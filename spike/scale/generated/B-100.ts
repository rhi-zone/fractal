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
const h10 = async (ctx: Ctx<"/res10/:id">) => json({ id: 10, key: ctx.params.id })
const h11 = async (ctx: Ctx<"/res11">) => json({ id: 11, key: "res11" })
const h12 = async (ctx: Ctx<"/res12/:id">) => json({ id: 12, key: ctx.params.id })
const h13 = withValidation(async (b: Body) => json({ id: 13, name: b.name, qty: b.qty }), bodySchema)
const h14 = async (ctx: Ctx<"/res14/:id">) => json({ id: 14, key: ctx.params.id })
const h15 = async (ctx: Ctx<"/res15">) => json({ id: 15, key: "res15" })
const h16 = async (ctx: Ctx<"/res16/:id">) => json({ id: 16, key: ctx.params.id })
const h17 = withValidation(async (b: Body) => json({ id: 17, name: b.name, qty: b.qty }), bodySchema)
const h18 = async (ctx: Ctx<"/res18/:id">) => json({ id: 18, key: ctx.params.id })
const h19 = async (ctx: Ctx<"/res19">) => json({ id: 19, key: "res19" })
const h20 = async (ctx: Ctx<"/res20/:id">) => json({ id: 20, key: ctx.params.id })
const h21 = async (ctx: Ctx<"/res21">) => json({ id: 21, key: "res21" })
const h22 = async (ctx: Ctx<"/res22/:id">) => json({ id: 22, key: ctx.params.id })
const h23 = async (ctx: Ctx<"/res23">) => json({ id: 23, key: "res23" })
const h24 = async (ctx: Ctx<"/res24/:id">) => json({ id: 24, key: ctx.params.id })
const h25 = withValidation(async (b: Body) => json({ id: 25, name: b.name, qty: b.qty }), bodySchema)
const h26 = async (ctx: Ctx<"/res26/:id">) => json({ id: 26, key: ctx.params.id })
const h27 = async (ctx: Ctx<"/res27">) => json({ id: 27, key: "res27" })
const h28 = async (ctx: Ctx<"/res28/:id">) => json({ id: 28, key: ctx.params.id })
const h29 = withValidation(async (b: Body) => json({ id: 29, name: b.name, qty: b.qty }), bodySchema)
const h30 = async (ctx: Ctx<"/res30/:id">) => json({ id: 30, key: ctx.params.id })
const h31 = async (ctx: Ctx<"/res31">) => json({ id: 31, key: "res31" })
const h32 = async (ctx: Ctx<"/res32/:id">) => json({ id: 32, key: ctx.params.id })
const h33 = async (ctx: Ctx<"/res33">) => json({ id: 33, key: "res33" })
const h34 = async (ctx: Ctx<"/res34/:id">) => json({ id: 34, key: ctx.params.id })
const h35 = async (ctx: Ctx<"/res35">) => json({ id: 35, key: "res35" })
const h36 = async (ctx: Ctx<"/res36/:id">) => json({ id: 36, key: ctx.params.id })
const h37 = withValidation(async (b: Body) => json({ id: 37, name: b.name, qty: b.qty }), bodySchema)
const h38 = async (ctx: Ctx<"/res38/:id">) => json({ id: 38, key: ctx.params.id })
const h39 = async (ctx: Ctx<"/res39">) => json({ id: 39, key: "res39" })
const h40 = async (ctx: Ctx<"/res40/:id">) => json({ id: 40, key: ctx.params.id })
const h41 = withValidation(async (b: Body) => json({ id: 41, name: b.name, qty: b.qty }), bodySchema)
const h42 = async (ctx: Ctx<"/res42/:id">) => json({ id: 42, key: ctx.params.id })
const h43 = async (ctx: Ctx<"/res43">) => json({ id: 43, key: "res43" })
const h44 = async (ctx: Ctx<"/res44/:id">) => json({ id: 44, key: ctx.params.id })
const h45 = async (ctx: Ctx<"/res45">) => json({ id: 45, key: "res45" })
const h46 = async (ctx: Ctx<"/res46/:id">) => json({ id: 46, key: ctx.params.id })
const h47 = async (ctx: Ctx<"/res47">) => json({ id: 47, key: "res47" })
const h48 = async (ctx: Ctx<"/res48/:id">) => json({ id: 48, key: ctx.params.id })
const h49 = withValidation(async (b: Body) => json({ id: 49, name: b.name, qty: b.qty }), bodySchema)
const h50 = async (ctx: Ctx<"/res50/:id">) => json({ id: 50, key: ctx.params.id })
const h51 = async (ctx: Ctx<"/res51">) => json({ id: 51, key: "res51" })
const h52 = async (ctx: Ctx<"/res52/:id">) => json({ id: 52, key: ctx.params.id })
const h53 = withValidation(async (b: Body) => json({ id: 53, name: b.name, qty: b.qty }), bodySchema)
const h54 = async (ctx: Ctx<"/res54/:id">) => json({ id: 54, key: ctx.params.id })
const h55 = async (ctx: Ctx<"/res55">) => json({ id: 55, key: "res55" })
const h56 = async (ctx: Ctx<"/res56/:id">) => json({ id: 56, key: ctx.params.id })
const h57 = async (ctx: Ctx<"/res57">) => json({ id: 57, key: "res57" })
const h58 = async (ctx: Ctx<"/res58/:id">) => json({ id: 58, key: ctx.params.id })
const h59 = async (ctx: Ctx<"/res59">) => json({ id: 59, key: "res59" })
const h60 = async (ctx: Ctx<"/res60/:id">) => json({ id: 60, key: ctx.params.id })
const h61 = withValidation(async (b: Body) => json({ id: 61, name: b.name, qty: b.qty }), bodySchema)
const h62 = async (ctx: Ctx<"/res62/:id">) => json({ id: 62, key: ctx.params.id })
const h63 = async (ctx: Ctx<"/res63">) => json({ id: 63, key: "res63" })
const h64 = async (ctx: Ctx<"/res64/:id">) => json({ id: 64, key: ctx.params.id })
const h65 = withValidation(async (b: Body) => json({ id: 65, name: b.name, qty: b.qty }), bodySchema)
const h66 = async (ctx: Ctx<"/res66/:id">) => json({ id: 66, key: ctx.params.id })
const h67 = async (ctx: Ctx<"/res67">) => json({ id: 67, key: "res67" })
const h68 = async (ctx: Ctx<"/res68/:id">) => json({ id: 68, key: ctx.params.id })
const h69 = async (ctx: Ctx<"/res69">) => json({ id: 69, key: "res69" })
const h70 = async (ctx: Ctx<"/res70/:id">) => json({ id: 70, key: ctx.params.id })
const h71 = async (ctx: Ctx<"/res71">) => json({ id: 71, key: "res71" })
const h72 = async (ctx: Ctx<"/res72/:id">) => json({ id: 72, key: ctx.params.id })
const h73 = withValidation(async (b: Body) => json({ id: 73, name: b.name, qty: b.qty }), bodySchema)
const h74 = async (ctx: Ctx<"/res74/:id">) => json({ id: 74, key: ctx.params.id })
const h75 = async (ctx: Ctx<"/res75">) => json({ id: 75, key: "res75" })
const h76 = async (ctx: Ctx<"/res76/:id">) => json({ id: 76, key: ctx.params.id })
const h77 = withValidation(async (b: Body) => json({ id: 77, name: b.name, qty: b.qty }), bodySchema)
const h78 = async (ctx: Ctx<"/res78/:id">) => json({ id: 78, key: ctx.params.id })
const h79 = async (ctx: Ctx<"/res79">) => json({ id: 79, key: "res79" })
const h80 = async (ctx: Ctx<"/res80/:id">) => json({ id: 80, key: ctx.params.id })
const h81 = async (ctx: Ctx<"/res81">) => json({ id: 81, key: "res81" })
const h82 = async (ctx: Ctx<"/res82/:id">) => json({ id: 82, key: ctx.params.id })
const h83 = async (ctx: Ctx<"/res83">) => json({ id: 83, key: "res83" })
const h84 = async (ctx: Ctx<"/res84/:id">) => json({ id: 84, key: ctx.params.id })
const h85 = withValidation(async (b: Body) => json({ id: 85, name: b.name, qty: b.qty }), bodySchema)
const h86 = async (ctx: Ctx<"/res86/:id">) => json({ id: 86, key: ctx.params.id })
const h87 = async (ctx: Ctx<"/res87">) => json({ id: 87, key: "res87" })
const h88 = async (ctx: Ctx<"/res88/:id">) => json({ id: 88, key: ctx.params.id })
const h89 = withValidation(async (b: Body) => json({ id: 89, name: b.name, qty: b.qty }), bodySchema)
const h90 = async (ctx: Ctx<"/res90/:id">) => json({ id: 90, key: ctx.params.id })
const h91 = async (ctx: Ctx<"/res91">) => json({ id: 91, key: "res91" })
const h92 = async (ctx: Ctx<"/res92/:id">) => json({ id: 92, key: ctx.params.id })
const h93 = async (ctx: Ctx<"/res93">) => json({ id: 93, key: "res93" })
const h94 = async (ctx: Ctx<"/res94/:id">) => json({ id: 94, key: ctx.params.id })
const h95 = async (ctx: Ctx<"/res95">) => json({ id: 95, key: "res95" })
const h96 = async (ctx: Ctx<"/res96/:id">) => json({ id: 96, key: ctx.params.id })
const h97 = withValidation(async (b: Body) => json({ id: 97, name: b.name, qty: b.qty }), bodySchema)
const h98 = async (ctx: Ctx<"/res98/:id">) => json({ id: 98, key: ctx.params.id })
const h99 = async (ctx: Ctx<"/res99">) => json({ id: 99, key: "res99" })

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
  h10,
  h11,
  h12,
  h13,
  h14,
  h15,
  h16,
  h17,
  h18,
  h19,
  h20,
  h21,
  h22,
  h23,
  h24,
  h25,
  h26,
  h27,
  h28,
  h29,
  h30,
  h31,
  h32,
  h33,
  h34,
  h35,
  h36,
  h37,
  h38,
  h39,
  h40,
  h41,
  h42,
  h43,
  h44,
  h45,
  h46,
  h47,
  h48,
  h49,
  h50,
  h51,
  h52,
  h53,
  h54,
  h55,
  h56,
  h57,
  h58,
  h59,
  h60,
  h61,
  h62,
  h63,
  h64,
  h65,
  h66,
  h67,
  h68,
  h69,
  h70,
  h71,
  h72,
  h73,
  h74,
  h75,
  h76,
  h77,
  h78,
  h79,
  h80,
  h81,
  h82,
  h83,
  h84,
  h85,
  h86,
  h87,
  h88,
  h89,
  h90,
  h91,
  h92,
  h93,
  h94,
  h95,
  h96,
  h97,
  h98,
  h99,
]
