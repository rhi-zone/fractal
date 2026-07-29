import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { date, datetime, email, int8, int16, int32, int64, uint8, uint16, uint32, uint64, uri, uuid } from "./kinds/common.ts"
import { type LeafHeuristic } from "./from-json.ts"
import { fromJsonCorpus, type CorpusInferConfig } from "./from-json-corpus.ts"

// Single-value inference is the N=1 case of the one public entry point; there
// is no separate single-value function. This file exercises that case.
const inferOne = (value: unknown, config?: CorpusInferConfig) =>
  fromJsonCorpus([value], config)


describe("leaf types", () => {
  test("null", () => {
    expect(inferOne(null)).toEqual(t(types.null))
  })

  test("booleans collapse to boolean, never literal", () => {
    expect(inferOne(true)).toEqual(t(types.boolean))
    expect(inferOne(false)).toEqual(t(types.boolean))
  })

  test("small non-negative integer narrows to uint8", () => {
    expect(inferOne(42)).toEqual(uint8())
  })

  test("fractional number stays number", () => {
    expect(inferOne(3.14)).toEqual(t(types.number))
  })

  test("large positive integer beyond uint32 range narrows to uint64", () => {
    expect(inferOne(5_000_000_000)).toEqual(uint64())
  })

  test("large negative integer beyond int32 range narrows to int64", () => {
    expect(inferOne(-5_000_000_000)).toEqual(int64())
  })

  test("narrowIntegerWidth: false keeps plain integer", () => {
    expect(inferOne(42, { narrowIntegerWidth: false })).toEqual(t(types.integer))
  })

  test("plain string", () => {
    expect(inferOne("hello")).toEqual(t(types.string))
  })
})

describe("integer width narrowing", () => {
  test("0 -> uint8 (non-negative, fits [0,255])", () => {
    expect(inferOne(0)).toEqual(uint8())
  })

  test("127 -> uint8 (non-negative, fits [0,255] before int8 [-128,127])", () => {
    expect(inferOne(127)).toEqual(uint8())
  })

  test("128 -> uint8 (fits [0,255])", () => {
    expect(inferOne(128)).toEqual(uint8())
  })

  test("255 -> uint8 (upper bound of [0,255])", () => {
    expect(inferOne(255)).toEqual(uint8())
  })

  test("256 -> uint16 (exceeds uint8, fits [0,65535])", () => {
    expect(inferOne(256)).toEqual(uint16())
  })

  test("-1 -> int8 (negative, fits [-128,127])", () => {
    expect(inferOne(-1)).toEqual(int8())
  })

  test("-128 -> int8 (lower bound of [-128,127])", () => {
    expect(inferOne(-128)).toEqual(int8())
  })

  test("-129 -> int16 (exceeds int8, fits [-32768,32767])", () => {
    expect(inferOne(-129)).toEqual(int16())
  })

  test("32767 -> uint16 (non-negative, fits [0,65535] before int16 [-32768,32767])", () => {
    expect(inferOne(32767)).toEqual(uint16())
  })

  test("-32768 -> int16 (lower bound of [-32768,32767])", () => {
    expect(inferOne(-32768)).toEqual(int16())
  })

  test("-32769 -> int32 (exceeds int16, negative so skips uint32, fits [-2147483648,2147483647])", () => {
    expect(inferOne(-32769)).toEqual(int32())
  })

  test("65535 -> uint16 (upper bound of [0,65535])", () => {
    expect(inferOne(65535)).toEqual(uint16())
  })

  test("65536 -> uint32 (exceeds uint16, fits [0,4294967295])", () => {
    expect(inferOne(65536)).toEqual(uint32())
  })

  test("4294967295 -> uint32 (upper bound of [0,4294967295])", () => {
    expect(inferOne(4294967295)).toEqual(uint32())
  })

  test("4294967296 -> uint64 (exceeds uint32, non-negative)", () => {
    expect(inferOne(4294967296)).toEqual(uint64())
  })

  test("2147483647 -> uint32 (non-negative, fits [0,4294967295] before int32)", () => {
    expect(inferOne(2147483647)).toEqual(uint32())
  })

  test("-2147483648 -> int32 (lower bound of int32)", () => {
    expect(inferOne(-2147483648)).toEqual(int32())
  })

  test("-2147483649 -> int64 (exceeds int32, negative)", () => {
    expect(inferOne(-2147483649)).toEqual(int64())
  })
})

describe("string format detection", () => {
  test("ISO date", () => {
    expect(inferOne("2026-07-18")).toEqual(date())
  })

  test("ISO datetime", () => {
    expect(inferOne("2026-07-18T12:34:56Z")).toEqual(datetime())
  })

  test("uuid", () => {
    expect(inferOne("123e4567-e89b-12d3-a456-426614174000")).toEqual(uuid())
  })

  test("email", () => {
    expect(inferOne("foo@bar.com")).toEqual(email())
  })

  test("uri", () => {
    expect(inferOne("https://example.com/path")).toEqual(uri())
  })

  test("detectStringFormats: false keeps plain string", () => {
    expect(inferOne("2026-07-18", { detectStringFormats: false })).toEqual(t(types.string))
  })
})

describe("empty containers", () => {
  test("empty array widens to Array<unknown>", () => {
    expect(inferOne([])).toEqual(t(types.array(t(types.unknown))))
  })

  test("empty object widens to a fieldless object", () => {
    expect(inferOne({})).toEqual(t(types.object({})))
  })
})

describe("arrays vs tuples", () => {
  test("homogeneous array at/above threshold -> array", () => {
    expect(inferOne([1, 2, 3])).toEqual(t(types.array(uint8())))
  })

  test("homogeneous array below threshold -> tuple (not enough samples to be confident)", () => {
    expect(inferOne([1, 2])).toEqual(t(types.tuple([uint8(), uint8()])))
  })

  test("heterogeneous array -> tuple", () => {
    expect(inferOne([1, "a", true])).toEqual(t(types.tuple([uint8(), t(types.string), t(types.boolean)])))
  })

  test("custom arrayThreshold", () => {
    expect(inferOne([1, 2], { arrayThreshold: 2 })).toEqual(t(types.array(uint8())))
  })
})

describe("objects", () => {
  test("non-empty object infers each field recursively", () => {
    expect(inferOne({ name: "Ada", age: 30 })).toEqual(
      t(types.object({ name: t(types.string), age: uint8() })),
    )
  })

  test("nested object", () => {
    expect(inferOne({ user: { id: 1 } })).toEqual(t(types.object({ user: t(types.object({ id: uint8() })) })))
  })
})

describe("array of objects: shape merging", () => {
  test("shared fields across all elements are required", () => {
    const value = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ]
    expect(inferOne(value)).toEqual(t(types.array(t(types.object({ id: uint8(), name: t(types.string) })))))
  })

  test("field present in only some elements is optional", () => {
    const value = [
      { id: 1, name: "a" },
      { id: 2, name: "b", nickname: "bee" },
      { id: 3, name: "c" },
    ]
    expect(inferOne(value)).toEqual(
      t(
        types.array(
          t(
            types.object({
              id: uint8(),
              name: t(types.string),
              nickname: t(types.string, { optional: true }),
            }),
          ),
        ),
      ),
    )
  })

  test("conflicting field type across elements becomes a union", () => {
    const value = [{ id: 1 }, { id: "two" }, { id: 3 }]
    expect(inferOne(value)).toEqual(t(types.array(t(types.object({ id: t(types.union([uint8(), t(types.string)])) })))))
  })

  test("array of objects below threshold stays a tuple of raw element types", () => {
    const value = [{ id: 1 }, { id: 2 }]
    expect(inferOne(value)).toEqual(t(types.tuple([t(types.object({ id: uint8() })), t(types.object({ id: uint8() }))])))
  })
})

describe("custom leaf heuristics", () => {
  test("a heuristic can override default inference", () => {
    const moneyHeuristic: LeafHeuristic = (value) =>
      typeof value === "number" ? t(types.number, { semantic: "money" }) : undefined
    expect(inferOne(42, { leafHeuristics: [moneyHeuristic] })).toEqual(t(types.number, { semantic: "money" }))
  })

  test("a heuristic returning undefined falls through to defaults", () => {
    const noop: LeafHeuristic = () => undefined
    expect(inferOne(42, { leafHeuristics: [noop] })).toEqual(uint8())
  })

  test("heuristics apply recursively inside containers", () => {
    const moneyHeuristic: LeafHeuristic = (value) =>
      typeof value === "number" ? t(types.number, { semantic: "money" }) : undefined
    expect(inferOne({ price: 9.99 }, { leafHeuristics: [moneyHeuristic] })).toEqual(
      t(types.object({ price: t(types.number, { semantic: "money" }) })),
    )
  })
})

// ---------------------------------------------------------------------------
// Nominal class identity on runtime values
//
// Inference normally sees JSON-parsed data, where every object's prototype is
// `Object.prototype` and none of this fires. It matters on the one path that
// feeds inference values that did NOT come from `JSON.parse` —
// `from-standard-schema.ts`'s `~standard.types.output` sample, whose output
// type need not be JSON-safe (`z.instanceof(Date)` produces a live Date).
// ---------------------------------------------------------------------------

class Money {
  constructor(public cents = 5) {}
}
class Behaviour {
  greet(): string { return "hi" }
}

describe("class identity", () => {
  test("a data-less instance becomes nominal rather than an empty object", () => {
    expect(inferOne(new Date())).toEqual(t(types.instance("Date", "")))
    expect(inferOne(new Map([["a", 1]]))).toEqual(t(types.instance("Map", "")))
    expect(inferOne(new Set([1]))).toEqual(t(types.instance("Set", "")))
    expect(inferOne(new Behaviour())).toEqual(t(types.instance("Behaviour", "")))
  })

  test("an instance carrying data keeps its structure and records identity", () => {
    // `instance` is nominal-only by design, so returning it here would discard
    // fields we can actually see. Structure is kept; the name rides in meta.
    const out = inferOne(new Money(5))
    expect(out.shape).toEqual({ kind: "object", fields: { cents: uint8() } })
    expect(out.meta?.className).toBe("Money")
  })

  test("plain objects are untouched", () => {
    expect(inferOne({})).toEqual(t(types.object({})))
    const out = inferOne({ a: 1 })
    expect(out.shape.kind).toBe("object")
    expect(out.meta?.className).toBeUndefined()
  })

  test("a JSON `constructor` key does not fake an instance", () => {
    // `{"constructor":{"name":"Date"}}` is valid JSON, and reading
    // `value.constructor.name` would report "Date" for it. Identity is read
    // off the prototype instead, which JSON.parse never sets.
    const evil = JSON.parse('{"constructor":{"name":"Date"}}') as unknown
    const out = inferOne(evil)
    expect(out.shape.kind).toBe("object")
    expect(out.shape.kind).not.toBe("instance")
  })

  test("a JSON `__proto__` key does not fake an instance either", () => {
    const out = inferOne(JSON.parse('{"__proto__":{"x":1}}') as unknown)
    expect(out.shape.kind).not.toBe("instance")
  })

  test("null-prototype objects have no identity to report", () => {
    expect(inferOne(Object.create(null))).toEqual(t(types.object({})))
  })

  test("detectClassInstances: false restores the structural reading", () => {
    expect(inferOne(new Date(), { detectClassInstances: false })).toEqual(t(types.object({})))
    expect(inferOne(new Money(5), { detectClassInstances: false }).meta?.className).toBeUndefined()
  })

  test("arrays are unaffected", () => {
    expect(inferOne([1, 2, 3]).shape.kind).toBe("array")
  })
})
