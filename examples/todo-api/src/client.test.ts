// examples/todo-api/src/client.test.ts
// The generated typed client (codegen, from the example `app`) run IN-PROCESS,
// proving results are identical to a direct toFetch round-trip.

import { describe, expect, it } from "bun:test";
import { app, handle, type Todo } from "./app.ts";
import { createClient } from "./generated/client.ts";

describe("generated typed client over the example app — in-process", () => {
  it("POST then GET /todos returns the created todo (typed end-to-end)", async () => {
    const c = createClient(app);
    const created = await c["/todos"].post({ body: { title: "client-created" } });
    expect((created as Todo).title).toBe("client-created");

    const todos = (await c["/todos"].get()) as Todo[];
    expect(todos.some((t) => t.id === (created as Todo).id)).toBe(true);
  });

  it("typed path param {id} flows into GET /todos/{id}", async () => {
    const c = createClient(app);
    const created = (await c["/todos"].post({ body: { title: "to-find" } })) as Todo;
    const one = (await c["/todos/{id}"].get({ params: { id: created.id } })) as Todo;
    expect(one.title).toBe("to-find");
  });

  it("typed param + body flows into POST /todos/{id}/done", async () => {
    const c = createClient(app);
    const created = (await c["/todos"].post({ body: { title: "to-mark" } })) as Todo;
    const done = (await c["/todos/{id}/done"].post({
      params: { id: created.id },
      body: { done: true },
    })) as Todo;
    expect(done.done).toBe(true);
  });

  it("in-process equals a direct toFetch round-trip (server-identical)", async () => {
    const c = createClient(app);
    const direct = await (await handle(new Request("http://x/todos"))).json();
    const viaClient = await c["/todos"].get();
    expect(viaClient).toEqual(direct);
  });
});
