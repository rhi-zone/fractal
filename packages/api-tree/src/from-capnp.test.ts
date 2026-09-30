import { describe, expect, test } from "bun:test";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector/project";
import { renderCapnp, toCapnpInterface } from "@rhi-zone/fractal-type-ir/capnp";
import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir";
import { addressKey, type Imported, type Operation } from "./api-description.ts";
import { fromCapnpSchema } from "./from-capnp.ts";
import { lower, nameKeys, schemaMap, typeRefMap } from "./lower.ts";

const source = `
  @0xdbb9ad1f14bf0b36;

  struct Entry {
    key @0 :Text;
    value @1 :Data;
  }

  enum Mode { fast @0; safe @1; }

  # A key-value store.
  interface Store @0xabcdef0123456789 {
    # Fetch a value.
    get @0 (key :Text, mode :Mode = fast) -> (entry :Entry, found :Bool);
    put @1 (entry :Entry);
    clear @2 () -> ();
    scan @3 ScanParams -> ScanResults;
    tail @4 (prefix :Text) -> stream;

    struct ScanParams { prefix @0 :Text; limit @1 :UInt32 = 10; }
    struct ScanResults { entries @0 :List(Entry); }
  }
`;

const byKey = (imported: Imported): Record<string, Operation> =>
  Object.fromEntries(imported.api.operations.map((op) => [addressKey(op.address), op]));

const fieldsOf = (ref: TypeRef): Record<string, TypeRef> =>
  (ref.shape as { fields: Record<string, TypeRef> }).fields;

describe("fromCapnpSchema: interfaces", () => {
  const imported = fromCapnpSchema(source);
  const ops = byKey(imported);

  test("each method is an operation addressed [Interface, method]", () => {
    expect(Object.keys(ops)).toEqual([
      "Store/get",
      "Store/put",
      "Store/clear",
      "Store/scan",
      "Store/tail",
    ]);
    expect(ops["Store/get"]!.address).toEqual([
      { kind: "static", name: "Store" },
      { kind: "static", name: "get" },
    ]);
  });

  test("the interface is a group carrying its description and ids; the file id is on the root", () => {
    expect(imported.api.groups).toEqual([
      { address: [], meta: { capnp: { id: "0xdbb9ad1f14bf0b36" } } },
      {
        address: [{ kind: "static", name: "Store" }],
        meta: {
          capnp: { kind: "interface", id: "0xabcdef0123456789" },
          description: "A key-value store.",
        },
      },
    ]);
  });

  test("params list -> named-params object with ordinals, defaults and refs into defs", () => {
    const get = ops["Store/get"]!;
    expect(get.input.shape.kind).toBe("object");
    const fields = fieldsOf(get.input);
    expect(Object.keys(fields)).toEqual(["key", "mode"]);
    expect(fields.key!.shape.kind).toBe("string");
    expect(fields.key!.meta.ordinal).toBe(0);
    expect(fields.mode!.shape).toEqual({ kind: "ref", target: "Mode" });
    expect(fields.mode!.meta).toMatchObject({ ordinal: 1, default: "fast", optional: true });
    expect(fields.key!.meta.optional).toBeUndefined();
  });

  test("results list -> object of the named results; empty results -> void", () => {
    const out = ops["Store/get"]!.output!;
    expect(Object.keys(fieldsOf(out))).toEqual(["entry", "found"]);
    expect(fieldsOf(out).entry!.shape).toEqual({ kind: "ref", target: "Entry" });
    expect(ops["Store/clear"]!.output!.shape.kind).toBe("void");
    expect(ops["Store/put"]!.output!.shape.kind).toBe("void");
    expect(Object.keys(fieldsOf(ops["Store/clear"]!.input))).toEqual([]);
  });

  test("params/results naming a struct take that struct's fields", () => {
    const scan = ops["Store/scan"]!;
    expect(Object.keys(fieldsOf(scan.input))).toEqual(["prefix", "limit"]);
    expect(Object.keys(fieldsOf(scan.output!))).toEqual(["entries"]);
    expect(scan.meta.capnp).toMatchObject({
      interface: "Store",
      ordinal: 3,
      paramsType: "Store.ScanParams",
      resultsType: "Store.ScanResults",
    });
  });

  test("ordinals and the interface name live under meta.capnp; description is the flat key", () => {
    expect(ops["Store/get"]!.meta).toEqual({
      capnp: { interface: "Store", ordinal: 0 },
      description: "Fetch a value.",
    });
  });

  test("structs and enums (top-level and nested) are defs", () => {
    expect(Object.keys(imported.api.defs).sort()).toEqual([
      "Entry",
      "Mode",
      "Store.ScanParams",
      "Store.ScanResults",
    ]);
    expect(imported.api.defs.Mode!.shape.kind).toBe("enum");
  });

  test("`-> stream` is void, kept as meta.capnp.stream, and diagnosed", () => {
    const tail = ops["Store/tail"]!;
    expect(tail.output!.shape.kind).toBe("void");
    expect(tail.meta.capnp).toMatchObject({ stream: true });
    expect(
      imported.diagnostics.some((d) => d.at === "Store.tail" && d.message.includes("stream")),
    ).toBe(true);
  });

  test("the only diagnostic for this schema is the stream method", () => {
    expect(imported.diagnostics.map((d) => d.at)).toEqual(["Store.tail"]);
  });

  test("the result is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported))).toEqual(imported);
  });
});

describe("fromCapnpSchema: what does not map", () => {
  test("capabilities: unknown tagged with the interface, diagnosed", () => {
    const { api, diagnostics } = fromCapnpSchema(`
      interface Callback { call @0 (); }
      interface Service {
        subscribe @0 (cb :Callback) -> (handle :Callback);
      }
    `);
    const op = api.operations.find((o) => addressKey(o.address) === "Service/subscribe")!;
    const cb = fieldsOf(op.input).cb!;
    expect(cb.shape.kind).toBe("unknown");
    expect(cb.meta.capnpInterface).toBe("Callback");
    expect(fieldsOf(op.output!).handle!.meta.capnpInterface).toBe("Callback");
    expect(diagnostics.filter((d) => d.message.startsWith("capability")).map((d) => d.at)).toEqual([
      "Service.subscribe",
    ]);
  });

  test("extends is recorded on the group and diagnosed, not expanded", () => {
    const { api, diagnostics } = fromCapnpSchema(`
      interface Base { ping @0 (); }
      interface Derived extends(Base) { extra @0 (); }
    `);
    expect(api.operations.map((o) => addressKey(o.address))).toEqual([
      "Base/ping",
      "Derived/extra",
    ]);
    const group = api.groups.find((g) => addressKey(g.address) === "Derived")!;
    expect((group.meta.capnp as { extends: string[] }).extends).toEqual(["Base"]);
    expect(diagnostics.map((d) => d.at)).toEqual(["Derived"]);
  });

  test("generics: parameters become unknown, arguments stay in meta, both diagnosed", () => {
    const { api, diagnostics } = fromCapnpSchema(`
      struct Box(T) { value @0 :T; }
      interface Vault(K) {
        open @0 [V] (key :K, into :V) -> (box :Box(Text));
      }
    `);
    const open = api.operations[0]!;
    expect(fieldsOf(open.input).key!.shape.kind).toBe("unknown");
    expect(fieldsOf(open.input).key!.meta.capnpTypeParam).toBe("K");
    expect(fieldsOf(open.input).into!.meta.capnpTypeParam).toBe("V");
    expect(open.meta.capnp).toMatchObject({ typeParams: ["V"] });
    const box = fieldsOf(open.output!).box!;
    expect(box.shape).toEqual({ kind: "ref", target: "Box" });
    expect((box.meta.typeArgs as TypeRef[])[0]!.shape.kind).toBe("string");
    const ats = diagnostics.map((d) => d.at);
    expect(ats).toContain("Box");
    expect(ats).toContain("Vault");
    expect(ats).toContain("Vault.open");
  });

  test("nested interfaces address under their parents", () => {
    const { api } = fromCapnpSchema(`
      interface Outer {
        interface Inner { ping @0 (); }
        make @0 () -> (inner :Inner);
      }
    `);
    expect(api.operations.map((o) => addressKey(o.address))).toEqual([
      "Outer/make",
      "Outer/Inner/ping",
    ]);
    expect(api.groups.map((g) => addressKey(g.address))).toEqual(["Outer", "Outer/Inner"]);
    expect(lower(api).tree.children!.Outer!.children!.Inner!.children!.ping).toBeDefined();
  });

  test("a method named like a nested interface is skipped with a diagnostic", () => {
    const { api, diagnostics } = fromCapnpSchema(`
      interface Outer {
        interface Inner { ping @0 (); }
        Inner @0 ();
      }
    `);
    expect(api.operations.map((o) => addressKey(o.address))).toEqual(["Outer/Inner/ping"]);
    expect(diagnostics.map((d) => d.at)).toEqual(["Outer.Inner"]);
    expect(() => lower(api)).not.toThrow();
  });

  test("names that resolve to no def are diagnosed, params naming a non-struct give an empty input", () => {
    const { api, diagnostics } = fromCapnpSchema(`
      using Other = import "other.capnp";
      interface S {
        a @0 (x :Other.Thing);
        b @1 Other.Params -> Other.Results;
      }
    `);
    const [a, b] = api.operations;
    expect(fieldsOf(a!.input).x!.shape).toEqual({ kind: "ref", target: "Other.Thing" });
    expect(Object.keys(fieldsOf(b!.input))).toEqual([]);
    expect(b!.output).toBeUndefined();
    const messages = diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(messages.some((m) => m.startsWith('schema: using "Other"'))).toBe(true);
    expect(messages.some((m) => m.startsWith("S.a:") && m.includes('"Other.Thing"'))).toBe(true);
    expect(messages.some((m) => m.startsWith("S.b:") && m.includes("not a struct"))).toBe(true);
  });

  test("a malformed method is reported and the rest of the document still imports", () => {
    const { api, diagnostics } = fromCapnpSchema(`
      interface S {
        good @0 (a :Int32);
        broken @1 (a Int32);
        other @2 ();
      }
      struct Bad { x @0 Int32; }
      struct Fine { y @0 :Int32; }
    `);
    expect(api.operations.map((o) => addressKey(o.address))).toEqual(["S/good", "S/other"]);
    expect(Object.keys(api.defs)).toEqual(["Fine"]);
    expect(diagnostics.filter((d) => d.at === "schema")).toHaveLength(2);
  });

  test("an interface-level const is reported", () => {
    const { diagnostics } = fromCapnpSchema(`interface S { const limit :Int32 = 3; ping @0 (); }`);
    expect(diagnostics.map((d) => [d.at, d.message.split(" (")[0]])).toEqual([
      ["S", 'const "limit"'],
    ]);
  });
});

describe("fromCapnpSchema: consumed by the rest of fractal", () => {
  const { api } = fromCapnpSchema(source);
  const lowered = lower(api);

  test("lower() yields Interface > method, with types keyed by name", () => {
    expect(Object.keys(lowered.tree.children!.Store!.children!)).toEqual([
      "get",
      "put",
      "clear",
      "scan",
      "tail",
    ]);
    expect(Object.keys(typeRefMap(lowered, nameKeys)).sort()).toEqual([
      "Store_clear",
      "Store_get",
      "Store_put",
      "Store_scan",
      "Store_tail",
    ]);
  });

  test("schemaMap resolves refs against defs", () => {
    const schemas = schemaMap(lowered, nameKeys);
    const input = schemas.Store_get!.inputSchema as {
      properties: Record<string, unknown>;
      $defs: Record<string, unknown>;
    };
    expect(Object.keys(input.properties)).toEqual(["key", "mode"]);
    expect(Object.keys(input.$defs)).toEqual(["Mode"]);
    expect(schemas.Store_get!.description).toBe("Fetch a value.");
  });

  test("the MCP projector lists each method as a tool", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "Store_clear",
      "Store_get",
      "Store_put",
      "Store_scan",
      "Store_tail",
    ]);
    const get = tools.find((tool) => tool.name === "Store_get")!;
    expect(get.description).toBe("Fetch a value.");
    expect((get.inputSchema as { properties: object }).properties).toHaveProperty("mode");
  });

  test("interfaces rendered by type-ir's Cap'n Proto projector import back as operations", () => {
    const iface = toCapnpInterface(
      "Account",
      t(
        types.interface({
          deposit: t(types.method([{ name: "amount", type: t(types.number) }], t(types.void))),
          balance: t(types.method([], t(types.number))),
        }),
      ),
    );
    const { api: back, diagnostics } = fromCapnpSchema(renderCapnp([], "0xabc123", [iface]));
    expect(diagnostics).toEqual([]);
    const ops = byKey({ api: back, diagnostics });
    expect(Object.keys(fieldsOf(ops["Account/deposit"]!.input))).toEqual(["amount"]);
    expect(ops["Account/deposit"]!.output!.shape.kind).toBe("void");
    expect(Object.keys(fieldsOf(ops["Account/balance"]!.output!))).toEqual(["result"]);
  });
});
