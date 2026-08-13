// Generated validators, wired through `opts.rewriters`.
//
// `applyValidation` rewrites the tree before any projection walk reads it, so
// the handler registered for dispatch is already wrapped in its leaf's
// generated `parse()`. Where a validator covers a leaf, decode and validation
// run on every call to it. Where none does, nothing runs — there is no manual
// schema check to fall back to (docs/design/wire-profiles-and-staged-
// validation.md, "What goes away", item 3), and the wire values reach the
// handler as they arrived. That is the design's stated cost of working in a
// checkout where codegen has not been run.

import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { api, op } from "@rhi-zone/fractal-api-tree/node";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { createApplyValidation } from "@rhi-zone/fractal-api-tree/apply-validation";
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/apply-validation";
import { createMcpServer } from "./server.ts";
import type { SchemaMap } from "./project.ts";

/** Stands in for a generated validator: `id` must be a string of digits, and becomes a number. */
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

/** Shown to clients as the tool's `inputSchema`, and never consulted at dispatch. */
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

  it("a tool no generated-validator entry covers is not validated at all", async () => {
    // A validator is wired, but under a different path, so this leaf is
    // uncovered. The advertised schema says `id` is a string and the call sends
    // a number; nothing checks, and the handler sees the number.
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

    // With no rewriter there is nothing to decode or validate, so "42" stays
    // the string it arrived as.
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" });
  });
});

describe('createMcpServer — 3-arg applyValidation(key, tree, "mcp") wiring', () => {
  // The protocol-keyed runtime path, with a hand-written entry standing in for
  // a generated one: strict, coercing no stringified numbers, as MCP's
  // identity-plus-JSON-dates profile requires
  // (docs/design/wire-profiles-and-staged-validation.md). Codegen actually
  // producing such an entry is covered in packages/api-tree, by
  // apply-validation-build.test.ts.
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
