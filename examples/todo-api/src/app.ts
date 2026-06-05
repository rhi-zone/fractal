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
  type StandardSchemaV1,
} from "@rhi-zone/fractal-core";
import {
  binary,
  json,
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
  return {
    "~standard": {
      version: 1,
      vendor: "todo-fixture",
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
  };
}

const createSchema = schema({ title: "string" });
const doneSchema = schema({ done: "boolean" });

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
  GET: () => json(todos),
  POST: validated<typeof createSchema, Todo>(createSchema, (value) => {
    const todo: Todo = { id: String(seq++), title: value.title, done: false };
    todos.push(todo);
    return status(201, todo);
  }),
});

// /todos/{id}/done — POST a validated { done } body for a typed param id.
const todoDone = param(
  "id",
  path({
    done: methods({
      POST: validated<typeof doneSchema, Todo | { error: string }>(
        doneSchema,
        (value, req) => {
          const id = paramValue(req, "id");
          const todo = todos.find((t) => t.id === id);
          if (todo === undefined) {
            return json({ error: "TODO_NOT_FOUND", id }, { status: 404 });
          }
          todo.done = value.done;
          return json(todo);
        },
      ),
    }),
  }),
);

// /todos/{id} — GET one (404 if unknown).
const todoItem = param(
  "id",
  methods({
    GET: (req) => {
      const id = paramValue(req, "id");
      const todo = todos.find((t) => t.id === id);
      return todo
        ? json(todo)
        : json({ error: "TODO_NOT_FOUND", id }, { status: 404 });
    },
  }),
);

// /todos : the collection, then /{id}/done, then /{id}. `choice` tries each in
// order; the first non-undefined wins.
const todosResource = choice(todosCollection, todoDone, todoItem);

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

export const app = path({
  todos: todosResource,
  health: methods({ GET: () => text("ok") }),
  events,
  favicon,
});

/** WHATWG fetch handler for the app. Run in-process with new Request(...). */
export const handle = toFetch(app);
