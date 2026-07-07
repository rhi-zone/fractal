// packages/mcp/src/project.test.ts — MCP tool projection tests

import { describe, expect, it } from "bun:test"
import { node, op, param } from "@rhi-zone/fractal-core/node"
import { buildRoutes } from "@rhi-zone/fractal-http/project"
import { toTools } from "./project.ts"

// ============================================================================
// 1. Cross-surface payoff: one meta.tags → MCP annotations + HTTP verb
//
// This is the core thesis test: the SAME meta.tags that drives HTTP verb
// selection also drives MCP annotation hints. One authoring, two surfaces.
// ============================================================================

describe("cross-surface: same meta.tags → MCP annotation hints + HTTP verb", () => {
  it("readOnly:true → readOnlyHint:true (MCP) + GET (HTTP)", () => {
    // Single authored node — meta.tags authored ONCE
    const n = node({
      ops: {
        get: op((_: unknown) => "result", { tags: { readOnly: true } }),
      },
    })

    // MCP surface: readOnlyHint derives from meta.tags.readOnly
    const tools = toTools(n)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true)

    // HTTP surface: same meta.tags → GET (safe method)
    const routes = buildRoutes(n)
    expect(routes).toHaveLength(1)
    expect(routes[0]!.verb).toBe("GET")
  })

  it("destructive:true → destructiveHint:true (MCP) + non-GET verb (HTTP)", () => {
    const n = node({
      ops: {
        delete: op((_: unknown) => null, { tags: { destructive: true } }),
      },
    })

    // MCP surface: destructiveHint derives from meta.tags.destructive
    const tools = toTools(n)
    expect(tools[0]!.annotations?.destructiveHint).toBe(true)

    // HTTP surface: same meta.tags → POST (destructive without idempotent = conservative)
    const routes = buildRoutes(n)
    expect(routes[0]!.verb).toBe("POST") // not GET — a mutating verb
    expect(routes[0]!.verb).not.toBe("GET")
  })

  it("idempotent:true + destructive:true → idempotentHint:true + destructiveHint:true (MCP) + DELETE (HTTP)", () => {
    const n = node({
      ops: {
        remove: op((_: unknown) => null, {
          tags: { idempotent: true, destructive: true },
        }),
      },
    })

    const tools = toTools(n)
    expect(tools[0]!.annotations?.idempotentHint).toBe(true)
    expect(tools[0]!.annotations?.destructiveHint).toBe(true)

    const routes = buildRoutes(n)
    expect(routes[0]!.verb).toBe("DELETE")
  })
})

// ============================================================================
// 2. Node-level tag inheritance: parent tag flows into child ops
// ============================================================================

describe("node-level tag inheritance → MCP annotations", () => {
  it("readOnly:true on a node makes all its ops emit readOnlyHint:true", () => {
    const api = node({
      children: {
        catalog: node({
          meta: { tags: { readOnly: true } },
          ops: {
            list: op((_: unknown) => []), // no own tags — inherits from parent
            search: op((_: unknown) => []), // no own tags — inherits from parent
          },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools).toHaveLength(2)
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true)
    }
  })

  it("op-level tag overrides node-level tag (closest-wins)", () => {
    const api = node({
      children: {
        items: node({
          meta: { tags: { readOnly: true } },
          ops: {
            // op explicitly negates readOnly and asserts idempotent+destructive
            delete: op((_: unknown) => ({}), {
              tags: { readOnly: false, idempotent: true, destructive: true },
            }),
          },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools[0]!.annotations?.readOnlyHint).toBe(false)
    expect(tools[0]!.annotations?.destructiveHint).toBe(true)
    expect(tools[0]!.annotations?.idempotentHint).toBe(true)

    // HTTP surface consistent: same closest-wins logic → DELETE
    const routes = buildRoutes(api)
    expect(routes[0]!.verb).toBe("DELETE")
  })
})

// ============================================================================
// 3. Unknown tags omit hints (three-valued semantics)
// ============================================================================

describe("unknown tags omit hints", () => {
  it("no meta.tags → no annotations object at all", () => {
    const n = node({ ops: { create: op((_: unknown) => ({})) } })
    const tools = toTools(n)
    expect(tools[0]!.annotations).toBeUndefined()
  })

  it("empty meta.tags → no annotations object", () => {
    const n = node({ ops: { create: op((_: unknown) => ({}), { tags: {} }) } })
    const tools = toTools(n)
    expect(tools[0]!.annotations).toBeUndefined()
  })

  it("tags present for some hints only — absent hints are omitted, not false", () => {
    const n = node({
      ops: {
        fetch: op((_: unknown) => ({}), {
          tags: { readOnly: true, openWorld: true },
        }),
      },
    })
    const tools = toTools(n)
    const ann = tools[0]!.annotations!
    expect(ann.readOnlyHint).toBe(true)
    expect(ann.openWorldHint).toBe(true)
    // destructive and idempotent are unknown → must NOT appear
    expect("destructiveHint" in ann).toBe(false)
    // idempotent is lifted to true by readOnly ⇒ idempotent implication
    // (lattice rule: readOnly=true → idempotent=true when idempotent was undefined)
    expect(ann.idempotentHint).toBe(true)
  })

  it("idempotent explicitly unknown (undefined) with no readOnly → hint omitted", () => {
    const n = node({
      ops: { update: op((_: unknown) => ({}), { tags: { destructive: true } }) },
    })
    const tools = toTools(n)
    const ann = tools[0]!.annotations!
    expect(ann.destructiveHint).toBe(true)
    // idempotent was never set and readOnly is not true → idempotent remains unknown → omitted
    expect("idempotentHint" in ann).toBe(false)
  })
})

// ============================================================================
// 4. Name namespacing by tree position
// ============================================================================

describe("name namespacing from tree position", () => {
  it("root-level op name is just the op key", () => {
    const n = node({ ops: { create: op((_: unknown) => ({})) } })
    const tools = toTools(n)
    expect(tools[0]!.name).toBe("create")
  })

  it("nested op name is underscore-joined: parent_key", () => {
    const api = node({
      children: {
        users: node({
          ops: { list: op((_: unknown) => []) },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("users_list")
  })

  it("deeply nested op name: grandparent_parent_op", () => {
    const api = node({
      children: {
        invoices: node({
          children: {
            items: node({
              ops: { get: op((_: unknown) => ({})) },
            }),
          },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("invoices_items_get")
  })

  it("param node contributes its name to the tool name prefix", () => {
    const api = node({
      children: {
        users: node({
          children: {
            userId: param(
              "userId",
              node({ ops: { profile: op((_: unknown) => ({})) } }),
            ),
          },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("users_userId_profile")
  })

  it("meta.mcp.segment on a child node overrides its segment contribution", () => {
    const api = node({
      children: {
        usersNode: node({
          meta: { mcp: { segment: "users" } },
          ops: { list: op((_: unknown) => []) },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("users_list")
  })
})

// ============================================================================
// 5. meta.mcp per-projection overrides
// ============================================================================

describe("meta.mcp per-projection overrides", () => {
  it("meta.mcp.name overrides the inferred name", () => {
    const n = node({
      ops: {
        list: op((_: unknown) => [], { mcp: { name: "catalog_search" } }),
      },
    })
    const tools = toTools(n)
    expect(tools[0]!.name).toBe("catalog_search")
  })

  it("meta.mcp.description overrides description", () => {
    const n = node({
      ops: {
        list: op((_: unknown) => [], {
          description: "agnostic description",
          mcp: { description: "MCP-specific description for model planning" },
        }),
      },
    })
    const tools = toTools(n)
    expect(tools[0]!.description).toBe("MCP-specific description for model planning")
  })

  it("meta.description is used when meta.mcp.description is absent", () => {
    const n = node({
      ops: {
        list: op((_: unknown) => [], { description: "lists all items" }),
      },
    })
    const tools = toTools(n)
    expect(tools[0]!.description).toBe("lists all items")
  })

  it("meta.mcp.title emits annotations.title", () => {
    const n = node({
      ops: {
        get: op((_: unknown) => ({}), { mcp: { title: "Get Item" } }),
      },
    })
    const tools = toTools(n)
    expect(tools[0]!.annotations?.title).toBe("Get Item")
  })

  it("meta.mcp.annotations overrides individual hint keys", () => {
    const n = node({
      ops: {
        // tag says readOnly, but MCP projection overrides readOnlyHint to false
        get: op((_: unknown) => ({}), {
          tags: { readOnly: true },
          mcp: { annotations: { readOnlyHint: false } },
        }),
      },
    })
    const tools = toTools(n)
    expect(tools[0]!.annotations?.readOnlyHint).toBe(false)
  })
})

// ============================================================================
// 6. Param-node ops produce a tool (structural coverage)
// ============================================================================

describe("param-node ops produce a tool", () => {
  it("produces a tool for an op inside a param node", () => {
    const api = node({
      children: {
        invoices: node({
          children: {
            invoiceId: param(
              "invoiceId",
              node({
                ops: {
                  checkout: op((_: { invoiceId: string }) => ({ url: "…" }), {
                    tags: { idempotent: true },
                  }),
                },
              }),
            ),
          },
        }),
      },
    })
    const tools = toTools(api)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe("invoices_invoiceId_checkout")
    expect(tools[0]!.annotations?.idempotentHint).toBe(true)
    expect(tools[0]!.inputSchema).toEqual({ type: "object" })
  })
})

// ============================================================================
// 7. inputSchema placeholder is always present
// ============================================================================

describe("inputSchema placeholder", () => {
  it("every tool has inputSchema: { type: 'object' }", () => {
    const api = node({
      ops: {
        a: op((_: unknown) => ({})),
        b: op((_: unknown) => ({}), { tags: { readOnly: true } }),
      },
    })
    const tools = toTools(api)
    for (const t of tools) {
      expect(t.inputSchema).toEqual({ type: "object" })
    }
  })
})
