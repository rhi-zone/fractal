import { describe, expect, test } from "bun:test";
import { toMethods, type SchemaMap } from "@rhi-zone/fractal-json-rpc-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { fromOpenRpcDocument } from "./from-openrpc.ts";
import { lower, nameKeys, schemaMap, type KeyConvention } from "./lower.ts";

const doc = {
  openrpc: "1.3.2",
  info: { title: "Chain", version: "0.9.0", description: "a chain node", license: { name: "MIT" } },
  servers: [{ name: "local", url: "http://localhost:8545" }],
  "x-team": "core",
  methods: [
    {
      name: "eth.getBalance",
      summary: "balance of an address",
      tags: [{ name: "accounts" }, { $ref: "#/components/tags/state" }],
      params: [
        { $ref: "#/components/contentDescriptors/Address" },
        { name: "block", schema: { type: "string" }, description: "block tag" },
      ],
      result: { name: "balance", schema: { $ref: "#/components/schemas/Quantity" } },
      errors: [{ $ref: "#/components/errors/NotFound" }],
      examples: [
        {
          name: "one",
          params: [{ name: "address", value: "0xabc" }],
          result: { name: "balance", value: "0x1" },
        },
      ],
      "x-cost": 3,
    },
    {
      name: "eth.blockNumber",
      params: [],
      result: { name: "n", schema: { type: "integer" } },
    },
    {
      name: "net.version",
      description: "network id",
      deprecated: true,
      params: [],
      result: { name: "v", schema: { type: "string" } },
    },
    {
      name: "ping",
      params: [{ name: "payload", required: true, schema: { type: "string" } }],
      result: { name: "pong", schema: { type: "string" } },
    },
    {
      name: "notify",
      params: [{ name: "msg", required: true, schema: { type: "string" } }],
    },
    {
      name: "positional",
      paramStructure: "by-position",
      params: [
        { name: "a", required: true, schema: { type: "integer" } },
        { name: "b", required: true, schema: { type: "integer" } },
      ],
      result: { name: "sum", schema: { type: "integer" } },
    },
    {
      name: "viaRef",
      params: [{ name: "q", schema: { $ref: "#/components/contentDescriptors/Address/schema" } }],
      result: { name: "r", schema: true },
    },
  ],
  components: {
    schemas: {
      Quantity: { type: "string", pattern: "^0x[0-9a-f]+$" },
      Tree: { type: "object", properties: { next: { $ref: "#/components/schemas/Tree" } } },
    },
    contentDescriptors: {
      Address: {
        name: "address",
        required: true,
        schema: { type: "string", minLength: 3 },
      },
    },
    errors: { NotFound: { code: -32001, message: "not found" } },
    tags: { state: { name: "state", description: "chain state" } },
  },
};

const dotted: KeyConvention = { delimiter: ".", fallbackSegment: (n) => n, namespace: "jsonrpc" };

/** The json-rpc projector's `SchemaMap`, keyed by dotted method name, from the lowered types. */
function jsonRpcSchemas(lowered: ReturnType<typeof lower>): SchemaMap {
  const out: Record<string, SchemaMap[string]> = {};
  for (const [key, s] of Object.entries(schemaMap(lowered, dotted))) {
    out[key] = {
      paramsSchema: s.inputSchema,
      ...(s.outputSchema !== undefined ? { resultSchema: s.outputSchema } : {}),
    };
  }
  return out;
}

describe("fromOpenRpcDocument", () => {
  const imported = fromOpenRpcDocument(doc);
  const byName = (name: string) =>
    imported.api.operations.find(
      (o) =>
        (o.meta.jsonrpc as { name?: string } | undefined)?.name === name ||
        o.address.map((s) => s.name).join(".") === name,
    )!;
  const fieldsOf = (name: string) =>
    (
      byName(name).input.shape as {
        fields: Record<string, { meta: Record<string, unknown> }>;
      }
    ).fields;

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });

  test("dotted names become address paths", () => {
    expect(imported.api.operations.map((o) => o.address.map((s) => s.name).join("/"))).toEqual([
      "eth/getBalance",
      "eth/blockNumber",
      "net/version",
      "ping",
      "notify",
      "positional",
      "viaRef",
    ]);
  });

  test("params become one named input; refs resolve; required is opt-in", () => {
    const f = fieldsOf("eth.getBalance");
    expect(Object.keys(f)).toEqual(["address", "block"]);
    expect(f.address!.meta.optional).toBeUndefined();
    expect(f.block!.meta.optional).toBe(true);
    expect(f.block!.meta.description).toBe("block tag");
  });

  test("result schemas become output; component schemas become defs", () => {
    expect(byName("eth.getBalance").output!.shape).toEqual({ kind: "ref", target: "Quantity" });
    expect(Object.keys(imported.api.defs).sort()).toEqual(["Quantity", "Tree"]);
    expect(imported.api.defs.Tree!.meta.typeName).toBe("Tree");
  });

  test("a $ref that is not into components.schemas is inlined", () => {
    const q = fieldsOf("viaRef").q as unknown as { shape: { kind: string } };
    expect(q.shape.kind).toBe("string");
    expect(byName("viaRef").output!.shape.kind).toBe("unknown");
  });

  test("deprecation and description land in shared meta", () => {
    const v = byName("net.version");
    expect(v.meta.tags).toEqual({ deprecated: true });
    expect(v.meta.description).toBe("network id");
    expect(byName("eth.getBalance").meta.description).toBe("balance of an address");
  });

  test("everything else is kept verbatim under meta.openrpc with references resolved", () => {
    const o = byName("eth.getBalance").meta.openrpc as Record<string, unknown>;
    expect(o.summary).toBe("balance of an address");
    expect(o.tags).toEqual([{ name: "accounts" }, { name: "state", description: "chain state" }]);
    expect(o.errors).toEqual([{ code: -32001, message: "not found" }]);
    expect(o["x-cost"]).toBe(3);
    expect(o.result).toEqual({ name: "balance" });
    expect((o.examples as { params: unknown[] }[])[0]!.params).toEqual([
      { name: "address", value: "0xabc" },
    ]);
  });

  test("document info comes back and root meta carries servers and extensions", () => {
    expect(imported.version).toBe("1.3.2");
    expect(imported.info).toEqual({ title: "Chain", version: "0.9.0" });
    const root = imported.api.groups.find((g) => g.address.length === 0)!;
    expect(root.meta.description).toBe("a chain node");
    expect((root.meta.openrpc as Record<string, unknown>).servers).toEqual(doc.servers);
    expect((root.meta.openrpc as Record<string, unknown>)["x-team"]).toBe("core");
  });

  test("a method without result is a void notification, reported", () => {
    const n = byName("notify");
    expect(n.output!.shape.kind).toBe("void");
    expect((n.meta.openrpc as Record<string, unknown>).notification).toBe(true);
    expect(
      imported.diagnostics.some((d) => d.at === "#/methods/4" && /notification/.test(d.message)),
    ).toBe(true);
  });

  test("by-position paramStructure is reported and kept", () => {
    expect(
      imported.diagnostics.some(
        (d) => d.at === "#/methods/5/paramStructure" && /by name only/.test(d.message),
      ),
    ).toBe(true);
    expect((byName("positional").meta.openrpc as Record<string, unknown>).paramStructure).toBe(
      "by-position",
    );
    expect(Object.keys(fieldsOf("positional"))).toEqual(["a", "b"]);
  });

  test("a bad part is reported without losing the rest", () => {
    const { api, diagnostics } = fromOpenRpcDocument({
      openrpc: "1.2.6",
      info: { title: "t", version: "1" },
      methods: [
        {
          name: "ok",
          params: [{ $ref: "#/components/contentDescriptors/Nope" }],
          result: { name: "r", schema: {} },
        },
        { name: "ok", params: [], result: { name: "r", schema: {} } },
        { $ref: "https://example.com/other.json#/methods/0" },
      ],
    });
    expect(api.operations).toHaveLength(1);
    expect(diagnostics.map((d) => d.at).sort()).toEqual([
      "#/methods/0/params/0",
      "#/methods/1",
      "#/methods/2",
    ]);
  });

  test("non-openrpc documents throw", () => {
    expect(() => fromOpenRpcDocument({ openapi: "3.0.0" })).toThrow(/unsupported/);
    expect(() => fromOpenRpcDocument("x")).toThrow(/JSON object/);
  });
});

describe("names that are not plain dotted paths", () => {
  const imported = fromOpenRpcDocument({
    openrpc: "1.3.2",
    info: { title: "t", version: "1" },
    methods: [
      { name: "eth", params: [], result: { name: "r", schema: {} } },
      { name: "eth.getBalance", params: [], result: { name: "r", schema: {} } },
      { name: "a..b", params: [], result: { name: "r", schema: {} } },
    ],
  });

  test("a name that prefixes another keeps its wire name and is reported", () => {
    expect(imported.api.operations[0]!.meta.jsonrpc).toEqual({ name: "eth" });
    expect(imported.diagnostics.filter((d) => /plain dotted path/.test(d.message))).toHaveLength(2);
  });

  test("the json-rpc projector still names every method exactly", () => {
    const names = toMethods(lower(imported.api).tree).map((m) => m.name);
    expect(names.sort()).toEqual(["a..b", "eth", "eth.getBalance"]);
  });

  test("a renamed method's schema is keyed by its wire name", () => {
    const lowered = lower(imported.api);
    const methods = toMethods(lowered.tree, { schemas: jsonRpcSchemas(lowered) });
    for (const m of methods) expect(m.resultSchema).toBeDefined();
  });
});

describe("lower + projectors", () => {
  const imported = fromOpenRpcDocument(doc);
  const lowered = lower(imported.api);

  test("json-rpc methods come back out with identical names, schemas and flags", () => {
    const methods = toMethods(lowered.tree, { schemas: jsonRpcSchemas(lowered) });
    expect(methods.map((m) => m.name).sort()).toEqual(doc.methods.map((m) => m.name).sort());
    const bal = methods.find((m) => m.name === "eth.getBalance")!;
    expect(bal.description).toBe("balance of an address");
    const params = bal.paramsSchema as { properties: object; required: string[] };
    expect(Object.keys(params.properties)).toEqual(["address", "block"]);
    expect(params.required).toEqual(["address"]);
    expect(bal.resultSchema).toMatchObject({ $ref: "#/$defs/Quantity" });
    expect(methods.find((m) => m.name === "net.version")!.deprecated).toBe(true);
  });

  test("mcp tools read the same imported schemas", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const names = tools.map((t) => t.name);
    expect(names).toContain("eth_getBalance");
    expect(names).toContain("ping");
  });
});
