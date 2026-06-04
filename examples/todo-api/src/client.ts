// examples/todo-api/src/client.ts
//
// Demo of the TYPED CLIENT derived from the example `app` (src/app.ts).
//
// One server definition (`app`) yields a fully-typed client surface with ZERO
// hand-written types: path params, validated bodies, and domain outputs are all
// inferred from the SAME router that serves. This is the criterion-6 feature —
// end-to-end inference that matches/beats Eden `treaty` and Hono `hc`.
//
// `client(app)` defaults to the IN-PROCESS transport (Hyper unification: the
// same handler runs, no network). Swap in `http(baseUrl)` to target a real
// server over `fetch` — the derived TYPE is identical, only execution differs.

import { client, http, type ClientOf } from "@rhi-zone/fractal-client"
import { app, type Todo } from "./app.ts"

// ---------------------------------------------------------------------------
// The derived client surface — a type probe.
//
// type AppClient expands (abbreviated) to:
// {
//   "/todos":             { get: () => Promise<Todo[]> }
//   "/todos/:id/mark-done": { post: (a: { params: { id: string } }) => Promise<...> }
//   "/count":             { get: () => Promise<{ total: number } | ...> }
//   "/search":            { get: () => Promise<{ q: ...; limit: ...; raw: true }> }
//   "/admin/me":          { get: () => Promise<...> }   // prefixed from the mount
//   "/admin/stats":       { get: () => Promise<...> }
//   ...
// }
// ---------------------------------------------------------------------------

export type AppClient = ClientOf<typeof app>

// In-process client (default transport).
export const local = client(app)

// HTTP client — same ClientOf type, fetch transport. (baseUrl is illustrative.)
export const remote: AppClient = client(app, http("http://localhost:3000"))

// ---------------------------------------------------------------------------
// Typed call sites — every shape below is inferred from `app`, no annotations.
// ---------------------------------------------------------------------------

export async function demo(): Promise<void> {
  // GET /todos → Todo[] (output recovered from json(todos)).
  const todos: Todo[] = await local["/todos"].get()

  // POST /todos with a typed validated body → the created Todo.
  const created = await local["/todos"].post({ body: { title: "write the client" } })

  // POST /todos/:id/mark-done — typed path param (`:id`). Passing a number for
  // `id` would be a COMPILE error; omitting `params` would too.
  const result = await local["/todos/:id/mark-done"].post({ params: { id: created.id } })

  // GET /count → the plain value rendered to JSON.
  const count = await local["/count"].get()

  console.log("todos:", todos, "created:", created, "result:", result, "count:", count)
}
