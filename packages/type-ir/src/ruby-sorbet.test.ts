import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, int32, uri, uuid } from "./kinds/common.ts"
import { toRuby, toRubyClass, toRubyEnum, toRubyMethodSig, toRubyType, toRbsClass, toRbsType } from "./ruby-sorbet.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toRubyType(t(types.boolean))).toBe("T::Boolean")
  })

  test("number", () => {
    expect(toRubyType(t(types.number))).toBe("Float")
  })

  test("integer", () => {
    expect(toRubyType(t(types.integer))).toBe("Integer")
  })

  test("string", () => {
    expect(toRubyType(t(types.string))).toBe("String")
  })

  test("null", () => {
    expect(toRubyType(t(types.null))).toBe("NilClass")
  })

  test("unknown", () => {
    expect(toRubyType(t(types.unknown))).toBe("T.untyped")
  })

  test("void", () => {
    expect(toRubyType(t(types.void))).toBe("T.untyped")
  })

  test("never", () => {
    expect(toRubyType(t(types.never))).toBe("T.noreturn")
  })

  test("bytes", () => {
    expect(toRubyType(bytes())).toBe("String")
  })

  test("datetime", () => {
    expect(toRubyType(datetime())).toBe("Time")
  })

  test("date", () => {
    expect(toRubyType(date())).toBe("Time")
  })
})

describe("string subtype fallback", () => {
  test("uuid falls back to string handler", () => {
    expect(toRubyType(uuid())).toBe("String")
  })

  test("uri falls back to string handler", () => {
    expect(toRubyType(uri())).toBe("String")
  })

  test("email falls back to string handler", () => {
    expect(toRubyType(email())).toBe("String")
  })

  test("duration falls back to string handler", () => {
    expect(toRubyType(duration())).toBe("String")
  })
})

describe("numeric subtype fallback", () => {
  test("int32 falls back to integer handler", () => {
    expect(toRubyType(int32())).toBe("Integer")
  })
})

describe("array", () => {
  test("array of string", () => {
    expect(toRubyType(t(types.array(t(types.string))))).toBe("T::Array[String]")
  })

  test("uniform tuple collapses to T::Array[T]", () => {
    const ref = t(types.tuple([t(types.string), t(types.string)]))
    expect(toRubyType(ref)).toBe("T::Array[String]")
  })

  test("heterogeneous tuple degrades to T::Array[T.any(...)]", () => {
    const ref = t(types.tuple([t(types.string), t(types.number)]))
    expect(toRubyType(ref)).toBe("T::Array[T.any(String, Float)]")
  })
})

describe("map", () => {
  test("string-keyed map", () => {
    const ref = t(types.map(t(types.string), t(types.number)))
    expect(toRubyType(ref)).toBe("T::Hash[String, Float]")
  })
})

describe("union", () => {
  test("two-variant union with null collapses to T.nilable", () => {
    const ref = t(types.union([t(types.string), t(types.null)]))
    expect(toRubyType(ref)).toBe("T.nilable(String)")
  })

  test("general union renders T.any", () => {
    const ref = t(types.union([t(types.string), t(types.number), t(types.boolean)]))
    expect(toRubyType(ref)).toBe("T.any(String, Float, T::Boolean)")
  })
})

describe("meta.nullable", () => {
  test("wraps in T.nilable", () => {
    expect(toRubyType(t(types.string, { nullable: true }))).toBe("T.nilable(String)")
  })
})

describe("literal", () => {
  test("string literal degrades to String", () => {
    expect(toRubyType(t(types.literal("active")))).toBe("String")
  })

  test("number literal degrades to Integer/Float", () => {
    expect(toRubyType(t(types.literal(42)))).toBe("Integer")
    expect(toRubyType(t(types.literal(4.2)))).toBe("Float")
  })

  test("boolean literal degrades to T::Boolean", () => {
    expect(toRubyType(t(types.literal(true)))).toBe("T::Boolean")
  })

  test("null literal degrades to NilClass", () => {
    expect(toRubyType(t(types.literal(null)))).toBe("NilClass")
  })
})

describe("ref and instance", () => {
  test("ref renders the bare target name", () => {
    expect(toRubyType(t(types.ref("User")))).toBe("User")
  })

  test("instance renders the bare class name", () => {
    expect(toRubyType(t(types.instance("Account", "src/account.ts")))).toBe("Account")
  })
})

describe("intersection", () => {
  test("renders T.all", () => {
    const ref = t(types.intersection([t(types.string), t(types.number)]))
    expect(toRubyType(ref)).toBe("T.all(String, Float)")
  })
})

describe("function", () => {
  test("renders a T.proc builder", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toRubyType(ref)).toBe("T.proc.params(x: Float).returns(String)")
  })

  test("no-param function omits .params", () => {
    const ref = t(types.function([], t(types.void)))
    expect(toRubyType(ref)).toBe("T.proc.returns(T.untyped)")
  })
})

describe("stream and page", () => {
  test("stream renders T::Enumerator", () => {
    expect(toRubyType(t(types.stream(t(types.string))))).toBe("T::Enumerator[String]")
  })

  test("page degrades to T::Array over its element", () => {
    expect(toRubyType(t(types.page(t(types.string), "cursor")))).toBe("T::Array[String]")
  })
})

describe("interface", () => {
  test("degrades to T.untyped", () => {
    expect(toRubyType(t(types.interface({})))).toBe("T.untyped")
  })
})

describe("enum without a name", () => {
  test("degrades to String", () => {
    expect(toRubyType(t(types.enum(["a", "b"])))).toBe("String")
  })

  test("with meta.enumName renders the class reference", () => {
    expect(toRubyType(t(types.enum(["a", "b"]), { enumName: "Status" }))).toBe("Status")
  })
})

describe("toRubyEnum", () => {
  test("emits a T::Enum class with serialized constants", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toRubyEnum("Status", ref)).toBe(
      ['class Status < T::Enum', '  enums do', '    ACTIVE = new("active")', '    INACTIVE = new("inactive")', "  end", "end"].join(
        "\n",
      ),
    )
  })

  test("sanitizes non-identifier characters in the constant name", () => {
    const ref = t(types.enum(["in progress"]))
    expect(toRubyEnum("Status", ref)).toContain('IN_PROGRESS = new("in progress")')
  })

  test("description renders as a leading comment", () => {
    const ref = t(types.enum(["a"]), { description: "Lifecycle state" })
    expect(toRubyEnum("Status", ref).split("\n")[0]).toBe("# Lifecycle state")
  })
})

describe("toRubyClass", () => {
  test("emits a T::Struct with prop declarations", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const rendered = toRubyClass("Person", ref)
    expect(rendered).toContain("class Person < T::Struct")
    expect(rendered).toContain("extend T::Sig")
    expect(rendered).toContain("prop :name, String")
    expect(rendered).toContain("prop :age, T.nilable(Integer), default: nil")
  })

  test("readonly field emits const instead of prop", () => {
    const ref = t(types.object({ id: t(types.string, { readonly: true }) }))
    expect(toRubyClass("Thing", ref)).toContain("const :id, String")
  })

  test("nullable-but-required field wraps in T.nilable without a default", () => {
    const ref = t(types.object({ id: t(types.string, { nullable: true }) }))
    const rendered = toRubyClass("Thing", ref)
    expect(rendered).toContain("prop :id, T.nilable(String)")
    expect(rendered).not.toContain("default: nil")
  })

  test("includes to_json/from_json class methods", () => {
    const ref = t(types.object({ id: t(types.string) }))
    const rendered = toRubyClass("Thing", ref)
    expect(rendered).toContain("def to_json(*_args)")
    expect(rendered).toContain("serialize.to_json")
    expect(rendered).toContain("def self.from_json(json)")
    expect(rendered).toContain("from_hash(JSON.parse(json))")
  })

  test("nested object field synthesizes a named nested T::Struct", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const rendered = toRubyClass("Person", ref)
    expect(rendered).toContain("class PersonAddress < T::Struct")
    expect(rendered).toContain("prop :address, PersonAddress")
  })

  test("nested enum field synthesizes a named T::Enum", () => {
    const ref = t(
      types.object({
        status: t(types.enum(["active", "inactive"])),
      }),
    )
    const rendered = toRubyClass("Person", ref)
    expect(rendered).toContain("class PersonStatus < T::Enum")
    expect(rendered).toContain("prop :status, PersonStatus")
  })

  test("array of nested object field synthesizes a named nested T::Struct wrapped in T::Array", () => {
    const ref = t(
      types.object({
        addresses: t(types.array(t(types.object({ city: t(types.string) })))),
      }),
    )
    const rendered = toRubyClass("Person", ref)
    expect(rendered).toContain("class PersonAddresses < T::Struct")
    expect(rendered).toContain("prop :addresses, T::Array[PersonAddresses]")
  })

  test("description and deprecated render as leading comments", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person", deprecated: true })
    const rendered = toRubyClass("Person", ref)
    expect(rendered.split("\n").slice(0, 2)).toEqual(["# A person", "# @deprecated"])
  })
})

describe("toRubyMethodSig", () => {
  test("renders a sig block and method signature", () => {
    const ref = t(types.method([{ name: "amount", type: t(types.number) }], t(types.void)))
    expect(toRubyMethodSig("deposit", ref)).toBe(
      ["sig { params(amount: Float). void }", "def deposit(amount); end"].join("\n"),
    )
  })

  test("no-param method with a return type", () => {
    const ref = t(types.method([], t(types.number)))
    expect(toRubyMethodSig("balance", ref)).toBe(["sig { returns(Float) }", "def balance(); end"].join("\n"))
  })
})

describe("toRuby", () => {
  test("named object dispatches to toRubyClass", () => {
    const ref = t(types.object({ id: t(types.string) }))
    expect(toRuby(ref, "Thing")).toBe(toRubyClass("Thing", ref))
  })

  test("named enum dispatches to toRubyEnum", () => {
    const ref = t(types.enum(["a", "b"]))
    expect(toRuby(ref, "Status")).toBe(toRubyEnum("Status", ref))
  })

  test("named non-struct/enum emits a T.type_alias binding", () => {
    const ref = t(types.string)
    expect(toRuby(ref, "Name")).toBe("Name = T.type_alias { String }")
  })

  test("unnamed ref returns a bare Sorbet type expression", () => {
    expect(toRuby(t(types.string))).toBe("String")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to T.untyped", () => {
    const ref = { shape: { kind: "bogus" } as never, meta: {} }
    expect(toRubyType(ref)).toBe("T.untyped")
  })
})

// ============================================================================
// RBS mode
// ============================================================================

describe("RBS: leaf types", () => {
  test("boolean", () => {
    expect(toRbsType(t(types.boolean))).toBe("bool")
  })

  test("string", () => {
    expect(toRbsType(t(types.string))).toBe("String")
  })

  test("null", () => {
    expect(toRbsType(t(types.null))).toBe("nil")
  })

  test("unknown", () => {
    expect(toRbsType(t(types.unknown))).toBe("untyped")
  })
})

describe("RBS: collections", () => {
  test("array", () => {
    expect(toRbsType(t(types.array(t(types.string))))).toBe("Array[String]")
  })

  test("map", () => {
    expect(toRbsType(t(types.map(t(types.string), t(types.number))))).toBe("Hash[String, Float]")
  })

  test("tuple", () => {
    expect(toRbsType(t(types.tuple([t(types.string), t(types.number)])))).toBe("[String, Float]")
  })
})

describe("RBS: union and nilable", () => {
  test("two-variant union with null collapses to a ? suffix", () => {
    expect(toRbsType(t(types.union([t(types.string), t(types.null)])))).toBe("String?")
  })

  test("general union joins with |", () => {
    expect(toRbsType(t(types.union([t(types.string), t(types.number)])))).toBe("String | Float")
  })

  test("meta.nullable appends ?", () => {
    expect(toRbsType(t(types.string, { nullable: true }))).toBe("String?")
  })
})

describe("RBS: literal types", () => {
  test("string literal renders as a quoted literal type", () => {
    expect(toRbsType(t(types.literal("active")))).toBe('"active"')
  })

  test("number literal renders bare", () => {
    expect(toRbsType(t(types.literal(42)))).toBe("42")
  })
})

describe("RBS: enum", () => {
  test("without a name renders a literal union", () => {
    expect(toRbsType(t(types.enum(["a", "b"])))).toBe('"a" | "b"')
  })

  test("with meta.enumName renders the class reference", () => {
    expect(toRbsType(t(types.enum(["a", "b"]), { enumName: "Status" }))).toBe("Status")
  })
})

describe("toRbsClass", () => {
  test("emits attr_reader per field", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const rendered = toRbsClass("Person", ref)
    expect(rendered).toBe(["class Person", "  attr_reader name: String", "  attr_reader age: Integer?", "end"].join("\n"))
  })
})

describe("RBS: function and interface", () => {
  test("function renders a ^(...) -> R proc type", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toRbsType(ref)).toBe("^(Float x) -> String")
  })

  test("interface degrades to untyped", () => {
    expect(toRbsType(t(types.interface({})))).toBe("untyped")
  })
})
