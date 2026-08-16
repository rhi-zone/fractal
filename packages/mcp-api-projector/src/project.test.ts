// project.ts — the three projection walks, in isolation from any server.

import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { verbFromTags } from "@rhi-zone/fractal-http-api-projector/project";
import { projectPrompts, projectResources, projectTools, toTools } from "./project.ts";
// Registers `meta.mcp` on core's meta types for this suite — without it,
// `meta.mcp.segment` on a branch below would not type-check. See that file.
import "./deployment-meta.test-support.ts";

// ============================================================================
// 1. One authoring, two surfaces
//
// Each case here authors `meta.tags` once and then asserts on both what MCP
// derives from it and what HTTP does — the payoff being that neither surface
// was authored for separately.
// ============================================================================

describe("cross-surface: same meta.tags → MCP annotation hints + HTTP verb", () => {
  it("readOnly:true → readOnlyHint:true (MCP) + GET (HTTP)", () => {
    const leaf = op((_: unknown) => "result", { tags: { readOnly: true } });
    const n = api_({ get: leaf });

    const tools = toTools(n);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);

    // HTTP surface: same meta.tags → GET (safe method)
    expect(verbFromTags(leaf.meta)).toBe("GET");
  });

  it("destructive:true → destructiveHint:true (MCP) + non-GET verb (HTTP)", () => {
    const leaf = op((_: unknown) => null, { tags: { destructive: true } });
    const n = api_({ delete: leaf });

    const tools = toTools(n);
    expect(tools[0]!.annotations?.destructiveHint).toBe(true);

    // Destructive but not idempotent, so HTTP settles on POST rather than a
    // verb that promises repeatability.
    expect(verbFromTags(leaf.meta)).toBe("POST");
    expect(verbFromTags(leaf.meta)).not.toBe("GET");
  });

  it("idempotent:true + destructive:true → idempotentHint:true + destructiveHint:true (MCP) + DELETE (HTTP)", () => {
    const leaf = op((_: unknown) => null, {
      tags: { idempotent: true, destructive: true },
    });
    const n = api_({ remove: leaf });

    const tools = toTools(n);
    expect(tools[0]!.annotations?.idempotentHint).toBe(true);
    expect(tools[0]!.annotations?.destructiveHint).toBe(true);

    expect(verbFromTags(leaf.meta)).toBe("DELETE");
  });
});

// ============================================================================
// 2. A leaf reads its own tags and no ancestor's
// ============================================================================

describe("leaf tags → MCP annotations (no ancestor inheritance)", () => {
  it("a tag on a branch does not reach untagged leaves below it", () => {
    // `tags` is leaf-only under the meta role split
    // (docs/design/meta-role-split-spec.md §2), so `api_()` will not let a
    // branch carry one — a stronger guarantee than this test asserts. What is
    // tested here is the runtime behavior against a tree that carries one
    // anyway, as a hand-built or legacy-computed tree still can. Hence the
    // spread over a real `api_()` result.
    const catalog = api_({
      list: op((_: unknown) => []),
      search: op((_: unknown) => []),
    });
    const api = api_({
      catalog: { ...catalog, meta: { tags: { readOnly: true } } },
    });
    const tools = toTools(api);
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t.annotations).toBeUndefined();
    }
  });

  it("a leaf's own tags drive its annotations regardless of ancestor meta", () => {
    const leaf = op((_: unknown) => ({}), {
      tags: { readOnly: false, idempotent: true, destructive: true },
    });
    // Spread for the same reason as the previous test.
    const items = api_({ delete: leaf });
    const api = api_({
      items: { ...items, meta: { tags: { readOnly: true } } },
    });
    const tools = toTools(api);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(false);
    expect(tools[0]!.annotations?.destructiveHint).toBe(true);
    expect(tools[0]!.annotations?.idempotentHint).toBe(true);

    // HTTP reads the same leaf-only tags and agrees.
    expect(verbFromTags(leaf.meta)).toBe("DELETE");
  });
});

// ============================================================================
// 3. An unset tag emits no hint
// ============================================================================

describe("unknown tags omit hints", () => {
  it("no meta.tags → no annotations object at all", () => {
    const n = api_({ create: op((_: unknown) => ({})) });
    const tools = toTools(n);
    expect(tools[0]!.annotations).toBeUndefined();
  });

  it("empty meta.tags → no annotations object", () => {
    const n = api_({ create: op((_: unknown) => ({}), { tags: {} }) });
    const tools = toTools(n);
    expect(tools[0]!.annotations).toBeUndefined();
  });

  it("tags present for some hints only — absent hints are omitted, not false", () => {
    const n = api_({
      fetch: op((_: unknown) => ({}), {
        tags: { readOnly: true, openWorld: true },
      }),
    });
    const tools = toTools(n);
    const ann = tools[0]!.annotations!;
    expect(ann.readOnlyHint).toBe(true);
    expect(ann.openWorldHint).toBe(true);
    expect("destructiveHint" in ann).toBe(false);
    // Not authored, but not unknown either: the lattice derives it, since
    // something read-only is necessarily repeatable.
    expect(ann.idempotentHint).toBe(true);
  });

  it("idempotent explicitly unknown (undefined) with no readOnly → hint omitted", () => {
    const n = api_({ update: op((_: unknown) => ({}), { tags: { destructive: true } }) });
    const tools = toTools(n);
    const ann = tools[0]!.annotations!;
    expect(ann.destructiveHint).toBe(true);
    // Nothing authored it and no lattice rule reaches it, so it stays unknown.
    expect("idempotentHint" in ann).toBe(false);
  });
});

// ============================================================================
// 4. Name namespacing by tree position
// ============================================================================

describe("name namespacing from tree position", () => {
  it("root-level leaf name is just the leaf key", () => {
    const n = api_({ create: op((_: unknown) => ({})) });
    const tools = toTools(n);
    expect(tools[0]!.name).toBe("create");
  });

  it("nested leaf name is underscore-joined: parent_key", () => {
    const api = api_({
      users: api_({ list: op((_: unknown) => []) }),
    });
    const tools = toTools(api);
    expect(tools[0]!.name).toBe("users_list");
  });

  it("deeply nested leaf name: grandparent_parent_leaf", () => {
    const api = api_({
      invoices: api_({
        items: api_({ get: op((_: unknown) => ({})) }),
      }),
    });
    const tools = toTools(api);
    expect(tools[0]!.name).toBe("invoices_items_get");
  });

  it("fallback contributes its name to the tool name prefix", () => {
    const api = api_({
      users: api_(
        {},
        {
          fallback: {
            name: "userId",
            subtree: api_({ profile: op((_: unknown) => ({})) }),
          },
        },
      ),
    });
    const tools = toTools(api);
    expect(tools[0]!.name).toBe("users_userId_profile");
  });

  it("meta.mcp.segment on a child node overrides its segment contribution", () => {
    const api = api_({
      usersNode: api_({ list: op((_: unknown) => []) }, { meta: { mcp: { segment: "users" } } }),
    });
    const tools = toTools(api);
    expect(tools[0]!.name).toBe("users_list");
  });
});

// ============================================================================
// 4a. Same-name collision between two DIFFERENT tree positions throws,
// instead of the second-visited leaf silently overwriting the first —
// regression coverage mirroring @rhi-zone/fractal-api-tree's
// `assertUniqueName` (tree.ts), since the underscore-join here has the exact
// same unescaped delimiter.
// ============================================================================

describe("same-name collision between two tree positions throws instead of silently overwriting", () => {
  it("a leaf literally named 'users_list' collides with branch 'users' -> leaf 'list'", () => {
    const api = api_({
      users_list: op((_: unknown) => ({ flat: true })),
      users: api_({ list: op((_: unknown) => ({ nested: true })) }),
    });
    expect(() => toTools(api)).toThrow(/two tree positions produced the same tool name "users_list"/);
  });

  it("projectPrompts throws the same way for a colliding prompt name", () => {
    const api = api_({
      users_list: op((_: unknown) => ({}), { mcp: { as: "prompt" } }),
      users: api_({ list: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) }),
    });
    expect(() => projectPrompts(api)).toThrow(
      /two tree positions produced the same prompt name "users_list"/,
    );
  });

  it("a colliding meta.mcp.segment override on one branch is caught just like an authored key", () => {
    const api = api_({
      users_list: op((_: unknown) => ({})),
      usersNode: api_(
        { list: op((_: unknown) => ({})) },
        { meta: { mcp: { segment: "users" } } },
      ),
    });
    expect(() => toTools(api)).toThrow(/two tree positions produced the same tool name "users_list"/);
  });

  it("non-colliding trees are entirely unaffected — same names as before, no throw", () => {
    const api = api_({
      users: api_({ list: op((_: unknown) => []), create: op((_: unknown) => ({})) }),
    });
    const tools = toTools(api);
    expect(tools.map((t) => t.name).sort()).toEqual(["users_create", "users_list"]);
  });
});

// ============================================================================
// 5. meta.mcp per-projection overrides
// ============================================================================

describe("meta.mcp per-projection overrides", () => {
  it("meta.mcp.name overrides the inferred name", () => {
    const n = api_({
      list: op((_: unknown) => [], { mcp: { name: "catalog_search" } }),
    });
    const tools = toTools(n);
    expect(tools[0]!.name).toBe("catalog_search");
  });

  it("meta.mcp.description overrides description", () => {
    const n = api_({
      list: op((_: unknown) => [], {
        description: "agnostic description",
        mcp: { description: "MCP-specific description for model planning" },
      }),
    });
    const tools = toTools(n);
    expect(tools[0]!.description).toBe("MCP-specific description for model planning");
  });

  it("meta.description is used when meta.mcp.description is absent", () => {
    const n = api_({
      list: op((_: unknown) => [], { description: "lists all items" }),
    });
    const tools = toTools(n);
    expect(tools[0]!.description).toBe("lists all items");
  });

  it("meta.mcp.title emits annotations.title", () => {
    const n = api_({
      get: op((_: unknown) => ({}), { mcp: { title: "Get Item" } }),
    });
    const tools = toTools(n);
    expect(tools[0]!.annotations?.title).toBe("Get Item");
  });

  it("meta.mcp.annotations overrides individual hint keys", () => {
    const n = api_({
      // tag says readOnly, but MCP projection overrides readOnlyHint to false
      get: op((_: unknown) => ({}), {
        tags: { readOnly: true },
        mcp: { annotations: { readOnlyHint: false } },
      }),
    });
    const tools = toTools(n);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(false);
  });
});

// ============================================================================
// 6. Fallback-subtree leaves produce a tool (structural coverage)
// ============================================================================

describe("fallback-subtree leaves produce a tool", () => {
  it("produces a tool for a leaf inside a fallback subtree", () => {
    const api = api_({
      invoices: api_(
        {},
        {
          fallback: {
            name: "invoiceId",
            subtree: api_({
              checkout: op((_: { invoiceId: string }) => ({ url: "…" }), {
                tags: { idempotent: true },
              }),
            }),
          },
        },
      ),
    });
    const tools = toTools(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("invoices_invoiceId_checkout");
    expect(tools[0]!.annotations?.idempotentHint).toBe(true);
    expect(tools[0]!.inputSchema).toEqual({ type: "object" });
  });
});

// ============================================================================
// 6b. A `fallback.subtree` that is a bare `op()` rather than an `api({...})`.
//
// The Node model allows either, and all three walks check for it: recursing
// into a bare leaf as though it were a branch would find no children and drop
// the leaf silently. api-tree's `walkNodeType` (aa28952) handles the same case
// during extraction.
// ============================================================================

describe("fallback.subtree as a bare op() leaf (not wrapped in api())", () => {
  it("projectTools visits the leaf, keyed with no extra segment beyond the fallback's own name", () => {
    const api = api_({
      widgets: api_(
        {},
        {
          fallback: {
            name: "widgetId",
            subtree: op((input: { widgetId: string }) => ({ widgetId: input.widgetId }), {
              tags: { idempotent: true },
            }),
          },
        },
      ),
    });
    const { tools, handlers } = projectTools(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("widgets_widgetId");
    expect(tools[0]!.annotations?.idempotentHint).toBe(true);
    expect(handlers.has("widgets_widgetId")).toBe(true);
  });

  it("projectResources visits the leaf as a ResourceTemplate, no extra URI segment beyond {widgetId}", () => {
    const api = api_({
      widgets: api_(
        {},
        {
          fallback: {
            name: "widgetId",
            subtree: op((input: { widgetId: string }) => ({ widgetId: input.widgetId }), {
              mcp: { as: "resource" },
            }),
          },
        },
      ),
    });
    const { resources, resourceTemplates, templateHandlers } = projectResources(api);
    expect(resources).toHaveLength(0);
    expect(resourceTemplates).toHaveLength(1);
    expect(resourceTemplates[0]!.uriTemplate).toBe("resource://widgets/{widgetId}");
    expect(templateHandlers).toHaveLength(1);
    expect(templateHandlers[0]!.paramNames).toEqual(["widgetId"]);
  });

  it("projectPrompts visits the leaf, keyed with no extra segment beyond the fallback's own name", () => {
    const api = api_({
      docs: api_(
        {},
        {
          fallback: {
            name: "docId",
            subtree: op((_input: { docId: string }) => ({}), { mcp: { as: "prompt" } }),
          },
        },
      ),
    });
    const { prompts, handlers } = projectPrompts(api);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.name).toBe("docs_docId");
    expect(handlers.has("docs_docId")).toBe(true);
  });
});

// ============================================================================
// 7. inputSchema placeholder is always present
// ============================================================================

describe("inputSchema placeholder", () => {
  it("every tool has inputSchema: { type: 'object' }", () => {
    const api = api_({
      a: op((_: unknown) => ({})),
      b: op((_: unknown) => ({}), { tags: { readOnly: true } }),
    });
    const tools = toTools(api);
    for (const t of tools) {
      expect(t.inputSchema).toEqual({ type: "object" });
    }
  });
});

// ============================================================================
// 8. Resource projection — meta.mcp.as: "resource"
// ============================================================================

describe('meta.mcp.as: "resource" projects a resource, not a tool', () => {
  it('a leaf tagged as: "resource" is excluded from toTools', () => {
    const n = api_({ config: op((_: unknown) => ({}), { mcp: { as: "resource" } }) });
    expect(toTools(n)).toHaveLength(0);
  });

  it("the same leaf appears in projectResources' resources array", () => {
    const n = api_({ config: op((_: unknown) => ({}), { mcp: { as: "resource" } }) });
    const { resources } = projectResources(n);
    expect(resources).toHaveLength(1);
    expect(resources[0]!.name).toBe("config");
  });

  it("default behavior (no `as`) still produces a tool, not a resource", () => {
    const n = api_({ create: op((_: unknown) => ({})) });
    expect(toTools(n)).toHaveLength(1);
    const { resources, resourceTemplates } = projectResources(n);
    expect(resources).toHaveLength(0);
    expect(resourceTemplates).toHaveLength(0);
  });
});

describe("resource URI derivation from tree position", () => {
  it("root-level leaf URI is scheme + leaf key", () => {
    const n = api_({ config: op((_: unknown) => ({}), { mcp: { as: "resource" } }) });
    const { resources } = projectResources(n);
    expect(resources[0]!.uri).toBe("resource://config");
  });

  it("nested leaf URI is slash-joined: scheme + parent/leaf", () => {
    const api = api_({
      users: api_({ list: op((_: unknown) => [], { mcp: { as: "resource" } }) }),
    });
    const { resources } = projectResources(api);
    expect(resources[0]!.uri).toBe("resource://users/list");
  });

  it("a custom scheme option is used as the URI prefix", () => {
    const n = api_({ config: op((_: unknown) => ({}), { mcp: { as: "resource" } }) });
    const { resources } = projectResources(n, { scheme: "myapp://" });
    expect(resources[0]!.uri).toBe("myapp://config");
  });

  it("a colliding derived URI throws instead of silently overwriting the first resource's dispatch entry", () => {
    const api = api_({
      "users/list": op((_: unknown) => ({}), { mcp: { as: "resource" } }),
      users: api_({ list: op((_: unknown) => ({}), { mcp: { as: "resource" } }) }),
    });
    expect(() => projectResources(api)).toThrow(
      /two tree positions produced the same resource URI "resource:\/\/users\/list"/,
    );
  });

  it("non-colliding resource URIs are entirely unaffected — no throw", () => {
    const api = api_({
      users: api_({
        list: op((_: unknown) => [], { mcp: { as: "resource" } }),
        create: op((_: unknown) => ({}), { mcp: { as: "resource" } }),
      }),
    });
    const { resources } = projectResources(api);
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "resource://users/create",
      "resource://users/list",
    ]);
  });
});

describe("fallback nodes produce URI templates", () => {
  it("a leaf inside a fallback subtree becomes a ResourceTemplate with {var}", () => {
    const api = api_({
      users: api_(
        {},
        {
          fallback: {
            name: "userId",
            subtree: api_({ profile: op((_: unknown) => ({}), { mcp: { as: "resource" } }) }),
          },
        },
      ),
    });
    const { resources, resourceTemplates } = projectResources(api);
    expect(resources).toHaveLength(0);
    expect(resourceTemplates).toHaveLength(1);
    expect(resourceTemplates[0]!.uriTemplate).toBe("resource://users/{userId}/profile");
  });

  it("a non-fallback leaf at the same tree depth is a fixed resource, not a template", () => {
    const api = api_({
      users: api_({ list: op((_: unknown) => [], { mcp: { as: "resource" } }) }),
    });
    const { resources, resourceTemplates } = projectResources(api);
    expect(resources).toHaveLength(1);
    expect(resourceTemplates).toHaveLength(0);
  });
});

describe("meta.mcp.uri overrides the derived URI", () => {
  it("a fixed resource's derived URI is replaced entirely", () => {
    const n = api_({
      config: op((_: unknown) => ({}), { mcp: { as: "resource", uri: "custom://settings" } }),
    });
    const { resources } = projectResources(n);
    expect(resources[0]!.uri).toBe("custom://settings");
  });
});

describe("meta.mcp.mimeType is passed through", () => {
  it("defaults to application/json when absent", () => {
    const n = api_({ config: op((_: unknown) => ({}), { mcp: { as: "resource" } }) });
    const { resources } = projectResources(n);
    expect(resources[0]!.mimeType).toBe("application/json");
  });

  it("an explicit meta.mcp.mimeType overrides the default", () => {
    const n = api_({
      report: op((_: unknown) => ({}), { mcp: { as: "resource", mimeType: "text/csv" } }),
    });
    const { resources } = projectResources(n);
    expect(resources[0]!.mimeType).toBe("text/csv");
  });
});

describe("resource description resolution", () => {
  it("meta.mcp.description overrides meta.description and the leaf key", () => {
    const n = api_({
      config: op((_: unknown) => ({}), {
        description: "agnostic description",
        mcp: { as: "resource", description: "MCP-specific description" },
      }),
    });
    const { resources } = projectResources(n);
    expect(resources[0]!.description).toBe("MCP-specific description");
  });

  it("meta.description is used when meta.mcp.description is absent", () => {
    const n = api_({
      config: op((_: unknown) => ({}), {
        description: "app configuration",
        mcp: { as: "resource" },
      }),
    });
    const { resources } = projectResources(n);
    expect(resources[0]!.description).toBe("app configuration");
  });
});

// ============================================================================
// 9. Prompt projection — meta.mcp.as: "prompt"
// ============================================================================

describe('meta.mcp.as: "prompt" projects a prompt, not a tool', () => {
  it('a leaf tagged as: "prompt" is excluded from toTools', () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    expect(toTools(n)).toHaveLength(0);
  });

  it('a leaf tagged as: "prompt" is excluded from projectResources', () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { resources } = projectResources(n);
    expect(resources).toHaveLength(0);
  });

  it("the same leaf appears in projectPrompts' prompts array", () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { prompts } = projectPrompts(n);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.name).toBe("summarize");
  });

  it("default behavior (no `as`) still produces a tool, not a prompt", () => {
    const n = api_({ create: op((_: unknown) => ({})) });
    expect(toTools(n)).toHaveLength(1);
    const { prompts } = projectPrompts(n);
    expect(prompts).toHaveLength(0);
  });
});

describe("prompt name derivation from tree position", () => {
  it("root-level leaf name is just the leaf key", () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.name).toBe("summarize");
  });

  it("nested leaf name is underscore-joined: parent_key", () => {
    const api = api_({
      docs: api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) }),
    });
    const { prompts } = projectPrompts(api);
    expect(prompts[0]!.name).toBe("docs_summarize");
  });

  it("fallback contributes its name to the prompt name prefix", () => {
    const api = api_({
      docs: api_(
        {},
        {
          fallback: {
            name: "docId",
            subtree: api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) }),
          },
        },
      ),
    });
    const { prompts } = projectPrompts(api);
    expect(prompts[0]!.name).toBe("docs_docId_summarize");
  });

  it("meta.mcp.name overrides the inferred name", () => {
    const n = api_({
      summarize: op((_: unknown) => ({}), { mcp: { as: "prompt", name: "doc_summary" } }),
    });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.name).toBe("doc_summary");
  });
});

describe("prompt description resolution", () => {
  it("meta.mcp.description overrides meta.description and the leaf key", () => {
    const n = api_({
      summarize: op((_: unknown) => ({}), {
        description: "agnostic description",
        mcp: { as: "prompt", description: "MCP-specific description" },
      }),
    });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.description).toBe("MCP-specific description");
  });

  it("meta.description is used when meta.mcp.description is absent", () => {
    const n = api_({
      summarize: op((_: unknown) => ({}), {
        description: "summarizes a document",
        mcp: { as: "prompt" },
      }),
    });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.description).toBe("summarizes a document");
  });

  it("falls back to the leaf key when no description is available anywhere", () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.description).toBe("summarize");
  });
});

describe("prompt arguments derived from schema", () => {
  it("no schema supplied → no arguments array", () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.arguments).toBeUndefined();
  });

  it("a derived inputSchema's properties become PromptArgument entries", () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { prompts } = projectPrompts(n, {
      schemas: {
        summarize: {
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "the text to summarize" },
              length: { type: "number" },
            },
            required: ["text"],
          },
        },
      },
    });
    const args = prompts[0]!.arguments!;
    expect(args).toHaveLength(2);
    const text = args.find((a) => a.name === "text")!;
    expect(text.description).toBe("the text to summarize");
    expect(text.required).toBe(true);
    const length = args.find((a) => a.name === "length")!;
    expect(length.required).toBeUndefined();
    expect(length.description).toBeUndefined();
  });

  it("the MCP spec minimum schema ({ type: 'object' }, no properties) yields no arguments", () => {
    const n = api_({ summarize: op((_: unknown) => ({}), { mcp: { as: "prompt" } }) });
    const { prompts } = projectPrompts(n, {
      schemas: { summarize: { inputSchema: { type: "object" } } },
    });
    expect(prompts[0]!.arguments).toBeUndefined();
  });
});

// ============================================================================
// 10. meta.tags.deprecated, on all three surfaces
// ============================================================================

describe("meta.tags.deprecated surfaces on every leaf-derived surface", () => {
  it("tool: deprecated:true → tools[0].deprecated === true", () => {
    const n = api_({ old: op((_: unknown) => "result", { tags: { deprecated: true } }) });
    const tools = toTools(n);
    expect(tools[0]!.deprecated).toBe(true);
  });

  it("tool: no deprecated tag → deprecated key omitted", () => {
    const n = api_({ fresh: op((_: unknown) => "result", {}) });
    const tools = toTools(n);
    expect("deprecated" in tools[0]!).toBe(false);
  });

  it("tool: deprecated:false → deprecated key omitted (three-valued, not false)", () => {
    const n = api_({ fresh: op((_: unknown) => "result", { tags: { deprecated: false } }) });
    const tools = toTools(n);
    expect("deprecated" in tools[0]!).toBe(false);
  });

  it("resource: deprecated:true → resources[0].deprecated === true", () => {
    const n = api_({
      old: op((_: unknown) => ({}), { mcp: { as: "resource" }, tags: { deprecated: true } }),
    });
    const { resources } = projectResources(n);
    expect(resources[0]!.deprecated).toBe(true);
  });

  it("prompt: deprecated:true → prompts[0].deprecated === true", () => {
    const n = api_({
      old: op((_: unknown) => ({}), { mcp: { as: "prompt" }, tags: { deprecated: true } }),
    });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.deprecated).toBe(true);
  });
});

// ============================================================================
// 11. Recovering a stream or page kind from a derived output schema
//
// JSON Schema cannot express either kind, so type-ir lowers both to a tagged
// array schema. These cases cover reading the tag back off — into
// `McpTool.streaming`, `.paginated` and `.pageStyle` — and the precedence
// between the tag and an authored `meta.tags.streaming`.
// ============================================================================

describe("stream/page kind preservation from a derived output schema", () => {
  it("an x-stream-tagged output schema sets tools[0].streaming = true", () => {
    const n = api_({ gen: op((_: unknown) => ({}), {}) });
    const { tools } = projectTools(n, {
      schemas: {
        gen: { outputSchema: { type: "array", items: { type: "string" }, "x-stream": true } },
      },
    });
    expect(tools[0]!.streaming).toBe(true);
  });

  it("an x-stream-tagged output schema is not assigned to outputSchema, being an array where MCP requires an object", () => {
    const n = api_({ gen: op((_: unknown) => ({}), {}) });
    const { tools } = projectTools(n, {
      schemas: {
        gen: { outputSchema: { type: "array", items: { type: "string" }, "x-stream": true } },
      },
    });
    expect(tools[0]!.outputSchema).toBeUndefined();
  });

  it("an x-stream-tagged schema whose item schema is object-shaped surfaces that item schema as outputSchema", () => {
    const n = api_({ gen: op((_: unknown) => ({}), {}) });
    const itemSchema = { type: "object", properties: { chunk: { type: "string" } } };
    const { tools } = projectTools(n, {
      schemas: { gen: { outputSchema: { type: "array", items: itemSchema, "x-stream": true } } },
    });
    expect(tools[0]!.outputSchema).toEqual(itemSchema);
    expect(tools[0]!.streaming).toBe(true);
  });

  it("an x-page-style-tagged output schema sets tools[0].paginated = true and pageStyle", () => {
    const n = api_({ list: op((_: unknown) => ({}), {}) });
    const { tools } = projectTools(n, {
      schemas: {
        list: {
          outputSchema: { type: "array", items: { type: "string" }, "x-page-style": "cursor" },
        },
      },
    });
    expect(tools[0]!.paginated).toBe(true);
    expect(tools[0]!.pageStyle).toBe("cursor");
    expect(tools[0]!.streaming).toBeUndefined();
  });

  it("offset-style pagination surfaces pageStyle: 'offset'", () => {
    const n = api_({ list: op((_: unknown) => ({}), {}) });
    const { tools } = projectTools(n, {
      schemas: {
        list: {
          outputSchema: { type: "array", items: { type: "string" }, "x-page-style": "offset" },
        },
      },
    });
    expect(tools[0]!.pageStyle).toBe("offset");
  });

  it("a plain object output schema (no x-stream/x-page-style) is assigned to outputSchema unchanged, streaming/paginated omitted", () => {
    const n = api_({ get: op((_: unknown) => ({}), {}) });
    const outputSchema = { type: "object", properties: { id: { type: "string" } } };
    const { tools } = projectTools(n, { schemas: { get: { outputSchema } } });
    expect(tools[0]!.outputSchema).toEqual(outputSchema);
    expect(tools[0]!.streaming).toBeUndefined();
    expect(tools[0]!.paginated).toBeUndefined();
  });

  it("no derived schema at all → outputSchema/streaming/paginated all omitted", () => {
    const n = api_({ get: op((_: unknown) => ({}), {}) });
    const tools = toTools(n);
    expect(tools[0]!.outputSchema).toBeUndefined();
    expect(tools[0]!.streaming).toBeUndefined();
    expect(tools[0]!.paginated).toBeUndefined();
  });

  it("an explicit meta.tags.streaming: true wins even with no x-stream marker on the schema", () => {
    const n = api_({ gen: op((_: unknown) => ({}), { tags: { streaming: true } }) });
    const tools = toTools(n);
    expect(tools[0]!.streaming).toBe(true);
  });

  it("an explicit meta.tags.streaming: false wins over an x-stream-tagged schema (authored fact over inferred one)", () => {
    const n = api_({ gen: op((_: unknown) => ({}), { tags: { streaming: false } }) });
    const { tools } = projectTools(n, {
      schemas: {
        gen: { outputSchema: { type: "array", items: { type: "string" }, "x-stream": true } },
      },
    });
    expect(tools[0]!.streaming).toBe(false);
  });

  it("resource: an authored meta.tags.streaming: true surfaces on resources[0].streaming (no schema to unwrap for resources)", () => {
    const n = api_({
      log: op((_: unknown) => ({}), { mcp: { as: "resource" }, tags: { streaming: true } }),
    });
    const { resources } = projectResources(n);
    expect(resources[0]!.streaming).toBe(true);
  });

  it("resource template (fallback subtree): streaming surfaces the same way", () => {
    const n = api_({
      users: api_(
        {},
        {
          fallback: {
            name: "userId",
            subtree: api_({
              log: op((_: unknown) => ({}), { mcp: { as: "resource" }, tags: { streaming: true } }),
            }),
          },
        },
      ),
    });
    const { resourceTemplates } = projectResources(n);
    expect(resourceTemplates[0]!.streaming).toBe(true);
  });

  it("prompt: an authored meta.tags.streaming: true surfaces on prompts[0].streaming", () => {
    const n = api_({
      narrate: op((_: unknown) => ({}), { mcp: { as: "prompt" }, tags: { streaming: true } }),
    });
    const { prompts } = projectPrompts(n);
    expect(prompts[0]!.streaming).toBe(true);
  });

  it("an explicit meta.tags.streaming: false is emitted as streaming: false (a genuine negation, not the unknown/omitted case)", () => {
    const n = api_({ get: op((_: unknown) => ({}), { tags: { streaming: false } }) });
    const tools = toTools(n);
    expect(tools[0]!.streaming).toBe(false);
    expect("streaming" in tools[0]!).toBe(true);
  });
});
