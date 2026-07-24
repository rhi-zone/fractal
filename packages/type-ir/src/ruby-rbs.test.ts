import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, int32, uri, uuid } from "./kinds/common.ts"
import { toRbsFile, toRbsType } from "./ruby-rbs.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toRbsType(t(types.boolean))).toBe("bool")
  })

  test("number", () => {
    expect(toRbsType(t(types.number))).toBe("Float")
  })

  test("integer", () => {
    expect(toRbsType(t(types.integer))).toBe("Integer")
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

  test("void", () => {
    expect(toRbsType(t(types.void))).toBe("void")
  })

  test("never", () => {
    expect(toRbsType(t(types.never))).toBe("bot")
  })

  test("bytes", () => {
    expect(toRbsType(bytes())).toBe("String")
  })

  test("datetime", () => {
    expect(toRbsType(datetime())).toBe("Time")
  })

  test("date", () => {
    expect(toRbsType(date())).toBe("Time")
  })
})

describe("string subtype fallback", () => {
  test("uuid falls back to string handler", () => {
    expect(toRbsType(uuid())).toBe("String")
  })

  test("uri falls back to string handler", () => {
    expect(toRbsType(uri())).toBe("String")
  })

  test("email falls back to string handler", () => {
    expect(toRbsType(email())).toBe("String")
  })

  test("duration falls back to string handler", () => {
    expect(toRbsType(duration())).toBe("String")
  })
})

describe("numeric subtype fallback", () => {
  test("int32 falls back to integer handler", () => {
    expect(toRbsType(int32())).toBe("Integer")
  })
})

describe("collections", () => {
  test("array of string", () => {
    expect(toRbsType(t(types.array(t(types.string))))).toBe("Array[String]")
  })

  test("tuple", () => {
    expect(toRbsType(t(types.tuple([t(types.string), t(types.number)])))).toBe("[String, Float]")
  })

  test("map", () => {
    expect(toRbsType(t(types.map(t(types.string), t(types.number))))).toBe("Hash[String, Float]")
  })
})

describe("union and nilable", () => {
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

describe("literal types", () => {
  test("string literal renders as a quoted literal type", () => {
    expect(toRbsType(t(types.literal("active")))).toBe('"active"')
  })

  test("number literal renders bare", () => {
    expect(toRbsType(t(types.literal(42)))).toBe("42")
  })

  test("boolean literal renders bare", () => {
    expect(toRbsType(t(types.literal(true)))).toBe("true")
  })

  test("null literal renders nil", () => {
    expect(toRbsType(t(types.literal(null)))).toBe("nil")
  })
})

describe("enum type expression", () => {
  test("without a name renders a literal union", () => {
    expect(toRbsType(t(types.enum(["a", "b"])))).toBe('"a" | "b"')
  })

  test("with meta.enumName renders the class reference", () => {
    expect(toRbsType(t(types.enum(["a", "b"]), { enumName: "Status" }))).toBe("Status")
  })
})

describe("ref and instance", () => {
  test("ref renders the bare target name", () => {
    expect(toRbsType(t(types.ref("User")))).toBe("User")
  })

  test("instance renders the bare class name", () => {
    expect(toRbsType(t(types.instance("Account", "src/account.ts")))).toBe("Account")
  })
})

describe("intersection", () => {
  test("renders & joined members", () => {
    expect(toRbsType(t(types.intersection([t(types.string), t(types.number)])))).toBe("String & Float")
  })
})

describe("function and interface", () => {
  test("function renders a ^(...) -> R proc type", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toRbsType(ref)).toBe("^(Float x) -> String")
  })

  test("interface degrades to untyped", () => {
    expect(toRbsType(t(types.interface({})))).toBe("untyped")
  })
})

describe("stream and page", () => {
  test("stream renders Enumerator[T]", () => {
    expect(toRbsType(t(types.stream(t(types.string))))).toBe("Enumerator[String]")
  })

  test("page degrades to Array[T]", () => {
    expect(toRbsType(t(types.page(t(types.string), "cursor")))).toBe("Array[String]")
  })
})

describe("unknown kind fallback", () => {
  test("falls back to untyped", () => {
    const ref = { shape: { kind: "bogus" } as never, meta: {} }
    expect(toRbsType(ref)).toBe("untyped")
  })
})

// ============================================================================
// toRbsFile — full .rbs file rendering
// ============================================================================

describe("toRbsFile: object", () => {
  test("emits a class with attr_reader lines and an initialize signature", () => {
    const ref = t(
      types.object({
        name: t(types.string),
        age: t(types.integer, { optional: true }),
      }),
    )
    const out = toRbsFile(ref, "Person")
    expect(out).toContain("class Person")
    expect(out).toContain("  attr_reader name: String")
    expect(out).toContain("  attr_reader age: Integer")
    expect(out).toContain("def initialize: (name: String, ?age: Integer) -> void")
    expect(out).toContain("end")
  })

  test("nullable-but-required field has no ? prefix on the initialize keyword", () => {
    const ref = t(types.object({ id: t(types.string, { nullable: true }) }))
    const out = toRbsFile(ref, "Thing")
    expect(out).toContain("attr_reader id: String?")
    expect(out).toContain("def initialize: (id: String?) -> void")
  })

  test("empty object has an empty initialize parameter list", () => {
    const out = toRbsFile(t(types.object({})), "Empty")
    expect(out).toContain("class Empty")
    expect(out).toContain("def initialize: () -> void")
  })

  test("description and deprecated render as leading comments", () => {
    const ref = t(types.object({ id: t(types.string) }), { description: "A person", deprecated: true })
    const out = toRbsFile(ref, "Person")
    const lines = out.split("\n")
    expect(lines[0]).toBe("# A person")
    expect(lines[1]).toBe("# @deprecated")
  })

  test("nested object field synthesizes a sibling class declaration", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    const out = toRbsFile(ref, "Person")
    expect(out).toContain("class PersonAddress")
    expect(out).toContain("  attr_reader city: String")
    expect(out).toContain("class Person")
    expect(out).toContain("attr_reader address: PersonAddress")
    expect(out).toContain("def initialize: (address: PersonAddress) -> void")
  })

  test("nested enum field synthesizes a sibling type alias", () => {
    const ref = t(types.object({ status: t(types.enum(["active", "inactive"])) }))
    const out = toRbsFile(ref, "Person")
    expect(out).toContain('type PersonStatus = "active" | "inactive"')
    expect(out).toContain("attr_reader status: PersonStatus")
  })

  test("array of nested object field synthesizes a sibling class wrapped in Array[]", () => {
    const ref = t(types.object({ addresses: t(types.array(t(types.object({ city: t(types.string) })))) }))
    const out = toRbsFile(ref, "Person")
    expect(out).toContain("class PersonAddresses")
    expect(out).toContain("attr_reader addresses: Array[PersonAddresses]")
  })

  test("array of nested enum field synthesizes a sibling type alias wrapped in Array[]", () => {
    const ref = t(types.object({ statuses: t(types.array(t(types.enum(["a", "b"])))) }))
    const out = toRbsFile(ref, "Person")
    expect(out).toContain('type PersonStatuses = "a" | "b"')
    expect(out).toContain("attr_reader statuses: Array[PersonStatuses]")
  })
})

describe("toRbsFile: enum", () => {
  test("top-level enum renders a single type alias", () => {
    const ref = t(types.enum(["active", "inactive"]))
    expect(toRbsFile(ref, "Status")).toBe('type Status = "active" | "inactive"\n')
  })

  test("description renders as a leading comment", () => {
    const ref = t(types.enum(["a"]), { description: "Lifecycle state" })
    const out = toRbsFile(ref, "Status")
    expect(out.split("\n")[0]).toBe("# Lifecycle state")
  })
})

describe("toRbsFile: non-object/enum kinds", () => {
  test("primitive renders a bare type alias", () => {
    expect(toRbsFile(t(types.string), "Name")).toBe("type Name = String\n")
  })

  test("union renders a type alias over the union expression", () => {
    const ref = t(types.union([t(types.string), t(types.integer)]))
    expect(toRbsFile(ref, "Id")).toBe("type Id = String | Integer\n")
  })

  test("discriminated union carries a degrade comment naming pattern matching", () => {
    const circle = t(types.object({ kind: t(types.literal("circle")), radius: t(types.number) }))
    const square = t(types.object({ kind: t(types.literal("square")), side: t(types.number) }))
    const ref = t(types.union([circle, square]), { discriminator: "kind" })
    const out = toRbsFile(ref, "Shape")
    expect(out).toContain('discriminated by "kind"')
    expect(out).toContain("case")
  })

  test("ref renders the bare target name", () => {
    expect(toRbsFile(t(types.ref("SomeType")), "Alias")).toBe("type Alias = SomeType\n")
  })
})
