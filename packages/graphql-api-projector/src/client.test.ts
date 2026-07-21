// packages/graphql-api-projector/src/client.test.ts — createGraphQLClient tests
//
// Two kinds of coverage:
//   1. Real round-trips: `createGraphQLClient` driven against a real
//      `createGraphQLServer` (built from the SAME tree/types), transport
//      wired directly to `server.execute` — no network, exercises the actual
//      document the client constructs against the actual resolver dispatch.
//   2. Mock-transport tests: assert the exact query text/variables the client
//      sends, and error propagation from a transport's `errors` array —
//      things a round-trip can't directly observe (the server swallows
//      document text on the way in).

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { createGraphQLClient, GraphQLClientError } from "./client.ts"
import type { GraphQLTransport } from "./client.ts"
import type { FieldTypeMap } from "./project.ts"
import { createGraphQLServer } from "./server.ts"

// ============================================================================
// Fixture: nested Query branch (with a fallback for slug-captured args),
// a flat Mutation, and a root-level scalar Query leaf — one tree exercising
// namespace nesting, fallback capture, flat mutation naming, and the
// no-output-TypeRef (scalar) degrade.
// ============================================================================

const tree = api_({
  users: api_(
    {
      get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), { tags: { readOnly: true } }),
      admin: api_({
        settings: op((_: unknown) => ({ theme: "dark" }), { tags: { readOnly: true } }),
      }),
    },
    {
      fallback: {
        name: "userId",
        subtree: api_({
          profile: op((input: { userId: string }) => ({ id: input.userId, bio: "hello" }), {
            tags: { readOnly: true },
          }),
          rename: op((input: { userId: string; name: string }) => ({ id: input.userId, name: input.name })),
        }),
      },
    },
  ),
  createUser: op((input: { name: string }) => ({ id: "1", name: input.name })),
  ping: op((_: unknown) => "pong", { tags: { readOnly: true } }),
})

const typesMap: FieldTypeMap = {
  users_get: { input: t(types.object({ id: t(types.string) })), output: t(types.ref("User")) },
  users_admin_settings: { output: t(types.ref("Settings")) },
  users_userId_profile: { output: t(types.ref("Profile")) },
  users_userId_rename: {
    input: t(types.object({ userId: t(types.string), name: t(types.string) })),
    output: t(types.ref("User")),
  },
  createUser: { input: t(types.object({ name: t(types.string) })), output: t(types.ref("User")) },
}

const namedTypes = {
  User: t(types.object({ id: t(types.string), name: t(types.string) }), { typeName: "User" }),
  Settings: t(types.object({ theme: t(types.string) }), { typeName: "Settings" }),
  Profile: t(types.object({ id: t(types.string), bio: t(types.string) }), { typeName: "Profile" }),
}

/** Adapts a real `GraphQLServer.execute` into a `GraphQLTransport`. */
function serverTransport(server: { execute: (q: string, v?: Record<string, unknown>) => Promise<{ data?: unknown; errors?: readonly { message: string; extensions?: unknown }[] }> }): GraphQLTransport {
  return async (query, variables) => {
    const result = await server.execute(query, variables)
    return { data: result.data, ...(result.errors !== undefined ? { errors: result.errors } : {}) }
  }
}

// ============================================================================
// 1. Proxy shape mirrors the tree
// ============================================================================

describe("createGraphQLClient — proxy shape", () => {
  it("mirrors branch/fallback/leaf structure", () => {
    const client = createGraphQLClient(tree, async () => ({}), { types: typesMap, namedTypes })
    expect(typeof client.users).toBe("object")
    expect(typeof client.users.get).toBe("function")
    expect(typeof client.users.admin).toBe("object")
    expect(typeof client.users.admin.settings).toBe("function")
    expect(typeof client.users.userId).toBe("function") // fallback capture
    expect(typeof client.createUser).toBe("function")
    expect(typeof client.ping).toBe("function")
  })
})

// ============================================================================
// 2. Real round-trips against createGraphQLServer
// ============================================================================

describe("createGraphQLClient — round-trip against createGraphQLServer", () => {
  it("nested query field with declared args", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const result = await client.users.get({ id: "42" })
    expect(result).toEqual({ id: "42", name: "Alice" })
  })

  it("two-level-deep nested query field with no args", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const result = await client.users.admin.settings()
    expect(result).toEqual({ theme: "dark" })
  })

  it("flat top-level mutation field", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const result = await client.createUser({ name: "Bob" })
    expect(result).toEqual({ id: "1", name: "Bob" })
  })

  it("root-level scalar query leaf (no declared output type — degrades to JSON, no selection set)", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const result = await client.ping()
    expect(result).toBe("pong")
  })

  it("fallback slug capture reaches the right handler through a nested query field", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const sub = client.users.userId("7")
    const result = await sub.profile()
    expect(result).toEqual({ id: "7", bio: "hello" })
  })

  it("a different captured slug value reaches the same handler with a different input", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const result = await client.users.userId("99").profile()
    expect(result).toEqual({ id: "99", bio: "hello" })
  })

  it("fallback slug capture reaches a flat mutation field, declared arg winning over the captured placeholder", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })
    const client = createGraphQLClient(tree, serverTransport(server), { types: typesMap, namedTypes })
    const result = await client.users.userId("7").rename({ name: "Bobby" })
    expect(result).toEqual({ id: "7", name: "Bobby" })
  })
})

// ============================================================================
// 3. Document construction — mock transport
// ============================================================================

describe("createGraphQLClient — document construction", () => {
  it("constructs a flat mutation document with a variable declaration + field arg, and passes variables through", async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = []
    const transport: GraphQLTransport = async (query, variables) => {
      calls.push({ query, ...(variables !== undefined ? { variables } : {}) })
      return { data: { createUser: { id: "1", name: "Bob" } } }
    }
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })
    const result = await client.createUser({ name: "Bob" })

    expect(result).toEqual({ id: "1", name: "Bob" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.query).toContain("mutation")
    expect(calls[0]!.query).toContain("$name: String!")
    expect(calls[0]!.query).toContain("createUser(name: $name)")
    expect(calls[0]!.variables).toEqual({ name: "Bob" })
  })

  it("constructs a nested query document wrapping the leaf field in its namespace path", async () => {
    let capturedQuery = ""
    const transport: GraphQLTransport = async (query) => {
      capturedQuery = query
      return { data: { users: { get: { id: "42", name: "Alice" } } } }
    }
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })
    await client.users.get({ id: "42" })

    expect(capturedQuery).toContain("query")
    expect(capturedQuery).toContain("users {")
    expect(capturedQuery).toContain("get(id: $id)")
  })

  it("expands a ref-kind output TypeRef into its scalar fields via namedTypes", async () => {
    let capturedQuery = ""
    const transport: GraphQLTransport = async (query) => {
      capturedQuery = query
      return { data: { createUser: { id: "1", name: "Bob" } } }
    }
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })
    await client.createUser({ name: "Bob" })

    expect(capturedQuery).toContain("{ id name }")
  })

  it("an unresolvable ref (no matching namedTypes entry) degrades to __typename", async () => {
    let capturedQuery = ""
    const transport: GraphQLTransport = async (query) => {
      capturedQuery = query
      return { data: { createUser: { id: "1" } } }
    }
    // Same types map, but no namedTypes supplied — "User" ref can't be expanded.
    const client = createGraphQLClient(tree, transport, { types: typesMap })
    await client.createUser({ name: "Bob" })

    expect(capturedQuery).toContain("{ __typename }")
  })

  it("no declared output type emits no selection set", async () => {
    let capturedQuery = ""
    const transport: GraphQLTransport = async (query) => {
      capturedQuery = query
      return { data: { ping: "pong" } }
    }
    const client = createGraphQLClient(tree, transport)
    await client.ping()

    expect(capturedQuery).not.toMatch(/ping\s*\{/)
  })

  it("fallback contributes an ID! variable and captures the slug value into the variable bag", async () => {
    let capturedQuery = ""
    let capturedVars: Record<string, unknown> | undefined
    const transport: GraphQLTransport = async (query, variables) => {
      capturedQuery = query
      capturedVars = variables
      return { data: { users: { userId: { profile: { id: "7", bio: "hi" } } } } }
    }
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })
    const sub = client.users.userId("7")
    const result = await sub.profile()

    expect(capturedQuery).toContain("$userId: ID!")
    expect(capturedVars).toEqual({ userId: "7" })
    expect(result).toEqual({ id: "7", bio: "hi" })
  })

  it("caller-supplied input overrides a captured slug value on name collision", async () => {
    let capturedVars: Record<string, unknown> | undefined
    const transport: GraphQLTransport = async (_query, variables) => {
      capturedVars = variables
      return { data: { users: { userId: { rename: { id: "override", name: "New" } } } } }
    }
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })
    const sub = client.users.userId("7")
    await sub.rename({ userId: "override", name: "New" })

    expect(capturedVars).toEqual({ userId: "override", name: "New" })
  })
})

// ============================================================================
// 4. Error propagation from the transport
// ============================================================================

describe("createGraphQLClient — error handling", () => {
  it("throws GraphQLClientError when the transport returns a non-empty errors array", async () => {
    const transport: GraphQLTransport = async () => ({ errors: [{ message: "boom" }] })
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })

    await expect(client.createUser({ name: "Bob" })).rejects.toBeInstanceOf(GraphQLClientError)
    await expect(client.createUser({ name: "Bob" })).rejects.toThrow("boom")
  })

  it("an errors array carries through as the error's .errors property", async () => {
    const transport: GraphQLTransport = async () => ({
      errors: [{ message: "not found", extensions: { code: "NOT_FOUND" } }],
    })
    const client = createGraphQLClient(tree, transport, { types: typesMap, namedTypes })

    try {
      await client.createUser({ name: "Bob" })
      throw new Error("expected rejection")
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLClientError)
      expect((e as GraphQLClientError).errors).toEqual([{ message: "not found", extensions: { code: "NOT_FOUND" } }])
    }
  })

  it("an empty errors array does not throw", async () => {
    const transport: GraphQLTransport = async () => ({ data: { ping: "pong" }, errors: [] })
    const client = createGraphQLClient(tree, transport)
    const result = await client.ping()
    expect(result).toBe("pong")
  })
})
