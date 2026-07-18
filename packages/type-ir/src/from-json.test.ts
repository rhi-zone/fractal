import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { date, datetime, int8, int16, int32, int64, uint8, uint16, uint32, uint64, uri, uuid } from "./kinds/common.ts"
import { fromJson, type LeafHeuristic } from "./from-json.ts"

describe("leaf types", () => {
  test("null", () => {
    expect(fromJson(null)).toEqual(t(types.null))
  })

  test("booleans collapse to boolean, never literal", () => {
    expect(fromJson(true)).toEqual(t(types.boolean))
    expect(fromJson(false)).toEqual(t(types.boolean))
  })

  test("small non-negative integer narrows to uint8", () => {
    expect(fromJson(42)).toEqual(uint8())
  })

  test("fractional number stays number", () => {
    expect(fromJson(3.14)).toEqual(t(types.number))
  })

  test("large positive integer beyond uint32 range narrows to uint64", () => {
    expect(fromJson(5_000_000_000)).toEqual(uint64())
  })

  test("large negative integer beyond int32 range narrows to int64", () => {
    expect(fromJson(-5_000_000_000)).toEqual(int64())
  })

  test("narrowIntegerWidth: false keeps plain integer", () => {
    expect(fromJson(42, { narrowIntegerWidth: false })).toEqual(t(types.integer))
  })

  test("plain string", () => {
    expect(fromJson("hello")).toEqual(t(types.string))
  })
})

describe("integer width narrowing", () => {
  test("0 -> uint8 (non-negative, fits [0,255])", () => {
    expect(fromJson(0)).toEqual(uint8())
  })

  test("127 -> uint8 (non-negative, fits [0,255] before int8 [-128,127])", () => {
    expect(fromJson(127)).toEqual(uint8())
  })

  test("128 -> uint8 (fits [0,255])", () => {
    expect(fromJson(128)).toEqual(uint8())
  })

  test("255 -> uint8 (upper bound of [0,255])", () => {
    expect(fromJson(255)).toEqual(uint8())
  })

  test("256 -> uint16 (exceeds uint8, fits [0,65535])", () => {
    expect(fromJson(256)).toEqual(uint16())
  })

  test("-1 -> int8 (negative, fits [-128,127])", () => {
    expect(fromJson(-1)).toEqual(int8())
  })

  test("-128 -> int8 (lower bound of [-128,127])", () => {
    expect(fromJson(-128)).toEqual(int8())
  })

  test("-129 -> int16 (exceeds int8, fits [-32768,32767])", () => {
    expect(fromJson(-129)).toEqual(int16())
  })

  test("32767 -> uint16 (non-negative, fits [0,65535] before int16 [-32768,32767])", () => {
    expect(fromJson(32767)).toEqual(uint16())
  })

  test("-32768 -> int16 (lower bound of [-32768,32767])", () => {
    expect(fromJson(-32768)).toEqual(int16())
  })

  test("-32769 -> int32 (exceeds int16, negative so skips uint32, fits [-2147483648,2147483647])", () => {
    expect(fromJson(-32769)).toEqual(int32())
  })

  test("65535 -> uint16 (upper bound of [0,65535])", () => {
    expect(fromJson(65535)).toEqual(uint16())
  })

  test("65536 -> uint32 (exceeds uint16, fits [0,4294967295])", () => {
    expect(fromJson(65536)).toEqual(uint32())
  })

  test("4294967295 -> uint32 (upper bound of [0,4294967295])", () => {
    expect(fromJson(4294967295)).toEqual(uint32())
  })

  test("4294967296 -> uint64 (exceeds uint32, non-negative)", () => {
    expect(fromJson(4294967296)).toEqual(uint64())
  })

  test("2147483647 -> uint32 (non-negative, fits [0,4294967295] before int32)", () => {
    expect(fromJson(2147483647)).toEqual(uint32())
  })

  test("-2147483648 -> int32 (lower bound of int32)", () => {
    expect(fromJson(-2147483648)).toEqual(int32())
  })

  test("-2147483649 -> int64 (exceeds int32, negative)", () => {
    expect(fromJson(-2147483649)).toEqual(int64())
  })
})

describe("string format detection", () => {
  test("ISO date", () => {
    expect(fromJson("2026-07-18")).toEqual(date())
  })

  test("ISO datetime", () => {
    expect(fromJson("2026-07-18T12:34:56Z")).toEqual(datetime())
  })

  test("uuid", () => {
    expect(fromJson("123e4567-e89b-12d3-a456-426614174000")).toEqual(uuid())
  })

  test("email falls back to string + meta.format", () => {
    expect(fromJson("foo@bar.com")).toEqual(t(types.string, { format: "email" }))
  })

  test("uri", () => {
    expect(fromJson("https://example.com/path")).toEqual(uri())
  })

  test("detectStringFormats: false keeps plain string", () => {
    expect(fromJson("2026-07-18", { detectStringFormats: false })).toEqual(t(types.string))
  })
})

describe("empty containers", () => {
  test("empty array widens to Array<unknown>", () => {
    expect(fromJson([])).toEqual(t(types.array(t(types.unknown))))
  })

  test("empty object widens to a fieldless object", () => {
    expect(fromJson({})).toEqual(t(types.object({})))
  })
})

describe("arrays vs tuples", () => {
  test("homogeneous array at/above threshold -> array", () => {
    expect(fromJson([1, 2, 3])).toEqual(t(types.array(uint8())))
  })

  test("homogeneous array below threshold -> tuple (not enough samples to be confident)", () => {
    expect(fromJson([1, 2])).toEqual(t(types.tuple([uint8(), uint8()])))
  })

  test("heterogeneous array -> tuple", () => {
    expect(fromJson([1, "a", true])).toEqual(t(types.tuple([uint8(), t(types.string), t(types.boolean)])))
  })

  test("custom arrayThreshold", () => {
    expect(fromJson([1, 2], { arrayThreshold: 2 })).toEqual(t(types.array(uint8())))
  })
})

describe("objects", () => {
  test("non-empty object infers each field recursively", () => {
    expect(fromJson({ name: "Ada", age: 30 })).toEqual(
      t(types.object({ name: t(types.string), age: uint8() })),
    )
  })

  test("nested object", () => {
    expect(fromJson({ user: { id: 1 } })).toEqual(t(types.object({ user: t(types.object({ id: uint8() })) })))
  })
})

describe("array of objects: shape merging", () => {
  test("shared fields across all elements are required", () => {
    const value = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ]
    expect(fromJson(value)).toEqual(t(types.array(t(types.object({ id: uint8(), name: t(types.string) })))))
  })

  test("field present in only some elements is optional", () => {
    const value = [
      { id: 1, name: "a" },
      { id: 2, name: "b", nickname: "bee" },
      { id: 3, name: "c" },
    ]
    expect(fromJson(value)).toEqual(
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
    expect(fromJson(value)).toEqual(t(types.array(t(types.object({ id: t(types.union([uint8(), t(types.string)])) })))))
  })

  test("array of objects below threshold stays a tuple of raw element types", () => {
    const value = [{ id: 1 }, { id: 2 }]
    expect(fromJson(value)).toEqual(t(types.tuple([t(types.object({ id: uint8() })), t(types.object({ id: uint8() }))])))
  })
})

describe("custom leaf heuristics", () => {
  test("a heuristic can override default inference", () => {
    const moneyHeuristic: LeafHeuristic = (value) =>
      typeof value === "number" ? t(types.number, { semantic: "money" }) : undefined
    expect(fromJson(42, { leafHeuristics: [moneyHeuristic] })).toEqual(t(types.number, { semantic: "money" }))
  })

  test("a heuristic returning undefined falls through to defaults", () => {
    const noop: LeafHeuristic = () => undefined
    expect(fromJson(42, { leafHeuristics: [noop] })).toEqual(uint8())
  })

  test("heuristics apply recursively inside containers", () => {
    const moneyHeuristic: LeafHeuristic = (value) =>
      typeof value === "number" ? t(types.number, { semantic: "money" }) : undefined
    expect(fromJson({ price: 9.99 }, { leafHeuristics: [moneyHeuristic] })).toEqual(
      t(types.object({ price: t(types.number, { semantic: "money" }) })),
    )
  })
})
