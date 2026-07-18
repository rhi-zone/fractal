import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toEffectSchema, toEffectSchemaDeclaration, toEffectSchemaDeclarations } from "./effect-schema.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toEffectSchema(t(types.boolean))).toBe("S.Boolean")
  })

  test("number", () => {
    expect(toEffectSchema(t(types.number))).toBe("S.Number")
  })

  test("integer", () => {
    expect(toEffectSchema(t(types.integer))).toBe("S.Int")
  })

  test("string", () => {
    expect(toEffectSchema(t(types.string))).toBe("S.String")
  })

  test("bytes", () => {
    expect(toEffectSchema(bytes())).toBe("S.String")
  })

  test("null", () => {
    expect(toEffectSchema(t(types.null))).toBe("S.Null")
  })

  test("void", () => {
    expect(toEffectSchema(t(types.void))).toBe("S.Void")
  })

  test("unknown", () => {
    expect(toEffectSchema(t(types.unknown))).toBe("S.Unknown")
  })

  test("never", () => {
    expect(toEffectSchema(t(types.never))).toBe("S.Never")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toEffectSchema(int32())).toBe("S.Int")
  })

  test("int64", () => {
    expect(toEffectSchema(int64())).toBe("S.Int")
  })

  test("float32", () => {
    expect(toEffectSchema(float32())).toBe("S.Number")
  })

  test("float64", () => {
    expect(toEffectSchema(float64())).toBe("S.Number")
  })

  test("uuid", () => {
    expect(toEffectSchema(uuid())).toBe("S.UUID")
  })

  test("uri", () => {
    expect(toEffectSchema(uri())).toBe("S.String")
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toEffectSchema(datetime())).toBe("S.DateFromString")
  })

  test("date", () => {
    expect(toEffectSchema(date())).toBe("S.DateFromString")
  })

  test("time", () => {
    expect(toEffectSchema(time())).toBe("S.String")
  })

  test("duration", () => {
    expect(toEffectSchema(duration())).toBe("S.String")
  })
})

describe("object", () => {
  test("required fields", () => {
    const ref = t(types.object({ name: t(types.string) }))
    expect(toEffectSchema(ref)).toBe("S.Struct({ name: S.String })")
  })

  test("optional field without default", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toEffectSchema(ref)).toBe("S.Struct({ name: S.String, nickname: S.optional(S.String) })")
  })

  test("optional field with default", () => {
    const ref = t(
      types.object({
        active: t(types.boolean, { optional: true, default: true }),
      }),
    )
    expect(toEffectSchema(ref)).toBe(
      "S.Struct({ active: S.optionalWith(S.Boolean, { default: () => true } as const) })",
    )
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toEffectSchema(ref)).toBe('S.Struct({ "not-an-ident": S.String })')
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toEffectSchema(ref)).toBe("S.Array(S.Int)")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toEffectSchema(ref)).toBe("S.Tuple(S.String, S.Int)")
  })
})

describe("map", () => {
  test("record", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toEffectSchema(ref)).toBe("S.Record({ key: S.String, value: S.Number })")
  })
})

describe("union", () => {
  test("union of variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toEffectSchema(ref)).toBe("S.Union(S.String, S.Int)")
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toEffectSchema(t(types.literal("active")))).toBe('S.Literal("active")')
  })

  test("number literal", () => {
    expect(toEffectSchema(t(types.literal(42)))).toBe("S.Literal(42)")
  })

  test("boolean literal", () => {
    expect(toEffectSchema(t(types.literal(true)))).toBe("S.Literal(true)")
  })

  test("null literal", () => {
    expect(toEffectSchema(t(types.literal(null)))).toBe("S.Literal(null)")
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toEffectSchema(ref)).toBe('S.Union(S.Literal("a"), S.Literal("b"), S.Literal("c"))')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toEffectSchema(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("leaf", () => {
    const ref = t(types.string, { nullable: true })
    expect(toEffectSchema(ref)).toBe("S.NullOr(S.String)")
  })

  test("complex type", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toEffectSchema(ref)).toBe("S.NullOr(S.Array(S.String))")
  })
})

describe("constraints", () => {
  test("string minLength/maxLength/pattern", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toEffectSchema(ref)).toBe("S.String.pipe(S.minLength(1), S.maxLength(10), S.pattern(/^[a-z]+$/))")
  })

  test("numeric minimum/maximum/multipleOf", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toEffectSchema(ref)).toBe(
      "S.Int.pipe(S.greaterThanOrEqualTo(0), S.lessThanOrEqualTo(100), S.multipleOf(5))",
    )
  })

  test("exclusiveMinimum/exclusiveMaximum use strict greaterThan/lessThan", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toEffectSchema(ref)).toBe("S.Int.pipe(S.greaterThan(0), S.lessThan(100))")
  })

  test("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 5 })
    expect(toEffectSchema(ref)).toBe("S.Array(S.String).pipe(S.minLength(1), S.maxLength(5))")
  })

  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toEffectSchema(ref)).toBe('S.String.annotations({ description: "a name" })')
  })

  test("nullable with description applies after NullOr wrap", () => {
    const ref = t(types.string, { nullable: true, description: "a name" })
    expect(toEffectSchema(ref)).toBe('S.NullOr(S.String).annotations({ description: "a name" })')
  })

  test("regex with forward slash in pattern", () => {
    const ref = t(types.string, { pattern: "a/b" })
    expect(toEffectSchema(ref)).toBe("S.String.pipe(S.pattern(/a\\/b/))")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toEffectSchema(ref)).toBe("S.Int")
  })

  test("no ancestor handler falls back to S.Unknown", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toEffectSchema(ref)).toBe("S.Unknown")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toEffectSchema(ref)).toBe("S.Struct({ ids: S.Array(S.UUID) })")
  })
})

describe("intersection", () => {
  test("all-object members chain S.extend left-associatively", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toEffectSchema(ref)).toBe(
      "S.extend(S.Struct({ id: S.String }), S.Struct({ createdAt: S.String }))",
    )
  })

  test("three all-object members nest left-associatively", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
        t(types.object({ name: t(types.string) })),
      ]),
    )
    expect(toEffectSchema(ref)).toBe(
      "S.extend(S.extend(S.Struct({ id: S.String }), S.Struct({ createdAt: S.String })), S.Struct({ name: S.String }))",
    )
  })

  test("non-object member falls back to the first member (lossy)", () => {
    const ref = t(types.intersection([t(types.string), t(types.object({ id: t(types.string) }))]))
    expect(toEffectSchema(ref)).toBe("S.String")
  })
})

describe("toEffectSchemaDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toEffectSchemaDeclaration("Age", t(types.integer))).toBe("const Age = S.Int;")
  })
})

describe("toEffectSchemaDeclarations", () => {
  test("emits import and multiple declarations", () => {
    const registry = {
      User: t(types.object({ id: uuid() })),
      Age: t(types.integer),
    }
    expect(toEffectSchemaDeclarations(registry)).toBe(
      [
        'import * as S from "@effect/schema/Schema";',
        "",
        "const User = S.Struct({ id: S.UUID });",
        "const Age = S.Int;",
      ].join("\n"),
    )
  })
})

describe("function", () => {
  test("degrades to S.Unknown (no callable-type schema)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toEffectSchema(ref)).toBe("S.Unknown")
  })
})
