import { describe, expect, test } from "bun:test"
import { registerParent, t, types } from "./index.ts"
import { bytes, date, datetime, duration, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { toYup, toYupDeclaration, toYupDeclarations } from "./yup.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toYup(t(types.boolean))).toBe("yup.boolean()")
  })

  test("number", () => {
    expect(toYup(t(types.number))).toBe("yup.number()")
  })

  test("integer", () => {
    expect(toYup(t(types.integer))).toBe("yup.number().integer()")
  })

  test("string", () => {
    expect(toYup(t(types.string))).toBe("yup.string()")
  })

  test("bytes", () => {
    expect(toYup(bytes())).toBe("yup.string() /* no native base64 validation in Yup */")
  })

  test("null", () => {
    expect(toYup(t(types.null))).toBe("yup.mixed().oneOf([null] as const)")
  })

  test("void", () => {
    expect(toYup(t(types.void))).toBe("yup.mixed() /* no native void type in Yup */")
  })

  test("unknown", () => {
    expect(toYup(t(types.unknown))).toBe("yup.mixed()")
  })

  test("never", () => {
    expect(toYup(t(types.never))).toBe("yup.mixed().oneOf([] as const) /* no native never type in Yup */")
  })
})

describe("formatted types", () => {
  test("int32", () => {
    expect(toYup(int32())).toBe("yup.number().integer()")
  })

  test("int64", () => {
    expect(toYup(int64())).toBe("yup.number().integer()")
  })

  test("float32", () => {
    expect(toYup(float32())).toBe("yup.number()")
  })

  test("float64", () => {
    expect(toYup(float64())).toBe("yup.number()")
  })

  test("uuid", () => {
    expect(toYup(uuid())).toBe(
      "yup.string().matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)",
    )
  })

  test("uri", () => {
    expect(toYup(uri())).toBe("yup.string().url()")
  })
})

describe("temporal types", () => {
  test("datetime", () => {
    expect(toYup(datetime())).toBe("yup.date()")
  })

  test("date", () => {
    expect(toYup(date())).toBe("yup.date()")
  })

  test("time", () => {
    expect(toYup(time())).toBe("yup.string() /* no native time type in Yup */")
  })

  test("duration", () => {
    expect(toYup(duration())).toBe("yup.string() /* no native duration type in Yup */")
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
    expect(toYup(ref)).toBe("yup.object({ name: yup.string().required(), nickname: yup.string() })")
  })

  test("quotes non-identifier field names", () => {
    const ref = t(types.object({ "not-an-ident": t(types.string) }))
    expect(toYup(ref)).toBe('yup.object({ "not-an-ident": yup.string().required() })')
  })
})

describe("array", () => {
  test("element type", () => {
    const ref = t(types.array(t(types.integer)))
    expect(toYup(ref)).toBe("yup.array().of(yup.number().integer())")
  })
})

describe("tuple", () => {
  test("elements", () => {
    const ref = t(types.tuple([t(types.string), t(types.integer)]))
    expect(toYup(ref)).toBe("yup.tuple([yup.string(), yup.number().integer()])")
  })
})

describe("map", () => {
  test("lossy object fallback", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toYup(ref)).toBe("yup.object() /* lossy: Yup has no native record/map type; key/value types not preserved */")
  })
})

describe("union", () => {
  test("literal-only union uses mixed().oneOf()", () => {
    const ref = t(types.union([t(types.literal("a")), t(types.literal("b"))]))
    expect(toYup(ref)).toBe('yup.mixed().oneOf(["a", "b"] as const)')
  })

  test("schema union falls back to yup.lazy() with runtime guards", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toYup(ref)).toBe(
      [
        "yup.lazy((value) => {",
        '  if (typeof value === "string") return yup.string();',
        '  if (typeof value === "number") return yup.number().integer();',
        "  return yup.mixed();",
        "})",
      ].join("\n"),
    )
  })
})

describe("literal", () => {
  test("string literal", () => {
    expect(toYup(t(types.literal("active")))).toBe('yup.mixed().oneOf(["active"] as const)')
  })

  test("number literal", () => {
    expect(toYup(t(types.literal(42)))).toBe("yup.mixed().oneOf([42] as const)")
  })

  test("boolean literal", () => {
    expect(toYup(t(types.literal(true)))).toBe("yup.mixed().oneOf([true] as const)")
  })

  test("null literal", () => {
    expect(toYup(t(types.literal(null)))).toBe("yup.mixed().oneOf([null] as const)")
  })
})

describe("enum", () => {
  test("enum members", () => {
    const ref = t(types.enum(["a", "b", "c"]))
    expect(toYup(ref)).toBe('yup.mixed().oneOf(["a", "b", "c"] as const)')
  })
})

describe("ref", () => {
  test("target name", () => {
    expect(toYup(t(types.ref("User")))).toBe("User")
  })
})

describe("nullable", () => {
  test("leaf", () => {
    const ref = t(types.string, { nullable: true })
    expect(toYup(ref)).toBe("yup.string().nullable()")
  })

  test("complex type", () => {
    const ref = t(types.array(t(types.string)), { nullable: true })
    expect(toYup(ref)).toBe("yup.array().of(yup.string()).nullable()")
  })
})

describe("constraints", () => {
  test("string minLength/maxLength/pattern", () => {
    const ref = t(types.string, { minLength: 1, maxLength: 10, pattern: "^[a-z]+$" })
    expect(toYup(ref)).toBe("yup.string().min(1).max(10).matches(/^[a-z]+$/)")
  })

  test("numeric minimum/maximum/multipleOf", () => {
    const ref = t(types.integer, { minimum: 0, maximum: 100, multipleOf: 5 })
    expect(toYup(ref)).toBe(
      'yup.number().integer().min(0).max(100).test("multipleOf", "must be a multiple of 5", (value) => value === undefined || value % 5 === 0)',
    )
  })

  test("array minLength/maxLength", () => {
    const ref = t(types.array(t(types.string)), { minLength: 1, maxLength: 5 })
    expect(toYup(ref)).toBe("yup.array().of(yup.string()).min(1).max(5)")
  })

  test("description", () => {
    const ref = t(types.string, { description: "a name" })
    expect(toYup(ref)).toBe('yup.string().label("a name")')
  })

  test("default", () => {
    const ref = t(types.integer, { default: 0 })
    expect(toYup(ref)).toBe("yup.number().integer().default(0)")
  })

  test("regex with forward slash in pattern", () => {
    const ref = t(types.string, { pattern: "a/b" })
    expect(toYup(ref)).toBe("yup.string().matches(/a\\/b/)")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to nearest ancestor handler", () => {
    registerParent("int128", "integer")
    const ref = t({ kind: "int128" } as never)
    expect(toYup(ref)).toBe("yup.number().integer()")
  })

  test("no ancestor handler falls back to yup.mixed()", () => {
    registerParent("mystery", null)
    const ref = t({ kind: "mystery" } as never)
    expect(toYup(ref)).toBe("yup.mixed()")
  })
})

describe("nested", () => {
  test("object with array of uuid fields", () => {
    const ref = t(
      types.object({
        ids: t(types.array(uuid())),
      }),
    )
    expect(toYup(ref)).toBe(
      "yup.object({ ids: yup.array().of(yup.string().matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)).required() })",
    )
  })
})

describe("intersection", () => {
  test("all-object members chain .concat() left-associatively", () => {
    const ref = t(
      types.intersection([
        t(types.object({ id: t(types.string) })),
        t(types.object({ createdAt: t(types.string) })),
      ]),
    )
    expect(toYup(ref)).toBe(
      "yup.object({ id: yup.string().required() }).concat(yup.object({ createdAt: yup.string().required() }))",
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
    expect(toYup(ref)).toBe(
      "yup.object({ id: yup.string().required() }).concat(yup.object({ createdAt: yup.string().required() })).concat(yup.object({ name: yup.string().required() }))",
    )
  })

  test("non-object member falls back to the first member (lossy)", () => {
    const ref = t(types.intersection([t(types.string), t(types.object({ id: t(types.string) }))]))
    expect(toYup(ref)).toBe("yup.string()")
  })
})

describe("toYupDeclaration", () => {
  test("emits a const declaration", () => {
    expect(toYupDeclaration("Age", t(types.integer))).toBe("const Age = yup.number().integer();")
  })
})

describe("toYupDeclarations", () => {
  test("emits import and multiple declarations", () => {
    const registry = {
      User: t(types.object({ id: uuid() })),
      Age: t(types.integer),
    }
    expect(toYupDeclarations(registry)).toBe(
      [
        'import * as yup from "yup";',
        "",
        "const User = yup.object({ id: yup.string().matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).required() });",
        "const Age = yup.number().integer();",
      ].join("\n"),
    )
  })
})

describe("function", () => {
  test("degrades to yup.mixed() (no construct for an opaque callable value)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toYup(ref)).toBe("yup.mixed()")
  })
})

describe("stream", () => {
  test("degrades to yup.array().of() of the element type", () => {
    const ref = t(types.stream(t(types.integer)))
    expect(toYup(ref)).toBe("yup.array().of(yup.number().integer())")
  })
})
