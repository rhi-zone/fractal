// packages/type-ir/src/from-json-corpus.ts — @rhi-zone/fractal-type-ir/from-json-corpus
//
// Corpus-level JSON inference: given MULTIPLE JSON values, infer the
// tightest type that covers all of them. This is where accumulation
// signals live — enum detection, discriminated unions, record-vs-dict,
// optional field detection — none of which are possible from a single
// sample.
//
// Two-phase architecture:
//
//   Phase 1 — collectEvidence(values, config) -> EvidenceTree
//     A purely mechanical upward pass over the raw corpus. It counts,
//     buckets, and structurally mirrors the data (per-field evidence for
//     objects, per-element evidence for arrays) but makes NO type
//     commitment decisions — no enum/dict/DU calls, no union resolution.
//
//   Phase 2 — resolveEvidence(tree, strategy) -> TypeRef
//     Reads the evidence tree and makes every heuristic decision:
//     structural merge (incl. integer width widening), enum detection,
//     discriminated-union detection, dict-vs-record detection,
//     discriminant-free structural union splitting, dirty-data detection.
//     All the tunable heuristics live here, behind `ResolveStrategy`.
//
//   fromJsonCorpus(values, config) is a convenience wrapper that runs both
//   phases back to back, so existing callers see identical behavior.

import { t, types, ancestors, type TypeRef } from "./index.ts"
import { fromJson, type InferConfig, type LeafHeuristic } from "./from-json.ts"
import {
  int8, int16, int32, int64,
  uint8, uint16, uint32, uint64,
} from "./kinds/common.ts"

// ---------------------------------------------------------------------------
// Phase 1 types — the evidence tree
// ---------------------------------------------------------------------------

/**
 * Evidence gathered for one structural position in the corpus (the root, an
 * object field, or an array's elements). Mirrors the shape of the data —
 * `object` positions carry per-field sub-evidence, `array` positions carry
 * element sub-evidence — but never commits to a resolved TypeRef.
 */
export interface EvidenceNode {
  /** Total number of raw values (of any JS type) observed at this position. */
  readonly n: number
  /** How many of those values were `null`. */
  readonly nullCount: number
  /** How many were non-container leaf values (null/boolean/number/string) — the population `distinctValues`/`sortedNumeric` are drawn from. */
  readonly leafCount: number
  /** Per-JS-type occurrence counts: "null" | "boolean" | "number" | "string" | "object" | "array". */
  readonly typeCounts: Readonly<Record<string, number>>
  /** Raw values observed at this position, in corpus order — used by dirty-data resolution, which needs to re-run `fromJson` per value. */
  readonly values: readonly unknown[]
  /** JSON-serialized distinct leaf values — the enum evidence's K. */
  readonly distinctValues: ReadonlySet<string>
  /** Distinct integer leaf values, sorted ascending — clustering evidence for integer enum detection. */
  readonly sortedNumeric: readonly number[]
  /** Present when at least one raw value at this position was a plain object. */
  readonly object?: {
    /** Sub-evidence per field name, merged across every sample that had that field. */
    readonly fields: Readonly<Record<string, EvidenceNode>>
    /** How many object-typed samples had each field present. */
    readonly fieldPresenceCount: Readonly<Record<string, number>>
    /** Number of object-typed samples observed at this position. */
    readonly sampleCount: number
    /** One key-set per object-typed sample, in corpus order — dict-vs-record growth evidence. */
    readonly keySets: readonly ReadonlySet<string>[]
  }
  /** Present when at least one raw value at this position was an array. */
  readonly array?: {
    /** Sub-evidence merged across every element of every array at this position (index-agnostic — the "homogeneous array" bucket). */
    readonly element: EvidenceNode
    /** Sub-evidence per index, across arrays at this position (index-sensitive — the "fixed-arity tuple" bucket). */
    readonly perIndex: readonly EvidenceNode[]
    /** Length of each array-typed sample, in corpus order. */
    readonly lengths: readonly number[]
    /** Raw object elements across every array at this position — discriminated-union candidate data. */
    readonly elementObjects: readonly Record<string, unknown>[]
  }
}

export interface EvidenceTree {
  /** The raw corpus, unmodified. */
  readonly values: readonly unknown[]
  /** Evidence for the corpus as a whole (the root structural position). */
  readonly root: EvidenceNode
  /** The config passed to `collectEvidence`, kept as `resolveEvidence`'s defaults when no `ResolveStrategy` override is given. */
  readonly config?: CorpusInferConfig
}

// ---------------------------------------------------------------------------
// Phase 2 types — the resolution strategy
// ---------------------------------------------------------------------------

/** A resolution hook tried at every node: return a replacement TypeRef to override the built-in decision, or `undefined` to leave it as-is. */
export type EvidenceResolver = (node: EvidenceNode, ref: TypeRef) => TypeRef | undefined

export interface ResolveStrategy extends InferConfig {
  /** Enum detection: use the three-signal approach (saturation, uniqueness, clustering). Default: true. */
  detectEnums?: boolean
  /** Discriminated union detection. Default: true. */
  detectDiscriminatedUnions?: boolean
  /** Dict detection via key accumulation. Default: true. */
  detectDicts?: boolean
  /** Dirty-data detection (flag anomalous minority types). Default: false. */
  detectDirtyData?: boolean
  /** Minimum samples before enum detection fires. Default: 3. */
  enumMinSamples?: number
  /**
   * Minimum samples before K=1 evidence (every sample shares one value)
   * collapses to `literal`/a one-member `enum`. Deliberately higher than
   * `enumMinSamples`: committing to the single exact value a field has ever
   * been observed to take is a stronger claim than committing to a small
   * bounded set of values, and a corpus that's barely cleared
   * `enumMinSamples` hasn't yet had much chance to show a second value.
   * Default: 5.
   */
  literalMinSamples?: number
  /**
   * Upper bound on distinct-value count (K) above which a position is never
   * called an enum, regardless of how many samples support it. Default: 50.
   *
   * PROVISIONAL — this is a policy default, not a derived constant, and the
   * K-only form is known to be defective: it rejects a field with K=100 at
   * N=100,000 (ratio 0.001, unambiguously a bounded vocabulary) purely
   * because K exceeds the cap, while admitting K=49 at N=50. The ratio tests
   * below (`K/N`) are the part that carries the evidence; this cap is an
   * independent guard on output size. Set to `Infinity` to disable it and
   * rely on the ratio alone. See `docs/design/inference-theory.md` §6.6-6.7
   * for why a cut on K alone cannot separate memorization from restriction.
   */
  enumMaxMembers?: number
  /** Minimum samples before dict detection fires. Default: 3. */
  dictMinSamples?: number
  /**
   * Structural union splitting on plain object merges: when a position in
   * the corpus mixes objects whose field sets are dissimilar enough (see
   * `objectSplitThreshold`), keep them as distinct union variants instead
   * of collapsing everything into one optional-everything record. This is
   * `tryDetectDU`'s Jaccard-distance test generalized to positions with no
   * discriminant field — it fires at every object-typed position (root,
   * object fields, array elements), not just inside array-of-object DU
   * detection. Default: true.
   */
  splitDissimilarObjects?: boolean
  /**
   * Jaccard symmetric-difference threshold (fraction of the union of field
   * names) above which two clustered samples are considered structurally
   * distinct enough to split into separate union variants. `tryDetectDU`
   * uses 0.1 for this same distance, but that threshold applies to groups
   * already confirmed distinct by a discriminant field — strong prior
   * evidence. General splitting has no such prior: real records routinely
   * have several optional fields, and comparing two samples that each
   * happen to be missing a different subset of them can read as `>10%`
   * dissimilar without the shapes actually being different populations.
   * The default is set high enough that a single missing optional field
   * out of as few as 2 total fields (worst case: 1/2 = 0.5 symmetric
   * difference) never triggers a split on its own. Default: 0.5.
   */
  objectSplitThreshold?: number
  /**
   * Minimum object samples at a position before structural splitting is
   * considered. Higher than `dictMinSamples`/`enumMinSamples` because,
   * unlike those, splitting has no discriminant field corroborating that
   * the dissimilarity is real signal rather than sampling noise. Default: 5.
   */
  objectSplitMinSamples?: number
  /**
   * How `trySplitDissimilarObjects` groups the raw per-sample field sets
   * before deciding whether a position's objects are one population or
   * several. All three read `objectSplitThreshold`/`objectSplitMinSamples`
   * the same way; they differ only in how "close enough to merge" is
   * decided:
   *
   *  - `"single-linkage"` (default): greedy nearest-cluster assignment —
   *    each sample joins the *nearest* existing cluster if within
   *    threshold, else starts a new one. Cheap (single pass), but prone to
   *    "chaining": A merges with B, B merges with C, so A and C end up in
   *    the same cluster even though A and C alone would exceed the
   *    threshold — a distant pair pulled together via an intermediary.
   *  - `"complete-linkage"`: agglomerative clustering where two clusters
   *    may only merge when *every* cross-pair of underlying samples is
   *    within threshold (the merge distance is the *max*, not the nearest,
   *    pairwise distance). More conservative — avoids chaining — at the
   *    cost of being more willing to leave a sample in its own cluster
   *    (which the `>=2 members` guard below then discards as a lone
   *    outlier rather than a real second population). Costs more to
   *    compute (repeated all-pairs distance scans) than single-linkage.
   *  - `"key-signature"`: skip distance entirely — group samples by their
   *    *exact* key-set signature (same set of keys -> same cluster).
   *    Ignores `objectSplitThreshold` altogether. Simpler and more
   *    aggressive: two samples differing by even one optional field become
   *    separate clusters, which fits the "polymorphic API response" case
   *    (a handful of exact, recurring shapes) but over-splits ordinary
   *    records with a few sparsely-present optional fields.
   *
   * Default: `"single-linkage"`.
   */
  clusteringMethod?: ClusteringMethod
  /**
   * CFD-style discriminant search (see the "CFD discriminant search"
   * section of `from-json-corpus.ts` and
   * `docs/design/prior-art/json-shape-inference.md` §1): generalizes
   * `tryDetectDU` beyond fields already typed `enum`/literal-union by
   * searching every scalar sibling field directly against raw evidence and
   * scoring it as a candidate discriminant. Runs only where `tryDetectDU`
   * found nothing, and only against positions still in plain `object` form
   * (so it never re-litigates a discriminant `tryDetectDU` already
   * committed to, and never fights `trySplitDissimilarObjects`, which runs
   * after it and skips anything already resolved to a union). Default:
   * true.
   */
  detectCfdDiscriminants?: boolean
  /**
   * Minimum object samples at a position before CFD discriminant search
   * runs. Higher than `tryDetectDU`'s implicit `elements.length < 3` gate:
   * unlike `tryDetectDU`, this pass has no enum-typed field to lean on as
   * prior evidence — every scalar sibling field is a candidate, so more
   * samples are needed before a cardinality/cohesion/separation score can
   * be trusted over sampling noise. Default: 8.
   */
  cfdMinSamples?: number
  /**
   * Maximum K/N ratio (distinct discriminant values over sample count) a
   * candidate field may have. This is the direct analogue of
   * `looksLikeEnum`'s saturation check, but applied without its
   * integer-clustering escape hatch or absolute `K > 50` cap — a CFD
   * discriminant can legitimately have more distinct values than a typical
   * enum (Tagger's own GeoJSON `type` tag is a small closed set, but the
   * paper doesn't bound candidate cardinality beyond "low enough to have
   * repeated support"). A field with `K === N` (every value unique) is
   * always rejected regardless of this threshold — that's a unique-ID
   * field, not a discriminant. Default: 0.5.
   */
  cfdMaxCardinalityRatio?: number
  /**
   * Minimum samples required in every value-group of a candidate
   * discriminant field. Mirrors `trySplitDissimilarObjects`'s "a cluster of
   * one is indistinguishable from a lone outlier" guard: a discriminant
   * value seen only once has no corroborating evidence that its shape is a
   * real, repeatable population rather than sampling noise. Default: 2.
   */
  cfdMinGroupSize?: number
  /**
   * Minimum `cohesion * separation` score (see `scoreCfdCandidate`) a
   * candidate discriminant must clear to be accepted. Both signals range
   * over `[0, 1]`; the product is high only when a field's value-groups are
   * both internally consistent AND structurally distinct from each other.
   * Default: 0.5.
   */
  cfdMinScore?: number
  /** Custom resolvers for specific evidence patterns, tried at every node after the built-in passes. First non-`undefined` result wins. */
  customResolvers?: EvidenceResolver[]
}

/** See `ResolveStrategy.clusteringMethod`. */
export type ClusteringMethod = "single-linkage" | "complete-linkage" | "key-signature"

/** Back-compat alias — the config accepted by `fromJsonCorpus`/`collectEvidence` is exactly a `ResolveStrategy`. */
export type CorpusInferConfig = ResolveStrategy

// ---------------------------------------------------------------------------
// Phase 1 — collectEvidence: mechanical, no decisions
// ---------------------------------------------------------------------------

function buildEvidenceNode(values: readonly unknown[]): EvidenceNode {
  const typeCounts: Record<string, number> = {}
  let nullCount = 0
  const distinctValues = new Set<string>()
  const numericSet = new Set<number>()
  const objectSamples: Record<string, unknown>[] = []
  const arraySamples: unknown[][] = []
  const keySets: Set<string>[] = []

  for (const v of values) {
    if (v === null) {
      nullCount++
      typeCounts.null = (typeCounts.null ?? 0) + 1
      distinctValues.add("null")
      continue
    }
    if (Array.isArray(v)) {
      typeCounts.array = (typeCounts.array ?? 0) + 1
      arraySamples.push(v)
      continue
    }
    if (typeof v === "object") {
      typeCounts.object = (typeCounts.object ?? 0) + 1
      const obj = v as Record<string, unknown>
      objectSamples.push(obj)
      keySets.push(new Set(Object.keys(obj)))
      continue
    }
    typeCounts[typeof v] = (typeCounts[typeof v] ?? 0) + 1
    distinctValues.add(JSON.stringify(v))
    if (typeof v === "number" && Number.isInteger(v)) numericSet.add(v)
  }

  const leafCount = values.length - objectSamples.length - arraySamples.length

  let objectEvidence: EvidenceNode["object"] | undefined
  if (objectSamples.length > 0) {
    const fieldNames = new Set<string>()
    for (const o of objectSamples) for (const k of Object.keys(o)) fieldNames.add(k)
    const fields: Record<string, EvidenceNode> = {}
    const fieldPresenceCount: Record<string, number> = {}
    for (const name of fieldNames) {
      const fieldValues = objectSamples.filter((o) => Object.hasOwn(o, name)).map((o) => o[name])
      fieldPresenceCount[name] = fieldValues.length
      fields[name] = buildEvidenceNode(fieldValues)
    }
    objectEvidence = { fields, fieldPresenceCount, sampleCount: objectSamples.length, keySets }
  }

  let arrayEvidence: EvidenceNode["array"] | undefined
  if (arraySamples.length > 0) {
    const allElements = arraySamples.flat()
    const elementObjects = allElements.filter(
      (e) => e !== null && typeof e === "object" && !Array.isArray(e),
    ) as Record<string, unknown>[]
    const maxLength = Math.max(...arraySamples.map((a) => a.length))
    const perIndex: EvidenceNode[] = []
    for (let i = 0; i < maxLength; i++) {
      perIndex.push(buildEvidenceNode(arraySamples.filter((a) => i < a.length).map((a) => a[i])))
    }
    arrayEvidence = {
      element: buildEvidenceNode(allElements),
      perIndex,
      lengths: arraySamples.map((a) => a.length),
      elementObjects,
    }
  }

  return {
    n: values.length,
    nullCount,
    leafCount,
    typeCounts,
    values,
    distinctValues,
    sortedNumeric: [...numericSet].sort((a, b) => a - b),
    ...(objectEvidence !== undefined ? { object: objectEvidence } : {}),
    ...(arrayEvidence !== undefined ? { array: arrayEvidence } : {}),
  }
}

/**
 * Walk a corpus of JSON values and collect statistical evidence — value
 * counts, distinct-value sets, key-set growth, element evidence — without
 * making any type-commitment decision. Purely mechanical: no enum/dict/DU
 * heuristics run here.
 */
export function collectEvidence(values: unknown[], config?: CorpusInferConfig): EvidenceTree {
  return { values, root: buildEvidenceNode(values), ...(config !== undefined ? { config } : {}) }
}

// ---------------------------------------------------------------------------
// Integer width unification
// ---------------------------------------------------------------------------

// Ranges indexed by kind name, for computing the tightest covering width.
const intWidthTable: Record<string, { min: number; max: number }> = {
  uint8:   { min: 0, max: 255 },
  int8:    { min: -128, max: 127 },
  uint16:  { min: 0, max: 65535 },
  int16:   { min: -32768, max: 32767 },
  uint32:  { min: 0, max: 4294967295 },
  int32:   { min: -2147483648, max: 2147483647 },
  uint64:  { min: 0, max: Number.MAX_SAFE_INTEGER },
  int64:   { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  integer: { min: -Infinity, max: Infinity },
}

// Ordered tightest-to-widest (same order as fromJson's narrowing table).
const intWidthOrder: readonly { kind: string; min: number; max: number; ctor: () => TypeRef }[] = [
  { kind: "uint8",  min: 0, max: 255, ctor: uint8 },
  { kind: "int8",   min: -128, max: 127, ctor: int8 },
  { kind: "uint16", min: 0, max: 65535, ctor: uint16 },
  { kind: "int16",  min: -32768, max: 32767, ctor: int16 },
  { kind: "uint32", min: 0, max: 4294967295, ctor: uint32 },
  { kind: "int32",  min: -2147483648, max: 2147483647, ctor: int32 },
  { kind: "uint64", min: 0, max: Number.MAX_SAFE_INTEGER, ctor: uint64 },
  { kind: "int64",  min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, ctor: int64 },
]

const integerKindSet = new Set(Object.keys(intWidthTable))

/** Find the tightest integer width that covers the union of two widths' ranges. */
function widenIntegerKinds(a: string, b: string): TypeRef {
  const ra = intWidthTable[a]
  const rb = intWidthTable[b]
  if (ra === undefined || rb === undefined) return t(types.integer)
  const needMin = Math.min(ra.min, rb.min)
  const needMax = Math.max(ra.max, rb.max)
  for (const { min, max, ctor } of intWidthOrder) {
    if (needMin >= min && needMax <= max) return ctor()
  }
  return t(types.integer)
}

// ---------------------------------------------------------------------------
// Type unification — merge two TypeRefs into the tightest common supertype
// ---------------------------------------------------------------------------

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

function shapeEqual(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a.shape) === JSON.stringify(b.shape)
}

function typeRefEqual(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isSubkind(child: string, parent: string): boolean {
  if (child === parent) return true
  return ancestors(child).includes(parent)
}

// `date`/`datetime` are type-ir's `Date` domain type, not a string subtype
// (see kinds/date-time.ts) — but `fromJson`'s string-format detection (see
// from-json.ts's `inferString`) still guesses them FROM a raw JSON string
// sample. When corpus evidence disagrees on which format a string-shaped
// field actually is (e.g. some samples parse as a date, others don't, or
// parse as a different format like uuid), the honest fallback is still
// "it's a string, we're just not sure which format" — same as two
// conflicting `string`-subtype format guesses (uuid vs. uri) always
// widened to plain `string`. This set names the format-detected kinds that
// need that string-widening path even though they're no longer literal
// string subtypes in the type system.
const stringDetectedFormatKinds = new Set(["date", "datetime"])

function isStringLikeForUnification(kind: string): boolean {
  return isSubkind(kind, "string") || stringDetectedFormatKinds.has(kind)
}

/**
 * Merge meta bags from two TypeRefs. Picks up `nullable`, `optional`,
 * and any other conventions that should survive unification.
 */
function mergeMeta(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  if (a.nullable === true || b.nullable === true) merged.nullable = true
  if (a.optional === true || b.optional === true) merged.optional = true
  return merged
}

/**
 * Unify two TypeRefs: find the tightest type that accepts values from both.
 * - Same kind → merge structurally (objects: merge fields; arrays: unify elements)
 * - Compatible kinds (integer widths, string subtypes) → widen
 * - Incompatible → union
 */
function unifyTypes(a: TypeRef, b: TypeRef): TypeRef {
  if (typeRefEqual(a, b)) return a

  const ak = a.shape.kind
  const bk = b.shape.kind
  const meta = mergeMeta(a.meta, b.meta)

  // Integer width unification — find tightest covering width
  if (integerKindSet.has(ak) && integerKindSet.has(bk)) {
    return withMeta(widenIntegerKinds(ak, bk), meta)
  }

  // String subtype/format unification — if both are string subtypes (or a
  // string-detected format like date/datetime — see isStringLikeForUnification),
  // widen to string (e.g. uuid + date → string; we can't narrow further)
  if (isStringLikeForUnification(ak) && isStringLikeForUnification(bk)) {
    if (ak === bk) return withMeta(a, meta) // same format
    // Different string subtypes/formats → plain string
    return withMeta(t(types.string), meta)
  }

  // number + any integer kind → number (integers are a subset of numbers)
  if (ak === "number" && (integerKindSet.has(bk) || bk === "number")) return withMeta(t(types.number), meta)
  if (bk === "number" && (integerKindSet.has(ak) || ak === "number")) return withMeta(t(types.number), meta)

  // Same compound kind → structural merge
  if (ak === "object" && bk === "object") {
    return withMeta(mergeObjectTypes(a, b), meta)
  }

  if (ak === "array" && bk === "array") {
    const aEl = (a.shape as { element: TypeRef }).element
    const bEl = (b.shape as { element: TypeRef }).element
    return withMeta(t(types.array(unifyTypes(aEl, bEl))), meta)
  }

  if (ak === "tuple" && bk === "tuple") {
    const aEls = (a.shape as { elements: readonly TypeRef[] }).elements
    const bEls = (b.shape as { elements: readonly TypeRef[] }).elements
    if (aEls.length === bEls.length) {
      return withMeta(t(types.tuple(aEls.map((el, i) => unifyTypes(el, bEls[i]!)))), meta)
    }
    // Different-length tuples → can't unify as tuple
    return withMeta(makeUnion(a, b), meta)
  }

  // array + tuple → array (tuple is a special case of array)
  if ((ak === "array" && bk === "tuple") || (ak === "tuple" && bk === "array")) {
    const arrRef = ak === "array" ? a : b
    const tupRef = ak === "tuple" ? a : b
    const arrEl = (arrRef.shape as { element: TypeRef }).element
    const tupEls = (tupRef.shape as { elements: readonly TypeRef[] }).elements
    let unified = arrEl
    for (const el of tupEls) unified = unifyTypes(unified, el)
    return withMeta(t(types.array(unified)), meta)
  }

  // map + object → keep as union (semantically different)
  // map + map → unify value types
  if (ak === "map" && bk === "map") {
    const aVal = (a.shape as { value: TypeRef }).value
    const bVal = (b.shape as { value: TypeRef }).value
    return withMeta(t(types.map(t(types.string), unifyTypes(aVal, bVal))), meta)
  }

  // `unknown` means "no information" (e.g. an empty array's element type),
  // not "matches everything" — it's the bottom of unification, not the top.
  // A concrete type merged with `unknown` should just be that concrete
  // type; only unknown-with-unknown stays unknown. (If every sample really
  // is `unknown`, both branches below still return `unknown`.)
  if (ak === "unknown") return withMeta(b, meta)
  if (bk === "unknown") return withMeta(a, meta)

  // null + T → T with nullable meta (common pattern)
  if (ak === "null" && bk !== "null") return withMeta(b, { ...meta, nullable: true })
  if (bk === "null" && ak !== "null") return withMeta(a, { ...meta, nullable: true })

  // Flatten unions: if either side is already a union, merge into it
  return withMeta(makeUnion(a, b), meta)
}

function makeUnion(a: TypeRef, b: TypeRef): TypeRef {
  const aVariants = a.shape.kind === "union"
    ? (a.shape as { variants: readonly TypeRef[] }).variants
    : [a]
  const bVariants = b.shape.kind === "union"
    ? (b.shape as { variants: readonly TypeRef[] }).variants
    : [b]
  // Deduplicate
  const all = [...aVariants]
  for (const v of bVariants) {
    if (!all.some((existing) => typeRefEqual(existing, v))) all.push(v)
  }
  return all.length === 1 ? all[0]! : t(types.union(all))
}

function mergeObjectTypes(a: TypeRef, b: TypeRef): TypeRef {
  const aFields = (a.shape as { fields: Record<string, TypeRef> }).fields
  const bFields = (b.shape as { fields: Record<string, TypeRef> }).fields
  const allKeys = new Set([...Object.keys(aFields), ...Object.keys(bFields)])
  const fields: Record<string, TypeRef> = {}
  for (const key of allKeys) {
    const inA = Object.hasOwn(aFields, key)
    const inB = Object.hasOwn(bFields, key)
    if (inA && inB) {
      // Present in both — unify types, keep required only if required in both
      const unified = unifyTypes(aFields[key]!, bFields[key]!)
      const aOpt = aFields[key]!.meta.optional === true
      const bOpt = bFields[key]!.meta.optional === true
      if (aOpt || bOpt) {
        fields[key] = withMeta(unified, { optional: true })
      } else {
        fields[key] = unified
      }
    } else {
      // Present in only one → optional
      const ref = inA ? aFields[key]! : bFields[key]!
      fields[key] = withMeta(ref, { optional: true })
    }
  }
  return t(types.object(fields))
}

// ---------------------------------------------------------------------------
// Multi-value merge — unify N TypeRefs via pairwise unification
// ---------------------------------------------------------------------------

function mergeAll(refs: readonly TypeRef[]): TypeRef {
  if (refs.length === 0) return t(types.unknown)
  let merged = refs[0]!
  for (let i = 1; i < refs.length; i++) {
    merged = unifyTypes(merged, refs[i]!)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Enum detection
// ---------------------------------------------------------------------------

/**
 * Decide whether a field with K distinct values across N samples is
 * enum-shaped, using three signals combined (not required to all agree):
 *
 *  - K saturation: distinct-value count stays low relative to sample count
 *    (approximated in the batch case as K/N below a threshold).
 *  - Uniqueness: K << N — heavy repetition is strong enum evidence; K == N
 *    (every value unique) is conclusive evidence AGAINST enum.
 *  - Clustering (integers only): sorted distinct values leave large gaps
 *    relative to the value range. This alone is not sufficient (timestamps
 *    cluster too) — it only corroborates a borderline saturation signal.
 *
 * K == 1 (every sample has the same value) is maximal saturation, but it
 * still needs enough samples before it's trusted: a single-value corpus at
 * very low N can't distinguish "this field is a constant" from "we simply
 * haven't seen a second value yet". `literalMinSamples` (default 5, higher
 * than the general `enumMinSamples`) gates that commitment — below it, K=1
 * evidence is left alone rather than collapsed to `literal`/a one-member
 * `enum`.
 *
 * When signals disagree or are ambiguous, be conservative and say no.
 */
function looksLikeEnum(
  K: number,
  N: number,
  sortedValues?: readonly number[],
  literalMinSamples = 5,
  enumMaxMembers = 50,
): boolean {
  if (K === 1) return N >= literalMinSamples
  if (K >= N) return false // every value unique — definitely not an enum
  // Output-size guard, NOT an evidence test — see `enumMaxMembers`. A cut on
  // K alone cannot distinguish memorization from genuine restriction; the
  // K/N ratio tests below are what carry the evidence.
  if (K > enumMaxMembers) return false

  const ratio = K / N
  const saturated = ratio < 0.5 // K stopped growing relative to N
  if (!saturated) return false

  const stronglyRepetitive = ratio <= 1 / 3 // K << N
  if (stronglyRepetitive) return true

  // Borderline saturation (1/3 < ratio < 1/2): look for corroborating
  // clustering evidence among integers before committing to enum.
  if (sortedValues !== undefined && sortedValues.length >= 2) {
    const range = sortedValues[sortedValues.length - 1]! - sortedValues[0]!
    if (range > 0) return K <= range / 2
  }

  return false
}

function walkAndDetectEnums(
  ref: TypeRef,
  node: EvidenceNode,
  minSamples: number,
  literalMinSamples: number,
  enumMaxMembers: number,
): TypeRef {
  const { shape } = ref

  if (shape.kind === "string" || isSubkind(shape.kind, "string")) {
    if (node.leafCount >= minSamples) {
      const K = node.distinctValues.size
      const N = node.leafCount
      if (looksLikeEnum(K, N, undefined, literalMinSamples, enumMaxMembers)) {
        const members = [...node.distinctValues].map((s) => JSON.parse(s) as unknown)
        // Only if all values are strings
        if (members.every((m) => typeof m === "string")) {
          // K === 1 → single constant value, represent as a literal, same
          // as the integer branch below (see the asymmetry this replaced,
          // documented in from-json.adversarial.test.ts §13).
          // K > 1 → enum.
          if (members.length === 1) return t(types.literal(members[0] as string), ref.meta)
          return t(types.enum(members as string[]), ref.meta)
        }
      }
    }
    return ref
  }

  if (integerKindSet.has(shape.kind)) {
    if (node.leafCount >= minSamples) {
      const K = node.distinctValues.size
      const N = node.leafCount
      const values = [...node.distinctValues].map((s) => JSON.parse(s) as unknown)
      if (values.every((v) => typeof v === "number" && Number.isInteger(v))) {
        const numericValues = values as number[]
        if (looksLikeEnum(K, N, node.sortedNumeric, literalMinSamples, enumMaxMembers)) {
          // K === 1 → single constant value, represent as a literal.
          // K > 1 → union of literals.
          if (numericValues.length === 1) return t(types.literal(numericValues[0]!), ref.meta)
          const variants = numericValues.map((v) => t(types.literal(v)))
          return t(types.union(variants), ref.meta)
        }
      }
    }
    return ref
  }

  if (shape.kind === "object") {
    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      const childNode = node.object?.fields[name]
      newFields[name] = childNode !== undefined
        ? walkAndDetectEnums(fieldRef, childNode, minSamples, literalMinSamples, enumMaxMembers)
        : fieldRef
    }
    return t(types.object(newFields), ref.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    const childNode = node.array?.element
    const newEl = childNode !== undefined
      ? walkAndDetectEnums(el, childNode, minSamples, literalMinSamples, enumMaxMembers)
      : el
    return t(types.array(newEl), ref.meta)
  }

  if (shape.kind === "tuple") {
    const els = (shape as { elements: readonly TypeRef[] }).elements
    const perIndex = node.array?.perIndex
    return t(types.tuple(els.map((el, i) => {
      const childNode = perIndex?.[i]
      return childNode !== undefined
        ? walkAndDetectEnums(el, childNode, minSamples, literalMinSamples, enumMaxMembers)
        : el
    })), ref.meta)
  }

  if (shape.kind === "union") {
    const variants = (shape as { variants: readonly TypeRef[] }).variants
    return t(types.union(variants.map((v) => walkAndDetectEnums(v, node, minSamples, literalMinSamples, enumMaxMembers))), ref.meta)
  }

  return ref
}

// ---------------------------------------------------------------------------
// Shared Jaccard-distance machinery — field-set (dis)similarity, used by
// both discriminant-grouped splitting (tryDetectDU) and the general,
// discriminant-free splitting below (trySplitDissimilarObjects).
// ---------------------------------------------------------------------------

/**
 * Symmetric-difference-over-union distance between two field-name sets: 0
 * when the sets are identical, 1 when they're disjoint. This is the same
 * measure `tryDetectDU` has always used to decide whether discriminant
 * groups are "meaningfully different shapes" — factored out so the general
 * splitting pass can reuse it verbatim instead of re-deriving its own
 * notion of structural distance.
 */
function fieldSetJaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let diffCount = 0
  const union = new Set<string>()
  for (const x of a) {
    union.add(x)
    if (!b.has(x)) diffCount++
  }
  for (const x of b) {
    union.add(x)
    if (!a.has(x)) diffCount++
  }
  if (union.size === 0) return 0
  return diffCount / union.size
}

// ---------------------------------------------------------------------------
// Discriminated union detection
// ---------------------------------------------------------------------------

function walkAndDetectDU(ref: TypeRef, node: EvidenceNode): TypeRef {
  const { shape } = ref

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    if (el.shape.kind === "object" && node.array !== undefined) {
      const du = tryDetectDU(el, node.array.elementObjects)
      if (du !== null) return t(types.array(du), ref.meta)
    }
    const childNode = node.array?.element
    const newEl = childNode !== undefined ? walkAndDetectDU(el, childNode) : el
    return t(types.array(newEl), ref.meta)
  }

  if (shape.kind === "object") {
    // `tryDetectDU` needs the raw object samples that produced this
    // position's merged type, not just the merged type itself — the same
    // thing `node.array.elementObjects` supplies for array elements. There's
    // no equivalent pre-filtered bucket for object-typed positions (root,
    // an object field, a map value, …), because `EvidenceNode.object` only
    // carries per-field sub-evidence, not the raw per-sample objects. Derive
    // it here from `node.values` — mirrors the same filter
    // `trySplitDissimilarObjects` uses to recover raw samples from a node.
    // This is what makes DU detection fire for a corpus whose union members
    // sit directly at a position instead of nested inside an array field.
    const objectSamples = node.values.filter(
      (v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v),
    )
    const du = tryDetectDU(ref, objectSamples)
    if (du !== null) return withMeta(du, ref.meta)

    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      const childNode = node.object?.fields[name]
      newFields[name] = childNode !== undefined ? walkAndDetectDU(fieldRef, childNode) : fieldRef
    }
    return t(types.object(newFields), ref.meta)
  }

  return ref
}

/**
 * Given an object type and the corpus of objects that produced it, check
 * whether any enum-typed field partitions the remaining structure into
 * distinct shapes — i.e. acts as a discriminant.
 */
function tryDetectDU(
  objectRef: TypeRef,
  elements: readonly Record<string, unknown>[],
): TypeRef | null {
  if (elements.length < 3) return null
  const fields = (objectRef.shape as { fields: Record<string, TypeRef> }).fields

  // Candidate discriminant fields: enum-typed fields
  const candidates: string[] = []
  for (const [name, fieldRef] of Object.entries(fields)) {
    if (fieldRef.shape.kind === "enum") candidates.push(name)
    if (fieldRef.shape.kind === "union") {
      const variants = (fieldRef.shape as { variants: readonly TypeRef[] }).variants
      if (variants.every((v) => v.shape.kind === "literal")) candidates.push(name)
    }
  }

  for (const discField of candidates) {
    // Group elements by the discriminant field's value
    const groups = new Map<string, Record<string, unknown>[]>()
    let valid = true
    for (const el of elements) {
      const val = el[discField]
      if (val === undefined) { valid = false; break }
      const key = JSON.stringify(val)
      let group = groups.get(key)
      if (group === undefined) {
        group = []
        groups.set(key, group)
      }
      group.push(el)
    }
    if (!valid || groups.size < 2) continue

    // Check if the groups have distinct shapes — use Jaccard distance
    // on field sets (excluding the discriminant field itself)
    const groupFieldSets = new Map<string, Set<string>>()
    for (const [key, group] of groups) {
      const fieldSet = new Set<string>()
      for (const el of group) {
        for (const k of Object.keys(el)) {
          if (k !== discField) fieldSet.add(k)
        }
      }
      groupFieldSets.set(key, fieldSet)
    }

    // Check if groups have meaningfully different field sets
    const fieldSets = [...groupFieldSets.values()]
    let hasDifference = false
    for (let i = 0; i < fieldSets.length && !hasDifference; i++) {
      for (let j = i + 1; j < fieldSets.length && !hasDifference; j++) {
        // If symmetric difference is > 10% of the union, shapes are distinct
        // enough. This threshold is deliberately much lower than the general
        // splitting pass's `objectSplitThreshold` (see ResolveStrategy) —
        // here the discriminant field has already established these are
        // separate populations, so far less field-set disagreement is
        // needed to corroborate that they're structurally distinct too.
        if (fieldSetJaccardDistance(fieldSets[i]!, fieldSets[j]!) > 0.1) {
          hasDifference = true
        }
      }
    }

    if (!hasDifference) continue

    return buildDiscriminatedUnion(discField, groups)
  }

  return null
}

/**
 * Build a discriminated-union `TypeRef` from a discriminant field name and
 * its value-grouped raw samples: re-infer and merge each group, pin the
 * discriminant field to a `literal` of that group's value, and wrap the
 * result in a `union` tagged with `meta.discriminator`. Shared by
 * `tryDetectDU` (candidate = an already enum/literal-union-typed field) and
 * `tryDetectCfdDiscriminant` (candidate = any scalar sibling field, scored
 * directly from raw evidence — see the CFD discriminant search section
 * below) since both arrive at the same grouped-samples shape and need
 * identical variant construction.
 */
function buildDiscriminatedUnion(
  discField: string,
  groups: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): TypeRef {
  const variants: TypeRef[] = []
  for (const [key, group] of groups) {
    // Merge objects within this group
    const groupRefs = group.map((el) => {
      const fields: Record<string, TypeRef> = {}
      for (const [k, v] of Object.entries(el)) {
        fields[k] = fromJson(v)
      }
      return t(types.object(fields))
    })
    let merged = groupRefs[0]!
    for (let i = 1; i < groupRefs.length; i++) {
      merged = mergeObjectTypes(merged, groupRefs[i]!)
    }
    // Set the discriminant field to a literal
    const mergedFields = { ...(merged.shape as { fields: Record<string, TypeRef> }).fields }
    mergedFields[discField] = t(types.literal(JSON.parse(key)))
    variants.push(t(types.object(mergedFields)))
  }

  return t(types.union(variants), { discriminator: discField })
}

// ---------------------------------------------------------------------------
// CFD-style discriminant search — Tagger's unary constant conditional
// functional dependency (ucCFD) discovery, generalized beyond `tryDetectDU`'s
// enum-only candidate set (see docs/design/prior-art/json-shape-inference.md
// §1). `tryDetectDU` only ever considers a field that's *already* been typed
// `enum`/all-literal-union by the earlier enum-detection pass — a field with
// borderline cardinality that `looksLikeEnum` rejected (e.g. a string field
// whose K/N ratio lands in the ambiguous 1/3–1/2 band, where only integer
// values get a clustering-evidence escape hatch) can never become a DU
// discriminant, even when its value provably determines sibling structure.
//
// This pass searches every scalar-valued sibling field directly against the
// raw evidence — not the inferred field type — and scores each candidate on
// three signals matching Tagger's own filtering heuristics (its "overfitting
// prevention" section): low cardinality relative to N (not a unique-ID
// field), internally consistent structure within each value-group
// (cohesion), and distinct structure across groups (separation). Unlike
// Tagger's general CFD-discovery algorithm (which is "computationally
// expensive, scaling exponentially in the number of attributes"), this stays
// unary — one candidate field at a time, exactly the restriction the Tagger
// paper itself imposes for tractability — so the search is linear in the
// number of sibling fields, not exponential.
// ---------------------------------------------------------------------------

/** A scalar sibling field candidate, grouped by its raw JSON-serialized value, with its combined cohesion*separation score. */
interface CfdCandidate {
  readonly field: string
  readonly groups: ReadonlyMap<string, readonly Record<string, unknown>[]>
  readonly score: number
}

/**
 * Field names whose value was a basic (non-container) type in every element
 * that had it — Tagger's own restriction ("discriminant candidates are
 * restricted to basic values — the relational encoding doesn't capture
 * nested-object tag values at all"). A field that's ever an object or array
 * in any sample is disqualified outright, everywhere else is a candidate.
 */
function collectScalarFieldNames(elements: readonly Record<string, unknown>[]): string[] {
  const allKeys = new Set<string>()
  const disqualified = new Set<string>()
  for (const el of elements) {
    for (const [k, v] of Object.entries(el)) {
      allKeys.add(k)
      if (v !== null && typeof v === "object") disqualified.add(k)
    }
  }
  return [...allKeys].filter((k) => !disqualified.has(k))
}

/**
 * Score one candidate discriminant field against the raw elements. Returns
 * `null` when the field fails a hard gate (missing from some element, not
 * scalar everywhere, too few/too many groups, or a group without
 * `minGroupSize` corroborating samples — the same "a cluster of one is
 * indistinguishable from a lone outlier" guard `trySplitDissimilarObjects`
 * uses) — otherwise the field's grouping plus a `[0, 1]` score:
 *
 *  - **Cardinality gate** (`maxCardinalityRatio`): K/N must stay below the
 *    threshold, and K must be strictly less than N (K == N means every
 *    value is unique — a unique ID, not a discriminant, same disqualifying
 *    check `looksLikeEnum` uses).
 *  - **Cohesion**: `1 - ` the average pairwise Jaccard distance between
 *    sibling field-sets *within* each group (excluding the discriminant
 *    field itself) — high when every sample sharing a discriminant value
 *    has the same sibling shape. Groups of size 1 contribute no pairs and
 *    are treated as perfectly cohesive (no internal disagreement possible).
 *  - **Separation**: the average pairwise Jaccard distance between groups'
 *    (unioned) sibling field-sets — high when different discriminant values
 *    imply genuinely different sibling shapes.
 *
 * `score = cohesion * separation`: both signals must hold for the score to
 * be high — a field that's cohesive but produces near-identical groups (low
 * separation), or one that produces wildly different groups that are each
 * internally inconsistent (low cohesion), is not a good discriminant either
 * way.
 */
function scoreCfdCandidate(
  field: string,
  elements: readonly Record<string, unknown>[],
  maxCardinalityRatio: number,
  minGroupSize: number,
): CfdCandidate | null {
  const N = elements.length
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const el of elements) {
    const val = el[field]
    if (val === undefined || (val !== null && typeof val === "object")) return null
    const key = JSON.stringify(val)
    let group = groups.get(key)
    if (group === undefined) {
      group = []
      groups.set(key, group)
    }
    group.push(el)
  }

  const K = groups.size
  if (K < 2 || K >= N) return null
  if (K / N > maxCardinalityRatio) return null
  for (const group of groups.values()) {
    if (group.length < minGroupSize) return null
  }

  const groupFieldSetLists = new Map<string, Set<string>[]>()
  const groupUnionFieldSets = new Map<string, Set<string>>()
  for (const [key, group] of groups) {
    const perElementSets: Set<string>[] = []
    const unionSet = new Set<string>()
    for (const el of group) {
      const fs = new Set(Object.keys(el).filter((k) => k !== field))
      perElementSets.push(fs)
      for (const k of fs) unionSet.add(k)
    }
    groupFieldSetLists.set(key, perElementSets)
    groupUnionFieldSets.set(key, unionSet)
  }

  let cohesionDistSum = 0
  let cohesionPairCount = 0
  for (const sets of groupFieldSetLists.values()) {
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        cohesionDistSum += fieldSetJaccardDistance(sets[i]!, sets[j]!)
        cohesionPairCount++
      }
    }
  }
  const cohesion = cohesionPairCount > 0 ? 1 - cohesionDistSum / cohesionPairCount : 1

  const unionSets = [...groupUnionFieldSets.values()]
  let sepDistSum = 0
  let sepPairCount = 0
  for (let i = 0; i < unionSets.length; i++) {
    for (let j = i + 1; j < unionSets.length; j++) {
      sepDistSum += fieldSetJaccardDistance(unionSets[i]!, unionSets[j]!)
      sepPairCount++
    }
  }
  const separation = sepPairCount > 0 ? sepDistSum / sepPairCount : 0

  return { field, groups, score: cohesion * separation }
}

/**
 * Search every scalar sibling field at an object-typed position for the
 * best-scoring CFD discriminant (see `scoreCfdCandidate`), and build a
 * discriminated union from it if one clears `minScore`. Called only when
 * `tryDetectDU` (the enum-only path) has already had first refusal and
 * found nothing — see `walkAndDetectCfdDiscriminant`'s call site in
 * `resolveEvidence`'s pass ordering.
 */
function tryDetectCfdDiscriminant(
  elements: readonly Record<string, unknown>[],
  minSamples: number,
  maxCardinalityRatio: number,
  minGroupSize: number,
  minScore: number,
): TypeRef | null {
  if (elements.length < minSamples) return null

  const candidateFields = collectScalarFieldNames(elements)
  let best: CfdCandidate | null = null
  for (const field of candidateFields) {
    const candidate = scoreCfdCandidate(field, elements, maxCardinalityRatio, minGroupSize)
    if (candidate === null) continue
    if (candidate.score < minScore) continue
    if (best === null || candidate.score > best.score) best = candidate
  }
  if (best === null) return null

  return buildDiscriminatedUnion(best.field, best.groups)
}

function walkAndDetectCfdDiscriminant(
  ref: TypeRef,
  node: EvidenceNode,
  minSamples: number,
  maxCardinalityRatio: number,
  minGroupSize: number,
  minScore: number,
): TypeRef {
  const { shape } = ref

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    if (el.shape.kind === "object" && node.array !== undefined) {
      const cfd = tryDetectCfdDiscriminant(
        node.array.elementObjects, minSamples, maxCardinalityRatio, minGroupSize, minScore,
      )
      if (cfd !== null) return t(types.array(cfd), ref.meta)
    }
    const childNode = node.array?.element
    const newEl = childNode !== undefined
      ? walkAndDetectCfdDiscriminant(el, childNode, minSamples, maxCardinalityRatio, minGroupSize, minScore)
      : el
    return t(types.array(newEl), ref.meta)
  }

  if (shape.kind === "object") {
    // Same raw-sample recovery `walkAndDetectDU`'s object branch uses — see
    // its comment for why `node.values` (not `node.object`) is the source.
    const objectSamples = node.values.filter(
      (v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v),
    )
    const cfd = tryDetectCfdDiscriminant(objectSamples, minSamples, maxCardinalityRatio, minGroupSize, minScore)
    if (cfd !== null) return withMeta(cfd, ref.meta)

    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      const childNode = node.object?.fields[name]
      newFields[name] = childNode !== undefined
        ? walkAndDetectCfdDiscriminant(fieldRef, childNode, minSamples, maxCardinalityRatio, minGroupSize, minScore)
        : fieldRef
    }
    return t(types.object(newFields), ref.meta)
  }

  return ref
}

// ---------------------------------------------------------------------------
// General structural union splitting (no discriminant field)
//
// tryDetectDU only fires when a candidate discriminant (an already
// enum/literal-typed field) exists. Most structurally-dissimilar object
// corpora have no such field — they just merge into one big
// optional-everything record via mergeObjectTypes, silently losing the
// "these are actually different shapes" signal. This pass generalizes the
// same Jaccard-distance test to plain object merges: cluster the raw
// per-sample field sets by similarity, and if that clustering yields more
// than one group with real (>=2-sample) support, keep the groups as
// distinct union variants instead of merging them all into one record.
//
// Runs after dict detection (not before): a dict's ever-growing key set
// looks exactly as "dissimilar" under Jaccard distance as a genuine
// structural split would, so dict detection needs first refusal — objects
// it reclassifies as `map` are no longer `object`-kind by the time this
// pass sees them, and won't be considered for splitting.
// ---------------------------------------------------------------------------

/**
 * `fieldSetJaccardDistance`, except an empty field set is always treated as
 * distance 0 from anything. A sample with zero keys (`{}`) is compatible
 * with every shape — it's the "all fields absent" case of an
 * all-optional-fields record, not positive evidence of a second,
 * differently-shaped population. Without this, `{}` vs. `{tag: "a"}` scores
 * a Jaccard distance of 1.0 (maximal) purely because there's only one field
 * to disagree about, which would split what is really just "tag is
 * optional" into two spurious single-field-vs-empty variants.
 */
function objectSplitDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  return fieldSetJaccardDistance(a, b)
}

/** One resolved cluster: the union of its members' field names, and the raw member samples. */
interface ObjectCluster {
  readonly fieldSet: Set<string>
  readonly members: Record<string, unknown>[]
}

/**
 * Single-linkage clustering: each sample joins the nearest existing cluster
 * if within `threshold` (comparing against the cluster's running field-set
 * union), else starts a new cluster. O(n * clusters) — cheap, but prone to
 * chaining (see `ResolveStrategy.clusteringMethod`).
 */
function clusterSingleLinkage(
  samples: readonly Record<string, unknown>[],
  keySets: readonly ReadonlySet<string>[],
  threshold: number,
): ObjectCluster[] {
  const clusters: ObjectCluster[] = []
  for (let i = 0; i < samples.length; i++) {
    const fs = keySets[i]!
    let best: { cluster: ObjectCluster; dist: number } | undefined
    for (const cluster of clusters) {
      const dist = objectSplitDistance(fs, cluster.fieldSet)
      if (best === undefined || dist < best.dist) best = { cluster, dist }
    }
    if (best !== undefined && best.dist <= threshold) {
      best.cluster.members.push(samples[i]!)
      for (const k of fs) best.cluster.fieldSet.add(k)
    } else {
      clusters.push({ fieldSet: new Set(fs), members: [samples[i]!] })
    }
  }
  return clusters
}

/**
 * Complete-linkage agglomerative clustering: starts with every sample as
 * its own cluster and repeatedly merges the two clusters whose *farthest*
 * cross-pair of underlying samples is closest, stopping once the best
 * available merge would exceed `threshold`. Unlike single-linkage, a merge
 * requires ALL cross-pairs between the two clusters to be within
 * threshold, not just one — this is what avoids chaining (see
 * `ResolveStrategy.clusteringMethod`).
 *
 * Implementation: precompute the base n*n pairwise Jaccard-distance matrix
 * once (O(n^2) `Set` operations), then agglomerate using only array
 * lookups — a cluster pair's distance is `max` over its members' base
 * distances, and the standard complete-linkage merge update
 * (`dist(A∪B, k) = max(dist(A,k), dist(B,k))`) keeps that number-only
 * comparison as cheap on every later round. Still O(n^3) *comparisons* in
 * the worst case (n samples, up to n merge rounds, each scanning O(n^2)
 * cluster pairs), but each comparison is a plain float compare instead of
 * a `Set`-based distance recomputation — the dominant cost at the sample
 * counts `objectSplitMinSamples` gates this pass to.
 */
function clusterCompleteLinkage(
  samples: readonly Record<string, unknown>[],
  keySets: readonly ReadonlySet<string>[],
  threshold: number,
): ObjectCluster[] {
  const n = samples.length

  // Base pairwise distance matrix over original sample indices.
  const base: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = objectSplitDistance(keySets[i]!, keySets[j]!)
      base[i]![j] = d
      base[j]![i] = d
    }
  }

  // Each active cluster is identified by a slot index and tracks its member
  // sample indices plus its current distance to every other active slot
  // (maintained incrementally via the complete-linkage merge-update rule,
  // rather than recomputed from scratch after every merge).
  const members: number[][] = Array.from({ length: n }, (_, i) => [i])
  const active = new Array<boolean>(n).fill(true)
  const dist: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array<number>(n).fill(Infinity)
    for (let j = 0; j < n; j++) if (j !== i) row[j] = base[i]![j]!
    return row
  })

  let remaining = n
  while (remaining > 1) {
    let bi = -1
    let bj = -1
    let bestDist = Infinity
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue
      const row = dist[i]!
      for (let j = i + 1; j < n; j++) {
        if (!active[j]) continue
        const d = row[j]!
        if (d < bestDist) { bestDist = d; bi = i; bj = j }
      }
    }
    if (bi === -1 || bestDist > threshold) break

    // Merge cluster bj into bi; complete-linkage update: the merged
    // cluster's distance to any other active cluster k is the max of the
    // two pre-merge distances.
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue
      const merged = Math.max(dist[bi]![k]!, dist[bj]![k]!)
      dist[bi]![k] = merged
      dist[k]![bi] = merged
    }
    members[bi]!.push(...members[bj]!)
    active[bj] = false
    remaining--
  }

  const clusters: ObjectCluster[] = []
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue
    const fieldSet = new Set<string>()
    for (const idx of members[i]!) for (const k of keySets[idx]!) fieldSet.add(k)
    clusters.push({ fieldSet, members: members[i]!.map((idx) => samples[idx]!) })
  }
  return clusters
}

/**
 * Key-signature clustering: group samples by their exact key-set signature
 * (same set of keys -> same cluster), ignoring `threshold` entirely. No
 * distance computation, so it's the cheapest of the three, and the most
 * aggressive splitter — see `ResolveStrategy.clusteringMethod`.
 */
function clusterByKeySignature(
  samples: readonly Record<string, unknown>[],
  keySets: readonly ReadonlySet<string>[],
): ObjectCluster[] {
  const bySignature = new Map<string, ObjectCluster>()
  for (let i = 0; i < samples.length; i++) {
    const fs = keySets[i]!
    const signature = [...fs].sort().join(" ")
    let cluster = bySignature.get(signature)
    if (cluster === undefined) {
      cluster = { fieldSet: new Set(fs), members: [] }
      bySignature.set(signature, cluster)
    }
    cluster.members.push(samples[i]!)
  }
  return [...bySignature.values()]
}

function clusterObjectSamples(
  samples: readonly Record<string, unknown>[],
  keySets: readonly ReadonlySet<string>[],
  threshold: number,
  method: ClusteringMethod,
): ObjectCluster[] {
  switch (method) {
    case "complete-linkage": return clusterCompleteLinkage(samples, keySets, threshold)
    case "key-signature": return clusterByKeySignature(samples, keySets)
    case "single-linkage": return clusterSingleLinkage(samples, keySets, threshold)
  }
}

/**
 * Cluster the raw object samples observed at `node` by field-set similarity
 * (per `clusteringMethod` — see `ResolveStrategy.clusteringMethod`), then
 * re-infer and merge within each cluster. Returns `null` when there isn't
 * enough evidence to split (too few samples, or the split would produce a
 * variant backed by only one sample — indistinguishable from a lone
 * outlier rather than a real second population).
 */
function trySplitDissimilarObjects(
  node: EvidenceNode,
  threshold: number,
  minSamples: number,
  clusteringMethod: ClusteringMethod,
): TypeRef | null {
  const objEv = node.object
  if (objEv === undefined) return null
  if (objEv.sampleCount < minSamples) return null

  const objectSamples = node.values.filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v),
  )
  // buildEvidenceNode pushes onto `keySets` in the same order it pushes
  // onto `objectSamples` (both driven by the same filter pass), and
  // `node.values` preserves corpus order — so index i here lines up with
  // `objEv.keySets[i]`.
  if (objectSamples.length !== objEv.keySets.length) return null

  const clusters = clusterObjectSamples(objectSamples, objEv.keySets, threshold, clusteringMethod)

  if (clusters.length < 2) return null
  // Every resulting variant needs corroborating evidence from at least two
  // samples — a cluster of one is indistinguishable from a single outlier,
  // and splitting on that alone would fork off a spurious variant.
  if (clusters.some((c) => c.members.length < 2)) return null

  const variants = clusters.map((cluster) => mergeAll(cluster.members.map((el) => fromJson(el))))
  return t(types.union(variants))
}

function walkAndSplitDissimilarObjects(
  ref: TypeRef,
  node: EvidenceNode,
  threshold: number,
  minSamples: number,
  clusteringMethod: ClusteringMethod,
): TypeRef {
  const { shape } = ref

  if (shape.kind === "object") {
    const split = trySplitDissimilarObjects(node, threshold, minSamples, clusteringMethod)
    if (split !== null) return withMeta(split, ref.meta)

    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      const childNode = node.object?.fields[name]
      newFields[name] = childNode !== undefined
        ? walkAndSplitDissimilarObjects(fieldRef, childNode, threshold, minSamples, clusteringMethod)
        : fieldRef
    }
    return t(types.object(newFields), ref.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    const childNode = node.array?.element
    const newEl = childNode !== undefined
      ? walkAndSplitDissimilarObjects(el, childNode, threshold, minSamples, clusteringMethod)
      : el
    return t(types.array(newEl), ref.meta)
  }

  if (shape.kind === "tuple") {
    const els = (shape as { elements: readonly TypeRef[] }).elements
    const perIndex = node.array?.perIndex
    return t(types.tuple(els.map((el, i) => {
      const childNode = perIndex?.[i]
      return childNode !== undefined
        ? walkAndSplitDissimilarObjects(el, childNode, threshold, minSamples, clusteringMethod)
        : el
    })), ref.meta)
  }

  // Deliberately no `union` case: a union at this position was already
  // produced by an earlier pass (DU detection) from evidence scoped to its
  // own discriminant groups. `node` here is the raw, unscoped evidence for
  // the *whole* position — reusing it to re-walk each variant would ignore
  // which raw samples actually belong to which variant and could re-split
  // (or corrupt) an already-correct discriminated union. General splitting
  // only ever acts on positions still in plain `object` form.

  return ref
}

// ---------------------------------------------------------------------------
// Dict detection (record vs. map)
// ---------------------------------------------------------------------------

function walkAndDetectDicts(
  ref: TypeRef,
  node: EvidenceNode,
  totalValues: number,
  minSamples: number,
): TypeRef {
  const { shape } = ref
  if (shape.kind !== "object") {
    if (shape.kind === "array") {
      const el = (shape as { element: TypeRef }).element
      const childNode = node.array?.element
      const newEl = childNode !== undefined ? walkAndDetectDicts(el, childNode, totalValues, minSamples) : el
      return t(types.array(newEl), ref.meta)
    }
    return ref
  }

  const fields = (shape as { fields: Record<string, TypeRef> }).fields

  // First, recurse into child fields
  const newFields: Record<string, TypeRef> = {}
  for (const [name, fieldRef] of Object.entries(fields)) {
    const childNode = node.object?.fields[name]
    newFields[name] = childNode !== undefined ? walkAndDetectDicts(fieldRef, childNode, totalValues, minSamples) : fieldRef
  }

  if (totalValues < minSamples) return t(types.object(newFields), ref.meta)

  // Key sets observed at this path across the corpus
  const allKeySets = node.object?.keySets ?? []

  if (allKeySets.length < minSamples) return t(types.object(newFields), ref.meta)

  // Measure key-set growth: how many distinct keys appear as we add samples?
  const allDistinctKeys = new Set<string>()
  const growthPoints: number[] = []
  for (const ks of allKeySets) {
    for (const k of ks) allDistinctKeys.add(k)
    growthPoints.push(allDistinctKeys.size)
  }

  // If key set is stable (same keys in every sample), it's a record.
  // If distinct key count keeps growing linearly, it's a dict.
  const firstCount = growthPoints[0]!
  const lastCount = growthPoints[growthPoints.length - 1]!

  // Keys common to ALL samples → record fields
  let commonKeys: Set<string> | undefined
  for (const ks of allKeySets) {
    if (commonKeys === undefined) {
      commonKeys = new Set(ks)
    } else {
      for (const k of commonKeys) {
        if (!ks.has(k)) commonKeys.delete(k)
      }
    }
  }

  // Growth ratio: how much did the distinct key count grow relative to
  // how many samples we saw? If it grew by > 50% of the sample count,
  // that's dict-like linear growth.
  const keyGrowth = lastCount - firstCount
  const sampleCount = allKeySets.length
  const growthRatio = keyGrowth / sampleCount

  if (growthRatio > 0.5 && lastCount > (commonKeys?.size ?? 0) + 2) {
    // Dict detected. Separate common keys (record fields) from varying keys (dict entries).
    const common = commonKeys ?? new Set<string>()

    if (common.size > 0) {
      // Mixed: fixed record fields + dynamic dict entries
      // Collect all non-common-key value types for the dict part
      const dictValueRefs: TypeRef[] = []
      for (const [name, fieldRef] of Object.entries(newFields)) {
        if (!common.has(name)) dictValueRefs.push(fieldRef)
      }
      const dictValueType = dictValueRefs.length > 0 ? mergeAll(dictValueRefs) : t(types.unknown)

      const recordFields: Record<string, TypeRef> = {}
      for (const k of common) {
        if (k in newFields) recordFields[k] = newFields[k]!
      }

      // `meta.additionalPropertyType` — the dict-entry value type, distinct
      // from the boolean closedness flag `meta.additionalProperties` that
      // `compile.ts`/`standard-schema.ts` read (see the `meta` conventions
      // doc on `TypeRef` in index.ts). No projector currently reads this
      // `TypeRef` back out; it's inert beyond this module's own tests today.
      return withMeta(t(types.object(recordFields)), {
        ...ref.meta,
        additionalPropertyType: dictValueType,
      })
    }

    // Pure dict: no stable keys
    const allValueRefs = Object.values(newFields)
    const valueType = allValueRefs.length > 0 ? mergeAll(allValueRefs) : t(types.unknown)
    return t(types.map(t(types.string), valueType))
  }

  return t(types.object(newFields), ref.meta)
}

// ---------------------------------------------------------------------------
// Dirty data detection (opt-in)
// ---------------------------------------------------------------------------

function walkAndDetectDirty(ref: TypeRef, node: EvidenceNode): TypeRef {
  const { shape } = ref

  if (shape.kind === "union") {
    const variants = (shape as { variants: readonly TypeRef[] }).variants
    if (variants.length !== 2) return ref

    const pathValues = node.values

    if (pathValues.length < 5) return ref

    // Count how many values match each variant
    const counts = variants.map((variant) => {
      let count = 0
      for (const val of pathValues) {
        const inferred = fromJson(val)
        if (shapeEqual(inferred, variant)) count++
      }
      return count
    })

    const total = counts.reduce((a, b) => a + b, 0)
    const max = Math.max(...counts)
    const maxIdx = counts.indexOf(max)

    // If one variant has > 90% of the values, the other is likely dirty
    if (max / total > 0.9) {
      const cleanType = variants[maxIdx]!
      const dirtyCount = total - max
      return withMeta(cleanType, {
        dirtyDataWarning: `${dirtyCount}/${total} values (${((dirtyCount / total) * 100).toFixed(1)}%) appear to be dirty data`,
      })
    }
  }

  if (shape.kind === "object") {
    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      const childNode = node.object?.fields[name]
      newFields[name] = childNode !== undefined ? walkAndDetectDirty(fieldRef, childNode) : fieldRef
    }
    return t(types.object(newFields), ref.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    const childNode = node.array?.element
    const newEl = childNode !== undefined ? walkAndDetectDirty(el, childNode) : el
    return t(types.array(newEl), ref.meta)
  }

  return ref
}

// ---------------------------------------------------------------------------
// Custom resolvers
// ---------------------------------------------------------------------------

function applyCustomResolvers(ref: TypeRef, node: EvidenceNode, resolvers: readonly EvidenceResolver[]): TypeRef {
  let current = ref
  for (const resolver of resolvers) {
    const result = resolver(node, current)
    if (result !== undefined) current = result
  }

  const { shape } = current
  if (shape.kind === "object") {
    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      const childNode = node.object?.fields[name]
      newFields[name] = childNode !== undefined ? applyCustomResolvers(fieldRef, childNode, resolvers) : fieldRef
    }
    return t(types.object(newFields), current.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    const childNode = node.array?.element
    const newEl = childNode !== undefined ? applyCustomResolvers(el, childNode, resolvers) : el
    return t(types.array(newEl), current.meta)
  }

  if (shape.kind === "tuple") {
    const els = (shape as { elements: readonly TypeRef[] }).elements
    const perIndex = node.array?.perIndex
    return t(types.tuple(els.map((el, i) => {
      const childNode = perIndex?.[i]
      return childNode !== undefined ? applyCustomResolvers(el, childNode, resolvers) : el
    })), current.meta)
  }

  if (shape.kind === "union") {
    const variants = (shape as { variants: readonly TypeRef[] }).variants
    return t(types.union(variants.map((v) => applyCustomResolvers(v, node, resolvers))), current.meta)
  }

  return current
}

// ---------------------------------------------------------------------------
// Phase 2 — resolveEvidence: every heuristic decision lives here
// ---------------------------------------------------------------------------

interface ResolvedStrategy {
  readonly innerConfig: InferConfig
  readonly detectEnums: boolean
  readonly detectDiscriminatedUnions: boolean
  readonly detectDicts: boolean
  readonly detectDirtyData: boolean
  readonly enumMinSamples: number
  readonly literalMinSamples: number
  readonly enumMaxMembers: number
  readonly dictMinSamples: number
  readonly splitDissimilarObjects: boolean
  readonly objectSplitThreshold: number
  readonly objectSplitMinSamples: number
  readonly clusteringMethod: ClusteringMethod
  readonly detectCfdDiscriminants: boolean
  readonly cfdMinSamples: number
  readonly cfdMaxCardinalityRatio: number
  readonly cfdMinGroupSize: number
  readonly cfdMinScore: number
  readonly customResolvers: readonly EvidenceResolver[]
}

function resolveStrategy(tree: EvidenceTree, strategy?: ResolveStrategy): ResolvedStrategy {
  const cfg = tree.config

  const innerConfig: InferConfig = {}
  const arrayThreshold = strategy?.arrayThreshold ?? cfg?.arrayThreshold
  if (arrayThreshold !== undefined) innerConfig.arrayThreshold = arrayThreshold
  const narrowIntegerWidth = strategy?.narrowIntegerWidth ?? cfg?.narrowIntegerWidth
  if (narrowIntegerWidth !== undefined) innerConfig.narrowIntegerWidth = narrowIntegerWidth
  const detectStringFormats = strategy?.detectStringFormats ?? cfg?.detectStringFormats
  if (detectStringFormats !== undefined) innerConfig.detectStringFormats = detectStringFormats
  const leafHeuristics = strategy?.leafHeuristics ?? cfg?.leafHeuristics
  if (leafHeuristics !== undefined) innerConfig.leafHeuristics = leafHeuristics as LeafHeuristic[]

  return {
    innerConfig,
    detectEnums: strategy?.detectEnums ?? cfg?.detectEnums ?? true,
    detectDiscriminatedUnions: strategy?.detectDiscriminatedUnions ?? cfg?.detectDiscriminatedUnions ?? true,
    detectDicts: strategy?.detectDicts ?? cfg?.detectDicts ?? true,
    detectDirtyData: strategy?.detectDirtyData ?? cfg?.detectDirtyData ?? false,
    enumMinSamples: strategy?.enumMinSamples ?? cfg?.enumMinSamples ?? 3,
    literalMinSamples: strategy?.literalMinSamples ?? cfg?.literalMinSamples ?? 5,
    enumMaxMembers: strategy?.enumMaxMembers ?? cfg?.enumMaxMembers ?? 50,
    dictMinSamples: strategy?.dictMinSamples ?? cfg?.dictMinSamples ?? 3,
    splitDissimilarObjects: strategy?.splitDissimilarObjects ?? cfg?.splitDissimilarObjects ?? true,
    objectSplitThreshold: strategy?.objectSplitThreshold ?? cfg?.objectSplitThreshold ?? 0.5,
    objectSplitMinSamples: strategy?.objectSplitMinSamples ?? cfg?.objectSplitMinSamples ?? 5,
    clusteringMethod: strategy?.clusteringMethod ?? cfg?.clusteringMethod ?? "single-linkage",
    detectCfdDiscriminants: strategy?.detectCfdDiscriminants ?? cfg?.detectCfdDiscriminants ?? true,
    cfdMinSamples: strategy?.cfdMinSamples ?? cfg?.cfdMinSamples ?? 8,
    cfdMaxCardinalityRatio: strategy?.cfdMaxCardinalityRatio ?? cfg?.cfdMaxCardinalityRatio ?? 0.5,
    cfdMinGroupSize: strategy?.cfdMinGroupSize ?? cfg?.cfdMinGroupSize ?? 2,
    cfdMinScore: strategy?.cfdMinScore ?? cfg?.cfdMinScore ?? 0.5,
    customResolvers: strategy?.customResolvers ?? cfg?.customResolvers ?? [],
  }
}

/**
 * Resolve an evidence tree into a final TypeRef. All the commitment
 * decisions — structural merge (incl. integer width widening), enum
 * detection, discriminated-union detection, dict-vs-record detection,
 * dirty-data detection — happen here, gated by `strategy`.
 */
export function resolveEvidence(tree: EvidenceTree, strategy?: ResolveStrategy): TypeRef {
  if (tree.values.length === 0) return t(types.unknown)

  const resolved = resolveStrategy(tree, strategy)

  // 1. Run fromJson on each raw value, then structurally merge (incl.
  //    integer width widening, union flattening).
  const perValue = tree.values.map((v) => fromJson(v, resolved.innerConfig))
  let merged = mergeAll(perValue)

  // 2. Enum detection
  if (resolved.detectEnums) {
    merged = walkAndDetectEnums(merged, tree.root, resolved.enumMinSamples, resolved.literalMinSamples, resolved.enumMaxMembers)
  }

  // 3. Discriminated union detection
  if (resolved.detectDiscriminatedUnions) {
    merged = walkAndDetectDU(merged, tree.root)
  }

  // 4. Dict detection
  if (resolved.detectDicts) {
    merged = walkAndDetectDicts(merged, tree.root, tree.values.length, resolved.dictMinSamples)
  }

  // 5. CFD-style discriminant search (no pre-typed enum required) — runs
  //    after dict detection (same "growing key set looks dissimilar too"
  //    reasoning as general splitting below) and only ever acts on
  //    positions `walkAndDetectDU` left in plain `object` form, so it never
  //    re-litigates a discriminant DU detection already committed to.
  if (resolved.detectCfdDiscriminants) {
    merged = walkAndDetectCfdDiscriminant(
      merged, tree.root,
      resolved.cfdMinSamples, resolved.cfdMaxCardinalityRatio, resolved.cfdMinGroupSize, resolved.cfdMinScore,
    )
  }

  // 6. General structural union splitting (no discriminant field) — runs
  //    last of the union-shaping passes so it only ever sees positions
  //    neither `tryDetectDU` nor the CFD discriminant search above could
  //    resolve to a discriminated union.
  if (resolved.splitDissimilarObjects) {
    merged = walkAndSplitDissimilarObjects(
      merged, tree.root, resolved.objectSplitThreshold, resolved.objectSplitMinSamples, resolved.clusteringMethod,
    )
  }

  // 7. Dirty data detection (opt-in)
  if (resolved.detectDirtyData) {
    merged = walkAndDetectDirty(merged, tree.root)
  }

  // 8. Custom resolvers
  if (resolved.customResolvers.length > 0) {
    merged = applyCustomResolvers(merged, tree.root, resolved.customResolvers)
  }

  return merged
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Infer a TypeRef from a corpus of JSON values. All values are assumed
 * to be independent samples of the same type — the result is the tightest
 * type that covers all of them, with corpus-level signals (enums,
 * discriminated unions, dict-vs-record, optional fields) applied.
 *
 * Convenience wrapper over `collectEvidence` + `resolveEvidence`.
 */
export function fromJsonCorpus(values: unknown[], config?: CorpusInferConfig): TypeRef {
  const evidence = collectEvidence(values, config)
  return resolveEvidence(evidence, config)
}
