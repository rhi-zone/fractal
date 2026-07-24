// packages/json-rpc-api-projector/src/project.test.ts — JSON-RPC method projection tests

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { projectMethods, toMethods } from "./project.ts"

describe("naming: dot-separated method names from tree position", () => {
  it("root leaf -> bare name", () => {
    const tree = api_({ ping: op((_: unknown) => "pong") })
    const methods = toMethods(tree)
    expect(methods.map((m) => m.name)).toEqual(["ping"])
  })

  it("nested children -> dot-joined name", () => {
    const tree = api_({
      users: api_({ list: op((_: unknown) => []), get: op((_: unknown) => ({})) }),
      books: api_({ get: op((_: unknown) => ({})) }),
    })
    const methods = toMethods(tree)
    expect(methods.map((m) => m.name).sort()).toEqual(["books.get", "users.get", "users.list"])
  })

  it("fallback contributes its own name as a literal dot-segment", () => {
    const tree = api_({
      books: api_(
        {},
        {
          fallback: {
            name: "bookId",
            subtree: api_({ get: op((_: unknown) => ({})) }),
          },
        },
      ),
    })
    const methods = toMethods(tree)
    expect(methods[0]!.name).toBe("books.bookId.get")
  })

  it("meta.jsonrpc.name overrides the full derived name", () => {
    const tree = api_({
      users: api_({ list: op((_: unknown) => [], { jsonrpc: { name: "listUsers" } }) }),
    })
    const methods = toMethods(tree)
    expect(methods[0]!.name).toBe("listUsers")
  })

  it("meta.jsonrpc.segment overrides a branch node's own prefix contribution", () => {
    const tree = api_({
      usersNode: api_({ list: op((_: unknown) => []) }, { meta: { jsonrpc: { segment: "users" } } }),
    })
    const methods = toMethods(tree)
    expect(methods[0]!.name).toBe("users.list")
  })
})

describe("tags -> flat method metadata (no ancestor inheritance)", () => {
  it("readOnly/destructive/idempotent surface as top-level three-valued fields", () => {
    const tree = api_({
      list: op((_: unknown) => [], { tags: { readOnly: true } }),
      remove: op((_: unknown) => null, { tags: { destructive: true, idempotent: true } }),
    })
    const methods = toMethods(tree)
    const list = methods.find((m) => m.name === "list")!
    const remove = methods.find((m) => m.name === "remove")!
    expect(list.readOnly).toBe(true)
    expect(list.destructive).toBeUndefined()
    expect(remove.destructive).toBe(true)
    expect(remove.idempotent).toBe(true)
  })

  it("a node-level tag does not flow to leaf children with no own tags", () => {
    const tree = api_({
      catalog: api_({ list: op((_: unknown) => []) }, { meta: { tags: { readOnly: true } } }),
    })
    const methods = toMethods(tree)
    expect(methods[0]!.readOnly).toBeUndefined()
  })

  it("meta.tags.deprecated -> deprecated: true", () => {
    const tree = api_({ old: op((_: unknown) => null, { tags: { deprecated: true } }) })
    expect(toMethods(tree)[0]!.deprecated).toBe(true)
  })

  it("no tags -> all metadata fields omitted", () => {
    const tree = api_({ plain: op((_: unknown) => null) })
    const method = toMethods(tree)[0]!
    expect(method.readOnly).toBeUndefined()
    expect(method.destructive).toBeUndefined()
    expect(method.idempotent).toBeUndefined()
    expect(method.deprecated).toBeUndefined()
    expect(method.streaming).toBeUndefined()
  })
})

describe("schemas: paramsSchema/resultSchema/description from a derived SchemaMap", () => {
  it("no schema entry -> paramsSchema degrades to the JSON Schema minimum, resultSchema omitted", () => {
    const tree = api_({ ping: op((_: unknown) => "pong") })
    const method = toMethods(tree)[0]!
    expect(method.paramsSchema).toEqual({ type: "object" })
    expect(method.resultSchema).toBeUndefined()
  })

  it("a matching schema entry supplies paramsSchema/resultSchema/description", () => {
    const tree = api_({ getBalance: op((_: unknown) => 0) })
    const methods = toMethods(tree, {
      schemas: {
        getBalance: {
          paramsSchema: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"] },
          resultSchema: { type: "number" },
          description: "Fetches an account's balance",
        },
      },
    })
    expect(methods[0]!.paramsSchema).toEqual({
      type: "object",
      properties: { accountId: { type: "string" } },
      required: ["accountId"],
    })
    expect(methods[0]!.resultSchema).toEqual({ type: "number" })
    expect(methods[0]!.description).toBe("Fetches an account's balance")
  })

  it("description falls back to meta.description, then the leaf key", () => {
    const withMetaDescription = api_({ ping: op((_: unknown) => "pong", { description: "Health check" }) })
    expect(toMethods(withMetaDescription)[0]!.description).toBe("Health check")

    const bare = api_({ ping: op((_: unknown) => "pong") })
    expect(toMethods(bare)[0]!.description).toBe("ping")
  })
})

describe("errorSchema: the standard JSON-RPC envelope, optionally narrowed", () => {
  it("default -> unconstrained data", () => {
    const tree = api_({ deposit: op((_: unknown) => null) })
    expect(toMethods(tree)[0]!.errorSchema).toEqual({
      type: "object",
      properties: { code: { type: "integer" }, message: { type: "string" }, data: {} },
      required: ["code", "message"],
    })
  })

  it("meta.jsonrpc.errorDataSchema narrows the envelope's data field", () => {
    const tree = api_({
      deposit: op((_: unknown) => null, { jsonrpc: { errorDataSchema: { type: "string" } } }),
    })
    expect(toMethods(tree)[0]!.errorSchema.properties).toMatchObject({ data: { type: "string" } })
  })
})

describe("projectMethods: dispatch table mirrors the descriptor array", () => {
  it("one handler entry per method, keyed by the same derived name", () => {
    const handler = (_: unknown) => "pong"
    const tree = api_({ ping: op(handler) })
    const { methods, handlers } = projectMethods(tree)
    expect(methods).toHaveLength(1)
    expect(handlers.size).toBe(1)
    expect(handlers.get("ping")?.handler).toBe(handler)
  })

  it("meta.jsonrpc.sourceMap is threaded onto the dispatch entry", () => {
    const tree = api_({
      whoami: op((_: unknown) => "someone", {
        jsonrpc: { sourceMap: { token: { store: "caller", key: "authToken" } } },
      }),
    })
    const { handlers } = projectMethods(tree)
    expect(handlers.get("whoami")?.sourceMap).toEqual({ token: { store: "caller", key: "authToken" } })
  })
})
