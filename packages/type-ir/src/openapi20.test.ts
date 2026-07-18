import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toOpenApi20, toOpenApi20Definitions } from "./openapi20.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toOpenApi20(t(types.boolean))).toEqual({ type: "boolean" })
  })

  test("number", () => {
    expect(toOpenApi20(t(types.number))).toEqual({ type: "number" })
  })

  test("integer", () => {
    expect(toOpenApi20(t(types.integer))).toEqual({ type: "integer" })
  })

  test("string", () => {
    expect(toOpenApi20(t(types.string))).toEqual({ type: "string" })
  })

  test("bytes uses format byte", () => {
    expect(toOpenApi20(bytes())).toEqual({ type: "string", format: "byte" })
  })

  test("null uses x-nullable extension, no nullable keyword", () => {
    expect(toOpenApi20(t(types.null))).toEqual({ "x-nullable": true })
  })

  test("void", () => {
    expect(toOpenApi20(t(types.void))).toEqual({ "x-nullable": true })
  })

  test("unknown", () => {
    expect(toOpenApi20(t(types.unknown))).toEqual({})
  })

  test("never uses x-never extension, no not keyword", () => {
    const schema = toOpenApi20(t(types.never))
    expect(schema).toEqual({ "x-never": true })
    expect(schema).not.toHaveProperty("not")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toOpenApi20(int32())).toEqual({ type: "integer", format: "int32" })
  })

  test("int64", () => {
    expect(toOpenApi20(int64())).toEqual({ type: "integer", format: "int64" })
  })

  test("float32", () => {
    expect(toOpenApi20(float32())).toEqual({ type: "number", format: "float" })
  })

  test("float64", () => {
    expect(toOpenApi20(float64())).toEqual({ type: "number", format: "double" })
  })

  test("uuid", () => {
    expect(toOpenApi20(uuid())).toEqual({ type: "string", format: "uuid" })
  })

  test("uri", () => {
    expect(toOpenApi20(uri())).toEqual({ type: "string", format: "uri" })
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toOpenApi20(datetime())).toEqual({ type: "string", format: "date-time" })
  })

  test("date", () => {
    expect(toOpenApi20(date())).toEqual({ type: "string", format: "date" })
  })

  test("time", () => {
    expect(toOpenApi20(time())).toEqual({ type: "string", format: "time" })
  })

  test("duration has no standard format", () => {
    expect(toOpenApi20(duration())).toEqual({ type: "string" })
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
    expect(toOpenApi20(ref)).toEqual({
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
    expect(toOpenApi20(ref)).toEqual({
      type: "object",
      properties: { nickname: { type: "string" } },
    })
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toOpenApi20(ref)).toEqual({ type: "array", items: { type: "integer" } })
  })

  test("items is always present (required per spec, unlike a bare array type)", () => {
    const ref = t(types.array(t(types.string)))
    const schema = toOpenApi20(ref)
    expect(schema).toHaveProperty("items")
  })
})

describe("tuple", () => {
  test("homogeneous tuple uses the common element schema as items (lossy but accurate)", () => {
    const ref = t(types.tuple([t(types.string), t(types.string)]))
    expect(toOpenApi20(ref)).toEqual({ type: "array", items: { type: "string" } })
  })

  test("heterogeneous tuple falls back to empty schema items (fully lossy)", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toOpenApi20(ref)).toEqual({ type: "array", items: {} })
  })

  test("no prefixItems, no array-form items", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    const schema = toOpenApi20(ref)
    expect(schema).not.toHaveProperty("prefixItems")
    expect(Array.isArray(schema.items)).toBe(false)
  })
})

describe("map", () => {
  test("additionalProperties", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toOpenApi20(ref)).toEqual({ type: "object", additionalProperties: { type: "number" } })
  })
})

describe("union", () => {
  test("empty schema with x-oneOf extension, no oneOf/anyOf keyword", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    const schema = toOpenApi20(ref)
    expect(schema).toEqual({
      "x-oneOf": [{ type: "string" }, { type: "integer" }],
    })
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema).not.toHaveProperty("anyOf")
  })
})

describe("union with discriminator", () => {
  test("discriminator is a string, not a { propertyName } object", () => {
    const ref = t(types.union([t(types.object({ kind: t(types.literal("a")) }))]), { discriminator: "kind" })
    const schema = toOpenApi20(ref)
    expect(schema.discriminator).toBe("kind")
  })
})

describe("literal", () => {
  test("single-element enum, not const", () => {
    expect(toOpenApi20(t(types.literal("active")))).toEqual({ enum: ["active"] })
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toOpenApi20(ref)).toEqual({ type: "string", enum: ["a", "b", "c"] })
  })
})

describe("ref", () => {
  test("$ref uses #/definitions/, not #/components/schemas/", () => {
    expect(toOpenApi20(t(types.ref("User")))).toEqual({ $ref: "#/definitions/User" })
  })
})

describe("definitions map", () => {
  test("builds a definitions object keyed by name", () => {
    const defs = toOpenApi20Definitions({
      User: t(types.object({ id: uuid() })),
      Status: t(types.enum(["active", "inactive"])),
    })
    expect(defs).toEqual({
      User: {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
        required: ["id"],
      },
      Status: { type: "string", enum: ["active", "inactive"] },
    })
  })
})

describe("nullable", () => {
  test("leaf uses x-nullable extension, not nullable keyword", () => {
    const ref = t(types.string, { nullable: true })
    expect(toOpenApi20(ref)).toEqual({ type: "string", "x-nullable": true })
  })

  test("complex type also uses x-nullable extension, not anyOf/type-array wrapper", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toOpenApi20(ref)).toEqual({
      type: "array",
      items: { type: "string" },
      "x-nullable": true,
    })
  })
})

describe("metadata passthrough", () => {
  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toOpenApi20(ref)).toEqual({ type: "string", description: "a name" })
  })

  test("deprecated uses x-deprecated extension, not deprecated keyword", () => {
    const ref = t(types.string, { deprecated: true })
    const schema = toOpenApi20(ref)
    expect(schema).toEqual({ type: "string", "x-deprecated": true })
    expect(schema).not.toHaveProperty("deprecated")
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toOpenApi20(ref)).toEqual({ type: "integer", default: 0 })
  })

  test("example (singular, not examples)", () => {
    const ref = t(types.string, { example: "jane" })
    const schema = toOpenApi20(ref)
    expect(schema).toEqual({ type: "string", example: "jane" })
    expect(schema).not.toHaveProperty("examples")
  })

  test("readOnly passes through", () => {
    const ref = t(types.string, { readOnly: true })
    expect(toOpenApi20(ref)).toEqual({ type: "string", readOnly: true })
  })

  test("writeOnly is dropped (no Swagger 2.0 equivalent)", () => {
    const ref = t(types.string, { writeOnly: true })
    const schema = toOpenApi20(ref)
    expect(schema).not.toHaveProperty("writeOnly")
    expect(schema).not.toHaveProperty("x-writeOnly")
  })

  test("constraints", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toOpenApi20(ref)).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
      pattern: "^[a-z]+$",
    })
  })

  test("numeric constraints", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toOpenApi20(ref)).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      multipleOf: 5,
    })
  })

  test("$comment is dropped (not part of draft-04)", () => {
    const ref = t(types.string, { $comment: "internal note" })
    expect(toOpenApi20(ref)).toEqual({ type: "string" })
  })

  test("exclusiveMinimum / exclusiveMaximum (draft-04 boolean-modifier form)", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toOpenApi20(ref)).toEqual({
      type: "integer",
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 100,
      exclusiveMaximum: true,
    })
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toOpenApi20(ref)).toEqual({ type: "integer" })
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toOpenApi20(ref)).toEqual({
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
    expect(toOpenApi20(ref)).toEqual({ "x-function": true })
  })
})
