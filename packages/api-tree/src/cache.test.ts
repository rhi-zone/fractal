// Content-addressed build cache tests.
//
// Covers checkCache/writeCacheMetadata (cache.ts) via apply-validation-build.ts's
// `writeWireApplyValidationModuleCached`/schema-build.ts's `writeSchemaModuleCached`
// wrappers end-to-end against a real fixture entry file (so "touching a
// dependency the extractor reads, not just the entry file" is proven
// against genuine multi-file extraction, not a synthetic closure list).
//
// FIXTURE wraps tree.fixture.ts in a single 2-arg `applyValidation` call site
// (__fixtures__/apply-validation-tree.fixture.ts). Every `applyValidation`
// call site, 2-arg included, compiles through the wire-profile build path (an
// omitted protocol resolves to `"identity"`, docs/design/wire-profiles-and-staged-validation.md),
// so `writeWireApplyValidationModuleCached` against this fixture exercises
// cache.ts's contract the same way `writeApplyValidationModuleCached` did
// before the wire-profile path existed. `writeWireApplyValidationModuleCached`
// writes the same cache-metadata contract (cache.ts tracks the whole
// `ts.Program`'s file set by default), so touching DEP_FIXTURE — reachable
// transitively through tree.fixture.ts, one hop further from FIXTURE — still
// invalidates.

import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as extract from "./extract.ts";
import { createExtractorProgram } from "./extract.ts";
import { writeWireApplyValidationModuleCached } from "./apply-validation-build.ts";
import { writeSchemaModuleCached } from "./schema-build.ts";
import { checkCache, writeCacheMetadata } from "./cache.ts";
import { computeEntryClosures } from "./reachability.ts";

const FIXTURE = `${import.meta.dir}/__fixtures__/apply-validation-tree.fixture.ts`;
const DEP_FIXTURE = `${import.meta.dir}/__fixtures__/result-reexport.fixture.ts`;
const SHARING_FIXTURE = `${import.meta.dir}/__fixtures__/sharing.fixture.ts`;

const TMP_DIR = `${import.meta.dir}/__fixtures__/.cache-test-tmp`;

function freshOutFile(name: string): string {
  return path.join(TMP_DIR, name);
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("cache.ts — content-addressed incremental build cache", () => {
  it("first build is a miss (no cache metadata yet); rebuilding immediately after is a hit", async () => {
    const outFile = freshOutFile("v1.ts");

    const first = await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    expect(first.status).toBe("built");
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.existsSync(`${outFile}.cache.json`)).toBe(true);

    const second = await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    expect(second.status).toBe("hit");

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(true);
  });

  it("touching a DEPENDENCY the extractor reads (not the entry file itself) invalidates the cache", async () => {
    const outFile = freshOutFile("v2.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    expect((await writeWireApplyValidationModuleCached(FIXTURE, outFile)).status).toBe("hit");

    // Touch result-reexport.fixture.ts — a real transitive dependency of
    // tree.fixture.ts's `ResultFromBarrel` import — via a content change,
    // reverted in `finally` so the fixture stays clean for other tests.
    const original = fs.readFileSync(DEP_FIXTURE, "utf8");
    try {
      fs.writeFileSync(DEP_FIXTURE, `${original}\n// cache-test perturbation\n`);
      const check = checkCache(FIXTURE, outFile);
      expect(check.hit).toBe(false);
      if (!check.hit) expect(check.reason).toContain("result-reexport.fixture.ts");

      const rebuilt = await writeWireApplyValidationModuleCached(FIXTURE, outFile);
      expect(rebuilt.status).toBe("built");
    } finally {
      fs.writeFileSync(DEP_FIXTURE, original);
    }
  });

  it("editing the entry file itself invalidates the cache", async () => {
    const outFile = freshOutFile("v3.ts");
    // A throwaway copy of the fixture, with its relative imports rewritten
    // to still resolve from the copy's new (tmp) location, so it extracts
    // cleanly and can safely be edited without touching the real fixture.
    const entryCopy = freshOutFile("entry.fixture.ts");
    const rewritten = fs
      .readFileSync(FIXTURE, "utf8")
      .replaceAll(
        "./apply-validation-stub.fixture.ts",
        path.relative(TMP_DIR, `${import.meta.dir}/__fixtures__/apply-validation-stub.fixture.ts`),
      )
      .replaceAll(
        "./tree.fixture.ts",
        path.relative(TMP_DIR, `${import.meta.dir}/__fixtures__/tree.fixture.ts`),
      );
    fs.writeFileSync(entryCopy, rewritten);

    await writeWireApplyValidationModuleCached(entryCopy, outFile);
    expect((await writeWireApplyValidationModuleCached(entryCopy, outFile)).status).toBe("hit");

    fs.appendFileSync(entryCopy, "\n// entry-file perturbation\n");
    const check = checkCache(entryCopy, outFile);
    expect(check.hit).toBe(false);
    expect((await writeWireApplyValidationModuleCached(entryCopy, outFile)).status).toBe("built");
  });

  it("force bypasses the cache unconditionally, even on a hit", async () => {
    const outFile = freshOutFile("v4.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    expect((await writeWireApplyValidationModuleCached(FIXTURE, outFile)).status).toBe("hit");
    expect(
      (await writeWireApplyValidationModuleCached(FIXTURE, outFile, { force: true })).status,
    ).toBe("built");
  });

  it("hand-editing the output file invalidates the cache even though no input changed", async () => {
    const outFile = freshOutFile("v5.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    fs.appendFileSync(outFile, "\n// hand edit\n");
    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("output file changed");
  });

  it("a different tsVersion in the recorded metadata is a miss (was structurally uncatchable before — audit §7#1)", async () => {
    const outFile = freshOutFile("v-tsversion.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    const cacheFile = `${outFile}.cache.json`;
    const meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(cacheFile, JSON.stringify({ ...meta, tsVersion: "0.0.0-not-real" }));

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("typescript version");
  });

  it("a different typeIrVersion in the recorded metadata is a miss (audit §7#1)", async () => {
    const outFile = freshOutFile("v-typeirversion.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    const cacheFile = `${outFile}.cache.json`;
    const meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(cacheFile, JSON.stringify({ ...meta, typeIrVersion: "0.0.0-not-real" }));

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("fractal-type-ir version");
  });

  it("a different apiTreeVersion in the recorded metadata is a miss (audit §1.1/§2.1: the toolchain gate previously had no signal for a fractal-api-tree-internal codegen change at all)", async () => {
    const outFile = freshOutFile("v-apitreeversion.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    const cacheFile = `${outFile}.cache.json`;
    const meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(cacheFile, JSON.stringify({ ...meta, apiTreeVersion: "0.0.0-not-real" }));

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("fractal-api-tree version");
  });

  it("a different compilerOptionsHash in the recorded metadata is a miss (audit §2.2: tsconfig/compilerOptions weren't tracked at all before)", async () => {
    const outFile = freshOutFile("v-compileropts.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    const cacheFile = `${outFile}.cache.json`;
    const meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    expect(typeof meta.compilerOptionsHash).toBe("string");
    expect((meta.compilerOptionsHash as string).length).toBeGreaterThan(0);
    fs.writeFileSync(cacheFile, JSON.stringify({ ...meta, compilerOptionsHash: "not-the-real-hash" }));

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("tsconfig/compilerOptions");
  });

  it("a different buildOptionsKey (e.g. a changed --tree-id/runtimeImport) in the recorded metadata is a miss (audit §1.3)", async () => {
    const outFile = freshOutFile("v-buildoptions.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    const cacheFile = `${outFile}.cache.json`;
    const meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(cacheFile, JSON.stringify({ ...meta, buildOptionsKey: "some-other-option" }));

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("build options");
  });

  it("writeSchemaModuleCached folds treeId into the cache key: hand-editing a recorded buildOptionsKey away from the real treeId is a miss (audit §1.3's --tree-id example)", async () => {
    const outFile = freshOutFile("v-schema-treeid.ts");
    await writeSchemaModuleCached(FIXTURE, "validated", outFile);
    expect((await writeSchemaModuleCached(FIXTURE, "validated", outFile)).status).toBe("hit");

    const cacheFile = `${outFile}.cache.json`;
    const meta = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    expect(meta.buildOptionsKey).toBe("validated");
    fs.writeFileSync(cacheFile, JSON.stringify({ ...meta, buildOptionsKey: "someOtherTreeId" }));

    // Building "validated" again must not trust a cache entry recorded under
    // a different tree's key — was a Tier-1 hit serving the wrong tree's
    // artifact as "up to date" before treeId was part of the cache key.
    expect((await writeSchemaModuleCached(FIXTURE, "validated", outFile)).status).toBe("built");
  });

  it("cacheFile/cacheDir options relocate cache metadata away from the default <output>.cache.json sibling", async () => {
    const outFile = freshOutFile("v6.ts");
    const cacheDir = freshOutFile("cache-pool");
    const outcome = await writeWireApplyValidationModuleCached(FIXTURE, outFile, { cacheDir });
    expect(outcome.status).toBe("built");
    expect(fs.existsSync(`${outFile}.cache.json`)).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, `${path.basename(outFile)}.cache.json`))).toBe(true);
    expect(
      (await writeWireApplyValidationModuleCached(FIXTURE, outFile, { cacheDir })).status,
    ).toBe("hit");
  });

  it("options.header is folded into the written bytes AND the cache key (audit §6#2/§8.1)", async () => {
    const HEADER = "// @generated header for this test — do not edit\n";
    const outFile = freshOutFile("v-header.ts");

    const first = await writeWireApplyValidationModuleCached(FIXTURE, outFile, { header: HEADER });
    expect(first.status).toBe("built");
    if (first.status !== "built") throw new Error("unreachable");
    // `result` (what got written) starts with the header, and disk holds
    // exactly `result` — the byte-exact contract `withCache`'s doc comment
    // requires, now satisfied even with a header folded in.
    expect(first.result.startsWith(HEADER)).toBe(true);
    expect(fs.readFileSync(outFile, "utf8")).toBe(first.result);

    // Same header again: a real hit, since the recorded outputHash matches
    // the headered bytes actually on disk.
    const second = await writeWireApplyValidationModuleCached(FIXTURE, outFile, { header: HEADER });
    expect(second.status).toBe("hit");

    // A different header, everything else unchanged, must NOT be served the
    // old header's cached artifact — header is folded into buildOptionsKey.
    const differentHeaderOutcome = await writeWireApplyValidationModuleCached(FIXTURE, outFile, {
      header: "// a completely different header\n",
    });
    expect(differentHeaderOutcome.status).toBe("built");

    // Dropping the header entirely (back to the pre-existing no-header
    // behavior) is also a distinct cache key, not a hit against the
    // headered artifact.
    const noHeaderCheck = checkCache(FIXTURE, outFile);
    expect(noHeaderCheck.hit).toBe(false);
  });

  it("buildSchemaModuleCached's options.header is folded into the written bytes AND the cache key, same as the wire-validator wrapper", async () => {
    const HEADER = "// @generated schema header for this test — do not edit\n";
    const outFile = freshOutFile("v-schema-header.ts");

    const first = await writeSchemaModuleCached(FIXTURE, "validated", outFile, { header: HEADER });
    expect(first.status).toBe("built");
    if (first.status !== "built") throw new Error("unreachable");
    expect(first.result.startsWith(HEADER)).toBe(true);
    expect(fs.readFileSync(outFile, "utf8")).toBe(first.result);

    const second = await writeSchemaModuleCached(FIXTURE, "validated", outFile, { header: HEADER });
    expect(second.status).toBe("hit");

    const noHeaderOutcome = await writeSchemaModuleCached(FIXTURE, "validated", outFile);
    expect(noHeaderOutcome.status).toBe("built");
  });

  it("a warm hit never constructs a ts.Program — checkCache re-validates off recorded size/mtime/hash only", async () => {
    const outFile = freshOutFile("v8.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);

    // Spy on `createExtractorProgram` (extract.ts) — apply-validation-build.ts's
    // Program-construction entry point (`buildWireApplyValidationModuleCached`'s
    // `program` option). A warm `checkCache`/cached-build
    // call must never reach it: the whole point of the tiered stat/hash
    // re-validation (see cache.ts's warm-check-cost doc block) is to decide
    // "hit" without ever needing a Program.
    const createProgramSpy = spyOn(extract, "createExtractorProgram");
    try {
      const check = checkCache(FIXTURE, outFile);
      expect(check.hit).toBe(true);
      expect(createProgramSpy).not.toHaveBeenCalled();

      const outcome = await writeWireApplyValidationModuleCached(FIXTURE, outFile);
      expect(outcome.status).toBe("hit");
      expect(createProgramSpy).not.toHaveBeenCalled();
    } finally {
      createProgramSpy.mockRestore();
    }
  });

  it("touching a tracked file's mtime without changing its content still resolves to a hit (content-hash fallback)", async () => {
    const outFile = freshOutFile("v9.ts");
    await writeWireApplyValidationModuleCached(FIXTURE, outFile);

    // Bump DEP_FIXTURE's mtime (and only its mtime — content unchanged) far
    // enough into the future that it can't collide with the recorded value
    // under any filesystem's timestamp resolution, so the fast size/mtime
    // path is guaranteed to miss and fall through to the content-hash check.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(DEP_FIXTURE, future, future);

    const check = checkCache(FIXTURE, outFile);
    expect(check.hit).toBe(true);

    const outcome = await writeWireApplyValidationModuleCached(FIXTURE, outFile);
    expect(outcome.status).toBe("hit");
  });

  it("schema-build.ts's writeSchemaModuleCached uses the SAME cache contract, independently of the validator module's cache entry", async () => {
    const validatorOut = freshOutFile("v7.validators.ts");
    const schemaOut = freshOutFile("v7.schemas.ts");

    expect((await writeSchemaModuleCached(FIXTURE, "validated", schemaOut)).status).toBe("built");
    expect((await writeSchemaModuleCached(FIXTURE, "validated", schemaOut)).status).toBe("hit");

    // Building the validator module for the same entry doesn't touch the
    // schema artifact's cache entry (separate outFile, separate metadata).
    expect((await writeWireApplyValidationModuleCached(FIXTURE, validatorOut)).status).toBe(
      "built",
    );
    expect((await writeSchemaModuleCached(FIXTURE, "validated", schemaOut)).status).toBe("hit");

    const source = fs.readFileSync(schemaOut, "utf8");
    expect(source).toContain("export const schemas");
    expect(source).toContain("namedType_search");
  });

  describe("writeCacheMetadata's `reachable` param — per-entry closures over a SHARED multi-root Program", () => {
    it("recording with `reachable` tracks only that entry's own closure, not the whole shared Program's file set — touching an UNRELATED entry's dependency stays a hit", async () => {
      const treeOut = freshOutFile("shared-tree.ts");
      const sharingOut = freshOutFile("shared-sharing.ts");

      // One Program shared across both entries — the exact shape the sibling codebase's
      // codegen-fractal-validators.ts uses.
      const program = createExtractorProgram([FIXTURE, SHARING_FIXTURE]);
      const closures = computeEntryClosures([FIXTURE, SHARING_FIXTURE], program);
      const treeClosure = closures.get(path.resolve(FIXTURE));
      const sharingClosure = closures.get(path.resolve(SHARING_FIXTURE));
      expect(treeClosure).toBeDefined();
      expect(sharingClosure).toBeDefined();

      fs.writeFileSync(treeOut, "tree content");
      fs.writeFileSync(sharingOut, "sharing content");
      writeCacheMetadata(FIXTURE, treeOut, program, "tree content", undefined, treeClosure);
      writeCacheMetadata(
        SHARING_FIXTURE,
        sharingOut,
        program,
        "sharing content",
        undefined,
        sharingClosure,
      );

      expect(checkCache(FIXTURE, treeOut).hit).toBe(true);
      expect(checkCache(SHARING_FIXTURE, sharingOut).hit).toBe(true);

      // Touch DEP_FIXTURE — reachable from FIXTURE (tree.fixture.ts) but not
      // from SHARING_FIXTURE (sharing.fixture.ts never imports it, see
      // reachability.test.ts). Recording the whole shared Program's file set
      // for every entry (the behavior when `reachable` is omitted, see below)
      // would invalidate both entries on this touch; per-entry closures
      // invalidate only the entry that actually reaches the touched file.
      const original = fs.readFileSync(DEP_FIXTURE, "utf8");
      try {
        fs.writeFileSync(DEP_FIXTURE, `${original}\n// cache-test perturbation\n`);
        expect(checkCache(FIXTURE, treeOut).hit).toBe(false);
        expect(checkCache(SHARING_FIXTURE, sharingOut).hit).toBe(true);
      } finally {
        fs.writeFileSync(DEP_FIXTURE, original);
      }
    });

    it("omitting `reachable` keeps the old behavior: the whole Program's file set is tracked", async () => {
      const outFile = freshOutFile("no-reachable.ts");
      const program = createExtractorProgram([FIXTURE, SHARING_FIXTURE]);
      fs.writeFileSync(outFile, "content");
      writeCacheMetadata(FIXTURE, outFile, program, "content");

      const meta = JSON.parse(fs.readFileSync(`${outFile}.cache.json`, "utf8")) as {
        files: Record<string, unknown>;
      };
      // Without `reachable`, every file in the shared Program (including
      // sharing.fixture.ts's own unique files) is tracked against FIXTURE's
      // cache entry — the coarse union behavior.
      expect(Object.keys(meta.files)).toContain(path.resolve(SHARING_FIXTURE));
    });
  });
});
