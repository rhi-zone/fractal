import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { toJsonSchema07 } from "./json-schema-07.ts"

describe("draft-07 differences", () => {
  test("tuple uses items array + additionalItems", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toJsonSchema07(ref)).toEqual({
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: false,
    })
  })

  test("ref targets #/definitions/", () => {
    expect(toJsonSchema07(t(types.ref("User")))).toEqual({ $ref: "#/definitions/User" })
  })

  test("never is boolean false schema", () => {
    expect(toJsonSchema07(t(types.never))).toEqual(false as unknown as Record<string, unknown>)
  })
})

describe("shared: leaf types", () => {
  test("boolean", () => {
    expect(toJsonSchema07(t(types.boolean))).toEqual({ type: "boolean" })
  })

  test("string", () => {
    expect(toJsonSchema07(t(types.string))).toEqual({ type: "string" })
  })

  test("null", () => {
    expect(toJsonSchema07(t(types.null))).toEqual({ type: "null" })
  })

  test("unknown", () => {
    expect(toJsonSchema07(t(types.unknown))).toEqual({})
  })
})

describe("shared: formatted types", () => {
  test("uuid", () => {
    expect(toJsonSchema07(t(types.uuid))).toEqual({ type: "string", format: "uuid" })
  })

  test("int32", () => {
    expect(toJsonSchema07(t(types.int32))).toEqual({ type: "integer", format: "int32" })
  })
})

describe("shared: object", () => {
  test("required and optional fields", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toJsonSchema07(ref)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
    })
  })
})

describe("shared: array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toJsonSchema07(ref)).toEqual({ type: "array", items: { type: "integer" } })
  })
})

describe("shared: union", () => {
  test("anyOf", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJsonSchema07(ref)).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] })
  })
})

describe("shared: nullable", () => {
  test("leaf uses type array form", () => {
    const ref = t(types.string, { nullable: true })
    expect(toJsonSchema07(ref)).toEqual({ type: ["string", "null"] })
  })

  test("complex type uses anyOf wrapper", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toJsonSchema07(ref)).toEqual({
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    })
  })
})

describe("shared: metadata passthrough", () => {
  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toJsonSchema07(ref)).toEqual({ type: "string", description: "a name" })
  })

  test("constraints", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toJsonSchema07(ref)).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
      pattern: "^[a-z]+$",
    })
  })

  test("exclusiveMinimum / exclusiveMaximum (numeric form, since draft-06)", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toJsonSchema07(ref)).toEqual({
      type: "integer",
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
    })
  })

  test("examples", () => {
    const ref = t(types.string, { examples: ["a", "b"] })
    expect(toJsonSchema07(ref)).toEqual({ type: "string", examples: ["a", "b"] })
  })

  test("readOnly / writeOnly", () => {
    expect(toJsonSchema07(t(types.string, { readOnly: true }))).toEqual({ type: "string", readOnly: true })
    expect(toJsonSchema07(t(types.string, { writeOnly: true }))).toEqual({ type: "string", writeOnly: true })
  })
})
