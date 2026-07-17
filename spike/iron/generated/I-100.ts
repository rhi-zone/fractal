import { choice, route, path, lit, param, json } from "../http.ts"
import { client } from "../client.ts"
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
  route("POST", path(lit("res10"), param("id")), async (ctx) => json({ id: 10, key: ctx.params.id })),
  route("PUT", path(lit("res11")), async (ctx) => json({ id: 11, key: "res11" })),
  route("GET", path(lit("res12"), param("id")), async (ctx) => json({ id: 12, key: ctx.params.id })),
  route("POST", path(lit("res13")), bodySchema, async (ctx) => json({ id: 13, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res14"), param("id")), async (ctx) => json({ id: 14, key: ctx.params.id })),
  route("GET", path(lit("res15")), async (ctx) => json({ id: 15, key: "res15" })),
  route("POST", path(lit("res16"), param("id")), async (ctx) => json({ id: 16, key: ctx.params.id })),
  route("PUT", path(lit("res17")), bodySchema, async (ctx) => json({ id: 17, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res18"), param("id")), async (ctx) => json({ id: 18, key: ctx.params.id })),
  route("POST", path(lit("res19")), async (ctx) => json({ id: 19, key: "res19" })),
  route("PUT", path(lit("res20"), param("id")), async (ctx) => json({ id: 20, key: ctx.params.id })),
  route("GET", path(lit("res21")), async (ctx) => json({ id: 21, key: "res21" })),
  route("POST", path(lit("res22"), param("id")), async (ctx) => json({ id: 22, key: ctx.params.id })),
  route("PUT", path(lit("res23")), async (ctx) => json({ id: 23, key: "res23" })),
  route("GET", path(lit("res24"), param("id")), async (ctx) => json({ id: 24, key: ctx.params.id })),
  route("POST", path(lit("res25")), bodySchema, async (ctx) => json({ id: 25, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res26"), param("id")), async (ctx) => json({ id: 26, key: ctx.params.id })),
  route("GET", path(lit("res27")), async (ctx) => json({ id: 27, key: "res27" })),
  route("POST", path(lit("res28"), param("id")), async (ctx) => json({ id: 28, key: ctx.params.id })),
  route("PUT", path(lit("res29")), bodySchema, async (ctx) => json({ id: 29, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res30"), param("id")), async (ctx) => json({ id: 30, key: ctx.params.id })),
  route("POST", path(lit("res31")), async (ctx) => json({ id: 31, key: "res31" })),
  route("PUT", path(lit("res32"), param("id")), async (ctx) => json({ id: 32, key: ctx.params.id })),
  route("GET", path(lit("res33")), async (ctx) => json({ id: 33, key: "res33" })),
  route("POST", path(lit("res34"), param("id")), async (ctx) => json({ id: 34, key: ctx.params.id })),
  route("PUT", path(lit("res35")), async (ctx) => json({ id: 35, key: "res35" })),
  route("GET", path(lit("res36"), param("id")), async (ctx) => json({ id: 36, key: ctx.params.id })),
  route("POST", path(lit("res37")), bodySchema, async (ctx) => json({ id: 37, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res38"), param("id")), async (ctx) => json({ id: 38, key: ctx.params.id })),
  route("GET", path(lit("res39")), async (ctx) => json({ id: 39, key: "res39" })),
  route("POST", path(lit("res40"), param("id")), async (ctx) => json({ id: 40, key: ctx.params.id })),
  route("PUT", path(lit("res41")), bodySchema, async (ctx) => json({ id: 41, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res42"), param("id")), async (ctx) => json({ id: 42, key: ctx.params.id })),
  route("POST", path(lit("res43")), async (ctx) => json({ id: 43, key: "res43" })),
  route("PUT", path(lit("res44"), param("id")), async (ctx) => json({ id: 44, key: ctx.params.id })),
  route("GET", path(lit("res45")), async (ctx) => json({ id: 45, key: "res45" })),
  route("POST", path(lit("res46"), param("id")), async (ctx) => json({ id: 46, key: ctx.params.id })),
  route("PUT", path(lit("res47")), async (ctx) => json({ id: 47, key: "res47" })),
  route("GET", path(lit("res48"), param("id")), async (ctx) => json({ id: 48, key: ctx.params.id })),
  route("POST", path(lit("res49")), bodySchema, async (ctx) => json({ id: 49, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res50"), param("id")), async (ctx) => json({ id: 50, key: ctx.params.id })),
  route("GET", path(lit("res51")), async (ctx) => json({ id: 51, key: "res51" })),
  route("POST", path(lit("res52"), param("id")), async (ctx) => json({ id: 52, key: ctx.params.id })),
  route("PUT", path(lit("res53")), bodySchema, async (ctx) => json({ id: 53, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res54"), param("id")), async (ctx) => json({ id: 54, key: ctx.params.id })),
  route("POST", path(lit("res55")), async (ctx) => json({ id: 55, key: "res55" })),
  route("PUT", path(lit("res56"), param("id")), async (ctx) => json({ id: 56, key: ctx.params.id })),
  route("GET", path(lit("res57")), async (ctx) => json({ id: 57, key: "res57" })),
  route("POST", path(lit("res58"), param("id")), async (ctx) => json({ id: 58, key: ctx.params.id })),
  route("PUT", path(lit("res59")), async (ctx) => json({ id: 59, key: "res59" })),
  route("GET", path(lit("res60"), param("id")), async (ctx) => json({ id: 60, key: ctx.params.id })),
  route("POST", path(lit("res61")), bodySchema, async (ctx) => json({ id: 61, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res62"), param("id")), async (ctx) => json({ id: 62, key: ctx.params.id })),
  route("GET", path(lit("res63")), async (ctx) => json({ id: 63, key: "res63" })),
  route("POST", path(lit("res64"), param("id")), async (ctx) => json({ id: 64, key: ctx.params.id })),
  route("PUT", path(lit("res65")), bodySchema, async (ctx) => json({ id: 65, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res66"), param("id")), async (ctx) => json({ id: 66, key: ctx.params.id })),
  route("POST", path(lit("res67")), async (ctx) => json({ id: 67, key: "res67" })),
  route("PUT", path(lit("res68"), param("id")), async (ctx) => json({ id: 68, key: ctx.params.id })),
  route("GET", path(lit("res69")), async (ctx) => json({ id: 69, key: "res69" })),
  route("POST", path(lit("res70"), param("id")), async (ctx) => json({ id: 70, key: ctx.params.id })),
  route("PUT", path(lit("res71")), async (ctx) => json({ id: 71, key: "res71" })),
  route("GET", path(lit("res72"), param("id")), async (ctx) => json({ id: 72, key: ctx.params.id })),
  route("POST", path(lit("res73")), bodySchema, async (ctx) => json({ id: 73, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res74"), param("id")), async (ctx) => json({ id: 74, key: ctx.params.id })),
  route("GET", path(lit("res75")), async (ctx) => json({ id: 75, key: "res75" })),
  route("POST", path(lit("res76"), param("id")), async (ctx) => json({ id: 76, key: ctx.params.id })),
  route("PUT", path(lit("res77")), bodySchema, async (ctx) => json({ id: 77, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res78"), param("id")), async (ctx) => json({ id: 78, key: ctx.params.id })),
  route("POST", path(lit("res79")), async (ctx) => json({ id: 79, key: "res79" })),
  route("PUT", path(lit("res80"), param("id")), async (ctx) => json({ id: 80, key: ctx.params.id })),
  route("GET", path(lit("res81")), async (ctx) => json({ id: 81, key: "res81" })),
  route("POST", path(lit("res82"), param("id")), async (ctx) => json({ id: 82, key: ctx.params.id })),
  route("PUT", path(lit("res83")), async (ctx) => json({ id: 83, key: "res83" })),
  route("GET", path(lit("res84"), param("id")), async (ctx) => json({ id: 84, key: ctx.params.id })),
  route("POST", path(lit("res85")), bodySchema, async (ctx) => json({ id: 85, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res86"), param("id")), async (ctx) => json({ id: 86, key: ctx.params.id })),
  route("GET", path(lit("res87")), async (ctx) => json({ id: 87, key: "res87" })),
  route("POST", path(lit("res88"), param("id")), async (ctx) => json({ id: 88, key: ctx.params.id })),
  route("PUT", path(lit("res89")), bodySchema, async (ctx) => json({ id: 89, name: ctx.input.name, qty: ctx.input.qty })),
  route("GET", path(lit("res90"), param("id")), async (ctx) => json({ id: 90, key: ctx.params.id })),
  route("POST", path(lit("res91")), async (ctx) => json({ id: 91, key: "res91" })),
  route("PUT", path(lit("res92"), param("id")), async (ctx) => json({ id: 92, key: ctx.params.id })),
  route("GET", path(lit("res93")), async (ctx) => json({ id: 93, key: "res93" })),
  route("POST", path(lit("res94"), param("id")), async (ctx) => json({ id: 94, key: ctx.params.id })),
  route("PUT", path(lit("res95")), async (ctx) => json({ id: 95, key: "res95" })),
  route("GET", path(lit("res96"), param("id")), async (ctx) => json({ id: 96, key: ctx.params.id })),
  route("POST", path(lit("res97")), bodySchema, async (ctx) => json({ id: 97, name: ctx.input.name, qty: ctx.input.qty })),
  route("PUT", path(lit("res98"), param("id")), async (ctx) => json({ id: 98, key: ctx.params.id })),
  route("GET", path(lit("res99")), async (ctx) => json({ id: 99, key: "res99" })),
)

const api = client(app)
const r0 = api["/res0/{id}"].get({ params: { id: "1" } })
void r0.then((v) => v)
const r14 = api["/res14/{id}"].put({ params: { id: "1" } })
void r14.then((v) => v)
const r28 = api["/res28/{id}"].post({ params: { id: "1" } })
void r28.then((v) => v)
const r42 = api["/res42/{id}"].get({ params: { id: "1" } })
void r42.then((v) => v)
const r56 = api["/res56/{id}"].put({ params: { id: "1" } })
void r56.then((v) => v)
const r70 = api["/res70/{id}"].post({ params: { id: "1" } })
void r70.then((v) => v)
const r84 = api["/res84/{id}"].get({ params: { id: "1" } })
void r84.then((v) => v)
const r99 = api["/res99"].get()
void r99.then((v) => v)
