import { choice, route, path, lit, param, json } from "../http.ts"
import { client } from "../client.ts"
import type { StandardSchema } from "@rhi-zone/fractal-core"

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

const app = choice(
  route("GET", path(lit("res0"), param("id")), async (ctx) => json({ id: 0, key: ctx.params.id })),
  route("POST", path(lit("res1")), bodySchema, async (ctx) => json({ id: 1, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res2"), param("id")), async (ctx) => json({ id: 2, key: ctx.params.id })),
  route("GET", path(lit("res3")), async (ctx) => json({ id: 3, key: "res3" })),
  route("POST", path(lit("res4"), param("id")), async (ctx) => json({ id: 4, key: ctx.params.id })),
  route("PUT", path(lit("res5")), bodySchema, async (ctx) => json({ id: 5, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res6"), param("id")), async (ctx) => json({ id: 6, key: ctx.params.id })),
  route("POST", path(lit("res7")), async (ctx) => json({ id: 7, key: "res7" })),
  route("PUT", path(lit("res8"), param("id")), async (ctx) => json({ id: 8, key: ctx.params.id })),
  route("GET", path(lit("res9")), async (ctx) => json({ id: 9, key: "res9" })),
)

const api = client(app)
const r0 = api["/res0/{id}"].get({ params: { id: "1" } })
void r0.then((v) => v)
const r1 = api["/res1"].post({ body: { name: "x", qty: 1 } })
void r1.then((v) => v)
const r2 = api["/res2/{id}"].put({ params: { id: "1" } })
void r2.then((v) => v)
const r3 = api["/res3"].get()
void r3.then((v) => v)
const r5 = api["/res5"].put({ body: { name: "x", qty: 1 } })
void r5.then((v) => v)
const r6 = api["/res6/{id}"].get({ params: { id: "1" } })
void r6.then((v) => v)
const r7 = api["/res7"].post()
void r7.then((v) => v)
const r9 = api["/res9"].get()
void r9.then((v) => v)
