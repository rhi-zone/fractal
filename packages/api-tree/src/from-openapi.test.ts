import { describe, expect, test } from "bun:test";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { toSDL } from "@rhi-zone/fractal-graphql-api-projector";
import { fromOpenApiDocument } from "./from-openapi.ts";
import { flatMapOperations, patchOperations } from "./api-description.ts";
import {
  lower,
  nameKeys,
  routeKeys,
  schemaMap,
  typeRefMap,
  UnboundOperationError,
} from "./lower.ts";
import type { Node } from "./node.ts";

const petstore = {
  openapi: "3.0.3",
  info: { title: "Pets", version: "1.2.3", description: "a pet store" },
  security: [{ key: [] }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        tags: ["pets"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", format: "int32" } },
          { name: "X-Trace", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
          default: { description: "error" },
        },
      },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } },
        },
        responses: { "201": { description: "created" } },
        "x-fern-availability": "beta",
      },
    },
    "/pets/{petId}": {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "showPet",
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
      delete: {
        operationId: "deletePet",
        deprecated: true,
        responses: { "204": { description: "gone" } },
      },
    },
    "/pets/{id}/photo.{ext}": { get: { responses: { "200": { description: "x" } } } },
  },
  components: {
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } },
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          owner: { $ref: "#/components/schemas/Pet" },
        },
      },
      NewPet: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, tag: { type: "string" } },
      },
    },
  },
};

function leafAt(tree: Node, path: readonly string[]): Node {
  let cur: Node = tree;
  for (const seg of path) {
    const next = seg.startsWith(":") ? cur.fallback?.subtree : cur.children?.[seg];
    if (next === undefined) throw new Error(`no node at ${path.join("/")}`);
    cur = next;
  }
  return cur;
}

describe("fromOpenApiDocument", () => {
  const imported = fromOpenApiDocument(petstore);

  test("addresses mirror the URL path with the method as the operation key", () => {
    const addrs = imported.api.operations.map((o) =>
      o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/"),
    );
    expect(addrs).toEqual(["pets/get", "pets/post", "pets/{petId}/get", "pets/{petId}/delete"]);
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });

  test("params and body properties become one named-params input with a sourceMap", () => {
    const list = imported.api.operations[0]!;
    expect(Object.keys((list.input.shape as { fields: object }).fields)).toEqual([
      "limit",
      "X-Trace",
    ]);
    expect((list.meta.http as { sourceMap: unknown }).sourceMap).toEqual({
      limit: { store: "query" },
      "X-Trace": { store: "header" },
    });
    const create = imported.api.operations[1]!;
    const fields = (
      create.input.shape as { fields: Record<string, { meta: Record<string, unknown> }> }
    ).fields;
    expect(Object.keys(fields)).toEqual(["name", "tag"]);
    expect(fields.name!.meta.optional).toBeUndefined();
    expect(fields.tag!.meta.optional).toBe(true);
  });

  test("method semantics, deprecation and vendor extensions land in meta", () => {
    const [list, create, , del] = imported.api.operations;
    expect(list!.meta.tags).toEqual({ readOnly: true, idempotent: true });
    expect(create!.meta.tags).toEqual({});
    expect(del!.meta.tags).toEqual({ idempotent: true, deprecated: true });
    expect((create!.meta.openapi as Record<string, unknown>)["x-fern-availability"]).toBe("beta");
    expect(list!.meta.description).toBe("List pets");
  });

  test("outputs: first 2xx schema, void for an empty 2xx", () => {
    const [list, create] = imported.api.operations;
    expect(list!.output!.shape.kind).toBe("array");
    expect(create!.output!.shape.kind).toBe("void");
  });

  test("unrepresentable parts are reported, not dropped silently", () => {
    const messages = imported.diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(messages.some((m) => m.includes("photo.{ext}") && m.includes("skipped"))).toBe(true);
    expect(messages.some((m) => m.includes("non-2xx"))).toBe(true);
  });

  test("document info and security come back for the out side", () => {
    expect(imported.info).toEqual({ title: "Pets", version: "1.2.3" });
    expect(imported.defaultSecurity).toEqual([{ key: [] }]);
  });
});

describe("lower + projectors", () => {
  const imported = fromOpenApiDocument(petstore);
  const lowered = lower(imported.api);

  test("unbound operations throw a typed error", () => {
    const leaf = leafAt(lowered.tree, ["pets", "get"]);
    expect(() => leaf.handler!({})).toThrow(UnboundOperationError);
  });

  test("openapi out reproduces paths, methods and operationIds", async () => {
    const doc = await toOpenApi(lowered.tree, {
      schemas: schemaMap(lowered, routeKeys),
      title: imported.info.title!,
      version: imported.info.version!,
      defaultSecurity: [...imported.defaultSecurity!],
    });
    const ops = Object.entries(doc.paths).flatMap(([p, ms]) =>
      Object.entries(ms).map(([m, o]) => `${m.toUpperCase()} ${p} ${o.operationId}`),
    );
    expect(ops.sort()).toEqual(
      [
        "GET /pets listPets",
        "POST /pets createPet",
        "GET /pets/{petId} showPet",
        "DELETE /pets/{petId} deletePet",
      ].sort(),
    );
    expect(doc.paths["/pets/{petId}"]!.delete!.deprecated).toBe(true);
    expect(doc.components?.securitySchemes).toEqual(petstore.components.securitySchemes);
    const show = doc.paths["/pets/{petId}"]!.get!;
    const schema = (
      show.responses["200"] as { content: Record<string, { schema: Record<string, unknown> }> }
    ).content["application/json"]!.schema;
    expect(schema.$ref).toBe("#/$defs/Pet");
    expect(Object.keys(schema.$defs as object)).toEqual(["Pet"]);
  });

  test("mcp tools carry the imported schemas and method-derived hints", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "pets_get",
      "pets_petId_delete",
      "pets_petId_get",
      "pets_post",
    ]);
    expect((byName.pets_get!.inputSchema as { properties: object }).properties).toHaveProperty(
      "limit",
    );
    expect(byName.pets_get!.annotations?.readOnlyHint).toBe(true);
  });

  test("graphql picks query vs mutation from the same tags", () => {
    const sdl = toSDL(lowered.tree, {
      types: typeRefMap(lowered, nameKeys),
      namedTypes: lowered.defs,
    });
    const mutation = /type Mutation \{([^}]*)\}/.exec(sdl)?.[1] ?? "";
    expect(mutation).toContain("petsPost(name: String!, tag: String)");
    expect(mutation).not.toContain("petsGet");
  });

  test("types follow handlers through a Node => Node transform", () => {
    const moved: Node = { meta: {}, children: { v1: lowered.tree } };
    expect(Object.keys(schemaMap(lowered, routeKeys, moved)).sort()).toEqual(
      ["v1/pets/get", "v1/pets/post", "v1/pets/:petId/get", "v1/pets/:petId/delete"].sort(),
    );
  });
});

describe("transforms", () => {
  const { api } = fromOpenApiDocument(petstore);

  test("aliasing exposes one operation at a second address", () => {
    const aliased = flatMapOperations(api, (op) =>
      op.meta.openapi && (op.meta.openapi as { operationId?: string }).operationId === "listPets"
        ? [
            op,
            {
              ...op,
              address: [{ kind: "static", name: "ls" }],
              meta: { ...op.meta, http: undefined },
            },
          ]
        : op,
    );
    const lowered = lower(aliased);
    expect(leafAt(lowered.tree, ["ls"]).handler).toBeDefined();
    expect(leafAt(lowered.tree, ["pets", "get"]).handler).toBeDefined();
  });

  test("dropping and patching are ordinary functions over the description", () => {
    const hidden = patchOperations(
      api,
      (op) =>
        op.meta.tags !== undefined &&
        (op.meta.tags as { deprecated?: boolean }).deprecated === true,
      {
        cli: { hidden: true },
      },
    );
    const del = hidden.operations.find(
      (o) => (o.meta.openapi as { operationId?: string }).operationId === "deletePet",
    )!;
    expect(del.meta.cli).toEqual({ hidden: true });
    const dropped = flatMapOperations(api, (op) =>
      (op.meta.tags as { deprecated?: boolean }).deprecated ? [] : op,
    );
    expect(dropped.operations).toHaveLength(3);
  });

  test("a param bound under two names at one position is rejected by lower", () => {
    expect(() =>
      lower({
        operations: [
          {
            address: [
              { kind: "param", name: "a" },
              { kind: "static", name: "x" },
            ],
            input: api.operations[0]!.input,
            meta: {},
          },
          {
            address: [
              { kind: "param", name: "b" },
              { kind: "static", name: "y" },
            ],
            input: api.operations[0]!.input,
            meta: {},
          },
        ],
        groups: [],
        defs: {},
      }),
    ).toThrow(/names a param/);
  });
});

describe("swagger 2.0 and openapi 3.1", () => {
  test("swagger 2.0 body parameter and definitions", () => {
    const { api, version } = fromOpenApiDocument({
      swagger: "2.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users/{id}": {
          put: {
            parameters: [
              { name: "id", in: "path", required: true, type: "integer" },
              { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/User" } },
            ],
            responses: { "200": { description: "ok", schema: { $ref: "#/definitions/User" } } },
          },
        },
      },
      definitions: {
        User: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    });
    expect(version).toBe("2.0");
    const op = api.operations[0]!;
    expect(Object.keys((op.input.shape as { fields: object }).fields)).toEqual(["id", "name"]);
    expect(op.output!.shape).toEqual({ kind: "ref", target: "User" });
    expect(api.defs.User).toBeDefined();
  });

  test("openapi 3.1 type arrays go through the json schema ingester", () => {
    const { api, version } = fromOpenApiDocument({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/n": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: ["string", "null"] } } },
              },
            },
          },
        },
      },
    });
    expect(version).toBe("3.1");
    expect(api.operations[0]!.output!.meta.nullable).toBe(true);
  });
});
