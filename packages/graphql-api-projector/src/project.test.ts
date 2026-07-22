// packages/graphql-api-projector/src/project.test.ts — GraphQL field projection tests

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { getGraphQLMeta, projectGraphQL } from "./project.ts"
import type { FieldTypeMap } from "./project.ts"

// ============================================================================
// 1. Operation-type derivation — tag inference + meta.graphql.operation override
// ============================================================================

describe("operation-type derivation", () => {
  it("tags.readOnly:true → query", () => {
    const n = api_({ list: op((_: unknown) => [], { tags: { readOnly: true } }) })
    const { queryFields, mutationFields, subscriptionFields } = projectGraphQL(n)
    expect(queryFields.map((f) => f.name)).toEqual(["list"])
    expect(mutationFields).toHaveLength(0)
    expect(subscriptionFields).toHaveLength(0)
  })

  it("tags.streaming:true → subscription", () => {
    const n = api_({ watch: op((_: unknown) => ({}), { tags: { streaming: true } }) })
    const { queryFields, mutationFields, subscriptionFields } = projectGraphQL(n)
    expect(subscriptionFields.map((f) => f.name)).toEqual(["watch"])
    expect(queryFields).toHaveLength(0)
    expect(mutationFields).toHaveLength(0)
  })

  it("no tags → mutation (conservative default)", () => {
    const n = api_({ create: op((_: unknown) => ({})) })
    const { mutationFields } = projectGraphQL(n)
    expect(mutationFields.map((f) => f.name)).toEqual(["create"])
  })

  it("a `stream` output TypeRef (no tags asserted) → subscription", () => {
    const n = api_({ watch: op((_: unknown) => ({})) })
    const types_: FieldTypeMap = { watch: { output: t(types.stream(t(types.string))) } }
    const { queryFields, mutationFields, subscriptionFields } = projectGraphQL(n, { types: types_ })
    expect(subscriptionFields.map((f) => f.name)).toEqual(["watch"])
    expect(queryFields).toHaveLength(0)
    expect(mutationFields).toHaveLength(0)
  })

  it("an explicit tags.streaming:false wins over a `stream` output TypeRef", () => {
    const n = api_({ watch: op((_: unknown) => ({}), { tags: { streaming: false } }) })
    const types_: FieldTypeMap = { watch: { output: t(types.stream(t(types.string))) } }
    const { mutationFields, subscriptionFields } = projectGraphQL(n, { types: types_ })
    expect(subscriptionFields).toHaveLength(0)
    expect(mutationFields.map((f) => f.name)).toEqual(["watch"])
  })

  it("meta.graphql.operation overrides tag inference", () => {
    const n = api_({
      // readOnly would normally mean "query" — explicit override forces mutation.
      refresh: op((_: unknown) => ({}), { tags: { readOnly: true }, graphql: { operation: "mutation" } }),
    })
    const { queryFields, mutationFields } = projectGraphQL(n)
    expect(queryFields).toHaveLength(0)
    expect(mutationFields.map((f) => f.name)).toEqual(["refresh"])
  })

  it("destructive/idempotent leaf with no readOnly/streaming → mutation", () => {
    const n = api_({ remove: op((_: unknown) => null, { tags: { destructive: true, idempotent: true } }) })
    const { mutationFields } = projectGraphQL(n)
    expect(mutationFields.map((f) => f.name)).toEqual(["remove"])
  })
})

// ============================================================================
// 2. Field shape — nested Query, flat Mutation/Subscription
// ============================================================================

describe("nested Query vs flat Mutation/Subscription", () => {
  it("Query: a branch synthesizes a namespace type; root gets one field pointing at it", () => {
    const n = api_({
      users: api_({
        list: op((_: unknown) => [], { tags: { readOnly: true } }),
        get: op((_: unknown) => ({}), { tags: { readOnly: true } }),
      }),
    })
    const result = projectGraphQL(n)
    expect(result.queryFields.map((f) => f.name)).toEqual(["users"])
    expect(result.queryFields[0]!.typeSDL).toBe("UsersQuery!")
    expect(result.types.UsersQuery).toBeDefined()
    const nested = (result.types.UsersQuery!.meta.graphqlFields as { name: string }[]).map((f) => f.name)
    expect(nested.sort()).toEqual(["get", "list"])
  })

  it("deeper nesting synthesizes a PascalCase-joined namespace type name", () => {
    const n = api_({
      users: api_({
        admin: api_({
          list: op((_: unknown) => [], { tags: { readOnly: true } }),
        }),
      }),
    })
    const result = projectGraphQL(n)
    expect(result.types.UsersAdminQuery).toBeDefined()
    expect(result.types.UsersQuery).toBeDefined()
    const usersFields = (result.types.UsersQuery!.meta.graphqlFields as { name: string; argsSDL: string; typeSDL: string }[])
    expect(usersFields).toEqual([{ name: "admin", argsSDL: "", typeSDL: "UsersAdminQuery!" }])
  })

  it("Mutation: camelCase-joins the full tree path into one flat field name", () => {
    const n = api_({
      users: api_({
        create: op((_: unknown) => ({})),
        delete: op((_: unknown) => null, { tags: { destructive: true } }),
      }),
    })
    const { mutationFields } = projectGraphQL(n)
    expect(mutationFields.map((f) => f.name).sort()).toEqual(["usersCreate", "usersDelete"])
  })

  it("Subscription: camelCase-joins the full tree path into one flat field name", () => {
    const n = api_({
      orders: api_({
        watch: op((_: unknown) => ({}), { tags: { streaming: true } }),
      }),
    })
    const { subscriptionFields } = projectGraphQL(n)
    expect(subscriptionFields.map((f) => f.name)).toEqual(["ordersWatch"])
  })

  it("root-level leaf field name is just the leaf key, in every operation type", () => {
    const n = api_({
      ping: op((_: unknown) => "pong", { tags: { readOnly: true } }),
      poke: op((_: unknown) => null),
    })
    const { queryFields, mutationFields } = projectGraphQL(n)
    expect(queryFields.map((f) => f.name)).toEqual(["ping"])
    expect(mutationFields.map((f) => f.name)).toEqual(["poke"])
  })
})

// ============================================================================
// 3. Fallback (wildcard capture) → named argument
// ============================================================================

describe("fallback → named GraphQL argument", () => {
  it("a fallback under a flat (mutation) leaf becomes an ID! arg on that leaf's field", () => {
    const n = api_(
      {},
      {
        fallback: {
          name: "userId",
          subtree: api_({ delete: op((_: { userId: string }) => null, { tags: { destructive: true } }) }),
        },
      },
    )
    const { mutationFields, handlers } = projectGraphQL(n)
    const field = mutationFields.find((f) => f.name === "userIdDelete")
    expect(field).toBeDefined()
    expect(field!.argsSDL).toBe("(userId: ID!)")
    expect(handlers.get("userIdDelete")?.inputNames).toEqual(["userId"])
  })

  it("a fallback under a nested (query) leaf becomes an ID! arg on the leaf field itself (not the namespace field)", () => {
    const n = api_(
      {},
      {
        fallback: {
          name: "userId",
          subtree: api_({
            users: api_({ profile: op((_: { userId: string }) => ({}), { tags: { readOnly: true } }) }),
          }),
        },
      },
    )
    const result = projectGraphQL(n)
    // "userId" segment becomes the outer namespace; "users" nests beneath it.
    expect(result.types.UserIdQuery).toBeDefined()
    const outer = result.types.UserIdQuery!.meta.graphqlFields as { name: string; argsSDL: string; typeSDL: string }[]
    expect(outer).toEqual([{ name: "users", argsSDL: "", typeSDL: "UserIdUsersQuery!" }])
    const inner = result.types.UserIdUsersQuery!.meta.graphqlFields as { name: string; argsSDL: string }[]
    expect(inner[0]!.name).toBe("profile")
    expect(inner[0]!.argsSDL).toBe("(userId: ID!)")
  })

  it("captured args come before declared (type-derived) args, and a name collision favors the declared arg", () => {
    const typesMap: FieldTypeMap = {
      userId_rename: { input: t(types.object({ userId: t(types.string), name: t(types.string) })) },
    }
    const n = api_(
      {},
      {
        fallback: {
          name: "userId",
          subtree: api_({ rename: op((_: { userId: string; name: string }) => null) }),
        },
      },
    )
    const { mutationFields, handlers } = projectGraphQL(n, { types: typesMap })
    const field = mutationFields.find((f) => f.name === "userIdRename")!
    // Declared "userId: String!" wins over the captured "userId: ID!" placeholder — no duplicate.
    expect(field.argsSDL).toBe("(userId: String!, name: String!)")
    expect(handlers.get("userIdRename")?.inputNames).toEqual(["userId", "name"])
  })
})

// ============================================================================
// 4. Derived TypeRefs → args SDL + return SDL
// ============================================================================

describe("derived TypeRefs drive args/return SDL", () => {
  it("an object input TypeRef expands to one arg per field; output TypeRef drives the return type", () => {
    const typesMap: FieldTypeMap = {
      users_get: {
        input: t(types.object({ id: t(types.string) })),
        output: t(types.object({ name: t(types.string) }), { typeName: "User" }),
      },
    }
    const n = api_({
      users: api_({ get: op((_: { id: string }) => ({ name: "a" }), { tags: { readOnly: true } }) }),
    })
    const result = projectGraphQL(n, { types: typesMap })
    const inner = result.types.UsersQuery!.meta.graphqlFields as { name: string; argsSDL: string; typeSDL: string }[]
    const get = inner.find((f) => f.name === "get")!
    expect(get.argsSDL).toBe("(id: String!)")
    expect(get.typeSDL).toBe("User!")
  })

  it("no derived TypeRef → args empty, return degrades to JSON (nullable, unknown)", () => {
    const n = api_({ create: op((_: unknown) => ({})) })
    const { mutationFields } = projectGraphQL(n)
    expect(mutationFields[0]!.argsSDL).toBe("")
    expect(mutationFields[0]!.typeSDL).toBe("JSON")
  })

  it("an optional field (meta.optional) renders as nullable — no trailing !", () => {
    const typesMap: FieldTypeMap = {
      create: { input: t(types.object({ name: t(types.string, { optional: true }) })) },
    }
    const n = api_({ create: op((_: { name?: string }) => ({})) })
    const { mutationFields } = projectGraphQL(n, { types: typesMap })
    expect(mutationFields[0]!.argsSDL).toBe("(name: String)")
  })
})

// ============================================================================
// 5. meta.graphql per-projection overrides
// ============================================================================

describe("meta.graphql per-projection overrides", () => {
  it("getGraphQLMeta returns {} for an absent bag", () => {
    expect(getGraphQLMeta({})).toEqual({})
  })

  it("meta.graphql.name overrides the inferred field name", () => {
    const n = api_({ list: op((_: unknown) => [], { tags: { readOnly: true }, graphql: { name: "catalogList" } }) })
    const { queryFields } = projectGraphQL(n)
    expect(queryFields.map((f) => f.name)).toEqual(["catalogList"])
  })

  it("meta.graphql.description overrides meta.description overrides derived description", () => {
    const typesMap: FieldTypeMap = { list: { description: "derived" } }
    const n = api_({ list: op((_: unknown) => [], { description: "agnostic", graphql: { description: "gql-specific" } }) })
    const { mutationFields } = projectGraphQL(n, { types: typesMap })
    expect(mutationFields[0]!.description).toBe("gql-specific")
  })

  it("meta.description is used when meta.graphql.description is absent", () => {
    const n = api_({ list: op((_: unknown) => [], { description: "agnostic description" }) })
    const { mutationFields } = projectGraphQL(n)
    expect(mutationFields[0]!.description).toBe("agnostic description")
  })

  it("meta.tags.deprecated → deprecated:true on the field; meta.graphql.deprecated overrides it", () => {
    const n1 = api_({ old: op((_: unknown) => ({}), { tags: { deprecated: true } }) })
    expect(projectGraphQL(n1).mutationFields[0]!.deprecated).toBe(true)

    const n2 = api_({ old: op((_: unknown) => ({}), { tags: { deprecated: true }, graphql: { deprecated: false } }) })
    expect(projectGraphQL(n2).mutationFields[0]!.deprecated).toBeUndefined()
  })

  it("meta.graphql.deprecatedReason is only emitted when deprecated resolves true", () => {
    const n = api_({ old: op((_: unknown) => ({}), { tags: { deprecated: true }, graphql: { deprecatedReason: "use `new` instead" } }) })
    expect(projectGraphQL(n).mutationFields[0]!.deprecatedReason).toBe("use `new` instead")
  })

  it("meta.graphql.sourceMap is threaded onto the Dispatch entry", () => {
    const n = api_({
      create: op((_: unknown) => ({}), { graphql: { sourceMap: { name: { store: "argument", key: "fullName" } } } }),
    })
    const { handlers } = projectGraphQL(n)
    expect(handlers.get("create")?.sourceMap).toEqual({ name: { store: "argument", key: "fullName" } })
  })
})

// ============================================================================
// 6. Handler dispatch map
// ============================================================================

describe("handler dispatch", () => {
  it("a flat (mutation) field is keyed by its exact SDL field name", () => {
    const handler = (_: unknown) => "ok"
    const n = api_({ users: api_({ create: op(handler) }) })
    const { handlers } = projectGraphQL(n)
    expect(handlers.get("usersCreate")?.handler).toBe(handler)
    expect(handlers.get("usersCreate")?.operationType).toBe("mutation")
  })

  it("a nested (query) field is keyed by the underscore-joined tree path, not the bare field name — avoids collisions across namespaces", () => {
    const usersList = (_: unknown) => "users"
    const ordersList = (_: unknown) => "orders"
    const n = api_({
      users: api_({ list: op(usersList, { tags: { readOnly: true } }) }),
      orders: api_({ list: op(ordersList, { tags: { readOnly: true } }) }),
    })
    const { handlers } = projectGraphQL(n)
    expect(handlers.get("list")).toBeUndefined()
    expect(handlers.get("users_list")?.handler).toBe(usersList)
    expect(handlers.get("orders_list")?.handler).toBe(ordersList)
    expect(handlers.get("users_list")?.operationType).toBe("query")
  })
})
