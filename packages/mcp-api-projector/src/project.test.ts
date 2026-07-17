// packages/mcp-api-projector/src/project.test.ts — MCP tool projection tests

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { verbFromTags } from "@rhi-zone/fractal-http-api-projector/project"
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
    const leaf = op((_: unknown) => "result", { tags: { readOnly: true } })
    const n = api_({ get: leaf })

    // MCP surface: readOnlyHint derives from meta.tags.readOnly
    const tools = toTools(n)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true)

    // HTTP surface: same meta.tags → GET (safe method)
    expect(verbFromTags(leaf.meta)).toBe("GET")
  })

  it("destructive:true → destructiveHint:true (MCP) + non-GET verb (HTTP)", () => {
    const leaf = op((_: unknown) => null, { tags: { destructive: true } })
    const n = api_({ delete: leaf })

    // MCP surface: destructiveHint derives from meta.tags.destructive
    const tools = toTools(n)
    expect(tools[0]!.annotations?.destructiveHint).toBe(true)

    // HTTP surface: same meta.tags → POST (destructive without idempotent = conservative)
    expect(verbFromTags(leaf.meta)).toBe("POST") // not GET — a mutating verb
    expect(verbFromTags(leaf.meta)).not.toBe("GET")
  })

  it("idempotent:true + destructive:true → idempotentHint:true + destructiveHint:true (MCP) + DELETE (HTTP)", () => {
    const leaf = op((_: unknown) => null, {
      tags: { idempotent: true, destructive: true },
    })
    const n = api_({ remove: leaf })

    const tools = toTools(n)
    expect(tools[0]!.annotations?.idempotentHint).toBe(true)
    expect(tools[0]!.annotations?.destructiveHint).toBe(true)

    expect(verbFromTags(leaf.meta)).toBe("DELETE")
  })
})

// ============================================================================
// 2. Tags are read directly from the leaf's own meta — no ancestor inheritance
// ============================================================================

describe("leaf tags → MCP annotations (no ancestor inheritance)", () => {
  it("a node-level tag does NOT flow to leaf children with no own tags", () => {
    const api = api_({
        catalog: api_({
            list: op((_: unknown) => []), // no own tags — does NOT inherit
            search: op((_: unknown) => []), // no own tags — does NOT inherit
          }, { meta: { tags: { readOnly: true } } }),
      })
    const tools = toTools(api)
    expect(tools).toHaveLength(2)
    for (const t of tools) {
      expect(t.annotations).toBeUndefined()
    }
  })

  it("a leaf's own tags drive its annotations regardless of ancestor meta", () => {
    const leaf = op((_: unknown) => ({}), {
      tags: { readOnly: false, idempotent: true, destructive: true },
    })
    const api = api_({
        items: api_({ delete: leaf }, { meta: { tags: { readOnly: true } } }),
      })
    const tools = toTools(api)
    expect(tools[0]!.annotations?.readOnlyHint).toBe(false)
    expect(tools[0]!.annotations?.destructiveHint).toBe(true)
    expect(tools[0]!.annotations?.idempotentHint).toBe(true)

    // HTTP surface consistent: same leaf-only read → DELETE
    expect(verbFromTags(leaf.meta)).toBe("DELETE")
  })
})

// ============================================================================
// 3. Unknown tags omit hints (three-valued semantics)
// ============================================================================

describe("unknown tags omit hints", () => {
  it("no meta.tags → no annotations object at all", () => {
    const n = api_({ create: op((_: unknown) => ({})) })
    const tools = toTools(n)
    expect(tools[0]!.annotations).toBeUndefined()
  })

  it("empty meta.tags → no annotations object", () => {
    const n = api_({ create: op((_: unknown) => ({}), { tags: {} }) })
    const tools = toTools(n)
    expect(tools[0]!.annotations).toBeUndefined()
  })

  it("tags present for some hints only — absent hints are omitted, not false", () => {
    const n = api_({
        fetch: op((_: unknown) => ({}), {
          tags: { readOnly: true, openWorld: true },
        }),
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
    const n = api_({ update: op((_: unknown) => ({}), { tags: { destructive: true } }) })
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
  it("root-level leaf name is just the leaf key", () => {
    const n = api_({ create: op((_: unknown) => ({})) })
    const tools = toTools(n)
    expect(tools[0]!.name).toBe("create")
  })

  it("nested leaf name is underscore-joined: parent_key", () => {
    const api = api_({
        users: api_({ list: op((_: unknown) => []) }),
      })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("users_list")
  })

  it("deeply nested leaf name: grandparent_parent_leaf", () => {
    const api = api_({
        invoices: api_({
            items: api_({ get: op((_: unknown) => ({})) }),
          }),
      })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("invoices_items_get")
  })

  it("fallback contributes its name to the tool name prefix", () => {
    const api = api_({
        users: api_({}, { fallback: {
            name: "userId",
            subtree: api_({ profile: op((_: unknown) => ({})) }),
          } }),
      })
    const tools = toTools(api)
    expect(tools[0]!.name).toBe("users_userId_profile")
  })

  it("meta.mcp.segment on a child node overrides its segment contribution", () => {
    const api = api_({
        usersNode: api_({ list: op((_: unknown) => []) }, { meta: { mcp: { segment: "users" } } }),
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
    const n = api_({
        list: op((_: unknown) => [], { mcp: { name: "catalog_search" } }),
      })
    const tools = toTools(n)
    expect(tools[0]!.name).toBe("catalog_search")
  })

  it("meta.mcp.description overrides description", () => {
    const n = api_({
        list: op((_: unknown) => [], {
          description: "agnostic description",
          mcp: { description: "MCP-specific description for model planning" },
        }),
      })
    const tools = toTools(n)
    expect(tools[0]!.description).toBe("MCP-specific description for model planning")
  })

  it("meta.description is used when meta.mcp.description is absent", () => {
    const n = api_({
        list: op((_: unknown) => [], { description: "lists all items" }),
      })
    const tools = toTools(n)
    expect(tools[0]!.description).toBe("lists all items")
  })

  it("meta.mcp.title emits annotations.title", () => {
    const n = api_({
        get: op((_: unknown) => ({}), { mcp: { title: "Get Item" } }),
      })
    const tools = toTools(n)
    expect(tools[0]!.annotations?.title).toBe("Get Item")
  })

  it("meta.mcp.annotations overrides individual hint keys", () => {
    const n = api_({
        // tag says readOnly, but MCP projection overrides readOnlyHint to false
        get: op((_: unknown) => ({}), {
          tags: { readOnly: true },
          mcp: { annotations: { readOnlyHint: false } },
        }),
      })
    const tools = toTools(n)
    expect(tools[0]!.annotations?.readOnlyHint).toBe(false)
  })
})

// ============================================================================
// 6. Fallback-subtree leaves produce a tool (structural coverage)
// ============================================================================

describe("fallback-subtree leaves produce a tool", () => {
  it("produces a tool for a leaf inside a fallback subtree", () => {
    const api = api_({
        invoices: api_({}, { fallback: {
            name: "invoiceId",
            subtree: api_({
                checkout: op((_: { invoiceId: string }) => ({ url: "…" }), {
                  tags: { idempotent: true },
                }),
              }),
          } }),
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
    const api = api_({
        a: op((_: unknown) => ({})),
        b: op((_: unknown) => ({}), { tags: { readOnly: true } }),
      })
    const tools = toTools(api)
    for (const t of tools) {
      expect(t.inputSchema).toEqual({ type: "object" })
    }
  })
})
