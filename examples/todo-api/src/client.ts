// examples/todo-api/src/client.ts
//
// Demo of the TYPED CLIENT derived from the example `app` (src/app.ts).
//
// One server definition (`app`) yields a fully-typed client surface, derived
// flat from the app's inert `.meta`: path params, validated bodies, and outputs
// are all inferred from the SAME tree that serves. ZERO hand-written client types.
//
// `client(app)` defaults to the IN-PROCESS transport (the same handler runs, no
// network). Swap in `http(baseUrl)` to target a real server over `fetch` — the
// derived TYPE is identical, only execution differs.

import { client, http, type Client } from "@rhi-zone/fractal-client";
import { app } from "./app.ts";

// The derived client surface — a type probe. `AppClient` expands (abbreviated):
// {
//   "/todos":            { get: () => Promise<...>; post: (a:{body:{title}}) => ... }
//   "/todos/{id}":       { get: (a:{params:{id:string}}) => Promise<...> }
//   "/todos/{id}/done":  { post: (a:{params:{id:string}; body:{done:boolean}}) => ... }
//   "/health":           { get: () => Promise<string> }
//   ...
// }
export type AppClient = Client<typeof app>;

// In-process client (default transport).
export const local = client(app);

// HTTP client — same Client type, fetch transport. (baseUrl is illustrative.)
export const remote: AppClient = client(app, http("http://localhost:3000"));

// ---------------------------------------------------------------------------
// Typed call sites — every shape below is inferred from `app`, no annotations.
// ---------------------------------------------------------------------------

export async function demo(): Promise<void> {
  // POST /todos with a typed validated body → the created Todo.
  const created = await local["/todos"].post({ body: { title: "write the client" } });

  // GET /todos → the list.
  const list = await local["/todos"].get();

  // GET /todos/{id} — typed path param. Omitting `params` would be a compile error.
  const one = await local["/todos/{id}"].get({ params: { id: (created as { id: string }).id } });

  // POST /todos/{id}/done — typed param AND typed validated body.
  const done = await local["/todos/{id}/done"].post({
    params: { id: (created as { id: string }).id },
    body: { done: true },
  });

  console.log("created:", created, "list:", list, "one:", one, "done:", done);
}
