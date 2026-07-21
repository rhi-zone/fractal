// packages/type-ir/src/from-json.ts — @rhi-zone/fractal-type-ir/from-json
//
// FROM-direction projector: a single JSON value -> TypeRef, by structural
// heuristic. Mirrors from-json-schema.ts's construction style (t(), types,
// the same extension-kind constructors) but the input is a JSON *value*,
// not a schema — there's no declared type to read, only a shape to guess.
//
// Core heuristic (see the design sketch this implements): narrow away from
// a wide type only when the observed value lands in a subspace that ~0% of
// the wide type's inhabitants occupy — a number with zero fractional part,
// a string that validates as a UUID. That rarity is itself the evidence.
// Never infer literal types (booleans, string/number literals) — a literal
// is a single-inhabitant type, zero information gain once the shape is
// already known.
//
// This function infers from ONE value. Corpus inference (enum detection,
// discriminated unions, dict-vs-record, dirty-data modeling) needs multiple
// samples to find accumulation signal and is out of scope here — see the
// design sketch for that follow-on work.

import { t, types, type TypeRef } from "./index.ts"
import { date, datetime, email, int8, int16, int32, int64, uint8, uint16, uint32, uint64, uuid, uri } from "./kinds/common.ts"

export interface InferConfig {
  /** Minimum elements before inferring `array` (vs. `tuple`) for a non-empty array. Default: 3. */
  arrayThreshold?: number
  /** Narrow whole numbers to the tightest fixed-width integer kind (uint8..int64). Default: true. */
  narrowIntegerWidth?: boolean
  /** Try ISO date/datetime, uuid, email, uri format detection on strings. Default: true. */
  detectStringFormats?: boolean
  /**
   * Custom leaf heuristics, tried in order before the built-in inference at
   * every node (leaves and containers alike). The first heuristic to return
   * a `TypeRef` wins; returning `undefined` falls through to the next
   * heuristic, and past the end of the list to the built-in defaults. Put a
   * heuristic first to override a default; append one to extend without
   * touching default behavior.
   */
  leafHeuristics?: LeafHeuristic[]
}

/** A single custom inference rule. Return `undefined` to defer to the next heuristic / the built-in default. */
export type LeafHeuristic = (value: unknown) => TypeRef | undefined

interface ResolvedConfig {
  readonly arrayThreshold: number
  readonly narrowIntegerWidth: boolean
  readonly detectStringFormats: boolean
  readonly leafHeuristics: readonly LeafHeuristic[]
}

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// ---------------------------------------------------------------------------
// String format detection — heuristics, not validators. False negatives
// (missing a weird format) are fine; false positives (claiming a date that
// isn't one) are not, so each regex stays conservative.
// ---------------------------------------------------------------------------

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/
const isoDateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const uriRe = /^[a-z][a-z0-9+.-]*:\/\//i

function inferString(value: string, config: ResolvedConfig): TypeRef {
  if (config.detectStringFormats) {
    if (isoDateRe.test(value)) return date()
    if (isoDateTimeRe.test(value)) return datetime()
    if (uuidRe.test(value)) return uuid()
    if (emailRe.test(value)) return email()
    if (uriRe.test(value)) return uri()
  }
  return t(types.string)
}

// Width narrowing: check from tightest to widest, prefer unsigned when the
// value is non-negative. First match wins.
//
// Order: uint8 [0,255], int8 [-128,127], uint16 [0,65535], int16 [-32768,32767],
//        uint32 [0,4294967295], int32 [-2147483648,2147483647],
//        uint64/int64 for larger safe integers.
const intWidths: readonly { min: number; max: number; ctor: () => TypeRef }[] = [
  { min: 0, max: 255, ctor: uint8 },
  { min: -128, max: 127, ctor: int8 },
  { min: 0, max: 65535, ctor: uint16 },
  { min: -32768, max: 32767, ctor: int16 },
  { min: 0, max: 4294967295, ctor: uint32 },
  { min: -2147483648, max: 2147483647, ctor: int32 },
]

function inferNumber(value: number, config: ResolvedConfig): TypeRef {
  if (!Number.isInteger(value)) return t(types.number)
  if (config.narrowIntegerWidth) {
    for (const { min, max, ctor } of intWidths) {
      if (value >= min && value <= max) return ctor()
    }
    // Beyond 32-bit range but still a safe integer — pick unsigned if
    // non-negative, signed otherwise.
    if (Number.isSafeInteger(value)) return value >= 0 ? uint64() : int64()
  }
  return t(types.integer)
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function isObjectRef(ref: TypeRef): ref is TypeRef & { shape: { kind: "object"; fields: Readonly<Record<string, TypeRef>> } } {
  return ref.shape.kind === "object"
}

function shapeEqual(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a.shape) === JSON.stringify(b.shape)
}

// Unifies field values observed at the same key across several object
// samples into one TypeRef: identical types collapse to that type, distinct
// types become a union.
function mergeTypeRefs(refs: readonly TypeRef[]): TypeRef {
  const distinct: TypeRef[] = []
  for (const ref of refs) {
    if (!distinct.some((seen) => shapeEqual(seen, ref))) distinct.push(ref)
  }
  return distinct.length === 1 ? distinct[0]! : t(types.union(distinct))
}

// Merges several object shapes into one: a field present in every sample is
// required; a field present in only some is optional. This is what lets an
// array of near-identical objects (e.g. 8 of 10 fields shared) collapse to
// one record type with optional fields, rather than one tuple slot per
// sample or a union of unrelated shapes.
function mergeObjectShapes(refs: readonly (TypeRef & { shape: { kind: "object"; fields: Readonly<Record<string, TypeRef>> } })[]): TypeRef {
  const fieldNames = new Set<string>()
  for (const ref of refs) {
    for (const name of Object.keys(ref.shape.fields)) fieldNames.add(name)
  }

  const fields: Record<string, TypeRef> = {}
  for (const name of fieldNames) {
    const present = refs.filter((ref) => name in ref.shape.fields).map((ref) => ref.shape.fields[name]!)
    const merged = mergeTypeRefs(present)
    fields[name] = present.length < refs.length ? withMeta(merged, { optional: true }) : merged
  }
  return t(types.object(fields))
}

function inferArray(value: readonly unknown[], config: ResolvedConfig): TypeRef {
  // A single-inhabitant type (the empty tuple) carries zero information —
  // widen to the general container shape instead of inferring `[]`.
  if (value.length === 0) return t(types.array(t(types.unknown)))

  const elementRefs = value.map((v) => inferValue(v, config))

  // Arrays of objects merge structurally even when individual samples
  // differ (optional fields), rather than requiring exact equality like the
  // scalar/array/tuple case below.
  if (elementRefs.every(isObjectRef)) {
    if (elementRefs.length < config.arrayThreshold) return t(types.tuple(elementRefs))
    return t(types.array(mergeObjectShapes(elementRefs)))
  }

  const first = elementRefs[0]!
  const homogeneous = elementRefs.every((ref) => shapeEqual(ref, first))
  if (homogeneous && elementRefs.length >= config.arrayThreshold) return t(types.array(first))

  // Heterogeneous, or homogeneous but below the sample threshold to be
  // confident it's array-shaped rather than a fixed-arity tuple that
  // happens to share types at each position.
  return t(types.tuple(elementRefs))
}

function inferObject(value: Record<string, unknown>, config: ResolvedConfig): TypeRef {
  const keys = Object.keys(value)
  // Single-inhabitant type (the empty record) — same reasoning as `[]`.
  if (keys.length === 0) return t(types.object({}))

  const fields: Record<string, TypeRef> = {}
  for (const key of keys) fields[key] = inferValue(value[key], config)
  return t(types.object(fields))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function inferValue(value: unknown, config: ResolvedConfig): TypeRef {
  for (const heuristic of config.leafHeuristics) {
    const result = heuristic(value)
    if (result !== undefined) return result
  }

  if (value === null) return t(types.null)
  // Never infer literal types — true/false collapse to `boolean`, the
  // literal is zero information gain once the shape is already known.
  if (typeof value === "boolean") return t(types.boolean)
  if (typeof value === "number") return inferNumber(value, config)
  if (typeof value === "string") return inferString(value, config)
  if (Array.isArray(value)) return inferArray(value, config)
  if (typeof value === "object") return inferObject(value as Record<string, unknown>, config)
  // undefined, bigint, symbol, function — not representable in JSON.
  return t(types.unknown)
}

/** Infer a `TypeRef` shape from a single JSON value. See module doc for the heuristic. */
export function fromJson(value: unknown, config?: InferConfig): TypeRef {
  const resolved: ResolvedConfig = {
    arrayThreshold: config?.arrayThreshold ?? 3,
    narrowIntegerWidth: config?.narrowIntegerWidth ?? true,
    detectStringFormats: config?.detectStringFormats ?? true,
    leafHeuristics: config?.leafHeuristics ?? [],
  }
  return inferValue(value, resolved)
}
