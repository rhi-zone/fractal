// packages/type-ir/src/inference-eval.ts — @rhi-zone/fractal-type-ir/inference-eval
//
// Evaluation harness for JSON inference quality. `from-json-corpus.ts`'s
// heuristics (K/N < 1/3 enum saturation, Jaccard > 0.1 discriminated-union
// splits, growthRatio > 0.5 dict detection, …) were hand-picked with no
// labeled-corpus validation. This module closes that gap by running
// inference BACKWARDS from a known-good schema:
//
//   schema --(generateCorpus)--> synthetic JSON values --(fromJsonCorpus)-->
//     inferred schema --(scoreInference against the original)--> quality report
//
// Three pieces:
//   - `generateCorpus` — the inverse of inference: given a TypeRef, produce
//     N synthetic JSON values that conform to it.
//   - `scoreInference` — given the original schema and what inference
//     produced from a corpus generated from it, compute precision/recall/F1
//     metrics along several axes (field coverage, type accuracy, enum
//     detection, dict-vs-record detection, union fidelity).
//   - `runEvaluation` — drives a labeled set of schemas through both at
//     several corpus sizes and reports how quality trends with N.
//
// This is deliberately independent of any one threshold's current value —
// it measures outcomes (did we recover the right shape), not the internals
// (which constant fired). That's what makes it useful for tuning the
// thresholds in from-json-corpus.ts: change a threshold, rerun, compare.

import { ancestors, t, types, type TypeRef } from "./index.ts"
import { fromJsonCorpus, type CorpusInferConfig } from "./from-json-corpus.ts"
import { ecommerceOrder, apiResponse, kitchenSink, treeNode } from "./test-fixtures.ts"

// ---------------------------------------------------------------------------
// Seeded RNG — deterministic so eval runs (and their test assertions) are
// reproducible. Not cryptographic; just a small, fast, seedable generator.
// ---------------------------------------------------------------------------

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}

/** mulberry32 — small, fast, seedable PRNG. Returns a `() => number in [0,1)` generator. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = () => number

function rngFromSeed(seed: number | string | undefined): Rng {
  if (seed === undefined) return mulberry32(0xc0ffee)
  return mulberry32(typeof seed === "string" ? hashSeed(seed) : seed >>> 0)
}

function randInt(rng: Rng, min: number, max: number): number {
  // Inclusive [min, max].
  return Math.floor(rng() * (max - min + 1)) + min
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, 0, items.length - 1)]!
}

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
]

function randomWord(rng: Rng): string {
  return pick(rng, WORDS) + randInt(rng, 0, 999)
}

function randomHex(rng: Rng, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += Math.floor(rng() * 16).toString(16)
  return out
}

function randomUuid(rng: Rng): string {
  return `${randomHex(rng, 8)}-${randomHex(rng, 4)}-4${randomHex(rng, 3)}-8${randomHex(rng, 3)}-${randomHex(rng, 12)}`
}

function randomDate(rng: Rng): string {
  const year = randInt(rng, 2000, 2030)
  const month = String(randInt(rng, 1, 12)).padStart(2, "0")
  const day = String(randInt(rng, 1, 28)).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function randomDateTime(rng: Rng): string {
  const h = String(randInt(rng, 0, 23)).padStart(2, "0")
  const m = String(randInt(rng, 0, 59)).padStart(2, "0")
  const s = String(randInt(rng, 0, 59)).padStart(2, "0")
  return `${randomDate(rng)}T${h}:${m}:${s}Z`
}

// ---------------------------------------------------------------------------
// Corpus generation — the inverse of inference
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** Deterministic seed. Same seed + same schema + same n -> same corpus. */
  readonly seed?: number | string
  /** Probability an optional field is present. Default 0.75. */
  readonly optionalPresenceRate?: number
  /** Probability a nullable value is generated as `null`. Default 0.15. */
  readonly nullableNullRate?: number
  /** Inclusive [min, max] length for `array`-kind values. Default [0, 5]. */
  readonly arrayLengthRange?: readonly [number, number]
  /** Inclusive [min, max] key count for `map`-kind values. Default [0, 4]. */
  readonly mapSizeRange?: readonly [number, number]
  /**
   * Named definitions `ref`-kind nodes resolve against — mirrors
   * `TypeRefDocument.defs` (see index.ts) for schemas built with recursive
   * `ref`s (e.g. test-fixtures.ts's `treeNode`), which carry no defs of
   * their own.
   */
  readonly defs?: Readonly<Record<string, TypeRef>>
  /**
   * Recursion depth at which array-valued positions are forced to length 0,
   * guaranteeing termination for self-referential schemas (a recursive
   * `ref` can only ever recur through a container position — forcing arrays
   * empty at depth cuts every such cycle without needing to know the
   * referent's shape ahead of time). Default 6.
   */
  readonly maxDepth?: number
}

interface ResolvedGenOptions {
  readonly rng: Rng
  readonly optionalPresenceRate: number
  readonly nullableNullRate: number
  readonly arrayLengthRange: readonly [number, number]
  readonly mapSizeRange: readonly [number, number]
  readonly defs: Readonly<Record<string, TypeRef>>
  readonly maxDepth: number
}

function resolveGenOptions(options: GenerateOptions | undefined): ResolvedGenOptions {
  return {
    rng: rngFromSeed(options?.seed),
    optionalPresenceRate: options?.optionalPresenceRate ?? 0.75,
    nullableNullRate: options?.nullableNullRate ?? 0.15,
    arrayLengthRange: options?.arrayLengthRange ?? [0, 5],
    mapSizeRange: options?.mapSizeRange ?? [0, 4],
    defs: options?.defs ?? {},
    maxDepth: options?.maxDepth ?? 6,
  }
}

const intRanges: Readonly<Record<string, readonly [number, number]>> = {
  uint8: [0, 255],
  int8: [-128, 127],
  uint16: [0, 65535],
  int16: [-32768, 32767],
  uint32: [0, 4294967295],
  int32: [-2147483648, 2147483647],
  uint64: [0, Number.MAX_SAFE_INTEGER],
  int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

function generateLeaf(kind: string, opts: ResolvedGenOptions): unknown {
  switch (kind) {
    case "boolean": return opts.rng() < 0.5
    case "number": return Math.round(opts.rng() * 10000) / 100
    case "integer": return randInt(opts.rng, -1000, 1000)
    case "string": return randomWord(opts.rng)
    case "uuid": return randomUuid(opts.rng)
    case "uri": return `https://example.com/${randomWord(opts.rng)}`
    case "email": return `${randomWord(opts.rng)}@example.com`
    case "date": return randomDate(opts.rng)
    case "datetime": return randomDateTime(opts.rng)
    case "time": return `${String(randInt(opts.rng, 0, 23)).padStart(2, "0")}:00:00`
    case "bytes": return randomHex(opts.rng, 16)
    case "null": return null
    case "void": return null
    case "unknown": return pick(opts.rng, [randomWord(opts.rng), randInt(opts.rng, 0, 1000), true, null])
    default: {
      const range = intRanges[kind]
      if (range !== undefined) return randInt(opts.rng, range[0], range[1])
      // Nominal/callable kinds (instance/function/method/interface/never) have
      // no JSON-representable inhabitant — degrade to null rather than throw,
      // same "honest degrade" convention projectors use elsewhere.
      return null
    }
  }
}

function generateValue(ref: TypeRef, opts: ResolvedGenOptions, depth: number): unknown {
  if (ref.meta.nullable === true && opts.rng() < opts.nullableNullRate) return null

  const { shape } = ref
  const forceEmptyContainers = depth >= opts.maxDepth

  switch (shape.kind) {
    case "object": {
      const fields = (shape as { fields: Readonly<Record<string, TypeRef>> }).fields
      const out: Record<string, unknown> = {}
      for (const [name, fieldRef] of Object.entries(fields)) {
        if (fieldRef.meta.optional === true && opts.rng() >= opts.optionalPresenceRate) continue
        out[name] = generateValue(fieldRef, opts, depth + 1)
      }
      return out
    }
    case "array": {
      const element = (shape as { element: TypeRef }).element
      const [lo, hi] = opts.arrayLengthRange
      const len = forceEmptyContainers ? 0 : randInt(opts.rng, lo, hi)
      return Array.from({ length: len }, () => generateValue(element, opts, depth + 1))
    }
    case "tuple": {
      const elements = (shape as { elements: readonly TypeRef[] }).elements
      return elements.map((el) => generateValue(el, opts, depth + 1))
    }
    case "map": {
      const value = (shape as { value: TypeRef }).value
      const [lo, hi] = opts.mapSizeRange
      const size = forceEmptyContainers ? 0 : randInt(opts.rng, lo, hi)
      const out: Record<string, unknown> = {}
      for (let i = 0; i < size; i++) out[`${randomWord(opts.rng)}_${i}`] = generateValue(value, opts, depth + 1)
      return out
    }
    case "union": {
      const variants = (shape as { variants: readonly TypeRef[] }).variants
      if (variants.length === 0) return null
      return generateValue(pick(opts.rng, variants), opts, depth + 1)
    }
    case "literal": {
      return (shape as { value: string | number | boolean | null }).value
    }
    case "enum": {
      const members = (shape as { members: readonly string[] }).members
      if (members.length === 0) return ""
      return pick(opts.rng, members)
    }
    case "ref": {
      const target = (shape as { target: string }).target
      const resolved = opts.defs[target]
      if (resolved === undefined) return null // unresolvable ref — no defs given, degrade to null
      return generateValue(resolved, opts, depth + 1)
    }
    default:
      return generateLeaf(shape.kind, opts)
  }
}

/**
 * Generate `n` synthetic JSON values that conform to `schema` — the inverse
 * of `fromJsonCorpus`. Deterministic given the same `options.seed`.
 */
export function generateCorpus(schema: TypeRef, n: number, options?: GenerateOptions): unknown[] {
  const opts = resolveGenOptions(options)
  return Array.from({ length: n }, () => generateValue(schema, opts, 0))
}

// ---------------------------------------------------------------------------
// Schema indexing — flatten a TypeRef into path -> kind info for comparison.
//
// Path convention: object fields append `.name`; array/map elements append
// `[]`/`{}`; tuple elements append `[i]`. A `union`'s variants are indexed
// UNDER THE SAME PATH as the union itself (not a new segment) — the fields a
// union's variants carry are exactly what "did inference recover the right
// fields" cares about, even though which variant a field came from is lost
// at that resolution. Variant-level fidelity is covered separately by
// `unionPaths`/`variantCounts` in `ScoreReport.unionFidelity`.
// ---------------------------------------------------------------------------

interface SchemaIndex {
  /** Every path visited (containers and leaves alike), excluding the root. */
  readonly paths: ReadonlySet<string>
  /** path -> the TypeRef shape kind observed there (last writer wins for union-merged paths). */
  readonly kindAt: ReadonlyMap<string, string>
  readonly enumPaths: ReadonlySet<string>
  readonly unionPaths: ReadonlySet<string>
  readonly mapPaths: ReadonlySet<string>
  /** union path -> number of variants (for union-fidelity variant-count comparison). */
  readonly variantCounts: ReadonlyMap<string, number>
}

function indexSchema(root: TypeRef): SchemaIndex {
  const paths = new Set<string>()
  const kindAt = new Map<string, string>()
  const enumPaths = new Set<string>()
  const unionPaths = new Set<string>()
  const mapPaths = new Set<string>()
  const variantCounts = new Map<string, number>()

  function visit(ref: TypeRef, path: string, seen: ReadonlySet<TypeRef>): void {
    if (seen.has(ref)) return // guard against `ref`-free structural cycles (shouldn't occur, but stay safe)
    const nextSeen = new Set(seen)
    nextSeen.add(ref)

    const { shape } = ref
    if (path !== "") {
      paths.add(path)
      kindAt.set(path, shape.kind)
    }
    if (shape.kind === "enum") enumPaths.add(path)
    if (shape.kind === "map") mapPaths.add(path)

    if (shape.kind === "object") {
      const fields = (shape as { fields: Readonly<Record<string, TypeRef>> }).fields
      for (const [name, fieldRef] of Object.entries(fields)) {
        visit(fieldRef, path === "" ? name : `${path}.${name}`, nextSeen)
      }
      return
    }
    if (shape.kind === "array") {
      visit((shape as { element: TypeRef }).element, `${path}[]`, nextSeen)
      return
    }
    if (shape.kind === "tuple") {
      const elements = (shape as { elements: readonly TypeRef[] }).elements
      elements.forEach((el, i) => visit(el, `${path}[${i}]`, nextSeen))
      return
    }
    if (shape.kind === "map") {
      visit((shape as { value: TypeRef }).value, `${path}{}`, nextSeen)
      return
    }
    if (shape.kind === "union") {
      unionPaths.add(path)
      const variants = (shape as { variants: readonly TypeRef[] }).variants
      variantCounts.set(path, variants.length)
      for (const v of variants) visit(v, path, nextSeen)
      return
    }
    // Leaves (scalars, literal, ref, instance/function/method/interface/
    // stream/page/never/unknown/void) — no children indexed.
  }

  visit(root, "", new Set())
  return { paths, kindAt, enumPaths, unionPaths, mapPaths, variantCounts }
}

/** The nearest ancestor kind with no parent of its own — groups width/format
 * refinements (uint8, int32, uuid, datetime, …) under their structural
 * family (number, string, …) for a looser "close enough" comparison. */
function rootKind(kind: string): string {
  const chain = ancestors(kind)
  return chain.length > 0 ? chain[chain.length - 1]! : kind
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface PrecisionRecallF1 {
  readonly precision: number
  readonly recall: number
  readonly f1: number
}

function prf1(matched: number, actual: number, predicted: number): PrecisionRecallF1 {
  if (actual === 0 && predicted === 0) return { precision: 1, recall: 1, f1: 1 }
  const precision = predicted === 0 ? 0 : matched / predicted
  const recall = actual === 0 ? 0 : matched / actual
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

function setPrf1(actual: ReadonlySet<string>, predicted: ReadonlySet<string>): PrecisionRecallF1 {
  let matched = 0
  for (const p of actual) if (predicted.has(p)) matched++
  return prf1(matched, actual.size, predicted.size)
}

export interface FieldComparison {
  readonly path: string
  readonly originalKind: string
  readonly inferredKind?: string
  readonly status: "exact" | "family" | "mismatch" | "missing" | "extra"
}

export interface ScoreReport {
  /** Did we find all the fields/positions the original schema declared? */
  readonly fieldCoverage: PrecisionRecallF1
  /** Among positions found in both, how often did the inferred kind match. */
  readonly typeAccuracy: { readonly exactRate: number; readonly familyRate: number; readonly comparedCount: number }
  /** Did we find the enum-shaped positions (vs. leaving them as plain string/integer). */
  readonly enumDetection: PrecisionRecallF1
  /** Did we find the dict-shaped positions (vs. leaving them as fixed-field record). */
  readonly dictDetection: PrecisionRecallF1
  /** Did we find the union-shaped positions (incl. discriminated unions), and how close were variant counts. */
  readonly unionFidelity: PrecisionRecallF1 & { readonly avgVariantCountDiff: number | null }
  /** Single-number rollup — unweighted mean of the axes above that apply (an axis with nothing to find in the original is excluded, not scored as a free win). */
  readonly overallF1: number
  readonly fields: readonly FieldComparison[]
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Compare an inferred TypeRef against the original schema it was (via a
 * generated corpus) supposed to recover. See module doc for the axes.
 */
export function scoreInference(original: TypeRef, inferred: TypeRef): ScoreReport {
  const origIdx = indexSchema(original)
  const infIdx = indexSchema(inferred)

  const fieldCoverage = setPrf1(origIdx.paths, infIdx.paths)

  const fields: FieldComparison[] = []
  let exact = 0
  let family = 0
  let compared = 0
  for (const path of origIdx.paths) {
    const originalKind = origIdx.kindAt.get(path)!
    const inferredKind = infIdx.kindAt.get(path)
    if (inferredKind === undefined) {
      fields.push({ path, originalKind, status: "missing" })
      continue
    }
    compared++
    if (originalKind === inferredKind) {
      exact++
      family++
      fields.push({ path, originalKind, inferredKind, status: "exact" })
    } else if (rootKind(originalKind) === rootKind(inferredKind)) {
      family++
      fields.push({ path, originalKind, inferredKind, status: "family" })
    } else {
      fields.push({ path, originalKind, inferredKind, status: "mismatch" })
    }
  }
  for (const path of infIdx.paths) {
    if (!origIdx.paths.has(path)) {
      fields.push({ path, originalKind: "(none)", inferredKind: infIdx.kindAt.get(path)!, status: "extra" })
    }
  }

  const typeAccuracy = {
    exactRate: compared === 0 ? 1 : exact / compared,
    familyRate: compared === 0 ? 1 : family / compared,
    comparedCount: compared,
  }

  const enumDetection = setPrf1(origIdx.enumPaths, infIdx.enumPaths)
  const dictDetection = setPrf1(origIdx.mapPaths, infIdx.mapPaths)
  const unionPrf1 = setPrf1(origIdx.unionPaths, infIdx.unionPaths)

  const variantDiffs: number[] = []
  for (const path of origIdx.unionPaths) {
    const infCount = infIdx.variantCounts.get(path)
    if (infCount !== undefined) variantDiffs.push(Math.abs(origIdx.variantCounts.get(path)! - infCount))
  }
  const unionFidelity = {
    ...unionPrf1,
    avgVariantCountDiff: variantDiffs.length === 0 ? null : mean(variantDiffs),
  }

  // Roll up only the axes that had something to find in the original —
  // an empty axis (e.g. no enums in this schema) doesn't get free credit.
  const axisScores: number[] = [fieldCoverage.f1, typeAccuracy.familyRate]
  if (origIdx.enumPaths.size > 0) axisScores.push(enumDetection.f1)
  if (origIdx.mapPaths.size > 0) axisScores.push(dictDetection.f1)
  if (origIdx.unionPaths.size > 0) axisScores.push(unionFidelity.f1)

  return {
    fieldCoverage,
    typeAccuracy,
    enumDetection,
    dictDetection,
    unionFidelity,
    overallF1: mean(axisScores),
    fields,
  }
}

// ---------------------------------------------------------------------------
// Evaluation runner
// ---------------------------------------------------------------------------

export interface EvalCase {
  readonly name: string
  readonly schema: TypeRef
  /** Passed through to `fromJsonCorpus` when inferring from this case's generated corpus. */
  readonly config?: CorpusInferConfig
  /** Passed through to `generateCorpus` (minus `seed`, which the runner derives per case/size for reproducibility). */
  readonly generateOptions?: Omit<GenerateOptions, "seed">
}

export interface EvalCaseResult {
  readonly name: string
  readonly n: number
  readonly score: ScoreReport
}

export interface SizeAverage {
  readonly n: number
  readonly avgOverallF1: number
  readonly avgFieldCoverageF1: number
  readonly avgTypeAccuracyFamilyRate: number
  readonly avgEnumDetectionF1: number
  readonly avgDictDetectionF1: number
  readonly avgUnionFidelityF1: number
}

export interface EvalSummary {
  readonly sizes: readonly number[]
  readonly results: readonly EvalCaseResult[]
  readonly bySize: readonly SizeAverage[]
}

const defaultSizes = [5, 10, 50, 100, 500] as const

/**
 * Run a labeled set of schemas through generate -> infer -> score at each
 * of `sizes`, and summarize how quality trends with corpus size N.
 */
export function runEvaluation(cases: readonly EvalCase[], sizes: readonly number[] = defaultSizes): EvalSummary {
  const results: EvalCaseResult[] = []
  for (const evalCase of cases) {
    for (const n of sizes) {
      const corpus = generateCorpus(evalCase.schema, n, {
        ...evalCase.generateOptions,
        seed: `${evalCase.name}:${n}`,
      })
      const inferred = fromJsonCorpus(corpus, evalCase.config)
      const score = scoreInference(evalCase.schema, inferred)
      results.push({ name: evalCase.name, n, score })
    }
  }

  const bySize: SizeAverage[] = sizes.map((n) => {
    const atSize = results.filter((r) => r.n === n)
    return {
      n,
      avgOverallF1: mean(atSize.map((r) => r.score.overallF1)),
      avgFieldCoverageF1: mean(atSize.map((r) => r.score.fieldCoverage.f1)),
      avgTypeAccuracyFamilyRate: mean(atSize.map((r) => r.score.typeAccuracy.familyRate)),
      avgEnumDetectionF1: mean(atSize.map((r) => r.score.enumDetection.f1)),
      avgDictDetectionF1: mean(atSize.map((r) => r.score.dictDetection.f1)),
      avgUnionFidelityF1: mean(atSize.map((r) => r.score.unionFidelity.f1)),
    }
  })

  return { sizes, results, bySize }
}

// ---------------------------------------------------------------------------
// Labeled corpus — reuses test-fixtures.ts's hand-crafted realistic schemas
// (shared with cross-projector.test.ts/compile-check.test.ts, so this eval
// exercises the same shapes those suites already trust as representative)
// plus a few synthetic cases that target the specific heuristics named in
// from-json-corpus.ts: enum K/N saturation, discriminated-union Jaccard
// splits, and dict growth-ratio detection.
// ---------------------------------------------------------------------------

const statusEnumSchema = t(
  types.object({
    id: t(types.integer),
    // 4 distinct values repeated across many samples — deep in "enum" territory.
    status: t(types.enum(["pending", "active", "done", "archived"])),
  }),
)

// NOTE on shape: `tryDetectDU` (from-json-corpus.ts) only fires from
// `walkAndDetectDU`'s `array` branch — it looks for a field whose value is
// an ARRAY of union-shaped objects (`node.array.elementObjects`), not for a
// corpus whose top-level values are themselves the union members. A
// root-level union schema (like `apiResponse` above) therefore always
// scores `unionFidelity.recall === 0` regardless of N — a real detection
// gap this harness surfaced, not a sample-size problem. Nesting the union
// under an array field here exercises the code path DU detection actually
// supports.
const discriminatedUnionSchema = t(
  types.object({
    shapes: t(
      types.array(
        t(
          types.union([
            t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) })),
            t(types.object({ kind: t(types.literal("rect")), width: t(types.number), height: t(types.number) })),
            t(types.object({ kind: t(types.literal("triangle")), base: t(types.number), height: t(types.number) })),
          ]),
        ),
      ),
    ),
  }),
)

const dictSchema = t(
  types.object({
    // `scores` has no fixed field set across samples — every generated key
    // is unique, which is exactly the key-set-growth signal
    // `walkAndDetectDicts` looks for.
    scores: t(types.map(t(types.string), t(types.integer))),
    label: t(types.string),
  }),
)

/** The default labeled test set `inference-eval.test.ts` runs against. */
export const defaultLabeledCases: readonly EvalCase[] = [
  { name: "E-commerce Order", schema: ecommerceOrder },
  { name: "Discriminated Union API Response", schema: apiResponse },
  { name: "Kitchen Sink", schema: kitchenSink },
  {
    name: "Recursive Tree",
    schema: treeNode,
    generateOptions: { defs: { TreeNode: treeNode }, maxDepth: 3, arrayLengthRange: [0, 2] },
  },
  { name: "Status Enum", schema: statusEnumSchema },
  {
    name: "Shape Discriminated Union",
    schema: discriminatedUnionSchema,
    // Keep every sample's `shapes` array non-empty (min length 3, matching
    // fromJson's default `arrayThreshold`): an empty-array sample infers as
    // `array<unknown>` (see from-json.ts's "empty tuple carries zero
    // information" rule), and unifying that against a populated sample's
    // `array<object>` collapses the WHOLE element type to `unknown`
    // (`unknown` absorbs everything in `unifyTypes`) — a real corpus-merge
    // gap this harness surfaced, not something this case is meant to probe.
    generateOptions: { arrayLengthRange: [3, 6] },
  },
  { name: "Growing Dict", schema: dictSchema, generateOptions: { mapSizeRange: [1, 5] } },
]
