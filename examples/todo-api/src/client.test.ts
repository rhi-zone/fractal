// examples/todo-api/src/client.test.ts
// The typed client (derived from the example `app`) run IN-PROCESS, proving
// results are identical to a direct toHandler round-trip.

import { describe, expect, it } from "bun:test"
import { client } from "@rhi-zone/fractal-client"
import { app, handle, type Todo } from "./app.ts"

describe("typed client over the example app — in-process", () => {
  it("POST then GET /todos returns the created todo (typed end-to-end)", async () => {
    const c = client(app)
    const created = await c["/todos"].post({ body: { title: "client-created" } })
    expect(created.title).toBe("client-created")

    const todos: Todo[] = await c["/todos"].get()
    expect(todos.some((t) => t.id === created.id)).toBe(true)
  })

  it("typed path param :id flows into mark-done", async () => {
    const c = client(app)
    const created = await c["/todos"].post({ body: { title: "to-mark" } })
    // This route uses `respond(...)`; its success body type (Outcome `Ok` = Todo)
    // is recovered by the client — typed output flows through the Outcome path too.
    const result = await c["/todos/:id/mark-done"].post({ params: { id: created.id } })
    expect(result.done).toBe(true)
  })

  it("in-process equals a direct toHandler round-trip (server-identical)", async () => {
    const c = client(app)
    const direct = await (await handle(new Request("http://x/count"))).json()
    const viaClient = await c["/count"].get()
    expect(viaClient).toEqual(direct)
  })
})
