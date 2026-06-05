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
import { app, type Todo } from "../../../../../examples/todo-api/src/app.ts";

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
// CLIENT — RESPONSE TYPES. `returns(handler, todoSchema)` on GET /todos/{id}
// makes the call resolve to a CONCRETE Todo shape (not `Promise<unknown>`).
// ---------------------------------------------------------------------------
export async function clientResponses(): Promise<void> {
  // POSITIVE: the resolved value is assignable to Todo (structural; the generated
  // return is the inline `{ id; title; done }` the output schema projects).
  const one: Todo = await client["/todos/{id}"].get({ params: { id: "1" } });
  void one;
  // POSITIVE: GET /todos resolves to a Todo[] (the array output schema).
  const list: Todo[] = await client["/todos"].get();
  void list;
}

export async function clientResponseNegatives(): Promise<void> {
  // @ts-expect-error — the GET /todos/{id} response is a Todo, NOT a string.
  const bad: string = await client["/todos/{id}"].get({ params: { id: "1" } });
  void bad;
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
// CLIENT — the PROJECTION SPLIT. GET /me is an AUTHENTICATED route (`withAuth`):
// its `user` ctx key is a VAR, server-injected — NOT a path param. So the
// generated client call for /me takes NO arguments (no `user`, no params); auth
// rides the request server-side. This is the load-bearing proof that a var does
// not leak into the client contract.
// ---------------------------------------------------------------------------
export async function authedRouteHasNoUserArg(): Promise<void> {
  // POSITIVE: GET /me is called with NO arguments — the signature is `() => …`.
  const me = await client["/me"].get();
  void me;
}

export async function authedRouteNegatives(): Promise<void> {
  // @ts-expect-error — /me takes NO call args: there is no `user` (server-injected).
  await client["/me"].get({ user: { id: "1", name: "a" } });
  // @ts-expect-error — and no `params` either (the var is not a path param).
  await client["/me"].get({ params: { user: "1" } });
}

// ---------------------------------------------------------------------------
// SERVER — a handler annotated with a generated alias has typed req.ctx, stays
// a plain Handler value, and drops into `methods({...})` cleanly.
// ---------------------------------------------------------------------------
const getTodoById: GetTodosId = (req) => json(req.ctx.id); // req.ctx.id: string
const markDone: PostTodosIdDone = (req) => json(req.ctx.id);

// The generated alias carries the param obligation `{ id: string }`; `methods`
// EXTRACTS that obligation from the handler value (no explicit type-arg, which
// would erase the literal verb set), and the enclosing `param("id", …)`
// discharges it. (Annotating the value with the alias is the ergonomics fix —
// `req.ctx.id` is typed with no inference contortion, and the value stays a
// plain `Handler` whose declared ctx type `methods` reads back out.)
export const todoItemRoute = methods({ GET: getTodoById });
export const todoDoneRoute = methods({ POST: markDone });

// SERVER — negative: a typo on a generated-typed param is a compile error.
export const badHandler: GetTodosId = (req) =>
  // @ts-expect-error — `idd` is not a key of the generated param type.
  json(req.ctx.idd);
