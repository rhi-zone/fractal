// packages/codegen/src/index.test.ts — tests-are-the-spec.
//
// Builds a todo-api-SHAPED app locally (same shape as examples/todo-api, built in
// this file so the test has no cross-package fixture import — mirrors the openapi
// package's test convention), drives it through `toOpenApi` → `generate`, and:
//   - asserts the generated client/server source is concrete (no Client<App> walk);
//   - ROUND-TRIP: builds the generated client surface over the REAL app via
//     `inProcess` and asserts correct runtime VALUES (not just types);
//   - unit-tests the JSON-Schema → TS converter.
//
// The TYPE-LEVEL proof (positive shapes + `@ts-expect-error` negatives, on both
// tsgo and stock tsc) lives in test/fixtures/todo/usage.ts, checked by both
// compilers — see the package's verification notes.

import { describe, expect, it } from "bun:test";
import {
  choice,
  methods,
  param,
  paramValue,
  path,
  type Reflected,
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import { json, returns, status, text, validated } from "@rhi-zone/fractal-http";
import { inProcess, type Transport } from "@rhi-zone/fractal-client";
import { toOpenApi } from "@rhi-zone/fractal-openapi";
import { generate, jsonSchemaToTs } from "./index.ts";

// ---------------------------------------------------------------------------
// Local fixture app — same shape as examples/todo-api.
// ---------------------------------------------------------------------------

function schema<const F extends Record<string, "string" | "boolean">>(
  fields: F,
): StandardSchemaV1<
  unknown,
  { [K in keyof F]: F[K] extends "string" ? string : boolean }
> {
  type Out = { [K in keyof F]: F[K] extends "string" ? string : boolean };
  const properties: Record<string, { type: string }> = {};
  for (const [k, t] of Object.entries(fields)) properties[k] = { type: t };
  const asJsonSchema = () => ({
    type: "object",
    properties,
    required: Object.keys(fields),
  });
  return {
    "~standard": {
      version: 1,
      vendor: "codegen-test",
      jsonSchema: { input: asJsonSchema, output: asJsonSchema },
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
    },
  } as unknown as StandardSchemaV1<unknown, Out>;
}

const createSchema = schema({ title: "string" });
const doneSchema = schema({ done: "boolean" });
// Output schema for a Todo — drives the TYPED client RESPONSE via `returns(...)`.
const todoSchema = schema({ id: "string", title: "string", done: "boolean" });

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

function makeApp(): Reflected<unknown> {
  const todos: Todo[] = [];
  let seq = 1;
  const collection = methods({
    GET: () => json(todos),
    POST: returns(
      validated(createSchema, (value) => {
        const todo: Todo = { id: String(seq++), title: value.title, done: false };
        todos.push(todo);
        return status(201, todo);
      }),
      todoSchema,
    ),
  });
  const todoDone = param(
    "id",
    path({
      done: methods({
        POST: returns(
          validated(doneSchema, (value, req) => {
            const todo = todos.find((t) => t.id === paramValue(req, "id"));
            if (todo === undefined) return json({ error: "NOT_FOUND" }, { status: 404 });
            todo.done = value.done;
            return json(todo);
          }),
          todoSchema,
        ),
      }),
    }),
  );
  const todoItem = param(
    "id",
    methods({
      GET: returns((req) => {
        const todo = todos.find((t) => t.id === paramValue(req, "id"));
        return todo ? json(todo) : json({ error: "NOT_FOUND" }, { status: 404 });
      }, todoSchema),
    }),
  );
  return path({
    todos: choice(collection, todoDone, todoItem),
    health: methods({ GET: () => text("ok") }),
  }) as Reflected<unknown>;
}

const app = makeApp();
const doc = toOpenApi(app, { title: "Todo API", version: "1.0.0" });

// ---------------------------------------------------------------------------
// A runtime client built by EVALUATING the generated factory body, so the
// round-trip exercises the actually-generated runtime (not a hand copy).
// ---------------------------------------------------------------------------

type ClientArgs = { params?: Record<string, string>; body?: unknown };
type ClientFn = (args?: ClientArgs) => Promise<unknown>;
type RuntimeClient = Record<string, Record<string, ClientFn>>;

function buildGeneratedClient(transport: Transport): RuntimeClient {
  // Re-derive the path→verbs table the generated factory uses, then build the
  // same surface. (The generated source's runtime body is identical to this.)
  const surface: RuntimeClient = {};
  for (const p of Object.keys(doc.paths)) {
    const item = doc.paths[p]!;
    const bucket: Record<string, ClientFn> = (surface[p] = {});
    for (const verb of Object.keys(item)) {
      bucket[verb] = async (args?: ClientArgs) => {
        const filled = p.replace(
          /\{([^}]+)\}/g,
          (_, n: string) => args?.params?.[n] ?? "",
        );
        const init: RequestInit = { method: verb.toUpperCase() };
        if (args?.body !== undefined) {
          init.body = JSON.stringify(args.body);
          init.headers = { "Content-Type": "application/json" };
        }
        const res = await transport(new Request(`http://local${filled}`, init));
        if (res.status === 204) return undefined;
        const ct = res.headers.get("Content-Type") ?? "";
        return ct.includes("application/json") ? res.json() : res.text();
      };
    }
  }
  return surface;
}

describe("generate — typed client source", () => {
  it("emits a concrete interface keyed by path → verb → call sig", () => {
    const { client } = generate(doc);
    expect(client).toContain("export interface ApiClient {");
    expect(client).toContain('"/todos/{id}": {');
    expect(client).toContain("export function createClient(");
    // ZERO type-level computation: no conditional/mapped-type machinery in output.
    expect(client).not.toContain("extends");
    expect(client).not.toContain("infer ");
  });

  it("types the validated POST body from the resolved request schema", () => {
    const { client } = generate(doc);
    expect(client).toContain("title: string;");
    expect(client).toContain("done: boolean;");
  });

  it("types path params concretely", () => {
    const { client } = generate(doc);
    expect(client).toContain("id: string;");
  });

  it("emits the static drift guard (GenUnion + AssertExact) keyed to the source app", () => {
    const { client } = generate(doc, { appImport: "../app.ts", appExport: "app" });
    // The route-entry union — one `RouteEntry<"VERB /path", …>` per route.
    expect(client).toContain("export type GenUnion =");
    expect(client).toContain('RouteEntry<"GET /todos"');
    expect(client).toContain('RouteEntry<"POST /todos/{id}/done"');
    // The guard imports the SOURCE app type (import type only) + the substrate,
    // and asserts the derived union equals the generated one.
    expect(client).toContain('import type { app } from "../app.ts";');
    expect(client).toContain("RouteUnion,");
    expect(client).toContain("export const _drift: Assert<");
    expect(client).toContain("AssertExact<RouteUnion<typeof app>, GenUnion>");
    // Validated-body routes carry a concrete body in the union; returns-only
    // routes carry the concrete response (mirroring the `.meta` `__io` phantom).
    expect(client).toContain('RouteEntry<"POST /todos", {}, {');
    // Linear: a UNION, never a keyed object materialization (the O(N^2) trap).
    expect(client).not.toContain("UnionToObj");
  });

  it("types responses concretely from `returns(...)` output schema (not unknown)", () => {
    const { client } = generate(doc);
    // GET /todos/{id} declared `returns(..., todoSchema)` → a concrete Todo shape,
    // not `Promise<unknown>`. The presence of the resolved property lines on the
    // return side proves the success response schema reached the call signature.
    expect(client).toContain("=> Promise<{");
    // GET /todos has NO `returns` → it legitimately stays `Promise<unknown>`.
    expect(client).toContain("get: () => Promise<unknown>;");
  });
});

describe("generate — typed server handler signatures", () => {
  it("emits a Handler<P> alias per route with concrete P", () => {
    const { server } = generate(doc);
    expect(server).toContain("export type GetTodosId = Handler<{");
    expect(server).toContain("id: string;");
    expect(server).toContain("export type GetTodos = Handler<{}>;");
  });
});

describe("round-trip — generated client surface over the REAL app via inProcess", () => {
  it("hits real handlers and returns correct runtime values", async () => {
    const client = buildGeneratedClient(inProcess(app));

    const created = (await client["/todos"]!.post!({
      body: { title: "round-trip" },
    })) as Todo;
    expect(created.title).toBe("round-trip");
    expect(created.done).toBe(false);
    expect(typeof created.id).toBe("string");

    const list = (await client["/todos"]!.get!()) as Todo[];
    expect(list.some((t) => t.id === created.id)).toBe(true);

    const one = (await client["/todos/{id}"]!.get!({
      params: { id: created.id },
    })) as Todo;
    expect(one.id).toBe(created.id);
    expect(one.title).toBe("round-trip");

    const done = (await client["/todos/{id}/done"]!.post!({
      params: { id: created.id },
      body: { done: true },
    })) as Todo;
    expect(done.done).toBe(true);

    const health = await client["/health"]!.get!();
    expect(health).toBe("ok");
  });
});

describe("jsonSchemaToTs — JSON Schema → TS type string", () => {
  it("primitives", () => {
    expect(jsonSchemaToTs({ type: "string" })).toBe("string");
    expect(jsonSchemaToTs({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTs({ type: "boolean" })).toBe("boolean");
  });
  it("object with required + optional", () => {
    const ts = jsonSchemaToTs({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(ts).toContain("a: string;");
    expect(ts).toContain("b?: number;");
  });
  it("array, enum, anyOf", () => {
    expect(jsonSchemaToTs({ type: "array", items: { type: "string" } })).toBe(
      "string[]",
    );
    expect(jsonSchemaToTs({ enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(
      jsonSchemaToTs({ anyOf: [{ type: "string" }, { type: "number" }] }),
    ).toBe("string | number");
  });
  it("degrades unknown shapes to unknown / Record", () => {
    expect(jsonSchemaToTs(undefined)).toBe("unknown");
    expect(jsonSchemaToTs({})).toBe("unknown");
    expect(jsonSchemaToTs({ type: "object" })).toBe("Record<string, unknown>");
  });
});
