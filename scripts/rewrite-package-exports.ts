// scripts/rewrite-package-exports.ts
//
// Mechanically rewrites a publishable package's package.json so its
// `exports` (and `main`/`module`/`types`/`bin`, when present) point at
// built `dist/*.js` + `dist/*.d.ts` output instead of `src/*.ts` source.
//
// This repo's packages are dev-consumed source-to-source (bun workspace +
// tsconfig `paths` mapping straight at sibling `src/*.ts` — see
// tsconfig.base.json and each package's tsconfig.json, neither of which
// this script touches). The rewritten package.json is what actually ships
// to npm: `dist/` output from `tsc -b <pkg>/tsconfig.build.json`.
//
// Every `exports` entry is expected to already follow the
// `{ "types": "./src/X.ts", "import": "./src/X.ts" }` shape (both branches
// pointing at the same source file, which is the only shape this repo
// currently uses — ESM-only, no `require` condition). Anything else is
// treated as unhandled rather than guessed at.
//
// Usage:
//   bun scripts/rewrite-package-exports.ts <package-dir> [...more package dirs]
//   bun scripts/rewrite-package-exports.ts --check <package-dir>   # dry run, exit 1 on diff
//
// Used per-package while rolling out the tsc build pipeline (Option A);
// safe to re-run — it's idempotent once exports already point at dist.

type ExportsMap = Record<string, unknown>;

function isSrcTsPointer(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("./src/") && value.endsWith(".ts");
}

// "./src/foo/bar.ts" -> { dtsRel: "./dist/foo/bar.d.ts", jsRel: "./dist/foo/bar.js" }
function srcTsToDistPaths(srcPointer: string): { dtsRel: string; jsRel: string } {
  const withoutPrefix = srcPointer.slice("./src/".length, -".ts".length);
  return {
    dtsRel: `./dist/${withoutPrefix}.d.ts`,
    jsRel: `./dist/${withoutPrefix}.js`,
  };
}

function rewriteExportsEntry(key: string, entry: unknown): unknown {
  // The "." root entry and every subpath entry we've seen in this repo is
  // an object with "types" and "import" both pointing at the same
  // ./src/X.ts file. Reject anything else loudly rather than guess.
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `exports["${key}"]: expected an object with "types"/"import", got ${JSON.stringify(entry)}`,
    );
  }
  const obj = entry as Record<string, unknown>;
  const keys = Object.keys(obj);
  const unexpected = keys.filter((k) => k !== "types" && k !== "import");
  if (unexpected.length > 0) {
    throw new Error(
      `exports["${key}"]: unhandled condition(s) ${JSON.stringify(unexpected)} — extend this script before rewriting`,
    );
  }
  if (!isSrcTsPointer(obj.types) || !isSrcTsPointer(obj.import)) {
    throw new Error(
      `exports["${key}"]: expected both "types" and "import" to point at "./src/*.ts", got ${JSON.stringify(obj)}`,
    );
  }
  if (obj.types !== obj.import) {
    throw new Error(
      `exports["${key}"]: "types" and "import" point at different files (${obj.types} vs ${obj.import}) — unhandled shape`,
    );
  }
  const { dtsRel, jsRel } = srcTsToDistPaths(obj.types);
  return { types: dtsRel, import: jsRel };
}

function rewriteExports(exportsMap: ExportsMap): ExportsMap {
  const out: ExportsMap = {};
  for (const [key, entry] of Object.entries(exportsMap)) {
    out[key] = rewriteExportsEntry(key, entry);
  }
  return out;
}

function srcTsPathToDistJsPath(srcPath: string): string {
  if (!isSrcTsPointer(srcPath)) {
    throw new Error(`expected a "./src/*.ts" pointer, got ${JSON.stringify(srcPath)}`);
  }
  return srcTsToDistPaths(srcPath).jsRel;
}

function srcTsPathToDistDtsPath(srcPath: string): string {
  if (!isSrcTsPointer(srcPath)) {
    throw new Error(`expected a "./src/*.ts" pointer, got ${JSON.stringify(srcPath)}`);
  }
  return srcTsToDistPaths(srcPath).dtsRel;
}

export function rewritePackageJson(pkg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...pkg };

  if (typeof out.exports === "object" && out.exports !== null) {
    out.exports = rewriteExports(out.exports as ExportsMap);
  }

  if (typeof out.main === "string") out.main = srcTsPathToDistJsPath(out.main);
  if (typeof out.module === "string") out.module = srcTsPathToDistJsPath(out.module);
  if (typeof out.types === "string") out.types = srcTsPathToDistDtsPath(out.types);

  if (typeof out.bin === "string") {
    out.bin = srcTsPathToDistJsPath(out.bin);
  } else if (out.bin !== null && typeof out.bin === "object") {
    const bin = out.bin as Record<string, string>;
    const rewritten: Record<string, string> = {};
    for (const [name, path] of Object.entries(bin)) {
      rewritten[name] = srcTsPathToDistJsPath(path);
    }
    out.bin = rewritten;
  }

  // `files` currently ships raw source (with test-file globs excluded by
  // hand); once we ship dist output the whole directory is the package
  // contents and none of the exclusion globs are needed (tsc's build
  // excludes already keep tests/fixtures out of dist).
  if (Array.isArray(out.files)) {
    out.files = ["dist"];
  }

  out.publishConfig = {
    ...(typeof out.publishConfig === "object" && out.publishConfig !== null
      ? out.publishConfig
      : {}),
    access: "public",
  };

  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const pkgDirs = args.filter((a) => a !== "--check");

  if (pkgDirs.length === 0) {
    console.error(
      "usage: bun scripts/rewrite-package-exports.ts [--check] <package-dir> [...more]",
    );
    process.exit(1);
  }

  let anyDiff = false;

  for (const pkgDir of pkgDirs) {
    const pkgJsonPath = `${pkgDir}/package.json`;
    const file = Bun.file(pkgJsonPath);
    if (!(await file.exists())) {
      console.error(`${pkgJsonPath}: not found`);
      process.exit(1);
    }
    const original = await file.json();
    const rewritten = rewritePackageJson(original);
    const originalText = JSON.stringify(original, null, 2);
    const rewrittenText = `${JSON.stringify(rewritten, null, 2)}\n`;

    if (checkOnly) {
      if (`${originalText}\n` !== rewrittenText) {
        console.log(`${pkgJsonPath}: would change`);
        anyDiff = true;
      } else {
        console.log(`${pkgJsonPath}: up to date`);
      }
      continue;
    }

    await Bun.write(pkgJsonPath, rewrittenText);
    console.log(
      `${pkgJsonPath}: rewrote exports (${Object.keys((rewritten.exports as object) ?? {}).length} entries)`,
    );
  }

  if (checkOnly && anyDiff) process.exit(1);
}

if (import.meta.main) {
  await main();
}
