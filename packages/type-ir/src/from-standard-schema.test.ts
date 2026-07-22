import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { fromStandardSchema } from "./from-standard-schema.ts"

// Minimal StandardSchemaV1 mock — validate() is never exercised by
// fromStandardSchema, so it just needs to satisfy the interface shape.
function mockStandardSchema(
  vendor: string,
  extra?: Partial<StandardSchemaV1.Props>,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
      ...extra,
    },
  }
}

function mockStandardJsonSchema(
  vendor: string,
  jsonSchema: Record<string, unknown>,
  opts?: { failOn2020?: boolean },
): StandardJSONSchemaV1 & StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: (options) => {
          if (opts?.failOn2020 && options.target === "draft-2020-12") {
            throw new Error(`unsupported target: ${options.target}`)
          }
          return jsonSchema
        },
        output: (options) => {
          if (opts?.failOn2020 && options.target === "draft-2020-12") {
            throw new Error(`unsupported target: ${options.target}`)
          }
          return jsonSchema
        },
      },
    },
  }
}

describe("StandardJSONSchemaV1 path", () => {
  test("delegates to fromJsonSchema when jsonSchema.input is available", () => {
    const schema = mockStandardJsonSchema("zod", { type: "string" })
    expect(fromStandardSchema(schema)).toEqual(t(types.string, { vendor: "zod" }))
  })

  test("converts a structured object schema via the JSON Schema export", () => {
    const schema = mockStandardJsonSchema("valibot", {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name"],
    })
    const result = fromStandardSchema(schema)
    expect(result.meta.vendor).toBe("valibot")
    expect(result.shape.kind).toBe("object")
  })

  test("falls back to draft-07 when the vendor doesn't support draft-2020-12", () => {
    const schema = mockStandardJsonSchema("weird-vendor", { type: "boolean" }, { failOn2020: true })
    expect(fromStandardSchema(schema)).toEqual(t(types.boolean, { vendor: "weird-vendor" }))
  })
})

describe("fallback path (no JSON Schema export)", () => {
  test("infers from a runtime ~standard.types sample when present", () => {
    const schema = mockStandardSchema("custom-vendor", {
      types: { input: "hello", output: "hello" },
    })
    const result = fromStandardSchema(schema)
    expect(result.shape).toEqual(types.string)
    expect(result.meta.vendor).toBe("custom-vendor")
  })

  test("infers a structured sample from ~standard.types.output", () => {
    const schema = mockStandardSchema("custom-vendor", {
      types: { input: {}, output: { id: 1, name: "widget" } },
    })
    const result = fromStandardSchema(schema)
    expect(result.shape.kind).toBe("object")
    expect(result.meta.vendor).toBe("custom-vendor")
  })

  test("degrades to unknown when no types sample and no jsonSchema export exist", () => {
    const schema = mockStandardSchema("bare-vendor")
    expect(fromStandardSchema(schema)).toEqual(t(types.unknown, { vendor: "bare-vendor" }))
  })
})

describe("vendor metadata preservation", () => {
  test("preserves vendor across the JSON Schema path", () => {
    const schema = mockStandardJsonSchema("arktype", { type: "number" })
    expect(fromStandardSchema(schema).meta.vendor).toBe("arktype")
  })

  test("preserves vendor across the fallback path", () => {
    const schema = mockStandardSchema("io-ts")
    expect(fromStandardSchema(schema).meta.vendor).toBe("io-ts")
  })
})
