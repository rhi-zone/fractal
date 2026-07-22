import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { fromOpenApi20, fromOpenApi30 } from "./from-openapi.ts"
import { toOpenApi30 } from "./openapi30.ts"
import { toOpenApi20 } from "./openapi20.ts"

describe("leaf types (shared 3.0/2.0 subset)", () => {
  for (const fromOpenApi of [fromOpenApi30, fromOpenApi20] as const) {
    test(`boolean (${fromOpenApi.name})`, () => {
      expect(fromOpenApi({ type: "boolean" })).toEqual(t(types.boolean))
    })

    test(`number (${fromOpenApi.name})`, () => {
      expect(fromOpenApi({ type: "number" })).toEqual(t(types.number))
    })

    test(`integer (${fromOpenApi.name})`, () => {
      expect(fromOpenApi({ type: "integer" })).toEqual(t(types.integer))
    })

    test(`string (${fromOpenApi.name})`, () => {
      expect(fromOpenApi({ type: "string" })).toEqual(t(types.string))
    })

    test(`unknown (empty schema) (${fromOpenApi.name})`, () => {
      expect(fromOpenApi({})).toEqual(t(types.unknown))
    })
  }
})

describe("formats", () => {
  test("int32 / int64", () => {
    expect(fromOpenApi30({ type: "integer", format: "int32" })).toEqual(int32())
    expect(fromOpenApi30({ type: "integer", format: "int64" })).toEqual(int64())
  })

  test("float / double", () => {
    expect(fromOpenApi30({ type: "number", format: "float" })).toEqual(float32())
    expect(fromOpenApi30({ type: "number", format: "double" })).toEqual(float64())
  })

  test("uuid / uri / email", () => {
    expect(fromOpenApi30({ type: "string", format: "uuid" })).toEqual(uuid())
    expect(fromOpenApi30({ type: "string", format: "uri" })).toEqual(uri())
    expect(fromOpenApi30({ type: "string", format: "email" })).toEqual(email())
  })

  test("date-time / date / time / duration", () => {
    expect(fromOpenApi30({ type: "string", format: "date-time" })).toEqual(datetime())
    expect(fromOpenApi30({ type: "string", format: "date" })).toEqual(date())
    expect(fromOpenApi30({ type: "string", format: "time" })).toEqual(time())
    expect(fromOpenApi30({ type: "string", format: "duration" })).toEqual(duration())
  })

  test("byte -> bytes()", () => {
    expect(fromOpenApi30({ type: "string", format: "byte" })).toEqual(bytes())
    expect(fromOpenApi20({ type: "string", format: "byte" })).toEqual(bytes())
  })

  test("unrecognized format falls back to base type + meta.format", () => {
    expect(fromOpenApi30({ type: "string", format: "ipv4" })).toEqual(t(types.string, { format: "ipv4" }))
    expect(fromOpenApi30({ type: "string", format: "binary" })).toEqual(t(types.string, { format: "binary" }))
    expect(fromOpenApi30({ type: "number", format: "decimal" })).toEqual(t(types.number, { format: "decimal" }))
    expect(fromOpenApi30({ type: "integer", format: "unsigned" })).toEqual(t(types.integer, { format: "unsigned" }))
  })
})

describe("object", () => {
  test("required and optional fields", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, nickname: { type: "string" } },
      required: ["name"],
    }
    expect(fromOpenApi30(schema)).toEqual(
      t(types.object({ name: t(types.string), nickname: t(types.string, { optional: true }) })),
    )
  })

  test("no required key -> all fields optional", () => {
    const schema = { type: "object", properties: { nickname: { type: "string" } } }
    expect(fromOpenApi30(schema)).toEqual(t(types.object({ nickname: t(types.string, { optional: true }) })))
  })

  test("no properties or additionalProperties -> empty object", () => {
    expect(fromOpenApi30({ type: "object" })).toEqual(t(types.object({})))
  })

  test("additionalProperties -> map", () => {
    const schema = { type: "object", additionalProperties: { type: "number" } }
    expect(fromOpenApi30(schema)).toEqual(t(types.map(t(types.string), t(types.number))))
  })

  test("readOnly property -> meta.readonly alongside verbatim meta.readOnly", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
      required: ["id", "name"],
    }
    const result = fromOpenApi30(schema)
    const fields = (result.shape as { kind: "object"; fields: Record<string, ReturnType<typeof t>> }).fields
    expect(fields.id!.meta).toEqual({ readOnly: true, readonly: true })
    expect(fields.name!.meta).toEqual({})
  })
})

describe("array", () => {
  test("element type", () => {
    expect(fromOpenApi30({ type: "array", items: { type: "integer" } })).toEqual(t(types.array(t(types.integer))))
  })

  test("no items -> array of unknown", () => {
    expect(fromOpenApi30({ type: "array" })).toEqual(t(types.array(t(types.unknown))))
  })
})

describe("allOf -> intersection", () => {
  test("3.0", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { createdAt: { type: "string" } }, required: ["createdAt"] },
      ],
    }
    expect(fromOpenApi30(schema)).toEqual(
      t(types.intersection([t(types.object({ id: t(types.string) })), t(types.object({ createdAt: t(types.string) }))])),
    )
  })

  test("2.0 (the only polymorphism keyword Swagger 2.0 has)", () => {
    const schema = {
      allOf: [{ $ref: "#/definitions/Pet" }, { type: "object", properties: { name: { type: "string" } }, required: ["name"] }],
    }
    expect(fromOpenApi20(schema)).toEqual(t(types.intersection([t(types.ref("Pet")), t(types.object({ name: t(types.string) }))])))
  })
})

describe("union: oneOf / anyOf (3.0)", () => {
  test("anyOf", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }] }
    expect(fromOpenApi30(schema)).toEqual(t(types.union([t(types.string), t(types.integer)])))
  })

  test("oneOf without discriminator", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "integer" }] }
    expect(fromOpenApi30(schema)).toEqual(t(types.union([t(types.string), t(types.integer)])))
  })

  test("oneOf + discriminator.propertyName -> meta.discriminator", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { petType: { const: "Dog" }, bark: { type: "boolean" } }, required: ["petType"] },
        { type: "object", properties: { petType: { const: "Cat" }, meow: { type: "boolean" } }, required: ["petType"] },
      ],
      discriminator: { propertyName: "petType" },
    }
    const dog = t(types.object({ petType: t(types.literal("Dog")), bark: t(types.boolean, { optional: true }) }))
    const cat = t(types.object({ petType: t(types.literal("Cat")), meow: t(types.boolean, { optional: true }) }))
    expect(fromOpenApi30(schema)).toEqual(t(types.union([dog, cat]), { discriminator: "petType" }))
  })

  test("oneOf + discriminator.mapping -> meta.discriminatorMapping (preserved, no forward consumer yet)", () => {
    const schema = {
      oneOf: [{ $ref: "#/components/schemas/Dog" }, { $ref: "#/components/schemas/Cat" }],
      discriminator: { propertyName: "petType", mapping: { dog: "#/components/schemas/Dog", cat: "#/components/schemas/Cat" } },
    }
    const result = fromOpenApi30(schema)
    expect(result.meta.discriminator).toBe("petType")
    expect(result.meta.discriminatorMapping).toEqual({ dog: "#/components/schemas/Dog", cat: "#/components/schemas/Cat" })
  })
})

describe("union: Swagger 2.0's x-oneOf round-trip convention", () => {
  test("x-oneOf array -> union", () => {
    const schema = { "x-oneOf": [{ type: "string" }, { type: "integer" }] }
    expect(fromOpenApi20(schema)).toEqual(t(types.union([t(types.string), t(types.integer)])))
  })

  test("x-oneOf + discriminator string -> meta.discriminator", () => {
    const schema = {
      "x-oneOf": [
        { type: "object", properties: { petType: { const: "Dog" } }, required: ["petType"] },
        { type: "object", properties: { petType: { const: "Cat" } }, required: ["petType"] },
      ],
      discriminator: "petType",
    }
    const dog = t(types.object({ petType: t(types.literal("Dog")) }))
    const cat = t(types.object({ petType: t(types.literal("Cat")) }))
    expect(fromOpenApi20(schema)).toEqual(t(types.union([dog, cat]), { discriminator: "petType" }))
  })

  test("2.0 has no native oneOf/anyOf keyword — plain 'oneOf' key is ignored, not converted", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "integer" }] }
    // No recognized structural keyword -> falls through to the unknown-schema default.
    expect(fromOpenApi20(schema)).toEqual(t(types.unknown))
  })
})

describe("literal / enum", () => {
  test("const", () => {
    expect(fromOpenApi30({ const: "active" })).toEqual(t(types.literal("active")))
  })

  test("enum members", () => {
    expect(fromOpenApi30({ type: "string", enum: ["a", "b", "c"] })).toEqual(t(types.enum(["a", "b", "c"])))
    expect(fromOpenApi20({ type: "string", enum: ["a", "b", "c"] })).toEqual(t(types.enum(["a", "b", "c"])))
  })
})

describe("$ref", () => {
  test("3.0 components/schemas", () => {
    expect(fromOpenApi30({ $ref: "#/components/schemas/User" })).toEqual(t(types.ref("User")))
  })

  test("2.0 definitions", () => {
    expect(fromOpenApi20({ $ref: "#/definitions/User" })).toEqual(t(types.ref("User")))
  })
})

describe("nullable", () => {
  test("3.0 nullable: true", () => {
    expect(fromOpenApi30({ type: "string", nullable: true })).toEqual(t(types.string, { nullable: true }))
  })

  test("3.0 nullable on a composite (object) schema", () => {
    const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], nullable: true }
    expect(fromOpenApi30(schema)).toEqual(t(types.object({ id: t(types.string) }), { nullable: true }))
  })

  test("2.0 x-nullable: true", () => {
    expect(fromOpenApi20({ type: "string", "x-nullable": true })).toEqual(t(types.string, { nullable: true }))
  })

  test("nullable absent/false leaves meta empty", () => {
    expect(fromOpenApi30({ type: "string", nullable: false })).toEqual(t(types.string))
    expect(fromOpenApi20({ type: "string" })).toEqual(t(types.string))
  })
})

describe("metadata passthrough", () => {
  test("description / default / example", () => {
    expect(fromOpenApi30({ type: "string", description: "a name" })).toEqual(t(types.string, { description: "a name" }))
    expect(fromOpenApi30({ type: "integer", default: 0 })).toEqual(t(types.integer, { default: 0 }))
    expect(fromOpenApi30({ type: "string", example: "Fido" })).toEqual(t(types.string, { example: "Fido" }))
  })

  test("3.0 native deprecated", () => {
    expect(fromOpenApi30({ type: "string", deprecated: true })).toEqual(t(types.string, { deprecated: true }))
  })

  test("2.0 x-deprecated -> canonical meta.deprecated", () => {
    expect(fromOpenApi20({ type: "string", "x-deprecated": true })).toEqual(t(types.string, { deprecated: true }))
  })

  test("numeric / string constraints", () => {
    const schema = { type: "string", minLength: 1, maxLength: 10, pattern: "^[a-z]+$" }
    expect(fromOpenApi30(schema)).toEqual(t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" }))

    const numSchema = { type: "integer", minimum: 0, maximum: 100, multipleOf: 5 }
    expect(fromOpenApi30(numSchema)).toEqual(t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 }))
  })

  test("readOnly / writeOnly", () => {
    expect(fromOpenApi30({ type: "string", readOnly: true })).toEqual(t(types.string, { readOnly: true }))
    expect(fromOpenApi30({ type: "string", writeOnly: true })).toEqual(t(types.string, { writeOnly: true }))
  })

  test("unrecognized x-* vendor extension travels verbatim into meta", () => {
    expect(fromOpenApi30({ type: "string", "x-nullable-legacy": true })).toEqual(t(types.string, { "x-nullable-legacy": true }))
    expect(fromOpenApi20({ type: "string", "x-internal": "yes" })).toEqual(t(types.string, { "x-internal": "yes" }))
  })
})

describe("nested schemas", () => {
  test("object with array of uuid fields", () => {
    const schema = {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string", format: "uuid" } } },
      required: ["ids"],
    }
    expect(fromOpenApi30(schema)).toEqual(t(types.object({ ids: t(types.array(uuid())) })))
  })

  test("nested nullable inside object property (3.0)", () => {
    const schema = {
      type: "object",
      properties: { nickname: { type: "string", nullable: true } },
      required: ["nickname"],
    }
    expect(fromOpenApi30(schema)).toEqual(t(types.object({ nickname: t(types.string, { nullable: true }) })))
  })

  test("deeply nested array of objects with x-nullable field (2.0)", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, middleName: { type: "string", "x-nullable": true } },
        required: ["name"],
      },
    }
    expect(fromOpenApi20(schema)).toEqual(
      t(
        types.array(
          t(
            types.object({
              name: t(types.string),
              middleName: t(types.string, { nullable: true, optional: true }),
            }),
          ),
        ),
      ),
    )
  })
})

describe("round-trip: fromOpenApi30(toOpenApi30(ref))", () => {
  test("scalars", () => {
    expect(fromOpenApi30(toOpenApi30(t(types.boolean)))).toEqual(t(types.boolean))
    expect(fromOpenApi30(toOpenApi30(t(types.number)))).toEqual(t(types.number))
    expect(fromOpenApi30(toOpenApi30(t(types.integer)))).toEqual(t(types.integer))
    expect(fromOpenApi30(toOpenApi30(t(types.string)))).toEqual(t(types.string))
    expect(fromOpenApi30(toOpenApi30(t(types.unknown)))).toEqual(t(types.unknown))
  })

  test("formatted + temporal + bytes", () => {
    expect(fromOpenApi30(toOpenApi30(int32()))).toEqual(int32())
    expect(fromOpenApi30(toOpenApi30(int64()))).toEqual(int64())
    expect(fromOpenApi30(toOpenApi30(float32()))).toEqual(float32())
    expect(fromOpenApi30(toOpenApi30(float64()))).toEqual(float64())
    expect(fromOpenApi30(toOpenApi30(uuid()))).toEqual(uuid())
    expect(fromOpenApi30(toOpenApi30(uri()))).toEqual(uri())
    expect(fromOpenApi30(toOpenApi30(email()))).toEqual(email())
    expect(fromOpenApi30(toOpenApi30(datetime()))).toEqual(datetime())
    expect(fromOpenApi30(toOpenApi30(date()))).toEqual(date())
    expect(fromOpenApi30(toOpenApi30(time()))).toEqual(time())
    expect(fromOpenApi30(toOpenApi30(bytes()))).toEqual(bytes())
  })

  test("object / array / map", () => {
    const obj = t(types.object({ name: t(types.string), nickname: t(types.string, { optional: true }) }))
    expect(fromOpenApi30(toOpenApi30(obj))).toEqual(obj)

    const arr = t(types.array(t(types.integer)))
    expect(fromOpenApi30(toOpenApi30(arr))).toEqual(arr)

    const map = t(types.map(t(types.string), t(types.number)))
    expect(fromOpenApi30(toOpenApi30(map))).toEqual(map)
  })

  test("union with discriminator / intersection / literal / enum / ref", () => {
    const union = t(types.union([t(types.string), t(types.integer)]))
    expect(fromOpenApi30(toOpenApi30(union))).toEqual(union)

    // `kind` uses `enum` rather than `literal` here — a single-value
    // `literal` degrades to a one-member `enum` on the way through OAS's
    // const-less encoding (see the dedicated test below), which would make
    // this an unfaithful round-trip assertion for reasons unrelated to what
    // this test is actually verifying (discriminator + union preservation).
    const discriminated = t(
      types.union([
        t(types.object({ kind: t(types.enum(["a", "b"])) })),
        t(types.object({ kind: t(types.enum(["a", "b"])) })),
      ]),
      { discriminator: "kind" },
    )
    expect(fromOpenApi30(toOpenApi30(discriminated))).toEqual(discriminated)

    const intersection = t(types.intersection([t(types.object({ id: t(types.string) })), t(types.object({ createdAt: t(types.string) }))]))
    expect(fromOpenApi30(toOpenApi30(intersection))).toEqual(intersection)

    const enumRef = t(types.enum(["a", "b", "c"]))
    expect(fromOpenApi30(toOpenApi30(enumRef))).toEqual(enumRef)

    const ref = t(types.ref("User"))
    expect(fromOpenApi30(toOpenApi30(ref))).toEqual(ref)
  })

  // OAS 3.0.3 is draft-05-based and has no `const` keyword (a later JSON
  // Schema addition) — openapi30.ts's `literal` handler degrades to a
  // single-value `enum` (§4.8.24 has no other way to pin one value), which
  // is structurally indistinguishable on ingest from an actual one-member
  // `enum`. This is a genuine, inherent asymmetry in the forward projector's
  // encoding (not a round-trip bug): `literal` -> OAS -> `enum`, never back
  // to `literal`.
  test("literal degrades to a one-member enum through OAS 3.0's const-less encoding", () => {
    const oas = toOpenApi30(t(types.literal("active")))
    expect(oas).toEqual({ enum: ["active"] })
    expect(fromOpenApi30(oas)).toEqual(t(types.enum(["active"])))
  })

  test("nullable leaf and composite", () => {
    const leaf = t(types.string, { nullable: true })
    expect(fromOpenApi30(toOpenApi30(leaf))).toEqual(leaf)

    const complex = t(types.array(t(types.string)), { nullable: true })
    expect(fromOpenApi30(toOpenApi30(complex))).toEqual(complex)
  })

  test("deprecated / example", () => {
    const ref = t(types.string, { deprecated: true, example: "Fido" })
    expect(fromOpenApi30(toOpenApi30(ref))).toEqual(ref)
  })
})

describe("round-trip: fromOpenApi20(toOpenApi20(ref))", () => {
  test("scalars", () => {
    expect(fromOpenApi20(toOpenApi20(t(types.boolean)))).toEqual(t(types.boolean))
    expect(fromOpenApi20(toOpenApi20(t(types.string)))).toEqual(t(types.string))
    expect(fromOpenApi20(toOpenApi20(t(types.unknown)))).toEqual(t(types.unknown))
  })

  test("formatted + bytes", () => {
    expect(fromOpenApi20(toOpenApi20(int32()))).toEqual(int32())
    expect(fromOpenApi20(toOpenApi20(uuid()))).toEqual(uuid())
    expect(fromOpenApi20(toOpenApi20(bytes()))).toEqual(bytes())
  })

  test("object / array / map", () => {
    const obj = t(types.object({ name: t(types.string), nickname: t(types.string, { optional: true }) }))
    expect(fromOpenApi20(toOpenApi20(obj))).toEqual(obj)

    const arr = t(types.array(t(types.integer)))
    expect(fromOpenApi20(toOpenApi20(arr))).toEqual(arr)

    const map = t(types.map(t(types.string), t(types.number)))
    expect(fromOpenApi20(toOpenApi20(map))).toEqual(map)
  })

  test("union with discriminator via x-oneOf convention", () => {
    const union = t(types.union([t(types.string), t(types.integer)]))
    expect(fromOpenApi20(toOpenApi20(union))).toEqual(union)

    // See the 3.0 test above for why `kind` uses `enum` rather than `literal`.
    const discriminated = t(
      types.union([t(types.object({ kind: t(types.enum(["a", "b"])) })), t(types.object({ kind: t(types.enum(["a", "b"])) }))]),
      { discriminator: "kind" },
    )
    expect(fromOpenApi20(toOpenApi20(discriminated))).toEqual(discriminated)
  })

  test("intersection / literal / enum / ref", () => {
    const intersection = t(types.intersection([t(types.object({ id: t(types.string) })), t(types.object({ createdAt: t(types.string) }))]))
    expect(fromOpenApi20(toOpenApi20(intersection))).toEqual(intersection)

    // Same const-less asymmetry as OAS 3.0 (see the dedicated test above) —
    // Swagger 2.0's draft-04 base has no `const` either.
    expect(fromOpenApi20(toOpenApi20(t(types.literal("active"))))).toEqual(t(types.enum(["active"])))

    const enumRef = t(types.enum(["a", "b", "c"]))
    expect(fromOpenApi20(toOpenApi20(enumRef))).toEqual(enumRef)

    const ref = t(types.ref("User"))
    expect(fromOpenApi20(toOpenApi20(ref))).toEqual(ref)
  })

  test("nullable leaf (via x-nullable) and deprecated (via x-deprecated)", () => {
    const leaf = t(types.string, { nullable: true })
    expect(fromOpenApi20(toOpenApi20(leaf))).toEqual(leaf)

    const deprecated = t(types.string, { deprecated: true })
    expect(fromOpenApi20(toOpenApi20(deprecated))).toEqual(deprecated)
  })
})
