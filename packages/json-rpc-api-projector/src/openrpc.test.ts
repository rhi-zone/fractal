import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { fromOpenRpcDocument } from "@rhi-zone/fractal-api-tree/from-openrpc";
import { lower, schemaMap, type KeyConvention } from "@rhi-zone/fractal-api-tree/lower";
import { toOpenRpc } from "./openrpc.ts";
import type { SchemaMap } from "./project.ts";
import "./deployment-meta.test-support.ts";

const dotted: KeyConvention = { delimiter: ".", fallbackSegment: (n) => n, namespace: "jsonrpc" };

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
      name: "eth.getStorage",
      description: "storage word",
      params: [{ name: "slot", required: true, schema: { $ref: "#/components/schemas/Quantity" } }],
      result: { name: "word", schema: { $ref: "#/components/schemas/Tree" } },
    },
    {
      name: "net.version",
      description: "network id",
      deprecated: true,
      params: [],
      result: { name: "v", schema: { type: "string" } },
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
    { name: "eth", params: [], result: { name: "r", schema: {} } },
  ],
  components: {
    schemas: {
      Quantity: { type: "string", pattern: "^0x[0-9a-f]+$" },
      Tree: { type: "object", properties: { next: { $ref: "#/components/schemas/Tree" } } },
    },
    contentDescriptors: {
      Address: { name: "address", required: true, schema: { type: "string", minLength: 3 } },
    },
    errors: { NotFound: { code: -32001, message: "not found" } },
    tags: { state: { name: "state", description: "chain state" } },
  },
};

const roundTrip = (d: unknown) => {
  const imported = fromOpenRpcDocument(d);
  const lowered = lower(imported.api);
  const out = toOpenRpc(lowered.tree, { schemas: jsonRpcSchemas(lowered) });
  return { imported, out, again: fromOpenRpcDocument(out) };
};

describe("toOpenRpc: from-openrpc -> lower -> toOpenRpc", () => {
  const { imported, out, again } = roundTrip(doc);
  const method = (name: string) => out.methods.find((m) => m.name === name)!;

  it("re-importing the emitted document gives back the same api description, apart from the by-name paramStructure the server implies", () => {
    const stripped = structuredClone(again.api);
    for (const o of stripped.operations) {
      const meta = o.meta.openrpc as Record<string, unknown> | undefined;
      if (meta?.paramStructure === "by-name") delete meta.paramStructure;
    }
    expect(stripped).toEqual(imported.api);
  });

  it("keeps every method name, including one that prefixes another", () => {
    expect(out.methods.map((m) => m.name).sort()).toEqual(doc.methods.map((m) => m.name).sort());
  });

  it("root info, servers and extensions come back; explicit options win", () => {
    expect(out.openrpc).toBe("1.3.2");
    expect(out.info).toMatchObject({ title: "Chain", version: "0.9.0", license: { name: "MIT" } });
    expect(out.servers).toEqual(doc.servers);
    expect(out["x-team"]).toBe("core");
    const lowered = lower(imported.api);
    const over = toOpenRpc(lowered.tree, { title: "T", version: "2" });
    expect(over.info).toMatchObject({ title: "T", version: "2" });
  });

  it("params: order, required, descriptions; paramStructure by-name unless kept", () => {
    const m = method("eth.getBalance");
    expect(m.params.map((p) => p.name)).toEqual(["address", "block"]);
    expect(m.params[0]!.required).toBe(true);
    expect(m.params[1]!.required).toBeUndefined();
    expect(m.params[1]!.description).toBe("block tag");
    expect(m.paramStructure).toBe("by-name");
    expect(method("positional").paramStructure).toBe("by-position");
  });

  it("shared defs live once under components.schemas and refs point there", () => {
    expect(Object.keys(out.components!.schemas).sort()).toEqual(["Quantity", "Tree"]);
    expect(method("eth.getBalance").result!.schema).toEqual({
      $ref: "#/components/schemas/Quantity",
    });
    expect(method("eth.getStorage").params[0]!.schema).toEqual({
      $ref: "#/components/schemas/Quantity",
    });
    expect(JSON.stringify(out)).not.toContain("$defs");
    expect(out.components!.schemas.Tree).toMatchObject({
      properties: { next: { $ref: "#/components/schemas/Tree" } },
    });
  });

  it("deprecated, description-from-summary and verbatim meta.openrpc", () => {
    expect(method("net.version").deprecated).toBe(true);
    const m = method("eth.getBalance");
    expect(m.summary).toBe("balance of an address");
    expect(m.description).toBeUndefined();
    expect(m.tags).toEqual([{ name: "accounts" }, { name: "state", description: "chain state" }]);
    expect(m.errors).toEqual([{ code: -32001, message: "not found" }]);
    expect(m["x-cost"]).toBe(3);
    expect(m.examples).toBeDefined();
    expect(method("eth.getStorage").description).toBe("storage word");
    expect(method("eth.blockNumber" as string)).toBeUndefined();
  });

  it("a notification has no result; a method with a result keeps its name", () => {
    expect(method("notify").result).toBeUndefined();
    expect(method("eth.getBalance").result!.name).toBe("balance");
  });
});

describe("toOpenRpc: trees not from an importer", () => {
  it("description falls back through meta, never the tree key", () => {
    const tree = api_({
      a: op((_: unknown) => 1, { description: "from meta" }),
      b: op((_: unknown) => 1),
    });
    const out = toOpenRpc(tree);
    expect(out.methods.find((m) => m.name === "a")!.description).toBe("from meta");
    expect(out.methods.find((m) => m.name === "b")!.description).toBeUndefined();
    expect(out.info).toEqual({ title: "API", version: "0.1.0" });
    expect(out.components).toBeUndefined();
  });

  it("missing schemas degrade to no params and an unconstrained result", () => {
    const m = toOpenRpc(api_({ ping: op((_: unknown) => 1) })).methods[0]!;
    expect(m.params).toEqual([]);
    expect(m.result).toEqual({ name: "result", schema: {} });
  });

  it("errorDataSchema becomes x-error-data-schema, its defs hoisted", () => {
    const tree = api_({
      a: op((_: unknown) => 1, {
        jsonrpc: {
          errorDataSchema: { $ref: "#/$defs/E", $defs: { E: { type: "string" } } },
        },
      }),
    });
    const out = toOpenRpc(tree);
    expect(out.methods[0]!["x-error-data-schema"]).toEqual({ $ref: "#/components/schemas/E" });
    expect(out.components!.schemas.E).toEqual({ type: "string" });
  });

  it("same-named defs that differ are kept apart; identical ones dedupe", () => {
    const schemas: SchemaMap = {
      a: { paramsSchema: { type: "object", $defs: { T: { type: "string" } } } },
      b: { paramsSchema: { type: "object", $defs: { T: { type: "string" } } } },
      c: {
        paramsSchema: {
          type: "object",
          properties: { x: { $ref: "#/$defs/T" } },
          $defs: { T: { type: "integer" }, U: { $ref: "#/$defs/T" } },
        },
      },
    };
    const tree = api_({
      a: op((_: unknown) => 1),
      b: op((_: unknown) => 1),
      c: op((_: unknown) => 1),
    });
    const out = toOpenRpc(tree, { schemas });
    expect(out.components!.schemas).toEqual({
      T: { type: "string" },
      T_2: { type: "integer" },
      U: { $ref: "#/components/schemas/T_2" },
    });
    expect(out.methods.find((m) => m.name === "c")!.params[0]!.schema).toEqual({
      $ref: "#/components/schemas/T_2",
    });
  });

  it("enum and default data that look like refs are left alone", () => {
    const schemas: SchemaMap = {
      a: {
        paramsSchema: {
          type: "object",
          properties: { x: { enum: [{ $ref: "#/$defs/T" }] } },
          $defs: { T: {} },
        },
      },
    };
    const out = toOpenRpc(api_({ a: op((_: unknown) => 1) }), { schemas });
    expect(out.methods[0]!.params[0]!.schema).toEqual({ enum: [{ $ref: "#/$defs/T" }] });
  });
});
