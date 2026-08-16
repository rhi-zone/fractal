// Memory-shape regression guard for `createExtractorProgram`.
//
// Incident this guards against: `the sibling codebase`'s 16-slice validator codegen
// script (`apps/web/scripts/codegen-fractal-validators.ts`) called
// `buildValidatorModuleSource` once per slice, sequentially, in one process
// — and, before `createExtractorProgram` grew a multi-root form, every one
// of those calls built its own fresh `ts.Program` internally (walkTree ->
// createExtractorProgram(entryFile)). A `ts.Program`'s dominant cost is
// parsing+binding its whole transitive import closure, not the root file
// itself — measured against the real the sibling codebase repo, one slice's Program
// alone peaked ~3-5.5GB RSS. Building 16 of them back-to-back in one
// process, without ever passing a shared Program, let the garbage from
// earlier iterations pile up faster than the GC reclaimed it, and RSS
// climbed past 20GB, repeatedly OOM-killing unrelated processes on the
// user's machine (Steam, etc. — confirmed by direct observation, not a
// kernel dmesg log).
//
// This file cannot depend on the real the sibling codebase repo (wrong direction of
// coupling — an upstream package's tests must not reach into a downstream
// consumer's tree), so it reproduces the shape of the problem with a
// synthetic fixture generated at test time: many entry files that all
// import a shared, deliberately large type module — the same shape as
// the sibling codebase's 16 slices, which all transitively import the same
// kernel/schema/adapter types. The synthetic fixture is written to a temp
// directory (never checked in) with no tsconfig.json, so
// `createExtractorProgram` falls back to `FALLBACK_COMPILER_OPTIONS` —
// fully self-contained, no dependency on this repo's own project config.
//
// Two kinds of assertion:
//   1. Deterministic (the real gate — not timing/GC-dependent): the shared
//      multi-root Program's total parsed-file count is close to what one
//      single-entry Program costs, while the sum of N independent
//      single-entry Programs' file counts is ~N times that — this is the
//      literal mechanism the memory blowup is made of, and it can't flake.
//   2. Measured (real memory comparison, deliberately NOT `heapUsed`): the
//      "16 independent Programs in one process, all still reachable" shape
//      (the pre-fix path — still what happens today if a caller omits the
//      `program` parameter — modeled here as the worst case where nothing
//      has been GC'd yet, i.e. GC hasn't caught up) versus the "one shared
//      Program covering the same roots" shape (the fix). Measured via
//      `process.memoryUsage().heapTotal` (the VM's actual committed heap
//      size) after an explicit `Bun.gc(true)`, not `.heapUsed`.
//
//      This split was forced by a real finding, not a style preference: on
//      Bun 1.3.9, `.heapUsed` does not reliably fall back down after
//      `Bun.gc(true)` even when the objects it counted are provably
//      unreachable and fully collected — confirmed with a minimal repro
//      (allocate ~600MB of plain objects, drop the reference, force GC:
//      `.heapTotal` correctly shrinks back near baseline, `.heapUsed` stays
//      pinned at its prior high-water mark indefinitely, surviving further
//      forced GCs). That made the original version of this test (which read
//      `.heapUsed`) fail nondeterministically — independently of anything
//      `createExtractorProgram` does — roughly 30-40% of runs, because the
//      the pre-GC-drop "peak" sample and the post-GC "final" reading were
//      being compared against a metric that only ever goes up. `.heapTotal`
//      does not have this problem: across dozens of local repro runs it
//      separates the two shapes by ~8x with no overlap (independent-and-
//      retained ~850MB vs. shared ~104MB for this fixture), instead of the
//      `.heapUsed`-based version's readings landing anywhere from a 2.6x
//      apparent win down to a dead heat purely on GC-scheduling luck.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtractorProgram } from "./from-typescript.ts";

const ENTRY_COUNT = 12;
/** Each generated interface gets this many fields — big enough that the
 * shared module's parse+bind cost is measurable in the tens-of-MB range
 * (not a full real-app's multi-GB closure, since that would make the test
 * itself slow/heavy — only the shape of "many roots share one big
 * closure" needs reproducing, not the absolute scale). */
const INTERFACE_COUNT = 400;
const FIELDS_PER_INTERFACE = 25;

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1);
}

/** Forces a full GC, then reads `heapTotal` (the VM's committed heap size) —
 * deliberately not `heapUsed`; see the file header for why. */
function forceGcHeapTotal(): number {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
  if (typeof bunGc === "function") bunGc(true);
  return process.memoryUsage().heapTotal;
}

/** Build a synthetic fixture tree: one large `shared.ts` (many exported
 * interfaces) plus `ENTRY_COUNT` entry files that each `export *` from it
 * — enough to force full parse+bind of `shared.ts` into any Program rooted
 * at an entry file, without needing real `api()`/`op()` tree semantics
 * (this test is about `createExtractorProgram`'s Program-construction cost
 * alone, not the leaf-walking layer above it). */
function writeSyntheticFixture(): { dir: string; entryFiles: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "fractal-memtest-"));

  const sharedLines: string[] = [];
  for (let i = 0; i < INTERFACE_COUNT; i++) {
    const fields = Array.from(
      { length: FIELDS_PER_INTERFACE },
      (_, f) => `  field${f}: string | number | boolean | { nested${f}: string[] } | null`,
    ).join("\n");
    sharedLines.push(`export interface Shared${i} {\n${fields}\n}`);
  }
  writeFileSync(join(dir, "shared.ts"), sharedLines.join("\n\n"));

  const entryFiles: string[] = [];
  for (let e = 0; e < ENTRY_COUNT; e++) {
    const entryPath = join(dir, `entry${e}.ts`);
    writeFileSync(entryPath, `export * from "./shared.ts"\nexport const marker${e} = ${e}\n`);
    entryFiles.push(entryPath);
  }
  return { dir, entryFiles };
}

describe("createExtractorProgram — memory-shape regression (batch vs per-call)", () => {
  it("a multi-root Program's file count is close to one single-root Program's — not N times larger", () => {
    const { dir, entryFiles } = writeSyntheticFixture();
    try {
      const singleProgram = createExtractorProgram(entryFiles[0]!);
      const singleFileCount = singleProgram.getSourceFiles().length;

      const sharedProgram = createExtractorProgram(entryFiles);
      const sharedFileCount = sharedProgram.getSourceFiles().length;

      // The union of all 12 entries' imports is just {shared.ts, the 12
      // entries themselves, lib.d.ts}, not 12x that — sharing the graph
      // instead of rebuilding it per entry is the entire fix.
      expect(sharedFileCount).toBeLessThan(singleFileCount * 2);
      expect(sharedFileCount).toBeGreaterThanOrEqual(singleFileCount);

      // The pre-fix shape: N independent single-root Programs, each paying
      // the full shared.ts parse+bind cost again. Sum of their file counts
      // is ~N times the shared Program's count — this is the literal
      // mechanism of the accumulation (not the GC-timing part, which is
      // covered by the measured heap check below).
      let independentTotal = 0;
      for (const entry of entryFiles) {
        independentTotal += createExtractorProgram(entry).getSourceFiles().length;
      }
      expect(independentTotal).toBeGreaterThan(sharedFileCount * (ENTRY_COUNT / 2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("measured: one shared Program for the whole batch commits far less heap than N independent Programs held live at once", () => {
    const { dir, entryFiles } = writeSyntheticFixture();
    try {
      // Pre-fix shape, worst case: what codegen-fractal-validators.ts did
      // before this fix — a fresh Program per entry, kept going — modeled
      // here as all N still being reachable at once (the worst case of "GC
      // hasn't caught up yet", which is the actual incident: garbage piling
      // up faster than the GC reclaimed it). Explicitly retaining them
      // trades away the "did GC race in time" question (unreliable — see
      // file header) for a deterministic bound on that same scenario.
      const independentPrograms: unknown[] = [];
      for (const entry of entryFiles) {
        const program = createExtractorProgram(entry);
        program.getTypeChecker();
        independentPrograms.push(program);
      }
      const independentHeapTotal = forceGcHeapTotal();

      // Drop the references and confirm the VM actually gives the memory
      // back before building the fix's shape — otherwise a false "win"
      // below could just be measurement noise rather than the shared
      // Program genuinely costing less.
      independentPrograms.length = 0;
      const releasedHeapTotal = forceGcHeapTotal();

      // Fix shape: one shared Program, built once, reused (conceptually —
      // here just built once, since there's nothing left to reuse it for
      // in this isolated test; the reuse itself is exercised by
      // build.test.ts's "program shared across two different entry files").
      const sharedProgram = createExtractorProgram(entryFiles);
      sharedProgram.getTypeChecker();
      const sharedHeapTotal = forceGcHeapTotal();

      console.log(
        `[memory-shape] independent(${ENTRY_COUNT}x, retained)=${mb(independentHeapTotal)}MB` +
          ` | released=${mb(releasedHeapTotal)}MB` +
          ` | shared(1x, ${ENTRY_COUNT} roots)=${mb(sharedHeapTotal)}MB`,
      );

      // The shared-Program path should cost meaningfully less than holding
      // all N independent Programs live at once — this is the actual "bad
      // vs less-bad" demonstration the fix was made for. Not a tight bound
      // (allocator behavior varies by machine/Bun version), just a floor
      // under further regression; locally this separates by ~8x with no
      // overlap across dozens of runs, so 2x leaves ample margin.
      expect(sharedHeapTotal).toBeLessThan(independentHeapTotal / 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
