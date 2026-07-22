import { describe, expect, test } from "bun:test"
import { resolveRef } from "./index.ts"
import {
  fromProtoDescriptor,
  fromProtoField,
  fromProtoText,
  parseProtoText,
  type ProtoFileDescriptor,
} from "./from-protobuf.ts"

describe("scalar types", () => {
  test("int32", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_INT32" }).shape.kind).toBe("int32")
  })

  test("int64", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_INT64" }).shape.kind).toBe("int64")
  })

  test("sint32/fixed32/sfixed32 all collapse to int32", () => {
    for (const type of ["TYPE_SINT32", "TYPE_FIXED32", "TYPE_SFIXED32"] as const) {
      expect(fromProtoField({ name: "n", number: 1, type }).shape.kind).toBe("int32")
    }
  })

  test("sint64/fixed64/sfixed64 all collapse to int64", () => {
    for (const type of ["TYPE_SINT64", "TYPE_FIXED64", "TYPE_SFIXED64"] as const) {
      expect(fromProtoField({ name: "n", number: 1, type }).shape.kind).toBe("int64")
    }
  })

  test("uint32", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_UINT32" }).shape.kind).toBe("uint32")
  })

  test("uint64", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_UINT64" }).shape.kind).toBe("uint64")
  })

  test("float", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_FLOAT" }).shape.kind).toBe("float32")
  })

  test("double", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_DOUBLE" }).shape.kind).toBe("float64")
  })

  test("bool", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_BOOL" }).shape.kind).toBe("boolean")
  })

  test("string", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_STRING" }).shape.kind).toBe("string")
  })

  test("bytes", () => {
    expect(fromProtoField({ name: "n", number: 1, type: "TYPE_BYTES" }).shape.kind).toBe("bytes")
  })
})

describe("field modifiers", () => {
  test("proto3Optional -> meta.optional", () => {
    const field = fromProtoField({ name: "n", number: 1, type: "TYPE_STRING", proto3Optional: true })
    expect(field.meta.optional).toBe(true)
  })

  test("deprecated option -> meta.deprecated", () => {
    const field = fromProtoField({ name: "n", number: 1, type: "TYPE_STRING", options: { deprecated: true } })
    expect(field.meta.deprecated).toBe(true)
  })

  test("description -> meta.description", () => {
    const field = fromProtoField({ name: "n", number: 1, type: "TYPE_STRING", description: "a note" })
    expect(field.meta.description).toBe("a note")
  })

  test("repeated -> array", () => {
    const field = fromProtoField({ name: "n", number: 1, type: "TYPE_STRING", label: "LABEL_REPEATED" })
    expect(field.shape.kind).toBe("array")
    expect((field.shape as { element: { shape: { kind: string } } }).element.shape.kind).toBe("string")
  })
})

describe("well-known types", () => {
  const wk = (typeName: string) => fromProtoField({ name: "n", number: 1, type: "TYPE_MESSAGE", typeName })

  test("google.protobuf.Timestamp -> datetime", () => {
    expect(wk("google.protobuf.Timestamp").shape.kind).toBe("datetime")
  })

  test("google.protobuf.Duration -> duration", () => {
    expect(wk("google.protobuf.Duration").shape.kind).toBe("duration")
  })

  test("google.protobuf.Any -> unknown", () => {
    const ref = wk("google.protobuf.Any")
    expect(ref.shape.kind).toBe("unknown")
    expect(ref.meta.protobufType).toBe("google.protobuf.Any")
  })

  test("google.protobuf.Empty -> void", () => {
    expect(wk("google.protobuf.Empty").shape.kind).toBe("void")
  })

  test("google.protobuf.StringValue -> nullable string", () => {
    const ref = wk("google.protobuf.StringValue")
    expect(ref.shape.kind).toBe("string")
    expect(ref.meta.nullable).toBe(true)
  })

  test("google.protobuf.Int32Value -> nullable int32", () => {
    const ref = wk("google.protobuf.Int32Value")
    expect(ref.shape.kind).toBe("int32")
    expect(ref.meta.nullable).toBe(true)
  })

  test("leading-dot-qualified well-known name still resolves", () => {
    expect(wk(".google.protobuf.Timestamp").shape.kind).toBe("datetime")
  })
})

describe("fromProtoDescriptor: messages", () => {
  test("flat message -> object", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        {
          name: "Person",
          field: [
            { name: "id", number: 1, type: "TYPE_STRING" },
            { name: "age", number: 2, type: "TYPE_INT32" },
          ],
        },
      ],
    }
    const doc = fromProtoDescriptor(file)
    const person = doc.defs.Person!
    expect(person.shape.kind).toBe("object")
    const fields = (person.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.id!.shape.kind).toBe("string")
    expect(fields.age!.shape.kind).toBe("int32")
    expect(doc.root).toEqual({ shape: { kind: "ref", target: "Person" }, meta: {} })
  })

  test("nested message -> ref resolving into defs under a dotted path", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        {
          name: "Person",
          field: [{ name: "address", number: 1, type: "TYPE_MESSAGE", typeName: "Address" }],
          nestedType: [{ name: "Address", field: [{ name: "city", number: 1, type: "TYPE_STRING" }] }],
        },
      ],
    }
    const doc = fromProtoDescriptor(file)
    expect(Object.keys(doc.defs).sort()).toEqual(["Person", "Person.Address"])
    const person = doc.defs.Person!
    const fields = (person.shape as unknown as { fields: Record<string, { shape: { kind: "ref"; target: string }; meta: Record<string, unknown> }> }).fields
    expect(fields.address!.shape.kind).toBe("ref")
    expect(fields.address!.shape.target).toBe("Person.Address")
    const resolved = resolveRef(doc, fields.address!)
    expect(resolved.shape.kind).toBe("object")
  })

  test("self-referential (recursive) message resolves via ref without infinite inlining", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        {
          name: "Node",
          field: [
            { name: "value", number: 1, type: "TYPE_STRING" },
            { name: "next", number: 2, type: "TYPE_MESSAGE", typeName: "Node" },
          ],
        },
      ],
    }
    const doc = fromProtoDescriptor(file)
    const fields = (doc.defs.Node!.shape as { fields: Record<string, { shape: { kind: string; target?: string } }> }).fields
    expect(fields.next!.shape.kind).toBe("ref")
    expect((fields.next!.shape as { target: string }).target).toBe("Node")
  })
})

describe("fromProtoDescriptor: enums", () => {
  test("enum -> enum TypeRef with member names", () => {
    const file: ProtoFileDescriptor = {
      enumType: [
        {
          name: "Status",
          value: [
            { name: "ACTIVE", number: 0 },
            { name: "INACTIVE", number: 1 },
          ],
        },
      ],
    }
    const doc = fromProtoDescriptor(file)
    expect(doc.defs.Status!.shape).toEqual({ kind: "enum", members: ["ACTIVE", "INACTIVE"] })
  })

  test("enum-typed field -> ref into defs", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        {
          name: "Account",
          field: [{ name: "status", number: 1, type: "TYPE_ENUM", typeName: "Status" }],
        },
      ],
      enumType: [{ name: "Status", value: [{ name: "ACTIVE", number: 0 }] }],
    }
    const doc = fromProtoDescriptor(file)
    const fields = (doc.defs.Account!.shape as { fields: Record<string, { shape: { kind: string; target?: string } }> }).fields
    expect(fields.status!.shape).toEqual({ kind: "ref", target: "Status" })
  })
})

describe("fromProtoDescriptor: repeated fields", () => {
  test("repeated scalar -> array", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        { name: "Post", field: [{ name: "tags", number: 1, type: "TYPE_STRING", label: "LABEL_REPEATED" }] },
      ],
    }
    const doc = fromProtoDescriptor(file)
    const fields = (doc.defs.Post!.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.tags!.shape.kind).toBe("array")
  })
})

describe("fromProtoDescriptor: map fields", () => {
  test("map<string, int32> -> map TypeRef", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        {
          name: "Widget",
          field: [{ name: "props", number: 1, type: "TYPE_MESSAGE", typeName: "PropsEntry", label: "LABEL_REPEATED" }],
          nestedType: [
            {
              name: "PropsEntry",
              options: { mapEntry: true },
              field: [
                { name: "key", number: 1, type: "TYPE_STRING" },
                { name: "value", number: 2, type: "TYPE_INT32" },
              ],
            },
          ],
        },
      ],
    }
    const doc = fromProtoDescriptor(file)
    const fields = (doc.defs.Widget!.shape as { fields: Record<string, { shape: { kind: string; key: { shape: { kind: string } }; value: { shape: { kind: string } } } }> }).fields
    expect(fields.props!.shape.kind).toBe("map")
    expect(fields.props!.shape.key.shape.kind).toBe("string")
    expect(fields.props!.shape.value.shape.kind).toBe("int32")
    // The synthetic map-entry message is not a user-facing def.
    expect(doc.defs["Widget.PropsEntry"]).toBeUndefined()
  })
})

describe("fromProtoDescriptor: oneof", () => {
  test("oneof -> union field, each variant tagged with its original proto field name", () => {
    const file: ProtoFileDescriptor = {
      messageType: [
        {
          name: "Shape",
          field: [
            { name: "circle", number: 1, type: "TYPE_STRING", oneofIndex: 0 },
            { name: "square", number: 2, type: "TYPE_INT32", oneofIndex: 0 },
          ],
          oneofDecl: [{ name: "kind" }],
        },
      ],
    }
    const doc = fromProtoDescriptor(file)
    const fields = (doc.defs.Shape!.shape as unknown as { fields: Record<string, { shape: { kind: string; variants: { shape: { kind: string }; meta: Record<string, unknown> }[] }; meta: Record<string, unknown> }> }).fields
    expect(fields.kind!.shape.kind).toBe("union")
    expect(fields.kind!.meta.optional).toBe(true)
    const variants = fields.kind!.shape.variants
    expect(variants).toHaveLength(2)
    expect(variants[0]!.shape.kind).toBe("string")
    expect(variants[0]!.meta.protoFieldName).toBe("circle")
    expect(variants[1]!.shape.kind).toBe("int32")
    expect(variants[1]!.meta.protoFieldName).toBe("square")
    // Individual oneof member fields don't ALSO appear as top-level fields.
    expect(fields.circle).toBeUndefined()
    expect(fields.square).toBeUndefined()
  })
})

describe("parseProtoText", () => {
  test("parses a flat message with scalar fields", () => {
    const file = parseProtoText(`
      syntax = "proto3";

      message Person {
        string id = 1;
        int32 age = 2;
      }
    `)
    expect(file.messageType).toHaveLength(1)
    const person = file.messageType![0]!
    expect(person.name).toBe("Person")
    expect(person.field).toEqual([
      { name: "id", number: 1, type: "TYPE_STRING" },
      { name: "age", number: 2, type: "TYPE_INT32" },
    ])
  })

  test("parses repeated and optional fields", () => {
    const file = parseProtoText(`
      message Post {
        repeated string tags = 1;
        optional string subtitle = 2;
      }
    `)
    const fields = file.messageType![0]!.field!
    expect(fields[0]).toEqual({ name: "tags", number: 1, type: "TYPE_STRING", label: "LABEL_REPEATED" })
    expect(fields[1]).toEqual({ name: "subtitle", number: 2, type: "TYPE_STRING", proto3Optional: true })
  })

  test("parses map fields", () => {
    const file = parseProtoText(`
      message Widget {
        map<string, int32> props = 1;
      }
    `)
    const widget = file.messageType![0]!
    expect(widget.nestedType).toHaveLength(1)
    expect(widget.nestedType![0]!.name).toBe("PropsEntry")
    expect(widget.nestedType![0]!.options).toEqual({ mapEntry: true })
    expect(widget.field![0]).toMatchObject({ name: "props", type: "TYPE_MESSAGE", typeName: "PropsEntry", label: "LABEL_REPEATED" })
  })

  test("parses nested messages", () => {
    const file = parseProtoText(`
      message Person {
        message Address {
          string city = 1;
        }
        Address address = 1;
      }
    `)
    const person = file.messageType![0]!
    expect(person.nestedType).toHaveLength(1)
    expect(person.nestedType![0]!.name).toBe("Address")
    expect(person.field![0]).toMatchObject({ name: "address", type: "TYPE_MESSAGE", typeName: "Address" })
  })

  test("parses enums", () => {
    const file = parseProtoText(`
      enum Status {
        ACTIVE = 0;
        INACTIVE = 1;
      }
    `)
    expect(file.enumType).toEqual([
      {
        name: "Status",
        value: [
          { name: "ACTIVE", number: 0 },
          { name: "INACTIVE", number: 1 },
        ],
      },
    ])
  })

  test("parses oneof blocks, tagging fields with their oneofIndex", () => {
    const file = parseProtoText(`
      message Shape {
        oneof kind {
          string circle = 1;
          int32 square = 2;
        }
      }
    `)
    const shape = file.messageType![0]!
    expect(shape.oneofDecl).toEqual([{ name: "kind" }])
    expect(shape.field).toEqual([
      { name: "circle", number: 1, type: "TYPE_STRING", oneofIndex: 0 },
      { name: "square", number: 2, type: "TYPE_INT32", oneofIndex: 0 },
    ])
  })

  test("captures // comments as description on the following declaration", () => {
    const file = parseProtoText(`
      message Person {
        // the user's display name
        string name = 1;
      }
    `)
    expect(file.messageType![0]!.field![0]!.description).toBe("the user's display name")
  })

  test("parses the [deprecated = true] field option", () => {
    const file = parseProtoText(`
      message Person {
        string legacyId = 1 [deprecated = true];
      }
    `)
    expect(file.messageType![0]!.field![0]!.options).toEqual({ deprecated: true })
  })

  test("skips service/rpc blocks without corrupting surrounding parse state", () => {
    const file = parseProtoText(`
      message Ping {
        string value = 1;
      }

      service Pinger {
        rpc Do(Ping) returns (Ping);
      }

      message Pong {
        string value = 1;
      }
    `)
    expect(file.messageType!.map((m) => m.name)).toEqual(["Ping", "Pong"])
  })
})

describe("fromProtoText: end-to-end .proto -> TypeRefDocument", () => {
  test("messages, enums, nested types, map, oneof, repeated, well-known types all convert", () => {
    const doc = fromProtoText(`
      syntax = "proto3";

      // A user account.
      message Account {
        string id = 1;
        Status status = 2;
        repeated string tags = 3;
        map<string, int32> counters = 4;
        google.protobuf.Timestamp createdAt = 5;

        message Address {
          string city = 1;
        }
        Address address = 6;

        oneof contact {
          string email = 7;
          string phone = 8;
        }
      }

      enum Status {
        ACTIVE = 0;
        SUSPENDED = 1;
      }
    `)

    expect(Object.keys(doc.defs).sort()).toEqual(["Account", "Account.Address", "Status"])

    const account = doc.defs.Account!
    expect(account.meta.description).toBe("A user account.")
    const fields = (account.shape as unknown as { fields: Record<string, { shape: { kind: string; target?: string }; meta: Record<string, unknown> }> }).fields
    const addressRef = fields.address as unknown as { shape: { kind: "ref"; target: string }; meta: Record<string, unknown> }

    expect(fields.id!.shape.kind).toBe("string")
    expect(fields.status!.shape).toEqual({ kind: "ref", target: "Status" })
    expect(fields.tags!.shape.kind).toBe("array")
    expect(fields.counters!.shape.kind).toBe("map")
    expect(fields.createdAt!.shape.kind).toBe("datetime")
    expect(fields.address!.shape).toEqual({ kind: "ref", target: "Account.Address" })
    expect(fields.contact!.shape.kind).toBe("union")

    const resolvedAddress = resolveRef(doc, addressRef)
    expect((resolvedAddress.shape as unknown as { fields: Record<string, { shape: { kind: string } }> }).fields.city!.shape.kind).toBe("string")

    expect(doc.defs.Status!.shape).toEqual({ kind: "enum", members: ["ACTIVE", "SUSPENDED"] })
    expect(doc.root).toEqual({ shape: { kind: "ref", target: "Account" }, meta: {} })
  })
})
