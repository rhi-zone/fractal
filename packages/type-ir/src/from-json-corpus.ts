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
//     discriminated-union detection, dict-vs-record detection, dirty-data
//     detection. All the tunable heuristics live here, behind
//     `ResolveStrategy`.
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
  /** Minimum samples before dict detection fires. Default: 3. */
  dictMinSamples?: number
  /** Custom resolvers for specific evidence patterns, tried at every node after the built-in passes. First non-`undefined` result wins. */
  customResolvers?: EvidenceResolver[]
}

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

  // unknown absorbs everything
  if (ak === "unknown") return withMeta(a, meta)
  if (bk === "unknown") return withMeta(b, meta)

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
): boolean {
  if (K === 1) return N >= literalMinSamples
  if (K >= N) return false // every value unique — definitely not an enum
  if (K > 50) return false // too many distinct values to be enum-like

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
): TypeRef {
  const { shape } = ref

  if (shape.kind === "string" || isSubkind(shape.kind, "string")) {
    if (node.leafCount >= minSamples) {
      const K = node.distinctValues.size
      const N = node.leafCount
      if (looksLikeEnum(K, N, undefined, literalMinSamples)) {
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
        if (looksLikeEnum(K, N, node.sortedNumeric, literalMinSamples)) {
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
        ? walkAndDetectEnums(fieldRef, childNode, minSamples, literalMinSamples)
        : fieldRef
    }
    return t(types.object(newFields), ref.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    const childNode = node.array?.element
    const newEl = childNode !== undefined
      ? walkAndDetectEnums(el, childNode, minSamples, literalMinSamples)
      : el
    return t(types.array(newEl), ref.meta)
  }

  if (shape.kind === "tuple") {
    const els = (shape as { elements: readonly TypeRef[] }).elements
    const perIndex = node.array?.perIndex
    return t(types.tuple(els.map((el, i) => {
      const childNode = perIndex?.[i]
      return childNode !== undefined
        ? walkAndDetectEnums(el, childNode, minSamples, literalMinSamples)
        : el
    })), ref.meta)
  }

  if (shape.kind === "union") {
    const variants = (shape as { variants: readonly TypeRef[] }).variants
    return t(types.union(variants.map((v) => walkAndDetectEnums(v, node, minSamples, literalMinSamples))), ref.meta)
  }

  return ref
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
        const a = fieldSets[i]!
        const b = fieldSets[j]!
        // Symmetric difference: fields in one but not the other
        const diff = new Set([...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x))))
        const union = new Set([...a, ...b])
        // If symmetric difference is > 10% of the union, shapes are distinct enough
        if (diff.size > 0 && diff.size / union.size > 0.1) {
          hasDifference = true
        }
      }
    }

    if (!hasDifference) continue

    // Build per-variant TypeRefs by re-inferring each group
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

  return null
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
  readonly dictMinSamples: number
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
    dictMinSamples: strategy?.dictMinSamples ?? cfg?.dictMinSamples ?? 3,
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
    merged = walkAndDetectEnums(merged, tree.root, resolved.enumMinSamples, resolved.literalMinSamples)
  }

  // 3. Discriminated union detection
  if (resolved.detectDiscriminatedUnions) {
    merged = walkAndDetectDU(merged, tree.root)
  }

  // 4. Dict detection
  if (resolved.detectDicts) {
    merged = walkAndDetectDicts(merged, tree.root, tree.values.length, resolved.dictMinSamples)
  }

  // 5. Dirty data detection (opt-in)
  if (resolved.detectDirtyData) {
    merged = walkAndDetectDirty(merged, tree.root)
  }

  // 6. Custom resolvers
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
