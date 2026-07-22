import { describe, expect, test } from "bun:test"
import { registerParent, t, typeRefDocument, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toJsonSchema, toJsonSchemaDocument } from "./json-schema.ts"

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
    expect(toJsonSchema(bytes())).toEqual({ type: "string", contentEncoding: "base64" })
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
    expect(toJsonSchema(int32())).toEqual({ type: "integer", format: "int32" })
  })

  test("int64", () => {
    expect(toJsonSchema(int64())).toEqual({ type: "integer", format: "int64" })
  })

  test("float32", () => {
    expect(toJsonSchema(float32())).toEqual({ type: "number", format: "float" })
  })

  test("float64", () => {
    expect(toJsonSchema(float64())).toEqual({ type: "number", format: "double" })
  })

  test("uuid", () => {
    expect(toJsonSchema(uuid())).toEqual({ type: "string", format: "uuid" })
  })

  test("uri", () => {
    expect(toJsonSchema(uri())).toEqual({ type: "string", format: "uri" })
  })

  test("email", () => {
    expect(toJsonSchema(email())).toEqual({ type: "string", format: "email" })
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toJsonSchema(datetime())).toEqual({ type: "string", format: "date-time" })
  })

  test("date", () => {
    expect(toJsonSchema(date())).toEqual({ type: "string", format: "date" })
  })

  test("time", () => {
    expect(toJsonSchema(time())).toEqual({ type: "string", format: "time" })
  })

  test("duration", () => {
    expect(toJsonSchema(duration())).toEqual({ type: "string", format: "duration" })
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

  test("readonly field emits readOnly: true", () => {
    const ref = t(
      types.object({
        id: t(types.string, { readonly: true }),
        name: t(types.string),
      }),
    )
    expect(toJsonSchema(ref)).toEqual({
      type: "object",
      properties: {
        id: { type: "string", readOnly: true },
        name: { type: "string" },
      },
      required: ["id", "name"],
    })
  })
})

describe("instance", () => {
  test("degrades to an untyped object schema, carrying x-class-name", () => {
    const ref = t(types.instance("User", "src/user.ts"))
    expect(toJsonSchema(ref)).toEqual({
      type: "object",
      "x-class-name": "User",
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

  test("discriminated union: oneOf + discriminator.propertyName, driven by meta.discriminator", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })
    expect(toJsonSchema(ref)).toEqual({
      oneOf: [
        { type: "object", properties: { type: { const: "circle" }, radius: { type: "number" } }, required: ["type", "radius"] },
        { type: "object", properties: { type: { const: "square" }, side: { type: "number" } }, required: ["type", "side"] },
      ],
      discriminator: { propertyName: "type" },
    })
  })
})

describe("intersection", () => {
  test("allOf", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toJsonSchema(ref)).toEqual({
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
    expect(toJsonSchema(ref)).toEqual({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "string" },
        { type: "number" },
      ],
    })
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

  test("exclusiveMinimum / exclusiveMaximum (numeric form)", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toJsonSchema(ref)).toEqual({
      type: "integer",
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
    })
  })

  test("examples", () => {
    const ref = t(types.string, { examples: ["a", "b"] })
    expect(toJsonSchema(ref)).toEqual({ type: "string", examples: ["a", "b"] })
  })

  test("readOnly / writeOnly", () => {
    expect(toJsonSchema(t(types.string, { readOnly: true }))).toEqual({ type: "string", readOnly: true })
    expect(toJsonSchema(t(types.string, { writeOnly: true }))).toEqual({ type: "string", writeOnly: true })
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
        ids: t(types.array(uuid())),
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

describe("function", () => {
  test("degrades to an untyped schema carrying x-function (no JSON Schema callable vocabulary)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toJsonSchema(ref)).toEqual({ "x-function": true })
  })
})

describe("method", () => {
  test("degrades to an untyped schema carrying x-method (distinguished from x-function)", () => {
    const ref = t(types.method([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toJsonSchema(ref)).toEqual({ "x-method": true })
  })
})

describe("interface", () => {
  test("degrades to an untyped object schema carrying x-interface", () => {
    const ref = t(types.interface({ deposit: t(types.method([], t(types.void))) }))
    expect(toJsonSchema(ref)).toEqual({ type: "object", "x-interface": true })
  })
})

describe("unrecognized metadata (open metadata bag)", () => {
  test("meta.brand is silently ignored — projects to the base type", () => {
    expect(toJsonSchema(t(types.string, { brand: "LocationId" }))).toEqual({
      type: "string",
    })
  })
})

describe("stream", () => {
  test("degrades to an array carrying x-stream: true (no native streaming vocabulary)", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toJsonSchema(ref)).toEqual({ type: "array", items: { type: "integer" }, "x-stream": true })
  })
})

describe("toJsonSchemaDocument", () => {
  test("a bare TypeRef (no defs) omits $defs entirely — same output as toJsonSchema alone", () => {
    const doc = typeRefDocument(t(types.object({ id: t(types.string) })))
    expect(toJsonSchemaDocument(doc)).toEqual(toJsonSchema(doc.root))
  })

  test("populates $defs from doc.defs, resolving the root's ref via #/$defs/NAME", () => {
    const user = t(types.object({ id: t(types.string) }))
    const doc = typeRefDocument(t(types.ref("User")), { User: user })
    expect(toJsonSchemaDocument(doc)).toEqual({
      $ref: "#/$defs/User",
      $defs: { User: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    })
  })

  test("every defs entry is converted, not just ones reachable from root", () => {
    const doc = typeRefDocument(t(types.string), {
      Unused: t(types.object({ x: t(types.number) })),
    })
    const result = toJsonSchemaDocument(doc)
    expect(result.$defs).toEqual({ Unused: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } })
  })
})
