import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { date, datetime } from "./kinds/common.ts"
import { fromGraphql } from "./from-graphql.ts"

describe("scalar fields", () => {
  test("String -> nullable string", () => {
    const result = fromGraphql(`type T { f: String }`)
    expect(result.T?.shape).toEqual(types.object({ f: t(types.string, { nullable: true }) }))
  })

  test("String! -> non-null string", () => {
    const result = fromGraphql(`type T { f: String! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.string))
  })

  test("Int -> integer", () => {
    const result = fromGraphql(`type T { f: Int! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.integer))
  })

  test("Float -> number", () => {
    const result = fromGraphql(`type T { f: Float! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.number))
  })

  test("Boolean -> boolean", () => {
    const result = fromGraphql(`type T { f: Boolean! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.boolean))
  })

  test("ID -> string with format:id", () => {
    const result = fromGraphql(`type T { f: ID! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.string, { format: "id" }))
  })

  test("DateTime -> datetime()", () => {
    const result = fromGraphql(`type T { f: DateTime! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(datetime())
  })

  test("Date -> date()", () => {
    const result = fromGraphql(`type T { f: Date! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(date())
  })
})

describe("object types", () => {
  test("fields become object properties", () => {
    const result = fromGraphql(`
      type User {
        id: ID!
        name: String
      }
    `)
    const shape = result.User?.shape as { kind: string; fields: Record<string, unknown> }
    expect(shape.kind).toBe("object")
    expect(shape.fields.id).toEqual(t(types.string, { format: "id" }))
    expect(shape.fields.name).toEqual(t(types.string, { nullable: true }))
  })

  test("carries graphqlKind and typeName meta", () => {
    const result = fromGraphql(`type User { id: ID! }`)
    expect(result.User?.meta.graphqlKind).toBe("type")
    expect(result.User?.meta.typeName).toBe("User")
  })

  test("field referencing another declared type becomes a ref", () => {
    const result = fromGraphql(`
      type User { pet: Pet }
      type Pet { name: String }
    `)
    const shape = result.User?.shape as { fields: Record<string, unknown> }
    expect(shape.fields.pet).toEqual(t(types.ref("Pet"), { nullable: true }))
  })

  test("implements records interface names in meta", () => {
    const result = fromGraphql(`
      interface Node { id: ID! }
      type User implements Node { id: ID! }
    `)
    expect(result.User?.meta.implements).toEqual(["Node"])
  })
})

describe("input types", () => {
  test("input object -> object with graphqlKind: input", () => {
    const result = fromGraphql(`
      input UserInput {
        name: String!
        age: Int
      }
    `)
    const shape = result.UserInput?.shape as { kind: string; fields: Record<string, unknown> }
    expect(shape.kind).toBe("object")
    expect(result.UserInput?.meta.graphqlKind).toBe("input")
    expect(shape.fields.name).toEqual(t(types.string))
    expect(shape.fields.age).toEqual(t(types.integer, { nullable: true }))
  })

  test("default value captured in field meta", () => {
    const result = fromGraphql(`input UserInput { age: Int = 18 }`)
    const shape = result.UserInput?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }
    expect(shape.fields.age?.meta.default).toBe(18)
  })
})

describe("enum types", () => {
  test("enum -> enum members", () => {
    const result = fromGraphql(`enum Status { ACTIVE INACTIVE }`)
    expect(result.Status?.shape).toEqual(types.enum(["ACTIVE", "INACTIVE"]))
  })
})

describe("union types", () => {
  test("union -> union of refs", () => {
    const result = fromGraphql(`
      type A { a: String }
      type B { b: String }
      union AB = A | B
    `)
    const shape = result.AB?.shape as { kind: string; variants: unknown[] }
    expect(shape.kind).toBe("union")
    expect(shape.variants).toEqual([t(types.ref("A")), t(types.ref("B"))])
    expect(result.AB?.meta.unionName).toBe("AB")
  })
})

describe("interface types", () => {
  test("interface -> object with graphqlKind: interface", () => {
    const result = fromGraphql(`
      interface Node {
        id: ID!
      }
    `)
    const shape = result.Node?.shape as { kind: string; fields: Record<string, unknown> }
    expect(shape.kind).toBe("object")
    expect(result.Node?.meta.graphqlKind).toBe("interface")
    expect(shape.fields.id).toEqual(t(types.string, { format: "id" }))
  })
})

describe("list modifiers", () => {
  test("[T] -> nullable array of nullable T", () => {
    const result = fromGraphql(`type T { f: [String] }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.array(t(types.string, { nullable: true })), { nullable: true }))
  })

  test("[T!]! -> non-null array of non-null T", () => {
    const result = fromGraphql(`type T { f: [String!]! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.array(t(types.string))))
  })

  test("[T!] -> nullable array of non-null T", () => {
    const result = fromGraphql(`type T { f: [String!] }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.array(t(types.string)), { nullable: true }))
  })
})

describe("field arguments", () => {
  test("field with arguments becomes a method TypeRef", () => {
    const result = fromGraphql(`
      type Query {
        users(limit: Int, offset: Int!): [String!]!
      }
    `)
    const field = (result.Query?.shape as { fields: Record<string, { shape: unknown }> }).fields.users
    expect(field?.shape).toEqual({
      kind: "method",
      params: [
        { name: "limit", type: t(types.integer, { nullable: true }) },
        { name: "offset", type: t(types.integer) },
      ],
      returnType: t(types.array(t(types.string))),
    })
  })

  test("argument default value captured", () => {
    const result = fromGraphql(`type Query { users(limit: Int = 10): [String!]! }`)
    const field = result.Query?.shape as unknown as {
      fields: Record<string, { shape: { params: { type: { meta: Record<string, unknown> } }[] } }>
    }
    expect(field.fields.users?.shape.params[0]?.type.meta.default).toBe(10)
  })
})

describe("descriptions", () => {
  test("type description -> meta.description", () => {
    const result = fromGraphql(`
      """A person who uses the app"""
      type User { id: ID! }
    `)
    expect(result.User?.meta.description).toBe("A person who uses the app")
  })

  test("field description -> field meta.description", () => {
    const result = fromGraphql(`
      type User {
        """The user's unique id"""
        id: ID!
      }
    `)
    const field = (result.User?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields.id
    expect(field?.meta.description).toBe("The user's unique id")
  })
})

describe("custom scalars", () => {
  test("declared custom scalar -> unknown with graphqlScalar meta", () => {
    const result = fromGraphql(`scalar JSON`)
    expect(result.JSON?.shape).toEqual(types.unknown)
    expect(result.JSON?.meta.graphqlScalar).toBe("JSON")
  })

  test("field referencing an undeclared custom scalar -> unknown with graphqlScalar meta", () => {
    const result = fromGraphql(`type T { f: Upload! }`)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.unknown, { graphqlScalar: "Upload" }))
  })

  test("field referencing a declared custom scalar -> ref", () => {
    const result = fromGraphql(`
      scalar JSON
      type T { f: JSON! }
    `)
    const field = (result.T?.shape as { fields: Record<string, unknown> }).fields.f
    expect(field).toEqual(t(types.ref("JSON")))
  })
})

describe("directives", () => {
  test("@deprecated with reason -> meta.deprecated + meta.deprecatedReason", () => {
    const result = fromGraphql(`
      type T {
        old: String @deprecated(reason: "use new instead")
      }
    `)
    const field = (result.T?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields.old
    expect(field?.meta.deprecated).toBe(true)
    expect(field?.meta.deprecatedReason).toBe("use new instead")
  })

  test("@deprecated with no reason -> meta.deprecated only", () => {
    const result = fromGraphql(`type T { old: String @deprecated }`)
    const field = (result.T?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields.old
    expect(field?.meta.deprecated).toBe(true)
    expect(field?.meta.deprecatedReason).toBeUndefined()
  })

  test("custom directive captured in meta.directives", () => {
    const result = fromGraphql(`
      type T {
        secret: String @auth(role: "ADMIN")
      }
    `)
    const field = (result.T?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields.secret
    expect(field?.meta.directives).toEqual([{ name: "auth", args: { role: "ADMIN" } }])
  })
})
