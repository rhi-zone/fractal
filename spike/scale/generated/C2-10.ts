import { json, withValidation } from "@rhi-zone/fractal-http"
import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-core"
import { buildClient, defineRoute } from "../contract"

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

const r0 = defineRoute("GET", "/res0/:id", async (ctx: Ctx<"/res0/:id">) => json({ id: 0, key: ctx.params.id }))
const r1 = defineRoute("POST", "/res1", withValidation(async (b: Body) => json({ id: 1, name: b.name, qty: b.qty }), bodySchema))
const r2 = defineRoute("PUT", "/res2/:id", async (ctx: Ctx<"/res2/:id">) => json({ id: 2, key: ctx.params.id }))
const r3 = defineRoute("GET", "/res3", async (ctx: Ctx<"/res3">) => json({ id: 3, key: "res3" }))
const r4 = defineRoute("POST", "/res4/:id", async (ctx: Ctx<"/res4/:id">) => json({ id: 4, key: ctx.params.id }))
const r5 = defineRoute("PUT", "/res5", withValidation(async (b: Body) => json({ id: 5, name: b.name, qty: b.qty }), bodySchema))
const r6 = defineRoute("GET", "/res6/:id", async (ctx: Ctx<"/res6/:id">) => json({ id: 6, key: ctx.params.id }))
const r7 = defineRoute("POST", "/res7", async (ctx: Ctx<"/res7">) => json({ id: 7, key: "res7" }))
const r8 = defineRoute("PUT", "/res8/:id", async (ctx: Ctx<"/res8/:id">) => json({ id: 8, key: ctx.params.id }))
const r9 = defineRoute("GET", "/res9", async (ctx: Ctx<"/res9">) => json({ id: 9, key: "res9" }))

const api = buildClient([r0, r1, r2, r3, r4, r5, r6, r7, r8, r9])
const probe0 = api["/res0/:id"].get({ params: { id: "1" } })
void probe0.then((v) => v)
const probe1 = api["/res1"].post({ body: { name: "x", qty: 1 } })
void probe1.then((v) => v)
const probe2 = api["/res2/:id"].put({ params: { id: "1" } })
void probe2.then((v) => v)
const probe3 = api["/res3"].get()
void probe3.then((v) => v)
const probe5 = api["/res5"].put({ body: { name: "x", qty: 1 } })
void probe5.then((v) => v)
const probe6 = api["/res6/:id"].get({ params: { id: "1" } })
void probe6.then((v) => v)
const probe7 = api["/res7"].post()
void probe7.then((v) => v)
const probe9 = api["/res9"].get()
void probe9.then((v) => v)
