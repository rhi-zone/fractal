// examples/todo-api/src/client.ts
//
// Demo of the TYPED CLIENT for the example `app` (src/app.ts).
//
// CODE-FIRST: the handler tree (`app`) is truth; `@rhi-zone/fractal-codegen`
// projects an OpenAPI doc from it and emits a PLAIN `.ts` typed client —
// `src/generated/client.ts` (the `ApiClient` interface + `createClient` factory).
// Regenerate with:
//
//   bun ../../packages/codegen/src/cli.ts ./src/app.ts \
//     --out ./src/generated --title "Todo API" --version "1.0.0"
//
// `createClient(app)` defaults to the IN-PROCESS transport (the same handler runs,
// no network). Swap in `http(baseUrl)` to target a real server over `fetch` — the
// generated TYPE is identical, only execution differs. ZERO type-level walk: tsc
// pays near-zero instantiation cost regardless of route count.

import { http } from "@rhi-zone/fractal-client";
import { app } from "./app.ts";
import { createClient, type ApiClient } from "./generated/client.ts";

// The generated client surface — a concrete interface (see ./generated/client.ts):
// {
//   "/todos":            { get: () => Promise<...>; post: (a:{body:{title}}) => ... }
//   "/todos/{id}":       { get: (a:{params:{id:string}}) => Promise<...> }
//   "/todos/{id}/done":  { post: (a:{params:{id:string}; body:{done:boolean}}) => ... }
//   "/health":           { get: () => Promise<unknown> }
//   ...
// }
export type AppClient = ApiClient;

// In-process client (default transport).
export const local = createClient(app);

// HTTP client — same ApiClient type, fetch transport. (baseUrl is illustrative.)
export const remote: ApiClient = createClient(app, http("http://localhost:3000"));

// ---------------------------------------------------------------------------
// Typed call sites — every shape below is checked against the generated interface.
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
