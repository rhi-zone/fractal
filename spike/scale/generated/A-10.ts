import { httpRouter, json, withValidation } from "@rhi-zone/fractal-http"
import type { StandardSchema } from "@rhi-zone/fractal-api-tree"
import { client } from "@rhi-zone/fractal-client"

// Minimal Standard-Schema validator (no zod — isolate fractal's cost).
interface Body { readonly name: string; readonly qty: number }
const bodySchema: StandardSchema<unknown, Body> = {
  "~standard": {
    version: 1,
    validate(v: unknown) {
      const o = v as Body
      return { value: { name: String(o?.name ?? ""), qty: Number(o?.qty ?? 0) } }
    },
  },
}

const app = httpRouter()
  .get("/res0/:id", async (ctx) => json({ id: 0, key: ctx.params.id }))
  .routeNode("POST", "/res1", withValidation(async (b: Body) => json({ id: 1, name: b.name, qty: b.qty }), bodySchema))
  .put("/res2/:id", async (ctx) => json({ id: 2, key: ctx.params.id }))
  .get("/res3", async (ctx) => json({ id: 3, key: "res3" }))
  .post("/res4/:id", async (ctx) => json({ id: 4, key: ctx.params.id }))
  .routeNode("PUT", "/res5", withValidation(async (b: Body) => json({ id: 5, name: b.name, qty: b.qty }), bodySchema))
  .get("/res6/:id", async (ctx) => json({ id: 6, key: ctx.params.id }))
  .post("/res7", async (ctx) => json({ id: 7, key: "res7" }))
  .put("/res8/:id", async (ctx) => json({ id: 8, key: ctx.params.id }))
  .get("/res9", async (ctx) => json({ id: 9, key: "res9" }))

const api = client(app)
const r0 = api["/res0/:id"].get({ params: { id: "1" } })
void r0.then((v) => v)
const r1 = api["/res1"].post({ body: { name: "x", qty: 1 } })
void r1.then((v) => v)
const r2 = api["/res2/:id"].put({ params: { id: "1" } })
void r2.then((v) => v)
const r3 = api["/res3"].get()
void r3.then((v) => v)
const r5 = api["/res5"].put({ body: { name: "x", qty: 1 } })
void r5.then((v) => v)
const r6 = api["/res6/:id"].get({ params: { id: "1" } })
void r6.then((v) => v)
const r7 = api["/res7"].post()
void r7.then((v) => v)
const r9 = api["/res9"].get()
void r9.then((v) => v)
