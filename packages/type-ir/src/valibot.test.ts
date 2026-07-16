import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { toValibot, toValibotDeclaration, toValibotDeclarations } from "./valibot.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toValibot(t(types.boolean))).toBe("v.boolean()")
  })

  test("number", () => {
    expect(toValibot(t(types.number))).toBe("v.number()")
  })

  test("integer", () => {
    expect(toValibot(t(types.integer))).toBe("v.pipe(v.number(), v.integer())")
  })

  test("string", () => {
    expect(toValibot(t(types.string))).toBe("v.string()")
  })

  test("bytes", () => {
    expect(toValibot(t(types.bytes))).toBe("v.pipe(v.string(), v.base64())")
  })

  test("null", () => {
    expect(toValibot(t(types.null))).toBe("v.null()")
  })

  test("void", () => {
    expect(toValibot(t(types.void))).toBe("v.void()")
  })

  test("unknown", () => {
    expect(toValibot(t(types.unknown))).toBe("v.unknown()")
  })

  test("never", () => {
    expect(toValibot(t(types.never))).toBe("v.never()")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toValibot(t(types.int32))).toBe("v.pipe(v.number(), v.integer())")
  })

  test("int64", () => {
    expect(toValibot(t(types.int64))).toBe("v.pipe(v.number(), v.integer())")
  })

  test("float32", () => {
    expect(toValibot(t(types.float32))).toBe("v.number()")
  })

  test("float64", () => {
    expect(toValibot(t(types.float64))).toBe("v.number()")
  })

  test("uuid", () => {
    expect(toValibot(t(types.uuid))).toBe("v.pipe(v.string(), v.uuid())")
  })

  test("uri", () => {
    expect(toValibot(t(types.uri))).toBe("v.pipe(v.string(), v.url())")
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toValibot(t(types.datetime))).toBe("v.pipe(v.string(), v.isoDateTime())")
  })

  test("date", () => {
    expect(toValibot(t(types.date))).toBe("v.pipe(v.string(), v.isoDate())")
  })

  test("time", () => {
    expect(toValibot(t(types.time))).toBe("v.pipe(v.string(), v.isoTime())")
  })

  test("duration", () => {
    expect(toValibot(t(types.duration))).toBe("v.string()")
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
    expect(toValibot(ref)).toBe("v.object({ name: v.string(), nickname: v.optional(v.string()) })")
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toValibot(ref)).toBe("v.array(v.pipe(v.number(), v.integer()))")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toValibot(ref)).toBe("v.tuple([v.string(), v.pipe(v.number(), v.integer())])")
  })
})

describe("map", () => {
  test("record with explicit string key", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toValibot(ref)).toBe("v.record(v.string(), v.number())")
  })
})

describe("union", () => {
  test("variants", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toValibot(ref)).toBe("v.union([v.string(), v.pipe(v.number(), v.integer())])")
  })

  test("discriminated union: v.variant(key, [...]), driven by meta.discriminator", () => {
    const circle = t(types.object({ type: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ type: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "type" })
    expect(toValibot(ref)).toBe(
      'v.variant("type", [v.object({ type: v.literal("circle"), radius: v.number() }), v.object({ type: v.literal("square"), side: v.number() })])',
    )
  })
})

describe("intersection", () => {
  test("v.intersect([...]) accepts any arity", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toValibot(ref)).toBe("v.intersect([v.object({ id: v.string() }), v.object({ createdAt: v.string() })])")
  })

  test("three-way intersection stays a single flat v.intersect([...])", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
        t(types.object({ name: t(types.string) })),
      ]),
    )
    expect(toValibot(ref)).toBe(
      "v.intersect([v.object({ id: v.string() }), v.object({ createdAt: v.string() }), v.object({ name: v.string() })])",
    )
  })
})

describe("literal", () => {
  test("string", () => {
    expect(toValibot(t(types.literal("active")))).toBe('v.literal("active")')
  })

  test("number", () => {
    expect(toValibot(t(types.literal(42)))).toBe("v.literal(42)")
  })

  test("boolean", () => {
    expect(toValibot(t(types.literal(true)))).toBe("v.literal(true)")
  })

  test("null", () => {
    expect(toValibot(t(types.literal(null)))).toBe("v.literal(null)")
  })
})

describe("enum", () => {
  test("picklist", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toValibot(ref)).toBe('v.picklist(["a", "b", "c"])')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toValibot(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("wraps whole expression", () => {
    const ref = t(types.string, { nullable: true })
    expect(toValibot(ref)).toBe("v.nullable(v.string())")
  })

  test("wraps pipe expression", () => {
    const ref = t(types.integer, { nullable: true })
    expect(toValibot(ref)).toBe("v.nullable(v.pipe(v.number(), v.integer()))")
  })
})

describe("constraints", () => {
  test("string minLength/maxLength", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 100 })
    expect(toValibot(ref)).toBe("v.pipe(v.string(), v.minLength(1), v.maxLength(100))")
  })

  test("numeric minimum/maximum", () => {
    const ref = t(types.number, { minimum: 0, maximum: 10 })
    expect(toValibot(ref)).toBe("v.pipe(v.number(), v.minValue(0), v.maxValue(10))")
  })

  test("pattern", () => {
    const ref = t(types.string, { pattern: "^[a-z]+$" })
    expect(toValibot(ref)).toBe("v.pipe(v.string(), v.regex(/^[a-z]+$/))")
  })

  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toValibot(ref)).toBe('v.pipe(v.string(), v.description("a name"))')
  })

  test("merges into existing pipe base (integer + constraints)", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100 })
    expect(toValibot(ref)).toBe("v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))")
  })

  test("multipleOf", () => {
    const ref = t(types.number, { multipleOf: 2 })
    expect(toValibot(ref)).toBe("v.pipe(v.number(), v.multipleOf(2))")
  })
})

describe("default", () => {
  test("optional + default uses v.optional's second argument", () => {
    const ref = t(types.string, { optional: true, default: "hi" })
    expect(toValibot(ref)).toBe('v.optional(v.string(), "hi")')
  })

  test("nullable + default uses v.nullable's second argument", () => {
    const ref = t(types.string, { nullable: true, default: "hi" })
    expect(toValibot(ref)).toBe('v.nullable(v.string(), "hi")')
  })

  test("bare default (no optional/nullable wrapper) has no valibot equivalent — surfaced as a comment", () => {
    const ref = t(types.string, { default: "hi" })
    expect(toValibot(ref)).toBe('v.string() /* default: "hi" */')
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toValibot(ref)).toBe("v.pipe(v.number(), v.integer())")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(t(types.uuid))),
      }),
    )
    expect(toValibot(ref)).toBe("v.object({ ids: v.array(v.pipe(v.string(), v.uuid())) })")
  })
})

describe("branded types (meta.brand)", () => {
  test("branded string appends v.brand(...) via v.pipe", () => {
    expect(toValibot(t(types.string, { brand: "LocationId" }))).toBe(
      'v.pipe(v.string(), v.brand("LocationId"))',
    )
  })
})

describe("declarations", () => {
  test("single declaration", () => {
    expect(toValibotDeclaration("Name", t(types.string))).toBe("const Name = v.string();")
  })

  test("registry produces import and declarations", () => {
    const registry = {
      User: t(types.object({ id: t(types.uuid) })),
      Status: t(types.enum(["active", "inactive"])),
    }
    expect(toValibotDeclarations(registry)).toBe(
      [
        'import * as v from "valibot"',
        "",
        "const User = v.object({ id: v.pipe(v.string(), v.uuid()) });",
        'const Status = v.picklist(["active", "inactive"]);',
      ].join("\n"),
    )
  })
})
