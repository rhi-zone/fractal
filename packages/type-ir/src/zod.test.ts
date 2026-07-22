import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toZod, toZodDeclaration, toZodDeclarations } from "./zod.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toZod(t(types.boolean))).toBe("z.boolean()")
  })

  test("number", () => {
    expect(toZod(t(types.number))).toBe("z.number()")
  })

  test("integer", () => {
    expect(toZod(t(types.integer))).toBe("z.number().int()")
  })

  test("string", () => {
    expect(toZod(t(types.string))).toBe("z.string()")
  })

  test("bytes", () => {
    expect(toZod(bytes())).toBe("z.string().base64()")
  })

  test("null", () => {
    expect(toZod(t(types.null))).toBe("z.null()")
  })

  test("void", () => {
    expect(toZod(t(types.void))).toBe("z.void()")
  })

  test("unknown", () => {
    expect(toZod(t(types.unknown))).toBe("z.unknown()")
  })

  test("never", () => {
    expect(toZod(t(types.never))).toBe("z.never()")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toZod(int32())).toBe("z.number().int()")
  })

  test("int64", () => {
    expect(toZod(int64())).toBe("z.number().int()")
  })

  test("float32", () => {
    expect(toZod(float32())).toBe("z.number()")
  })

  test("float64", () => {
    expect(toZod(float64())).toBe("z.number()")
  })

  test("uuid", () => {
    expect(toZod(uuid())).toBe("z.string().uuid()")
  })

  test("uri", () => {
    expect(toZod(uri())).toBe("z.string().url()")
  })

  test("email", () => {
    expect(toZod(email())).toBe("z.string().email()")
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toZod(datetime())).toBe("z.coerce.date()")
  })

  test("date", () => {
    expect(toZod(date())).toBe("z.coerce.date()")
  })

  test("time", () => {
    expect(toZod(time())).toBe("z.string().time()")
  })

  test("duration", () => {
    expect(toZod(duration())).toBe("z.string().duration()")
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
    expect(toZod(ref)).toBe("z.object({ name: z.string(), nickname: z.string().optional() })")
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toZod(ref)).toBe('z.object({ "not-an-ident": z.string() })')
  })

  test("readonly field", () => {
    const ref = t(
      types.object({
        id: t(types.string, { readonly: true }),
        name: t(types.string),
      }),
    )
    expect(toZod(ref)).toBe("z.object({ id: z.string().readonly(), name: z.string() })")
  })

  test("optional and readonly field chains .optional().readonly()", () => {
    const ref = t(types.object({ id: t(types.string, { optional: true, readonly: true }) }))
    expect(toZod(ref)).toBe("z.object({ id: z.string().optional().readonly() })")
  })
})

describe("instance", () => {
  test("emits z.instanceof(className)", () => {
    const ref = t(types.instance("User", "src/user.ts"))
    expect(toZod(ref)).toBe("z.instanceof(User)")
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toZod(ref)).toBe("z.array(z.number().int())")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toZod(ref)).toBe("z.tuple([z.string(), z.number().int()])")
  })
})

describe("map", () => {
  test("record", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toZod(ref)).toBe("z.record(z.string(), z.number())")
  })
})

describe("union", () => {
  test("union of variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toZod(ref)).toBe("z.union([z.string(), z.number().int()])")
  })

  test("discriminated union: z.discriminatedUnion(key, [...]), driven by meta.discriminator", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })
    expect(toZod(ref)).toBe(
      'z.discriminatedUnion("type", [z.object({ type: z.literal("circle"), radius: z.number() }), z.object({ type: z.literal("square"), side: z.number() })])',
    )
  })
})

describe("intersection", () => {
  test("two members: z.intersection(a, b)", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toZod(ref)).toBe(
      "z.intersection(z.object({ id: z.string() }), z.object({ createdAt: z.string() }))",
    )
  })

  test("three members nest left-associatively: z.intersection(z.intersection(a, b), c)", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
        t(types.object({ name: t(types.string) })),
      ]),
    )
    expect(toZod(ref)).toBe(
      "z.intersection(z.intersection(z.object({ id: z.string() }), z.object({ createdAt: z.string() })), z.object({ name: z.string() }))",
    )
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toZod(t(types.literal("active")))).toBe('z.literal("active")')
  })

  test("number literal", () => {
    expect(toZod(t(types.literal(42)))).toBe("z.literal(42)")
  })

  test("boolean literal", () => {
    expect(toZod(t(types.literal(true)))).toBe("z.literal(true)")
  })

  test("null literal", () => {
    expect(toZod(t(types.literal(null)))).toBe("z.literal(null)")
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toZod(ref)).toBe('z.enum(["a", "b", "c"])')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toZod(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("leaf", () => {
    const ref = t(types.string, { nullable: true })
    expect(toZod(ref)).toBe("z.string().nullable()")
  })

  test("complex type", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toZod(ref)).toBe("z.array(z.string()).nullable()")
  })
})

describe("constraints", () => {
  test("string minLength/maxLength/pattern", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toZod(ref)).toBe('z.string().min(1).max(10).regex(/^[a-z]+$/)')
  })

  test("numeric minimum/maximum/multipleOf", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toZod(ref)).toBe("z.number().int().min(0).max(100).multipleOf(5)")
  })

  test("numeric exclusiveMinimum/exclusiveMaximum use .gt()/.lt()", () => {
    const ref = t(types.number, { exclusiveMinimum: 0, exclusiveMaximum: 100 })
    expect(toZod(ref)).toBe("z.number().gt(0).lt(100)")
  })

  test("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 5 })
    expect(toZod(ref)).toBe("z.array(z.string()).min(1).max(5)")
  })

  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toZod(ref)).toBe('z.string().describe("a name")')
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toZod(ref)).toBe("z.number().int().default(0)")
  })

  test("regex with forward slash in pattern", () => {
    const ref = t(types.string, { pattern: "a/b" })
    expect(toZod(ref)).toBe("z.string().regex(/a\\/b/)")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toZod(ref)).toBe("z.number().int()")
  })

  test("no ancestor handler falls back to z.unknown()", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toZod(ref)).toBe("z.unknown()")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toZod(ref)).toBe("z.object({ ids: z.array(z.string().uuid()) })")
  })
})

describe("branded types (meta.brand)", () => {
  test("branded string appends .brand<...>()", () => {
    expect(toZod(t(types.string, { brand: "LocationId" }))).toBe(
      'z.string().brand<"LocationId">()',
    )
  })

  test("branded number appends .brand<...>() after other constraints", () => {
    expect(toZod(t(types.integer, { brand: "PositiveInt" }))).toBe(
      'z.number().int().brand<"PositiveInt">()',
    )
  })
})

describe("toZodDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toZodDeclaration("Age", t(types.integer))).toBe("const Age = z.number().int();")
  })
})

describe("toZodDeclarations", () => {
  test("emits import and multiple declarations, each wrapped in z.lazy for recursive-safety", () => {
    const registry = {
      User: t(types.object({ id: uuid() })),
      Age: t(types.integer),
    }
    expect(toZodDeclarations(registry)).toBe(
      [
        'import { z } from "zod";',
        "",
        "const User: z.ZodType<any> = z.lazy(() => (z.object({ id: z.string().uuid() })));",
        "const Age: z.ZodType<any> = z.lazy(() => (z.number().int()));",
      ].join("\n"),
    )
  })
})

describe("function", () => {
  test("emits z.function().args(...).returns(...)", () => {
    const ref = t(
      types.function([{ name: "x", type: t(types.number) }], t(types.string)),
    )
    expect(toZod(ref)).toBe("z.function().args(z.number()).returns(z.string())")
  })

  test("drops thisType (no Zod equivalent)", () => {
    const ref = t(
      types.function(
        [{ name: "amount", type: t(types.number) }],
        t(types.void),
        t(types.instance("Account", "src/account.ts")),
      ),
    )
    expect(toZod(ref)).toBe("z.function().args(z.number()).returns(z.void())")
  })
})

describe("method", () => {
  test("falls back to the function handler via registerParent", () => {
    const ref = t(
      types.method(
        [{ name: "amount", type: t(types.number) }],
        t(types.void),
        t(types.instance("Account", "src/account.ts")),
      ),
    )
    expect(toZod(ref)).toBe("z.function().args(z.number()).returns(z.void())")
  })
})

describe("interface", () => {
  test("emits z.object with each method as a z.function() field", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        balance: t(types.method([], t(types.number))),
      }),
    )
    expect(toZod(ref)).toBe(
      "z.object({ deposit: z.function().args(z.number()).returns(z.void()), balance: z.function().args().returns(z.number()) })",
    )
  })
})

describe("stream", () => {
  test("degrades to z.array() of the element type", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toZod(ref)).toBe("z.array(z.number().int())")
  })
})
