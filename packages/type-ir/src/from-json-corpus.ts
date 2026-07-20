// packages/type-ir/src/from-json-corpus.ts — @rhi-zone/fractal-type-ir/from-json-corpus
//
// Corpus-level JSON inference: given MULTIPLE JSON values, infer the
// tightest type that covers all of them. This is where accumulation
// signals live — enum detection, discriminated unions, record-vs-dict,
// optional field detection — none of which are possible from a single
// sample.
//
// Pipeline:
//   1. Run fromJson on each value → per-value TypeRefs
//   2. Merge/unify per-value TypeRefs into a corpus-level TypeRef
//   3. Post-merge passes: enum detection, DU detection, dict detection
//   4. Construct final TypeRef

import { t, types, ancestors, type TypeRef } from "./index.ts"
import { fromJson, type InferConfig } from "./from-json.ts"
import {
  int8, int16, int32, int64,
  uint8, uint16, uint32, uint64,
} from "./kinds/common.ts"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CorpusInferConfig extends InferConfig {
  /** Enable dirty-data detection. Default: false. */
  detectDirtyData?: boolean
  /** Minimum samples before enum detection fires. Default: 3. */
  enumMinSamples?: number
  /** Minimum samples before dict detection fires. Default: 3. */
  dictMinSamples?: number
}

interface ResolvedCorpusConfig {
  readonly innerConfig: InferConfig
  readonly detectDirtyData: boolean
  readonly enumMinSamples: number
  readonly dictMinSamples: number
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

  // String subtype unification — if both are string subtypes, widen to string
  // (e.g. uuid + date → string; we can't narrow further)
  if (isSubkind(ak, "string") && isSubkind(bk, "string")) {
    if (ak === bk) return withMeta(a, meta) // same format
    // Different string subtypes → plain string
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

// Track observed values for leaf fields across the corpus. If distinct
// count K saturates (K << N), the field is enum-shaped.
interface FieldStats {
  values: unknown[]
  distinctValues: Set<string> // JSON-serialized for comparison
}

function collectFieldStats(values: unknown[]): Map<string, FieldStats> {
  const stats = new Map<string, FieldStats>()

  function visit(value: unknown, path: string): void {
    if (value === null || typeof value !== "object") {
      let entry = stats.get(path)
      if (entry === undefined) {
        entry = { values: [], distinctValues: new Set() }
        stats.set(path, entry)
      }
      entry.values.push(value)
      entry.distinctValues.add(JSON.stringify(value))
      return
    }
    if (Array.isArray(value)) {
      for (const el of value) visit(el, path + "[]")
      return
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(v, path + "." + k)
    }
  }

  for (const v of values) visit(v, "$")
  return stats
}

function detectEnums(
  ref: TypeRef,
  fieldStats: Map<string, FieldStats>,
  minSamples: number,
): TypeRef {
  return walkAndDetectEnums(ref, "$", fieldStats, minSamples)
}

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
 * K == 1 (every sample has the same value) is treated as maximal saturation
 * — always a positive signal, independent of N.
 *
 * When signals disagree or are ambiguous, be conservative and say no.
 */
function looksLikeEnum(K: number, N: number, sortedValues?: readonly number[]): boolean {
  if (K === 1) return true
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
  path: string,
  fieldStats: Map<string, FieldStats>,
  minSamples: number,
): TypeRef {
  const { shape } = ref

  if (shape.kind === "string" || isSubkind(shape.kind, "string")) {
    const stats = fieldStats.get(path)
    if (stats !== undefined && stats.values.length >= minSamples) {
      const K = stats.distinctValues.size
      const N = stats.values.length
      if (looksLikeEnum(K, N)) {
        const members = [...stats.distinctValues].map((s) => JSON.parse(s) as string)
        // Only if all values are strings
        if (members.every((m) => typeof m === "string")) {
          return t(types.enum(members), ref.meta)
        }
      }
    }
    return ref
  }

  if (integerKindSet.has(shape.kind)) {
    const stats = fieldStats.get(path)
    if (stats !== undefined && stats.values.length >= minSamples) {
      const K = stats.distinctValues.size
      const N = stats.values.length
      const values = [...stats.distinctValues].map((s) => JSON.parse(s) as number)
      if (values.every((v) => typeof v === "number" && Number.isInteger(v))) {
        const sorted = [...values].sort((a, b) => a - b)
        if (looksLikeEnum(K, N, sorted)) {
          // K === 1 → single constant value, represent as a literal.
          // K > 1 → union of literals.
          if (values.length === 1) return t(types.literal(values[0]!), ref.meta)
          const variants = values.map((v) => t(types.literal(v)))
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
      newFields[name] = walkAndDetectEnums(fieldRef, path + "." + name, fieldStats, minSamples)
    }
    return t(types.object(newFields), ref.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    return t(types.array(walkAndDetectEnums(el, path + "[]", fieldStats, minSamples)), ref.meta)
  }

  if (shape.kind === "tuple") {
    const els = (shape as { elements: readonly TypeRef[] }).elements
    return t(types.tuple(els.map((el, i) => walkAndDetectEnums(el, path + `[${i}]`, fieldStats, minSamples))), ref.meta)
  }

  if (shape.kind === "union") {
    const variants = (shape as { variants: readonly TypeRef[] }).variants
    return t(types.union(variants.map((v) => walkAndDetectEnums(v, path, fieldStats, minSamples))), ref.meta)
  }

  return ref
}

// ---------------------------------------------------------------------------
// Discriminated union detection
// ---------------------------------------------------------------------------

function detectDiscriminatedUnions(ref: TypeRef, values: unknown[]): TypeRef {
  return walkAndDetectDU(ref, values, "$")
}

function walkAndDetectDU(ref: TypeRef, values: unknown[], path: string): TypeRef {
  const { shape } = ref

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    if (el.shape.kind === "object") {
      // Collect all array elements across the corpus at this path
      const allElements: Record<string, unknown>[] = []
      function collectElements(val: unknown, p: string): void {
        if (p === path && Array.isArray(val)) {
          for (const item of val) {
            if (item !== null && typeof item === "object" && !Array.isArray(item)) {
              allElements.push(item as Record<string, unknown>)
            }
          }
        } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
          for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            collectElements(v, p + "." + k)
          }
        } else if (Array.isArray(val)) {
          for (const item of val) collectElements(item, p + "[]")
        }
      }
      for (const v of values) collectElements(v, "$")

      const du = tryDetectDU(el, allElements)
      if (du !== null) return t(types.array(du), ref.meta)
    }
    // Recurse into element type
    const newEl = walkAndDetectDU(el, values, path + "[]")
    return t(types.array(newEl), ref.meta)
  }

  if (shape.kind === "object") {
    const fields = (shape as { fields: Record<string, TypeRef> }).fields
    const newFields: Record<string, TypeRef> = {}
    for (const [name, fieldRef] of Object.entries(fields)) {
      newFields[name] = walkAndDetectDU(fieldRef, values, path + "." + name)
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
  elements: Record<string, unknown>[],
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

function detectDicts(ref: TypeRef, values: unknown[], minSamples: number): TypeRef {
  return walkAndDetectDicts(ref, values, "$", minSamples)
}

function walkAndDetectDicts(
  ref: TypeRef,
  values: unknown[],
  path: string,
  minSamples: number,
): TypeRef {
  const { shape } = ref
  if (shape.kind !== "object") {
    if (shape.kind === "array") {
      const el = (shape as { element: TypeRef }).element
      return t(types.array(walkAndDetectDicts(el, values, path + "[]", minSamples)), ref.meta)
    }
    return ref
  }

  const fields = (shape as { fields: Record<string, TypeRef> }).fields

  // First, recurse into child fields
  const newFields: Record<string, TypeRef> = {}
  for (const [name, fieldRef] of Object.entries(fields)) {
    newFields[name] = walkAndDetectDicts(fieldRef, values, path + "." + name, minSamples)
  }

  if (values.length < minSamples) return t(types.object(newFields), ref.meta)

  // Collect all key sets observed at this path across the corpus
  const allKeySets: Set<string>[] = []
  function collectKeySets(val: unknown, p: string): void {
    if (p === path && val !== null && typeof val === "object" && !Array.isArray(val)) {
      allKeySets.push(new Set(Object.keys(val as Record<string, unknown>)))
    } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        collectKeySets(v, p + "." + k)
      }
    } else if (Array.isArray(val)) {
      for (const item of val) collectKeySets(item, p + "[]")
    }
  }
  for (const v of values) collectKeySets(v, "$")

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

      return withMeta(t(types.object(recordFields)), {
        ...ref.meta,
        additionalProperties: dictValueType,
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

function detectDirtyData(ref: TypeRef, values: unknown[]): TypeRef {
  // For union types at the top level or in fields, check if one variant
  // is overwhelmingly dominant — the minority is likely dirty data.
  return walkAndDetectDirty(ref, values, "$")
}

function walkAndDetectDirty(ref: TypeRef, values: unknown[], path: string): TypeRef {
  const { shape } = ref

  if (shape.kind === "union") {
    const variants = (shape as { variants: readonly TypeRef[] }).variants
    if (variants.length !== 2) return ref

    // Collect values at this path
    const pathValues: unknown[] = []
    function collectValues(val: unknown, p: string): void {
      if (p === path) {
        pathValues.push(val)
      } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          collectValues(v, p + "." + k)
        }
      } else if (Array.isArray(val)) {
        for (const item of val) collectValues(item, p + "[]")
      }
    }
    for (const v of values) collectValues(v, "$")

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
      newFields[name] = walkAndDetectDirty(fieldRef, values, path + "." + name)
    }
    return t(types.object(newFields), ref.meta)
  }

  if (shape.kind === "array") {
    const el = (shape as { element: TypeRef }).element
    return t(types.array(walkAndDetectDirty(el, values, path + "[]")), ref.meta)
  }

  return ref
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Infer a TypeRef from a corpus of JSON values. All values are assumed
 * to be independent samples of the same type — the result is the tightest
 * type that covers all of them, with corpus-level signals (enums,
 * discriminated unions, dict-vs-record, optional fields) applied.
 */
export function fromJsonCorpus(values: unknown[], config?: CorpusInferConfig): TypeRef {
  if (values.length === 0) return t(types.unknown)

  const innerConfig: InferConfig = {}
  if (config?.arrayThreshold !== undefined) innerConfig.arrayThreshold = config.arrayThreshold
  if (config?.narrowIntegerWidth !== undefined) innerConfig.narrowIntegerWidth = config.narrowIntegerWidth
  if (config?.detectStringFormats !== undefined) innerConfig.detectStringFormats = config.detectStringFormats
  if (config?.leafHeuristics !== undefined) innerConfig.leafHeuristics = config.leafHeuristics

  const resolved: ResolvedCorpusConfig = {
    innerConfig,
    detectDirtyData: config?.detectDirtyData ?? false,
    enumMinSamples: config?.enumMinSamples ?? 3,
    dictMinSamples: config?.dictMinSamples ?? 3,
  }

  // 1. Run fromJson on each value
  const perValue = values.map((v) => fromJson(v, resolved.innerConfig))

  // 2. Merge/unify
  let merged = mergeAll(perValue)

  // 3. Enum detection
  const fieldStats = collectFieldStats(values)
  merged = detectEnums(merged, fieldStats, resolved.enumMinSamples)

  // 4. Discriminated union detection
  merged = detectDiscriminatedUnions(merged, values)

  // 5. Dict detection
  merged = detectDicts(merged, values, resolved.dictMinSamples)

  // 6. Dirty data detection (opt-in)
  if (resolved.detectDirtyData) {
    merged = detectDirtyData(merged, values)
  }

  return merged
}
