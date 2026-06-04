import { json, withValidation } from "@rhi-zone/fractal-http"
import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-core"
import type { ClientOfContract } from "../contract"

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

type Ctx<P extends string> = RoutingCtx & { params: PathParams<P> } & {
  query: URLSearchParams; headers: Headers; body: () => Promise<unknown>; request: Request
}

const contract = {
  "/res0/:id": {
    get: async (ctx: Ctx<"/res0/:id">) => json({ id: 0, key: ctx.params.id }),
  },
  "/res1": {
    post: withValidation(async (b: Body) => json({ id: 1, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res2/:id": {
    put: async (ctx: Ctx<"/res2/:id">) => json({ id: 2, key: ctx.params.id }),
  },
  "/res3": {
    get: async (ctx: Ctx<"/res3">) => json({ id: 3, key: "res3" }),
  },
  "/res4/:id": {
    post: async (ctx: Ctx<"/res4/:id">) => json({ id: 4, key: ctx.params.id }),
  },
  "/res5": {
    put: withValidation(async (b: Body) => json({ id: 5, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res6/:id": {
    get: async (ctx: Ctx<"/res6/:id">) => json({ id: 6, key: ctx.params.id }),
  },
  "/res7": {
    post: async (ctx: Ctx<"/res7">) => json({ id: 7, key: "res7" }),
  },
  "/res8/:id": {
    put: async (ctx: Ctx<"/res8/:id">) => json({ id: 8, key: ctx.params.id }),
  },
  "/res9": {
    get: async (ctx: Ctx<"/res9">) => json({ id: 9, key: "res9" }),
  },
} as const

type Api = ClientOfContract<typeof contract>
declare const api: Api
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
