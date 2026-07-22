import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { fromJsonSchema } from "./from-json-schema.ts"
import { toJsonSchema } from "./json-schema.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(fromJsonSchema({ type: "boolean" })).toEqual(t(types.boolean))
  })

  test("number", () => {
    expect(fromJsonSchema({ type: "number" })).toEqual(t(types.number))
  })

  test("integer", () => {
    expect(fromJsonSchema({ type: "integer" })).toEqual(t(types.integer))
  })

  test("string", () => {
    expect(fromJsonSchema({ type: "string" })).toEqual(t(types.string))
  })

  test("null", () => {
    expect(fromJsonSchema({ type: "null" })).toEqual(t(types.null))
  })

  test("void projects forward to null; null round-trips to null (not void)", () => {
    expect(fromJsonSchema(toJsonSchema(t(types.void)))).toEqual(t(types.null))
  })

  test("unknown (empty schema)", () => {
    expect(fromJsonSchema({})).toEqual(t(types.unknown))
  })

  test("never", () => {
    expect(fromJsonSchema({ not: {} })).toEqual(t(types.never))
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(fromJsonSchema({ type: "integer", format: "int32" })).toEqual(int32())
  })

  test("int64", () => {
    expect(fromJsonSchema({ type: "integer", format: "int64" })).toEqual(int64())
  })

  test("float32", () => {
    expect(fromJsonSchema({ type: "number", format: "float" })).toEqual(float32())
  })

  test("float64", () => {
    expect(fromJsonSchema({ type: "number", format: "double" })).toEqual(float64())
  })

  test("uuid", () => {
    expect(fromJsonSchema({ type: "string", format: "uuid" })).toEqual(uuid())
  })

  test("uri", () => {
    expect(fromJsonSchema({ type: "string", format: "uri" })).toEqual(uri())
  })

  test("email", () => {
    expect(fromJsonSchema({ type: "string", format: "email" })).toEqual(email())
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(fromJsonSchema({ type: "string", format: "date-time" })).toEqual(datetime())
  })

  test("date", () => {
    expect(fromJsonSchema({ type: "string", format: "date" })).toEqual(date())
  })

  test("time", () => {
    expect(fromJsonSchema({ type: "string", format: "time" })).toEqual(time())
  })

  test("duration", () => {
    expect(fromJsonSchema({ type: "string", format: "duration" })).toEqual(duration())
  })
})

describe("bytes", () => {
  test("contentEncoding: base64", () => {
    expect(fromJsonSchema({ type: "string", contentEncoding: "base64" })).toEqual(bytes())
  })
})

describe("object", () => {
  test("required and optional fields", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
    }
    expect(fromJsonSchema(schema)).toEqual(
      t(
        types.object({
          name: t(types.string),
          nickname: t(types.string, { optional: true }),
        }),
      ),
    )
  })

  test("no required key -> all fields optional", () => {
    const schema = {
      type: "object",
      properties: { nickname: { type: "string" } },
    }
    expect(fromJsonSchema(schema)).toEqual(t(types.object({ nickname: t(types.string, { optional: true }) })))
  })

  test("object with no properties or additionalProperties", () => {
    expect(fromJsonSchema({ type: "object" })).toEqual(t(types.object({})))
  })

  test("readOnly property -> meta.readonly (lowercase convention) alongside verbatim meta.readOnly", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string", readOnly: true },
        name: { type: "string" },
      },
      required: ["id", "name"],
    }
    const result = fromJsonSchema(schema)
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { kind: "object"; fields: Record<string, ReturnType<typeof t>> }).fields
    expect(fields.id!.meta).toEqual({ readOnly: true, readonly: true })
    expect(fields.name!.meta).toEqual({})
  })
})

describe("array", () => {
  test("element type", () => {
    expect(fromJsonSchema({ type: "array", items: { type: "integer" } })).toEqual(t(types.array(t(types.integer))))
  })

  test("no items -> array of unknown", () => {
    expect(fromJsonSchema({ type: "array" })).toEqual(t(types.array(t(types.unknown))))
  })
})

describe("tuple", () => {
  test("prefixItems", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
    }
    expect(fromJsonSchema(schema)).toEqual(t(types.tuple([t(types.string), t(types.integer)])))
  })

  test("draft-04/07 array-form items", () => {
    const schema = {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    }
    expect(fromJsonSchema(schema)).toEqual(t(types.tuple([t(types.string), t(types.number)])))
  })

  test("prefixItems takes precedence over array-form items when both present", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: [{ type: "boolean" }],
    }
    expect(fromJsonSchema(schema)).toEqual(t(types.tuple([t(types.string), t(types.integer)])))
  })
})

describe("map", () => {
  test("additionalProperties", () => {
    const schema = { type: "object", additionalProperties: { type: "number" } }
    expect(fromJsonSchema(schema)).toEqual(t(types.map(t(types.string), t(types.number))))
  })
})

describe("union", () => {
  test("anyOf", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }] }
    expect(fromJsonSchema(schema)).toEqual(t(types.union([t(types.string), t(types.integer)])))
  })

  test("discriminated union: oneOf + discriminator.propertyName -> meta.discriminator", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { type: { const: "circle" }, radius: { type: "number" } }, required: ["type", "radius"] },
        { type: "object", properties: { type: { const: "square" }, side: { type: "number" } }, required: ["type", "side"] },
      ],
      discriminator: { propertyName: "type" },
    }
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    expect(fromJsonSchema(schema)).toEqual(t(types.union([circle, square]), { discriminator: "type" }))
  })
})

describe("intersection", () => {
  test("allOf", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { createdAt: { type: "string" } }, required: ["createdAt"] },
      ],
    }
    expect(fromJsonSchema(schema)).toEqual(
      t(
        types.intersection([
          t(types.object({ id: t(types.string) })),
          t(types.object({ createdAt: t(types.string) })),
        ]),
      ),
    )
  })

  test("three-way allOf preserves every member", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "string" },
        { type: "number" },
      ],
    }
    expect(fromJsonSchema(schema)).toEqual(
      t(types.intersection([t(types.object({ a: t(types.string) })), t(types.string), t(types.number)])),
    )
  })
})

describe("literal", () => {
  test("const", () => {
    expect(fromJsonSchema({ const: "active" })).toEqual(t(types.literal("active")))
  })
})

describe("enum", () => {
  test("enum members", () => {
    expect(fromJsonSchema({ type: "string", enum: ["a", "b", "c"] })).toEqual(t(types.enum(["a", "b", "c"])))
  })

  test("enum without type", () => {
    expect(fromJsonSchema({ enum: ["a", "b"] })).toEqual(t(types.enum(["a", "b"])))
  })
})

describe("ref", () => {
  test("$ref", () => {
    expect(fromJsonSchema({ $ref: "#/$defs/User" })).toEqual(t(types.ref("User")))
  })
})

describe("nullable", () => {
  test("type array form", () => {
    expect(fromJsonSchema({ type: ["string", "null"] })).toEqual(t(types.string, { nullable: true }))
  })

  test("anyOf wrapper form (single non-null variant unwraps)", () => {
    const schema = { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] }
    expect(fromJsonSchema(schema)).toEqual(t(types.array(t(types.string)), { nullable: true }))
  })

  test("anyOf wrapper form with multiple non-null variants stays a union", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] }
    expect(fromJsonSchema(schema)).toEqual(t(types.union([t(types.string), t(types.integer)]), { nullable: true }))
  })
})

describe("metadata passthrough", () => {
  test("title", () => {
    expect(fromJsonSchema({ type: "string", title: "User Name" })).toEqual(
      t(types.string, { title: "User Name" }),
    )
  })

  test("description", () => {
    expect(fromJsonSchema({ type: "string", description: "a name" })).toEqual(
      t(types.string, { description: "a name" }),
    )
  })

  test("deprecated", () => {
    expect(fromJsonSchema({ type: "string", deprecated: true })).toEqual(t(types.string, { deprecated: true }))
  })

  test("default", () => {
    expect(fromJsonSchema({ type: "integer", default: 0 })).toEqual(t(types.integer, { default: 0 }))
  })

  test("constraints", () => {
    const schema = { type: "string", minLength: 1, maxLength: 10, pattern: "^[a-z]+$" }
    expect(fromJsonSchema(schema)).toEqual(
      t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" }),
    )
  })

  test("numeric constraints", () => {
    const schema = { type: "integer", minimum: 0, maximum: 100, multipleOf: 5 }
    expect(fromJsonSchema(schema)).toEqual(t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 }))
  })

  test("exclusiveMinimum / exclusiveMaximum", () => {
    const schema = { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 100 }
    expect(fromJsonSchema(schema)).toEqual(t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 }))
  })

  test("examples", () => {
    expect(fromJsonSchema({ type: "string", examples: ["a", "b"] })).toEqual(
      t(types.string, { examples: ["a", "b"] }),
    )
  })

  test("readOnly / writeOnly", () => {
    expect(fromJsonSchema({ type: "string", readOnly: true })).toEqual(t(types.string, { readOnly: true }))
    expect(fromJsonSchema({ type: "string", writeOnly: true })).toEqual(t(types.string, { writeOnly: true }))
  })
})

describe("unrecognized format fallback", () => {
  test("string format with no known constructor falls back to base type + meta.format", () => {
    expect(fromJsonSchema({ type: "string", format: "ipv4" })).toEqual(t(types.string, { format: "ipv4" }))
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const schema = {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string", format: "uuid" } },
      },
      required: ["ids"],
    }
    expect(fromJsonSchema(schema)).toEqual(t(types.object({ ids: t(types.array(uuid())) })))
  })
})

describe("round-trip: fromJsonSchema(toJsonSchema(ref))", () => {
  test("scalars", () => {
    expect(fromJsonSchema(toJsonSchema(t(types.boolean)))).toEqual(t(types.boolean))
    expect(fromJsonSchema(toJsonSchema(t(types.number)))).toEqual(t(types.number))
    expect(fromJsonSchema(toJsonSchema(t(types.integer)))).toEqual(t(types.integer))
    expect(fromJsonSchema(toJsonSchema(t(types.string)))).toEqual(t(types.string))
    expect(fromJsonSchema(toJsonSchema(t(types.unknown)))).toEqual(t(types.unknown))
    expect(fromJsonSchema(toJsonSchema(t(types.never)))).toEqual(t(types.never))
  })

  test("formatted + temporal + bytes", () => {
    expect(fromJsonSchema(toJsonSchema(int32()))).toEqual(int32())
    expect(fromJsonSchema(toJsonSchema(int64()))).toEqual(int64())
    expect(fromJsonSchema(toJsonSchema(float32()))).toEqual(float32())
    expect(fromJsonSchema(toJsonSchema(float64()))).toEqual(float64())
    expect(fromJsonSchema(toJsonSchema(uuid()))).toEqual(uuid())
    expect(fromJsonSchema(toJsonSchema(uri()))).toEqual(uri())
    expect(fromJsonSchema(toJsonSchema(email()))).toEqual(email())
    expect(fromJsonSchema(toJsonSchema(datetime()))).toEqual(datetime())
    expect(fromJsonSchema(toJsonSchema(date()))).toEqual(date())
    expect(fromJsonSchema(toJsonSchema(time()))).toEqual(time())
    expect(fromJsonSchema(toJsonSchema(duration()))).toEqual(duration())
    expect(fromJsonSchema(toJsonSchema(bytes()))).toEqual(bytes())
  })

  test("object / array / tuple / map", () => {
    const obj = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(fromJsonSchema(toJsonSchema(obj))).toEqual(obj)

    const arr = t(types.array(t(types.integer)))
    expect(fromJsonSchema(toJsonSchema(arr))).toEqual(arr)

    const tup = t(types.tuple([t(types.string), t(types.integer)]))
    expect(fromJsonSchema(toJsonSchema(tup))).toEqual(tup)

    const map = t(types.map(t(types.string), t(types.number)))
    expect(fromJsonSchema(toJsonSchema(map))).toEqual(map)
  })

  test("union / intersection / literal / enum / ref", () => {
    const union = t(types.union([t(types.string), t(types.integer)]))
    expect(fromJsonSchema(toJsonSchema(union))).toEqual(union)

    const intersection = t(
      types.intersection([t(types.object({ id: t(types.string) })), t(types.object({ createdAt: t(types.string) }))]),
    )
    expect(fromJsonSchema(toJsonSchema(intersection))).toEqual(intersection)

    const literal = t(types.literal("active"))
    expect(fromJsonSchema(toJsonSchema(literal))).toEqual(literal)

    const enumRef = t(types.enum(["a", "b", "c"]))
    expect(fromJsonSchema(toJsonSchema(enumRef))).toEqual(enumRef)

    const ref = t(types.ref("User"))
    expect(fromJsonSchema(toJsonSchema(ref))).toEqual(ref)
  })

  test("nullable leaf and complex", () => {
    const leaf = t(types.string, { nullable: true })
    expect(fromJsonSchema(toJsonSchema(leaf))).toEqual(leaf)

    const complex = t(types.array(t(types.string)), { nullable: true })
    expect(fromJsonSchema(toJsonSchema(complex))).toEqual(complex)
  })
})
