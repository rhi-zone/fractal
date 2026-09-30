import { describe, expect, test } from "bun:test";
import {
  projectPrompts,
  projectResources,
  projectTools,
  type SchemaMap,
} from "@rhi-zone/fractal-mcp-api-projector";
import { fromMcpListing } from "./from-mcp.ts";
import { lower, toSelfContainedJsonSchema, type Lowered } from "./lower.ts";
import { isLeaf, type Node } from "./node.ts";

const listing = {
  tools: [
    {
      name: "search_issues.v2",
      title: "Search issues",
      description: "Find issues",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "text to match" },
          limit: { type: "integer" },
          state: { $ref: "#/$defs/State" },
        },
        required: ["query"],
        $defs: { State: { type: "string", enum: ["open", "closed"] } },
      },
      outputSchema: {
        type: "object",
        properties: { total: { type: "integer" }, first: { $ref: "#/$defs/State" } },
        required: ["total"],
        $defs: { State: { type: "string", enum: ["open", "closed"] } },
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      icons: [{ src: "https://example.com/i.png" }],
    },
    {
      name: "delete-issue",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      annotations: { destructiveHint: true, idempotentHint: false, title: "Delete" },
    },
    { name: "ping", inputSchema: { type: "object", additionalProperties: false } },
    {
      name: "other",
      inputSchema: {
        type: "object",
        properties: { s: { $ref: "#/$defs/State" } },
        $defs: { State: { type: "string", enum: ["a", "b"] } },
      },
    },
  ],
  prompts: [
    {
      name: "code_review",
      title: "Code review",
      description: "Review code",
      arguments: [
        { name: "code", description: "the code", required: true },
        { name: "style", title: "Style" },
      ],
    },
    { name: "ping" },
  ],
  resources: [
    {
      uri: "file:///project/README.md",
      name: "README.md",
      description: "docs",
      mimeType: "text/markdown",
      annotations: { audience: ["user"], priority: 0.8 },
      size: 12,
    },
  ],
  resourceTemplates: [
    {
      uriTemplate: "file:///{dir}/{file}",
      name: "project.file",
      description: "any file",
      mimeType: "text/plain",
    },
  ],
};

/** Every leaf's JSON Schemas keyed by its exact `meta.mcp.name`, as the mcp projector looks them up. */
function schemasByMcpName(lowered: Lowered): SchemaMap {
  const out: Record<string, { inputSchema: object; outputSchema?: object; description?: string }> =
    {};
  const walk = (n: Node): void => {
    if (isLeaf(n)) {
      const name = (n.meta.mcp as { name?: string } | undefined)?.name;
      const info = lowered.types.get(n.handler!);
      if (name !== undefined && info !== undefined) {
        out[name] = {
          inputSchema: toSelfContainedJsonSchema(info.input, lowered.defs),
          ...(info.output !== undefined
            ? { outputSchema: toSelfContainedJsonSchema(info.output, lowered.defs) }
            : {}),
          ...(info.description !== undefined ? { description: info.description } : {}),
        };
      }
      return;
    }
    for (const c of Object.values(n.children ?? {})) walk(c);
    if (n.fallback !== undefined) walk(n.fallback.subtree);
  };
  walk(lowered.tree);
  return out as SchemaMap;
}

describe("fromMcpListing", () => {
  const imported = fromMcpListing(listing);
  const byAddress = (a: string) =>
    imported.api.operations.find(
      (o) => o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/") === a,
    )!;

  test("plain JSON, addressed by kind then exact name", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
    expect(
      imported.api.operations.map((o) =>
        o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/"),
      ),
    ).toEqual([
      "tools/search_issues.v2",
      "tools/delete-issue",
      "tools/ping",
      "tools/other",
      "prompts/code_review",
      "prompts/ping",
      "resources/README.md",
      "resourceTemplates/project.file/{dir}/{file}/read",
    ]);
  });

  test("annotation hints become only the tags that were present", () => {
    expect(byAddress("tools/search_issues.v2").meta.tags).toEqual({
      readOnly: true,
      openWorld: true,
    });
    expect(byAddress("tools/delete-issue").meta.tags).toEqual({
      destructive: true,
      idempotent: false,
    });
    expect(byAddress("tools/ping").meta.tags).toBeUndefined();
  });

  test("name, title, description and unread fields ride on meta.mcp", () => {
    const meta = byAddress("tools/search_issues.v2").meta;
    expect(meta.description).toBe("Find issues");
    expect(meta.mcp).toMatchObject({
      as: "tool",
      name: "search_issues.v2",
      title: "Search issues",
      icons: [{ src: "https://example.com/i.png" }],
    });
    expect(byAddress("resources/README.md").meta.mcp).toMatchObject({
      annotations: { audience: ["user"], priority: 0.8 },
      size: 12,
    });
    expect(byAddress("prompts/code_review").meta.mcp).toMatchObject({
      argumentExtras: { style: { title: "Style" } },
    });
  });

  test("identical $defs are shared, differing ones are kept under a renamed def", () => {
    expect(Object.keys(imported.api.defs).sort()).toEqual(["State", "tool:other.State"]);
    expect(imported.diagnostics.some((d) => d.message.includes('renamed "tool:other.State"'))).toBe(
      true,
    );
    expect(byAddress("tools/other").input.shape).toMatchObject({
      fields: { s: { shape: { kind: "ref", target: "tool:other.State" } } },
    });
  });

  test("bad entries are reported without dropping the rest", () => {
    const r = fromMcpListing({
      tools: [
        { name: "a", inputSchema: { type: "object" } },
        { name: "a", inputSchema: { type: "object" } },
        { inputSchema: {} },
        { name: "anyof", inputSchema: { anyOf: [{ type: "object" }] } },
      ],
      resources: [{ name: "no-uri" }],
      resourceTemplates: [{ name: "static", uriTemplate: "x://fixed" }],
    });
    expect(r.api.operations.map((o) => (o.address.at(-1) as { name: string }).name)).toEqual([
      "a",
      "anyof",
      "read",
    ]);
    const messages = r.diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("duplicate name"))).toBe(true);
    expect(messages.some((m) => m.includes("no string name"))).toBe(true);
    expect(messages.some((m) => m.includes("not an object schema"))).toBe(true);
    expect(messages.some((m) => m.includes("no string uri"))).toBe(true);
    expect(messages.some((m) => m.includes("no variables"))).toBe(true);
  });

  test("list results are accepted whole", () => {
    const r = fromMcpListing({ tools: { tools: listing.tools, nextCursor: "x" } });
    expect(r.api.operations).toHaveLength(4);
  });

  test("RFC 6570 operators are reported", () => {
    const r = fromMcpListing({ resourceTemplates: [{ name: "q", uriTemplate: "x://a{?q,r}" }] });
    expect(r.diagnostics.some((d) => d.message.includes("operators"))).toBe(true);
    expect(Object.keys((r.api.operations[0]!.input.shape as { fields: object }).fields)).toEqual([
      "q",
      "r",
    ]);
  });
});

describe("lower + mcp projector round trip", () => {
  const imported = fromMcpListing(listing);
  const lowered = lower(imported.api);
  const schemas = schemasByMcpName(lowered);

  test("tools come back with exact names, schemas and hints", () => {
    const tools = projectTools(lowered.tree, { schemas }).tools;
    expect(tools.map((t) => t.name)).toEqual(["search_issues.v2", "delete-issue", "ping", "other"]);
    const search = tools[0]!;
    expect(search.description).toBe("Find issues");
    expect(search.inputSchema).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string", description: "text to match" },
        limit: { type: "integer" },
        state: { $ref: "#/$defs/State" },
      },
      required: ["query"],
      $defs: { State: { type: "string", enum: ["open", "closed"] } },
    });
    expect(search.outputSchema).toMatchObject({
      type: "object",
      properties: { total: { type: "integer" } },
      required: ["total"],
    });
    expect(search.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
      title: "Search issues",
    });
    expect(tools[1]!.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
      title: "Delete",
    });
    expect(tools[2]!.inputSchema).toMatchObject({ type: "object" });
    expect(
      (tools[3]!.inputSchema as { $defs: Record<string, unknown> }).$defs["tool:other.State"],
    ).toMatchObject({ enum: ["a", "b"] });
  });

  test("prompts come back with exact names and arguments", () => {
    const { prompts } = projectPrompts(lowered.tree, { schemas });
    expect(prompts.map((p) => p.name)).toEqual(["code_review", "ping"]);
    expect(prompts[0]!.description).toBe("Review code");
    expect(prompts[0]!.arguments).toEqual([
      { name: "code", description: "the code", required: true },
      { name: "style" },
    ]);
    expect(prompts[1]!.arguments).toBeUndefined();
  });

  test("resources and templates come back with exact URIs", () => {
    const { resources, resourceTemplates, templateHandlers } = projectResources(lowered.tree);
    expect(resources).toEqual([
      {
        uri: "file:///project/README.md",
        name: "README.md",
        description: "docs",
        mimeType: "text/markdown",
      },
    ]);
    expect(resourceTemplates).toEqual([
      {
        uriTemplate: "file:///{dir}/{file}",
        name: "project.file",
        description: "any file",
        mimeType: "text/plain",
      },
    ]);
    expect(templateHandlers[0]!.paramNames).toEqual(["dir", "file"]);
    expect(templateHandlers[0]!.pattern.test("file:///a/b")).toBe(true);
  });
});
