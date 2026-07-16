import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { toJsonSchema } from "./json-schema.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toJsonSchema(t(types.boolean))).toEqual({ type: "boolean" })
  })

  test("number", () => {
    expect(toJsonSchema(t(types.number))).toEqual({ type: "number" })
  })

  test("integer", () => {
    expect(toJsonSchema(t(types.integer))).toEqual({ type: "integer" })
  })

  test("string", () => {
    expect(toJsonSchema(t(types.string))).toEqual({ type: "string" })
  })

  test("bytes", () => {
    expect(toJsonSchema(t(types.bytes))).toEqual({ type: "string", contentEncoding: "base64" })
  })

  test("null", () => {
    expect(toJsonSchema(t(types.null))).toEqual({ type: "null" })
  })

  test("void", () => {
    expect(toJsonSchema(t(types.void))).toEqual({ type: "null" })
  })

  test("unknown", () => {
    expect(toJsonSchema(t(types.unknown))).toEqual({})
  })

  test("never", () => {
    expect(toJsonSchema(t(types.never))).toEqual({ not: {} })
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toJsonSchema(t(types.int32))).toEqual({ type: "integer", format: "int32" })
  })

  test("int64", () => {
    expect(toJsonSchema(t(types.int64))).toEqual({ type: "integer", format: "int64" })
  })

  test("float32", () => {
    expect(toJsonSchema(t(types.float32))).toEqual({ type: "number", format: "float" })
  })

  test("float64", () => {
    expect(toJsonSchema(t(types.float64))).toEqual({ type: "number", format: "double" })
  })

  test("uuid", () => {
    expect(toJsonSchema(t(types.uuid))).toEqual({ type: "string", format: "uuid" })
  })

  test("uri", () => {
    expect(toJsonSchema(t(types.uri))).toEqual({ type: "string", format: "uri" })
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toJsonSchema(t(types.datetime))).toEqual({ type: "string", format: "date-time" })
  })

  test("date", () => {
    expect(toJsonSchema(t(types.date))).toEqual({ type: "string", format: "date" })
  })

  test("time", () => {
    expect(toJsonSchema(t(types.time))).toEqual({ type: "string", format: "time" })
  })

  test("duration", () => {
    expect(toJsonSchema(t(types.duration))).toEqual({ type: "string", format: "duration" })
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
    expect(toJsonSchema(ref)).toEqual({
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
    expect(toJsonSchema(ref)).toEqual({
      type: "object",
      properties: { nickname: { type: "string" } },
    })
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toJsonSchema(ref)).toEqual({ type: "array", items: { type: "integer" } })
  })
})

describe("tuple", () => {
  test("prefixItems", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toJsonSchema(ref)).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
    })
  })
})

describe("map", () => {
  test("additionalProperties", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toJsonSchema(ref)).toEqual({ type: "object", additionalProperties: { type: "number" } })
  })
})

describe("union", () => {
  test("anyOf", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJsonSchema(ref)).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] })
  })
})

describe("literal", () => {
  test("const", () => {
    expect(toJsonSchema(t(types.literal("active")))).toEqual({ const: "active" })
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toJsonSchema(ref)).toEqual({ type: "string", enum: ["a", "b", "c"] })
  })
})

describe("ref", () => {
  test("$ref", () => {
    expect(toJsonSchema(t(types.ref("User")))).toEqual({ $ref: "#/$defs/User" })
  })
})

describe("nullable", () => {
  test("leaf uses type array form", () => {
    const ref = t(types.string, { nullable: true })
    expect(toJsonSchema(ref)).toEqual({ type: ["string", "null"] })
  })

  test("complex type uses anyOf wrapper", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toJsonSchema(ref)).toEqual({
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    })
  })
})

describe("metadata passthrough", () => {
  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toJsonSchema(ref)).toEqual({ type: "string", description: "a name" })
  })

  test("deprecated", () => {
    const ref = t(types.string, { deprecated: true })
    expect(toJsonSchema(ref)).toEqual({ type: "string", deprecated: true })
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toJsonSchema(ref)).toEqual({ type: "integer", default: 0 })
  })

  test("constraints", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toJsonSchema(ref)).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
      pattern: "^[a-z]+$",
    })
  })

  test("numeric constraints", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toJsonSchema(ref)).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      multipleOf: 5,
    })
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toJsonSchema(ref)).toEqual({ type: "integer" })
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(t(types.uuid))),
      }),
    )
    expect(toJsonSchema(ref)).toEqual({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string", format: "uuid" } },
      },
      required: ["ids"],
    })
  })
})

describe("unrecognized metadata (open metadata bag)", () => {
  test("meta.brand is silently ignored — projects to the base type", () => {
    expect(toJsonSchema(t(types.string, { brand: "LocationId" }))).toEqual({
      type: "string",
    })
  })
})
