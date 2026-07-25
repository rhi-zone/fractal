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
import { fromJsonCorpus, type CorpusInferConfig, type ClusteringMethod } from "./from-json-corpus.ts"
import { uint8 } from "./kinds/common.ts"
import { ecommerceOrder, apiResponse, kitchenSink, treeNode, opt } from "./test-fixtures.ts"
import { mean, stddev, bootstrapCI, mulberry32, pairedBootstrapTest, type Rng, type ConfidenceInterval } from "./stats.ts"

export type { Rng }

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

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

// ---------------------------------------------------------------------------
// Generator profiles — pluggable presence/value distributions layered on
// top of generateValue's structural walk.
//
// Every eval result from Phase 1 was implicitly conditioned on exactly one
// generation policy: uniform random picks, a flat optional-presence rate, a
// flat null rate, uniform array/map sizing. That's a confound — a
// clustering method that wins under uniform field presence could lose under
// realistic skew, and none of the labeled cases probed enum false-positives
// at all. `GeneratorProfile` swaps the DISTRIBUTIONS `generateValue` samples
// from without touching the walk itself: each profile is one small
// `ProfileSampler` implementation, looked up once per corpus (via
// `resolveGenOptions`) and consulted at the handful of call sites below
// (optional-field presence, enum-member choice, scalar-leaf generation, map
// key choice).
// ---------------------------------------------------------------------------

export interface ZipfianPresenceProfile {
  readonly kind: "zipfian-presence"
  /**
   * Zipf exponent `s` in `weight(rank) = 1 / rank^s`, where `rank` is a
   * field's 1-based position among its object's optional fields (in
   * declaration order) or an enum member's 1-based position in its declared
   * member list. Higher = more skew. Default 1.2, in the "moderately
   * skewed" 1.0-1.5 range typical of real APIs: a few near-always-present
   * optional fields and a long tail of rare ones; enum values are almost
   * never uniformly distributed (`status: "active"` dominates
   * `status: "archived"`). This is expected to make `enumMinSamples`/
   * `looksLikeEnum`'s K/N threshold behave differently than under uniform
   * sampling — a rare enum value may not reach saturation (be observed at
   * all) until N is much larger than under uniform picks.
   */
  readonly exponent?: number
}

export interface AdversarialBoundaryProfile {
  readonly kind: "adversarial-boundary"
  /**
   * Signed offset applied to each targeted threshold's exact cutover before
   * constructing the corpus (e.g. `-0.02` lands just BELOW the cutover,
   * `+0.02` just ABOVE). Default 0 (land as close to exact as integer
   * sample/field counts allow). This profile directly evaluates threshold
   * PLACEMENT, not typical-case behavior — it deliberately constructs
   * corpora that land within one sample of a threshold's cutover, for every
   * threshold-bearing structural position it can act on:
   *
   *  - enum K/N ratio vs. 1/3 — `looksLikeEnum`'s `stronglyRepetitive`
   *    cutover (`from-json-corpus.ts`). Applied at every `enum`-shaped leaf:
   *    the corpus is built by cycling a fixed-size subset of the declared
   *    members (`K = round(N * (1/3 + epsilon))`) across the N samples, so
   *    the OBSERVED K/N ratio lands exactly at the target (subject to
   *    integer rounding).
   *  - field-set Jaccard distance vs. 0.1 — `tryDetectDU`'s
   *    group-distinctness cutover (`from-json-corpus.ts`). Applied at every
   *    object position with optional fields: the corpus is split into two
   *    halves by sample index, and a deterministically-chosen subset of
   *    optional fields (sized to hit `0.1 + epsilon` of the object's total
   *    field count) is present in the first half and absent in the second,
   *    with every other optional field always present so no incidental
   *    presence noise blurs the target distance. Approximate: field-count
   *    rounding means the achieved distance can differ slightly from the
   *    target on small objects.
   *  - dict key-growth ratio vs. 0.5 — `walkAndDetectDicts`'s
   *    `growthRatio` cutover (`from-json-corpus.ts`). Applied at every `map`
   *    position: each generated key is fresh with probability
   *    `0.5 + epsilon`, else reused from previously-seen keys at that
   *    position — probabilistic, not exact. `growthRatio` itself is
   *    `(distinct keys added) / (sample count)`, UNNORMALIZED by
   *    per-sample map size, so this only lands near the target ratio when
   *    `GenerateOptions.mapSizeRange` puts (close to) one entry per sample
   *    (e.g. `[1, 1]`) — at larger map sizes the achieved ratio scales up
   *    roughly proportionally to entries-per-sample instead.
   */
  readonly epsilon?: number
}

export interface HighCardinalityIdProfile {
  readonly kind: "high-cardinality-id"
  /**
   * Fraction of samples that get a freshly-minted (never-before-seen) value
   * at each plain `string`/`integer`-kind leaf position — near 1 means
   * near-unique per sample (UUID-like or sequential-ID-like). Default 0.98,
   * not exactly 1.0: real ID fields occasionally repeat (retries,
   * re-fetches, pagination overlap), and a hard 1.0 is an easier case than
   * this profile exists to probe. This is a NEGATIVE CONTROL: ground truth
   * for every field this touches is "must NOT be detected as enum" — it
   * exercises `scoreInference`'s enum-detection PRECISION axis (false
   * positives), which none of `defaultLabeledCases` specifically probes
   * (they all test recall — "did we find the real enum"). Only plain
   * `string`/`integer`-kind leaves are affected; already-enum/literal-typed
   * positions in the original schema are untouched, so a corpus generated
   * under this profile still has real enums to (correctly) detect alongside
   * the high-cardinality fields that must (correctly) be rejected.
   */
  readonly cardinalityRatio?: number
  /** ID value style: "uuid" (random hex UUID) or "sequential" (zero-padded counter / incrementing integer). Default "uuid". */
  readonly style?: "uuid" | "sequential"
}

export interface DirtyOutlierProfile {
  readonly kind: "dirty-outlier"
  /**
   * Fraction of samples steered to the first-declared variant of a
   * 2-variant `union` position (the "clean"/dominant variant); the
   * remainder go to the second variant (the minority/"dirty" one). Default
   * 0.95 — comfortably past `walkAndDetectDirty`'s `max / total > 0.9`
   * cutover (`from-json-corpus.ts`), so a corpus generated under the
   * default lands squarely in the shape that detection targets. Pass
   * something below 0.9 (e.g. 0.85) to build the NEGATIVE-CONTROL boundary
   * case instead — skewed, but not past the cutover, so dirty-data
   * collapsing must NOT fire.
   *
   * This is the profile that makes `detectDirtyData`
   * (`ResolveStrategy`/`AblationSignalKey`) measurable at all: before this
   * hook existed, `generateValue`'s union branch always picked a variant
   * uniformly, so `generateCorpus` essentially never produced the skewed
   * 2-variant union `walkAndDetectDirty` looks for (see the historical note
   * on `AblationSignalKey`).
   *
   * Only affects `union` positions with EXACTLY 2 variants, matching
   * `walkAndDetectDirty`'s own restriction — unions of any other arity fall
   * through to uniform picking, same as `uniformSampler`.
   */
  readonly dominantRatio?: number
}

/** See the individual profile interfaces for what each varies and why. `{ kind: "uniform" }` (or omitting `profile` entirely) keeps Phase 1's original flat/uniform behavior. */
export type GeneratorProfile =
  | { readonly kind: "uniform" }
  | ZipfianPresenceProfile
  | AdversarialBoundaryProfile
  | HighCardinalityIdProfile
  | DirtyOutlierProfile

/** Distribution hooks `generateValue` consults instead of sampling flat/uniform directly. Every method has a pass-through default (`uniformSampler`) so a profile only needs to override what it actually varies. */
interface ProfileSampler {
  /** Probability an optional field at `fieldName` (1-based `rank` among `objRef`'s optional fields, out of `optionalFieldNames`/`totalFieldCount`) is present in this sample. `base` is `GenerateOptions.optionalPresenceRate`, the uniform default. */
  presenceProbability(
    objRef: TypeRef,
    fieldName: string,
    rank: number,
    optionalFieldNames: readonly string[],
    totalFieldCount: number,
    base: number,
    sampleIndex: number,
    totalSamples: number,
  ): number
  /** Choose one member of an `enum`-shaped leaf's declared members. */
  pickEnumMember<T>(ref: TypeRef, members: readonly T[], rng: Rng, sampleIndex: number, totalSamples: number): T
  /** Override plain scalar-leaf generation for a given shape `kind`. Return `undefined` to fall through to the default `generateLeaf` behavior. */
  overrideLeaf(
    ref: TypeRef,
    kind: string,
    rng: Rng,
    sampleIndex: number,
    totalSamples: number,
  ): { readonly value: unknown } | undefined
  /** Choose a map entry's key, given the default-generated candidate key. */
  mapKey(ref: TypeRef, defaultKey: string, rng: Rng, sampleIndex: number, totalSamples: number): string
  /** Choose one variant of a `union`-shaped position's declared variants. */
  pickUnionVariant<T extends TypeRef>(ref: TypeRef, variants: readonly T[], rng: Rng, sampleIndex: number, totalSamples: number): T
}

const uniformSampler: ProfileSampler = {
  presenceProbability: (_objRef, _fieldName, _rank, _names, _totalFieldCount, base) => base,
  pickEnumMember: (_ref, members, rng) => pick(rng, members),
  overrideLeaf: () => undefined,
  mapKey: (_ref, defaultKey) => defaultKey,
  pickUnionVariant: (_ref, variants, rng) => pick(rng, variants),
}

function zipfWeights(count: number, exponent: number): number[] {
  return Array.from({ length: count }, (_, i) => 1 / Math.pow(i + 1, exponent))
}

function weightedPick<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!
    if (r <= 0) return items[i]!
  }
  return items[items.length - 1]!
}

function makeZipfianSampler(exponent: number): ProfileSampler {
  return {
    presenceProbability: (_objRef, _fieldName, rank) => clamp(1 / Math.pow(rank, exponent), 0, 1),
    pickEnumMember: (_ref, members, rng) => weightedPick(rng, members, zipfWeights(members.length, exponent)),
    overrideLeaf: () => undefined,
    mapKey: (_ref, defaultKey) => defaultKey,
    pickUnionVariant: (_ref, variants, rng) => pick(rng, variants),
  }
}

function makeAdversarialSampler(epsilon: number): ProfileSampler {
  const enumCycles = new WeakMap<TypeRef, readonly unknown[]>()
  const objectOmitSets = new WeakMap<TypeRef, ReadonlySet<string>>()
  const mapGrowthState = new WeakMap<TypeRef, { seenKeys: string[] }>()

  return {
    presenceProbability: (objRef, fieldName, _rank, optionalFieldNames, totalFieldCount, _base, sampleIndex, totalSamples) => {
      let omit = objectOmitSets.get(objRef)
      if (omit === undefined) {
        const target = clamp(0.1 + epsilon, 0, 1)
        const omitCount = clamp(Math.round(target * totalFieldCount), 0, optionalFieldNames.length)
        omit = new Set(optionalFieldNames.slice(0, omitCount))
        objectOmitSets.set(objRef, omit)
      }
      if (!omit.has(fieldName)) return 1 // only the boundary-defining fields carry presence variation
      const inClusterB = sampleIndex >= Math.floor(totalSamples / 2)
      return inClusterB ? 0 : 1
    },
    pickEnumMember: (ref, members, _rng, sampleIndex, totalSamples) => {
      let cycle = enumCycles.get(ref) as readonly (typeof members)[number][] | undefined
      if (cycle === undefined) {
        const target = clamp(1 / 3 + epsilon, 0, 1)
        const k = clamp(Math.round(totalSamples * target), 1, members.length)
        cycle = members.slice(0, k)
        enumCycles.set(ref, cycle)
      }
      return cycle[sampleIndex % cycle.length]!
    },
    overrideLeaf: () => undefined,
    mapKey: (ref, defaultKey, rng, _sampleIndex, _totalSamples) => {
      let st = mapGrowthState.get(ref)
      if (st === undefined) {
        st = { seenKeys: [] }
        mapGrowthState.set(ref, st)
      }
      const target = clamp(0.5 + epsilon, 0, 1)
      if (st.seenKeys.length === 0 || rng() < target) {
        st.seenKeys.push(defaultKey)
        return defaultKey
      }
      return pick(rng, st.seenKeys)
    },
    pickUnionVariant: (_ref, variants, rng) => pick(rng, variants),
  }
}

function makeHighCardinalitySampler(cardinalityRatio: number, style: "uuid" | "sequential"): ProfileSampler {
  const state = new WeakMap<TypeRef, { seen: unknown[]; counter: number }>()

  return {
    presenceProbability: (_objRef, _fieldName, _rank, _names, _totalFieldCount, base) => base,
    pickEnumMember: (_ref, members, rng) => pick(rng, members),
    overrideLeaf: (ref, kind, rng) => {
      if (kind !== "string" && kind !== "integer") return undefined
      let st = state.get(ref)
      if (st === undefined) {
        st = { seen: [], counter: 0 }
        state.set(ref, st)
      }
      if (st.seen.length === 0 || rng() < cardinalityRatio) {
        const value = kind === "integer"
          ? (style === "sequential" ? st.counter++ : randInt(rng, 0, 10_000_000))
          : (style === "sequential" ? `id-${String(st.counter++).padStart(6, "0")}` : randomUuid(rng))
        st.seen.push(value)
        return { value }
      }
      return { value: pick(rng, st.seen) }
    },
    mapKey: (_ref, defaultKey) => defaultKey,
    pickUnionVariant: (_ref, variants, rng) => pick(rng, variants),
  }
}

function makeDirtyOutlierSampler(dominantRatio: number): ProfileSampler {
  return {
    ...uniformSampler,
    pickUnionVariant: (_ref, variants, rng) => {
      if (variants.length !== 2) return pick(rng, variants) // only the 2-variant case is what `walkAndDetectDirty` looks for
      return rng() < dominantRatio ? variants[0]! : variants[1]!
    },
  }
}

function resolveProfile(profile: GeneratorProfile | undefined): ProfileSampler {
  if (profile === undefined || profile.kind === "uniform") return uniformSampler
  switch (profile.kind) {
    case "zipfian-presence": return makeZipfianSampler(profile.exponent ?? 1.2)
    case "adversarial-boundary": return makeAdversarialSampler(profile.epsilon ?? 0)
    case "high-cardinality-id": return makeHighCardinalitySampler(profile.cardinalityRatio ?? 0.98, profile.style ?? "uuid")
    case "dirty-outlier": return makeDirtyOutlierSampler(profile.dominantRatio ?? 0.95)
  }
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
  /**
   * The presence/value-frequency distribution `generateValue` samples from,
   * in place of the flat/uniform defaults above. See `GeneratorProfile`.
   * Default: `{ kind: "uniform" }` (Phase 1's original behavior — every eval
   * result before this option existed was implicitly generated under it).
   */
  readonly profile?: GeneratorProfile
}

interface ResolvedGenOptions {
  readonly rng: Rng
  readonly optionalPresenceRate: number
  readonly nullableNullRate: number
  readonly arrayLengthRange: readonly [number, number]
  readonly mapSizeRange: readonly [number, number]
  readonly defs: Readonly<Record<string, TypeRef>>
  readonly maxDepth: number
  readonly profile: ProfileSampler
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
    profile: resolveProfile(options?.profile),
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

function generateValue(
  ref: TypeRef,
  opts: ResolvedGenOptions,
  depth: number,
  sampleIndex: number,
  totalSamples: number,
): unknown {
  if (ref.meta.nullable === true && opts.rng() < opts.nullableNullRate) return null

  const { shape } = ref
  const forceEmptyContainers = depth >= opts.maxDepth

  switch (shape.kind) {
    case "object": {
      const fields = (shape as { fields: Readonly<Record<string, TypeRef>> }).fields
      const entries = Object.entries(fields)
      const optionalFieldNames = entries.filter(([, r]) => r.meta.optional === true).map(([name]) => name)
      const totalFieldCount = entries.length
      const out: Record<string, unknown> = {}
      let rank = 0
      for (const [name, fieldRef] of entries) {
        if (fieldRef.meta.optional === true) {
          rank++
          const p = opts.profile.presenceProbability(
            ref, name, rank, optionalFieldNames, totalFieldCount, opts.optionalPresenceRate, sampleIndex, totalSamples,
          )
          if (opts.rng() >= p) continue
        }
        out[name] = generateValue(fieldRef, opts, depth + 1, sampleIndex, totalSamples)
      }
      return out
    }
    case "array": {
      const element = (shape as { element: TypeRef }).element
      const [lo, hi] = opts.arrayLengthRange
      const len = forceEmptyContainers ? 0 : randInt(opts.rng, lo, hi)
      return Array.from({ length: len }, () => generateValue(element, opts, depth + 1, sampleIndex, totalSamples))
    }
    case "tuple": {
      const elements = (shape as { elements: readonly TypeRef[] }).elements
      return elements.map((el) => generateValue(el, opts, depth + 1, sampleIndex, totalSamples))
    }
    case "map": {
      const value = (shape as { value: TypeRef }).value
      const [lo, hi] = opts.mapSizeRange
      const size = forceEmptyContainers ? 0 : randInt(opts.rng, lo, hi)
      const out: Record<string, unknown> = {}
      for (let i = 0; i < size; i++) {
        const defaultKey = `${randomWord(opts.rng)}_${i}`
        const key = opts.profile.mapKey(ref, defaultKey, opts.rng, sampleIndex, totalSamples)
        out[key] = generateValue(value, opts, depth + 1, sampleIndex, totalSamples)
      }
      return out
    }
    case "union": {
      const variants = (shape as { variants: readonly TypeRef[] }).variants
      if (variants.length === 0) return null
      const chosen = opts.profile.pickUnionVariant(ref, variants, opts.rng, sampleIndex, totalSamples)
      return generateValue(chosen, opts, depth + 1, sampleIndex, totalSamples)
    }
    case "literal": {
      return (shape as { value: string | number | boolean | null }).value
    }
    case "enum": {
      const members = (shape as { members: readonly string[] }).members
      if (members.length === 0) return ""
      return opts.profile.pickEnumMember(ref, members, opts.rng, sampleIndex, totalSamples)
    }
    case "ref": {
      const target = (shape as { target: string }).target
      const resolved = opts.defs[target]
      if (resolved === undefined) return null // unresolvable ref — no defs given, degrade to null
      return generateValue(resolved, opts, depth + 1, sampleIndex, totalSamples)
    }
    default: {
      const override = opts.profile.overrideLeaf(ref, shape.kind, opts.rng, sampleIndex, totalSamples)
      if (override !== undefined) return override.value
      return generateLeaf(shape.kind, opts)
    }
  }
}

/**
 * Generate `n` synthetic JSON values that conform to `schema` — the inverse
 * of `fromJsonCorpus`. Deterministic given the same `options.seed`.
 */
export function generateCorpus(schema: TypeRef, n: number, options?: GenerateOptions): unknown[] {
  const opts = resolveGenOptions(options)
  return Array.from({ length: n }, (_, i) => generateValue(schema, opts, 0, i, n))
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
  /** enum path -> the declared member set (for member-set-fidelity comparison). */
  readonly enumMembersAt: ReadonlyMap<string, ReadonlySet<string>>
}

function indexSchema(root: TypeRef): SchemaIndex {
  const paths = new Set<string>()
  const kindAt = new Map<string, string>()
  const enumPaths = new Set<string>()
  const unionPaths = new Set<string>()
  const mapPaths = new Set<string>()
  const variantCounts = new Map<string, number>()
  const enumMembersAt = new Map<string, ReadonlySet<string>>()

  function visit(ref: TypeRef, path: string, seen: ReadonlySet<TypeRef>): void {
    if (seen.has(ref)) return // guard against `ref`-free structural cycles (shouldn't occur, but stay safe)
    const nextSeen = new Set(seen)
    nextSeen.add(ref)

    const { shape } = ref
    if (path !== "") {
      paths.add(path)
      kindAt.set(path, shape.kind)
    }
    if (shape.kind === "enum") {
      enumPaths.add(path)
      const members = (shape as { members: readonly string[] }).members
      enumMembersAt.set(path, new Set(members))
    }
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
  return { paths, kindAt, enumPaths, unionPaths, mapPaths, variantCounts, enumMembersAt }
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
  /** Did we find the enum-shaped positions (vs. leaving them as plain string/integer). Shape only — says nothing about whether the recovered member set is right; see `enumMemberFidelity`. */
  readonly enumDetection: PrecisionRecallF1
  /**
   * Among positions BOTH schemas agree are enum-shaped, how well did the
   * inferred member set match the true one. Precision: inferred members
   * that are real. Recall: real members that were found (the axis that
   * catches a rare member simply never appearing in a small sample — see
   * module doc / the zipfian-presence finding in inference-eval.test.ts).
   * Micro-averaged across compared positions (sums matched/actual/predicted
   * member counts, then computes one precision/recall/f1) rather than
   * averaging per-position rates, matching `fieldCoverage`/`enumDetection`'s
   * existing set-based convention. `comparedPositions === 0` (no position
   * where both schemas agree it's an enum) reports the vacuous perfect
   * score, same convention as `typeAccuracy`'s `compared === 0` case — this
   * axis is about member-set quality GIVEN shape was found, so it's excluded
   * from `overallF1` whenever there's nothing to compare, exactly like the
   * other conditionally-included axes below.
   */
  readonly enumMemberFidelity: PrecisionRecallF1 & { readonly comparedPositions: number }
  /** Did we find the dict-shaped positions (vs. leaving them as fixed-field record). */
  readonly dictDetection: PrecisionRecallF1
  /** Did we find the union-shaped positions (incl. discriminated unions), and how close were variant counts. */
  readonly unionFidelity: PrecisionRecallF1 & { readonly avgVariantCountDiff: number | null }
  /** Single-number rollup — unweighted mean of the axes above that apply (an axis with nothing to find in the original is excluded, not scored as a free win). */
  readonly overallF1: number
  readonly fields: readonly FieldComparison[]
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

  let memberMatched = 0
  let memberActual = 0
  let memberPredicted = 0
  let comparedPositions = 0
  for (const path of origIdx.enumPaths) {
    if (!infIdx.enumPaths.has(path)) continue // shape not recovered here — enumDetection already penalizes this
    const origMembers = origIdx.enumMembersAt.get(path)!
    const infMembers = infIdx.enumMembersAt.get(path)!
    comparedPositions++
    memberActual += origMembers.size
    memberPredicted += infMembers.size
    for (const m of origMembers) if (infMembers.has(m)) memberMatched++
  }
  const enumMemberFidelity = { ...prf1(memberMatched, memberActual, memberPredicted), comparedPositions }

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
  if (comparedPositions > 0) axisScores.push(enumMemberFidelity.f1)
  if (origIdx.mapPaths.size > 0) axisScores.push(dictDetection.f1)
  if (origIdx.unionPaths.size > 0) axisScores.push(unionFidelity.f1)

  return {
    fieldCoverage,
    typeAccuracy,
    enumDetection,
    enumMemberFidelity,
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
  readonly avgEnumMemberFidelityF1: number
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
      avgEnumMemberFidelityF1: mean(atSize.map((r) => r.score.enumMemberFidelity.f1)),
      avgDictDetectionF1: mean(atSize.map((r) => r.score.dictDetection.f1)),
      avgUnionFidelityF1: mean(atSize.map((r) => r.score.unionFidelity.f1)),
    }
  })

  return { sizes, results, bySize }
}

// ---------------------------------------------------------------------------
// Multi-trial evaluation — `runEvaluation` runs each (case, n) pair at
// exactly one seed, so a single run is one sample of a random variable, not
// a distribution. `runEvaluationTrials` runs `trialCount` independent seeds
// per (case, n) — `${evalCase.name}:${n}:${trial}`, preserving per-trial
// determinism/reproducibility the same way `runEvaluation` does for a
// single trial — and reports the resulting distribution (mean, stddev, 95%
// bootstrap CI) for `overallF1` and each sub-axis, rather than one number.
// ---------------------------------------------------------------------------

/** The sub-axis F1s (plus `overallF1`) that `runEvaluationTrials` tracks a distribution for. */
export type EvalAxis =
  | "overallF1"
  | "fieldCoverageF1"
  | "typeAccuracyFamilyRate"
  | "enumDetectionF1"
  | "enumMemberFidelityF1"
  | "dictDetectionF1"
  | "unionFidelityF1"

const evalAxes: readonly EvalAxis[] = [
  "overallF1",
  "fieldCoverageF1",
  "typeAccuracyFamilyRate",
  "enumDetectionF1",
  "enumMemberFidelityF1",
  "dictDetectionF1",
  "unionFidelityF1",
]

function axisValue(score: ScoreReport, axis: EvalAxis): number {
  switch (axis) {
    case "overallF1": return score.overallF1
    case "fieldCoverageF1": return score.fieldCoverage.f1
    case "typeAccuracyFamilyRate": return score.typeAccuracy.familyRate
    case "enumDetectionF1": return score.enumDetection.f1
    case "enumMemberFidelityF1": return score.enumMemberFidelity.f1
    case "dictDetectionF1": return score.dictDetection.f1
    case "unionFidelityF1": return score.unionFidelity.f1
  }
}

/**
 * Pull the raw per-trial values for one axis out of a `CaseSizeTrialResult`
 * — the shape `pairedBootstrapTest` (see stats.ts) wants for comparing two
 * configurations run on the same (case, n) at the same trial count: e.g.
 * `pairedBootstrapTest(axisValues(a, "overallF1"), axisValues(b, "overallF1"), rng)`
 * where `a`/`b` came from separately-configured `runEvaluationTrials` calls
 * over the same `cases`/`sizes`/`trialCount` (so trial `i` in each used the
 * same generated corpus).
 */
export function axisValues(result: CaseSizeTrialResult, axis: EvalAxis): number[] {
  return result.trials.map((score) => axisValue(score, axis))
}

export interface AxisStats {
  readonly mean: number
  readonly stddev: number
  /** 95% (or `options.ciLevel`) percentile bootstrap confidence interval on the mean. */
  readonly ci: ConfidenceInterval
}

export interface CaseSizeTrialResult {
  readonly name: string
  readonly n: number
  readonly trialCount: number
  /** Per-axis distribution summary — mean/stddev/CI. Keyed by `EvalAxis`. */
  readonly stats: Readonly<Record<EvalAxis, AxisStats>>
  /** The raw per-trial score reports, in trial order — use with `axisValues` for paired comparisons. */
  readonly trials: readonly ScoreReport[]
}

export interface EvalTrialsSummary {
  readonly sizes: readonly number[]
  readonly trialCount: number
  readonly results: readonly CaseSizeTrialResult[]
}

export interface RunEvaluationTrialsOptions {
  /** Bootstrap confidence level. Default 0.95. */
  readonly ciLevel?: number
  /** Bootstrap resample count per CI. Default 2000. */
  readonly resamples?: number
}

/**
 * Run each `(case, n)` pair in `cases` x `sizes` across `trialCount`
 * independent seeds and summarize the resulting distribution of
 * `overallF1` and each sub-axis F1, instead of `runEvaluation`'s single
 * point sample per pair. Seeds are derived as
 * `${evalCase.name}:${n}:${trial}`, so trial `i` is reproducible on its own
 * and — for two `runEvaluationTrials` calls made with the same `cases`
 * (same names/schemas), `sizes`, and `trialCount` but different
 * `EvalCase.config` — trial `i` in one call and trial `i` in the other were
 * generated from the SAME corpus, making per-index differences meaningful
 * for `pairedBootstrapTest`.
 */
export function runEvaluationTrials(
  cases: readonly EvalCase[],
  sizes: readonly number[] = defaultSizes,
  trialCount: number,
  options?: RunEvaluationTrialsOptions,
): EvalTrialsSummary {
  const ciLevel = options?.ciLevel ?? 0.95
  const resamples = options?.resamples ?? 2000

  const results: CaseSizeTrialResult[] = []
  for (const evalCase of cases) {
    for (const n of sizes) {
      const trials: ScoreReport[] = []
      for (let trial = 0; trial < trialCount; trial++) {
        const corpus = generateCorpus(evalCase.schema, n, {
          ...evalCase.generateOptions,
          seed: `${evalCase.name}:${n}:${trial}`,
        })
        const inferred = fromJsonCorpus(corpus, evalCase.config)
        trials.push(scoreInference(evalCase.schema, inferred))
      }

      // A dedicated bootstrap-resampling RNG stream, seeded off the case/n
      // pair (not off any individual trial's seed) so resampling is
      // reproducible without colluding with corpus-generation randomness.
      const bootstrapRng = rngFromSeed(`${evalCase.name}:${n}:bootstrap`)
      const stats = Object.fromEntries(
        evalAxes.map((axis) => {
          const values = trials.map((score) => axisValue(score, axis))
          return [
            axis,
            { mean: mean(values), stddev: stddev(values), ci: bootstrapCI(values, bootstrapRng, { level: ciLevel, resamples }) },
          ]
        }),
      ) as Record<EvalAxis, AxisStats>

      results.push({ name: evalCase.name, n, trialCount, stats, trials })
    }
  }

  return { sizes, trialCount, results }
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

// A 2-variant scalar union, paired with the `dirty-outlier` profile (see
// its doc) to land the skewed corpus shape `walkAndDetectDirty`
// (from-json-corpus.ts) targets: one variant holding >90% of the raw
// values, the other treated as dirty-data noise. Declaring the union
// directly in the schema (rather than injecting noise at a plain scalar
// leaf) is what lets `hasShapeForSignal`'s existing `idx.unionPaths.size >
// 0` classification pick this case up as a `detectDirtyData` positive
// control automatically, the same way every other union-recovery signal's
// positive control is classified.
//
// The dominant variant is `uint8` (fixed [0,255] range), NOT the generic
// `types.integer` -- deliberately. `walkAndDetectDirty` re-infers each raw
// value's type from scratch via a config-less `fromJson(val)` call and
// compares it against the corpus-MERGED variant type via strict
// `shapeEqual`. A generic `integer` variant generated over a wide range
// (e.g. [-1000, 1000]) spans MULTIPLE narrow integer widths (`uint8`,
// `int8`, `int16`, ...); `fromJson`'s per-value width narrowing picks a
// different tight kind for different individual values even though the
// corpus-wide merge widens them all to one common kind, so most individual
// values silently fail the `shapeEqual` comparison against that widened
// merged kind -- undercounting the true majority and making collapsing
// fail to fire even at extreme skew. This was found empirically while
// building this eval case (probing `types.integer` at 95%+ skew never
// collapsed): pinning the dominant variant to a single fixed-width kind
// like `uint8` keeps every individual re-inferred value's kind identical
// to the merged kind, exercising `walkAndDetectDirty` as designed instead
// of tripping over this width-narrowing mismatch.
const dirtyOutlierSchema = t(
  types.object({
    id: t(types.integer),
    count: t(types.union([uint8(), t(types.string)])),
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
  {
    name: "Dirty Outlier Field",
    schema: dirtyOutlierSchema,
    // Comfortably past `walkAndDetectDirty`'s 0.9 cutover (default
    // `dominantRatio` 0.95) — see `dirtyOutlierSchema`'s doc.
    generateOptions: { profile: { kind: "dirty-outlier" } },
  },
]

// ---------------------------------------------------------------------------
// Ablation runner (Phase 3 of the JSON-inference evaluation rigor plan) —
// leave-one-out ablation over `ResolveStrategy`'s boolean detection toggles
// (`from-json-corpus.ts`), following JSONoid's design: for each signal, run
// the full evaluation once with the signal ON and once OFF (all other
// signals at their default), across `trialCount` trials, and report on TWO
// axes rather than one:
//
//  - `discriminativePower` — does the signal ON improve RECALL on cases
//    whose ground-truth schema actually HAS the shape the signal detects
//    (e.g. `detectEnums` on the "Status Enum" case).
//  - `overfitRate` — does the signal ON hurt PRECISION on cases whose
//    ground truth does NOT have that shape (e.g. does `detectEnums` fire
//    spuriously on cases with no enum fields at all). This is the axis
//    `defaultLabeledCases` alone never probed before the `high-cardinality-id`
//    profile (Phase 2) — JSONoid's finding was that these two axes trade off
//    very differently per signal, so a signal that wins on recall can still
//    be a net loss if it also tanks precision elsewhere.
//
// Positive/negative case classification is automatic, not hand-curated: a
// case is a positive control for a signal if its ORIGINAL schema contains
// the shape that signal targets (checked via `indexSchema`, the same index
// `scoreInference` builds), and a negative control if it doesn't. This is
// the same principle the `high-cardinality-id` profile embodies (ground
// truth = "must not be detected") generalized to run automatically over
// whatever `cases` the caller supplies, rather than requiring a dedicated
// profile per signal.
// ---------------------------------------------------------------------------

/**
 * The `ResolveStrategy` boolean toggles this ablation runner evaluates.
 * `detectDirtyData`'s effect is measurable via the "Dirty Outlier Field"
 * case in `defaultLabeledCases`, which pairs a 2-variant scalar union with
 * the `dirty-outlier` `GeneratorProfile` to land the skewed corpus shape
 * `walkAndDetectDirty` (from-json-corpus.ts) looks for. Before that profile
 * existed, `generateValue`'s union branch always picked a variant
 * uniformly — no profile hook varied union-variant selection — so
 * `generateCorpus` essentially never produced the >90%-skewed 2-variant
 * union this signal needs, and the ablation could only report a null tie
 * (see the git history on this module for that finding).
 */
export type AblationSignalKey =
  | "detectEnums"
  | "detectDiscriminatedUnions"
  | "detectDicts"
  | "detectCfdDiscriminants"
  | "splitDissimilarObjects"
  | "detectDirtyData"

const ablationSignals: readonly AblationSignalKey[] = [
  "detectEnums",
  "detectDiscriminatedUnions",
  "detectDicts",
  "detectCfdDiscriminants",
  "splitDissimilarObjects",
  "detectDirtyData",
]

/**
 * Which `ScoreReport` precision/recall axis a signal's effect shows up on.
 * `detectDiscriminatedUnions`/`splitDissimilarObjects`/`detectCfdDiscriminants`/
 * `detectDirtyData` all act on union recovery (via different mechanisms —
 * discriminant-field detection, general structural splitting, CFD-style
 * discriminant search, and dirty-minority-variant collapsing respectively)
 * so they share `unionFidelity` as their target axis; each still gets its
 * own independent ON/OFF run (only that one toggle changes, the rest stay
 * at default), so the numbers legitimately differ per signal even though
 * the axis and case classification are the same.
 */
function signalAxis(score: ScoreReport, signal: AblationSignalKey): PrecisionRecallF1 {
  switch (signal) {
    case "detectEnums": return score.enumDetection
    case "detectDicts": return score.dictDetection
    case "detectDiscriminatedUnions":
    case "splitDissimilarObjects":
    case "detectCfdDiscriminants":
    case "detectDirtyData":
      return score.unionFidelity
  }
}

/** Does `schema`'s ground truth contain the shape `signal` is meant to detect — the automatic positive/negative-control classifier described above. */
function hasShapeForSignal(schema: TypeRef, signal: AblationSignalKey): boolean {
  const idx = indexSchema(schema)
  switch (signal) {
    case "detectEnums": return idx.enumPaths.size > 0
    case "detectDicts": return idx.mapPaths.size > 0
    case "detectDiscriminatedUnions":
    case "splitDissimilarObjects":
    case "detectCfdDiscriminants":
    case "detectDirtyData":
      return idx.unionPaths.size > 0
  }
}

/** One ON-vs-OFF comparison, paired-bootstrap tested (same seeds on both sides — only the signal's toggle differs). */
export interface AblationDelta {
  readonly onMean: number
  readonly offMean: number
  /** onMean - offMean. Positive means turning the signal ON helped (recall axis) or hurt (precision axis, where "helped" would be a smaller drop). */
  readonly meanDiff: number
  readonly pValue: number
  readonly significant: boolean
  readonly sampleCount: number
}

/** Reported when no case in the supplied set can serve as a control for a signal (positive: none has the shape; negative: every case has the shape). */
export interface AblationNotMeasurable {
  readonly measurable: false
  readonly reason: string
}

export interface SignalAblationReport {
  readonly signal: AblationSignalKey
  /** `ScoreReport` axis this signal's effect was measured on (see `signalAxis`). */
  readonly axis: "enumDetection" | "dictDetection" | "unionFidelity"
  /** Recall-based: does the signal ON find more of what's really there, on cases whose ground truth has the shape. */
  readonly discriminativePower: AblationDelta | AblationNotMeasurable
  /** Precision-based: does the signal ON introduce false positives, on cases whose ground truth does NOT have the shape. */
  readonly overfitRate: AblationDelta | AblationNotMeasurable
  readonly positiveCaseNames: readonly string[]
  readonly negativeCaseNames: readonly string[]
}

export interface AblationRunnerOptions {
  readonly ciLevel?: number
  readonly resamples?: number
  readonly bootstrapSeed?: number | string
}

function withSignalToggle(cases: readonly EvalCase[], signal: AblationSignalKey, on: boolean): EvalCase[] {
  return cases.map((c) => ({ ...c, config: { ...c.config, [signal]: on } }))
}

/** Pools every trial's `part` (precision/recall) value for `signal`'s axis across every (case, n) in `summary`, in a stable order — the shape `pairedBootstrapTest` needs when the ON and OFF summaries were run over the same cases/sizes/trialCount (so index i on each side shares a seed). */
function pooledPart(summary: EvalTrialsSummary, signal: AblationSignalKey, part: "precision" | "recall"): number[] {
  const out: number[] = []
  for (const r of summary.results) for (const score of r.trials) out.push(signalAxis(score, signal)[part])
  return out
}

/**
 * Leave-one-out ablation over every `AblationSignalKey`: for each signal,
 * run `cases` x `sizes` x `trialCount` twice (signal ON, signal OFF — all
 * other `ResolveStrategy` toggles left at their defaults) via
 * `runEvaluationTrials`, and report `discriminativePower` (recall delta on
 * positive-control cases) and `overfitRate` (precision delta on
 * negative-control cases), each paired-bootstrap tested. `O(signals)` runs,
 * not the full `O(2^signals)` power set.
 */
export function ablationRunner(
  cases: readonly EvalCase[],
  sizes: readonly number[],
  trialCount: number,
  opts?: AblationRunnerOptions,
): readonly SignalAblationReport[] {
  const bootstrapRng = rngFromSeed(opts?.bootstrapSeed ?? "ablation")
  const trialOpts: RunEvaluationTrialsOptions = {
    ...(opts?.ciLevel !== undefined ? { ciLevel: opts.ciLevel } : {}),
    ...(opts?.resamples !== undefined ? { resamples: opts.resamples } : {}),
  }
  const pairedOpts = {
    ...(opts?.ciLevel !== undefined ? { level: opts.ciLevel } : {}),
    ...(opts?.resamples !== undefined ? { resamples: opts.resamples } : {}),
  }

  function delta(onVals: readonly number[], offVals: readonly number[]): AblationDelta {
    const test = pairedBootstrapTest(onVals, offVals, bootstrapRng, pairedOpts)
    return {
      onMean: mean(onVals),
      offMean: mean(offVals),
      meanDiff: test.meanDiff,
      pValue: test.pValue,
      significant: test.significant,
      sampleCount: onVals.length,
    }
  }

  return ablationSignals.map((signal) => {
    const axisName = signal === "detectEnums" ? "enumDetection" : signal === "detectDicts" ? "dictDetection" : "unionFidelity"
    const positiveCases = cases.filter((c) => hasShapeForSignal(c.schema, signal))
    const negativeCases = cases.filter((c) => !hasShapeForSignal(c.schema, signal))

    let discriminativePower: AblationDelta | AblationNotMeasurable
    if (positiveCases.length === 0) {
      discriminativePower = {
        measurable: false,
        reason: `no case in the supplied set has ground truth containing the shape ${signal} detects — discriminative power (recall) is not measurable without a positive-control case`,
      }
    } else {
      const on = runEvaluationTrials(withSignalToggle(positiveCases, signal, true), sizes, trialCount, trialOpts)
      const off = runEvaluationTrials(withSignalToggle(positiveCases, signal, false), sizes, trialCount, trialOpts)
      discriminativePower = delta(pooledPart(on, signal, "recall"), pooledPart(off, signal, "recall"))
    }

    let overfitRate: AblationDelta | AblationNotMeasurable
    if (negativeCases.length === 0) {
      overfitRate = {
        measurable: false,
        reason: `every case in the supplied set has ground truth containing the shape ${signal} detects — overfit rate (precision on true negatives) is not measurable without a negative-control case`,
      }
    } else {
      const on = runEvaluationTrials(withSignalToggle(negativeCases, signal, true), sizes, trialCount, trialOpts)
      const off = runEvaluationTrials(withSignalToggle(negativeCases, signal, false), sizes, trialCount, trialOpts)
      overfitRate = delta(pooledPart(on, signal, "precision"), pooledPart(off, signal, "precision"))
    }

    return {
      signal,
      axis: axisName,
      discriminativePower,
      overfitRate,
      positiveCaseNames: positiveCases.map((c) => c.name),
      negativeCaseNames: negativeCases.map((c) => c.name),
    }
  })
}

// ---------------------------------------------------------------------------
// Clustering-method sweep — the JSONoid-derived comparison the design calls
// for: run each `clusteringMethod` across each `GeneratorProfile` and check
// whether one method's confidence interval sits strictly above the other
// two's on EVERY profile (crown it the default) or the intervals overlap
// somewhere in the sweep (no universal default — expose as configuration).
// Cases are chosen to isolate the specific clustering failure modes
// `ResolveStrategy.clusteringMethod`'s doc names (chaining risk,
// near-identical polymorphic-API-response shapes, and — critically —
// `"key-signature"`'s own documented weakness: "over-splits ordinary
// records with a few sparsely-present optional fields"). Leaving that last
// case out would silently bias the sweep toward whichever method the OTHER
// three cases were built to favor (key-signature, on this set); it's the
// negative control that makes "crowned default" a claim earned across the
// method's known failure mode, not just its known strength. Same schemas
// the single-trial/multi-trial comparisons in inference-eval.test.ts use,
// kept here so `clusteringMethodSweep` has a sensible default without
// requiring every caller to redefine them.
// ---------------------------------------------------------------------------

const clusteringDisjointSchema = t(
  types.union([
    t(types.object({ userId: t(types.integer), userName: t(types.string), userEmail: t(types.string) })),
    t(types.object({ orderId: t(types.integer), total: t(types.number), items: t(types.integer) })),
  ]),
)

const clusteringChainingRiskSchema = t(
  types.union([
    t(types.object({ p: t(types.integer), shared1: t(types.string) })),
    t(types.object({ shared1: t(types.string), shared2: t(types.string) })),
    t(types.object({ shared2: t(types.string), q: t(types.integer) })),
  ]),
)

const clusteringApiVariantsSchema = t(
  types.union([
    t(types.object({ id: t(types.integer), name: t(types.string) })),
    t(types.object({ id: t(types.integer), name: t(types.string), extra: t(types.boolean) })),
  ]),
)

// A single population (NOT a union — no unionPaths in ground truth at all)
// with six sparsely-present optional fields. Real records routinely look
// like this (a handful of near-always-present fields plus a long tail of
// rare ones), and every sample's key set differs from every other's purely
// from independent presence noise — exactly the shape `key-signature`'s
// doc warns it over-splits, since it groups by *exact* key-set signature
// with no distance tolerance. `splitDissimilarObjects`'s ablation
// (`ablationRunner`) already covers this schema as a generic
// negative-control case; it's included here too so the clustering-method
// sweep specifically stress-tests key-signature's weakness alongside its
// strength, not just the latter.
const clusteringSparseSingleTypeSchema = t(
  types.object({
    required: t(types.string),
    o1: opt(t(types.string)),
    o2: opt(t(types.string)),
    o3: opt(t(types.string)),
    o4: opt(t(types.string)),
    o5: opt(t(types.string)),
    o6: opt(t(types.string)),
  }),
)

/** Default cases for `clusteringMethodSweep` — see module comment above. */
export const clusteringSensitiveCases: readonly EvalCase[] = [
  { name: "disjoint", schema: clusteringDisjointSchema },
  { name: "chaining-risk", schema: clusteringChainingRiskSchema, config: { objectSplitThreshold: 0.8 } },
  { name: "api-variants", schema: clusteringApiVariantsSchema },
  { name: "sparse-single-type", schema: clusteringSparseSingleTypeSchema, generateOptions: { optionalPresenceRate: 0.3 } },
]

const clusteringMethods: readonly ClusteringMethod[] = ["single-linkage", "complete-linkage", "key-signature"]

export interface ClusteringMethodSweepResult {
  readonly profile: string
  readonly method: ClusteringMethod
  readonly mean: number
  readonly ci: ConfidenceInterval
  readonly sampleCount: number
}

export interface ClusteringMethodSweepSummary {
  readonly results: readonly ClusteringMethodSweepResult[]
  /** Which conclusion the data supports — computed, not presupposed. See module comment. */
  readonly conclusion: string
  /** method that strictly dominated (CI low > every other method's CI high) on every profile, if any. */
  readonly crownedDefault: ClusteringMethod | undefined
}

/**
 * Run every `ClusteringMethod` x `profile` combination in `profiles` over
 * `cases` (default `clusteringSensitiveCases`) x `sizes` x `trialCount`,
 * pooling `unionFidelity.f1` (the axis these schemas are built to isolate)
 * across cases/sizes/trials into one bootstrap CI per method/profile cell.
 * `crownedDefault` is set only when one method's CI sits strictly above
 * both others' on every profile in the sweep; otherwise the honest
 * conclusion is "no universal default, expose as configuration" per the
 * design.
 */
export function clusteringMethodSweep(
  profiles: readonly GeneratorProfile[],
  sizes: readonly number[],
  trialCount: number,
  cases: readonly EvalCase[] = clusteringSensitiveCases,
  opts?: RunEvaluationTrialsOptions,
): ClusteringMethodSweepSummary {
  const bootstrapRng = rngFromSeed("clustering-sweep")
  const results: ClusteringMethodSweepResult[] = []

  for (const profile of profiles) {
    for (const method of clusteringMethods) {
      const configured: EvalCase[] = cases.map((c) => ({
        ...c,
        config: { ...c.config, clusteringMethod: method },
        generateOptions: { ...c.generateOptions, profile },
      }))
      const summary = runEvaluationTrials(configured, sizes, trialCount, opts)
      const pooled: number[] = []
      for (const r of summary.results) for (const score of r.trials) pooled.push(score.unionFidelity.f1)
      const ci = bootstrapCI(pooled, bootstrapRng, {
        ...(opts?.ciLevel !== undefined ? { level: opts.ciLevel } : {}),
        ...(opts?.resamples !== undefined ? { resamples: opts.resamples } : {}),
      })
      results.push({ profile: profile.kind, method, mean: mean(pooled), ci, sampleCount: pooled.length })
    }
  }

  const profileNames = [...new Set(results.map((r) => r.profile))]
  const dominantPerProfile = new Map<string, ClusteringMethod | undefined>()
  for (const p of profileNames) {
    const rows = results.filter((r) => r.profile === p)
    const dominant = rows.find((row) => rows.every((o) => o.method === row.method || row.ci.low > o.ci.high))
    dominantPerProfile.set(p, dominant?.method)
  }

  const perProfileDominants = profileNames.map((p) => dominantPerProfile.get(p))
  const crownedDefault =
    perProfileDominants.length > 0 && perProfileDominants.every((d) => d !== undefined && d === perProfileDominants[0])
      ? perProfileDominants[0]
      : undefined

  const conclusion =
    crownedDefault !== undefined
      ? `crowned default: ${crownedDefault} — its confidence interval sits strictly above both other methods' on every profile in the sweep (${profileNames.join(", ")})`
      : `no universal default, expose as configuration — no single method's confidence interval sits strictly above the other two on every profile (per-profile: ${
          profileNames.map((p) => `${p}=${dominantPerProfile.get(p) ?? "none dominant"}`).join(", ")
        })`

  return { results, conclusion, crownedDefault }
}
