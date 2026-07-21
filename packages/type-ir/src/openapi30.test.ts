import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toOpenApi30 } from "./openapi30.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toOpenApi30(t(types.boolean))).toEqual({ type: "boolean" })
  })

  test("number", () => {
    expect(toOpenApi30(t(types.number))).toEqual({ type: "number" })
  })

  test("integer", () => {
    expect(toOpenApi30(t(types.integer))).toEqual({ type: "integer" })
  })

  test("string", () => {
    expect(toOpenApi30(t(types.string))).toEqual({ type: "string" })
  })

  test("bytes uses format byte, not contentEncoding", () => {
    expect(toOpenApi30(bytes())).toEqual({ type: "string", format: "byte" })
  })

  test("null uses nullable keyword, no type: null", () => {
    expect(toOpenApi30(t(types.null))).toEqual({ nullable: true })
  })

  test("void", () => {
    expect(toOpenApi30(t(types.void))).toEqual({ nullable: true })
  })

  test("unknown", () => {
    expect(toOpenApi30(t(types.unknown))).toEqual({})
  })

  test("never", () => {
    expect(toOpenApi30(t(types.never))).toEqual({ not: {} })
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toOpenApi30(int32())).toEqual({ type: "integer", format: "int32" })
  })

  test("int64", () => {
    expect(toOpenApi30(int64())).toEqual({ type: "integer", format: "int64" })
  })

  test("float32", () => {
    expect(toOpenApi30(float32())).toEqual({ type: "number", format: "float" })
  })

  test("float64", () => {
    expect(toOpenApi30(float64())).toEqual({ type: "number", format: "double" })
  })

  test("uuid", () => {
    expect(toOpenApi30(uuid())).toEqual({ type: "string", format: "uuid" })
  })

  test("uri", () => {
    expect(toOpenApi30(uri())).toEqual({ type: "string", format: "uri" })
  })

  test("email", () => {
    expect(toOpenApi30(email())).toEqual({ type: "string", format: "email" })
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toOpenApi30(datetime())).toEqual({ type: "string", format: "date-time" })
  })

  test("date", () => {
    expect(toOpenApi30(date())).toEqual({ type: "string", format: "date" })
  })

  test("time", () => {
    expect(toOpenApi30(time())).toEqual({ type: "string", format: "time" })
  })

  test("duration has no standard format", () => {
    expect(toOpenApi30(duration())).toEqual({ type: "string" })
  })
})

describe("object", () => {
  test("required and optional fields", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toOpenApi30(ref)).toEqual({
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
    expect(toOpenApi30(ref)).toEqual({
      type: "object",
      properties: { nickname: { type: "string" } },
    })
  })

  test("readonly field emits readOnly: true", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toOpenApi30(ref)).toEqual({
      type: "object",
      properties: { id: { type: "string", readOnly: true } },
      required: ["id"],
    })
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toOpenApi30(ref)).toEqual({ type: "array", items: { type: "integer" } })
  })
})

describe("tuple", () => {
  test("items array form, not prefixItems", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toOpenApi30(ref)).toEqual({
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
    })
  })
})

describe("map", () => {
  test("additionalProperties", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toOpenApi30(ref)).toEqual({ type: "object", additionalProperties: { type: "number" } })
  })
})

describe("union", () => {
  test("anyOf", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toOpenApi30(ref)).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] })
  })

  test("discriminated union: oneOf + native OAS 3.0 discriminator.propertyName", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })
    expect(toOpenApi30(ref)).toEqual({
      oneOf: [
        { type: "object", properties: { type: { enum: ["circle"] }, radius: { type: "number" } }, required: ["type", "radius"] },
        { type: "object", properties: { type: { enum: ["square"] }, side: { type: "number" } }, required: ["type", "side"] },
      ],
      discriminator: { propertyName: "type" },
    })
  })
})

describe("literal", () => {
  test("single-element enum, not const", () => {
    expect(toOpenApi30(t(types.literal("active")))).toEqual({ enum: ["active"] })
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toOpenApi30(ref)).toEqual({ type: "string", enum: ["a", "b", "c"] })
  })
})

describe("ref", () => {
  test("$ref uses #/components/schemas/, not #/$defs/", () => {
    expect(toOpenApi30(t(types.ref("User")))).toEqual({ $ref: "#/components/schemas/User" })
  })
})

describe("nullable", () => {
  test("leaf uses nullable keyword, not type array", () => {
    const ref = t(types.string, { nullable: true })
    expect(toOpenApi30(ref)).toEqual({ type: "string", nullable: true })
  })

  test("complex type also uses nullable keyword, not anyOf wrapper", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toOpenApi30(ref)).toEqual({
      type: "array",
      items: { type: "string" },
      nullable: true,
    })
  })
})

describe("metadata passthrough", () => {
  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toOpenApi30(ref)).toEqual({ type: "string", description: "a name" })
  })

  test("deprecated", () => {
    const ref = t(types.string, { deprecated: true })
    expect(toOpenApi30(ref)).toEqual({ type: "string", deprecated: true })
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toOpenApi30(ref)).toEqual({ type: "integer", default: 0 })
  })

  test("example (singular, not examples)", () => {
    const ref = t(types.string, { example: "jane" })
    expect(toOpenApi30(ref)).toEqual({ type: "string", example: "jane" })
  })

  test("constraints", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toOpenApi30(ref)).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
      pattern: "^[a-z]+$",
    })
  })

  test("numeric constraints", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toOpenApi30(ref)).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      multipleOf: 5,
    })
  })

  test("exclusiveMinimum / exclusiveMaximum (draft-05 boolean-modifier form)", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toOpenApi30(ref)).toEqual({
      type: "integer",
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 100,
      exclusiveMaximum: true,
    })
  })

  test("readOnly / writeOnly", () => {
    expect(toOpenApi30(t(types.string, { readOnly: true }))).toEqual({ type: "string", readOnly: true })
    expect(toOpenApi30(t(types.string, { writeOnly: true }))).toEqual({ type: "string", writeOnly: true })
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toOpenApi30(ref)).toEqual({ type: "integer" })
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toOpenApi30(ref)).toEqual({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string", format: "uuid" } },
      },
      required: ["ids"],
    })
  })
})

describe("function", () => {
  test("degrades to a vendor-extension x-function marker (no callable-type concept)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toOpenApi30(ref)).toEqual({ "x-function": true })
  })
})

describe("stream", () => {
  test("degrades to an array carrying x-stream: true (no native streaming vocabulary)", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toOpenApi30(ref)).toEqual({ type: "array", items: { type: "integer" }, "x-stream": true })
  })
})
