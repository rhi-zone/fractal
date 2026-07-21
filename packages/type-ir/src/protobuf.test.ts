import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { bytes, date, datetime, duration, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"
import { renderProto, toProtoField, toProtoMessage, toProtoService } from "./protobuf.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toProtoField(t(types.boolean))).toEqual({ type: "bool", repeated: false, optional: false })
  })

  test("int32", () => {
    expect(toProtoField(int32())).toEqual({ type: "int32", repeated: false, optional: false })
  })

  test("string", () => {
    expect(toProtoField(t(types.string))).toEqual({ type: "string", repeated: false, optional: false })
  })

  test("float64", () => {
    expect(toProtoField(float64())).toEqual({ type: "double", repeated: false, optional: false })
  })

  test("bytes", () => {
    expect(toProtoField(bytes())).toEqual({ type: "bytes", repeated: false, optional: false })
  })
})

describe("string subtypes fall back to string", () => {
  test("uuid", () => {
    expect(toProtoField(uuid()).type).toBe("string")
  })

  test("uri", () => {
    expect(toProtoField(uri()).type).toBe("string")
  })

  test("date", () => {
    expect(toProtoField(date()).type).toBe("string")
  })

  test("time", () => {
    expect(toProtoField(time()).type).toBe("string")
  })
})

describe("well-known types", () => {
  test("datetime -> google.protobuf.Timestamp", () => {
    expect(toProtoField(datetime()).type).toBe("google.protobuf.Timestamp")
  })

  test("duration -> google.protobuf.Duration", () => {
    expect(toProtoField(duration()).type).toBe("google.protobuf.Duration")
  })

  test("unknown -> google.protobuf.Any", () => {
    expect(toProtoField(t(types.unknown)).type).toBe("google.protobuf.Any")
  })

  test("void -> google.protobuf.Empty", () => {
    expect(toProtoField(t(types.void)).type).toBe("google.protobuf.Empty")
  })

  test("null -> google.protobuf.NullValue", () => {
    expect(toProtoField(t(types.null)).type).toBe("google.protobuf.NullValue")
  })
})

describe("array", () => {
  test("repeated element type", () => {
    expect(toProtoField(t(types.array(t(types.string))))).toEqual({
      type: "string",
      repeated: true,
      optional: false,
    })
  })
})

describe("map", () => {
  test("map<key, value>", () => {
    const field = toProtoField(t(types.map(t(types.string), int64())))
    expect(field.type).toBe("map<string, int64>")
    expect(field.mapKey).toBe("string")
    expect(field.mapValue).toBe("int64")
  })
})

describe("tuple", () => {
  test("uniform elements collapse to repeated of that type", () => {
    const field = toProtoField(t(types.tuple([int32(), int32()])))
    expect(field).toEqual({ type: "int32", repeated: true, optional: false })
  })

  test("heterogeneous elements degrade to repeated Any", () => {
    const field = toProtoField(t(types.tuple([int32(), t(types.string)])))
    expect(field.type).toBe("google.protobuf.Any")
    expect(field.repeated).toBe(true)
  })
})

describe("union", () => {
  test("degrades to google.protobuf.Any", () => {
    expect(toProtoField(t(types.union([t(types.string), int32()]))).type).toBe("google.protobuf.Any")
  })
})

describe("literal", () => {
  test("string literal -> string", () => {
    expect(toProtoField(t(types.literal("a"))).type).toBe("string")
  })

  test("integer literal -> int64", () => {
    expect(toProtoField(t(types.literal(1))).type).toBe("int64")
  })

  test("float literal -> double", () => {
    expect(toProtoField(t(types.literal(1.5))).type).toBe("double")
  })

  test("boolean literal -> bool", () => {
    expect(toProtoField(t(types.literal(true))).type).toBe("bool")
  })
})

describe("object", () => {
  test("standalone object falls back to google.protobuf.Struct", () => {
    expect(toProtoField(t(types.object({}))).type).toBe("google.protobuf.Struct")
  })

  test("named object uses meta.messageName", () => {
    expect(toProtoField(t(types.object({}), { messageName: "Foo" })).type).toBe("Foo")
  })
})

describe("ref", () => {
  test("ref -> target name", () => {
    expect(toProtoField(t(types.ref("Widget"))).type).toBe("Widget")
  })
})

describe("optional / nullable", () => {
  test("meta.optional sets optional", () => {
    expect(toProtoField(t(types.string, { optional: true })).optional).toBe(true)
  })

  test("meta.nullable sets optional", () => {
    expect(toProtoField(t(types.string, { nullable: true })).optional).toBe(true)
  })
})

describe("deprecated", () => {
  test("meta.deprecated sets the deprecated field option", () => {
    const field = toProtoField(t(types.string, { deprecated: true }))
    expect(field.deprecated).toBe(true)
  })

  test("meta.deprecated is absent by default", () => {
    const field = toProtoField(t(types.string))
    expect(field.deprecated).toBeUndefined()
  })

  test("renders as a bracketed field option", () => {
    const message = toProtoMessage("Person", t(types.object({ name: t(types.string, { deprecated: true }) })))
    const rendered = renderProto([message])
    expect(rendered).toContain("string name = 1 [deprecated = true];")
  })
})

describe("description", () => {
  test("meta.description sets the field description", () => {
    const field = toProtoField(t(types.string, { description: "the user's name" }))
    expect(field.description).toBe("the user's name")
  })

  test("meta.description is absent by default", () => {
    const field = toProtoField(t(types.string))
    expect(field.description).toBeUndefined()
  })

  test("renders as a // comment above the field", () => {
    const message = toProtoMessage(
      "Person",
      t(types.object({ name: t(types.string, { description: "the user's name" }) })),
    )
    const rendered = renderProto([message])
    expect(rendered).toContain("  // the user's name\n  string name = 1;")
  })

  test("renders as a // comment above the message", () => {
    const message = toProtoMessage("Person", t(types.object({ name: t(types.string) }), { description: "a person" }))
    const rendered = renderProto([message])
    expect(rendered).toContain("// a person\nmessage Person {")
  })
})

describe("toProtoMessage", () => {
  test("flat object with auto-numbered fields", () => {
    const ref = t(
      types.object({
        id: uuid(),
        name: t(types.string),
        age: int32({ optional: true }),
      }),
    )
    const message = toProtoMessage("Person", ref)
    expect(message.name).toBe("Person")
    expect(message.fields).toEqual([
      { name: "id", field: { type: "string", repeated: false, optional: false }, number: 1 },
      { name: "name", field: { type: "string", repeated: false, optional: false }, number: 2 },
      { name: "age", field: { type: "int32", repeated: false, optional: true }, number: 3 },
    ])
    expect(message.nestedMessages).toBeUndefined()
  })

  test("nested object field produces a nested message", () => {
    const ref = t(
      types.object({
        address: t(types.object({ city: t(types.string) })),
      }),
    )
    const message = toProtoMessage("Person", ref)
    expect(message.fields).toEqual([
      { name: "address", field: { type: "Address", repeated: false, optional: false }, number: 1 },
    ])
    expect(message.nestedMessages).toEqual([
      { name: "Address", fields: [{ name: "city", field: { type: "string", repeated: false, optional: false }, number: 1 }] },
    ])
  })

  test("array of nested objects produces a repeated nested message field", () => {
    const ref = t(
      types.object({
        tags: t(types.array(t(types.object({ label: t(types.string) })))),
      }),
    )
    const message = toProtoMessage("Post", ref)
    expect(message.fields).toEqual([
      { name: "tags", field: { type: "Tags", repeated: true, optional: false }, number: 1 },
    ])
    expect(message.nestedMessages?.[0]?.name).toBe("Tags")
  })

  test("enum field produces a nested enum", () => {
    const ref = t(types.object({ status: t(types.enum(["ACTIVE", "INACTIVE"])) }))
    const message = toProtoMessage("Account", ref)
    expect(message.fields).toEqual([
      { name: "status", field: { type: "Status", repeated: false, optional: false }, number: 1 },
    ])
    expect(message.nestedEnums).toEqual([{ name: "Status", values: ["ACTIVE", "INACTIVE"] }])
  })
})

describe("renderProto", () => {
  test("renders a flat message", () => {
    const message = toProtoMessage(
      "Person",
      t(
        types.object({
          id: uuid(),
          age: int32({ optional: true }),
        }),
      ),
    )
    expect(renderProto([message])).toBe(
      [
        'syntax = "proto3";',
        "",
        "message Person {",
        "  string id = 1;",
        "  optional int32 age = 2;",
        "}",
        "",
      ].join("\n"),
    )
  })

  test("renders repeated and map fields", () => {
    const message = toProtoMessage(
      "Widget",
      t(
        types.object({
          tags: t(types.array(t(types.string))),
          props: t(types.map(t(types.string), t(types.string))),
        }),
      ),
    )
    const output = renderProto([message])
    expect(output).toContain("repeated string tags = 1;")
    expect(output).toContain("map<string, string> props = 2;")
  })

  test("renders nested messages and enums", () => {
    const message = toProtoMessage(
      "Account",
      t(
        types.object({
          status: t(types.enum(["ACTIVE", "INACTIVE"])),
          address: t(types.object({ city: t(types.string) })),
        }),
      ),
    )
    const output = renderProto([message])
    expect(output).toContain("enum Status {")
    expect(output).toContain("ACTIVE = 0;")
    expect(output).toContain("INACTIVE = 1;")
    expect(output).toContain("message Address {")
    expect(output).toContain("string city = 1;")
  })
})

describe("unrecognized metadata (open metadata bag)", () => {
  test("meta.brand is silently ignored — projects to the base field type", () => {
    expect(toProtoField(t(types.string, { brand: "LocationId" }))).toEqual({
      type: "string",
      repeated: false,
      optional: false,
    })
  })
})

describe("function", () => {
  test("degrades to google.protobuf.Any (no callable-type construct)", () => {
    const ref = t(types.function([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toProtoField(ref)).toEqual({
      type: "google.protobuf.Any",
      repeated: false,
      optional: false,
    })
  })
})

describe("method", () => {
  test("as a field, falls back to google.protobuf.Any via registerParent", () => {
    const ref = t(types.method([{ name: "x", type: t(types.number) }], t(types.string)))
    expect(toProtoField(ref)).toEqual({
      type: "google.protobuf.Any",
      repeated: false,
      optional: false,
    })
  })
})

describe("interface -> service (the key use case)", () => {
  test("toProtoService lowers each method to an RPC with synthesized request/response messages", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
        getBalance: t(types.method([], t(types.number))),
      }),
    )
    const service = toProtoService("AccountService", ref)
    expect(service.name).toBe("AccountService")
    expect(service.rpcs).toEqual([
      { name: "Deposit", requestType: "DepositRequest", responseType: "DepositResponse" },
      { name: "GetBalance", requestType: "GetBalanceRequest", responseType: "GetBalanceResponse" },
    ])
    expect(service.messages).toEqual([
      { name: "DepositRequest", fields: [{ name: "amount", field: { type: "double", repeated: false, optional: false }, number: 1 }] },
      { name: "DepositResponse", fields: [] },
      { name: "GetBalanceRequest", fields: [] },
      { name: "GetBalanceResponse", fields: [{ name: "result", field: { type: "double", repeated: false, optional: false }, number: 1 }] },
    ])
  })

  test("renderProto renders a service block alongside its synthesized messages", () => {
    const ref = t(
      types.interface({
        deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
      }),
    )
    const service = toProtoService("AccountService", ref)
    const output = renderProto([], [service])
    expect(output).toContain("message DepositRequest {")
    expect(output).toContain("double amount = 1;")
    expect(output).toContain("message DepositResponse {")
    expect(output).toContain("service AccountService {")
    expect(output).toContain("rpc Deposit(DepositRequest) returns (DepositResponse);")
  })
})

describe("stream", () => {
  test("field position degrades to repeated (no field-level streaming type)", () => {
    expect(toProtoField(t(types.stream(t(types.string))))).toEqual({
      type: "string",
      repeated: true,
      optional: false,
    })
  })

  test("a method returning a stream renders a server-streaming RPC", () => {
    const iface = t(
      types.interface({
        watch: t(types.method([], t(types.stream(t(types.string))))),
      }),
    )
    const service = toProtoService("WatchService", iface)
    expect(service.rpcs).toEqual([
      { name: "Watch", requestType: "WatchRequest", responseType: "WatchResponse", responseStreaming: true },
    ])
    const output = renderProto([], [service])
    expect(output).toContain("rpc Watch(WatchRequest) returns (stream WatchResponse);")
  })
})
