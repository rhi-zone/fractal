import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toRuntypes, toRuntypesDeclaration, toRuntypesDeclarations } from "./runtypes.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toRuntypes(t(types.boolean))).toBe("R.Boolean")
  })

  test("number", () => {
    expect(toRuntypes(t(types.number))).toBe("R.Number")
  })

  test("integer", () => {
    expect(toRuntypes(t(types.integer))).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer")',
    )
  })

  test("string", () => {
    expect(toRuntypes(t(types.string))).toBe("R.String")
  })

  test("bytes", () => {
    expect(toRuntypes(bytes())).toBe("R.String /* bytes, base64 */")
  })

  test("null", () => {
    expect(toRuntypes(t(types.null))).toBe("R.Null")
  })

  test("void", () => {
    expect(toRuntypes(t(types.void))).toBe("R.Undefined")
  })

  test("unknown", () => {
    expect(toRuntypes(t(types.unknown))).toBe("R.Unknown")
  })

  test("never", () => {
    expect(toRuntypes(t(types.never))).toBe("R.Never")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toRuntypes(int32())).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer")',
    )
  })

  test("int64", () => {
    expect(toRuntypes(int64())).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer")',
    )
  })

  test("float32", () => {
    expect(toRuntypes(float32())).toBe("R.Number")
  })

  test("float64", () => {
    expect(toRuntypes(float64())).toBe("R.Number")
  })

  test("uuid", () => {
    expect(toRuntypes(uuid())).toBe("R.String /* uuid */")
  })

  test("uri", () => {
    expect(toRuntypes(uri())).toBe("R.String /* uri */")
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toRuntypes(datetime())).toBe("R.String /* datetime */")
  })

  test("date", () => {
    expect(toRuntypes(date())).toBe("R.String /* date */")
  })

  test("time", () => {
    expect(toRuntypes(time())).toBe("R.String /* time */")
  })

  test("duration", () => {
    expect(toRuntypes(duration())).toBe("R.String /* duration */")
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
    expect(toRuntypes(ref)).toBe("R.Record({ name: R.String, nickname: R.String.optional() })")
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toRuntypes(ref)).toBe('R.Record({ "not-an-ident": R.String })')
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toRuntypes(ref)).toBe(
      'R.Array(R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer"))',
    )
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toRuntypes(ref)).toBe(
      'R.Tuple(R.String, R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer"))',
    )
  })
})

describe("map", () => {
  test("dictionary", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toRuntypes(ref)).toBe("R.Dictionary(R.Number, R.String)")
  })
})

describe("union", () => {
  test("union of variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toRuntypes(ref)).toBe(
      'R.Union(R.String, R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer"))',
    )
  })
})

describe("intersection", () => {
  test("uses native R.Intersect(...) for any arity", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toRuntypes(ref)).toBe("R.Intersect(R.Record({ id: R.String }), R.Record({ createdAt: R.String }))")
  })

  test("three-way intersection stays a single flat R.Intersect(...)", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
        t(types.object({ name: t(types.string) })),
      ]),
    )
    expect(toRuntypes(ref)).toBe(
      "R.Intersect(R.Record({ id: R.String }), R.Record({ createdAt: R.String }), R.Record({ name: R.String }))",
    )
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toRuntypes(t(types.literal("active")))).toBe('R.Literal("active")')
  })

  test("number literal", () => {
    expect(toRuntypes(t(types.literal(42)))).toBe("R.Literal(42)")
  })

  test("boolean literal", () => {
    expect(toRuntypes(t(types.literal(true)))).toBe("R.Literal(true)")
  })

  test("null literal", () => {
    expect(toRuntypes(t(types.literal(null)))).toBe("R.Literal(null)")
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toRuntypes(ref)).toBe('R.Union(R.Literal("a"), R.Literal("b"), R.Literal("c"))')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toRuntypes(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("leaf", () => {
    const ref = t(types.string, { nullable: true })
    expect(toRuntypes(ref)).toBe("R.String.nullable()")
  })

  test("complex type", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toRuntypes(ref)).toBe("R.Array(R.String).nullable()")
  })
})

describe("constraints", () => {
  test("string minLength/maxLength/pattern", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toRuntypes(ref)).toBe(
      'R.String.withConstraint((v) => v.length >= 1 || "length must be >= 1")' +
        '.withConstraint((v) => v.length <= 10 || "length must be <= 10")' +
        '.withConstraint((v) => /^[a-z]+$/.test(v) || "must match ^[a-z]+$")',
    )
  })

  test("numeric minimum/maximum/multipleOf", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toRuntypes(ref)).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer")' +
        '.withConstraint((n) => n >= 0 || "must be >= 0")' +
        '.withConstraint((n) => n <= 100 || "must be <= 100")' +
        '.withConstraint((n) => n % 5 === 0 || "must be a multiple of 5")',
    )
  })

  test("exclusiveMinimum/exclusiveMaximum use strict > / < comparisons", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toRuntypes(ref)).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer")' +
        '.withConstraint((n) => n > 0 || "must be > 0")' +
        '.withConstraint((n) => n < 100 || "must be < 100")',
    )
  })

  test("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 5 })
    expect(toRuntypes(ref)).toBe(
      'R.Array(R.String).withConstraint((v) => v.length >= 1 || "length must be >= 1")' +
        '.withConstraint((v) => v.length <= 5 || "length must be <= 5")',
    )
  })

  test("description falls back to a comment", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toRuntypes(ref)).toBe("R.String /* a name */")
  })

  test("default falls back to a comment", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toRuntypes(ref)).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer") /* default: 0 */',
    )
  })

  test("regex with forward slash in pattern", () => {
    const ref = t(types.string, { pattern: "a/b" })
    expect(toRuntypes(ref)).toBe('R.String.withConstraint((v) => /a\\/b/.test(v) || "must match a/b")')
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toRuntypes(ref)).toBe(
      'R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer")',
    )
  })

  test("no ancestor handler falls back to R.Unknown", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toRuntypes(ref)).toBe("R.Unknown")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toRuntypes(ref)).toBe("R.Record({ ids: R.Array(R.String /* uuid */) })")
  })
})

describe("toRuntypesDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toRuntypesDeclaration("Age", t(types.integer))).toBe(
      'const Age = R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer");',
    )
  })
})

describe("toRuntypesDeclarations", () => {
  test("emits import and multiple declarations", () => {
    const registry = {
      User: t(types.object({ id: uuid() })),
      Age: t(types.integer),
    }
    expect(toRuntypesDeclarations(registry)).toBe(
      [
        'import * as R from "runtypes";',
        "",
        "const User = R.Record({ id: R.String /* uuid */ });",
        'const Age = R.Number.withConstraint((n) => Number.isInteger(n) || "must be an integer");',
      ].join("\n"),
    )
  })
})

describe("function", () => {
  test("degrades to R.Unknown (no callable-value runtype)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toRuntypes(ref)).toBe("R.Unknown")
  })
})
