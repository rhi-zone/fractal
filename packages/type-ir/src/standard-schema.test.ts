import { describe, expect, test } from "bun:test"
import { nullable, t, types, withMeta } from "./index.ts"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { toStandardSchema } from "./standard-schema.ts"

function issuePaths(issues: readonly StandardSchemaV1.Issue[]): string[] {
  return issues.map((i) => (i.path ?? []).map((seg) => (typeof seg === "object" ? seg.key : seg)).join("."))
}

describe("~standard shape", () => {
  test("has version 1 and vendor fractal-type-ir", () => {
    const schema = toStandardSchema(t(types.string))
    expect(schema["~standard"].version).toBe(1)
    expect(schema["~standard"].vendor).toBe("fractal-type-ir")
  })

  test("validate is callable and jsonSchema.input/output are callable", () => {
    const schema = toStandardSchema(t(types.string))
    expect(typeof schema["~standard"].validate).toBe("function")
    expect(typeof schema["~standard"].jsonSchema.input).toBe("function")
    expect(typeof schema["~standard"].jsonSchema.output).toBe("function")
  })

  test("satisfies the StandardSchemaV1 and StandardJSONSchemaV1 type constraints", () => {
    const schema: StandardSchemaV1 & StandardJSONSchemaV1 = toStandardSchema(t(types.string))
    expect(schema).toBeDefined()
  })
})

describe("primitives", () => {
  test("string: accepts a string, rejects others", () => {
    const schema = toStandardSchema(t(types.string))
    expect(schema["~standard"].validate("hello")).toEqual({ value: "hello" })
    const result = schema["~standard"].validate(42) as StandardSchemaV1.FailureResult
    expect(result.issues).toBeDefined()
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  test("number: accepts a number, rejects a string", () => {
    const schema = toStandardSchema(t(types.number))
    expect(schema["~standard"].validate(3.14)).toEqual({ value: 3.14 })
    const result = schema["~standard"].validate("3.14") as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  test("integer: rejects a non-integer number", () => {
    const schema = toStandardSchema(t(types.integer))
    expect(schema["~standard"].validate(5)).toEqual({ value: 5 })
    const result = schema["~standard"].validate(5.5) as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  test("boolean: accepts booleans only", () => {
    const schema = toStandardSchema(t(types.boolean))
    expect(schema["~standard"].validate(true)).toEqual({ value: true })
    const result = schema["~standard"].validate("true") as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  test("null: accepts null only", () => {
    const schema = toStandardSchema(t(types.null))
    expect(schema["~standard"].validate(null)).toEqual({ value: null })
    const result = schema["~standard"].validate(undefined) as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  test("meta.nullable allows null in addition to the base type", () => {
    const schema = toStandardSchema(nullable(t(types.string)))
    expect(schema["~standard"].validate(null)).toEqual({ value: null })
    expect(schema["~standard"].validate("x")).toEqual({ value: "x" })
    const result = schema["~standard"].validate(5) as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })
})

describe("objects", () => {
  const person = t(
    types.object({
      name: t(types.string),
      age: withMeta(t(types.integer), { optional: true }),
    }),
  )

  test("valid object with optional property omitted passes", () => {
    const schema = toStandardSchema(person)
    expect(schema["~standard"].validate({ name: "Ada" })).toEqual({ value: { name: "Ada" } })
  })

  test("valid object with optional property present passes", () => {
    const schema = toStandardSchema(person)
    expect(schema["~standard"].validate({ name: "Ada", age: 30 })).toEqual({ value: { name: "Ada", age: 30 } })
  })

  test("missing required property fails with a path", () => {
    const schema = toStandardSchema(person)
    const result = schema["~standard"].validate({}) as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
    expect(issuePaths(result.issues!)).toContain("name")
  })

  test("wrong-type property fails with a path to that property", () => {
    const schema = toStandardSchema(person)
    const result = schema["~standard"].validate({ name: 5 }) as StandardSchemaV1.FailureResult
    expect(issuePaths(result.issues!)).toContain("name")
  })

  test("additionalProperties: false rejects unexpected properties", () => {
    const strict = t(
      types.object({ name: t(types.string) }),
      { additionalProperties: false },
    )
    const schema = toStandardSchema(strict)
    expect(schema["~standard"].validate({ name: "Ada" })).toEqual({ value: { name: "Ada" } })
    const result = schema["~standard"].validate({ name: "Ada", extra: 1 }) as StandardSchemaV1.FailureResult
    expect(issuePaths(result.issues!)).toContain("extra")
  })

  test("additionalProperties unset (default) allows unexpected properties", () => {
    const schema = toStandardSchema(person)
    expect(schema["~standard"].validate({ name: "Ada", extra: 1 })).toEqual({ value: { name: "Ada", extra: 1 } })
  })
})

describe("arrays", () => {
  const numbers = t(types.array(t(types.number)))

  test("valid array passes", () => {
    const schema = toStandardSchema(numbers)
    expect(schema["~standard"].validate([1, 2, 3])).toEqual({ value: [1, 2, 3] })
  })

  test("non-array fails", () => {
    const schema = toStandardSchema(numbers)
    const result = schema["~standard"].validate("nope") as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  test("bad element fails with an index path", () => {
    const schema = toStandardSchema(numbers)
    const result = schema["~standard"].validate([1, "two", 3]) as StandardSchemaV1.FailureResult
    expect(issuePaths(result.issues!)).toContain("1")
  })
})

describe("unions", () => {
  const stringOrNumber = t(types.union([t(types.string), t(types.number)]))

  test("accepts either variant", () => {
    const schema = toStandardSchema(stringOrNumber)
    expect(schema["~standard"].validate("x")).toEqual({ value: "x" })
    expect(schema["~standard"].validate(5)).toEqual({ value: 5 })
  })

  test("rejects a value matching neither variant", () => {
    const schema = toStandardSchema(stringOrNumber)
    const result = schema["~standard"].validate(true) as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })

  describe("discriminated", () => {
    const shape = withMeta(
      t(
        types.union([
          t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) })),
          t(types.object({ kind: t(types.literal("square")), side: t(types.number) })),
        ]),
      ),
      { discriminator: "kind" },
    )

    test("validates the matching variant", () => {
      const schema = toStandardSchema(shape)
      expect(schema["~standard"].validate({ kind: "circle", radius: 2 })).toEqual({
        value: { kind: "circle", radius: 2 },
      })
    })

    test("reports precise issues against the matched variant", () => {
      const schema = toStandardSchema(shape)
      const result = schema["~standard"].validate({ kind: "circle", radius: "big" }) as StandardSchemaV1.FailureResult
      expect(issuePaths(result.issues!)).toContain("radius")
    })

    test("unmatched discriminator value fails", () => {
      const schema = toStandardSchema(shape)
      const result = schema["~standard"].validate({ kind: "triangle" }) as StandardSchemaV1.FailureResult
      expect(result.issues!.length).toBeGreaterThan(0)
    })
  })
})

describe("enums", () => {
  const color = t(types.enum(["red", "green", "blue"]))

  test("accepts a member", () => {
    const schema = toStandardSchema(color)
    expect(schema["~standard"].validate("red")).toEqual({ value: "red" })
  })

  test("rejects a non-member", () => {
    const schema = toStandardSchema(color)
    const result = schema["~standard"].validate("purple") as StandardSchemaV1.FailureResult
    expect(result.issues!.length).toBeGreaterThan(0)
  })
})

describe("jsonSchema export", () => {
  const person = t(types.object({ name: t(types.string) }))

  test("draft-2020-12 target returns a valid-looking JSON Schema", () => {
    const schema = toStandardSchema(person)
    const result = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as Record<string, unknown>
    expect(result.type).toBe("object")
    expect((result.properties as Record<string, unknown>).name).toEqual({ type: "string" })
  })

  test("draft-07 target returns a valid-looking JSON Schema", () => {
    const schema = toStandardSchema(person)
    const result = schema["~standard"].jsonSchema.input({ target: "draft-07" }) as Record<string, unknown>
    expect(result.type).toBe("object")
  })

  test("openapi-3.0 target returns an OpenAPI schema object", () => {
    const schema = toStandardSchema(person)
    const result = schema["~standard"].jsonSchema.input({ target: "openapi-3.0" }) as Record<string, unknown>
    expect(result.type).toBe("object")
  })

  test("output() matches input() for the same target", () => {
    const schema = toStandardSchema(person)
    const input = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
    const output = schema["~standard"].jsonSchema.output({ target: "draft-2020-12" })
    expect(output).toEqual(input)
  })

  test("unsupported target throws", () => {
    const schema = toStandardSchema(person)
    expect(() => schema["~standard"].jsonSchema.input({ target: "unsupported-target" })).toThrow()
  })
})
