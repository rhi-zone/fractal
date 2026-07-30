// packages/type-ir/src/from-typescript.memory.test.ts — @rhi-zone/fractal-type-ir
//
// MEMORY-SHAPE REGRESSION GUARD for `createExtractorProgram`.
//
// Incident this guards against: `the sibling codebase`'s 16-slice validator codegen
// script (`apps/web/scripts/codegen-fractal-validators.ts`) called
// `buildValidatorModuleSource` once per slice, sequentially, in ONE process
// — and, before `createExtractorProgram` grew a multi-root form, every one
// of those calls built its OWN fresh `ts.Program` internally (walkTree ->
// createExtractorProgram(entryFile)). A `ts.Program`'s dominant cost is
// parsing+binding its whole transitive import closure, not the root file
// itself — measured against the real the sibling codebase repo, ONE slice's Program
// alone peaked ~3-5.5GB RSS. Building 16 of them back-to-back in one
// process, without ever passing a shared Program, let the garbage from
// earlier iterations pile up faster than the GC reclaimed it, and RSS
// climbed past 20GB, repeatedly OOM-killing unrelated processes on the
// user's machine (Steam, etc. — confirmed by direct observation, not a
// kernel dmesg log).
//
// This file cannot depend on the real the sibling codebase repo (wrong direction of
// coupling — an upstream package's tests must not reach into a downstream
// consumer's tree), so it reproduces the SHAPE of the problem with a
// synthetic fixture generated at test time: many entry files that all
// import a shared, deliberately large type module — the same shape as
// the sibling codebase's 16 slices, which all transitively import the same
// kernel/schema/adapter types. The synthetic fixture is written to a temp
// directory (never checked in) with NO tsconfig.json, so
// `createExtractorProgram` falls back to `FALLBACK_COMPILER_OPTIONS` —
// fully self-contained, no dependency on this repo's own project config.
//
// Two kinds of assertion:
//   1. DETERMINISTIC (the real gate — not timing/GC-dependent): the shared
//      multi-root Program's total parsed-file count is close to what ONE
//      single-entry Program costs, while the SUM of N independent
//      single-entry Programs' file counts is ~N times that — this is the
//      literal mechanism the memory blowup is made of, and it can't flake.
//   2. MEASURED (informative, generous threshold, forced GC before each
//      reading via `Bun.gc(true)`): actual heapUsed comparison between the
//      "16 independent Programs in one process" path (the exact PRE-FIX
//      shape — still what happens today if a caller omits the `program`
//      parameter, e.g. a one-off single-file extraction) and the "one
//      shared Program" path (the FIX). Real memory measurement is
//      inherently noisier than (1), so the threshold leaves wide margin —
//      the point is to catch a gross regression, not to pin an exact number.

import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExtractorProgram } from "./from-typescript.ts"

const ENTRY_COUNT = 12
/** Each generated interface gets this many fields — big enough that the
 * shared module's parse+bind cost is measurable in the tens-of-MB range
 * (not a full real-app's multi-GB closure, since that would make the test
 * itself slow/heavy — only the SHAPE of "many roots share one big
 * closure" needs reproducing, not the absolute scale). */
const INTERFACE_COUNT = 400
const FIELDS_PER_INTERFACE = 25

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1)
}

function forceGcHeapUsed(): number {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc
  if (typeof bunGc === "function") bunGc(true)
  return process.memoryUsage().heapUsed
}

/** Build a synthetic fixture tree: one large `shared.ts` (many exported
 * interfaces) plus `ENTRY_COUNT` entry files that each `export *` from it
 * — enough to force full parse+bind of `shared.ts` into any Program rooted
 * at an entry file, without needing real `api()`/`op()` tree semantics
 * (this test is about `createExtractorProgram`'s Program-construction cost
 * alone, not the leaf-walking layer above it). */
function writeSyntheticFixture(): { dir: string; entryFiles: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "fractal-memtest-"))

  const sharedLines: string[] = []
  for (let i = 0; i < INTERFACE_COUNT; i++) {
    const fields = Array.from(
      { length: FIELDS_PER_INTERFACE },
      (_, f) => `  field${f}: string | number | boolean | { nested${f}: string[] } | null`,
    ).join("\n")
    sharedLines.push(`export interface Shared${i} {\n${fields}\n}`)
  }
  writeFileSync(join(dir, "shared.ts"), sharedLines.join("\n\n"))

  const entryFiles: string[] = []
  for (let e = 0; e < ENTRY_COUNT; e++) {
    const entryPath = join(dir, `entry${e}.ts`)
    writeFileSync(entryPath, `export * from "./shared.ts"\nexport const marker${e} = ${e}\n`)
    entryFiles.push(entryPath)
  }
  return { dir, entryFiles }
}

describe("createExtractorProgram — memory-shape regression (batch vs per-call)", () => {
  it("a multi-root Program's file count is close to ONE single-root Program's — not N times larger", () => {
    const { dir, entryFiles } = writeSyntheticFixture()
    try {
      const singleProgram = createExtractorProgram(entryFiles[0]!)
      const singleFileCount = singleProgram.getSourceFiles().length

      const sharedProgram = createExtractorProgram(entryFiles)
      const sharedFileCount = sharedProgram.getSourceFiles().length

      // The union of all 12 entries' imports is just {shared.ts, the 12
      // entries themselves, lib.d.ts}, not 12x that — sharing the graph
      // instead of rebuilding it per entry is the entire fix.
      expect(sharedFileCount).toBeLessThan(singleFileCount * 2)
      expect(sharedFileCount).toBeGreaterThanOrEqual(singleFileCount)

      // The PRE-FIX shape: N independent single-root Programs, each paying
      // the full shared.ts parse+bind cost again. Sum of their file counts
      // is ~N times the shared Program's count — this is the literal
      // mechanism of the accumulation (not the GC-timing part, which is
      // covered by the measured heap check below).
      let independentTotal = 0
      for (const entry of entryFiles) {
        independentTotal += createExtractorProgram(entry).getSourceFiles().length
      }
      expect(independentTotal).toBeGreaterThan(sharedFileCount * (ENTRY_COUNT / 2))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("measured: building one shared Program for the whole batch uses far less peak heap than building one independent Program per entry, in the same process", () => {
    const { dir, entryFiles } = writeSyntheticFixture()
    try {
      // PRE-FIX shape: exactly what codegen-fractal-validators.ts did before
      // this fix — loop, build a fresh Program per entry, keep going. No
      // manual GC between iterations (this IS how the real script ran).
      const heapBefore = forceGcHeapUsed()
      let independentPeak = heapBefore
      for (const entry of entryFiles) {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- force full parse+bind, then let it go out of scope like the real loop does
        createExtractorProgram(entry).getTypeChecker()
        independentPeak = Math.max(independentPeak, process.memoryUsage().heapUsed)
      }
      const independentFinal = forceGcHeapUsed()

      // FIX shape: one shared Program, built once, reused (conceptually —
      // here just built once, since there's nothing left to reuse it FOR
      // in this isolated test; the reuse itself is exercised by
      // build.test.ts's "program shared across TWO different entry files").
      const sharedProgram = createExtractorProgram(entryFiles)
      sharedProgram.getTypeChecker()
      const sharedFinal = forceGcHeapUsed()

      console.log(
        `[memory-shape] independent(${ENTRY_COUNT}x): peak=${mb(independentPeak)}MB final-after-gc=${mb(independentFinal)}MB` +
          ` | shared(1x, ${ENTRY_COUNT} roots): final-after-gc=${mb(sharedFinal)}MB`,
      )

      // Generous margin (real memory measurement, not the deterministic
      // file-count check above): the shared-Program path should retain
      // meaningfully less than the peak the independent-Program loop hit
      // along the way. This is the actual "bad vs less-bad" demonstration
      // the fix was made for — not a tight bound (GC/allocator timing is
      // inherently noisy), just a floor under further regression.
      expect(sharedFinal).toBeLessThan(independentPeak * 0.9)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
