import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { renderCapnp, toCapnpInterface, toCapnpStruct, toCapnpType } from "./capnp.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toCapnpType(t(types.boolean))).toBe("Bool")
  })

  test("int32", () => {
    expect(toCapnpType(int32())).toBe("Int32")
  })

  test("string", () => {
    expect(toCapnpType(t(types.string))).toBe("Text")
  })

  test("float64", () => {
    expect(toCapnpType(float64())).toBe("Float64")
  })

  test("bytes", () => {
    expect(toCapnpType(bytes())).toBe("Data")
  })
})

describe("string subtypes fall back to Text", () => {
  test("uuid", () => {
    expect(toCapnpType(uuid())).toBe("Text")
  })

  test("uri", () => {
    expect(toCapnpType(uri())).toBe("Text")
  })

  test("email", () => {
    expect(toCapnpType(email())).toBe("Text")
  })

  test("time", () => {
    expect(toCapnpType(time())).toBe("Text")
  })
})

describe("well-known conventions", () => {
  test("datetime -> Int64 (unix timestamp)", () => {
    expect(toCapnpType(datetime())).toBe("Int64")
  })

  test("date -> Int64 (unix timestamp; no calendar-only date type)", () => {
    expect(toCapnpType(date())).toBe("Int64")
  })

  test("duration -> Int64", () => {
    expect(toCapnpType(duration())).toBe("Int64")
  })

  test("unknown -> AnyPointer", () => {
    expect(toCapnpType(t(types.unknown))).toBe("AnyPointer")
  })

  test("void -> Void", () => {
    expect(toCapnpType(t(types.void))).toBe("Void")
  })

  test("null -> Void", () => {
    expect(toCapnpType(t(types.null))).toBe("Void")
  })

  test("never -> Void", () => {
    expect(toCapnpType(t(types.never))).toBe("Void")
  })
})

describe("array", () => {
  test("List(T)", () => {
    expect(toCapnpType(t(types.array(t(types.string))))).toBe("List(Text)")
  })

  test("nested array", () => {
    expect(toCapnpType(t(types.array(t(types.array(int32())))))).toBe("List(List(Int32))")
  })
})

describe("map", () => {
  test("standalone map type collapses to List(Entry)", () => {
    expect(toCapnpType(t(types.map(t(types.string), int64())))).toBe("List(Entry)")
  })
})

describe("tuple", () => {
  test("degrades to List(AnyPointer)", () => {
    expect(toCapnpType(t(types.tuple([int32(), t(types.string)])))).toBe("List(AnyPointer)")
  })
})

describe("union", () => {
  test("degrades to AnyPointer", () => {
    expect(toCapnpType(t(types.union([t(types.string), int32()])))).toBe("AnyPointer")
  })
})

describe("literal", () => {
  test("string literal -> Text", () => {
    expect(toCapnpType(t(types.literal("a")))).toBe("Text")
  })

  test("integer literal -> Int64", () => {
    expect(toCapnpType(t(types.literal(1)))).toBe("Int64")
  })

  test("float literal -> Float64", () => {
    expect(toCapnpType(t(types.literal(1.5)))).toBe("Float64")
  })

  test("boolean literal -> Bool", () => {
    expect(toCapnpType(t(types.literal(true)))).toBe("Bool")
  })

  test("null literal -> Void", () => {
    expect(toCapnpType(t(types.literal(null)))).toBe("Void")
  })
})

describe("object", () => {
  test("standalone object falls back to AnyPointer", () => {
    expect(toCapnpType(t(types.object({})))).toBe("AnyPointer")
  })

  test("named object uses meta.structName", () => {
    expect(toCapnpType(t(types.object({}), { structName: "Foo" }))).toBe("Foo")
  })
})

describe("enum", () => {
  test("falls back to generated name", () => {
    expect(toCapnpType(t(types.enum(["A", "B"])))).toBe("Enum2")
  })

  test("named enum uses meta.enumName", () => {
    expect(toCapnpType(t(types.enum(["A", "B"]), { enumName: "Status" }))).toBe("Status")
  })
})

describe("ref", () => {
  test("ref -> target name", () => {
    expect(toCapnpType(t(types.ref("Widget")))).toBe("Widget")
  })
})

describe("unknown kind fallback", () => {
  test("unrecognized kind falls back to AnyPointer", () => {
    expect(toCapnpType({ shape: { kind: "totally-unknown" } as never, meta: {} })).toBe("AnyPointer")
  })
})

describe("description", () => {
  test("meta.description sets the field description", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string, { description: "the user's name" }) })))
    expect(struct.fields[0]?.description).toBe("the user's name")
  })

  test("meta.description is absent by default", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string) })))
    expect(struct.fields[0]?.description).toBeUndefined()
  })

  test("renders as a # comment above the field", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string, { description: "the user's name" }) })))
    const rendered = renderCapnp([struct])
    expect(rendered).toContain("  # the user's name\n  name @0 :Text;")
  })

  test("renders as a # comment above the struct", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string) }), { description: "a person" }))
    const rendered = renderCapnp([struct])
    expect(rendered).toContain("# a person\nstruct Person {")
  })
})

describe("deprecated", () => {
  test("meta.deprecated true sets the field deprecated flag", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string, { deprecated: true }) })))
    expect(struct.fields[0]?.deprecated).toBe(true)
  })

  test("meta.deprecated string is preserved as the field's deprecation reason", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string, { deprecated: "use fullName" }) })))
    expect(struct.fields[0]?.deprecated).toBe("use fullName")
  })

  test("meta.deprecated is absent by default", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string) })))
    expect(struct.fields[0]?.deprecated).toBeUndefined()
  })

  test("renders as a # Deprecated comment above the field", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string, { deprecated: true }) })))
    const rendered = renderCapnp([struct])
    expect(rendered).toContain("  # Deprecated\n  name @0 :Text;")
  })

  test("renders with a reason when meta.deprecated is a string", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string, { deprecated: "use fullName" }) })))
    const rendered = renderCapnp([struct])
    expect(rendered).toContain("  # Deprecated: use fullName\n  name @0 :Text;")
  })

  test("renders as a # Deprecated comment above the struct", () => {
    const struct = toCapnpStruct("Person", t(types.object({ name: t(types.string) }), { deprecated: true }))
    const rendered = renderCapnp([struct])
    expect(rendered).toContain("# Deprecated\nstruct Person {")
  })

  test("interface: meta.deprecated renders as a # Deprecated comment", () => {
    const iface = toCapnpInterface(
      "Greeter",
      t(types.interface({ greet: t(types.method([], t(types.void))) }), { deprecated: "use Greeter2" }),
    )
    const rendered = renderCapnp([], undefined, [iface])
    expect(rendered).toContain("# Deprecated: use Greeter2\ninterface Greeter {")
  })
})

describe("toCapnpStruct", () => {
  test("flat object with auto-numbered ordinals starting at 0", () => {
    const ref = t(
      types.object({
        id: uuid(),
        name: t(types.string),
        age: int32(),
      }),
    )
    const struct = toCapnpStruct("Person", ref)
    expect(struct.name).toBe("Person")
    expect(struct.fields).toEqual([
      { name: "id", type: "Text", ordinal: 0 },
      { name: "name", type: "Text", ordinal: 1 },
      { name: "age", type: "Int32", ordinal: 2 },
    ])
    expect(struct.nestedStructs).toBeUndefined()
  })

  test("nested object field produces a nested struct", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const struct = toCapnpStruct("Person", ref)
    expect(struct.fields).toEqual([{ name: "address", type: "Address", ordinal: 0 }])
    expect(struct.nestedStructs).toEqual([
      { name: "Address", fields: [{ name: "city", type: "Text", ordinal: 0 }] },
    ])
  })

  test("array of nested objects produces a List(NestedStruct) field", () => {
    const ref = t(
      types.object({
        tags: t(types.array(t(types.object({ label: t(types.string) })))),
      }),
    )
    const struct = toCapnpStruct("Post", ref)
    expect(struct.fields).toEqual([{ name: "tags", type: "List(Tags)", ordinal: 0 }])
    expect(struct.nestedStructs?.[0]?.name).toBe("Tags")
  })

  test("enum field produces a nested enum", () => {
    const ref = t(types.object({ status: t(types.enum(["ACTIVE", "INACTIVE"])) }))
    const struct = toCapnpStruct("Account", ref)
    expect(struct.fields).toEqual([{ name: "status", type: "Status", ordinal: 0 }])
    expect(struct.nestedEnums).toEqual([{ name: "Status", values: ["ACTIVE", "INACTIVE"] }])
  })

  test("map field produces a helper Entry struct", () => {
    const ref = t(
      types.object({
        props: t(types.map(t(types.string), int64())),
      }),
    )
    const struct = toCapnpStruct("Widget", ref)
    expect(struct.fields).toEqual([{ name: "props", type: "List(PropsEntry)", ordinal: 0 }])
    expect(struct.nestedStructs).toEqual([
      {
        name: "PropsEntry",
        fields: [
          { name: "key", type: "Text", ordinal: 0 },
          { name: "value", type: "Int64", ordinal: 1 },
        ],
      },
    ])
  })
})

describe("union root", () => {
  const successResponse = t(
    types.object({
      type: t(types.literal("success")),
      data: t(types.object({ result: t(types.string) })),
    }),
  )
  const errorResponse = t(
    types.object({
      type: t(types.literal("error")),
      code: t(types.integer),
      message: t(types.string),
    }),
  )
  const paginatedResponse = t(
    types.object({
      type: t(types.literal("paginated")),
      items: t(types.array(t(types.string))),
      cursor: t(types.string),
      hasMore: t(types.boolean),
    }),
  )

  test("discriminated union: arm names come from the discriminator literal", () => {
    const ref = t(types.union([successResponse, errorResponse, paginatedResponse]), { discriminator: "type" })
    const struct = toCapnpStruct("ApiResponse", ref)
    expect(struct.name).toBe("ApiResponse")
    expect(struct.fields).toEqual([])
    expect(struct.unionFields).toEqual([
      { name: "success", type: "Success", ordinal: 0 },
      { name: "error", type: "Error", ordinal: 1 },
      { name: "paginated", type: "Paginated", ordinal: 2 },
    ])
    expect(struct.nestedStructs?.map((s) => s.name)).toEqual(["Success", "Error", "Paginated"])
    // Each variant lowers to a full nested struct via the ordinary object path.
    const errorStruct = struct.nestedStructs?.find((s) => s.name === "Error")
    expect(errorStruct?.fields).toEqual([
      { name: "type", type: "Text", ordinal: 0 },
      { name: "code", type: "Int64", ordinal: 1 },
      { name: "message", type: "Text", ordinal: 2 },
    ])
  })

  test("plain union (no discriminator) falls back to positional variant names", () => {
    const ref = t(types.union([successResponse, errorResponse]))
    const struct = toCapnpStruct("ApiResponse", ref)
    expect(struct.unionFields).toEqual([
      { name: "variant0", type: "Variant0", ordinal: 0 },
      { name: "variant1", type: "Variant1", ordinal: 1 },
    ])
  })

  test("mixed union: non-object variants become direct union arms", () => {
    const ref = t(types.union([t(types.string), int32(), successResponse]), { discriminator: "type" })
    const struct = toCapnpStruct("Mixed", ref)
    expect(struct.unionFields).toEqual([
      { name: "variant0", type: "Text", ordinal: 0 },
      { name: "variant1", type: "Int32", ordinal: 1 },
      { name: "success", type: "Success", ordinal: 2 },
    ])
    // Only the object variant produces a nested struct.
    expect(struct.nestedStructs?.map((s) => s.name)).toEqual(["Success"])
  })

  test("renders as a wrapper struct with an anonymous union block", () => {
    const ref = t(types.union([successResponse, errorResponse]), { discriminator: "type" })
    const struct = toCapnpStruct("ApiResponse", ref)
    const output = renderCapnp([struct])
    expect(output).toContain("struct ApiResponse {")
    expect(output).toContain("  union {")
    expect(output).toContain("    success @0 :Success;")
    expect(output).toContain("    error @1 :Error;")
    expect(output).toContain("  }")
    expect(output).toContain("struct Success {")
    expect(output).toContain("struct Error {")
  })
})

describe("renderCapnp", () => {
  test("renders a flat struct with a placeholder id comment", () => {
    const struct = toCapnpStruct(
      "Person",
      t(
        types.object({
          id: uuid(),
          age: int32(),
        }),
      ),
    )
    expect(renderCapnp([struct])).toBe(
      [
        "# @0x... (assign a unique ID)",
        "",
        "struct Person {",
        "  id @0 :Text;",
        "  age @1 :Int32;",
        "}",
        "",
      ].join("\n"),
    )
  })

  test("renders the provided file id", () => {
    const struct = toCapnpStruct("Empty", t(types.object({})))
    const output = renderCapnp([struct], "0xabcdef1234567890")
    expect(output.startsWith("@0xabcdef1234567890;\n")).toBe(true)
  })

  test("renders nested structs and enums", () => {
    const struct = toCapnpStruct(
      "Account",
      t(
        types.object({
          status: t(types.enum(["ACTIVE", "INACTIVE"])),
          address: t(types.object({ city: t(types.string) })),
        }),
      ),
    )
    const output = renderCapnp([struct])
    expect(output).toContain("enum Status {")
    expect(output).toContain("active @0;")
    expect(output).toContain("inactive @1;")
    expect(output).toContain("struct Address {")
    expect(output).toContain("city @0 :Text;")
  })

  test("renders map fields as List(Entry) with a helper struct", () => {
    const struct = toCapnpStruct(
      "Widget",
      t(
        types.object({
          props: t(types.map(t(types.string), t(types.string))),
        }),
      ),
    )
    const output = renderCapnp([struct])
    expect(output).toContain("props @0 :List(PropsEntry);")
    expect(output).toContain("struct PropsEntry {")
    expect(output).toContain("key @0 :Text;")
    expect(output).toContain("value @1 :Text;")
  })
})

describe("function", () => {
  test("degrades to AnyPointer (no callable-type construct)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toCapnpType(ref)).toBe("AnyPointer")
  })
})

describe("method", () => {
  test("as a field, falls back to AnyPointer via registerParent", () => {
    const ref = t(types.method([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toCapnpType(ref)).toBe("AnyPointer")
  })
})

describe("interface -> Cap'n Proto interface (the key use case)", () => {
  test("toCapnpInterface lowers each method to a native interface method", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        getBalance: t(types.method([], t(types.number))),
      }),
    )
    const iface = toCapnpInterface("AccountService", ref)
    expect(iface).toEqual({
      name: "AccountService",
      methods: [
        { name: "deposit", ordinal: 0, params: [{ name: "amount", type: "Float64" }], results: [] },
        { name: "getBalance", ordinal: 1, params: [], results: [{ name: "result", type: "Float64" }] },
      ],
    })
  })

  test("renders as native `interface { method @N (...) -> (...); }` syntax", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    const iface = toCapnpInterface("AccountService", ref)
    const output = renderCapnp([], undefined, [iface])
    expect(output).toContain("interface AccountService {")
    expect(output).toContain("deposit @0 (amount :Float64) -> ();")
  })
})

describe("stream", () => {
  test("degrades to the same List(T) encoding as array (no field-level streaming type)", () => {
    expect(toCapnpType(t(types.stream(t(types.string))))).toBe("List(Text)")
  })
})
