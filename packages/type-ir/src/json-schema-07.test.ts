import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
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

  test("number", () => {
    expect(toJsonSchema07(t(types.number))).toEqual({ type: "number" })
  })

  test("integer", () => {
    expect(toJsonSchema07(t(types.integer))).toEqual({ type: "integer" })
  })

  test("string", () => {
    expect(toJsonSchema07(t(types.string))).toEqual({ type: "string" })
  })

  test("bytes", () => {
    expect(toJsonSchema07(bytes())).toEqual({ type: "string", contentEncoding: "base64" })
  })

  test("null", () => {
    expect(toJsonSchema07(t(types.null))).toEqual({ type: "null" })
  })

  test("void", () => {
    expect(toJsonSchema07(t(types.void))).toEqual({ type: "null" })
  })

  test("unknown", () => {
    expect(toJsonSchema07(t(types.unknown))).toEqual({})
  })
})

describe("shared: formatted types", () => {
  test("uuid", () => {
    expect(toJsonSchema07(uuid())).toEqual({ type: "string", format: "uuid" })
  })

  test("uri", () => {
    expect(toJsonSchema07(uri())).toEqual({ type: "string", format: "uri" })
  })

  test("int32", () => {
    expect(toJsonSchema07(int32())).toEqual({ type: "integer", format: "int32" })
  })

  test("int64", () => {
    expect(toJsonSchema07(int64())).toEqual({ type: "integer", format: "int64" })
  })

  test("float32", () => {
    expect(toJsonSchema07(float32())).toEqual({ type: "number", format: "float" })
  })

  test("float64", () => {
    expect(toJsonSchema07(float64())).toEqual({ type: "number", format: "double" })
  })
})

describe("shared: temporal types", () => {
  test("datetime", () => {
    expect(toJsonSchema07(datetime())).toEqual({ type: "string", format: "date-time" })
  })

  test("date", () => {
    expect(toJsonSchema07(date())).toEqual({ type: "string", format: "date" })
  })

  test("time", () => {
    expect(toJsonSchema07(time())).toEqual({ type: "string", format: "time" })
  })

  test("duration", () => {
    expect(toJsonSchema07(duration())).toEqual({ type: "string", format: "duration" })
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

  test("no required key when all fields optional", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toJsonSchema07(ref)).toEqual({
      type: "object",
      properties: { nickname: { type: "string" } },
    })
  })
})

describe("shared: array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toJsonSchema07(ref)).toEqual({ type: "array", items: { type: "integer" } })
  })
})

describe("shared: map", () => {
  test("additionalProperties", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toJsonSchema07(ref)).toEqual({ type: "object", additionalProperties: { type: "number" } })
  })
})

describe("shared: union", () => {
  test("anyOf", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJsonSchema07(ref)).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] })
  })

  test("discriminated union: oneOf + discriminator.propertyName, driven by meta.discriminator", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })
    expect(toJsonSchema07(ref)).toEqual({
      oneOf: [
        { type: "object", properties: { type: { const: "circle" }, radius: { type: "number" } }, required: ["type", "radius"] },
        { type: "object", properties: { type: { const: "square" }, side: { type: "number" } }, required: ["type", "side"] },
      ],
      discriminator: { propertyName: "type" },
    })
  })
})

describe("shared: intersection", () => {
  test("allOf", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toJsonSchema07(ref)).toEqual({
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { createdAt: { type: "string" } }, required: ["createdAt"] },
      ],
    })
  })

  test("three-way intersection preserves every member in allOf", () => {
    const ref = t(
      types.intersection([t(types.object({ a: t(types.string) })), t(types.string), t(types.number)]),
    )
    expect(toJsonSchema07(ref)).toEqual({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "string" },
        { type: "number" },
      ],
    })
  })
})

describe("shared: literal", () => {
  test("const", () => {
    expect(toJsonSchema07(t(types.literal("active")))).toEqual({ const: "active" })
  })
})

describe("shared: enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toJsonSchema07(ref)).toEqual({ type: "string", enum: ["a", "b", "c"] })
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

  test("deprecated", () => {
    const ref = t(types.string, { deprecated: true })
    expect(toJsonSchema07(ref)).toEqual({ type: "string", deprecated: true })
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toJsonSchema07(ref)).toEqual({ type: "integer", default: 0 })
  })

  test("$comment", () => {
    const ref = t(types.string, { $comment: "internal note" })
    expect(toJsonSchema07(ref)).toEqual({ type: "string", $comment: "internal note" })
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

  test("numeric constraints: minimum, maximum, multipleOf", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toJsonSchema07(ref)).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      multipleOf: 5,
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

describe("shared: unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toJsonSchema07(ref)).toEqual({ type: "integer" })
  })
})

describe("shared: nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toJsonSchema07(ref)).toEqual({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string", format: "uuid" } },
      },
      required: ["ids"],
    })
  })
})

describe("shared: unrecognized metadata (open metadata bag)", () => {
  test("meta.brand is silently ignored — projects to the base type", () => {
    expect(toJsonSchema07(t(types.string, { brand: "LocationId" }))).toEqual({
      type: "string",
    })
  })
})
