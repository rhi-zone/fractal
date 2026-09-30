import { describe, expect, test } from "bun:test";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { fromPostmanCollection } from "./from-postman.ts";
import { lower, nameKeys, routeKeys, schemaMap, UnboundOperationError } from "./lower.ts";
import type { Node } from "./node.ts";

const json = (o: unknown): string => JSON.stringify(o);

const collection = {
  info: {
    name: "Users API",
    _postman_id: "abc",
    description: "user management",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
  variable: [{ key: "baseUrl", value: "https://api.example.com" }],
  item: [
    {
      name: "Users",
      description: "user endpoints",
      event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }],
      item: [
        {
          name: "List users",
          request: {
            method: "GET",
            header: [
              { key: "X-Trace", value: "t1" },
              { key: "Accept", value: "application/json" },
            ],
            url: {
              raw: "{{baseUrl}}/users?limit=10&ids=1&ids=2&page=3",
              host: ["{{baseUrl}}"],
              path: ["users"],
              query: [
                { key: "limit", value: "10", description: "page size" },
                { key: "ids", value: "1" },
                { key: "ids", value: "2" },
                { key: "page", value: "3", disabled: true },
              ],
            },
          },
          response: [
            {
              name: "ok",
              code: 200,
              header: [{ key: "Content-Type", value: "application/json" }],
              body: json([
                { id: 1, name: "a", email: "a@example.com" },
                { id: 2, name: "b", email: "b@example.com" },
              ]),
            },
            { name: "boom", code: 500, body: json({ error: "x" }) },
          ],
        },
        {
          name: "Get user",
          request: {
            method: "GET",
            url: {
              raw: "{{baseUrl}}/users/:id",
              host: ["{{baseUrl}}"],
              path: ["users", ":id"],
              variable: [{ key: "id", value: "42", description: "user id" }],
            },
          },
          response: [{ name: "ok", code: 200, body: json({ id: 42, name: "a", age: 30 }) }],
        },
        {
          name: "Create user",
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: {
              mode: "raw",
              raw: '{"name": "a", "age": {{age}}, "tags": ["x", "y"]}',
              options: { raw: { language: "json" } },
            },
            url: { raw: "{{baseUrl}}/users", host: ["{{baseUrl}}"], path: ["users"] },
          },
          response: [
            { name: "created", code: 201, body: json({ id: 1, name: "a" }) },
            { name: "created 2", code: 201, body: json({ id: 2, name: "b", nick: "bee" }) },
          ],
        },
        {
          name: "Create user (minimal)",
          request: {
            method: "POST",
            body: { mode: "raw", raw: '{"name": "b"}', options: { raw: { language: "json" } } },
            url: "{{baseUrl}}/users",
          },
        },
      ],
    },
    {
      name: "Members",
      auth: { type: "noauth" },
      item: [
        {
          name: "List members",
          request: { method: "GET", url: "https://other.example.com/orgs/{{orgId}}/members" },
        },
        {
          name: "Delete member",
          request: {
            method: "DELETE",
            url: { raw: "{{baseUrl}}/orgs/{{orgId}}/members/:memberId" },
          },
          response: [{ name: "gone", code: 204 }],
        },
      ],
    },
    {
      name: "Weird",
      item: [
        { name: "Photo", request: "{{baseUrl}}/photo.{{ext}}" },
        {
          name: "Search",
          request: {
            method: "POST",
            url: "{{baseUrl}}/graphql",
            body: { mode: "graphql", graphql: { query: "{ me { id } }" } },
          },
        },
        {
          name: "Upload",
          request: {
            method: "POST",
            url: "{{baseUrl}}/upload",
            body: {
              mode: "formdata",
              formdata: [
                { key: "file", type: "file", src: "a.png" },
                { key: "caption", type: "text", value: "hi" },
              ],
            },
          },
        },
      ],
    },
  ],
};

const addr = (o: { address: readonly { kind: string; name: string }[] }): string =>
  o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/");

type F = Record<string, { shape: { kind: string }; meta: Record<string, unknown> }>;
const fieldsOf = (input: { shape: unknown }): F => (input.shape as { fields: F }).fields;

describe("fromPostmanCollection", () => {
  const imported = fromPostmanCollection(collection);
  const byAddr = Object.fromEntries(imported.api.operations.map((o) => [addr(o), o]));

  test("addresses mirror the URL; folders and the base url stay out of them", () => {
    expect(Object.keys(byAddr)).toEqual([
      "users/get",
      "users/{id}/get",
      "users/post",
      "orgs/{orgId}/members/get",
      "orgs/{orgId}/members/{memberId}/delete",
      "graphql/post",
      "upload/post",
    ]);
    expect(imported.version).toBe("2.1");
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });

  test("path, query and header params, with sourceMap and optionality", () => {
    const list = byAddr["users/get"]!;
    expect(Object.keys(fieldsOf(list.input))).toEqual(["limit", "ids", "page", "X-Trace"]);
    const f = fieldsOf(list.input);
    expect(f.ids!.shape.kind).toBe("array");
    expect(f.limit!.meta.description).toBe("page size");
    expect(f.limit!.meta.optional).toBeUndefined();
    expect(f.page!.meta.optional).toBe(true);
    expect((list.meta.http as { sourceMap: unknown }).sourceMap).toEqual({
      limit: { store: "query" },
      ids: { store: "query" },
      page: { store: "query" },
      "X-Trace": { store: "header" },
    });
    const get = byAddr["users/{id}/get"]!;
    expect(fieldsOf(get.input).id!.meta.examples).toEqual(["42"]);
    expect((get.meta.http as { sourceMap: unknown }).sourceMap).toEqual({ id: { store: "path" } });
  });

  test("{{var}} path segments become params; host variables are server info", () => {
    const members = byAddr["orgs/{orgId}/members/get"]!;
    expect(Object.keys(fieldsOf(members.input))).toEqual(["orgId"]);
    const requests = members.meta.postman as { requests: { server: string }[] };
    expect(requests.requests[0]!.server).toBe("https://other.example.com");
    const root = imported.api.groups[0]!.meta.postman as { servers: string[] };
    expect(root.servers).toEqual(["{{baseUrl}}", "https://other.example.com"]);
    const messages = imported.diagnostics.map((d) => d.message);
    expect(messages.filter((m) => m.includes("{{orgId}}"))).toHaveLength(1);
  });

  test("requests at one method and url merge into one operation", () => {
    const create = byAddr["users/post"]!;
    const f = fieldsOf(create.input);
    expect(Object.keys(f)).toEqual(["name", "age", "tags"]);
    expect(f.name!.meta.optional).toBeUndefined();
    expect(f.age!.meta.optional).toBe(true);
    expect(f.tags!.meta.optional).toBe(true);
    const meta = create.meta.postman as { requests: { name: string; folder: string[] }[] };
    expect(meta.requests.map((r) => r.name)).toEqual(["Create user", "Create user (minimal)"]);
    expect(meta.requests[0]!.folder).toEqual(["Users"]);
    expect(imported.diagnostics.some((d) => d.message.includes("merged into one operation"))).toBe(
      true,
    );
  });

  test("inferred types are flagged, not narrowed, and reported", () => {
    const create = byAddr["users/post"]!;
    const f = fieldsOf(create.input);
    expect(f.name!.meta.inferred).toBe(true);
    expect(f.age!.shape.kind).not.toMatch(/^u?int\d+$/);
    expect(f.tags!.shape.kind).toBe("array");
    expect(create.output!.meta.inferred).toBe(true);
    const out = create.output!.shape as { fields: F };
    expect(out.fields.nick!.meta.optional).toBe(true);
    expect(imported.diagnostics.some((d) => d.message.includes("inferred from examples"))).toBe(
      true,
    );
  });

  test("output: lowest 2xx corpus, list inferred as array, empty 2xx is void", () => {
    expect(byAddr["users/get"]!.output!.shape.kind).toBe("array");
    expect(byAddr["orgs/{orgId}/members/{memberId}/delete"]!.output!.shape.kind).toBe("void");
    expect(byAddr["orgs/{orgId}/members/get"]!.output).toBeUndefined();
  });

  test("non-2xx responses, auth, scripts and folders are kept verbatim in meta.postman", () => {
    const list = byAddr["users/get"]!.meta.postman as {
      requests: { responses: { code: number }[]; headers: { key: string }[] }[];
    };
    expect(list.requests[0]!.responses.map((r) => r.code)).toEqual([500]);
    expect(list.requests[0]!.headers.map((h) => h.key)).toEqual(["Accept"]);
    const root = imported.api.groups[0]!;
    expect(root.meta.description).toBe("user management");
    const p = root.meta.postman as {
      auth: { type: string };
      variable: unknown[];
      folders: { path: string[]; event?: unknown; auth?: { type: string } }[];
    };
    expect(p.auth.type).toBe("bearer");
    expect(p.variable).toHaveLength(1);
    expect(p.folders.map((x) => x.path)).toEqual([["Users"], ["Members"], ["Weird"]]);
    expect(p.folders[0]!.event).toBeDefined();
    expect(p.folders[1]!.auth?.type).toBe("noauth");
    const messages = imported.diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("not represented as error types"))).toBe(true);
    expect(messages.some((m) => m.includes("scripts"))).toBe(true);
    expect(messages.some((m) => m.includes("auth on"))).toBe(true);
  });

  test("bodies that are not JSON are reported and kept verbatim", () => {
    const gql = byAddr["graphql/post"]!.meta.postman as { requests: { body: { mode: string } }[] };
    expect(gql.requests[0]!.body.mode).toBe("graphql");
    const up = byAddr["upload/post"]!;
    expect(fieldsOf(up.input).file!.shape.kind).toBe("bytes");
    expect(fieldsOf(up.input).caption!.shape.kind).toBe("string");
  });

  test("a segment mixing text and a variable is skipped with a diagnostic", () => {
    expect(
      imported.diagnostics.some(
        (d) => d.message.includes("photo.{{ext}}") && d.message.includes("skipped"),
      ),
    ).toBe(true);
  });

  test("method semantics land in tags and meta.http", () => {
    expect(byAddr["users/get"]!.meta.tags).toEqual({ readOnly: true, idempotent: true });
    expect(byAddr["users/post"]!.meta.tags).toEqual({});
    expect(byAddr["users/post"]!.meta.http).toMatchObject({ method: "POST", moveTo: ".." });
  });

  test("v2.0 collections are read the same way", () => {
    const v20 = fromPostmanCollection({
      ...collection,
      info: {
        ...collection.info,
        schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json",
      },
    });
    expect(v20.version).toBe("2.0");
    expect(v20.api.operations).toEqual(imported.api.operations);
  });

  test("v1 and non-collections are rejected", () => {
    expect(() => fromPostmanCollection({ info: { schema: "https://x/collection/v1/" } })).toThrow();
    expect(() => fromPostmanCollection({})).toThrow();
  });
});

describe("lower + projectors", () => {
  const imported = fromPostmanCollection(collection);
  const lowered = lower(imported.api);

  test("unbound operations throw a typed error", () => {
    const leaf = lowered.tree.children!.users!.children!.get!;
    expect(() => leaf.handler!({})).toThrow(UnboundOperationError);
  });

  test("openapi out reproduces the paths and methods", async () => {
    const doc = await toOpenApi(lowered.tree, {
      schemas: schemaMap(lowered, routeKeys),
      title: "Users API",
      version: "1",
    });
    const ops = Object.entries(doc.paths).flatMap(([p, ms]) =>
      Object.keys(ms).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(ops.sort()).toEqual(
      [
        "GET /users",
        "GET /users/{id}",
        "POST /users",
        "GET /orgs/{orgId}/members",
        "DELETE /orgs/{orgId}/members/{memberId}",
        "POST /graphql",
        "POST /upload",
      ].sort(),
    );
  });

  test("mcp tools carry the merged input schema", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const create = tools.find((x) => x.name === "users_post")!;
    const schema = create.inputSchema as { properties: object; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(["name", "age", "tags"]);
    expect(schema.required).toEqual(["name"]);
  });

  test("types follow handlers through a Node => Node transform", () => {
    const moved: Node = { meta: {}, children: { v1: lowered.tree } };
    expect(Object.keys(schemaMap(lowered, routeKeys, moved))).toContain("v1/users/:id/get");
  });
});
