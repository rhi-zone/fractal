import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toTypeBox, toTypeBoxDeclaration, toTypeBoxDeclarations } from "./typebox.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toTypeBox(t(types.boolean))).toBe("Type.Boolean()")
  })

  test("number", () => {
    expect(toTypeBox(t(types.number))).toBe("Type.Number()")
  })

  test("integer", () => {
    expect(toTypeBox(t(types.integer))).toBe("Type.Integer()")
  })

  test("string", () => {
    expect(toTypeBox(t(types.string))).toBe("Type.String()")
  })

  test("bytes", () => {
    expect(toTypeBox(bytes())).toBe('Type.String({ contentEncoding: "base64" })')
  })

  test("null", () => {
    expect(toTypeBox(t(types.null))).toBe("Type.Null()")
  })

  test("void", () => {
    expect(toTypeBox(t(types.void))).toBe("Type.Void()")
  })

  test("unknown", () => {
    expect(toTypeBox(t(types.unknown))).toBe("Type.Unknown()")
  })

  test("never", () => {
    expect(toTypeBox(t(types.never))).toBe("Type.Never()")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toTypeBox(int32())).toBe('Type.Integer({ format: "int32" })')
  })

  test("int64", () => {
    expect(toTypeBox(int64())).toBe('Type.Integer({ format: "int64" })')
  })

  test("float32", () => {
    expect(toTypeBox(float32())).toBe('Type.Number({ format: "float" })')
  })

  test("float64", () => {
    expect(toTypeBox(float64())).toBe('Type.Number({ format: "double" })')
  })

  test("uuid", () => {
    expect(toTypeBox(uuid())).toBe('Type.String({ format: "uuid" })')
  })

  test("uri", () => {
    expect(toTypeBox(uri())).toBe('Type.String({ format: "uri" })')
  })

  test("email", () => {
    expect(toTypeBox(email())).toBe('Type.String({ format: "email" })')
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toTypeBox(datetime())).toBe("Type.Date()")
  })

  test("date", () => {
    expect(toTypeBox(date())).toBe("Type.Date()")
  })

  test("time", () => {
    expect(toTypeBox(time())).toBe('Type.String({ format: "time" })')
  })

  test("duration", () => {
    expect(toTypeBox(duration())).toBe('Type.String({ format: "duration" })')
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
    expect(toTypeBox(ref)).toBe(
      "Type.Object({ name: Type.String(), nickname: Type.Optional(Type.String()) })",
    )
  })

  test("readonly field wraps in Type.Readonly", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toTypeBox(ref)).toBe("Type.Object({ id: Type.Readonly(Type.String()) })")
  })

  test("optional and readonly field composes Type.Optional(Type.Readonly(...))", () => {
    const ref = t(types.object({ id: t(types.string, { optional: true, readonly: true }) }))
    expect(toTypeBox(ref)).toBe("Type.Object({ id: Type.Optional(Type.Readonly(Type.String())) })")
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toTypeBox(ref)).toBe("Type.Array(Type.Integer())")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toTypeBox(ref)).toBe("Type.Tuple([Type.String(), Type.Integer()])")
  })
})

describe("map", () => {
  test("record", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toTypeBox(ref)).toBe("Type.Record(Type.String(), Type.Number())")
  })
})

describe("union", () => {
  test("variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toTypeBox(ref)).toBe("Type.Union([Type.String(), Type.Integer()])")
  })
})

describe("intersection", () => {
  test("uses native Type.Intersect([...]) for any arity", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toTypeBox(ref)).toBe(
      "Type.Intersect([Type.Object({ id: Type.String() }), Type.Object({ createdAt: Type.String() })])",
    )
  })

  test("three-way intersection stays a single flat Type.Intersect([...])", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
        t(types.object({ name: t(types.string) })),
      ]),
    )
    expect(toTypeBox(ref)).toBe(
      "Type.Intersect([Type.Object({ id: Type.String() }), Type.Object({ createdAt: Type.String() }), Type.Object({ name: Type.String() })])",
    )
  })
})

describe("literal", () => {
  test("string", () => {
    expect(toTypeBox(t(types.literal("active")))).toBe('Type.Literal("active")')
  })

  test("number", () => {
    expect(toTypeBox(t(types.literal(42)))).toBe("Type.Literal(42)")
  })

  test("boolean", () => {
    expect(toTypeBox(t(types.literal(true)))).toBe("Type.Literal(true)")
  })

  test("null", () => {
    expect(toTypeBox(t(types.literal(null)))).toBe("Type.Literal(null)")
  })
})

describe("enum", () => {
  test("union of literals", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toTypeBox(ref)).toBe('Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")])')
  })
})

describe("ref", () => {
  test("Type.Ref", () => {
    expect(toTypeBox(t(types.ref("User")))).toBe("Type.Ref(User)")
  })
})

describe("nullable", () => {
  test("leaf wraps in union with null", () => {
    const ref = t(types.string, { nullable: true })
    expect(toTypeBox(ref)).toBe("Type.Union([Type.String(), Type.Null()])")
  })

  test("complex type wraps in union with null", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toTypeBox(ref)).toBe("Type.Union([Type.Array(Type.String()), Type.Null()])")
  })
})

describe("options object", () => {
  test("string constraints", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 100 })
    expect(toTypeBox(ref)).toBe("Type.String({ minLength: 1, maxLength: 100 })")
  })

  test("numeric constraints", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toTypeBox(ref)).toBe("Type.Integer({ minimum: 0, maximum: 100, multipleOf: 5 })")
  })

  test("pattern", () => {
    const ref = t(types.string, { pattern: "^[a-z]+$" })
    expect(toTypeBox(ref)).toBe('Type.String({ pattern: "^[a-z]+$" })')
  })

  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toTypeBox(ref)).toBe('Type.String({ description: "a name" })')
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toTypeBox(ref)).toBe("Type.Integer({ default: 0 })")
  })

  test("exclusiveMinimum / exclusiveMaximum", () => {
    const ref = t(types.integer, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toTypeBox(ref)).toBe("Type.Integer({ exclusiveMinimum: 0, exclusiveMaximum: 100 })")
  })

  test("deprecated", () => {
    const ref = t(types.string, { deprecated: true })
    expect(toTypeBox(ref)).toBe("Type.String({ deprecated: true })")
  })

  test("readOnly", () => {
    const ref = t(types.string, { readOnly: true })
    expect(toTypeBox(ref)).toBe("Type.String({ readOnly: true })")
  })

  test("writeOnly", () => {
    const ref = t(types.string, { writeOnly: true })
    expect(toTypeBox(ref)).toBe("Type.String({ writeOnly: true })")
  })

  test("examples", () => {
    const ref = t(types.string, { examples: ["a", "b"] })
    expect(toTypeBox(ref)).toBe('Type.String({ examples: ["a","b"] })')
  })

  test("$comment", () => {
    const ref = t(types.string, { $comment: "internal note" })
    expect(toTypeBox(ref)).toBe('Type.String({ $comment: "internal note" })')
  })

  test("format combined with meta constraints", () => {
    const ref = uuid({ description: "the id" })
    expect(toTypeBox(ref)).toBe('Type.String({ format: "uuid", description: "the id" })')
  })

  test("no options object when no constraints present", () => {
    const ref = t(types.string, {})
    expect(toTypeBox(ref)).toBe("Type.String()")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toTypeBox(ref)).toBe("Type.Integer()")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toTypeBox(ref)).toBe('Type.Object({ ids: Type.Array(Type.String({ format: "uuid" })) })')
  })
})

describe("declarations", () => {
  test("toTypeBoxDeclaration", () => {
    expect(toTypeBoxDeclaration("Name", t(types.string))).toBe("const Name = Type.String();")
  })

  test("toTypeBoxDeclarations", () => {
    const registry = {
      Name: t(types.string),
      Age: t(types.integer),
    }
    expect(toTypeBoxDeclarations(registry)).toBe(
      [
        'import { Type } from "@sinclair/typebox";',
        "",
        "const Name = Type.String();",
        "const Age = Type.Integer();",
      ].join("\n"),
    )
  })
})

describe("function", () => {
  test("emits Type.Function(params, returns) — TypeBox's native callable-type constructor", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toTypeBox(ref)).toBe("Type.Function([Type.Number()], Type.String())")
  })

  test("drops thisType (no dedicated slot)", () => {
    const ref = t(
      types.function(
        [{ name: "amount", type: t(types.number) }],
        t(types.void),
        t(types.instance("Account", "src/account.ts")),
      ),
    )
    expect(toTypeBox(ref)).toBe("Type.Function([Type.Number()], Type.Void())")
  })
})

describe("stream", () => {
  test("degrades to Type.Array() of the element type", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toTypeBox(ref)).toBe("Type.Array(Type.Integer())")
  })
})
