import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { toArkType, toArkTypeDeclaration, toArkTypeDeclarations } from "./arktype.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toArkType(t(types.boolean))).toBe('type("boolean")')
  })

  test("number", () => {
    expect(toArkType(t(types.number))).toBe('type("number")')
  })

  test("integer", () => {
    expect(toArkType(t(types.integer))).toBe('type("number.integer")')
  })

  test("string", () => {
    expect(toArkType(t(types.string))).toBe('type("string")')
  })

  test("bytes", () => {
    expect(toArkType(t(types.bytes))).toBe('type("string")')
  })

  test("null", () => {
    expect(toArkType(t(types.null))).toBe('type("null")')
  })

  test("void", () => {
    expect(toArkType(t(types.void))).toBe('type("void")')
  })

  test("unknown", () => {
    expect(toArkType(t(types.unknown))).toBe('type("unknown")')
  })

  test("never", () => {
    expect(toArkType(t(types.never))).toBe('type("never")')
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toArkType(t(types.int32))).toBe('type("number.integer")')
  })

  test("int64", () => {
    expect(toArkType(t(types.int64))).toBe('type("number.integer")')
  })

  test("float32", () => {
    expect(toArkType(t(types.float32))).toBe('type("number")')
  })

  test("float64", () => {
    expect(toArkType(t(types.float64))).toBe('type("number")')
  })

  test("uuid", () => {
    expect(toArkType(t(types.uuid))).toBe('type("string")')
  })

  test("uri", () => {
    expect(toArkType(t(types.uri))).toBe('type("string")')
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toArkType(t(types.datetime))).toBe('type("string")')
  })

  test("date", () => {
    expect(toArkType(t(types.date))).toBe('type("string")')
  })

  test("time", () => {
    expect(toArkType(t(types.time))).toBe('type("string")')
  })

  test("duration", () => {
    expect(toArkType(t(types.duration))).toBe('type("string")')
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
    expect(toArkType(ref)).toBe('type({ name: "string", "nickname?": "string" })')
  })

  test("no optional marker when all fields required", () => {
    const ref = t(types.object({ id: t(types.uuid) }))
    expect(toArkType(ref)).toBe('type({ id: "string" })')
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toArkType(ref)).toBe('type({ "not-an-ident": "string" })')
  })
})

describe("array", () => {
  test("simple element uses string syntax", () => {
    const ref = t(types.array(t(types.string)))
    expect(toArkType(ref)).toBe('type("string[]")')
  })

  test("complex element uses type.array", () => {
    const ref = t(types.array(t(types.object({ id: t(types.string) }))))
    expect(toArkType(ref)).toBe('type.array({ id: "string" })')
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toArkType(ref)).toBe('type(["string", "number.integer"])')
  })
})

describe("map", () => {
  test("simple value uses Record syntax", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toArkType(ref)).toBe('type("Record<string, number>")')
  })

  test("complex value falls back to unknown", () => {
    const ref = t(types.map(t(types.string), t(types.object({ id: t(types.string) }))))
    expect(toArkType(ref)).toBe('type("Record<string, unknown>")')
  })
})

describe("union", () => {
  test("simple variants use string syntax", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toArkType(ref)).toBe('type("string | number.integer")')
  })

  test("complex variants use type.or", () => {
    const ref = t(
      types.union([t(types.object({ id: t(types.string) })), t(types.object({ code: t(types.integer) }))]),
    )
    expect(toArkType(ref)).toBe('type.or(type({ id: "string" }), type({ code: "number.integer" }))')
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toArkType(t(types.literal("active")))).toBe(`type("'active'")`)
  })

  test("number literal", () => {
    expect(toArkType(t(types.literal(42)))).toBe('type("42")')
  })

  test("boolean literal", () => {
    expect(toArkType(t(types.literal(true)))).toBe('type("true")')
  })

  test("null literal", () => {
    expect(toArkType(t(types.literal(null)))).toBe('type("null")')
  })
})

describe("enum", () => {
  test("enum members become union of string literals", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toArkType(ref)).toBe(`type("'a' | 'b' | 'c'")`)
  })
})

describe("ref", () => {
  test("target name, unwrapped", () => {
    expect(toArkType(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("simple type appends | null inline", () => {
    const ref = t(types.string, { nullable: true })
    expect(toArkType(ref)).toBe('type("string | null")')
  })

  test("complex type uses type.or", () => {
    const ref = t(types.object({ id: t(types.string) }), { nullable: true })
    expect(toArkType(ref)).toBe('type.or(type({ id: "string" }), type("null"))')
  })
})

describe("constraints", () => {
  test("minimum", () => {
    const ref = t(types.number, { minimum: 0 })
    expect(toArkType(ref)).toBe('type("number >= 0")')
  })

  test("maximum", () => {
    const ref = t(types.number, { maximum: 100 })
    expect(toArkType(ref)).toBe('type("number <= 100")')
  })

  test("minLength", () => {
    const ref = t(types.string, { minLength: 1 })
    expect(toArkType(ref)).toBe('type("string >= 1")')
  })

  test("maxLength", () => {
    const ref = t(types.string, { maxLength: 10 })
    expect(toArkType(ref)).toBe('type("string <= 10")')
  })

  test("pattern uses .matching()", () => {
    const ref = t(types.string, { pattern: "^[a-z]+$" })
    expect(toArkType(ref)).toBe('type("string").matching(/^[a-z]+$/)')
  })

  test("pattern escapes forward slashes", () => {
    const ref = t(types.string, { pattern: "a/b" })
    expect(toArkType(ref)).toBe('type("string").matching(/a\\/b/)')
  })

  test("complex type constraints are dropped (lossy)", () => {
    const ref = t(types.object({ id: t(types.string) }), { minLength: 1 })
    expect(toArkType(ref)).toBe('type({ id: "string" })')
  })

  test("multipleOf uses the % divisibility operator", () => {
    const ref = t(types.number, { multipleOf: 2 })
    expect(toArkType(ref)).toBe('type("number % 2")')
  })

  test("description uses .describe()", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toArkType(ref)).toBe('type("string").describe("a name")')
  })

  test("default uses .default()", () => {
    const ref = t(types.string, { default: "hi" })
    expect(toArkType(ref)).toBe('type("string").default("hi")')
  })

  test("description and default chain after constraints", () => {
    const ref = t(types.number, { minimum: 0, description: "count", default: 0 })
    expect(toArkType(ref)).toBe('type("number >= 0").describe("count").default(0)')
  })

  test("pattern is applied to nested object fields, not just the top level", () => {
    const ref = t(types.object({ name: t(types.string, { pattern: "^[a-z]+$" }) }))
    expect(toArkType(ref)).toBe('type({ name: type("string").matching(/^[a-z]+$/) })')
  })

  test("description is applied to nested array elements", () => {
    const ref = t(types.array(t(types.string, { description: "item" })))
    expect(toArkType(ref)).toBe('type.array(type("string").describe("item"))')
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toArkType(ref)).toBe('type("number.integer")')
  })

  test("no ancestor handler falls back to unknown", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toArkType(ref)).toBe('type("unknown")')
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(t(types.uuid))),
      }),
    )
    expect(toArkType(ref)).toBe('type({ ids: "string[]" })')
  })
})

describe("intersection", () => {
  test("word-mode members join with &", () => {
    const ref = t(types.intersection([t(types.string), t(types.number)]))
    expect(toArkType(ref)).toBe('type("string & number")')
  })

  test("non-word-mode members use type.and(...)", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toArkType(ref)).toBe('type.and(type({ id: "string" }), type({ createdAt: "string" }))')
  })

  test("empty members fall back to unknown", () => {
    expect(toArkType(t(types.intersection([])))).toBe('type("unknown")')
  })
})

describe("toArkTypeDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toArkTypeDeclaration("Age", t(types.integer))).toBe('const Age = type("number.integer");')
  })
})

describe("toArkTypeDeclarations", () => {
  test("emits import and multiple declarations", () => {
    const registry = {
      User: t(types.object({ id: t(types.uuid) })),
      Age: t(types.integer),
    }
    expect(toArkTypeDeclarations(registry)).toBe(
      [
        'import { type } from "arktype";',
        "",
        'const User = type({ id: "string" });',
        'const Age = type("number.integer");',
      ].join("\n"),
    )
  })
})
