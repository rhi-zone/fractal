// packages/openapi/src/index.test.ts — tests-are-the-spec.
//
// Drives the real todo-api fixture app through `toOpenApi` and asserts the
// projected document structurally: the right path strings, every declared verb
// as an operation, the `validated` body route carrying a `requestBody` schema,
// path params present as `parameters`. Plus a degradation test (a schema with no
// JSON-Schema trait → `{}`, document still valid).

import { describe, expect, it } from "bun:test";
import {
  choice,
  methods,
  param,
  path,
  withAuth,
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import { json, returns, status, validated } from "@rhi-zone/fractal-http";
import {
  resolveSchema,
  toJsonSchema,
  toOpenApi,
  toOpenApiWithWarnings,
  type Operation,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Fixtures — schemas that expose the Standard-Schema JSON-Schema trait, so the
// projection resolves real JSON Schema (no external validator dep).
// ---------------------------------------------------------------------------

/** Standard Schema + JSON-Schema trait, hand-rolled (no validator dep). */
function objSchema<const F extends Record<string, "string" | "boolean">>(
  fields: F,
): StandardSchemaV1<
  unknown,
  { [K in keyof F]: F[K] extends "string" ? string : boolean }
> {
  type Out = { [K in keyof F]: F[K] extends "string" ? string : boolean };
  const properties: Record<string, { type: string }> = {};
  for (const [k, t] of Object.entries(fields)) properties[k] = { type: t };
  const jsonSchema = () => ({
    type: "object",
    properties,
    required: Object.keys(fields),
  });
  return {
    "~standard": {
      version: 1,
      vendor: "openapi-test",
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "expected an object" }] };
        }
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, t] of Object.entries(fields)) {
          if (typeof obj[k] !== t) {
            return { issues: [{ message: `field "${k}" must be a ${t}` }] };
          }
          out[k] = obj[k];
        }
        return { value: out as Out };
      },
      // the reflective JSON-Schema trait the projection reads.
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    } as StandardSchemaV1<unknown, Out>["~standard"] & {
      jsonSchema: { input: () => object; output: () => object };
    },
  };
}

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const createSchema = objSchema({ title: "string" });
const doneSchema = objSchema({ done: "boolean" });

// ---------------------------------------------------------------------------
// The fixture app — the same SHAPE as examples/todo-api, built locally so the
// test owns its fixtures. /todos collection, /todos/{id}, /todos/{id}/done.
// ---------------------------------------------------------------------------

const todos: Todo[] = [];

const todosCollection = methods({
  GET: () => json(todos),
  POST: validated(createSchema, (value) =>
    status(201, { id: "1", title: value.title, done: false }),
  ),
});

const todoDone = param(
  "id",
  path({
    done: methods({
      POST: validated(doneSchema, () => json(todos[0])),
    }),
  }),
);

const todoItem = param(
  "id",
  methods({
    GET: returns<Todo>(() => json(todos[0]), createSchema),
  }),
);

const app = path({
  todos: choice(todosCollection, todoDone, todoItem),
  health: methods({ GET: () => json({ ok: true }) }),
});

const info = { title: "Todo API", version: "1.0.0" };

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe("toOpenApi — document shape", () => {
  it("emits a valid OpenAPI 3.x envelope", () => {
    const doc = toOpenApi(app, info);
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info).toEqual(info);
    expect(typeof doc.paths).toBe("object");
  });

  it("emits the expected path strings from the tree", () => {
    const doc = toOpenApi(app, info);
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/health",
      "/todos",
      "/todos/{id}",
      "/todos/{id}/done",
    ]);
  });

  it("enumerates each declared verb as an operation", () => {
    const doc = toOpenApi(app, info);
    expect(Object.keys(doc.paths["/todos"]!).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/health"]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths["/todos/{id}"]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths["/todos/{id}/done"]!)).toEqual(["post"]);
  });
});

describe("toOpenApi — requestBody from validated", () => {
  it("POST /todos carries the validated body schema", () => {
    const doc = toOpenApi(app, info);
    const op = doc.paths["/todos"]!.post as Operation;
    expect(op.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
    });
  });

  it("a validated route emits a 400 response", () => {
    const doc = toOpenApi(app, info);
    const op = doc.paths["/todos"]!.post as Operation;
    expect(op.responses["400"]).toEqual({ description: "Validation failed" });
  });

  it("GET /todos (no body) carries no requestBody", () => {
    const doc = toOpenApi(app, info);
    const op = doc.paths["/todos"]!.get as Operation;
    expect(op.requestBody).toBeUndefined();
  });
});

describe("toOpenApi — path parameters", () => {
  it("a param route emits a required path parameter", () => {
    const doc = toOpenApi(app, info);
    const op = doc.paths["/todos/{id}"]!.get as Operation;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("nested under param + literal segment keeps the param", () => {
    const doc = toOpenApi(app, info);
    const op = doc.paths["/todos/{id}/done"]!.post as Operation;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("a codec'd param resolves its schema (not just string)", () => {
    // `param(name, codec, inner)` stamps the codec as an inert reflectable schema
    // sidecar (mirrors validated's __schema); toOpenApi resolves it via the ladder.
    const intCodec = {
      "~standard": {
        version: 1 as const,
        vendor: "openapi-test",
        jsonSchema: {
          input: () => ({ type: "integer" }),
          output: () => ({ type: "integer" }),
        },
        validate: (v: unknown) => ({ value: Number(v) }),
      },
    } as unknown as StandardSchemaV1<string, number>;
    const codecApp = path({
      items: param("id", intCodec, methods({ GET: () => status(200) })),
    });
    const doc = toOpenApi(codecApp, info);
    const op = doc.paths["/items/{id}"]!.get as Operation;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer" } },
    ]);
  });
});

describe("toOpenApi — returns output schema", () => {
  it("GET /todos/{id} carries a success response schema from returns()", () => {
    const doc = toOpenApi(app, info);
    const op = doc.paths["/todos/{id}"]!.get as Operation;
    expect(op.responses["200"]?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
  });
});

describe("toOpenApi — choice branches, does not collapse alts", () => {
  it("all three /todos alts contribute distinct endpoints", () => {
    const doc = toOpenApi(app, info);
    // collection (GET+POST at /todos), todoDone (POST at /todos/{id}/done),
    // todoItem (GET at /todos/{id}) — every alt present, none collapsed.
    expect(doc.paths["/todos"]).toBeDefined();
    expect(doc.paths["/todos/{id}"]).toBeDefined();
    expect(doc.paths["/todos/{id}/done"]).toBeDefined();
  });
});

describe("resolveSchema / toJsonSchema — the ladder", () => {
  it("resolves via the Standard-Schema JSON-Schema trait", () => {
    expect(toJsonSchema(createSchema, "input")).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
  });

  it("uses a plain JSON-Schema-shaped object verbatim", () => {
    const plain = { type: "string", minLength: 1 };
    expect(resolveSchema(plain, "input")).toEqual(plain);
  });

  it("degrades a trait-less, non-JSON-Schema value to {} with a warning", () => {
    const warnings: { path: string; message: string }[] = [];
    const out = resolveSchema({ random: "thing" }, "input", {
      warn: (w) => warnings.push(w),
      at: "X",
    });
    expect(out).toEqual({});
    expect(warnings.length).toBe(1);
  });

  it("does not throw on a non-object schema", () => {
    expect(resolveSchema(42, "input")).toEqual({});
    expect(resolveSchema(undefined, "output")).toEqual({});
  });
});

describe("toOpenApi — degradation keeps the document valid", () => {
  it("a validator with no JSON-Schema trait yields {} body, no throw", () => {
    // a Standard Schema with NO jsonSchema trait.
    const traitless: StandardSchemaV1<unknown, { a: string }> = {
      "~standard": {
        version: 1,
        vendor: "traitless",
        validate: (v) => ({ value: v as { a: string } }),
      },
    };
    const degraded = path({
      thing: methods({
        POST: validated<typeof traitless>(traitless, () => json({})),
      }),
    });
    const { document, warnings } = toOpenApiWithWarnings(degraded, info);
    const op = document.paths["/thing"]!.post as Operation;
    expect(op.requestBody?.content["application/json"]?.schema).toEqual({});
    expect(document.openapi).toMatch(/^3\./);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// provide / withAuth — VAR injectors are TRANSPARENT to the projection. An authed
// route projects the SAME operation (same path, same parameters) as the plain
// route: the injected `user` key is server-internal, never an OpenAPI parameter.
// ---------------------------------------------------------------------------

describe("toOpenApi — provide/withAuth are transparent (no extra parameter)", () => {
  interface User { id: string }

  const plain = path({
    me: methods({ GET: () => json({ ok: true }) }),
  });
  const authed = path({
    me: withAuth(
      (): User | Response => ({ id: "u1" }),
      methods({
        GET: (req: Request & { ctx: { user: User } }) => json(req.ctx.user),
      }),
    ),
  });

  it("the authed route projects the SAME path + operation as the plain one", () => {
    const a = toOpenApi(authed, info);
    const p = toOpenApi(plain, info);
    expect(Object.keys(a.paths)).toEqual(["/me"]);
    expect(a.paths["/me"]).toEqual(p.paths["/me"]);
  });

  it("the authed route's GET operation has NO `user` (or any) parameter", () => {
    const a = toOpenApi(authed, info);
    const op = a.paths["/me"]!.get!;
    // No parameters at all — the var is invisible; a path param would still show.
    expect(op.parameters).toBeUndefined();
  });

  it("a path param UNDER withAuth still projects as a path parameter", () => {
    const withParam = path({
      thing: withAuth(
        (): User | Response => ({ id: "u1" }),
        param(
          "id",
          methods({
            GET: (req: Request & { ctx: { id: string; user: User } }) =>
              json({ id: req.ctx.id }),
          }),
        ),
      ),
    });
    const doc = toOpenApi(withParam, info);
    const op = doc.paths["/thing/{id}"]!.get!;
    expect(op.parameters?.map((p) => p.name)).toEqual(["id"]);
  });
});
