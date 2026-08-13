// packages/mcp-api-projector/src/server-validators.test.ts — createMcpServer generated-validator wiring
//
// `createMcpServer`'s `opts.rewriters` runs `applyValidation(key, tree, ...)`
// (@rhi-zone/fractal-api-tree/apply-validation) on `tree` before
// `projectTools` builds its dispatch map — the leaf's generated `parse()`
// runs, wrapping `dispatch.handler`. Decode+validation run unconditionally on
// every leaf a generated validator covers; there is no manual fallback check
// (`validateAgainstSchema`, deleted per
// docs/design/wire-profiles-and-staged-validation.md's "What goes away" item
// 3) for an uncovered leaf to fall back onto — an uncovered leaf's raw wire
// args reach the handler directly, unvalidated (the design's stated
// zero-setup tradeoff for a pre-codegen checkout).

import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { api, op } from "@rhi-zone/fractal-api-tree/node";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { createApplyValidation } from "@rhi-zone/fractal-api-tree/apply-validation";
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/apply-validation";
import { createMcpServer } from "./server.ts";
import type { SchemaMap } from "./project.ts";

/** A synthetic GeneratedEntry: requires `id` to be a numeric string,
 * coercing it to a number on success. */
function idEntry(): GeneratedEntry {
  return {
    parse: (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return {
          kind: "err",
          errors: [{ kind: "type", path: [], expected: "object", actual: value }],
        };
      }
      const v = value as Record<string, unknown>;
      if (typeof v.id !== "string" || !/^\d+$/.test(v.id)) {
        return {
          kind: "err",
          errors: [{ kind: "type", path: ["id"], expected: "numeric string", actual: v.id }],
        };
      }
      return { kind: "ok", value: { ...v, id: Number(v.id) } };
    },
  };
}

const tree = api({
  users: api({
    get: op((input: { id: number }) => ({ id: input.id, name: "Alice" })),
  }),
});

/** A derived schema — no longer consulted for validation (no manual fallback
 * check exists), but still forwarded to `projectTools` for `inputSchema`
 * advertised to MCP clients. */
const schemas: SchemaMap = {
  users_get: {
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
};

async function connectedClient(rewriters?: ReadonlyArray<(t: Node) => Node>) {
  const server = createMcpServer(tree, {
    name: "test-server",
    version: "1.0.0",
    schemas,
    ...(rewriters !== undefined ? { rewriters } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("createMcpServer — generated validators wired via opts.rewriters' applyValidation", () => {
  it("routes tool-call args through the generated validator's parse() — coercion reaches the handler", async () => {
    const applyValidation = createApplyValidation({ gen: { "users/get": idEntry() } });
    const { client } = await connectedClient([(t) => applyValidation("gen", t)]);
    const result = await client.callTool({ name: "users_get", arguments: { id: "42" } });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ id: 42, name: "Alice" });
  });

  it("a generated-validator rejection surfaces as an MCP tool error result, handler never runs", async () => {
    let handlerCalled = false;
    const trackedTree = api({
      users: api({
        get: op((input: { id: number }) => {
          handlerCalled = true;
          return input;
        }),
      }),
    });
    const applyValidation = createApplyValidation({ gen: { "users/get": idEntry() } });
    const server = createMcpServer(trackedTree, {
      name: "test-server",
      version: "1.0.0",
      rewriters: [(t) => applyValidation("gen", t)],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "users_get", arguments: { id: "not-a-number" } });

    expect(result.isError).toBe(true);
    expect(handlerCalled).toBe(false);
  });

  it("a tool with no matching generated-validator entry gets NO validation — raw args reach the handler", async () => {
    // A validator IS wired, but keyed under a DIFFERENT path — "users/get"
    // isn't covered. There is no manual-schema fallback anymore (deleted
    // per the wire-profiles design's "What goes away" item 3), so the
    // uncovered leaf's raw args pass straight through to the handler
    // unvalidated, even though the derived input schema declares `id` as a
    // string and the caller sent a number.
    const applyValidation = createApplyValidation({ gen: { "other/path": idEntry() } });
    const { client } = await connectedClient([(t) => applyValidation("gen", t)]);
    const result = await client.callTool({ name: "users_get", arguments: { id: 42 } });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ id: 42, name: "Alice" });
  });

  it("without opts.rewriters at all, args reach the handler with no validation at all", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({ name: "users_get", arguments: { id: "42" } });

    // No `applyValidation` rewriter at all -> no decode, no validation. The
    // handler receives the raw string "42" verbatim (no coercion to a
    // number) — the design's documented pre-codegen/uncovered-leaf
    // tradeoff, not a bug.
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" });
  });
});

describe('createMcpServer — 3-arg applyValidation(key, tree, "mcp") wiring', () => {
  // Exercises the real `WireValidatorMap`/protocol-keyed runtime path (not
  // full codegen — see `apply-validation-build.ts`'s
  // `buildWireApplyValidationModuleSource` in packages/api-tree for the
  // actual codegen-driven jsonProfile coverage, e.g.
  // apply-validation-build.test.ts's "http/cli (query/argv-shaped) coerce a
  // numeric-string \"page\"; mcp (json-shaped) rejects it"). Stands in for
  // what a generated `mcp` wire entry looks like: strict, no coercion of a
  // stringified number — matching MCP's identity+JSON-dates profile
  // (docs/design/wire-profiles-and-staged-validation.md, "MCP / GraphQL:
  // identity + JSON dates").
  function strictCountEntry(): GeneratedEntry {
    return {
      parse: (value: unknown) => {
        if (typeof value !== "object" || value === null) {
          return {
            kind: "err",
            errors: [{ kind: "type", path: [], expected: "object", actual: value }],
          };
        }
        const v = value as Record<string, unknown>;
        if (typeof v.count !== "number") {
          return {
            kind: "err",
            errors: [{ kind: "type", path: ["count"], expected: "number", actual: v.count }],
          };
        }
        return { kind: "ok", value: v };
      },
    };
  }

  const countTree = api({
    counter: api({
      get: op((input: { count: number }) => ({ count: input.count })),
    }),
  });

  async function connectedCountClient() {
    const applyValidation = createApplyValidation(
      {},
      { gen: { "counter/get": { mcp: strictCountEntry() } } },
    );
    const server = createMcpServer(countTree, {
      name: "test-server",
      version: "1.0.0",
      rewriters: [(t) => applyValidation("gen", t, "mcp")],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("a stringified number is rejected with a structured error — no coercion, matching MCP's identity+json-dates profile", async () => {
    const client = await connectedCountClient();
    const result = await client.callTool({ name: "counter_get", arguments: { count: "3" } });
    expect(result.isError).toBe(true);
  });

  it("an actual number passes straight through", async () => {
    const client = await connectedCountClient();
    const result = await client.callTool({ name: "counter_get", arguments: { count: 3 } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ count: 3 });
  });
});
