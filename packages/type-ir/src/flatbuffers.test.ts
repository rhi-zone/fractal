import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, email, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import {
  renderFlatBuffers,
  toFlatBuffers,
  toFlatBuffersDeclarations,
  toFlatBuffersService,
  toFlatBuffersTable,
} from "./flatbuffers.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toFlatBuffers(t(types.boolean))).toBe("bool")
  })

  test("int32", () => {
    expect(toFlatBuffers(int32())).toBe("int32")
  })

  test("int64", () => {
    expect(toFlatBuffers(int64())).toBe("int64")
  })

  test("string", () => {
    expect(toFlatBuffers(t(types.string))).toBe("string")
  })

  test("float64", () => {
    expect(toFlatBuffers(float64())).toBe("double")
  })

  test("bytes -> [ubyte]", () => {
    expect(toFlatBuffers(bytes())).toBe("[ubyte]")
  })

  test("integer -> int", () => {
    expect(toFlatBuffers(t(types.integer))).toBe("int")
  })

  test("number -> double", () => {
    expect(toFlatBuffers(t(types.number))).toBe("double")
  })
})

describe("string subtypes fall back to string", () => {
  test("uuid", () => {
    expect(toFlatBuffers(uuid())).toBe("string")
  })

  test("uri", () => {
    expect(toFlatBuffers(uri())).toBe("string")
  })

  test("email", () => {
    expect(toFlatBuffers(email())).toBe("string")
  })

  test("time", () => {
    expect(toFlatBuffers(time())).toBe("string")
  })
})

describe("temporal well-known conventions", () => {
  test("datetime -> int64 (unix-timestamp convention)", () => {
    expect(toFlatBuffers(datetime())).toBe("int64")
  })

  test("date -> int64 (unix-timestamp convention; no calendar-only date type)", () => {
    expect(toFlatBuffers(date())).toBe("int64")
  })

  test("duration -> int64", () => {
    expect(toFlatBuffers(duration())).toBe("int64")
  })
})

describe("null/void/unknown", () => {
  test("null degrades to opaque bytes standalone", () => {
    expect(toFlatBuffers(t(types.null))).toBe("[ubyte]")
  })

  test("void degrades to opaque bytes standalone", () => {
    expect(toFlatBuffers(t(types.void))).toBe("[ubyte]")
  })

  test("unknown -> [ubyte]", () => {
    expect(toFlatBuffers(t(types.unknown))).toBe("[ubyte]")
  })
})

describe("array", () => {
  test("vector of element type", () => {
    expect(toFlatBuffers(t(types.array(t(types.string))))).toBe("[string]")
  })
})

describe("map", () => {
  test("degrades to a vector of KeyValuePair", () => {
    expect(toFlatBuffers(t(types.map(t(types.string), int64())))).toBe("[KeyValuePair]")
  })

  test("meta.entryName names the entry table", () => {
    expect(toFlatBuffers(t(types.map(t(types.string), int64()), { entryName: "Prop" }))).toBe("[Prop]")
  })
})

describe("tuple", () => {
  test("standalone falls back to meta.tableName or AnyTuple", () => {
    expect(toFlatBuffers(t(types.tuple([int32(), int32()])))).toBe("AnyTuple")
    expect(toFlatBuffers(t(types.tuple([int32(), int32()]), { tableName: "Pair" }))).toBe("Pair")
  })
})

describe("union", () => {
  test("standalone falls back to meta.unionName or AnyUnion", () => {
    expect(toFlatBuffers(t(types.union([t(types.string), int32()])))).toBe("AnyUnion")
    expect(toFlatBuffers(t(types.union([t(types.string), int32()]), { unionName: "Shape" }))).toBe("Shape")
  })
})

describe("literal", () => {
  test("string literal -> string", () => {
    expect(toFlatBuffers(t(types.literal("a")))).toBe("string")
  })

  test("integer literal -> int", () => {
    expect(toFlatBuffers(t(types.literal(1)))).toBe("int")
  })

  test("float literal -> double", () => {
    expect(toFlatBuffers(t(types.literal(1.5)))).toBe("double")
  })

  test("boolean literal -> bool", () => {
    expect(toFlatBuffers(t(types.literal(true)))).toBe("bool")
  })

  test("null literal -> bool (no null representation)", () => {
    expect(toFlatBuffers(t(types.literal(null)))).toBe("bool")
  })
})

describe("object", () => {
  test("standalone object falls back to AnyTable", () => {
    expect(toFlatBuffers(t(types.object({})))).toBe("AnyTable")
  })

  test("named object uses meta.tableName", () => {
    expect(toFlatBuffers(t(types.object({}), { tableName: "Foo" }))).toBe("Foo")
  })
})

describe("instance", () => {
  test("references by className", () => {
    expect(toFlatBuffers(t(types.instance("Widget", "./widget.ts")))).toBe("Widget")
  })
})

describe("ref", () => {
  test("ref -> target name", () => {
    expect(toFlatBuffers(t(types.ref("Widget")))).toBe("Widget")
  })
})

describe("intersection", () => {
  test("degrades to the first member's type", () => {
    expect(toFlatBuffers(t(types.intersection([t(types.string), int32()])))).toBe("string")
  })

  test("empty intersection degrades to opaque bytes", () => {
    expect(toFlatBuffers(t(types.intersection([])))).toBe("[ubyte]")
  })
})

describe("function / method", () => {
  test("function degrades to opaque bytes (no callable-type construct)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toFlatBuffers(ref)).toBe("[ubyte]")
  })

  test("method as a field falls back to opaque bytes via registerParent", () => {
    const ref = t(types.method([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toFlatBuffers(ref)).toBe("[ubyte]")
  })
})

describe("interface as a field", () => {
  test("degrades to opaque bytes (rpc_service is top-level only)", () => {
    const ref = t(types.interface({}))
    expect(toFlatBuffers(ref)).toBe("[ubyte]")
  })
})

describe("toFlatBuffersTable", () => {
  test("flat object", () => {
    const ref = t(
      types.object({
        id: uuid(),
        name: t(types.string),
        age: int32({ optional: true }),
      }),
    )
    const rendered = toFlatBuffersTable("Person", ref)
    expect(rendered).toBe(
      ["table Person {", "  id:string (required);", "  name:string (required);", "  age:int32;", "}"].join("\n"),
    )
  })

  test("null/void fields are skipped", () => {
    const ref = t(types.object({ name: t(types.string), nothing: t(types.void), empty: t(types.null) }))
    const rendered = toFlatBuffersTable("Widget", ref)
    expect(rendered).not.toContain("nothing")
    expect(rendered).not.toContain("empty")
  })

  test("nested object field hoists a sibling table, referenced by name", () => {
    const ref = t(types.object({ address: t(types.object({ city: t(types.string) })) }))
    const rendered = toFlatBuffersTable("Person", ref)
    expect(rendered).toContain("table Address {")
    expect(rendered).toContain("  city:string (required);")
    expect(rendered).toContain("table Person {")
    expect(rendered).toContain("  address:Address (required);")
    // Sibling declaration comes first (FlatBuffers requires types be declared before use).
    expect(rendered.indexOf("table Address")).toBeLessThan(rendered.indexOf("table Person"))
  })

  test("array of nested objects hoists a sibling table, referenced as a vector", () => {
    const ref = t(types.object({ tags: t(types.array(t(types.object({ label: t(types.string) })))) }))
    const rendered = toFlatBuffersTable("Post", ref)
    expect(rendered).toContain("table Tags {")
    expect(rendered).toContain("  tags:[Tags];")
  })

  test("enum field hoists a sibling enum", () => {
    const ref = t(types.object({ status: t(types.enum(["ACTIVE", "INACTIVE"])) }))
    const rendered = toFlatBuffersTable("Account", ref)
    expect(rendered).toContain("enum Status : int {")
    expect(rendered).toContain("  ACTIVE, INACTIVE")
    // Enums are int-backed, thus scalar (§ "Attributes") — flatc rejects
    // `required` on a scalar field, so this never carries the attribute.
    expect(rendered).toContain("  status:Status;")
  })

  test("union field hoists a sibling union", () => {
    const ref = t(types.object({ shape: t(types.union([t(types.string), int32()])) }))
    const rendered = toFlatBuffersTable("Widget", ref)
    expect(rendered).toContain("union Shape { string, int32 }")
    expect(rendered).toContain("  shape:Shape;")
  })

  test("map field hoists a sibling key/value entry table", () => {
    const ref = t(types.object({ props: t(types.map(t(types.string), t(types.string))) }))
    const rendered = toFlatBuffersTable("Widget", ref)
    expect(rendered).toContain("table PropsEntry {")
    expect(rendered).toContain("  key:string (required);")
    expect(rendered).toContain("  value:string (required);")
    expect(rendered).toContain("  props:[PropsEntry];")
  })

  test("tuple field hoists a sibling positional table", () => {
    const ref = t(types.object({ point: t(types.tuple([int32(), int32()])) }))
    const rendered = toFlatBuffersTable("Widget", ref)
    // int32 is scalar (§ "Attributes") — never carries `required`, even
    // though the field itself is non-optional; the `Point` table is
    // itself non-scalar so `point` on the parent still gets `required`.
    expect(rendered).toContain("table Point {")
    expect(rendered).toContain("  e0:int32;")
    expect(rendered).toContain("  e1:int32;")
    expect(rendered).toContain("  point:Point (required);")
  })

  test("top-level tuple lowers to a positional table", () => {
    const ref = t(types.tuple([t(types.string), int32()]))
    const rendered = toFlatBuffersTable("Pair", ref)
    // e0 (string) is non-scalar and keeps `required`; e1 (int32) is scalar
    // and never carries it (§ "Attributes" — flatc rejects `required` on a
    // scalar table field).
    expect(rendered).toBe(["table Pair {", "  e0:string (required);", "  e1:int32;", "}"].join("\n"))
  })

  test("deprecated field renders the (deprecated) attribute", () => {
    const ref = t(types.object({ name: t(types.string, { deprecated: true }) }))
    const rendered = toFlatBuffersTable("Person", ref)
    expect(rendered).toContain("name:string (required, deprecated);")
  })

  test("description renders as a /// doc comment", () => {
    const ref = t(types.object({ name: t(types.string, { description: "the user's name" }) }), {
      description: "a person",
    })
    const rendered = toFlatBuffersTable("Person", ref)
    expect(rendered).toContain("/// a person\ntable Person {")
    expect(rendered).toContain("  /// the user's name\n  name:string (required);")
  })
})

describe("toFlatBuffersService", () => {
  test("lowers each method to an rpc with synthesized request/response tables", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        getBalance: t(types.method([], t(types.number))),
      }),
    )
    const rendered = toFlatBuffersService("AccountService", ref)
    expect(rendered).toContain("table DepositRequest {")
    // double is scalar (§ "Attributes") — never carries `required`.
    expect(rendered).toContain("  amount:double;")
    expect(rendered).toContain("table DepositResponse {\n}")
    expect(rendered).toContain("table GetBalanceRequest {\n}")
    expect(rendered).toContain("table GetBalanceResponse {")
    expect(rendered).toContain("  result:double;")
    expect(rendered).toContain("rpc_service AccountService {")
    expect(rendered).toContain("  Deposit(DepositRequest):DepositResponse;")
    expect(rendered).toContain("  GetBalance(GetBalanceRequest):GetBalanceResponse;")
  })
})

describe("toFlatBuffersDeclarations", () => {
  test("dispatches object/enum/union/interface entries to their declaration form", () => {
    const registry = {
      Status: t(types.enum(["ACTIVE", "INACTIVE"])),
      Shape: t(types.union([t(types.string), int32()])),
      Person: t(types.object({ name: t(types.string) })),
      AccountService: t(types.interface({ ping: t(types.method([], t(types.void))) })),
    }
    const rendered = toFlatBuffersDeclarations(registry)
    expect(rendered).toContain("enum Status : int {")
    expect(rendered).toContain("union Shape { string, int32 }")
    expect(rendered).toContain("table Person {")
    expect(rendered).toContain("rpc_service AccountService {")
  })
})

describe("renderFlatBuffers", () => {
  test("renders a complete .fbs file with enums/unions/tables/services in dependency-safe order", () => {
    const rendered = renderFlatBuffers(
      [{ name: "Person", fields: [{ name: "name", field: { type: "string", required: true } }] }],
      [{ name: "Status", base: "int", values: ["ACTIVE", "INACTIVE"] }],
      [{ name: "Shape", types: ["string", "int32"] }],
      [
        {
          name: "AccountService",
          rpcs: [{ name: "Ping", requestType: "PingRequest", responseType: "PingResponse" }],
          tables: [
            { name: "PingRequest", fields: [] },
            { name: "PingResponse", fields: [] },
          ],
        },
      ],
    )
    expect(rendered).toContain("enum Status : int {")
    expect(rendered).toContain("union Shape { string, int32 }")
    expect(rendered).toContain("table Person {")
    expect(rendered).toContain("rpc_service AccountService {")
    expect(rendered.indexOf("enum Status")).toBeLessThan(rendered.indexOf("table Person"))
    expect(rendered.indexOf("union Shape")).toBeLessThan(rendered.indexOf("table Person"))
    expect(rendered.endsWith("\n")).toBe(true)
    expect(rendered.endsWith("\n\n")).toBe(false)
  })
})

describe("unrecognized metadata (open metadata bag)", () => {
  test("meta.brand is silently ignored — projects to the base type", () => {
    expect(toFlatBuffers(t(types.string, { brand: "LocationId" }))).toBe("string")
  })
})

describe("stream", () => {
  test("degrades to the same vector encoding as array (no streaming construct)", () => {
    expect(toFlatBuffers(t(types.stream(t(types.string))))).toBe("[string]")
  })
})
