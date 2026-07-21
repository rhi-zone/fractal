import { describe, expect, test } from "bun:test"
import { t, types, withMeta } from "./index.ts"
import { toGraphQL, toGraphQLType, toGraphQLTypes } from "./graphql.ts"
import { date, datetime } from "./kinds/common.ts"

describe("leaf types", () => {
  test("boolean", () => {
    expect(toGraphQL(t(types.boolean))).toBe("Boolean!")
  })

  test("number -> Float", () => {
    expect(toGraphQL(t(types.number))).toBe("Float!")
  })

  test("integer -> Int", () => {
    expect(toGraphQL(t(types.integer))).toBe("Int!")
  })

  test("string", () => {
    expect(toGraphQL(t(types.string))).toBe("String!")
  })

  test("unknown -> JSON", () => {
    expect(toGraphQL(t(types.unknown))).toBe("JSON!")
  })

  test("never -> JSON", () => {
    expect(toGraphQL(t(types.never))).toBe("JSON!")
  })

  test("null -> JSON (direct reference fallback)", () => {
    expect(toGraphQL(t(types.null))).toBe("JSON!")
  })

  test("void -> JSON (direct reference fallback)", () => {
    expect(toGraphQL(t(types.void))).toBe("JSON!")
  })

  // type-ir's datetime/date are the domain type `Date` (see kinds/date-time.ts),
  // not a wire-format string — GraphQL has no native Date scalar, so these use
  // the ecosystem-conventional custom scalar names (same idiom `JSON` uses above).
  test("datetime -> DateTime (conventional custom scalar)", () => {
    expect(toGraphQL(datetime())).toBe("DateTime!")
  })

  test("date -> Date (conventional custom scalar)", () => {
    expect(toGraphQL(date())).toBe("Date!")
  })
})

describe("nullability", () => {
  test("no optional/nullable -> non-null (!)", () => {
    expect(toGraphQL(t(types.string))).toBe("String!")
  })

  test("meta.optional -> nullable, no !", () => {
    expect(toGraphQL(t(types.string, { optional: true }))).toBe("String")
  })

  test("meta.nullable -> nullable, no !", () => {
    expect(toGraphQL(t(types.string, { nullable: true }))).toBe("String")
  })
})

describe("literal", () => {
  test("string literal -> String", () => {
    expect(toGraphQL(t(types.literal("hello")))).toBe("String!")
  })

  test("integer literal -> Int", () => {
    expect(toGraphQL(t(types.literal(42)))).toBe("Int!")
  })

  test("float literal -> Float", () => {
    expect(toGraphQL(t(types.literal(4.2)))).toBe("Float!")
  })

  test("boolean literal -> Boolean", () => {
    expect(toGraphQL(t(types.literal(true)))).toBe("Boolean!")
  })

  test("null literal -> JSON", () => {
    expect(toGraphQL(t(types.literal(null)))).toBe("JSON!")
  })
})

describe("enum", () => {
  test("inline reference uses meta.enumName", () => {
    const ref = t(types.enum(["RED", "GREEN"]), { enumName: "Color" })
    expect(toGraphQL(ref)).toBe("Color!")
  })

  test("inline reference falls back without a name", () => {
    expect(toGraphQL(t(types.enum(["RED", "GREEN"])))).toBe("Enum2!")
  })

  test("declaration emits enum block", () => {
    const decl = toGraphQLType("Color", t(types.enum(["RED", "GREEN", "BLUE"])))
    expect(decl).toBe("enum Color {\n  RED\n  GREEN\n  BLUE\n}")
  })
})

describe("ref", () => {
  test("references target by name", () => {
    expect(toGraphQL(t(types.ref("User")))).toBe("User!")
  })
})

describe("instance", () => {
  test("references className", () => {
    expect(toGraphQL(t(types.instance("Buffer", "node:buffer")))).toBe("Buffer!")
  })
})

describe("array", () => {
  test("non-null list of non-null elements", () => {
    expect(toGraphQL(t(types.array(t(types.string))))).toBe("[String!]!")
  })

  test("nullable list of nullable elements", () => {
    const ref = t(types.array(t(types.string, { optional: true })), { optional: true })
    expect(toGraphQL(ref)).toBe("[String]")
  })

  test("non-null list of nullable elements", () => {
    const ref = t(types.array(t(types.string, { optional: true })))
    expect(toGraphQL(ref)).toBe("[String]!")
  })
})

describe("tuple", () => {
  test("degrades to [JSON]", () => {
    expect(toGraphQL(t(types.tuple([t(types.string), t(types.number)])))).toBe("[JSON]!")
  })
})

describe("map", () => {
  test("degrades to JSON", () => {
    expect(toGraphQL(t(types.map(t(types.string), t(types.number))))).toBe("JSON!")
  })
})

describe("union", () => {
  test("inline reference uses meta.unionName", () => {
    const ref = t(types.union([t(types.ref("Dog")), t(types.ref("Cat"))]), { unionName: "Pet" })
    expect(toGraphQL(ref)).toBe("Pet!")
  })

  test("inline reference falls back to JSON without a name", () => {
    expect(toGraphQL(t(types.union([t(types.ref("Dog")), t(types.ref("Cat"))])))).toBe("JSON!")
  })

  test("declaration emits union of ref variants", () => {
    const ref = t(types.union([t(types.ref("Dog")), t(types.ref("Cat"))]))
    expect(toGraphQLType("Pet", ref)).toBe("union Pet = Dog | Cat")
  })

  test("declaration degrades to scalar when a variant can't be named", () => {
    const ref = t(types.union([t(types.ref("Dog")), t(types.string)]))
    expect(toGraphQLType("Pet", ref)).toBe("scalar Pet")
  })
})

describe("intersection", () => {
  test("inline reference uses meta.typeName", () => {
    const ref = t(types.intersection([t(types.object({ a: t(types.string) }))]), { typeName: "Combined" })
    expect(toGraphQL(ref)).toBe("Combined!")
  })

  test("declaration merges fields from all members", () => {
    const ref = t(
      types.intersection([
        t(types.object({ a: t(types.string) })),
        t(types.object({ b: t(types.number) })),
      ]),
    )
    expect(toGraphQLType("Combined", ref)).toBe("type Combined {\n  a: String!\n  b: Float!\n}")
  })
})

describe("function", () => {
  test("degrades to JSON in field position", () => {
    expect(toGraphQL(t(types.function([], t(types.void))))).toBe("JSON!")
  })
})

describe("object", () => {
  test("inline reference uses meta.typeName", () => {
    const ref = t(types.object({ name: t(types.string) }), { typeName: "User" })
    expect(toGraphQL(ref)).toBe("User!")
  })

  test("inline reference falls back to JSON without a name", () => {
    expect(toGraphQL(t(types.object({ name: t(types.string) })))).toBe("JSON!")
  })

  test("declaration emits type block with non-null fields by default", () => {
    const ref = t(types.object({ id: t(types.string), age: t(types.integer) }))
    expect(toGraphQLType("User", ref)).toBe("type User {\n  id: String!\n  age: Int!\n}")
  })

  test("optional field is nullable (no !)", () => {
    const ref = t(types.object({ nickname: t(types.string, { optional: true }) }))
    expect(toGraphQLType("User", ref)).toBe("type User {\n  nickname: String\n}")
  })

  test("null/void-typed fields are omitted entirely", () => {
    const ref = t(
      types.object({
        id: t(types.string),
        gone: t(types.null),
        callback: t(types.void),
      }),
    )
    expect(toGraphQLType("User", ref)).toBe("type User {\n  id: String!\n}")
  })

  test("method-typed field renders with arguments", () => {
    const ref = t(
      types.object({
        greet: t(types.method([{ name: "name", type: t(types.string) }], t(types.string))),
      }),
    )
    expect(toGraphQLType("Greeter", ref)).toBe("type Greeter {\n  greet(name: String!): String!\n}")
  })
})

describe("interface -> type with method fields", () => {
  test("methods become fields with arguments", () => {
    const ref = t(
      types.interface({
        getUser: t(types.method([{ name: "id", type: t(types.string) }], t(types.ref("User")))),
        ping: t(types.method([], t(types.boolean))),
      }),
    )
    expect(toGraphQLType("UserService", ref)).toBe(
      "type UserService {\n  getUser(id: String!): User!\n  ping: Boolean!\n}",
    )
  })
})

describe("description", () => {
  test("type-level description renders as a triple-quoted block", () => {
    const ref = withMeta(t(types.object({ id: t(types.string) })), { description: "A user in the system" })
    expect(toGraphQLType("User", ref)).toBe(
      '"""A user in the system"""\ntype User {\n  id: String!\n}',
    )
  })

  test("field-level description renders above the field", () => {
    const ref = t(types.object({ id: withMeta(t(types.string), { description: "Unique identifier" }) }))
    expect(toGraphQLType("User", ref)).toBe(
      'type User {\n  """Unique identifier"""\n  id: String!\n}',
    )
  })
})

describe("deprecated", () => {
  test("meta.deprecated renders @deprecated directive", () => {
    const ref = t(types.object({ old: withMeta(t(types.string), { deprecated: true }) }))
    expect(toGraphQLType("User", ref)).toBe("type User {\n  old: String! @deprecated\n}")
  })

  test("meta.deprecatedReason adds a reason argument", () => {
    const ref = t(
      types.object({
        old: withMeta(t(types.string), { deprecated: true, deprecatedReason: "use `newField` instead" }),
      }),
    )
    expect(toGraphQLType("User", ref)).toBe(
      'type User {\n  old: String! @deprecated(reason: "use `newField` instead")\n}',
    )
  })
})

describe("scalar fallback", () => {
  test("a leaf kind declared by name degrades to a custom scalar", () => {
    expect(toGraphQLType("MyString", t(types.string))).toBe("scalar MyString")
  })
})

describe("toGraphQLTypes", () => {
  test("emits multiple declarations separated by a blank line", () => {
    const registry = {
      User: t(types.object({ id: t(types.string) })),
      Color: t(types.enum(["RED", "GREEN"])),
    }
    expect(toGraphQLTypes(registry)).toBe(
      "type User {\n  id: String!\n}\n\nenum Color {\n  RED\n  GREEN\n}",
    )
  })
})

describe("stream", () => {
  test("resolves to the element's own SDL type (subscriptions yield individual values)", () => {
    expect(toGraphQL(t(types.stream(t(types.string))))).toBe("String!")
  })

  test("nullable element stays nullable", () => {
    const ref = t(types.stream(t(types.string, { nullable: true })))
    expect(toGraphQL(ref)).toBe("String!")
  })
})
