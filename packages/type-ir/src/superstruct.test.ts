import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toSuperstruct, toSuperstructDeclaration, toSuperstructDeclarations } from "./superstruct.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toSuperstruct(t(types.boolean))).toBe("s.boolean()")
  })

  test("number", () => {
    expect(toSuperstruct(t(types.number))).toBe("s.number()")
  })

  test("integer", () => {
    expect(toSuperstruct(t(types.integer))).toBe("s.integer()")
  })

  test("string", () => {
    expect(toSuperstruct(t(types.string))).toBe("s.string()")
  })

  test("bytes", () => {
    expect(toSuperstruct(bytes())).toBe("s.string() /* base64 */")
  })

  test("null", () => {
    expect(toSuperstruct(t(types.null))).toBe("s.literal(null)")
  })

  test("void", () => {
    expect(toSuperstruct(t(types.void))).toBe("s.any() /* void */")
  })

  test("unknown", () => {
    expect(toSuperstruct(t(types.unknown))).toBe("s.unknown()")
  })

  test("never", () => {
    expect(toSuperstruct(t(types.never))).toBe("s.never()")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toSuperstruct(int32())).toBe("s.integer()")
  })

  test("int64", () => {
    expect(toSuperstruct(int64())).toBe("s.integer()")
  })

  test("float32", () => {
    expect(toSuperstruct(float32())).toBe("s.number()")
  })

  test("float64", () => {
    expect(toSuperstruct(float64())).toBe("s.number()")
  })

  test("uuid falls back to string with comment", () => {
    expect(toSuperstruct(uuid())).toBe("s.string() /* uuid */")
  })

  test("uri falls back to string with comment", () => {
    expect(toSuperstruct(uri())).toBe("s.string() /* uri */")
  })

})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toSuperstruct(datetime())).toBe("s.date()")
  })

  test("date", () => {
    expect(toSuperstruct(date())).toBe("s.date()")
  })

  test("time", () => {
    expect(toSuperstruct(time())).toBe("s.string() /* time */")
  })

  test("duration", () => {
    expect(toSuperstruct(duration())).toBe("s.string() /* duration */")
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
    expect(toSuperstruct(ref)).toBe("s.object({ name: s.string(), nickname: s.optional(s.string()) })")
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toSuperstruct(ref)).toBe('s.object({ "not-an-ident": s.string() })')
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toSuperstruct(ref)).toBe("s.array(s.integer())")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toSuperstruct(ref)).toBe("s.tuple([s.string(), s.integer()])")
  })
})

describe("map", () => {
  test("record with string key", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toSuperstruct(ref)).toBe("s.record(s.string(), s.number())")
  })
})

describe("union", () => {
  test("union of variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toSuperstruct(ref)).toBe("s.union([s.string(), s.integer()])")
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toSuperstruct(t(types.literal("active")))).toBe('s.literal("active")')
  })

  test("number literal", () => {
    expect(toSuperstruct(t(types.literal(42)))).toBe("s.literal(42)")
  })

  test("boolean literal", () => {
    expect(toSuperstruct(t(types.literal(true)))).toBe("s.literal(true)")
  })

  test("null literal", () => {
    expect(toSuperstruct(t(types.literal(null)))).toBe("s.literal(null)")
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toSuperstruct(ref)).toBe('s.enums(["a", "b", "c"])')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toSuperstruct(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("leaf", () => {
    const ref = t(types.string, { nullable: true })
    expect(toSuperstruct(ref)).toBe("s.nullable(s.string())")
  })

  test("complex type", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toSuperstruct(ref)).toBe("s.nullable(s.array(s.string()))")
  })
})

describe("constraints", () => {
  test("string minLength/maxLength wraps with s.size", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10 })
    expect(toSuperstruct(ref)).toBe("s.size(s.string(), 1, 10)")
  })

  test("string minLength only leaves maxLength unbounded", () => {
    const ref = t(types.string, { minLength: 1 })
    expect(toSuperstruct(ref)).toBe("s.size(s.string(), 1, Infinity)")
  })

  test("string maxLength only leaves minLength at 0", () => {
    const ref = t(types.string, { maxLength: 10 })
    expect(toSuperstruct(ref)).toBe("s.size(s.string(), 0, 10)")
  })

  test("string pattern", () => {
    const ref = t(types.string, { pattern: "^[a-z]+$" })
    expect(toSuperstruct(ref)).toBe("s.pattern(s.string(), /^[a-z]+$/)")
  })

  test("string minLength/maxLength/pattern combined", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toSuperstruct(ref)).toBe("s.pattern(s.size(s.string(), 1, 10), /^[a-z]+$/)")
  })

  test("numeric minimum/maximum", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100 })
    expect(toSuperstruct(ref)).toBe("s.max(s.min(s.integer(), 0), 100)")
  })

  test("numeric multipleOf uses s.refine", () => {
    const ref = t(types.integer, { multipleOf: 5 })
    expect(toSuperstruct(ref)).toBe('s.refine(s.integer(), "multipleOf", (value) => value % 5 === 0)')
  })

  test("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 5 })
    expect(toSuperstruct(ref)).toBe("s.size(s.array(s.string()), 1, 5)")
  })

  test("description is emitted as trailing comment", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toSuperstruct(ref)).toBe("s.string() /* a name */")
  })

  test("default wraps with s.defaulted", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toSuperstruct(ref)).toBe("s.defaulted(s.integer(), 0)")
  })

  test("regex with forward slash in pattern", () => {
    const ref = t(types.string, { pattern: "a/b" })
    expect(toSuperstruct(ref)).toBe("s.pattern(s.string(), /a\\/b/)")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toSuperstruct(ref)).toBe("s.integer()")
  })

  test("no ancestor handler falls back to s.unknown()", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toSuperstruct(ref)).toBe("s.unknown()")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toSuperstruct(ref)).toBe("s.object({ ids: s.array(s.string() /* uuid */) })")
  })
})

describe("intersection", () => {
  test("emits native s.intersection([...])", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toSuperstruct(ref)).toBe(
      "s.intersection([s.object({ id: s.string() }), s.object({ createdAt: s.string() })])",
    )
  })
})

describe("toSuperstructDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toSuperstructDeclaration("Age", t(types.integer))).toBe("const Age = s.integer();")
  })
})

describe("toSuperstructDeclarations", () => {
  test("emits import and multiple declarations", () => {
    const registry = {
      User: t(types.object({ id: uuid() })),
      Age: t(types.integer),
    }
    expect(toSuperstructDeclarations(registry)).toBe(
      [
        'import * as s from "superstruct";',
        "",
        "const User = s.object({ id: s.string() /* uuid */ });",
        "const Age = s.integer();",
      ].join("\n"),
    )
  })
})

describe("function", () => {
  test("degrades to s.unknown() (no callable-value validator)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toSuperstruct(ref)).toBe("s.unknown()")
  })
})

describe("stream", () => {
  test("degrades to s.array() of the element type", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toSuperstruct(ref)).toBe("s.array(s.integer())")
  })
})
