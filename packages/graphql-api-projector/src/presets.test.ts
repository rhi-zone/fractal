// packages/graphql-api-projector/src/presets.test.ts — createHttpGraphQLServer tests
//
// Drives the returned fetch handler directly with real `Request` objects —
// POST /graphql with query/variables, GET query-string queries, the SDL
// landing page, CORS headers, and error responses.

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import type { FieldTypeMap } from "./project.ts"
import { createHttpGraphQLServer } from "./presets.ts"

const tree = api_({
  users: api_({
    get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), { tags: { readOnly: true } }),
  }),
  createUser: op((input: { name: string }) => ({ id: "1", name: input.name })),
})

const typesMap: FieldTypeMap = {
  users_get: { input: t(types.object({ id: t(types.string) })), output: t(types.ref("User")) },
  createUser: { input: t(types.object({ name: t(types.string) })), output: t(types.ref("User")) },
}
const namedTypes = {
  User: t(types.object({ id: t(types.string), name: t(types.string) }), { typeName: "User" }),
}

// ============================================================================
// 1. POST /graphql
// ============================================================================

describe("createHttpGraphQLServer — POST /graphql", () => {
  it("executes a query from a JSON body and returns {data}", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ users { get(id: "42") { id name } } }` }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toEqual({ users: { get: { id: "42", name: "Alice" } } })
  })

  it("executes a mutation with variables", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation($name: String!) { createUser(name: $name) { id name } }`,
          variables: { name: "Bob" },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toEqual({ createUser: { id: "1", name: "Bob" } })
  })

  it("a GraphQL-level error (unknown field) still responds 200 with an errors array", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ doesNotExist }` }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { errors: unknown[] }
    expect(body.errors.length).toBeGreaterThan(0)
  })

  it("a missing query field responds 400", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
  })

  it("an invalid JSON body responds 400", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    )
    expect(res.status).toBe(400)
  })
})

// ============================================================================
// 2. GET /graphql — query-string queries + SDL landing page
// ============================================================================

describe("createHttpGraphQLServer — GET /graphql", () => {
  it("executes a query from ?query=", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const url = `http://localhost/graphql?query=${encodeURIComponent(`{ users { get(id: "7") { id } } }`)}`
    const res = await handler(new Request(url))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toEqual({ users: { get: { id: "7" } } })
  })

  it("executes a query with ?variables= as JSON", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const query = `query($id: String!) { users { get(id: $id) { id } } }`
    const url = `http://localhost/graphql?query=${encodeURIComponent(query)}&variables=${encodeURIComponent(JSON.stringify({ id: "9" }))}`
    const res = await handler(new Request(url))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toEqual({ users: { get: { id: "9" } } })
  })

  it("malformed ?variables= JSON responds 400", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const url = `http://localhost/graphql?query=${encodeURIComponent("{ users { get(id: \"1\") { id } } }")}&variables=not-json`
    const res = await handler(new Request(url))
    expect(res.status).toBe(400)
  })

  it("a bare GET with no ?query= serves the SDL text (playground default on)", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(new Request("http://localhost/graphql"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("type Query")
  })

  it("playground: false — a bare GET with no ?query= responds 400 instead", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes, playground: false })
    const res = await handler(new Request("http://localhost/graphql"))
    expect(res.status).toBe(400)
  })
})

// ============================================================================
// 3. Path / method handling
// ============================================================================

describe("createHttpGraphQLServer — path and method handling", () => {
  it("a request to a different path is a 404", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(new Request("http://localhost/not-graphql"))
    expect(res.status).toBe(404)
  })

  it("respects a custom `path` option", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes, path: "/api/gql" })
    const res = await handler(new Request("http://localhost/api/gql"))
    expect(res.status).toBe(200)
    const notMounted = await handler(new Request("http://localhost/graphql"))
    expect(notMounted.status).toBe(404)
  })

  it("an unsupported method on the mount path is a 405", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(new Request("http://localhost/graphql", { method: "DELETE" }))
    expect(res.status).toBe(405)
  })
})

// ============================================================================
// 4. CORS
// ============================================================================

describe("createHttpGraphQLServer — CORS", () => {
  it("default (no cors option): no CORS headers", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ users { get(id: "1") { id } } }` }),
      }),
    )
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("cors: true adds a permissive Access-Control-Allow-Origin header", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes, cors: true })
    const res = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ users { get(id: "1") { id } } }` }),
      }),
    )
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("an OPTIONS preflight with cors: true returns 204 + CORS headers", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes, cors: true })
    const res = await handler(new Request("http://localhost/graphql", { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
  })

  it("an OPTIONS request with no cors option returns a plain 204 (no CORS headers)", async () => {
    const handler = createHttpGraphQLServer(tree, { types: typesMap, namedTypes })
    const res = await handler(new Request("http://localhost/graphql", { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("cors with an explicit origin only reflects an allowed origin", async () => {
    const handler = createHttpGraphQLServer(tree, {
      types: typesMap,
      namedTypes,
      cors: { origin: "https://app.example.com" },
    })
    const allowed = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
        body: JSON.stringify({ query: `{ users { get(id: "1") { id } } }` }),
      }),
    )
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com")

    const disallowed = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        body: JSON.stringify({ query: `{ users { get(id: "1") { id } } }` }),
      }),
    )
    expect(disallowed.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })
})
