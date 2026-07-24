// packages/json-rpc-api-projector/src/client.test.ts — typed client tests

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { createJsonRpcHttpHandler } from "./server.ts"
import { createJsonRpcClient, createJsonRpcHttpCall, createJsonRpcHttpClient, JsonRpcClientError } from "./client.ts"
import type { JsonRpcCall } from "./client.ts"

describe("createJsonRpcClient: proxy shape mirrors the tree", () => {
  it("a leaf becomes an async callable dispatching through the supplied call", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const call: JsonRpcCall = async (method, params) => {
      calls.push({ method, params })
      return 42
    }
    const tree = api_({ users: api_({ list: op((_: unknown) => []) }) })
    const client = createJsonRpcClient(tree, call)

    const result = await client.users.list({ page: 1 })
    expect(result).toBe(42)
    expect(calls).toEqual([{ method: "users.list", params: { page: 1 } }])
  })

  it("a leaf call with no input still dispatches (empty params)", async () => {
    const calls: string[] = []
    const call: JsonRpcCall = async (method) => {
      calls.push(method)
      return null
    }
    const tree = api_({ ping: op((_: unknown) => "pong") })
    const client = createJsonRpcClient(tree, call)
    await client.ping()
    expect(calls).toEqual(["ping"])
  })

  it("a fallback becomes a function capturing the slug into every call under it", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const call: JsonRpcCall = async (method, params) => {
      calls.push({ method, params })
      return null
    }
    const tree = api_({
      books: api_(
        {},
        {
          fallback: {
            name: "bookId",
            subtree: api_({ get: op((_: unknown) => ({})), remove: op((_: unknown) => null) }),
          },
        },
      ),
    })
    const client = createJsonRpcClient(tree, call)

    await client.books.bookId("b-1").get()
    await client.books.bookId("b-2").remove({ force: true })

    expect(calls).toEqual([
      { method: "books.bookId.get", params: { bookId: "b-1" } },
      { method: "books.bookId.remove", params: { bookId: "b-2", force: true } },
    ])
  })

  it("meta.jsonrpc.name/segment overrides are respected", async () => {
    const calls: string[] = []
    const call: JsonRpcCall = async (method) => {
      calls.push(method)
      return null
    }
    const tree = api_({
      usersNode: api_(
        { list: op((_: unknown) => [], { jsonrpc: { name: "listUsers" } }) },
        { meta: { jsonrpc: { segment: "users" } } },
      ),
    })
    const client = createJsonRpcClient(tree, call)
    // Navigation key is the tree key ("usersNode"), not the segment override.
    await client.usersNode.list()
    expect(calls).toEqual(["listUsers"])
  })
})

describe("createJsonRpcHttpClient: end-to-end against createJsonRpcHttpHandler", () => {
  it("round-trips a successful call", async () => {
    const tree = api_({ add: op((input: { a: number; b: number }) => input.a + input.b) })
    const httpHandler = createJsonRpcHttpHandler(tree)
    const client = createJsonRpcHttpClient(tree, "http://localhost/rpc", {
      fetch: (_url, init) => httpHandler(new Request("http://localhost/rpc", init)),
    })

    const result = await client.add({ a: 2, b: 3 })
    expect(result).toBe(5)
  })

  it("throws JsonRpcClientError on an error Response", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong") })
    const httpHandler = createJsonRpcHttpHandler(tree)
    const call = createJsonRpcHttpCall("http://localhost/rpc", {
      fetch: (_url, init) => httpHandler(new Request("http://localhost/rpc", init)),
    })

    await expect(call("notAMethod", {})).rejects.toThrow(JsonRpcClientError)
  })
})
