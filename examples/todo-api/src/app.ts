// examples/todo-api/src/app.ts
//
// A small but real example on the handler-model framework. The ONLY framework
// type is `Handler`; the app is a tree built from `path` / `methods` / `param` /
// `choice`, with `validated` on a body route. `toFetch(app)` turns it into a
// WHATWG (Request) => Promise<Response>.
//
// Exercises:
//   - a CRUD-ish /todos resource: GET (list), POST (validated create → 201)
//   - a dynamic /todos/{id} route: GET one (404 if unknown)
//   - POST /todos/{id}/done — typed param + validated body
//   - GET /health — a second top-level resource
//   - an SSE endpoint and a binary endpoint (ordinary Responses)

import {
  choice,
  methods,
  param,
  paramValue,
  path,
  withAuth,
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import {
  binary,
  cors,
  json,
  logger,
  returns,
  sse,
  status,
  text,
  toFetch,
  validated,
} from "@rhi-zone/fractal-http";

// ---------------------------------------------------------------------------
// A tiny object-schema fixture (StandardSchema-shaped; no external dep)
// ---------------------------------------------------------------------------

function schema<const F extends Record<string, "string" | "boolean">>(
  fields: F,
): StandardSchemaV1<
  unknown,
  { [K in keyof F]: F[K] extends "string" ? string : boolean }
> {
  type Out = { [K in keyof F]: F[K] extends "string" ? string : boolean };
  // a JSON-Schema view of the fixture, so the OpenAPI projection
  // (@rhi-zone/fractal-openapi) resolves a real body schema rather than degrading
  // to `{}`. This is the Standard-Schema JSON-Schema reflective trait.
  const properties: Record<string, { type: string }> = {};
  for (const [k, t] of Object.entries(fields)) properties[k] = { type: t };
  const asJsonSchema = () => ({
    type: "object",
    properties,
    required: Object.keys(fields),
  });
  const std = {
    version: 1 as const,
    vendor: "todo-fixture",
    // the extra reflective trait is invisible to the StandardSchemaV1 type but
    // present at runtime for the OpenAPI projection to read.
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
  };
  return { "~standard": std } as StandardSchemaV1<unknown, Out>;
}

/** Wrap an object schema as an ARRAY schema (same StandardSchema + JSON-Schema
 *  trait shape), so a `returns(...)` annotation can type a list response. The
 *  validate is identity-ish (the example never re-validates outputs); the
 *  load-bearing part is the `jsonSchema` trait the OpenAPI projection reads. */
function arrayOf<O>(
  item: StandardSchemaV1<unknown, O>,
): StandardSchemaV1<unknown, O[]> {
  const itemJson = (item as { "~standard": { jsonSchema?: { output?: () => unknown } } })[
    "~standard"
  ].jsonSchema?.output;
  const std = {
    version: 1 as const,
    vendor: "todo-fixture",
    jsonSchema: {
      input: () => ({ type: "array", items: itemJson?.() }),
      output: () => ({ type: "array", items: itemJson?.() }),
    },
    validate(value: unknown) {
      return Array.isArray(value)
        ? { value: value as O[] }
        : { issues: [{ message: "expected an array" }] };
    },
  };
  return { "~standard": std } as StandardSchemaV1<unknown, O[]>;
}

const createSchema = schema({ title: "string" });
const doneSchema = schema({ done: "boolean" });

// Output schemas — the source of TYPED client responses. A `returns(handler,
// schema)` stamps `__schema.output`, which the OpenAPI projection emits as the
// 200 response schema and codegen turns into the client's concrete return type.
const todoSchema = schema({ id: "string", title: "string", done: "boolean" });
const todoListSchema = arrayOf(todoSchema);

// ---------------------------------------------------------------------------
// Domain — an in-memory todo store
// ---------------------------------------------------------------------------

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const todos: Todo[] = [];
let seq = 1;

// ---------------------------------------------------------------------------
// The app tree — plain combinators. Every leaf is a `methods` table; the id is
// read directly off the Request (where `param` bound it) via `paramValue`.
// ---------------------------------------------------------------------------

// GET /todos  +  POST /todos (validated create → 201)
const todosCollection = methods({
  GET: returns(() => json(todos), todoListSchema),
  POST: returns(
    validated(createSchema, (value) => {
      const todo: Todo = { id: String(seq++), title: value.title, done: false };
      todos.push(todo);
      return status(201, todo);
    }),
    todoSchema,
  ),
});

// /todos/{id}/done — POST a validated { done } body for a typed param id.
const todoDone = param(
  "id",
  path({
    done: methods({
      POST: returns(
        validated(doneSchema, (value, req) => {
          const id = paramValue(req, "id");
          const todo = todos.find((t) => t.id === id);
          if (todo === undefined) {
            return json({ error: "TODO_NOT_FOUND", id }, { status: 404 });
          }
          todo.done = value.done;
          return json(todo);
        }),
        todoSchema,
      ),
    }),
  }),
);

// /todos/{id} — GET one (404 if unknown).
const todoItem = param(
  "id",
  methods({
    GET: returns((req) => {
      const id = paramValue(req, "id");
      const todo = todos.find((t) => t.id === id);
      return todo
        ? json(todo)
        : json({ error: "TODO_NOT_FOUND", id }, { status: 404 });
    }, todoSchema),
  }),
);

// /todos : the collection, then /{id}/done, then /{id}. `choice` tries each in
// order; the first non-undefined wins.
const todosResource = choice(todosCollection, todoDone, todoItem);

// ---------------------------------------------------------------------------
// AUTHENTICATED route — dogfoods `withAuth` (a ctx-discharge middleware). The
// handler reads `req.ctx.user` TYPED; `withAuth` injects it (or 401s). CRITICAL:
// `user` is a VAR, not a path param — it is INVISIBLE to the generated client's
// call args and to the OpenAPI `parameters`. So GET /me's generated client
// signature is `() => Promise<...>` — NO `user` argument — while the server alias
// / handler sees `req.ctx.user` fully typed. Adding `withAuth` changed NO other
// route's generated output.
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
}

/** A toy authenticator: `Authorization: Bearer <name>` → a User; else a 401. The
 *  return is `User | Response` — the `provide`/`withAuth` discharge protocol. */
function authenticate(req: Request): User | Response {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (m === null) return json({ error: "UNAUTHORIZED" }, { status: 401 });
  return { id: m[1]!, name: m[1]! };
}

// GET /me — the authenticated principal. `withAuth` discharges the `user` ctx key;
// the inner handler's declared `{ ctx: { user: User } }` is read back typed.
const me = withAuth(
  authenticate,
  methods({
    GET: returns(
      (req: Request & { ctx: { user: User } }) => json(req.ctx.user),
      schema({ id: "string", name: "string" }),
    ),
  }),
);

// SSE + binary endpoints — ordinary Responses.
const events = methods({
  GET: () =>
    sse((emit) => {
      emit("connected", { ts: 0 });
      emit("count", { total: todos.length });
      emit("done", {});
    }),
});
const favicon = methods({
  GET: () => binary(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"),
});

// The ROUTE TREE — the source of truth the codegen + drift guard project from.
// `app` is the bare tree (no observing wrappers) so the generated client/server +
// drift guard read its `.meta` directly. `me` (the authed route) sits alongside
// the others; its `user` ctx key never reaches the client signature.
export const app = path({
  todos: todosResource,
  me,
  health: methods({ GET: () => text("ok") }),
  events,
  favicon,
});

/** WHATWG fetch handler for the app, wrapped in OBSERVING middleware: `logger`
 *  prints `METHOD /path -> status`, `cors` adds CORS headers + answers preflight.
 *  Both PRESERVE `.meta`, so wrapping changes neither dispatch routing nor the
 *  projections — they are transparent decorators around the same `app`. */
export const handle = toFetch(logger(cors()(app)));
