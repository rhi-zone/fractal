import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toJsonSchema04, toJsonSchema04Document } from "./json-schema-04.ts"

describe("draft-04 differences", () => {
  test("literal uses single-member enum, not const", () => {
    expect(toJsonSchema04(t(types.literal("active")))).toEqual({ enum: ["active"] })
  })

  test("literal number", () => {
    expect(toJsonSchema04(t(types.literal(42)))).toEqual({ enum: [42] })
  })

  test("literal boolean", () => {
    expect(toJsonSchema04(t(types.literal(true)))).toEqual({ enum: [true] })
  })

  test("literal null", () => {
    expect(toJsonSchema04(t(types.literal(null)))).toEqual({ enum: [null] })
  })

  test("tuple uses items array + additionalItems", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toJsonSchema04(ref)).toEqual({
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: false,
    })
  })

  test("ref targets #/definitions/", () => {
    expect(toJsonSchema04(t(types.ref("User")))).toEqual({ $ref: "#/definitions/User" })
  })

  test("never has no boolean schema — uses not: {}", () => {
    expect(toJsonSchema04(t(types.never))).toEqual({ not: {} })
  })

  test("nullable leaf uses anyOf, not type array", () => {
    const ref = t(types.string, { nullable: true })
    expect(toJsonSchema04(ref)).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  test("nullable complex type uses anyOf", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toJsonSchema04(ref)).toEqual({
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    })
  })

  test("exclusiveMinimum is a boolean modifier on minimum", () => {
    const ref = t(types.number, { exclusiveMinimum: 0 })
    expect(toJsonSchema04(ref)).toEqual({ type: "number", minimum: 0, exclusiveMinimum: true })
  })

  test("exclusiveMaximum is a boolean modifier on maximum", () => {
    const ref = t(types.number, { exclusiveMaximum: 100 })
    expect(toJsonSchema04(ref)).toEqual({ type: "number", maximum: 100, exclusiveMaximum: true })
  })

  test("plain minimum/maximum pass through without exclusive flags", () => {
    const ref = t(types.number, { minimum: 0, maximum: 100 })
    expect(toJsonSchema04(ref)).toEqual({ type: "number", minimum: 0, maximum: 100 })
  })

  test("both bounds exclusive at once", () => {
    const ref = t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toJsonSchema04(ref)).toEqual({
      type: "number",
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 100,
      exclusiveMaximum: true,
    })
  })
})

describe("shared: leaf types", () => {
  test("boolean", () => {
    expect(toJsonSchema04(t(types.boolean))).toEqual({ type: "boolean" })
  })

  test("number", () => {
    expect(toJsonSchema04(t(types.number))).toEqual({ type: "number" })
  })

  test("integer", () => {
    expect(toJsonSchema04(t(types.integer))).toEqual({ type: "integer" })
  })

  test("string", () => {
    expect(toJsonSchema04(t(types.string))).toEqual({ type: "string" })
  })

  test("bytes", () => {
    expect(toJsonSchema04(bytes())).toEqual({ type: "string", contentEncoding: "base64" })
  })

  test("null", () => {
    expect(toJsonSchema04(t(types.null))).toEqual({ type: "null" })
  })

  test("void", () => {
    expect(toJsonSchema04(t(types.void))).toEqual({ type: "null" })
  })

  test("unknown", () => {
    expect(toJsonSchema04(t(types.unknown))).toEqual({})
  })
})

describe("shared: formatted types", () => {
  test("int32", () => {
    expect(toJsonSchema04(int32())).toEqual({ type: "integer", format: "int32" })
  })

  test("int64", () => {
    expect(toJsonSchema04(int64())).toEqual({ type: "integer", format: "int64" })
  })

  test("float32", () => {
    expect(toJsonSchema04(float32())).toEqual({ type: "number", format: "float" })
  })

  test("float64", () => {
    expect(toJsonSchema04(float64())).toEqual({ type: "number", format: "double" })
  })

  test("uuid", () => {
    expect(toJsonSchema04(uuid())).toEqual({ type: "string", format: "uuid" })
  })

  test("uri", () => {
    expect(toJsonSchema04(uri())).toEqual({ type: "string", format: "uri" })
  })

  test("email", () => {
    expect(toJsonSchema04(email())).toEqual({ type: "string", format: "email" })
  })
})

describe("shared: temporal types", () => {
  test("datetime", () => {
    expect(toJsonSchema04(datetime())).toEqual({ type: "string", format: "date-time" })
  })

  test("date", () => {
    expect(toJsonSchema04(date())).toEqual({ type: "string", format: "date" })
  })

  test("time", () => {
    expect(toJsonSchema04(time())).toEqual({ type: "string", format: "time" })
  })

  test("duration", () => {
    expect(toJsonSchema04(duration())).toEqual({ type: "string", format: "duration" })
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
    expect(toJsonSchema04(ref)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
    })
  })

  test("no required array when all optional", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toJsonSchema04(ref)).toEqual({
      type: "object",
      properties: { nickname: { type: "string" } },
    })
  })

  test("readonly field: no readOnly keyword — draft-04 predates it (introduced draft-07)", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toJsonSchema04(ref)).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    })
  })
})

describe("shared: array", () => {
  test("array of strings", () => {
    expect(toJsonSchema04(t(types.array(t(types.string))))).toEqual({
      type: "array",
      items: { type: "string" },
    })
  })
})

describe("shared: map", () => {
  test("map of string to number", () => {
    expect(toJsonSchema04(t(types.map(t(types.string), t(types.number))))).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    })
  })
})

describe("shared: union", () => {
  test("anyOf of variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJsonSchema04(ref)).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    })
  })

  test("discriminated union: oneOf + discriminator.propertyName, driven by meta.discriminator", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })
    expect(toJsonSchema04(ref)).toEqual({
      oneOf: [
        { type: "object", properties: { type: { enum: ["circle"] }, radius: { type: "number" } }, required: ["type", "radius"] },
        { type: "object", properties: { type: { enum: ["square"] }, side: { type: "number" } }, required: ["type", "side"] },
      ],
      discriminator: { propertyName: "type" },
    })
  })
})

describe("shared: enum", () => {
  test("enum of string members", () => {
    expect(toJsonSchema04(t(types.enum(["a", "b", "c"])))).toEqual({
      type: "string",
      enum: ["a", "b", "c"],
    })
  })
})

describe("shared: meta", () => {
  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toJsonSchema04(ref)).toEqual({ type: "string", description: "a name" })
  })

  test("deprecated", () => {
    const ref = t(types.string, { deprecated: true })
    expect(toJsonSchema04(ref)).toEqual({ type: "string", deprecated: true })
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toJsonSchema04(ref)).toEqual({ type: "integer", default: 0 })
  })

  test("string constraints: minLength, maxLength, pattern", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toJsonSchema04(ref)).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
      pattern: "^[a-z]+$",
    })
  })

  test("multipleOf", () => {
    const ref = t(types.number, { multipleOf: 5 })
    expect(toJsonSchema04(ref)).toEqual({ type: "number", multipleOf: 5 })
  })

  test("$comment is dropped (draft-07+ keyword, not part of draft-04)", () => {
    const ref = t(types.string, { $comment: "internal note" })
    const schema = toJsonSchema04(ref)
    expect(schema).toEqual({ type: "string" })
    expect(schema).not.toHaveProperty("$comment")
  })
})

describe("document wrapper", () => {
  test("adds $schema draft-04 identifier", () => {
    const doc = toJsonSchema04Document(t(types.string))
    expect(doc).toEqual({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "string",
    })
  })

  test("uses id not $id", () => {
    const doc = toJsonSchema04Document(t(types.string), { id: "http://example.com/schema" })
    expect(doc).toEqual({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "string",
      id: "http://example.com/schema",
    })
  })

  test("definitions map is projected", () => {
    const doc = toJsonSchema04Document(t(types.ref("User")), {
      definitions: {
        User: t(types.object({ id: uuid() })),
      },
    })
    expect(doc).toEqual({
      $schema: "http://json-schema.org/draft-04/schema#",
      $ref: "#/definitions/User",
      definitions: {
        User: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    })
  })
})

describe("function", () => {
  test("degrades to an untyped schema carrying x-function (no callable-type vocabulary)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toJsonSchema04(ref)).toEqual({ "x-function": true })
  })
})

describe("stream", () => {
  test("degrades to an array carrying x-stream: true (no native streaming vocabulary)", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toJsonSchema04(ref)).toEqual({ type: "array", items: { type: "integer" }, "x-stream": true })
  })
})
