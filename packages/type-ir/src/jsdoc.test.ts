import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { toJsDocType, toJsDocTypedef, toJsDocTypedefs } from "./jsdoc.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toJsDocType(t(types.boolean))).toBe("boolean")
  })

  test("number", () => {
    expect(toJsDocType(t(types.number))).toBe("number")
  })

  test("integer", () => {
    expect(toJsDocType(t(types.integer))).toBe("number")
  })

  test("int32", () => {
    expect(toJsDocType(t(types.int32))).toBe("number")
  })

  test("int64", () => {
    expect(toJsDocType(t(types.int64))).toBe("number")
  })

  test("float32", () => {
    expect(toJsDocType(t(types.float32))).toBe("number")
  })

  test("float64", () => {
    expect(toJsDocType(t(types.float64))).toBe("number")
  })

  test("string", () => {
    expect(toJsDocType(t(types.string))).toBe("string")
  })

  test("uuid", () => {
    expect(toJsDocType(t(types.uuid))).toBe("string")
  })

  test("uri", () => {
    expect(toJsDocType(t(types.uri))).toBe("string")
  })

  test("datetime", () => {
    expect(toJsDocType(t(types.datetime))).toBe("string")
  })

  test("date", () => {
    expect(toJsDocType(t(types.date))).toBe("string")
  })

  test("time", () => {
    expect(toJsDocType(t(types.time))).toBe("string")
  })

  test("duration", () => {
    expect(toJsDocType(t(types.duration))).toBe("string")
  })

  test("bytes", () => {
    expect(toJsDocType(t(types.bytes))).toBe("string")
  })

  test("null", () => {
    expect(toJsDocType(t(types.null))).toBe("null")
  })

  test("void", () => {
    expect(toJsDocType(t(types.void))).toBe("void")
  })

  test("unknown", () => {
    expect(toJsDocType(t(types.unknown))).toBe("*")
  })

  test("never", () => {
    expect(toJsDocType(t(types.never))).toBe("never")
  })
})

describe("nullable", () => {
  test("prefixes with ?", () => {
    expect(toJsDocType(t(types.string, { nullable: true }))).toBe("?string")
  })

  test("prefixes complex types too", () => {
    expect(toJsDocType(t(types.array(t(types.string)), { nullable: true }))).toBe("?Array.<string>")
  })
})

describe("object", () => {
  test("empty object", () => {
    expect(toJsDocType(t(types.object({})))).toBe("Object.<string, *>")
  })

  test("inline record of fields", () => {
    const ref = t(types.object({ name: t(types.string), age: t(types.integer) }))
    expect(toJsDocType(ref)).toBe("{name: string, age: number}")
  })
})

describe("array", () => {
  test("Array.<element>", () => {
    expect(toJsDocType(t(types.array(t(types.string))))).toBe("Array.<string>")
  })
})

describe("tuple", () => {
  test("lossy union of element types", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toJsDocType(ref)).toBe("Array.<string|number>")
  })

  test("deduplicates identical element types", () => {
    const ref = t(types.tuple([t(types.string), t(types.string)]))
    expect(toJsDocType(ref)).toBe("Array.<string>")
  })
})

describe("map", () => {
  test("Object.<string, value>", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toJsDocType(ref)).toBe("Object.<string, number>")
  })
})

describe("union", () => {
  test("parenthesized union", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toJsDocType(ref)).toBe("(string|number)")
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toJsDocType(t(types.literal("active")))).toBe('"active"')
  })

  test("number literal", () => {
    expect(toJsDocType(t(types.literal(42)))).toBe("42")
  })

  test("boolean literal true", () => {
    expect(toJsDocType(t(types.literal(true)))).toBe("true")
  })

  test("boolean literal false", () => {
    expect(toJsDocType(t(types.literal(false)))).toBe("false")
  })

  test("null literal", () => {
    expect(toJsDocType(t(types.literal(null)))).toBe("null")
  })
})

describe("enum", () => {
  test("union of quoted members", () => {
    expect(toJsDocType(t(types.enum(["a", "b", "c"])))).toBe('("a"|"b"|"c")')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toJsDocType(t(types.ref("User")))).toBe("User")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toJsDocType(ref)).toBe("number")
  })

  test("falls back to * when no ancestor is registered", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toJsDocType(ref)).toBe("*")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(types.object({ ids: t(types.array(t(types.uuid))) }))
    expect(toJsDocType(ref)).toBe("{ids: Array.<string>}")
  })

  test("array of objects", () => {
    const ref = t(types.array(t(types.object({ name: t(types.string) }))))
    expect(toJsDocType(ref)).toBe("Array.<{name: string}>")
  })
})

describe("toJsDocTypedef", () => {
  test("non-object type produces single-line typedef", () => {
    expect(toJsDocTypedef("UserId", t(types.uuid))).toBe("/** @typedef {string} UserId */")
  })

  test("non-object type with description", () => {
    const ref = t(types.string, { description: "a display name" })
    expect(toJsDocTypedef("DisplayName", ref)).toBe("/** @typedef {string} DisplayName a display name */")
  })

  test("object produces @typedef with @property entries", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer, { optional: true }),
        roles: t(types.array(t(types.string))),
      }),
    )
    expect(toJsDocTypedef("UserInput", ref)).toBe(
      [
        "/**",
        " * @typedef {Object} UserInput",
        " * @property {string} name",
        " * @property {number} [age] - optional",
        " * @property {Array.<string>} roles",
        " */",
      ].join("\n"),
    )
  })

  test("object typedef with description on the typedef and a field", () => {
    const ref = t(
      types.object({
        id: t(types.uuid, { description: "primary key" }),
      }),
      { description: "A widget." },
    )
    expect(toJsDocTypedef("Widget", ref)).toBe(
      [
        "/**",
        " * @typedef {Object} Widget A widget.",
        " * @property {string} id - primary key",
        " */",
      ].join("\n"),
    )
  })

  test("optional field with explicit description prefers description over 'optional'", () => {
    const ref = t(
      types.object({
        nickname: t(types.string, { optional: true, description: "a nickname" }),
      }),
    )
    expect(toJsDocTypedef("Named", ref)).toBe(
      ["/**", " * @typedef {Object} Named", " * @property {string} [nickname] - a nickname", " */"].join("\n"),
    )
  })
})

describe("toJsDocTypedefs", () => {
  test("generates multiple typedef blocks joined by blank lines", () => {
    const registry = {
      UserId: t(types.uuid),
      User: t(types.object({ id: t(types.ref("UserId")) })),
    }
    expect(toJsDocTypedefs(registry)).toBe(
      [
        "/** @typedef {string} UserId */",
        "",
        "/**",
        " * @typedef {Object} User",
        " * @property {UserId} id",
        " */",
      ].join("\n"),
    )
  })
})
