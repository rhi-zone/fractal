import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { date, datetime, int32, int64, uri, uuid } from "./kinds/common.ts"
import { fromJson, type LeafHeuristic } from "./from-json.ts"

describe("leaf types", () => {
  test("null", () => {
    expect(fromJson(null)).toEqual(t(types.null))
  })

  test("booleans collapse to boolean, never literal", () => {
    expect(fromJson(true)).toEqual(t(types.boolean))
    expect(fromJson(false)).toEqual(t(types.boolean))
  })

  test("whole number narrows to int32 by default", () => {
    expect(fromJson(42)).toEqual(int32())
  })

  test("fractional number stays number", () => {
    expect(fromJson(3.14)).toEqual(t(types.number))
  })

  test("integer beyond int32 range narrows to int64", () => {
    expect(fromJson(5_000_000_000)).toEqual(int64())
  })

  test("narrowIntegerWidth: false keeps plain integer", () => {
    expect(fromJson(42, { narrowIntegerWidth: false })).toEqual(t(types.integer))
  })

  test("plain string", () => {
    expect(fromJson("hello")).toEqual(t(types.string))
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
    expect(fromJson([1, 2, 3])).toEqual(t(types.array(int32())))
  })

  test("homogeneous array below threshold -> tuple (not enough samples to be confident)", () => {
    expect(fromJson([1, 2])).toEqual(t(types.tuple([int32(), int32()])))
  })

  test("heterogeneous array -> tuple", () => {
    expect(fromJson([1, "a", true])).toEqual(t(types.tuple([int32(), t(types.string), t(types.boolean)])))
  })

  test("custom arrayThreshold", () => {
    expect(fromJson([1, 2], { arrayThreshold: 2 })).toEqual(t(types.array(int32())))
  })
})

describe("objects", () => {
  test("non-empty object infers each field recursively", () => {
    expect(fromJson({ name: "Ada", age: 30 })).toEqual(
      t(types.object({ name: t(types.string), age: int32() })),
    )
  })

  test("nested object", () => {
    expect(fromJson({ user: { id: 1 } })).toEqual(t(types.object({ user: t(types.object({ id: int32() })) })))
  })
})

describe("array of objects: shape merging", () => {
  test("shared fields across all elements are required", () => {
    const value = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ]
    expect(fromJson(value)).toEqual(t(types.array(t(types.object({ id: int32(), name: t(types.string) })))))
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
              id: int32(),
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
    expect(fromJson(value)).toEqual(t(types.array(t(types.object({ id: t(types.union([int32(), t(types.string)])) })))))
  })

  test("array of objects below threshold stays a tuple of raw element types", () => {
    const value = [{ id: 1 }, { id: 2 }]
    expect(fromJson(value)).toEqual(t(types.tuple([t(types.object({ id: int32() })), t(types.object({ id: int32() }))])))
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
    expect(fromJson(42, { leafHeuristics: [noop] })).toEqual(int32())
  })

  test("heuristics apply recursively inside containers", () => {
    const moneyHeuristic: LeafHeuristic = (value) =>
      typeof value === "number" ? t(types.number, { semantic: "money" }) : undefined
    expect(fromJson({ price: 9.99 }, { leafHeuristics: [moneyHeuristic] })).toEqual(
      t(types.object({ price: t(types.number, { semantic: "money" }) })),
    )
  })
})
