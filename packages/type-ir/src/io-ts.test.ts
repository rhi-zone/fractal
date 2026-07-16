import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { toIoTs, toIoTsDeclaration, toIoTsDeclarations } from "./io-ts.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toIoTs(t(types.boolean))).toBe("t.boolean")
  })

  test("number", () => {
    expect(toIoTs(t(types.number))).toBe("t.number")
  })

  test("string", () => {
    expect(toIoTs(t(types.string))).toBe("t.string")
  })

  test("null", () => {
    expect(toIoTs(t(types.null))).toBe("t.null")
  })

  test("void", () => {
    expect(toIoTs(t(types.void))).toBe("t.void")
  })

  test("unknown", () => {
    expect(toIoTs(t(types.unknown))).toBe("t.unknown")
  })

  test("never", () => {
    expect(toIoTs(t(types.never))).toBe("t.never")
  })
})

describe("number subtypes fall back to t.number with a comment", () => {
  test("integer", () => {
    expect(toIoTs(t(types.integer))).toBe("t.number /* integer */")
  })

  test("int32", () => {
    expect(toIoTs(t(types.int32))).toBe("t.number /* int32 */")
  })

  test("int64", () => {
    expect(toIoTs(t(types.int64))).toBe("t.number /* int64 */")
  })

  test("float32", () => {
    expect(toIoTs(t(types.float32))).toBe("t.number /* float32 */")
  })

  test("float64", () => {
    expect(toIoTs(t(types.float64))).toBe("t.number /* float64 */")
  })
})

describe("string subtypes fall back to t.string with a comment", () => {
  test("uuid", () => {
    expect(toIoTs(t(types.uuid))).toBe("t.string /* uuid */")
  })

  test("uri", () => {
    expect(toIoTs(t(types.uri))).toBe("t.string /* uri */")
  })

  test("datetime", () => {
    expect(toIoTs(t(types.datetime))).toBe("t.string /* datetime */")
  })

  test("date", () => {
    expect(toIoTs(t(types.date))).toBe("t.string /* date */")
  })

  test("time", () => {
    expect(toIoTs(t(types.time))).toBe("t.string /* time */")
  })

  test("duration", () => {
    expect(toIoTs(t(types.duration))).toBe("t.string /* duration */")
  })

  test("bytes", () => {
    expect(toIoTs(t(types.bytes))).toBe("t.string /* bytes */")
  })
})

describe("object", () => {
  test("all required fields use t.type", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    expect(toIoTs(ref)).toBe("t.type({ name: t.string, age: t.number /* integer */ })")
  })

  test("all optional fields use t.partial", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toIoTs(ref)).toBe("t.partial({ nickname: t.string })")
  })

  test("mixed required and optional fields combine via t.intersection", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        nickname: t(types.string, { optional: true }),
      }),
    )
    expect(toIoTs(ref)).toBe(
      "t.intersection([t.type({ name: t.string }), t.partial({ nickname: t.string })])",
    )
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toIoTs(ref)).toBe('t.type({ "not-an-ident": t.string })')
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.string)))
    expect(toIoTs(ref)).toBe("t.array(t.string)")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toIoTs(ref)).toBe("t.tuple([t.string, t.number /* integer */])")
  })
})

describe("map", () => {
  test("record with string domain", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toIoTs(ref)).toBe("t.record(t.string, t.number)")
  })
})

describe("union", () => {
  test("union of variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toIoTs(ref)).toBe("t.union([t.string, t.number /* integer */])")
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toIoTs(t(types.literal("active")))).toBe('t.literal("active")')
  })

  test("number literal", () => {
    expect(toIoTs(t(types.literal(42)))).toBe("t.literal(42)")
  })

  test("boolean literal", () => {
    expect(toIoTs(t(types.literal(true)))).toBe("t.literal(true)")
  })

  test("null literal falls back to t.null (io-ts literal excludes null)", () => {
    expect(toIoTs(t(types.literal(null)))).toBe("t.null")
  })
})

describe("enum", () => {
  test("members become t.keyof keys", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toIoTs(ref)).toBe("t.keyof({ a: null, b: null, c: null })")
  })

  test("quotes non-identifier members", () => {
    const ref = t(types.enum(["not-an-ident"]))
    expect(toIoTs(ref)).toBe('t.keyof({ "not-an-ident": null })')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toIoTs(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("leaf", () => {
    const ref = t(types.string, { nullable: true })
    expect(toIoTs(ref)).toBe("t.union([t.string, t.null])")
  })

  test("complex type", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toIoTs(ref)).toBe("t.union([t.array(t.string), t.null])")
  })

  test("combines with a subtype comment", () => {
    const ref = t(types.uuid, { nullable: true })
    expect(toIoTs(ref)).toBe("t.union([t.string /* uuid */, t.null])")
  })
})

describe("constraints render as comments (io-ts has no runtime constraint codecs)", () => {
  test("string minLength/maxLength/pattern", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toIoTs(ref)).toBe('t.string /* minLength: 1, maxLength: 10, pattern: "^[a-z]+$" */')
  })

  test("numeric minimum/maximum/multipleOf", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toIoTs(ref)).toBe("t.number /* integer, minimum: 0, maximum: 100, multipleOf: 5 */")
  })

  test("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 5 })
    expect(toIoTs(ref)).toBe("t.array(t.string) /* minLength: 1, maxLength: 5 */")
  })

  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toIoTs(ref)).toBe('t.string /* description: "a name" */')
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toIoTs(ref)).toBe("t.number /* integer, default: 0 */")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toIoTs(ref)).toBe("t.number /* integer */")
  })

  test("no ancestor handler falls back to t.unknown", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toIoTs(ref)).toBe("t.unknown")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(t(types.uuid))),
      }),
    )
    expect(toIoTs(ref)).toBe("t.type({ ids: t.array(t.string /* uuid */) })")
  })
})

describe("toIoTsDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toIoTsDeclaration("Age", t(types.integer))).toBe("const Age = t.number /* integer */;")
  })
})

describe("toIoTsDeclarations", () => {
  test("emits import and multiple declarations", () => {
    const registry = {
      User: t(types.object({ id: t(types.uuid) })),
      Age: t(types.integer),
    }
    expect(toIoTsDeclarations(registry)).toBe(
      [
        'import * as t from "io-ts";',
        "",
        "const User = t.type({ id: t.string /* uuid */ });",
        "const Age = t.number /* integer */;",
      ].join("\n"),
    )
  })
})
