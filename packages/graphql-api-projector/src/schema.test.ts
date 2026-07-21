// packages/graphql-api-projector/src/schema.test.ts — SDL assembly tests

import { describe, expect, it } from "bun:test"
import { buildSchema } from "graphql"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toSchema, toSDL } from "./schema.ts"
import { projectGraphQL } from "./project.ts"
import type { FieldTypeMap } from "./project.ts"

describe("toSchema", () => {
  it("emits a schema{} block wired to Query only when there is no Mutation/Subscription", () => {
    const n = api_({ ping: op((_: unknown) => "pong", { tags: { readOnly: true } }) })
    const sdl = toSDL(n)
    expect(sdl).toContain("schema {\n  query: Query\n}")
    expect(sdl).toContain("type Query {")
    expect(sdl).not.toContain("type Mutation")
    expect(sdl).not.toContain("type Subscription")
  })

  it("wires mutation/subscription into the schema{} block only when fields exist", () => {
    const n = api_({
      create: op((_: unknown) => ({})),
      watch: op((_: unknown) => ({}), { tags: { streaming: true } }),
    })
    const sdl = toSDL(n)
    expect(sdl).toContain("mutation: Mutation")
    expect(sdl).toContain("subscription: Subscription")
    expect(sdl).toContain("type Mutation {")
    expect(sdl).toContain("type Subscription {")
  })

  it("an empty Query (no query-tagged leaves) still emits a syntactically valid placeholder field", () => {
    const n = api_({ create: op((_: unknown) => ({})) })
    const sdl = toSDL(n)
    expect(sdl).toContain("type Query {")
    expect(sdl).toContain("_empty: Boolean")
  })

  it("renders a synthesized Query namespace type with its own fields", () => {
    const n = api_({
      users: api_({
        list: op((_: unknown) => [], { tags: { readOnly: true } }),
      }),
    })
    const sdl = toSDL(n)
    expect(sdl).toContain("type UsersQuery {\n  list: JSON\n}")
    expect(sdl).toContain("users: UsersQuery!")
  })

  it("declares the JSON scalar only when it's actually referenced", () => {
    const withJson = toSDL(api_({ create: op((_: unknown) => ({})) }))
    expect(withJson).toContain("scalar JSON")

    const typesMap: FieldTypeMap = {
      create: { input: t(types.object({ name: t(types.string) })), output: t(types.string) },
    }
    const withoutJson = toSDL(api_({ create: op((_: { name: string }) => "ok") }), { types: typesMap })
    expect(withoutJson).not.toContain("scalar JSON")
  })

  it("renders caller-supplied namedTypes via type-ir's toGraphQLType", () => {
    const n = api_({
      users: api_({
        get: op((_: { id: string }) => ({ name: "a" }), { tags: { readOnly: true } }),
      }),
    })
    const typesMap: FieldTypeMap = {
      users_get: {
        input: t(types.object({ id: t(types.string) })),
        output: t(types.ref("User")),
      },
    }
    const namedTypes = {
      User: t(types.object({ name: t(types.string) }), { typeName: "User" }),
    }
    const sdl = toSchema(projectGraphQL(n, { types: typesMap, namedTypes }))
    expect(sdl).toContain("type User {\n  name: String!\n}")
    expect(sdl).toContain("get(id: String!): User!")
  })

  it("produces SDL that graphql-js's buildSchema accepts", () => {
    const typesMap: FieldTypeMap = {
      users_list: { output: t(types.array(t(types.string))) },
      users_create: { input: t(types.object({ name: t(types.string) })) },
      orders_watch: { output: t(types.string) },
    }
    const n = api_({
      users: api_({
        list: op((_: unknown) => [], { tags: { readOnly: true } }),
        create: op((_: { name: string }) => ({})),
      }),
      orders: api_({
        watch: op((_: unknown) => ({}), { tags: { streaming: true } }),
      }),
    })
    const sdl = toSDL(n, { types: typesMap })
    expect(() => buildSchema(sdl)).not.toThrow()
  })
})
