// Generated-code USAGE PROBE — typechecked by tsgo AND stock tsc (see test).
//
// Proves the generated client + server types behave: correct positive shapes, and
// `@ts-expect-error` negatives that MUST fire (a wrong param/body is a compile
// error). If any `@ts-expect-error` stops firing, the compiler reports an unused
// directive and the typecheck FAILS — so this file is an executable spec.

import { json } from "@rhi-zone/fractal-http";
import { methods } from "@rhi-zone/fractal-core";
import { createClient, type ApiClient } from "./client.ts";
import type { GetTodosId, PostTodosIdDone } from "./server.ts";
import { app } from "../../../../../examples/todo-api/src/app.ts";

// ---------------------------------------------------------------------------
// CLIENT — positive shapes.
// ---------------------------------------------------------------------------
const client: ApiClient = createClient(app);

export async function clientPositives(): Promise<void> {
  // GET /todos/{id} with a typed param.
  await client["/todos/{id}"].get({ params: { id: "1" } });
  // GET /todos — no args.
  await client["/todos"].get();
  // POST /todos with a typed body.
  await client["/todos"].post({ body: { title: "x" } });
  // POST /todos/{id}/done — typed param AND typed body.
  await client["/todos/{id}/done"].post({ params: { id: "1" }, body: { done: true } });
}

// ---------------------------------------------------------------------------
// CLIENT — negatives. Each MUST be a compile error (directive must fire).
// ---------------------------------------------------------------------------
export async function clientNegatives(): Promise<void> {
  // @ts-expect-error — wrong param name (idd, not id).
  await client["/todos/{id}"].get({ params: { idd: "1" } });
  // @ts-expect-error — wrong body field (titel, not title).
  await client["/todos"].post({ body: { titel: "x" } });
  // @ts-expect-error — wrong body field type (done must be boolean).
  await client["/todos/{id}/done"].post({ params: { id: "1" }, body: { done: "yes" } });
  // @ts-expect-error — missing required params arg.
  await client["/todos/{id}"].get();
}

// ---------------------------------------------------------------------------
// SERVER — a handler annotated with a generated alias has typed req.params, stays
// a plain Handler value, and drops into `methods({...})` cleanly.
// ---------------------------------------------------------------------------
const getTodoById: GetTodosId = (req) => json(req.params.id); // req.params.id: string
const markDone: PostTodosIdDone = (req) => json(req.params.id);

// The generated alias carries the param obligation `{ id: string }`; the enclosing
// `param("id", …)` discharges it, so `methods` is parameterized by that same `P`.
// (Annotating the value with the alias is the ergonomics fix — `req.params.id` is
// typed with no inference contortion, and the value stays a plain `Handler`.)
export const todoItemRoute = methods<{ id: string }>({ GET: getTodoById });
export const todoDoneRoute = methods<{ id: string }>({ POST: markDone });

// SERVER — negative: a typo on a generated-typed param is a compile error.
export const badHandler: GetTodosId = (req) =>
  // @ts-expect-error — `idd` is not a key of the generated param type.
  json(req.params.idd);
