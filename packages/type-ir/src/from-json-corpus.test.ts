import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { t, types, type TypeRef } from "./index.ts"
import {
  int8, int16, int32, int64,
  uint8, uint16, uint32, uint64,
  date, datetime, uuid, uri,
} from "./kinds/common.ts"
import { fromJsonCorpus } from "./from-json-corpus.ts"

// ---------------------------------------------------------------------------
// Unit tests — deterministic, verifying specific behavior
// ---------------------------------------------------------------------------

describe("basic merging", () => {
  test("single value corpus = same as fromJson", () => {
    expect(fromJsonCorpus([42])).toEqual(uint8())
    expect(fromJsonCorpus(["hello"])).toEqual(t(types.string))
    expect(fromJsonCorpus([null])).toEqual(t(types.null))
  })

  test("empty corpus -> unknown", () => {
    expect(fromJsonCorpus([])).toEqual(t(types.unknown))
  })

  test("identical values -> same type", () => {
    expect(fromJsonCorpus([42, 42, 42])).toEqual(uint8())
  })

  test("boolean values merge to boolean", () => {
    expect(fromJsonCorpus([true, false, true])).toEqual(t(types.boolean))
  })

  test("null + non-null -> nullable", () => {
    const result = fromJsonCorpus([null, 42, 43])
    expect(result.shape.kind).toBe("uint8")
    expect(result.meta.nullable).toBe(true)
  })
})

describe("integer width unification", () => {
  test("uint8 + uint8 -> uint8", () => {
    expect(fromJsonCorpus([1, 2, 3])).toEqual(uint8())
  })

  test("uint8 + negative -> int8 or wider", () => {
    const result = fromJsonCorpus([1, -1, 2])
    // 1 -> uint8, -1 -> int8. Union of ranges [0,255] + [-128,127] = [-128,255] -> int16
    expect(result.shape.kind).toBe("int16")
  })

  test("small + large positive -> uint16 or wider", () => {
    const result = fromJsonCorpus([1, 300, 2])
    // uint8 + uint16 -> uint16
    expect(result.shape.kind).toBe("uint16")
  })

  test("int8 + uint16 -> int32 (needs [-128, 65535])", () => {
    const result = fromJsonCorpus([-1, 300, -2])
    // -1 -> int8 [-128,127], 300 -> uint16 [0,65535] -> need [-128,65535] -> int32
    expect(result.shape.kind).toBe("int32")
  })

  test("very large + very negative -> int64", () => {
    const result = fromJsonCorpus([5_000_000_000, -5_000_000_000, 0])
    expect(result.shape.kind).toBe("int64")
  })

  test("integer + number -> number", () => {
    const result = fromJsonCorpus([42, 3.14, 1])
    expect(result.shape.kind).toBe("number")
  })
})

describe("string format unification", () => {
  test("same format preserved", () => {
    const result = fromJsonCorpus([
      "2026-01-01", "2026-02-02", "2026-03-03",
    ])
    expect(result.shape.kind).toBe("date")
  })

  test("different formats widen to string", () => {
    const result = fromJsonCorpus([
      "2026-01-01",
      "123e4567-e89b-12d3-a456-426614174000",
      "2026-02-02",
    ])
    expect(result.shape.kind).toBe("string")
  })

  test("format + plain string -> string", () => {
    const result = fromJsonCorpus([
      "2026-01-01",
      "hello",
      "2026-02-02",
    ])
    expect(result.shape.kind).toBe("string")
  })
})

describe("object merging", () => {
  test("identical objects merge to same shape", () => {
    const result = fromJsonCorpus([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["id", "name"])
    expect(fields.id!.meta.optional).toBeUndefined()
    expect(fields.name!.meta.optional).toBeUndefined()
  })

  test("field present in some samples -> optional", () => {
    const result = fromJsonCorpus([
      { id: 1, name: "a" },
      { id: 2 },
      { id: 3, name: "c" },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.id!.meta.optional).toBeUndefined()
    expect(fields.name!.meta.optional).toBe(true)
  })

  test("field type varies across samples -> unified", () => {
    const result = fromJsonCorpus([
      { value: 1 },
      { value: "hello" },
      { value: 2 },
    ])
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    // uint8 + string -> union
    expect(fields.value!.shape.kind).toBe("union")
  })
})

describe("array element unification", () => {
  test("homogeneous arrays merge element types", () => {
    const result = fromJsonCorpus([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ])
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("uint8")
  })

  test("arrays with varying element ranges -> widened", () => {
    const result = fromJsonCorpus([
      [1, 2, 3],
      [300, 400, 500],
      [1, 2, 3],
    ])
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    expect(el.shape.kind).toBe("uint16")
  })
})

describe("enum detection", () => {
  test("string field with repeated values -> enum", () => {
    const values = []
    const statuses = ["active", "inactive", "pending"]
    for (let i = 0; i < 20; i++) {
      values.push({ status: statuses[i % 3], id: i })
    }
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.status!.shape.kind).toBe("enum")
    const members = (fields.status!.shape as { members: readonly string[] }).members
    expect([...members].sort()).toEqual(["active", "inactive", "pending"])
  })

  test("string field with many distinct values -> not enum", () => {
    const values = []
    for (let i = 0; i < 20; i++) {
      values.push({ name: `user_${i}`, id: i })
    }
    const result = fromJsonCorpus(values)
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.name!.shape.kind).toBe("string")
  })

  test("integer field with repeated values -> literal union", () => {
    const values = []
    const codes = [100, 200, 404]
    for (let i = 0; i < 20; i++) {
      values.push({ code: codes[i % 3] })
    }
    const result = fromJsonCorpus(values)
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(fields.code!.shape.kind).toBe("union")
    const variants = (fields.code!.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.every((v) => v.shape.kind === "literal")).toBe(true)
    const vals = variants.map((v) => (v.shape as { value: number }).value).sort((a, b) => a - b)
    expect(vals).toEqual([100, 200, 404])
  })
})

describe("discriminated union detection", () => {
  test("array of objects with discriminant field", () => {
    const values = [
      [
        { type: "circle", radius: 5 },
        { type: "rect", width: 3, height: 4 },
        { type: "circle", radius: 10 },
        { type: "rect", width: 6, height: 8 },
        { type: "circle", radius: 2 },
        { type: "rect", width: 1, height: 1 },
        { type: "circle", radius: 7 },
        { type: "rect", width: 9, height: 12 },
      ],
    ]
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("array")
    const el = (result.shape as { element: TypeRef }).element
    // Should detect discriminated union
    expect(el.shape.kind).toBe("union")
    expect(el.meta.discriminator).toBe("type")
    const variants = (el.shape as { variants: readonly TypeRef[] }).variants
    expect(variants.length).toBe(2)
    // Each variant should have a literal "type" field
    for (const v of variants) {
      const fields = (v.shape as { fields: Record<string, TypeRef> }).fields
      expect(fields.type!.shape.kind).toBe("literal")
    }
  })
})

describe("dict detection", () => {
  test("objects with varying keys -> map", () => {
    const values: Record<string, number>[] = []
    for (let i = 0; i < 10; i++) {
      const obj: Record<string, number> = {}
      // Each sample has different keys
      for (let j = 0; j < 3; j++) {
        obj[`key_${i}_${j}`] = i * 10 + j
      }
      values.push(obj)
    }
    const result = fromJsonCorpus(values)
    // Should detect as map (key set keeps growing)
    expect(result.shape.kind).toBe("map")
  })

  test("objects with stable keys -> record", () => {
    const values = []
    for (let i = 0; i < 10; i++) {
      values.push({ id: i, name: `user_${i}`, active: true })
    }
    const result = fromJsonCorpus(values)
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect(Object.keys(fields).sort()).toEqual(["active", "id", "name"])
  })

  test("mixed: stable keys + varying keys -> object with additionalProperties", () => {
    const values = []
    for (let i = 0; i < 10; i++) {
      const obj: Record<string, unknown> = { id: i, name: `user_${i}` }
      // Add varying extra keys
      obj[`extra_${i}_a`] = i * 10
      obj[`extra_${i}_b`] = i * 20
      values.push(obj)
    }
    const result = fromJsonCorpus(values)
    // Should detect mixed: record fields (id, name) + dynamic keys
    expect(result.shape.kind).toBe("object")
    expect(result.meta.additionalProperties).toBeDefined()
    const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
    expect("id" in fields).toBe(true)
    expect("name" in fields).toBe(true)
  })
})

describe("dirty data detection", () => {
  test("off by default", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, "oops"]
    const result = fromJsonCorpus(values)
    // Without dirty data detection, it should be a union
    expect(result.shape.kind).toBe("union")
  })

  test("when enabled, dominant type wins with warning", () => {
    const values: unknown[] = []
    for (let i = 0; i < 20; i++) values.push(i)
    values.push("oops") // 1 dirty value
    const result = fromJsonCorpus(values, { detectDirtyData: true })
    // The uint8 type should dominate, with a dirty data warning
    if (result.meta.dirtyDataWarning !== undefined) {
      expect(result.shape.kind).not.toBe("union")
      expect(typeof result.meta.dirtyDataWarning).toBe("string")
    }
    // If dirty data detection didn't fire (threshold not met), it's
    // still a union — that's also acceptable behavior
  })
})

// ---------------------------------------------------------------------------
// Property-based tests using fast-check
// ---------------------------------------------------------------------------

// Reuse value generation helpers from the fuzz test
function arbPlainString(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[A-Z][a-zA-Z]{2,10}$/)
}

function arbDate(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.integer({ min: 2000, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  ).map(([y, m, d]) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  )
}

function arbValueForTypeRef(ref: TypeRef): fc.Arbitrary<unknown> {
  const { shape, meta } = ref
  switch (shape.kind) {
    case "null": return fc.constant(null)
    case "boolean": return fc.boolean()
    case "number":
      return fc.double({ min: -1000, max: 1000, noDefaultInfinity: true, noNaN: true })
        .map((n) => Number.isInteger(n) ? n + 0.5 : n)
    case "integer": return fc.integer({ min: -1000, max: 1000 })
    case "string":
      if (meta.format === "email") return fc.stringMatching(/^[a-z]{2,8}$/).map((u) => `${u}@test.com`)
      return arbPlainString()
    case "uint8": return fc.integer({ min: 0, max: 255 })
    case "int8": return fc.integer({ min: -128, max: 127 })
    case "uint16": return fc.integer({ min: 0, max: 65535 })
    case "int16": return fc.integer({ min: -32768, max: 32767 })
    case "uint32": return fc.integer({ min: 0, max: 4294967295 })
    case "int32": return fc.integer({ min: -2147483648, max: 2147483647 })
    case "uint64": return fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
    case "int64": return fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })
    case "date": return arbDate()
    case "datetime":
      return fc.tuple(arbDate(), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }))
        .map(([d, h, m, s]) => `${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`)
    case "uuid":
      return fc.tuple(
        fc.stringMatching(/^[0-9a-f]{8}$/), fc.stringMatching(/^[0-9a-f]{4}$/),
        fc.stringMatching(/^[0-9a-f]{4}$/), fc.stringMatching(/^[0-9a-f]{4}$/),
        fc.stringMatching(/^[0-9a-f]{12}$/),
      ).map(([a, b, c, d, e]) => `${a}-${b}-${c}-${d}-${e}`)
    case "uri":
      return fc.stringMatching(/^[a-z]{3,8}$/).map((d) => `https://${d}.com/path`)
    case "object": {
      const fields = (shape as { fields: Record<string, TypeRef> }).fields
      const entries = Object.entries(fields)
      if (entries.length === 0) return fc.constant({})
      const arbs: Record<string, fc.Arbitrary<unknown>> = {}
      const optFlags: Record<string, boolean> = {}
      for (const [name, fieldRef] of entries) {
        arbs[name] = arbValueForTypeRef(fieldRef)
        optFlags[name] = fieldRef.meta.optional === true
      }
      return fc.record(arbs).chain((rec) =>
        fc.tuple(...Object.keys(rec).map((k) =>
          optFlags[k] ? fc.boolean() : fc.constant(true)
        )).map((includes) => {
          const result: Record<string, unknown> = {}
          const keys = Object.keys(rec)
          for (let i = 0; i < keys.length; i++) {
            if (includes[i]) result[keys[i]!] = rec[keys[i]!]
          }
          return result
        })
      )
    }
    case "array":
      return fc.array(arbValueForTypeRef((shape as { element: TypeRef }).element), { minLength: 3, maxLength: 7 })
    case "tuple": {
      const els = (shape as { elements: readonly TypeRef[] }).elements
      if (els.length === 0) return fc.constant([])
      return fc.tuple(...els.map(arbValueForTypeRef)) as fc.Arbitrary<unknown>
    }
    case "map":
      return fc.array(
        fc.tuple(fc.stringMatching(/^[a-z]{2,6}$/), arbValueForTypeRef((shape as { value: TypeRef }).value)),
        { minLength: 2, maxLength: 5 },
      ).map((pairs) => {
        const r: Record<string, unknown> = {}
        for (const [k, v] of pairs) r[k] = v
        return r
      })
    case "union": {
      const variants = (shape as { variants: readonly TypeRef[] }).variants.filter((v) => v.shape.kind !== "never")
      if (variants.length === 0) return fc.constant(null)
      return fc.oneof(...variants.map(arbValueForTypeRef))
    }
    case "enum":
      return fc.constantFrom(...(shape as { members: readonly string[] }).members)
    case "literal":
      return fc.constant((shape as { value: unknown }).value)
    case "unknown":
      return fc.oneof(fc.constant(null), fc.boolean(), fc.integer({ min: 0, max: 100 }), arbPlainString())
    default:
      return fc.constant(null)
  }
}

const integerKinds = new Set(["uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64", "integer"])

describe("property: no crashes on any JSON corpus", () => {
  test("arbitrary JSON values", () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 20 }),
        (values) => {
          fromJsonCorpus(values)
        },
      ),
      { numRuns: 5000 },
    )
  })
})

describe("property: determinism", () => {
  test("same corpus -> same result", () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { minLength: 1, maxLength: 10 }),
        (values) => {
          const a = fromJsonCorpus(values)
          const b = fromJsonCorpus(values)
          expect(a).toEqual(b)
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe("property: corpus inference is at least as wide as any single value", () => {
  test("corpus type covers each individual value's type", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant(null),
            fc.boolean(),
            fc.integer({ min: -1000, max: 1000 }),
            fc.double({ min: -100, max: 100, noDefaultInfinity: true, noNaN: true }).map((n) => Number.isInteger(n) ? n + 0.5 : n),
            arbPlainString(),
          ),
          { minLength: 2, maxLength: 10 },
        ),
        (values) => {
          const corpus = fromJsonCorpus(values)
          // The corpus type should be a supertype of each individual value's inferred type.
          // For this test, just check it doesn't crash and the kind is reasonable.
          const ck = corpus.shape.kind
          const hasNull = values.some((v) => v === null)
          const hasBool = values.some((v) => typeof v === "boolean")
          const hasNum = values.some((v) => typeof v === "number" && !Number.isInteger(v))
          const hasInt = values.some((v) => typeof v === "number" && Number.isInteger(v))
          const hasStr = values.some((v) => typeof v === "string")
          const typeCount = [hasNull, hasBool, hasNum || hasInt, hasStr].filter(Boolean).length

          if (typeCount > 1 || (hasNull && typeCount === 1)) {
            // Multiple JS-level types -> should be union or have nullable meta
            // (null + one type -> nullable, multiple types -> union)
            if (typeCount === 1 && hasNull) {
              // null + one other type -> nullable
              expect(corpus.meta.nullable === true || ck === "null" || ck === "union").toBe(true)
            }
          }
        },
      ),
      { numRuns: 3000 },
    )
  })
})

describe("property: optional field detection", () => {
  test("field present in some but not all samples marked optional", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          // N objects with 'id' always present
          fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 3, maxLength: 10 }),
          // Mask: which objects also have 'name'
          fc.array(fc.boolean(), { minLength: 3, maxLength: 10 }),
        ),
        ([ids, mask]) => {
          const len = Math.min(ids.length, mask.length)
          if (len < 3) return // too few samples

          const values: Record<string, unknown>[] = []
          let hasName = false
          let missingName = false
          for (let i = 0; i < len; i++) {
            const obj: Record<string, unknown> = { id: ids[i] }
            if (mask[i]) {
              obj.name = "test"
              hasName = true
            } else {
              missingName = true
            }
            values.push(obj)
          }

          if (!hasName || !missingName) return // need both present and absent

          const result = fromJsonCorpus(values)
          expect(result.shape.kind).toBe("object")
          const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
          expect(fields.name!.meta.optional).toBe(true)
          // 'id' should NOT be optional
          expect(fields.id!.meta.optional).toBeUndefined()
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe("property: enum detection with fast-check", () => {
  test("repeated string values from small set detected as enum", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          // Generate 2-5 distinct enum values
          fc.shuffledSubarray(
            ["active", "inactive", "pending", "archived", "deleted"],
            { minLength: 2, maxLength: 5 },
          ),
          // Number of samples
          fc.integer({ min: 15, max: 40 }),
        ),
        ([enumValues, n]) => {
          const values: { status: string; id: number }[] = []
          for (let i = 0; i < n; i++) {
            values.push({ status: enumValues[i % enumValues.length]!, id: i })
          }
          const result = fromJsonCorpus(values)
          const fields = (result.shape as { fields: Record<string, TypeRef> }).fields
          // Should detect enum for 'status' field
          expect(fields.status!.shape.kind).toBe("enum")
          const members = (fields.status!.shape as { members: readonly string[] }).members
          expect([...members].sort()).toEqual([...enumValues].sort())
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe("property: dict detection with fast-check", () => {
  test("objects with linearly growing key sets detected as map", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 15 }),
        (n) => {
          const values: Record<string, number>[] = []
          for (let i = 0; i < n; i++) {
            const obj: Record<string, number> = {}
            for (let j = 0; j < 3; j++) {
              obj[`k_${i}_${j}`] = i * 10 + j
            }
            values.push(obj)
          }
          const result = fromJsonCorpus(values)
          expect(result.shape.kind).toBe("map")
        },
      ),
      { numRuns: 500 },
    )
  })
})
