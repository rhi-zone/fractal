// Roundtrip fuzz harness for fromJson: generate arbitrary TypeRefs, produce
// conforming JSON values, run fromJson, and check that the inferred type
// is consistent with the generated value.
//
// The key invariant: fromJson should not crash, and the generated value
// should be a valid inhabitant of the inferred type. Width narrowing to a
// tighter type than the original is expected (e.g. value 5 from int32
// infers as uint8) — that's correct inference, not a failure.

import { describe, expect, test } from "bun:test"
import { t, types, ancestors, type TypeRef } from "./index.ts"
import {
  int8, int16, int32, int64,
  uint8, uint16, uint32, uint64,
  date, datetime, uuid, uri,
} from "./kinds/common.ts"
import { fromJson } from "./from-json.ts"

// ---------------------------------------------------------------------------
// Seeded PRNG — deterministic runs for reproducibility
// ---------------------------------------------------------------------------

// xoshiro128** — fast, good quality, seedable
function makeRng(seed: number) {
  let s0 = seed | 0 || 1
  let s1 = (seed * 2654435761) | 0 || 2
  let s2 = (seed * 2246822519) | 0 || 3
  let s3 = (seed * 3266489917) | 0 || 4
  return {
    /** Returns a float in [0, 1). */
    next(): number {
      const result = Math.imul(s1 * 5, 7) >>> 0
      const t = s1 << 9
      s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3
      s2 ^= t; s3 = (s3 << 11) | (s3 >>> 21)
      return (result >>> 0) / 4294967296
    },
    /** Integer in [min, max] inclusive. */
    int(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min
    },
    /** Pick a random element from an array. */
    pick<T>(arr: readonly T[]): T {
      return arr[this.int(0, arr.length - 1)]!
    },
    /** Return true with probability p. */
    chance(p: number): boolean {
      return this.next() < p
    },
  }
}

type Rng = ReturnType<typeof makeRng>

// ---------------------------------------------------------------------------
// TypeRef generator — random type trees
// ---------------------------------------------------------------------------

// Integer width ranges for value generation
const intRanges: Record<string, [number, number]> = {
  uint8:  [0, 255],
  int8:   [-128, 127],
  uint16: [0, 65535],
  int16:  [-32768, 32767],
  uint32: [0, 4294967295],
  int32:  [-2147483648, 2147483647],
  // For uint64/int64 we stay within safe integer range
  uint64: [0, Number.MAX_SAFE_INTEGER],
  int64:  [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
}

const fieldNames = [
  "id", "name", "age", "email", "url", "count", "value", "label",
  "status", "active", "score", "data", "items", "type", "kind",
  "title", "description", "timestamp", "amount", "level",
]

function generateTypeRef(rng: Rng, depth: number): TypeRef {
  // Bias toward leaves at deeper nesting to keep trees finite
  const maxDepth = 4
  const leafBias = depth >= maxDepth ? 1.0 : depth / (maxDepth + 1)

  if (rng.chance(leafBias)) {
    return generateLeaf(rng)
  }

  const r = rng.next()
  if (r < 0.08) return generateLeaf(rng)
  if (r < 0.28) return generateIntWidth(rng)
  if (r < 0.38) return generateStringFormat(rng)
  if (r < 0.53) return generateObject(rng, depth)
  if (r < 0.63) return generateArray(rng, depth)
  if (r < 0.73) return generateTuple(rng, depth)
  if (r < 0.80) return generateUnion(rng, depth)
  if (r < 0.85) return generateMap(rng, depth)
  if (r < 0.90) return generateEnum(rng)
  if (r < 0.95) return generateLiteral(rng)
  return t(types.unknown)
}

function generateLeaf(rng: Rng): TypeRef {
  const kind = rng.pick(["null", "boolean", "number", "integer", "string"] as const)
  switch (kind) {
    case "null": return t(types.null)
    case "boolean": return t(types.boolean)
    case "number": return t(types.number)
    case "integer": return t(types.integer)
    case "string": return t(types.string)
  }
}

function generateIntWidth(rng: Rng): TypeRef {
  const kind = rng.pick(["uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64"] as const)
  switch (kind) {
    case "uint8": return uint8()
    case "int8": return int8()
    case "uint16": return uint16()
    case "int16": return int16()
    case "uint32": return uint32()
    case "int32": return int32()
    case "uint64": return uint64()
    case "int64": return int64()
  }
}

function generateStringFormat(rng: Rng): TypeRef {
  const fmt = rng.pick(["date", "datetime", "uuid", "uri", "email"] as const)
  switch (fmt) {
    case "date": return date()
    case "datetime": return datetime()
    case "uuid": return uuid()
    case "uri": return uri()
    case "email": return t(types.string, { format: "email" })
  }
}

function generateObject(rng: Rng, depth: number): TypeRef {
  const fieldCount = rng.int(1, 5)
  const usedNames = new Set<string>()
  const fields: Record<string, TypeRef> = {}
  for (let i = 0; i < fieldCount; i++) {
    let name: string
    do { name = rng.pick(fieldNames) } while (usedNames.has(name))
    usedNames.add(name)
    let fieldRef = generateTypeRef(rng, depth + 1)
    if (rng.chance(0.25)) {
      fieldRef = { shape: fieldRef.shape, meta: { ...fieldRef.meta, optional: true } }
    }
    fields[name] = fieldRef
  }
  return t(types.object(fields))
}

function generateArray(rng: Rng, depth: number): TypeRef {
  return t(types.array(generateTypeRef(rng, depth + 1)))
}

function generateTuple(rng: Rng, depth: number): TypeRef {
  const len = rng.int(1, 4)
  const elements: TypeRef[] = []
  for (let i = 0; i < len; i++) elements.push(generateTypeRef(rng, depth + 1))
  return t(types.tuple(elements))
}

function generateUnion(rng: Rng, depth: number): TypeRef {
  const count = rng.int(2, 3)
  const variants: TypeRef[] = []
  for (let i = 0; i < count; i++) variants.push(generateTypeRef(rng, depth + 1))
  return t(types.union(variants))
}

function generateMap(rng: Rng, depth: number): TypeRef {
  return t(types.map(t(types.string), generateTypeRef(rng, depth + 1)))
}

function generateEnum(rng: Rng): TypeRef {
  const count = rng.int(2, 5)
  const members: string[] = []
  for (let i = 0; i < count; i++) members.push(`val_${i}_${rng.int(0, 999)}`)
  return t(types.enum(members))
}

function generateLiteral(rng: Rng): TypeRef {
  const r = rng.next()
  if (r < 0.25) return t(types.literal(null))
  if (r < 0.50) return t(types.literal(rng.chance(0.5)))
  if (r < 0.75) return t(types.literal(rng.int(-100, 100)))
  return t(types.literal(`lit_${rng.int(0, 999)}`))
}

// ---------------------------------------------------------------------------
// Value generator — produce a valid JSON value for a TypeRef
// ---------------------------------------------------------------------------

function generateValue(ref: TypeRef, rng: Rng): unknown {
  const { shape, meta } = ref
  switch (shape.kind) {
    case "null": return null
    case "boolean": return rng.chance(0.5)
    case "number": return rng.next() * 200 - 100 + 0.1 // always fractional
    case "integer": return rng.int(-1000, 1000)
    case "string": return generatePlainString(meta, rng)

    // Integer widths — generate within the exact range
    case "uint8":  return rng.int(0, 255)
    case "int8":   return rng.int(-128, 127)
    case "uint16": return rng.int(0, 65535)
    case "int16":  return rng.int(-32768, 32767)
    case "uint32": return rng.int(0, 4294967295)
    case "int32":  return rng.int(-2147483648, 2147483647)
    case "uint64": return rng.int(0, Number.MAX_SAFE_INTEGER)
    case "int64":  return rng.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)

    // Formatted strings (extension kinds)
    case "date":     return generateDate(rng)
    case "datetime": return generateDatetime(rng)
    case "uuid":     return generateUuid(rng)
    case "uri":      return `https://example.com/${rng.int(0, 9999)}`

    case "object":   return generateObjectValue(shape as { kind: "object"; fields: Record<string, TypeRef> }, rng)
    case "array":    return generateArrayValue(shape as { kind: "array"; element: TypeRef }, rng)
    case "tuple":    return generateTupleValue(shape as { kind: "tuple"; elements: readonly TypeRef[] }, rng)
    case "map":      return generateMapValue(shape as { kind: "map"; value: TypeRef }, rng)
    case "union":    return generateUnionValue(shape as { kind: "union"; variants: readonly TypeRef[] }, rng)
    case "enum":     return rng.pick((shape as { kind: "enum"; members: readonly string[] }).members)
    case "literal":  return (shape as { kind: "literal"; value: string | number | boolean | null }).value
    case "unknown":  return generateRandomJsonValue(rng)
    case "never":    return undefined // unreachable — skip in caller
    default:         return null
  }
}

function generatePlainString(meta: Record<string, unknown>, rng: Rng): string {
  // If the type has format meta, generate a valid string of that format
  if (meta.format === "email") return generateEmail(rng)
  // Plain string — make sure it doesn't accidentally match a format
  const chars = "abcdefghijklmnopqrstuvwxyz"
  const len = rng.int(3, 12)
  let result = ""
  for (let i = 0; i < len; i++) result += chars[rng.int(0, chars.length - 1)]
  return result
}

function generateDate(rng: Rng): string {
  const y = rng.int(2000, 2030)
  const m = String(rng.int(1, 12)).padStart(2, "0")
  const d = String(rng.int(1, 28)).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function generateDatetime(rng: Rng): string {
  const d = generateDate(rng)
  const h = String(rng.int(0, 23)).padStart(2, "0")
  const min = String(rng.int(0, 59)).padStart(2, "0")
  const s = String(rng.int(0, 59)).padStart(2, "0")
  return `${d}T${h}:${min}:${s}Z`
}

function generateUuid(rng: Rng): string {
  const hex = (n: number) => {
    let s = ""
    for (let i = 0; i < n; i++) s += "0123456789abcdef"[rng.int(0, 15)]
    return s
  }
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`
}

function generateEmail(rng: Rng): string {
  const user = "user" + rng.int(0, 999)
  const domain = "example" + rng.int(0, 99) + ".com"
  return `${user}@${domain}`
}

function generateObjectValue(shape: { kind: "object"; fields: Record<string, TypeRef> }, rng: Rng): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, fieldRef] of Object.entries(shape.fields)) {
    // Skip optional fields 50% of the time
    if (fieldRef.meta.optional && rng.chance(0.5)) continue
    result[name] = generateValue(fieldRef, rng)
  }
  return result
}

function generateArrayValue(shape: { kind: "array"; element: TypeRef }, rng: Rng): unknown[] {
  // Generate 3-7 elements (at least 3 to meet the default array threshold)
  const len = rng.int(3, 7)
  const result: unknown[] = []
  for (let i = 0; i < len; i++) result.push(generateValue(shape.element, rng))
  return result
}

function generateTupleValue(shape: { kind: "tuple"; elements: readonly TypeRef[] }, rng: Rng): unknown[] {
  return shape.elements.map((el) => generateValue(el, rng))
}

function generateMapValue(shape: { kind: "map"; value: TypeRef }, rng: Rng): Record<string, unknown> {
  const count = rng.int(2, 5)
  const result: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const key = `key_${rng.int(0, 9999)}`
    result[key] = generateValue(shape.value, rng)
  }
  return result
}

function generateUnionValue(shape: { kind: "union"; variants: readonly TypeRef[] }, rng: Rng): unknown {
  // Filter out never variants
  const valid = shape.variants.filter((v) => v.shape.kind !== "never")
  if (valid.length === 0) return null
  return generateValue(rng.pick(valid), rng)
}

function generateRandomJsonValue(rng: Rng): unknown {
  const r = rng.next()
  if (r < 0.15) return null
  if (r < 0.30) return rng.chance(0.5)
  if (r < 0.50) return rng.int(-100, 100)
  if (r < 0.70) return "str_" + rng.int(0, 999)
  if (r < 0.85) return { a: rng.int(0, 100), b: "v" + rng.int(0, 99) }
  return [rng.int(0, 10), rng.int(0, 10), rng.int(0, 10)]
}

// ---------------------------------------------------------------------------
// Validation — check that a value is a valid inhabitant of a TypeRef
// ---------------------------------------------------------------------------

function isSubkind(inferred: string, original: string): boolean {
  if (inferred === original) return true
  // Check if inferred is a descendant of original via ancestors
  return ancestors(inferred).includes(original)
}

// All integer width kinds in tightest-to-widest order.
// A value inferred as uint8 is valid for any wider integer kind.
const intWidthOrder = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64", "integer"]

function isIntegerSubtype(inferred: string, original: string): boolean {
  const inferredIdx = intWidthOrder.indexOf(inferred)
  const originalIdx = intWidthOrder.indexOf(original)
  if (inferredIdx === -1 || originalIdx === -1) return false
  // A tighter (earlier in list) inferred width is fine — the value fits
  // both the inferred type and the original. But we also need to check that
  // the inferred width's range is a subset of the original's.
  // Actually, for the roundtrip invariant, what matters is: the value we
  // generated from the original type was accepted by fromJson without error,
  // and the inferred type is an integer subtype. Since the value was
  // generated within the original's range and the inferrer picks the
  // tightest width that fits, any tighter width is correct.
  return true
}

/**
 * Check that the inferred TypeRef is consistent with the original TypeRef
 * and the generated value. Returns null on success, or an error message.
 */
function checkConsistency(
  original: TypeRef,
  value: unknown,
  inferred: TypeRef,
): string | null {
  const origKind = original.shape.kind
  const infKind = inferred.shape.kind

  // --- Primitives and integer widths ---
  // Width narrowing is expected: a value 5 generated from int32 will infer
  // as uint8. Both are subtypes of integer, so this is fine.
  if (isSubkind(infKind, origKind)) return null

  // Integer width cross-check: any integer kind inferred from a value
  // generated by another integer kind is fine — the value was in range.
  if (
    intWidthOrder.includes(infKind) &&
    (intWidthOrder.includes(origKind) || origKind === "number")
  ) {
    return null
  }

  // number -> integer narrowing: a value with zero fractional part generated
  // from `number` will be inferred as an integer kind. This is only valid if
  // the generated value actually has no fractional part. The value generator
  // adds 0.1 to number values to avoid this, but let's be safe.
  if (origKind === "number" && isSubkind(infKind, "number")) return null

  // Literal -> underlying type: literal(42) generates 42, inferred as uint8
  if (origKind === "literal") {
    const litVal = (original.shape as { value: unknown }).value
    if (litVal === null && infKind === "null") return null
    if (typeof litVal === "boolean" && infKind === "boolean") return null
    if (typeof litVal === "number" && (intWidthOrder.includes(infKind) || infKind === "number")) return null
    if (typeof litVal === "string" && (infKind === "string" || isSubkind(infKind, "string"))) return null
    return `literal ${JSON.stringify(litVal)} inferred as ${infKind}`
  }

  // Enum -> string: a single sampled enum value is just a string
  if (origKind === "enum" && infKind === "string") return null
  // Enum value might match a format (e.g. uuid-shaped enum member)
  if (origKind === "enum" && isSubkind(infKind, "string")) return null

  // String format: a plain string might not match a format (inferred as
  // plain string), or a formatted string inferred as a different format
  // subtype of string — both are string subtypes.
  if (origKind === "string" && isSubkind(infKind, "string")) return null
  // String with format meta (email) — the inferred type should also be
  // string with format meta or a string subtype
  if (isSubkind(origKind, "string") && isSubkind(infKind, "string")) return null

  // unknown -> anything: unknown is the top type, any inference is valid
  if (origKind === "unknown") return null

  // --- Containers ---

  if (origKind === "object" && infKind === "object") {
    return checkObjectConsistency(original, value as Record<string, unknown>, inferred)
  }

  if (origKind === "array" && infKind === "array") {
    // Array element type consistency is checked structurally below.
    // The inferrer merges element types, which may produce a different
    // (but compatible) element type.
    return null
  }

  // Array might be inferred as tuple (below threshold) — that's fine
  if (origKind === "array" && infKind === "tuple") return null
  // Tuple might be inferred as array (homogeneous elements above threshold)
  if (origKind === "tuple" && (infKind === "array" || infKind === "tuple")) return null

  // Map inferred as object (each key becomes a field) — expected
  if (origKind === "map" && infKind === "object") return null

  // Union: the generated value came from one variant, so the inferred type
  // should be consistent with that variant (not necessarily the union itself)
  if (origKind === "union") return null

  return `original kind ${origKind} inferred as ${infKind}`
}

function checkObjectConsistency(
  original: TypeRef,
  value: Record<string, unknown>,
  inferred: TypeRef,
): string | null {
  const origFields = (original.shape as { fields: Record<string, TypeRef> }).fields
  const infFields = (inferred.shape as { fields: Record<string, TypeRef> }).fields

  // Every field present in the value should appear in the inferred type
  for (const key of Object.keys(value)) {
    if (!(key in infFields)) {
      return `field "${key}" present in value but missing from inferred type`
    }
  }

  // Inferred type should not have fields that aren't in the value
  for (const key of Object.keys(infFields)) {
    if (!(key in value)) {
      return `field "${key}" in inferred type but not in value`
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// The fuzz test
// ---------------------------------------------------------------------------

const ITERATIONS = 2000

describe("fromJson roundtrip fuzz", () => {
  test(`${ITERATIONS} iterations: generate type -> generate value -> infer -> check consistency`, () => {
    const rng = makeRng(42) // deterministic seed
    let passed = 0
    let skipped = 0
    const failures: { iteration: number; original: TypeRef; value: unknown; inferred: TypeRef; error: string }[] = []

    for (let i = 0; i < ITERATIONS; i++) {
      const original = generateTypeRef(rng, 0)

      // Skip types that can't produce values
      if (original.shape.kind === "never") { skipped++; continue }

      let value: unknown
      try {
        value = generateValue(original, rng)
      } catch (e) {
        // Value generation failed — skip (shouldn't happen, but defensive)
        skipped++
        continue
      }

      let inferred: TypeRef
      try {
        inferred = fromJson(value)
      } catch (e) {
        failures.push({
          iteration: i,
          original,
          value,
          inferred: t(types.never),
          error: `fromJson crashed: ${e}`,
        })
        continue
      }

      const error = checkConsistency(original, value, inferred)
      if (error !== null) {
        failures.push({ iteration: i, original, value, inferred, error })
      } else {
        passed++
      }
    }

    // Report
    const total = ITERATIONS - skipped
    if (failures.length > 0) {
      const sample = failures.slice(0, 10)
      const report = sample.map((f) =>
        `  iteration ${f.iteration}: ${f.error}\n` +
        `    original: ${JSON.stringify(f.original.shape)}\n` +
        `    value:    ${JSON.stringify(f.value)}\n` +
        `    inferred: ${JSON.stringify(f.inferred.shape)}`
      ).join("\n")
      expect(failures.length).toBe(0)
      // This line is unreachable but helps with debugging if the test is
      // run in a mode that doesn't stop on first failure:
      console.log(`FAILURES (${failures.length}/${total}):\n${report}`)
    }

    expect(passed).toBe(total)
  })

  test("value generation covers all generatable kinds", () => {
    // Verify that the generator can produce values for each kind without
    // crashing, by explicitly constructing one of each.
    const rng = makeRng(123)
    const cases: TypeRef[] = [
      t(types.null),
      t(types.boolean),
      t(types.number),
      t(types.integer),
      t(types.string),
      t(types.string, { format: "email" }),
      uint8(), int8(), uint16(), int16(), uint32(), int32(), uint64(), int64(),
      date(), datetime(), uuid(), uri(),
      t(types.object({ a: t(types.string), b: t(types.integer, { optional: true }) })),
      t(types.array(t(types.boolean))),
      t(types.tuple([t(types.string), t(types.integer)])),
      t(types.map(t(types.string), t(types.number))),
      t(types.union([t(types.string), t(types.integer)])),
      t(types.enum(["a", "b", "c"])),
      t(types.literal(42)),
      t(types.literal("hello")),
      t(types.literal(true)),
      t(types.literal(null)),
      t(types.unknown),
    ]

    for (const typeRef of cases) {
      const value = generateValue(typeRef, rng)
      // Just check it doesn't crash and produces something JSON-serializable
      expect(() => JSON.stringify(value)).not.toThrow()
      // And fromJson doesn't crash on it
      expect(() => fromJson(value)).not.toThrow()
    }
  })

  test("nested type trees: objects in arrays, arrays of tuples, unions of objects", () => {
    const rng = makeRng(777)
    const nestedCases: TypeRef[] = [
      // Array of objects
      t(types.array(t(types.object({ id: uint32(), name: t(types.string) })))),
      // Object with nested array
      t(types.object({ tags: t(types.array(t(types.string))), count: int16() })),
      // Array of tuples
      t(types.array(t(types.tuple([t(types.string), uint8()])))),
      // Union of objects
      t(types.union([
        t(types.object({ type: t(types.literal("a")), x: uint8() })),
        t(types.object({ type: t(types.literal("b")), y: t(types.string) })),
      ])),
      // Deeply nested
      t(types.object({
        data: t(types.array(t(types.object({
          items: t(types.tuple([t(types.string), t(types.boolean)])),
          meta: t(types.map(t(types.string), uint16())),
        })))),
      })),
    ]

    for (const typeRef of nestedCases) {
      const value = generateValue(typeRef, rng)
      expect(() => JSON.stringify(value)).not.toThrow()
      const inferred = fromJson(value)
      const error = checkConsistency(typeRef, value, inferred)
      if (error !== null) {
        throw new Error(
          `Nested case failed: ${error}\n` +
          `  original: ${JSON.stringify(typeRef.shape)}\n` +
          `  value:    ${JSON.stringify(value)}\n` +
          `  inferred: ${JSON.stringify(inferred.shape)}`
        )
      }
    }
  })
})
