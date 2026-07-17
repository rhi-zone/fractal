import { json, withValidation } from "@rhi-zone/fractal-http"
import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-api-tree"

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
const h0 = async (ctx: Ctx<"/res0/:id">) => json({ id: 0, key: ctx.params.id })
const h1 = withValidation(async (b: Body) => json({ id: 1, name: b.name, qty: b.qty }), bodySchema)
const h2 = async (ctx: Ctx<"/res2/:id">) => json({ id: 2, key: ctx.params.id })
const h3 = async (ctx: Ctx<"/res3">) => json({ id: 3, key: "res3" })
const h4 = async (ctx: Ctx<"/res4/:id">) => json({ id: 4, key: ctx.params.id })
const h5 = withValidation(async (b: Body) => json({ id: 5, name: b.name, qty: b.qty }), bodySchema)
const h6 = async (ctx: Ctx<"/res6/:id">) => json({ id: 6, key: ctx.params.id })
const h7 = async (ctx: Ctx<"/res7">) => json({ id: 7, key: "res7" })
const h8 = async (ctx: Ctx<"/res8/:id">) => json({ id: 8, key: ctx.params.id })
const h9 = async (ctx: Ctx<"/res9">) => json({ id: 9, key: "res9" })

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
