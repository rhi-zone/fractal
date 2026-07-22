import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, datetime, float32, float64, int16, int32, int64, int8, uint64 } from "./kinds/common.ts"
import { fromElasticsearch, fromElasticsearchField } from "./from-elasticsearch.ts"

describe("leaf field types", () => {
  test("text -> string", () => {
    expect(fromElasticsearchField({ type: "text" })).toEqual(t(types.string))
  })

  test("keyword -> string", () => {
    expect(fromElasticsearchField({ type: "keyword" })).toEqual(t(types.string))
  })

  test("wildcard -> string", () => {
    expect(fromElasticsearchField({ type: "wildcard" })).toEqual(t(types.string))
  })

  test("long -> int64", () => {
    expect(fromElasticsearchField({ type: "long" })).toEqual(int64())
  })

  test("integer -> int32", () => {
    expect(fromElasticsearchField({ type: "integer" })).toEqual(int32())
  })

  test("short -> int16", () => {
    expect(fromElasticsearchField({ type: "short" })).toEqual(int16())
  })

  test("byte -> int8", () => {
    expect(fromElasticsearchField({ type: "byte" })).toEqual(int8())
  })

  test("unsigned_long -> uint64", () => {
    expect(fromElasticsearchField({ type: "unsigned_long" })).toEqual(uint64())
  })

  test("double -> float64", () => {
    expect(fromElasticsearchField({ type: "double" })).toEqual(float64())
  })

  test("float -> float32", () => {
    expect(fromElasticsearchField({ type: "float" })).toEqual(float32())
  })

  test("half_float -> number with float16 format (no native float16 kind)", () => {
    expect(fromElasticsearchField({ type: "half_float" })).toEqual(t(types.number, { format: "float16" }))
  })

  test("scaled_float -> number with scaling_factor in meta", () => {
    expect(fromElasticsearchField({ type: "scaled_float", scaling_factor: 100 })).toEqual(
      t(types.number, { format: "scaled_float", scalingFactor: 100 }),
    )
  })

  test("boolean -> boolean", () => {
    expect(fromElasticsearchField({ type: "boolean" })).toEqual(t(types.boolean))
  })

  test("binary -> bytes", () => {
    expect(fromElasticsearchField({ type: "binary" })).toEqual(bytes())
  })

  test("ip -> string with ip format", () => {
    expect(fromElasticsearchField({ type: "ip" })).toEqual(t(types.string, { format: "ip" }))
  })
})

describe("date", () => {
  test("date with no format -> datetime", () => {
    expect(fromElasticsearchField({ type: "date" })).toEqual(datetime())
  })

  test("date with format -> datetime with format in meta", () => {
    expect(fromElasticsearchField({ type: "date", format: "yyyy-MM-dd" })).toEqual(datetime({ format: "yyyy-MM-dd" }))
  })
})

describe("geo types", () => {
  test("geo_point -> object with lat/lon", () => {
    expect(fromElasticsearchField({ type: "geo_point" })).toEqual(
      t(
        types.object({
          lat: t(types.number),
          lon: t(types.number),
        }),
      ),
    )
  })

  test("geo_shape -> unknown with esType meta", () => {
    expect(fromElasticsearchField({ type: "geo_shape" })).toEqual(t(types.unknown, { esType: "geo_shape" }))
  })
})

describe("flattened", () => {
  test("flattened -> unknown with esType meta", () => {
    expect(fromElasticsearchField({ type: "flattened" })).toEqual(t(types.unknown, { esType: "flattened" }))
  })
})

describe("object / nested", () => {
  test("implicit object (no type, has properties)", () => {
    const field = fromElasticsearchField({
      properties: {
        name: { type: "text" },
        age: { type: "integer" },
      },
    })
    expect(field).toEqual(
      t(
        types.object({
          name: t(types.string),
          age: int32(),
        }),
      ),
    )
  })

  test("explicit type: object", () => {
    const field = fromElasticsearchField({
      type: "object",
      properties: { id: { type: "keyword" } },
    })
    expect(field).toEqual(t(types.object({ id: t(types.string) })))
  })

  test("object with no properties -> empty object", () => {
    expect(fromElasticsearchField({ type: "object" })).toEqual(t(types.object({})))
  })

  test("nested objects (recursion)", () => {
    const field = fromElasticsearchField({
      properties: {
        user: {
          properties: {
            name: { type: "text" },
            address: {
              properties: {
                city: { type: "keyword" },
                zip: { type: "keyword" },
              },
            },
          },
        },
      },
    })
    expect(field).toEqual(
      t(
        types.object({
          user: t(
            types.object({
              name: t(types.string),
              address: t(
                types.object({
                  city: t(types.string),
                  zip: t(types.string),
                }),
              ),
            }),
          ),
        }),
      ),
    )
  })

  test("nested type -> array of object", () => {
    const field = fromElasticsearchField({
      type: "nested",
      properties: {
        item: { type: "keyword" },
        qty: { type: "integer" },
      },
    })
    expect(field).toEqual(
      t(
        types.array(
          t(
            types.object({
              item: t(types.string),
              qty: int32(),
            }),
          ),
        ),
      ),
    )
  })

  test("enabled: false -> unknown (opaque object)", () => {
    const field = fromElasticsearchField({
      type: "object",
      enabled: false,
      properties: { anything: { type: "text" } },
    })
    expect(field).toEqual(t(types.unknown))
  })
})

describe("multi-fields", () => {
  test("text field with keyword sub-field preserved in meta.fields", () => {
    const field = fromElasticsearchField({
      type: "text",
      fields: {
        raw: { type: "keyword" },
      },
    })
    expect(field).toEqual(
      t(types.string, {
        fields: {
          raw: t(types.string),
        },
      }),
    )
  })

  test("multiple sub-fields", () => {
    const field = fromElasticsearchField({
      type: "text",
      fields: {
        raw: { type: "keyword" },
        length: { type: "long" },
      },
    })
    expect(field.meta.fields).toEqual({
      raw: t(types.string),
      length: int64(),
    })
  })
})

describe("dynamic / index / analyzer meta", () => {
  test("dynamic: strict preserved in meta", () => {
    const field = fromElasticsearchField({
      type: "object",
      dynamic: "strict",
      properties: { a: { type: "text" } },
    })
    expect(field.meta.dynamic).toBe("strict")
  })

  test("dynamic: false preserved in meta", () => {
    const field = fromElasticsearchField({ type: "object", dynamic: false, properties: {} })
    expect(field.meta.dynamic).toBe(false)
  })

  test("index: false preserved in meta", () => {
    const field = fromElasticsearchField({ type: "keyword", index: false })
    expect(field.meta.index).toBe(false)
  })

  test("index: true is not recorded (only the non-default is notable)", () => {
    const field = fromElasticsearchField({ type: "keyword", index: true })
    expect(field.meta.index).toBeUndefined()
  })

  test("analyzer / search_analyzer preserved in meta", () => {
    const field = fromElasticsearchField({
      type: "text",
      analyzer: "standard",
      search_analyzer: "simple",
    })
    expect(field.meta.analyzer).toBe("standard")
    expect(field.meta.searchAnalyzer).toBe("simple")
  })
})

describe("keyword enum convention", () => {
  test("keyword with enum values -> types.enum", () => {
    const field = fromElasticsearchField({
      type: "keyword",
      enum: ["active", "inactive", "pending"],
    })
    expect(field).toEqual(t(types.enum(["active", "inactive", "pending"])))
  })

  test("keyword without enum values stays a plain string", () => {
    expect(fromElasticsearchField({ type: "keyword" })).toEqual(t(types.string))
  })
})

describe("unrecognized field type", () => {
  test("degrades to unknown with esType recorded", () => {
    expect(fromElasticsearchField({ type: "completion" })).toEqual(t(types.unknown, { esType: "completion" }))
  })
})

describe("fromElasticsearch (mapping root)", () => {
  test("a complex real-world-ish mapping", () => {
    const mapping = {
      dynamic: "strict" as const,
      properties: {
        title: {
          type: "text",
          analyzer: "english",
          fields: {
            raw: { type: "keyword" },
          },
        },
        views: { type: "long" },
        rating: { type: "float" },
        published_at: { type: "date", format: "strict_date_optional_time" },
        status: { type: "keyword", enum: ["draft", "published", "archived"] },
        location: { type: "geo_point" },
        metadata: { type: "object", enabled: false },
        comments: {
          type: "nested",
          properties: {
            author: { type: "keyword" },
            body: { type: "text" },
          },
        },
        internal_notes: { type: "text", index: false },
      },
    }

    const result = fromElasticsearch(mapping)

    expect(result.meta.dynamic).toBe("strict")
    expect(result.shape.kind).toBe("object")
    const fields = (result.shape as { fields: Record<string, unknown> }).fields

    expect(fields.title).toEqual(
      t(types.string, {
        analyzer: "english",
        fields: { raw: t(types.string) },
      }),
    )
    expect(fields.views).toEqual(int64())
    expect(fields.rating).toEqual(float32())
    expect(fields.published_at).toEqual(datetime({ format: "strict_date_optional_time" }))
    expect(fields.status).toEqual(t(types.enum(["draft", "published", "archived"])))
    expect(fields.location).toEqual(
      t(
        types.object({
          lat: t(types.number),
          lon: t(types.number),
        }),
      ),
    )
    expect(fields.metadata).toEqual(t(types.unknown))
    expect(fields.comments).toEqual(
      t(
        types.array(
          t(
            types.object({
              author: t(types.string),
              body: t(types.string),
            }),
          ),
        ),
      ),
    )
    expect(fields.internal_notes).toEqual(t(types.string, { index: false }))
  })
})
