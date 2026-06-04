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
  "/res10/:id": {
    post: async (ctx: Ctx<"/res10/:id">) => json({ id: 10, key: ctx.params.id }),
  },
  "/res11": {
    put: async (ctx: Ctx<"/res11">) => json({ id: 11, key: "res11" }),
  },
  "/res12/:id": {
    get: async (ctx: Ctx<"/res12/:id">) => json({ id: 12, key: ctx.params.id }),
  },
  "/res13": {
    post: withValidation(async (b: Body) => json({ id: 13, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res14/:id": {
    put: async (ctx: Ctx<"/res14/:id">) => json({ id: 14, key: ctx.params.id }),
  },
  "/res15": {
    get: async (ctx: Ctx<"/res15">) => json({ id: 15, key: "res15" }),
  },
  "/res16/:id": {
    post: async (ctx: Ctx<"/res16/:id">) => json({ id: 16, key: ctx.params.id }),
  },
  "/res17": {
    put: withValidation(async (b: Body) => json({ id: 17, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res18/:id": {
    get: async (ctx: Ctx<"/res18/:id">) => json({ id: 18, key: ctx.params.id }),
  },
  "/res19": {
    post: async (ctx: Ctx<"/res19">) => json({ id: 19, key: "res19" }),
  },
  "/res20/:id": {
    put: async (ctx: Ctx<"/res20/:id">) => json({ id: 20, key: ctx.params.id }),
  },
  "/res21": {
    get: async (ctx: Ctx<"/res21">) => json({ id: 21, key: "res21" }),
  },
  "/res22/:id": {
    post: async (ctx: Ctx<"/res22/:id">) => json({ id: 22, key: ctx.params.id }),
  },
  "/res23": {
    put: async (ctx: Ctx<"/res23">) => json({ id: 23, key: "res23" }),
  },
  "/res24/:id": {
    get: async (ctx: Ctx<"/res24/:id">) => json({ id: 24, key: ctx.params.id }),
  },
  "/res25": {
    post: withValidation(async (b: Body) => json({ id: 25, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res26/:id": {
    put: async (ctx: Ctx<"/res26/:id">) => json({ id: 26, key: ctx.params.id }),
  },
  "/res27": {
    get: async (ctx: Ctx<"/res27">) => json({ id: 27, key: "res27" }),
  },
  "/res28/:id": {
    post: async (ctx: Ctx<"/res28/:id">) => json({ id: 28, key: ctx.params.id }),
  },
  "/res29": {
    put: withValidation(async (b: Body) => json({ id: 29, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res30/:id": {
    get: async (ctx: Ctx<"/res30/:id">) => json({ id: 30, key: ctx.params.id }),
  },
  "/res31": {
    post: async (ctx: Ctx<"/res31">) => json({ id: 31, key: "res31" }),
  },
  "/res32/:id": {
    put: async (ctx: Ctx<"/res32/:id">) => json({ id: 32, key: ctx.params.id }),
  },
  "/res33": {
    get: async (ctx: Ctx<"/res33">) => json({ id: 33, key: "res33" }),
  },
  "/res34/:id": {
    post: async (ctx: Ctx<"/res34/:id">) => json({ id: 34, key: ctx.params.id }),
  },
  "/res35": {
    put: async (ctx: Ctx<"/res35">) => json({ id: 35, key: "res35" }),
  },
  "/res36/:id": {
    get: async (ctx: Ctx<"/res36/:id">) => json({ id: 36, key: ctx.params.id }),
  },
  "/res37": {
    post: withValidation(async (b: Body) => json({ id: 37, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res38/:id": {
    put: async (ctx: Ctx<"/res38/:id">) => json({ id: 38, key: ctx.params.id }),
  },
  "/res39": {
    get: async (ctx: Ctx<"/res39">) => json({ id: 39, key: "res39" }),
  },
  "/res40/:id": {
    post: async (ctx: Ctx<"/res40/:id">) => json({ id: 40, key: ctx.params.id }),
  },
  "/res41": {
    put: withValidation(async (b: Body) => json({ id: 41, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res42/:id": {
    get: async (ctx: Ctx<"/res42/:id">) => json({ id: 42, key: ctx.params.id }),
  },
  "/res43": {
    post: async (ctx: Ctx<"/res43">) => json({ id: 43, key: "res43" }),
  },
  "/res44/:id": {
    put: async (ctx: Ctx<"/res44/:id">) => json({ id: 44, key: ctx.params.id }),
  },
  "/res45": {
    get: async (ctx: Ctx<"/res45">) => json({ id: 45, key: "res45" }),
  },
  "/res46/:id": {
    post: async (ctx: Ctx<"/res46/:id">) => json({ id: 46, key: ctx.params.id }),
  },
  "/res47": {
    put: async (ctx: Ctx<"/res47">) => json({ id: 47, key: "res47" }),
  },
  "/res48/:id": {
    get: async (ctx: Ctx<"/res48/:id">) => json({ id: 48, key: ctx.params.id }),
  },
  "/res49": {
    post: withValidation(async (b: Body) => json({ id: 49, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res50/:id": {
    put: async (ctx: Ctx<"/res50/:id">) => json({ id: 50, key: ctx.params.id }),
  },
  "/res51": {
    get: async (ctx: Ctx<"/res51">) => json({ id: 51, key: "res51" }),
  },
  "/res52/:id": {
    post: async (ctx: Ctx<"/res52/:id">) => json({ id: 52, key: ctx.params.id }),
  },
  "/res53": {
    put: withValidation(async (b: Body) => json({ id: 53, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res54/:id": {
    get: async (ctx: Ctx<"/res54/:id">) => json({ id: 54, key: ctx.params.id }),
  },
  "/res55": {
    post: async (ctx: Ctx<"/res55">) => json({ id: 55, key: "res55" }),
  },
  "/res56/:id": {
    put: async (ctx: Ctx<"/res56/:id">) => json({ id: 56, key: ctx.params.id }),
  },
  "/res57": {
    get: async (ctx: Ctx<"/res57">) => json({ id: 57, key: "res57" }),
  },
  "/res58/:id": {
    post: async (ctx: Ctx<"/res58/:id">) => json({ id: 58, key: ctx.params.id }),
  },
  "/res59": {
    put: async (ctx: Ctx<"/res59">) => json({ id: 59, key: "res59" }),
  },
  "/res60/:id": {
    get: async (ctx: Ctx<"/res60/:id">) => json({ id: 60, key: ctx.params.id }),
  },
  "/res61": {
    post: withValidation(async (b: Body) => json({ id: 61, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res62/:id": {
    put: async (ctx: Ctx<"/res62/:id">) => json({ id: 62, key: ctx.params.id }),
  },
  "/res63": {
    get: async (ctx: Ctx<"/res63">) => json({ id: 63, key: "res63" }),
  },
  "/res64/:id": {
    post: async (ctx: Ctx<"/res64/:id">) => json({ id: 64, key: ctx.params.id }),
  },
  "/res65": {
    put: withValidation(async (b: Body) => json({ id: 65, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res66/:id": {
    get: async (ctx: Ctx<"/res66/:id">) => json({ id: 66, key: ctx.params.id }),
  },
  "/res67": {
    post: async (ctx: Ctx<"/res67">) => json({ id: 67, key: "res67" }),
  },
  "/res68/:id": {
    put: async (ctx: Ctx<"/res68/:id">) => json({ id: 68, key: ctx.params.id }),
  },
  "/res69": {
    get: async (ctx: Ctx<"/res69">) => json({ id: 69, key: "res69" }),
  },
  "/res70/:id": {
    post: async (ctx: Ctx<"/res70/:id">) => json({ id: 70, key: ctx.params.id }),
  },
  "/res71": {
    put: async (ctx: Ctx<"/res71">) => json({ id: 71, key: "res71" }),
  },
  "/res72/:id": {
    get: async (ctx: Ctx<"/res72/:id">) => json({ id: 72, key: ctx.params.id }),
  },
  "/res73": {
    post: withValidation(async (b: Body) => json({ id: 73, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res74/:id": {
    put: async (ctx: Ctx<"/res74/:id">) => json({ id: 74, key: ctx.params.id }),
  },
  "/res75": {
    get: async (ctx: Ctx<"/res75">) => json({ id: 75, key: "res75" }),
  },
  "/res76/:id": {
    post: async (ctx: Ctx<"/res76/:id">) => json({ id: 76, key: ctx.params.id }),
  },
  "/res77": {
    put: withValidation(async (b: Body) => json({ id: 77, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res78/:id": {
    get: async (ctx: Ctx<"/res78/:id">) => json({ id: 78, key: ctx.params.id }),
  },
  "/res79": {
    post: async (ctx: Ctx<"/res79">) => json({ id: 79, key: "res79" }),
  },
  "/res80/:id": {
    put: async (ctx: Ctx<"/res80/:id">) => json({ id: 80, key: ctx.params.id }),
  },
  "/res81": {
    get: async (ctx: Ctx<"/res81">) => json({ id: 81, key: "res81" }),
  },
  "/res82/:id": {
    post: async (ctx: Ctx<"/res82/:id">) => json({ id: 82, key: ctx.params.id }),
  },
  "/res83": {
    put: async (ctx: Ctx<"/res83">) => json({ id: 83, key: "res83" }),
  },
  "/res84/:id": {
    get: async (ctx: Ctx<"/res84/:id">) => json({ id: 84, key: ctx.params.id }),
  },
  "/res85": {
    post: withValidation(async (b: Body) => json({ id: 85, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res86/:id": {
    put: async (ctx: Ctx<"/res86/:id">) => json({ id: 86, key: ctx.params.id }),
  },
  "/res87": {
    get: async (ctx: Ctx<"/res87">) => json({ id: 87, key: "res87" }),
  },
  "/res88/:id": {
    post: async (ctx: Ctx<"/res88/:id">) => json({ id: 88, key: ctx.params.id }),
  },
  "/res89": {
    put: withValidation(async (b: Body) => json({ id: 89, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res90/:id": {
    get: async (ctx: Ctx<"/res90/:id">) => json({ id: 90, key: ctx.params.id }),
  },
  "/res91": {
    post: async (ctx: Ctx<"/res91">) => json({ id: 91, key: "res91" }),
  },
  "/res92/:id": {
    put: async (ctx: Ctx<"/res92/:id">) => json({ id: 92, key: ctx.params.id }),
  },
  "/res93": {
    get: async (ctx: Ctx<"/res93">) => json({ id: 93, key: "res93" }),
  },
  "/res94/:id": {
    post: async (ctx: Ctx<"/res94/:id">) => json({ id: 94, key: ctx.params.id }),
  },
  "/res95": {
    put: async (ctx: Ctx<"/res95">) => json({ id: 95, key: "res95" }),
  },
  "/res96/:id": {
    get: async (ctx: Ctx<"/res96/:id">) => json({ id: 96, key: ctx.params.id }),
  },
  "/res97": {
    post: withValidation(async (b: Body) => json({ id: 97, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res98/:id": {
    put: async (ctx: Ctx<"/res98/:id">) => json({ id: 98, key: ctx.params.id }),
  },
  "/res99": {
    get: async (ctx: Ctx<"/res99">) => json({ id: 99, key: "res99" }),
  },
} as const

type Api = ClientOfContract<typeof contract>
declare const api: Api
const r0 = api["/res0/:id"].get({ params: { id: "1" } })
void r0.then((v) => v)
const r14 = api["/res14/:id"].put({ params: { id: "1" } })
void r14.then((v) => v)
const r28 = api["/res28/:id"].post({ params: { id: "1" } })
void r28.then((v) => v)
const r42 = api["/res42/:id"].get({ params: { id: "1" } })
void r42.then((v) => v)
const r56 = api["/res56/:id"].put({ params: { id: "1" } })
void r56.then((v) => v)
const r70 = api["/res70/:id"].post({ params: { id: "1" } })
void r70.then((v) => v)
const r84 = api["/res84/:id"].get({ params: { id: "1" } })
void r84.then((v) => v)
const r99 = api["/res99"].get()
void r99.then((v) => v)
