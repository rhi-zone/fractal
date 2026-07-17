import { lit, param, path, route } from "../router.ts"
import { json } from "../http.ts"
import type { StandardSchema } from "@rhi-zone/fractal-api-tree"

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

const h0 = route("GET", path(lit("res0"), param("id")), async (ctx) => json({ id: 0, key: ctx.params.id }))
const h1 = route("POST", path(lit("res1")), bodySchema, async (ctx) => json({ id: 1, name: ctx.body.name, qty: ctx.body.qty }))
const h2 = route("PUT", path(lit("res2"), param("id")), async (ctx) => json({ id: 2, key: ctx.params.id }))
const h3 = route("GET", path(lit("res3")), async (ctx) => json({ id: 3, key: "res3" }))
const h4 = route("POST", path(lit("res4"), param("id")), async (ctx) => json({ id: 4, key: ctx.params.id }))
const h5 = route("PUT", path(lit("res5")), bodySchema, async (ctx) => json({ id: 5, name: ctx.body.name, qty: ctx.body.qty }))
const h6 = route("GET", path(lit("res6"), param("id")), async (ctx) => json({ id: 6, key: ctx.params.id }))
const h7 = route("POST", path(lit("res7")), async (ctx) => json({ id: 7, key: "res7" }))
const h8 = route("PUT", path(lit("res8"), param("id")), async (ctx) => json({ id: 8, key: ctx.params.id }))
const h9 = route("GET", path(lit("res9")), async (ctx) => json({ id: 9, key: "res9" }))

void [
  h0,
  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  h7,
  h8,
  h9,
]
