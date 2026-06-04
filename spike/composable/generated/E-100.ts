import { lit, param, path, route } from "../router.ts"
import { json } from "../http.ts"
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
const h10 = route("POST", path(lit("res10"), param("id")), async (ctx) => json({ id: 10, key: ctx.params.id }))
const h11 = route("PUT", path(lit("res11")), async (ctx) => json({ id: 11, key: "res11" }))
const h12 = route("GET", path(lit("res12"), param("id")), async (ctx) => json({ id: 12, key: ctx.params.id }))
const h13 = route("POST", path(lit("res13")), bodySchema, async (ctx) => json({ id: 13, name: ctx.body.name, qty: ctx.body.qty }))
const h14 = route("PUT", path(lit("res14"), param("id")), async (ctx) => json({ id: 14, key: ctx.params.id }))
const h15 = route("GET", path(lit("res15")), async (ctx) => json({ id: 15, key: "res15" }))
const h16 = route("POST", path(lit("res16"), param("id")), async (ctx) => json({ id: 16, key: ctx.params.id }))
const h17 = route("PUT", path(lit("res17")), bodySchema, async (ctx) => json({ id: 17, name: ctx.body.name, qty: ctx.body.qty }))
const h18 = route("GET", path(lit("res18"), param("id")), async (ctx) => json({ id: 18, key: ctx.params.id }))
const h19 = route("POST", path(lit("res19")), async (ctx) => json({ id: 19, key: "res19" }))
const h20 = route("PUT", path(lit("res20"), param("id")), async (ctx) => json({ id: 20, key: ctx.params.id }))
const h21 = route("GET", path(lit("res21")), async (ctx) => json({ id: 21, key: "res21" }))
const h22 = route("POST", path(lit("res22"), param("id")), async (ctx) => json({ id: 22, key: ctx.params.id }))
const h23 = route("PUT", path(lit("res23")), async (ctx) => json({ id: 23, key: "res23" }))
const h24 = route("GET", path(lit("res24"), param("id")), async (ctx) => json({ id: 24, key: ctx.params.id }))
const h25 = route("POST", path(lit("res25")), bodySchema, async (ctx) => json({ id: 25, name: ctx.body.name, qty: ctx.body.qty }))
const h26 = route("PUT", path(lit("res26"), param("id")), async (ctx) => json({ id: 26, key: ctx.params.id }))
const h27 = route("GET", path(lit("res27")), async (ctx) => json({ id: 27, key: "res27" }))
const h28 = route("POST", path(lit("res28"), param("id")), async (ctx) => json({ id: 28, key: ctx.params.id }))
const h29 = route("PUT", path(lit("res29")), bodySchema, async (ctx) => json({ id: 29, name: ctx.body.name, qty: ctx.body.qty }))
const h30 = route("GET", path(lit("res30"), param("id")), async (ctx) => json({ id: 30, key: ctx.params.id }))
const h31 = route("POST", path(lit("res31")), async (ctx) => json({ id: 31, key: "res31" }))
const h32 = route("PUT", path(lit("res32"), param("id")), async (ctx) => json({ id: 32, key: ctx.params.id }))
const h33 = route("GET", path(lit("res33")), async (ctx) => json({ id: 33, key: "res33" }))
const h34 = route("POST", path(lit("res34"), param("id")), async (ctx) => json({ id: 34, key: ctx.params.id }))
const h35 = route("PUT", path(lit("res35")), async (ctx) => json({ id: 35, key: "res35" }))
const h36 = route("GET", path(lit("res36"), param("id")), async (ctx) => json({ id: 36, key: ctx.params.id }))
const h37 = route("POST", path(lit("res37")), bodySchema, async (ctx) => json({ id: 37, name: ctx.body.name, qty: ctx.body.qty }))
const h38 = route("PUT", path(lit("res38"), param("id")), async (ctx) => json({ id: 38, key: ctx.params.id }))
const h39 = route("GET", path(lit("res39")), async (ctx) => json({ id: 39, key: "res39" }))
const h40 = route("POST", path(lit("res40"), param("id")), async (ctx) => json({ id: 40, key: ctx.params.id }))
const h41 = route("PUT", path(lit("res41")), bodySchema, async (ctx) => json({ id: 41, name: ctx.body.name, qty: ctx.body.qty }))
const h42 = route("GET", path(lit("res42"), param("id")), async (ctx) => json({ id: 42, key: ctx.params.id }))
const h43 = route("POST", path(lit("res43")), async (ctx) => json({ id: 43, key: "res43" }))
const h44 = route("PUT", path(lit("res44"), param("id")), async (ctx) => json({ id: 44, key: ctx.params.id }))
const h45 = route("GET", path(lit("res45")), async (ctx) => json({ id: 45, key: "res45" }))
const h46 = route("POST", path(lit("res46"), param("id")), async (ctx) => json({ id: 46, key: ctx.params.id }))
const h47 = route("PUT", path(lit("res47")), async (ctx) => json({ id: 47, key: "res47" }))
const h48 = route("GET", path(lit("res48"), param("id")), async (ctx) => json({ id: 48, key: ctx.params.id }))
const h49 = route("POST", path(lit("res49")), bodySchema, async (ctx) => json({ id: 49, name: ctx.body.name, qty: ctx.body.qty }))
const h50 = route("PUT", path(lit("res50"), param("id")), async (ctx) => json({ id: 50, key: ctx.params.id }))
const h51 = route("GET", path(lit("res51")), async (ctx) => json({ id: 51, key: "res51" }))
const h52 = route("POST", path(lit("res52"), param("id")), async (ctx) => json({ id: 52, key: ctx.params.id }))
const h53 = route("PUT", path(lit("res53")), bodySchema, async (ctx) => json({ id: 53, name: ctx.body.name, qty: ctx.body.qty }))
const h54 = route("GET", path(lit("res54"), param("id")), async (ctx) => json({ id: 54, key: ctx.params.id }))
const h55 = route("POST", path(lit("res55")), async (ctx) => json({ id: 55, key: "res55" }))
const h56 = route("PUT", path(lit("res56"), param("id")), async (ctx) => json({ id: 56, key: ctx.params.id }))
const h57 = route("GET", path(lit("res57")), async (ctx) => json({ id: 57, key: "res57" }))
const h58 = route("POST", path(lit("res58"), param("id")), async (ctx) => json({ id: 58, key: ctx.params.id }))
const h59 = route("PUT", path(lit("res59")), async (ctx) => json({ id: 59, key: "res59" }))
const h60 = route("GET", path(lit("res60"), param("id")), async (ctx) => json({ id: 60, key: ctx.params.id }))
const h61 = route("POST", path(lit("res61")), bodySchema, async (ctx) => json({ id: 61, name: ctx.body.name, qty: ctx.body.qty }))
const h62 = route("PUT", path(lit("res62"), param("id")), async (ctx) => json({ id: 62, key: ctx.params.id }))
const h63 = route("GET", path(lit("res63")), async (ctx) => json({ id: 63, key: "res63" }))
const h64 = route("POST", path(lit("res64"), param("id")), async (ctx) => json({ id: 64, key: ctx.params.id }))
const h65 = route("PUT", path(lit("res65")), bodySchema, async (ctx) => json({ id: 65, name: ctx.body.name, qty: ctx.body.qty }))
const h66 = route("GET", path(lit("res66"), param("id")), async (ctx) => json({ id: 66, key: ctx.params.id }))
const h67 = route("POST", path(lit("res67")), async (ctx) => json({ id: 67, key: "res67" }))
const h68 = route("PUT", path(lit("res68"), param("id")), async (ctx) => json({ id: 68, key: ctx.params.id }))
const h69 = route("GET", path(lit("res69")), async (ctx) => json({ id: 69, key: "res69" }))
const h70 = route("POST", path(lit("res70"), param("id")), async (ctx) => json({ id: 70, key: ctx.params.id }))
const h71 = route("PUT", path(lit("res71")), async (ctx) => json({ id: 71, key: "res71" }))
const h72 = route("GET", path(lit("res72"), param("id")), async (ctx) => json({ id: 72, key: ctx.params.id }))
const h73 = route("POST", path(lit("res73")), bodySchema, async (ctx) => json({ id: 73, name: ctx.body.name, qty: ctx.body.qty }))
const h74 = route("PUT", path(lit("res74"), param("id")), async (ctx) => json({ id: 74, key: ctx.params.id }))
const h75 = route("GET", path(lit("res75")), async (ctx) => json({ id: 75, key: "res75" }))
const h76 = route("POST", path(lit("res76"), param("id")), async (ctx) => json({ id: 76, key: ctx.params.id }))
const h77 = route("PUT", path(lit("res77")), bodySchema, async (ctx) => json({ id: 77, name: ctx.body.name, qty: ctx.body.qty }))
const h78 = route("GET", path(lit("res78"), param("id")), async (ctx) => json({ id: 78, key: ctx.params.id }))
const h79 = route("POST", path(lit("res79")), async (ctx) => json({ id: 79, key: "res79" }))
const h80 = route("PUT", path(lit("res80"), param("id")), async (ctx) => json({ id: 80, key: ctx.params.id }))
const h81 = route("GET", path(lit("res81")), async (ctx) => json({ id: 81, key: "res81" }))
const h82 = route("POST", path(lit("res82"), param("id")), async (ctx) => json({ id: 82, key: ctx.params.id }))
const h83 = route("PUT", path(lit("res83")), async (ctx) => json({ id: 83, key: "res83" }))
const h84 = route("GET", path(lit("res84"), param("id")), async (ctx) => json({ id: 84, key: ctx.params.id }))
const h85 = route("POST", path(lit("res85")), bodySchema, async (ctx) => json({ id: 85, name: ctx.body.name, qty: ctx.body.qty }))
const h86 = route("PUT", path(lit("res86"), param("id")), async (ctx) => json({ id: 86, key: ctx.params.id }))
const h87 = route("GET", path(lit("res87")), async (ctx) => json({ id: 87, key: "res87" }))
const h88 = route("POST", path(lit("res88"), param("id")), async (ctx) => json({ id: 88, key: ctx.params.id }))
const h89 = route("PUT", path(lit("res89")), bodySchema, async (ctx) => json({ id: 89, name: ctx.body.name, qty: ctx.body.qty }))
const h90 = route("GET", path(lit("res90"), param("id")), async (ctx) => json({ id: 90, key: ctx.params.id }))
const h91 = route("POST", path(lit("res91")), async (ctx) => json({ id: 91, key: "res91" }))
const h92 = route("PUT", path(lit("res92"), param("id")), async (ctx) => json({ id: 92, key: ctx.params.id }))
const h93 = route("GET", path(lit("res93")), async (ctx) => json({ id: 93, key: "res93" }))
const h94 = route("POST", path(lit("res94"), param("id")), async (ctx) => json({ id: 94, key: ctx.params.id }))
const h95 = route("PUT", path(lit("res95")), async (ctx) => json({ id: 95, key: "res95" }))
const h96 = route("GET", path(lit("res96"), param("id")), async (ctx) => json({ id: 96, key: ctx.params.id }))
const h97 = route("POST", path(lit("res97")), bodySchema, async (ctx) => json({ id: 97, name: ctx.body.name, qty: ctx.body.qty }))
const h98 = route("PUT", path(lit("res98"), param("id")), async (ctx) => json({ id: 98, key: ctx.params.id }))
const h99 = route("GET", path(lit("res99")), async (ctx) => json({ id: 99, key: "res99" }))

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
