import { describe, expect, test } from "bun:test";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { addressKey, type Imported } from "./api-description.ts";
import { fromTypeSpecSource } from "./from-typespec.ts";
import { lower, nameKeys, routeKeys, schemaMap } from "./lower.ts";

type Obj = Record<string, any>;

const HEADER = `import "@typespec/http";\nusing TypeSpec.Http;\n`;

const compilerDiagnostics = (i: Imported) =>
  i.diagnostics.filter((d) => /^(error|warning) /.test(d.message));

const opAt = (i: Imported, address: string) => {
  const found = i.api.operations.find((o) => addressKey(o.address) === address);
  if (found === undefined) throw new Error(`no operation at ${address}`);
  return found as { input: any; output?: any; meta: Obj; address: any[] };
};

// A service with types of every kind, http bindings that do not mirror the
// address, and a plain (no http) operation.
const petStore = await fromTypeSpecSource(`${HEADER}
@service(#{ title: "Pet Store" })
@doc("Pets and their owners.")
namespace Pets;

/** An email address. */
@pattern("^.+@.+$") scalar Email extends string;
enum Kind { dog, cat }
enum Level { low: 1, high: 2 }
model Circle { r: float64 }
model Square { side: float64 }
union Shape { circle: Circle, square: Square }

/** A pet. */
model Pet {
  id: int32;
  @doc("What to call it.") @minLength(1) @maxLength(40) name: string;
  tag?: string = "none";
  kind: Kind;
  owner?: Email;
  @encodedName("application/json", "born") birthday: utcDateTime;
  tags: string[];
  attrs: Record<string>;
  parent?: Pet;
}
model Dog extends Pet { breed: string }
model Page<T> { items: T[]; next?: string }
@error model NotFound { code: 404; message: string }

@route("/pets")
interface PetOps {
  /** List pets. */
  @get list(@query limit?: int32, @header("x-request-id") requestId?: string): Page<Pet>;

  @summary("Fetch one pet")
  @get @route("{id}") read(@path id: int32): Pet | NotFound;

  #deprecated "use adopt"
  @post create(name: string, @encodedName("application/json", "nick") nickname?: string): { @statusCode _: 201; @body pet: Pet };

  @put replace(@body pet: Pet): void;
  @delete @route("{id}") remove(@path id: int32): void;
}
`);

const mirrored = await fromTypeSpecSource(`${HEADER}
@route("/pets")
namespace pets {
@get op list(@query limit?: int32, @header("x-request-id") requestId?: string): string[];
@post @route("/") op create(name: string, @encodedName("application/json", "nick") nickname?: string, @header contentType: "application/json"): void;
}
namespace other {
@route("/elsewhere") @get op ping(): void;
}
`);

const plain = await fromTypeSpecSource(`
model Pet { id: int32 }
@error model Oops { message: string }
/** Things. */
interface Things {
get(id: int32): Pet | Oops;
@doc("Ping.") ping(): void;
}
`);

const lowerSource = await fromTypeSpecSource(`${HEADER}
@service(#{ title: "Pet Store" })
@route("/pets")
namespace pets {
/** List pets. */
@get op list(@query limit?: int32): Pet[];
@post @route("/") op create(name: string): Pet;
@get @route("/ping") op ping(): void;
}
model Pet { id: int32; name: string }
`);

describe("fromTypeSpecSource: operations", () => {
  const { api } = petStore;

  test("the source compiles cleanly", () => {
    expect(compilerDiagnostics(petStore)).toEqual([]);
  });

  test("addresses are the namespace and interface path plus the operation name", () => {
    expect(api.operations.map((o) => addressKey(o.address)).sort()).toEqual([
      "Pets/PetOps/create",
      "Pets/PetOps/list",
      "Pets/PetOps/read",
      "Pets/PetOps/remove",
      "Pets/PetOps/replace",
    ]);
  });

  test("service namespace docs and title become group meta", () => {
    expect(api.groups).toEqual([
      {
        address: [{ kind: "static", name: "Pets" }],
        meta: {
          description: "Pets and their owners.",
          typespec: { service: { title: "Pet Store" } },
        },
      },
    ]);
  });

  test("parameters are the named-params input, with optionality", () => {
    const list = opAt(petStore, "Pets/PetOps/list");
    expect(Object.keys(list.input.shape.fields)).toEqual(["limit", "requestId"]);
    expect(list.input.shape.fields.limit).toEqual({
      shape: { kind: "int32" },
      meta: { optional: true },
    });
    expect(opAt(petStore, "Pets/PetOps/read").input.shape.fields.id.shape).toEqual({
      kind: "int32",
    });
  });

  test("output is the success response body", () => {
    expect(opAt(petStore, "Pets/PetOps/list").output.shape).toEqual({
      kind: "ref",
      target: "Page_Pet",
    });
    expect(opAt(petStore, "Pets/PetOps/read").output.shape).toEqual({
      kind: "ref",
      target: "Pet",
    });
    expect(opAt(petStore, "Pets/PetOps/create").output.shape).toEqual({
      kind: "ref",
      target: "Pet",
    });
    expect(opAt(petStore, "Pets/PetOps/replace").output.shape).toEqual({ kind: "void" });
  });

  test("@doc, @summary, #deprecated and verbs become description and tags", () => {
    expect(opAt(petStore, "Pets/PetOps/list").meta.description).toBe("List pets.");
    expect(opAt(petStore, "Pets/PetOps/read").meta.description).toBe("Fetch one pet");
    expect(opAt(petStore, "Pets/PetOps/list").meta.tags).toEqual({
      readOnly: true,
      idempotent: true,
    });
    expect(opAt(petStore, "Pets/PetOps/remove").meta.tags).toEqual({ idempotent: true });
    expect(opAt(petStore, "Pets/PetOps/create").meta.tags).toEqual({ deprecated: true });
    expect(opAt(petStore, "Pets/PetOps/create").meta.typespec.deprecated).toBe("use adopt");
  });

  test("a non-200 success status is kept", () => {
    expect(opAt(petStore, "Pets/PetOps/create").meta.typespec.successStatus).toBe(201);
  });

  test("error variants are kept under meta.typespec with a diagnostic", () => {
    const read = opAt(petStore, "Pets/PetOps/read");
    expect(read.meta.typespec.errors).toEqual([
      { status: "*", type: { shape: { kind: "ref", target: "NotFound" }, meta: {} } },
    ]);
    expect(
      petStore.diagnostics.some((d) => d.at === "Pets.PetOps.read" && d.message.includes("errors")),
    ).toBe(true);
  });

  test("the result is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(petStore.api))).toEqual(petStore.api);
  });
});

describe("fromTypeSpecSource: types", () => {
  const { defs } = petStore.api;

  test("named types become defs, template instances are keyed by their arguments", () => {
    expect(Object.keys(defs).sort()).toEqual(
      [
        "Circle",
        "Dog",
        "Email",
        "Kind",
        "Level",
        "NotFound",
        "Page_Pet",
        "Pet",
        "Shape",
        "Square",
      ].sort(),
    );
    expect(defs.Page_Pet!.shape).toMatchObject({
      kind: "object",
      fields: {
        items: { shape: { kind: "array", element: { shape: { kind: "ref", target: "Pet" } } } },
      },
    });
  });

  test("fields keep optionality, defaults, refinements, docs and JSON names", () => {
    const fields = (defs.Pet!.shape as any).fields as Obj;
    expect(fields.name.meta).toEqual({
      description: "What to call it.",
      minLength: 1,
      maxLength: 40,
    });
    expect(fields.tag.meta).toEqual({ optional: true, default: "none" });
    expect(fields.birthday).toEqual({ shape: { kind: "datetime" }, meta: { jsonName: "born" } });
    expect(fields.attrs.shape.kind).toBe("map");
    expect(fields.parent.shape).toEqual({ kind: "ref", target: "Pet" });
    expect(defs.Pet!.meta.description).toBe("A pet.");
  });

  test("scalars, enums, unions and inheritance", () => {
    expect(defs.Email).toMatchObject({
      shape: { kind: "string" },
      meta: { description: "An email address.", pattern: "^.+@.+$" },
    });
    expect(defs.Kind!.shape).toEqual({ kind: "enum", members: ["dog", "cat"] });
    expect(defs.Level!.shape).toEqual({
      kind: "union",
      variants: [
        { shape: { kind: "literal", value: 1 }, meta: {} },
        { shape: { kind: "literal", value: 2 }, meta: {} },
      ],
    });
    expect((defs.Shape!.shape as any).variants.map((v: any) => v.shape.target)).toEqual([
      "Circle",
      "Square",
    ]);
    expect((defs.Dog!.shape as any).kind).toBe("intersection");
    expect((defs.Dog!.shape as any).members[0].shape).toEqual({ kind: "ref", target: "Pet" });
    expect(defs.NotFound!.meta.typespec).toMatchObject({ error: true });
  });
});

describe("fromTypeSpecSource: http", () => {
  test("a binding whose address does not mirror the route is kept verbatim", () => {
    const list = opAt(petStore, "Pets/PetOps/list");
    expect(list.meta.http).toBeUndefined();
    expect(list.meta.typespec.http).toEqual({
      method: "GET",
      path: "/pets",
      uriTemplate: "/pets{?limit}",
      bindings: {
        limit: { kind: "query" },
        requestId: { kind: "header", key: "x-request-id" },
      },
    });
    expect(
      petStore.diagnostics.some(
        (d) => d.at === "Pets.PetOps.list" && d.message.includes("does not mirror"),
      ),
    ).toBe(true);
  });

  test("an @body parameter is not an exact binding", () => {
    const replace = opAt(petStore, "Pets/PetOps/replace");
    expect(replace.meta.http).toBeUndefined();
    expect(replace.meta.typespec.http.bindings).toEqual({ pet: { kind: "body" } });
    expect(
      petStore.diagnostics.some(
        (d) => d.at === "Pets.PetOps.replace" && d.message.includes("body"),
      ),
    ).toBe(true);
  });

  test("an address that mirrors the route gets an exact binding", () => {
    expect(compilerDiagnostics(mirrored)).toEqual([]);
    expect(opAt(mirrored, "pets/list").meta.http).toEqual({
      method: "GET",
      moveTo: "..",
      sourceMap: { limit: { store: "query" }, requestId: { store: "header", key: "x-request-id" } },
    });
    expect(opAt(mirrored, "pets/create").meta.http).toEqual({
      method: "POST",
      moveTo: "..",
      sourceMap: {
        name: { store: "body" },
        nickname: { store: "body", key: "nick" },
        contentType: { store: "header", key: "Content-Type" },
      },
    });
    expect(opAt(mirrored, "pets/list").meta.typespec.http).toBeUndefined();
  });

  test("a route under a different namespace name is not exact", () => {
    const ping = opAt(mirrored, "other/ping");
    expect(ping.meta.http).toBeUndefined();
    expect(ping.meta.typespec.http.path).toBe("/elsewhere");
  });
});

describe("fromTypeSpecSource: without @typespec/http", () => {
  test("operations import without any http metadata", () => {
    expect(compilerDiagnostics(plain)).toEqual([]);
    const get = opAt(plain, "Things/get");
    expect(get.meta.http).toBeUndefined();
    expect(get.meta.typespec.http).toBeUndefined();
    expect(get.meta.tags).toBeUndefined();
    expect(plain.api.groups).toEqual([
      { address: [{ kind: "static", name: "Things" }], meta: { description: "Things." } },
    ]);
  });

  test("the return type loses its @error variants, which are kept", () => {
    const get = opAt(plain, "Things/get");
    expect(get.output.shape).toEqual({ kind: "ref", target: "Pet" });
    expect(get.meta.typespec.errors).toEqual([
      { type: { shape: { kind: "ref", target: "Oops" }, meta: {} } },
    ]);
    expect(opAt(plain, "Things/ping").output.shape).toEqual({ kind: "void" });
  });
});

describe("fromTypeSpecSource: edge cases", () => {
  test("compiler errors become diagnostics and the rest still imports", async () => {
    const r = await fromTypeSpecSource(`
model Pet { id: int32 }
op ok(): Pet;
op broken(): Missing;
`);
    expect(r.diagnostics.some((d) => d.message.startsWith("error invalid-ref"))).toBe(true);
    expect(r.diagnostics.find((d) => d.message.startsWith("error invalid-ref"))?.at).toBe(
      "main.tsp:4:14",
    );
    expect(r.api.operations.map((o) => addressKey(o.address)).sort()).toEqual(["broken", "ok"]);
    expect(opAt(r, "ok").output.shape).toEqual({ kind: "ref", target: "Pet" });
    expect(opAt(r, "broken").output.shape).toEqual({ kind: "unknown" });
  });

  test("an operation named like a sibling group falls back and is reported", async () => {
    const r = await fromTypeSpecSource(`
namespace A {
  op stuff(): void;
  namespace stuff { op inner(): void; }
}
`);
    expect(r.api.operations.map((o) => addressKey(o.address)).sort()).toEqual([
      "A/stuff/inner",
      "A/stuffOp",
    ]);
    expect(r.diagnostics.some((d) => d.message.includes('keyed "stuffOp"'))).toBe(true);
  });

  test("two types with one bare name in different namespaces get distinct defs", async () => {
    const r = await fromTypeSpecSource(`
namespace A { model Item { a: string } op get(): Item; }
namespace B { model Item { b: string } op get(): Item; }
`);
    expect(Object.keys(r.api.defs).sort()).toEqual(["B.Item", "Item"]);
    expect(opAt(r, "A/get").output.shape).toEqual({ kind: "ref", target: "Item" });
    expect(opAt(r, "B/get").output.shape).toEqual({ kind: "ref", target: "B.Item" });
  });

  test("a file set with imports compiles", async () => {
    const r = await fromTypeSpecSource({
      "main.tsp": `import "./lib/types.tsp"; op a(): Thing;`,
      "lib/types.tsp": `model Thing { n: int32 }`,
    });
    expect(compilerDiagnostics(r)).toEqual([]);
    expect(opAt(r, "a").output.shape).toEqual({ kind: "ref", target: "Thing" });
  });

  test("a file set without main.tsp and paths outside the directory are rejected", async () => {
    await expect(fromTypeSpecSource({ "other.tsp": "" })).rejects.toThrow("main.tsp");
    await expect(fromTypeSpecSource({ "main.tsp": "", "../x.tsp": "" })).rejects.toThrow("outside");
  });
});

describe("lower + projectors", () => {
  const lowered = lower(lowerSource.api);

  test("lowers to a tree with the namespace nesting", () => {
    expect(compilerDiagnostics(lowerSource)).toEqual([]);
    expect(Object.keys(lowered.tree.children!)).toEqual(["pets"]);
    expect(Object.keys(lowered.tree.children!.pets!.children!).sort()).toEqual([
      "create",
      "list",
      "ping",
    ]);
  });

  test("openapi out places the exactly-bound operations at their route", async () => {
    const doc = await toOpenApi(lowered.tree, {
      schemas: schemaMap(lowered, routeKeys),
      title: "Pets",
      version: "1",
    });
    const ops = Object.entries(doc.paths).flatMap(([p, ms]) =>
      Object.entries(ms).map(([method]) => `${method.toUpperCase()} ${p}`),
    );
    expect(ops).toContain("GET /pets");
    expect(ops).toContain("POST /pets");
  });

  test("mcp tools are named by address and carry the description", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual(["pets_create", "pets_list", "pets_ping"]);
    expect(byName.pets_list!.description).toBe("List pets.");
    expect(byName.pets_list!.annotations?.readOnlyHint).toBe(true);
  });
});
