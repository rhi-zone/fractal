// packages/codegen/src/cli.ts — @rhi-zone/fractal-codegen CLI
//
// The CODE-FIRST loop made executable: import an app module, run
// `toOpenApi(app, info)` to PROJECT the doc from the live handler tree, then
// `generate` the client + server `.ts` and write them. The app running to project
// the doc is the whole point — the handler tree is truth, the doc + generated
// code are downstream projections.
//
// Usage:
//   fractal-codegen <app-module> --out <dir> [--title T] [--version V] \
//                   [--export app] [--client-type ApiClient] [--client-factory createClient]
//
// <app-module> is resolved relative to CWD; its named export (default `app`) must
// be a `Reflected<unknown>` (a root combinator). Outputs <dir>/client.ts and
// <dir>/server.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Reflected } from "@rhi-zone/fractal-core";
import { toOpenApi } from "@rhi-zone/fractal-openapi";
import { generate, type GenerateOptions } from "./index.ts";

interface CliArgs {
  readonly module: string;
  readonly out: string;
  readonly title: string;
  readonly version: string;
  readonly exportName: string;
  readonly opts: GenerateOptions;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(a);
    }
  }
  const module = positional[0];
  if (module === undefined) {
    throw new Error(
      "usage: fractal-codegen <app-module> --out <dir> [--title T] [--version V] [--export app]",
    );
  }
  const opts: GenerateOptions = {
    ...(flags["client-import"] ? { clientImport: flags["client-import"] } : {}),
    ...(flags["core-import"] ? { coreImport: flags["core-import"] } : {}),
    ...(flags["client-type"] ? { clientTypeName: flags["client-type"] } : {}),
    ...(flags["client-factory"]
      ? { clientFactoryName: flags["client-factory"] }
      : {}),
    ...(flags["app-import"] ? { appImport: flags["app-import"] } : {}),
    ...(flags["app-export"] ? { appExport: flags["app-export"] } : {}),
    ...(flags["gen-union"] ? { genUnionName: flags["gen-union"] } : {}),
  };
  return {
    module,
    out: flags["out"] ?? "./generated",
    title: flags["title"] ?? "API",
    version: flags["version"] ?? "0.0.0",
    exportName: flags["export"] ?? "app",
    opts,
  };
}

/** Normalize an OS path into a POSIX module specifier with a leading "./" (so it
 *  is a valid relative `import` specifier on any platform). */
function toSpecifier(p: string): string {
  const posix = p.split("\\").join("/");
  return posix.startsWith(".") ? posix : `./${posix}`;
}

/** Import the app, project the doc, generate, and write client.ts/server.ts (with
 *  the embedded drift guard). Returns the path count. Shared by one-shot `run` and
 *  `watch` so both emit byte-identical output. `import(...)` with a cache-busting
 *  query so `watch` re-imports the MUTATED source, not a cached module. */
export async function generateToDir(
  args: CliArgs,
  bust = false,
): Promise<{ clientPath: string; serverPath: string; paths: number }> {
  const modPath = resolve(process.cwd(), args.module);
  const href = pathToFileURL(modPath).href + (bust ? `?t=${Date.now()}` : "");
  const mod = (await import(href)) as Record<string, unknown>;
  const app = mod[args.exportName];
  if (app === undefined) {
    throw new Error(
      `module "${args.module}" has no export "${args.exportName}" (the app/root combinator)`,
    );
  }
  // PROJECT the doc from the live app — the code-first loop.
  const doc = toOpenApi(app as Reflected<unknown>, {
    title: args.title,
    version: args.version,
  });

  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });

  // Compute the SOURCE app's import specifier RELATIVE to the output dir, for the
  // drift guard's `import type` (unless explicitly overridden). The generated
  // client.ts sits in <outDir>; the source app is <modPath>. A relative specifier
  // keeps the guard correct regardless of where codegen runs.
  const appImport = args.opts.appImport ?? toSpecifier(relative(outDir, modPath));
  const appExport = args.opts.appExport ?? args.exportName;
  const generated = generate(doc, { ...args.opts, appImport, appExport });

  const clientPath = resolve(outDir, "client.ts");
  const serverPath = resolve(outDir, "server.ts");
  mkdirSync(dirname(clientPath), { recursive: true });
  writeFileSync(clientPath, generated.client);
  writeFileSync(serverPath, generated.server);
  return { clientPath, serverPath, paths: Object.keys(doc.paths).length };
}

export async function run(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const { clientPath, serverPath, paths } = await generateToDir(args);
  process.stdout.write(
    `generated:\n  ${clientPath}\n  ${serverPath}\n` +
      `from "${args.module}" export "${args.exportName}" (${paths} paths)\n`,
  );
}

/** `fractal-codegen watch <app-module> --out <dir> [...]` — regenerate on source
 *  change. Watches the source module's DIRECTORY (bun/Node `fs.watch`, recursive),
 *  debounces a burst of fs events into one regeneration, and re-imports the
 *  mutated module (cache-busted). Keep it simple + robust: log each regen, never
 *  crash the loop on a transient compile/import error (report and keep watching). */
export async function watch(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const modPath = resolve(process.cwd(), args.module);
  const watchDir = dirname(modPath);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const regen = async (): Promise<void> => {
    if (running) return; // coalesce; a trailing event re-triggers below
    running = true;
    try {
      const { paths } = await generateToDir(args, /* bust */ true);
      process.stdout.write(`[fractal watch] regenerated (${paths} paths) ${new Date().toISOString()}\n`);
    } catch (e: unknown) {
      process.stderr.write(`[fractal watch] regen failed: ${String(e)}\n`);
    } finally {
      running = false;
    }
  };

  await regen(); // initial generation
  process.stdout.write(`[fractal watch] watching ${watchDir} (Ctrl-C to stop)\n`);

  const { watch: fsWatch } = await import("node:fs");
  fsWatch(watchDir, { recursive: true }, (_event, filename) => {
    // Ignore our own output writes (the generated dir under outDir) to avoid a loop.
    const outDir = resolve(process.cwd(), args.out);
    if (filename !== null && resolve(watchDir, filename).startsWith(outDir)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void regen(), 120); // debounce
  });

  // Keep the process alive.
  await new Promise<never>(() => {});
}

// Invoked directly (bun/node run): parse process.argv and go. A leading
// `generate` / `watch` subcommand selects the mode (default: generate).
if (import.meta.main === true || process.argv[1]?.endsWith("cli.ts")) {
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;
  const go =
    sub === "watch"
      ? watch(rest)
      : sub === "generate"
        ? run(rest)
        : run(argv); // no subcommand → one-shot generate
  go.catch((e: unknown) => {
    process.stderr.write(`fractal-codegen: ${String(e)}\n`);
    process.exit(1);
  });
}
