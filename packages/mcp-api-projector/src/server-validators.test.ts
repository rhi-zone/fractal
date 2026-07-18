// packages/mcp-api-projector/src/server-validators.test.ts — createMcpServer generated-validator wiring
//
// `createMcpServer`'s `opts.validators` wraps the tree via `wrapValidators`
// (@rhi-zone/fractal-api-tree/build) before `projectTools` builds its
// dispatch map — the leaf's generated `parse()` runs instead of (not
// alongside) the manual `validateAgainstSchema` check for any tool a
// generated validator covers; tools it doesn't cover keep going through
// `validateAgainstSchema` exactly as before (see server.test.ts).

import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import { createMcpServer } from "./server.ts"
import type { SchemaMap } from "./project.ts"

/** A synthetic GeneratedEntry: requires `id` to be a numeric string,
 * coercing it to a number on success. */
function idEntry(): GeneratedEntry {
  return {
    parse: (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return { kind: "err", errors: [{ kind: "type", path: [], expected: "object", actual: value }] }
      }
      const v = value as Record<string, unknown>
      if (typeof v.id !== "string" || !/^\d+$/.test(v.id)) {
        return { kind: "err", errors: [{ kind: "type", path: ["id"], expected: "numeric string", actual: v.id }] }
      }
      return { kind: "ok", value: { ...v, id: Number(v.id) } }
    },
  }
}

const tree = api({
  users: api({
    get: op((input: { id: number }) => ({ id: input.id, name: "Alice" })),
  }),
})

/** A derived schema requiring `id` to be a string — used by the "fallback
 * validation" tests below to give `validateAgainstSchema` something to
 * actually reject (without a schema, it degrades to the MCP spec minimum
 * `{ type: "object" }`, which never rejects anything — see project.ts). */
const schemas: SchemaMap = {
  users_get: { inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
}

async function connectedClient(validators?: Record<string, GeneratedEntry>) {
  const server = createMcpServer(tree, {
    name: "test-server",
    version: "1.0.0",
    schemas,
    ...(validators !== undefined ? { validators } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe("createMcpServer — generated validators (opts.validators) wired via wrapValidators", () => {
  it("routes tool-call args through the generated validator's parse() — coercion reaches the handler", async () => {
    const { client } = await connectedClient({ "users/get": idEntry() })
    const result = await client.callTool({ name: "users_get", arguments: { id: "42" } })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ id: 42, name: "Alice" })
  })

  it("a generated-validator rejection surfaces as an MCP tool error result, handler never runs", async () => {
    let handlerCalled = false
    const trackedTree = api({
      users: api({
        get: op((input: { id: number }) => {
          handlerCalled = true
          return input
        }),
      }),
    })
    const server = createMcpServer(trackedTree, {
      name: "test-server",
      version: "1.0.0",
      validators: { "users/get": idEntry() },
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: "users_get", arguments: { id: "not-a-number" } })

    expect(result.isError).toBe(true)
    expect(handlerCalled).toBe(false)
  })

  it("a tool with no matching generated-validator entry keeps using validateAgainstSchema (fallback)", async () => {
    // Validators provided, but keyed under a DIFFERENT path — "users/get"
    // isn't covered, so it falls back to the manual schema check, which
    // rejects a non-object id per the derived `{ id: string }` input schema.
    const { client } = await connectedClient({ "other/path": idEntry() })
    const result = await client.callTool({ name: "users_get", arguments: { id: 42 } })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toContain("Invalid input")
  })

  it("without opts.validators at all, behavior is unchanged from the pre-existing validateAgainstSchema path", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: "users_get", arguments: { id: "42" } })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" })
  })
})
