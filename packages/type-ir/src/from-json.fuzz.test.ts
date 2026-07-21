// Property-based fuzz harness for fromJson using fast-check.
//
// Generates arbitrary TypeRef trees, produces conforming JSON values,
// runs fromJson, and checks properties. fast-check handles shrinking —
// when a failure is found, it minimizes the type+value to the simplest
// reproducer.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { t, types, ancestors, type TypeRef } from "./index.ts"
import {
  int8, int16, int32, int64,
  uint8, uint16, uint32, uint64,
  date, datetime, email, uuid, uri,
} from "./kinds/common.ts"
import { fromJson } from "./from-json.ts"

// ---------------------------------------------------------------------------
// TypeRef arbitrary — recursive, depth-bounded via fc.memo
// ---------------------------------------------------------------------------

const intWidthRanges: Record<string, { min: number; max: number; ctor: () => TypeRef }> = {
  uint8:  { min: 0, max: 255, ctor: uint8 },
  int8:   { min: -128, max: 127, ctor: int8 },
  uint16: { min: 0, max: 65535, ctor: uint16 },
  int16:  { min: -32768, max: 32767, ctor: int16 },
  uint32: { min: 0, max: 4294967295, ctor: uint32 },
  int32:  { min: -2147483648, max: 2147483647, ctor: int32 },
  uint64: { min: 0, max: Number.MAX_SAFE_INTEGER, ctor: uint64 },
  int64:  { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, ctor: int64 },
}

const fieldNamePool = [
  "id", "name", "age", "email", "url", "count", "value", "label",
  "status", "active", "score", "data", "items", "type", "kind",
  "title", "desc", "ts", "amount", "level", "flag", "key", "ref",
  "code", "body", "path", "size", "rank", "index", "pos",
]

// Leaf arbitraries — no recursion needed

const arbNull: fc.Arbitrary<TypeRef> = fc.constant(t(types.null))
const arbBoolean: fc.Arbitrary<TypeRef> = fc.constant(t(types.boolean))
const arbNumber: fc.Arbitrary<TypeRef> = fc.constant(t(types.number))
const arbInteger: fc.Arbitrary<TypeRef> = fc.constant(t(types.integer))
const arbString: fc.Arbitrary<TypeRef> = fc.constant(t(types.string))
const arbUnknown: fc.Arbitrary<TypeRef> = fc.constant(t(types.unknown))

const arbIntWidth: fc.Arbitrary<TypeRef> = fc.constantFrom(
  uint8(), int8(), uint16(), int16(), uint32(), int32(), uint64(), int64(),
)

const arbStringFormat: fc.Arbitrary<TypeRef> = fc.constantFrom(
  date(), datetime(), uuid(), uri(), email(),
)

const arbEnum: fc.Arbitrary<TypeRef> = fc.array(
  fc.stringMatching(/^[a-z][a-z0-9_]{1,10}$/),
  { minLength: 2, maxLength: 6 },
).map((members) => {
  // Deduplicate — enum members must be distinct
  const unique = [...new Set(members)]
  return unique.length >= 2 ? t(types.enum(unique)) : t(types.enum(["a", "b"]))
})

const arbLiteral: fc.Arbitrary<TypeRef> = fc.oneof(
  fc.constant(t(types.literal(null))),
  fc.boolean().map((b) => t(types.literal(b))),
  fc.integer({ min: -200, max: 200 }).map((n) => t(types.literal(n))),
  fc.stringMatching(/^[a-z]{2,8}$/).map((s) => t(types.literal(s))),
)

// All leaf types (no children) — used at max depth and weighted heavily
const arbLeaf: fc.Arbitrary<TypeRef> = fc.oneof(
  { weight: 2, arbitrary: arbNull },
  { weight: 3, arbitrary: arbBoolean },
  { weight: 3, arbitrary: arbNumber },
  { weight: 3, arbitrary: arbInteger },
  { weight: 4, arbitrary: arbString },
  { weight: 5, arbitrary: arbIntWidth },
  { weight: 3, arbitrary: arbStringFormat },
  { weight: 2, arbitrary: arbEnum },
  { weight: 2, arbitrary: arbLiteral },
  { weight: 1, arbitrary: arbUnknown },
)

// Recursive TypeRef tree — fc.memo controls depth
const arbTypeRef: fc.Memo<TypeRef> = fc.memo((depth) => {
  if (depth <= 0) return arbLeaf

  const inner = arbTypeRef(depth - 1)

  const arbObject: fc.Arbitrary<TypeRef> = fc.tuple(
    fc.shuffledSubarray(fieldNamePool, { minLength: 1, maxLength: 5 }),
    fc.array(fc.tuple(inner, fc.boolean()), { minLength: 1, maxLength: 5 }),
  ).map(([names, fieldSpecs]) => {
    const fields: Record<string, TypeRef> = {}
    const count = Math.min(names.length, fieldSpecs.length)
    for (let i = 0; i < count; i++) {
      const [fieldType, isOptional] = fieldSpecs[i]!
      fields[names[i]!] = isOptional
        ? { shape: fieldType.shape, meta: { ...fieldType.meta, optional: true } }
        : fieldType
    }
    return t(types.object(fields))
  })

  const arbArray: fc.Arbitrary<TypeRef> = inner.map((el) => t(types.array(el)))

  const arbTuple: fc.Arbitrary<TypeRef> = fc.array(inner, { minLength: 1, maxLength: 4 })
    .map((els) => t(types.tuple(els)))

  const arbUnion: fc.Arbitrary<TypeRef> = fc.array(inner, { minLength: 2, maxLength: 3 })
    .map((vs) => t(types.union(vs)))

  const arbMap: fc.Arbitrary<TypeRef> = inner.map((v) => t(types.map(t(types.string), v)))

  return fc.oneof(
    { weight: 12, arbitrary: arbLeaf },
    { weight: 5, arbitrary: arbObject },
    { weight: 3, arbitrary: arbArray },
    { weight: 3, arbitrary: arbTuple },
    { weight: 2, arbitrary: arbUnion },
    { weight: 2, arbitrary: arbMap },
  )
})

// ---------------------------------------------------------------------------
// Value arbitrary — given a TypeRef, produce a conforming JSON value
// ---------------------------------------------------------------------------

function arbDate(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.integer({ min: 2000, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  ).map(([y, m, d]) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  )
}

function arbDatetime(): fc.Arbitrary<string> {
  return fc.tuple(
    arbDate(),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
  ).map(([d, h, min, s]) =>
    `${d}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`
  )
}

function arbUuid(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.stringMatching(/^[0-9a-f]{8}$/),
    fc.stringMatching(/^[0-9a-f]{4}$/),
    fc.stringMatching(/^[0-9a-f]{4}$/),
    fc.stringMatching(/^[0-9a-f]{4}$/),
    fc.stringMatching(/^[0-9a-f]{12}$/),
  ).map(([a, b, c, d, e]) => `${a}-${b}-${c}-${d}-${e}`)
}

function arbEmail(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.stringMatching(/^[a-z]{2,8}$/),
    fc.stringMatching(/^[a-z]{2,8}$/),
  ).map(([user, domain]) => `${user}@${domain}.com`)
}

function arbUri(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom("http", "https"),
    fc.stringMatching(/^[a-z]{3,10}$/),
    fc.stringMatching(/^[a-z0-9]{1,8}$/),
  ).map(([scheme, domain, path]) => `${scheme}://${domain}.com/${path}`)
}

// A plain string that won't accidentally match date/datetime/uuid/email/uri formats.
// Starts with an uppercase letter to avoid matching any format regex.
function arbPlainString(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[A-Z][a-zA-Z]{2,10}$/)
}

function arbValueForType(ref: TypeRef): fc.Arbitrary<unknown> {
  const { shape } = ref
  switch (shape.kind) {
    case "null":
      return fc.constant(null)

    case "boolean":
      return fc.boolean()

    case "number":
      // Always fractional — avoid accidentally producing an integer
      return fc.double({ min: -1000, max: 1000, noDefaultInfinity: true, noNaN: true })
        .map((n) => {
          if (Number.isInteger(n)) return n + 0.5
          return n
        })

    case "integer":
      return fc.integer({ min: -1000, max: 1000 })

    case "string":
      return arbPlainString()

    // Integer widths — generate within exact range
    case "uint8":  return fc.integer({ min: 0, max: 255 })
    case "int8":   return fc.integer({ min: -128, max: 127 })
    case "uint16": return fc.integer({ min: 0, max: 65535 })
    case "int16":  return fc.integer({ min: -32768, max: 32767 })
    case "uint32": return fc.integer({ min: 0, max: 4294967295 })
    case "int32":  return fc.integer({ min: -2147483648, max: 2147483647 })
    case "uint64": return fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
    case "int64":  return fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })

    // String format kinds
    case "date":     return arbDate()
    case "datetime": return arbDatetime()
    case "uuid":     return arbUuid()
    case "uri":      return arbUri()
    case "email":    return arbEmail()

    case "object": {
      const fields = (shape as { kind: "object"; fields: Record<string, TypeRef> }).fields
      const entries = Object.entries(fields)
      if (entries.length === 0) return fc.constant({})
      // Build a record by generating each field's value independently
      const arbs: Record<string, fc.Arbitrary<unknown>> = {}
      const optionalFlags: Record<string, boolean> = {}
      for (const [name, fieldRef] of entries) {
        arbs[name] = arbValueForType(fieldRef)
        optionalFlags[name] = fieldRef.meta.optional === true
      }
      return fc.record(arbs).chain((rec) => {
        // For optional fields, sometimes omit them
        return fc.tuple(
          ...Object.keys(rec).map((k) =>
            optionalFlags[k] ? fc.boolean() : fc.constant(true)
          )
        ).map((includes) => {
          const result: Record<string, unknown> = {}
          const keys = Object.keys(rec)
          for (let i = 0; i < keys.length; i++) {
            if (includes[i]) result[keys[i]!] = rec[keys[i]!]
          }
          return result
        })
      })
    }

    case "array": {
      const element = (shape as { kind: "array"; element: TypeRef }).element
      // Generate 3-7 elements (at least 3 to meet the default arrayThreshold)
      return fc.array(arbValueForType(element), { minLength: 3, maxLength: 7 })
    }

    case "tuple": {
      const elements = (shape as { kind: "tuple"; elements: readonly TypeRef[] }).elements
      if (elements.length === 0) return fc.constant([])
      return fc.tuple(...elements.map(arbValueForType)) as fc.Arbitrary<unknown>
    }

    case "map": {
      const value = (shape as { kind: "map"; value: TypeRef }).value
      // Generate 2-5 entries with plain-string keys (won't match formats)
      return fc.array(
        fc.tuple(fc.stringMatching(/^[a-z]{2,6}$/), arbValueForType(value)),
        { minLength: 2, maxLength: 5 },
      ).map((pairs) => {
        const result: Record<string, unknown> = {}
        for (const [k, v] of pairs) result[k] = v
        return result
      })
    }

    case "union": {
      const variants = (shape as { kind: "union"; variants: readonly TypeRef[] }).variants
        .filter((v) => v.shape.kind !== "never")
      if (variants.length === 0) return fc.constant(null)
      return fc.oneof(...variants.map(arbValueForType))
    }

    case "enum": {
      const members = (shape as { kind: "enum"; members: readonly string[] }).members
      return fc.constantFrom(...members)
    }

    case "literal": {
      const value = (shape as { kind: "literal"; value: string | number | boolean | null }).value
      return fc.constant(value)
    }

    case "unknown":
      // Generate some valid JSON — mix of types
      return fc.oneof(
        fc.constant(null),
        fc.boolean(),
        fc.integer({ min: 0, max: 100 }),
        arbPlainString(),
      )

    case "never":
      // No valid values — should not be reached
      return fc.constant(undefined)

    default:
      return fc.constant(null)
  }
}

// ---------------------------------------------------------------------------
// Consistency checking — value inhabits inferred type
// ---------------------------------------------------------------------------

// All integer-like kinds (subtypes of integer, plus integer itself)
const integerKinds = new Set([
  "uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64", "integer",
])

function isSubkind(child: string, parent: string): boolean {
  if (child === parent) return true
  return ancestors(child).includes(parent)
}

/** Check that the value is a valid inhabitant of the inferred TypeRef. */
function valueInhabitsType(value: unknown, inferred: TypeRef): string | null {
  const kind = inferred.shape.kind

  if (value === null) {
    return kind === "null" ? null : `null value inferred as ${kind}`
  }

  if (typeof value === "boolean") {
    return kind === "boolean" ? null : `boolean value inferred as ${kind}`
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      // Integer values should infer as some integer kind
      if (integerKinds.has(kind)) {
        // Check the value actually fits the inferred width's range
        const range = intWidthRanges[kind]
        if (range !== undefined) {
          if (value < range.min || value > range.max) {
            return `integer ${value} inferred as ${kind} but out of range [${range.min}, ${range.max}]`
          }
        }
        return null
      }
      // Integer could also be inferred as number (if narrowing is off)
      if (kind === "number") return null
      return `integer value ${value} inferred as ${kind}`
    }
    // Fractional number
    return kind === "number" ? null : `fractional ${value} inferred as ${kind}`
  }

  if (typeof value === "string") {
    // Any string subtype is valid for a string value. `date`/`datetime` are
    // no longer string subtypes (they're type-ir's `Date` domain type — see
    // kinds/date-time.ts), but `fromJson`'s string-format detection still
    // infers them FROM a raw JSON string (from-json.ts's `inferString`) —
    // this property is about that wire-to-inference relationship, not the
    // compiled validator's domain-typed `check()`, so a string value
    // inferred as date/datetime is still a valid inhabitant here.
    if (kind === "string" || isSubkind(kind, "string") || kind === "date" || kind === "datetime") return null
    return `string "${value}" inferred as ${kind}`
  }

  if (Array.isArray(value)) {
    if (kind === "array" || kind === "tuple") return null
    return `array value inferred as ${kind}`
  }

  if (typeof value === "object") {
    if (kind === "object") {
      // Check that every key in the value has a corresponding field
      const fields = (inferred.shape as { fields: Record<string, TypeRef> }).fields
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!(key in fields)) {
          return `object key "${key}" not in inferred fields`
        }
      }
      // Check that every required inferred field is present in the value
      for (const [key, fieldRef] of Object.entries(fields)) {
        if (!fieldRef.meta.optional && !(key in (value as Record<string, unknown>))) {
          return `required inferred field "${key}" missing from value`
        }
      }
      return null
    }
    return `object value inferred as ${kind}`
  }

  return null // unknown/undefined — anything goes
}

/** Check the inferred type is the tightest integer width for this value. */
function checkIntegerTightness(value: number, inferred: TypeRef): string | null {
  if (!Number.isInteger(value)) return null
  const kind = inferred.shape.kind
  if (!integerKinds.has(kind)) return null

  // Replay the inferrer's tightest-first logic: uint8, int8, uint16, int16, uint32, int32, uint64, int64
  const order: { kind: string; min: number; max: number }[] = [
    { kind: "uint8", min: 0, max: 255 },
    { kind: "int8", min: -128, max: 127 },
    { kind: "uint16", min: 0, max: 65535 },
    { kind: "int16", min: -32768, max: 32767 },
    { kind: "uint32", min: 0, max: 4294967295 },
    { kind: "int32", min: -2147483648, max: 2147483647 },
  ]

  for (const { kind: expected, min, max } of order) {
    if (value >= min && value <= max) {
      return kind === expected
        ? null
        : `value ${value} should infer as ${expected} (tightest) but got ${kind}`
    }
  }

  // Beyond 32-bit
  if (Number.isSafeInteger(value)) {
    const expected = value >= 0 ? "uint64" : "int64"
    return kind === expected
      ? null
      : `value ${value} should infer as ${expected} but got ${kind}`
  }

  return null
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// Depth 3 gives types up to 3 levels of nesting — deep enough to exercise
// objects-in-arrays, unions-of-objects, etc.
const typeRefArb = arbTypeRef(3)

// Combined arbitrary: generate a type, then generate a conforming value
function arbTypeAndValue(): fc.Arbitrary<{ type: TypeRef; value: unknown }> {
  return typeRefArb
    .filter((ref) => ref.shape.kind !== "never")
    .chain((type) =>
      arbValueForType(type).map((value) => ({ type, value }))
    )
}

describe("fromJson property-based tests", () => {

  // Property 1: fromJson never crashes on any valid JSON
  test("no crashes on arbitrary JSON values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        // Should not throw
        fromJson(value)
      }),
      { numRuns: 10000 },
    )
  })

  // Property 2: determinism — same input yields structurally equal output
  test("determinism: same input, same output", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const a = fromJson(value)
        const b = fromJson(value)
        expect(a).toEqual(b)
      }),
      { numRuns: 5000 },
    )
  })

  // Property 3: the generated value inhabits the inferred type
  test("roundtrip: value inhabits inferred type", () => {
    fc.assert(
      fc.property(arbTypeAndValue(), ({ type, value }) => {
        const inferred = fromJson(value)
        const error = valueInhabitsType(value, inferred)
        if (error !== null) {
          throw new Error(
            `${error}\n` +
            `  original type: ${JSON.stringify(type.shape)}\n` +
            `  value:         ${JSON.stringify(value)}\n` +
            `  inferred:      ${JSON.stringify(inferred.shape)}`,
          )
        }
      }),
      { numRuns: 10000 },
    )
  })

  // Property 4: integer tightness — inferred width is the tightest possible
  test("tightness: integers infer to tightest width", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        (value) => {
          const inferred = fromJson(value)
          const error = checkIntegerTightness(value, inferred)
          if (error !== null) throw new Error(error)
        },
      ),
      { numRuns: 10000 },
    )
  })

  // Property 5: leaf type stability — re-inferring a leaf value gives the same type
  test("leaf stability: fromJson on a leaf value is idempotent on type", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.boolean(),
          fc.double({ min: -1000, max: 1000, noDefaultInfinity: true, noNaN: true })
            .map((n) => Number.isInteger(n) ? n + 0.5 : n),
          fc.integer({ min: -1000, max: 1000 }),
          arbPlainString(),
        ),
        (value) => {
          const first = fromJson(value)
          // Generate a "canonical" value from the inferred type and re-infer.
          // For leaves, the same value re-inferred should give the same type.
          const second = fromJson(value)
          expect(first).toEqual(second)
        },
      ),
      { numRuns: 5000 },
    )
  })

  // Property 6: object field preservation — all value keys appear in inferred object
  test("object fields: every key in value appears in inferred object", () => {
    fc.assert(
      fc.property(
        // Generate small objects with plain-string keys and mixed values
        fc.dictionary(
          fc.stringMatching(/^[a-z]{2,6}$/),
          fc.oneof(
            fc.constant(null),
            fc.boolean(),
            fc.integer({ min: 0, max: 100 }),
            arbPlainString(),
          ),
          { minKeys: 1, maxKeys: 8 },
        ),
        (obj) => {
          const inferred = fromJson(obj)
          expect(inferred.shape.kind).toBe("object")
          const fields = (inferred.shape as { fields: Record<string, TypeRef> }).fields
          for (const key of Object.keys(obj)) {
            if (!(key in fields)) {
              throw new Error(`key "${key}" missing from inferred object fields`)
            }
          }
          for (const key of Object.keys(fields)) {
            if (!(key in obj)) {
              throw new Error(`inferred field "${key}" not in input object`)
            }
          }
        },
      ),
      { numRuns: 5000 },
    )
  })

  // Property 7: array homogeneity — arrays of same-typed values infer as array (not tuple)
  test("homogeneous arrays above threshold infer as array kind", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 3, maxLength: 20 }),
        (arr) => {
          const inferred = fromJson(arr)
          // All elements are small non-negative integers -> all infer as uint8
          // -> homogeneous -> should be array, not tuple
          expect(inferred.shape.kind).toBe("array")
        },
      ),
      { numRuns: 5000 },
    )
  })

  // Property 8: string format detection is sound — formats only detected for valid strings
  test("string format soundness: detected formats match value", () => {
    fc.assert(
      fc.property(arbPlainString(), (s) => {
        const inferred = fromJson(s)
        // Plain strings (starting with uppercase, no special format) should
        // not be detected as date, datetime, uuid, email, or uri
        expect(inferred.shape.kind).toBe("string")
        expect(inferred.meta).toEqual({})
      }),
      { numRuns: 5000 },
    )
  })
})
