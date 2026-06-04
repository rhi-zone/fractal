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
  "/res100/:id": {
    post: async (ctx: Ctx<"/res100/:id">) => json({ id: 100, key: ctx.params.id }),
  },
  "/res101": {
    put: withValidation(async (b: Body) => json({ id: 101, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res102/:id": {
    get: async (ctx: Ctx<"/res102/:id">) => json({ id: 102, key: ctx.params.id }),
  },
  "/res103": {
    post: async (ctx: Ctx<"/res103">) => json({ id: 103, key: "res103" }),
  },
  "/res104/:id": {
    put: async (ctx: Ctx<"/res104/:id">) => json({ id: 104, key: ctx.params.id }),
  },
  "/res105": {
    get: async (ctx: Ctx<"/res105">) => json({ id: 105, key: "res105" }),
  },
  "/res106/:id": {
    post: async (ctx: Ctx<"/res106/:id">) => json({ id: 106, key: ctx.params.id }),
  },
  "/res107": {
    put: async (ctx: Ctx<"/res107">) => json({ id: 107, key: "res107" }),
  },
  "/res108/:id": {
    get: async (ctx: Ctx<"/res108/:id">) => json({ id: 108, key: ctx.params.id }),
  },
  "/res109": {
    post: withValidation(async (b: Body) => json({ id: 109, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res110/:id": {
    put: async (ctx: Ctx<"/res110/:id">) => json({ id: 110, key: ctx.params.id }),
  },
  "/res111": {
    get: async (ctx: Ctx<"/res111">) => json({ id: 111, key: "res111" }),
  },
  "/res112/:id": {
    post: async (ctx: Ctx<"/res112/:id">) => json({ id: 112, key: ctx.params.id }),
  },
  "/res113": {
    put: withValidation(async (b: Body) => json({ id: 113, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res114/:id": {
    get: async (ctx: Ctx<"/res114/:id">) => json({ id: 114, key: ctx.params.id }),
  },
  "/res115": {
    post: async (ctx: Ctx<"/res115">) => json({ id: 115, key: "res115" }),
  },
  "/res116/:id": {
    put: async (ctx: Ctx<"/res116/:id">) => json({ id: 116, key: ctx.params.id }),
  },
  "/res117": {
    get: async (ctx: Ctx<"/res117">) => json({ id: 117, key: "res117" }),
  },
  "/res118/:id": {
    post: async (ctx: Ctx<"/res118/:id">) => json({ id: 118, key: ctx.params.id }),
  },
  "/res119": {
    put: async (ctx: Ctx<"/res119">) => json({ id: 119, key: "res119" }),
  },
  "/res120/:id": {
    get: async (ctx: Ctx<"/res120/:id">) => json({ id: 120, key: ctx.params.id }),
  },
  "/res121": {
    post: withValidation(async (b: Body) => json({ id: 121, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res122/:id": {
    put: async (ctx: Ctx<"/res122/:id">) => json({ id: 122, key: ctx.params.id }),
  },
  "/res123": {
    get: async (ctx: Ctx<"/res123">) => json({ id: 123, key: "res123" }),
  },
  "/res124/:id": {
    post: async (ctx: Ctx<"/res124/:id">) => json({ id: 124, key: ctx.params.id }),
  },
  "/res125": {
    put: withValidation(async (b: Body) => json({ id: 125, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res126/:id": {
    get: async (ctx: Ctx<"/res126/:id">) => json({ id: 126, key: ctx.params.id }),
  },
  "/res127": {
    post: async (ctx: Ctx<"/res127">) => json({ id: 127, key: "res127" }),
  },
  "/res128/:id": {
    put: async (ctx: Ctx<"/res128/:id">) => json({ id: 128, key: ctx.params.id }),
  },
  "/res129": {
    get: async (ctx: Ctx<"/res129">) => json({ id: 129, key: "res129" }),
  },
  "/res130/:id": {
    post: async (ctx: Ctx<"/res130/:id">) => json({ id: 130, key: ctx.params.id }),
  },
  "/res131": {
    put: async (ctx: Ctx<"/res131">) => json({ id: 131, key: "res131" }),
  },
  "/res132/:id": {
    get: async (ctx: Ctx<"/res132/:id">) => json({ id: 132, key: ctx.params.id }),
  },
  "/res133": {
    post: withValidation(async (b: Body) => json({ id: 133, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res134/:id": {
    put: async (ctx: Ctx<"/res134/:id">) => json({ id: 134, key: ctx.params.id }),
  },
  "/res135": {
    get: async (ctx: Ctx<"/res135">) => json({ id: 135, key: "res135" }),
  },
  "/res136/:id": {
    post: async (ctx: Ctx<"/res136/:id">) => json({ id: 136, key: ctx.params.id }),
  },
  "/res137": {
    put: withValidation(async (b: Body) => json({ id: 137, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res138/:id": {
    get: async (ctx: Ctx<"/res138/:id">) => json({ id: 138, key: ctx.params.id }),
  },
  "/res139": {
    post: async (ctx: Ctx<"/res139">) => json({ id: 139, key: "res139" }),
  },
  "/res140/:id": {
    put: async (ctx: Ctx<"/res140/:id">) => json({ id: 140, key: ctx.params.id }),
  },
  "/res141": {
    get: async (ctx: Ctx<"/res141">) => json({ id: 141, key: "res141" }),
  },
  "/res142/:id": {
    post: async (ctx: Ctx<"/res142/:id">) => json({ id: 142, key: ctx.params.id }),
  },
  "/res143": {
    put: async (ctx: Ctx<"/res143">) => json({ id: 143, key: "res143" }),
  },
  "/res144/:id": {
    get: async (ctx: Ctx<"/res144/:id">) => json({ id: 144, key: ctx.params.id }),
  },
  "/res145": {
    post: withValidation(async (b: Body) => json({ id: 145, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res146/:id": {
    put: async (ctx: Ctx<"/res146/:id">) => json({ id: 146, key: ctx.params.id }),
  },
  "/res147": {
    get: async (ctx: Ctx<"/res147">) => json({ id: 147, key: "res147" }),
  },
  "/res148/:id": {
    post: async (ctx: Ctx<"/res148/:id">) => json({ id: 148, key: ctx.params.id }),
  },
  "/res149": {
    put: withValidation(async (b: Body) => json({ id: 149, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res150/:id": {
    get: async (ctx: Ctx<"/res150/:id">) => json({ id: 150, key: ctx.params.id }),
  },
  "/res151": {
    post: async (ctx: Ctx<"/res151">) => json({ id: 151, key: "res151" }),
  },
  "/res152/:id": {
    put: async (ctx: Ctx<"/res152/:id">) => json({ id: 152, key: ctx.params.id }),
  },
  "/res153": {
    get: async (ctx: Ctx<"/res153">) => json({ id: 153, key: "res153" }),
  },
  "/res154/:id": {
    post: async (ctx: Ctx<"/res154/:id">) => json({ id: 154, key: ctx.params.id }),
  },
  "/res155": {
    put: async (ctx: Ctx<"/res155">) => json({ id: 155, key: "res155" }),
  },
  "/res156/:id": {
    get: async (ctx: Ctx<"/res156/:id">) => json({ id: 156, key: ctx.params.id }),
  },
  "/res157": {
    post: withValidation(async (b: Body) => json({ id: 157, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res158/:id": {
    put: async (ctx: Ctx<"/res158/:id">) => json({ id: 158, key: ctx.params.id }),
  },
  "/res159": {
    get: async (ctx: Ctx<"/res159">) => json({ id: 159, key: "res159" }),
  },
  "/res160/:id": {
    post: async (ctx: Ctx<"/res160/:id">) => json({ id: 160, key: ctx.params.id }),
  },
  "/res161": {
    put: withValidation(async (b: Body) => json({ id: 161, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res162/:id": {
    get: async (ctx: Ctx<"/res162/:id">) => json({ id: 162, key: ctx.params.id }),
  },
  "/res163": {
    post: async (ctx: Ctx<"/res163">) => json({ id: 163, key: "res163" }),
  },
  "/res164/:id": {
    put: async (ctx: Ctx<"/res164/:id">) => json({ id: 164, key: ctx.params.id }),
  },
  "/res165": {
    get: async (ctx: Ctx<"/res165">) => json({ id: 165, key: "res165" }),
  },
  "/res166/:id": {
    post: async (ctx: Ctx<"/res166/:id">) => json({ id: 166, key: ctx.params.id }),
  },
  "/res167": {
    put: async (ctx: Ctx<"/res167">) => json({ id: 167, key: "res167" }),
  },
  "/res168/:id": {
    get: async (ctx: Ctx<"/res168/:id">) => json({ id: 168, key: ctx.params.id }),
  },
  "/res169": {
    post: withValidation(async (b: Body) => json({ id: 169, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res170/:id": {
    put: async (ctx: Ctx<"/res170/:id">) => json({ id: 170, key: ctx.params.id }),
  },
  "/res171": {
    get: async (ctx: Ctx<"/res171">) => json({ id: 171, key: "res171" }),
  },
  "/res172/:id": {
    post: async (ctx: Ctx<"/res172/:id">) => json({ id: 172, key: ctx.params.id }),
  },
  "/res173": {
    put: withValidation(async (b: Body) => json({ id: 173, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res174/:id": {
    get: async (ctx: Ctx<"/res174/:id">) => json({ id: 174, key: ctx.params.id }),
  },
  "/res175": {
    post: async (ctx: Ctx<"/res175">) => json({ id: 175, key: "res175" }),
  },
  "/res176/:id": {
    put: async (ctx: Ctx<"/res176/:id">) => json({ id: 176, key: ctx.params.id }),
  },
  "/res177": {
    get: async (ctx: Ctx<"/res177">) => json({ id: 177, key: "res177" }),
  },
  "/res178/:id": {
    post: async (ctx: Ctx<"/res178/:id">) => json({ id: 178, key: ctx.params.id }),
  },
  "/res179": {
    put: async (ctx: Ctx<"/res179">) => json({ id: 179, key: "res179" }),
  },
  "/res180/:id": {
    get: async (ctx: Ctx<"/res180/:id">) => json({ id: 180, key: ctx.params.id }),
  },
  "/res181": {
    post: withValidation(async (b: Body) => json({ id: 181, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res182/:id": {
    put: async (ctx: Ctx<"/res182/:id">) => json({ id: 182, key: ctx.params.id }),
  },
  "/res183": {
    get: async (ctx: Ctx<"/res183">) => json({ id: 183, key: "res183" }),
  },
  "/res184/:id": {
    post: async (ctx: Ctx<"/res184/:id">) => json({ id: 184, key: ctx.params.id }),
  },
  "/res185": {
    put: withValidation(async (b: Body) => json({ id: 185, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res186/:id": {
    get: async (ctx: Ctx<"/res186/:id">) => json({ id: 186, key: ctx.params.id }),
  },
  "/res187": {
    post: async (ctx: Ctx<"/res187">) => json({ id: 187, key: "res187" }),
  },
  "/res188/:id": {
    put: async (ctx: Ctx<"/res188/:id">) => json({ id: 188, key: ctx.params.id }),
  },
  "/res189": {
    get: async (ctx: Ctx<"/res189">) => json({ id: 189, key: "res189" }),
  },
  "/res190/:id": {
    post: async (ctx: Ctx<"/res190/:id">) => json({ id: 190, key: ctx.params.id }),
  },
  "/res191": {
    put: async (ctx: Ctx<"/res191">) => json({ id: 191, key: "res191" }),
  },
  "/res192/:id": {
    get: async (ctx: Ctx<"/res192/:id">) => json({ id: 192, key: ctx.params.id }),
  },
  "/res193": {
    post: withValidation(async (b: Body) => json({ id: 193, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res194/:id": {
    put: async (ctx: Ctx<"/res194/:id">) => json({ id: 194, key: ctx.params.id }),
  },
  "/res195": {
    get: async (ctx: Ctx<"/res195">) => json({ id: 195, key: "res195" }),
  },
  "/res196/:id": {
    post: async (ctx: Ctx<"/res196/:id">) => json({ id: 196, key: ctx.params.id }),
  },
  "/res197": {
    put: withValidation(async (b: Body) => json({ id: 197, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res198/:id": {
    get: async (ctx: Ctx<"/res198/:id">) => json({ id: 198, key: ctx.params.id }),
  },
  "/res199": {
    post: async (ctx: Ctx<"/res199">) => json({ id: 199, key: "res199" }),
  },
  "/res200/:id": {
    put: async (ctx: Ctx<"/res200/:id">) => json({ id: 200, key: ctx.params.id }),
  },
  "/res201": {
    get: async (ctx: Ctx<"/res201">) => json({ id: 201, key: "res201" }),
  },
  "/res202/:id": {
    post: async (ctx: Ctx<"/res202/:id">) => json({ id: 202, key: ctx.params.id }),
  },
  "/res203": {
    put: async (ctx: Ctx<"/res203">) => json({ id: 203, key: "res203" }),
  },
  "/res204/:id": {
    get: async (ctx: Ctx<"/res204/:id">) => json({ id: 204, key: ctx.params.id }),
  },
  "/res205": {
    post: withValidation(async (b: Body) => json({ id: 205, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res206/:id": {
    put: async (ctx: Ctx<"/res206/:id">) => json({ id: 206, key: ctx.params.id }),
  },
  "/res207": {
    get: async (ctx: Ctx<"/res207">) => json({ id: 207, key: "res207" }),
  },
  "/res208/:id": {
    post: async (ctx: Ctx<"/res208/:id">) => json({ id: 208, key: ctx.params.id }),
  },
  "/res209": {
    put: withValidation(async (b: Body) => json({ id: 209, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res210/:id": {
    get: async (ctx: Ctx<"/res210/:id">) => json({ id: 210, key: ctx.params.id }),
  },
  "/res211": {
    post: async (ctx: Ctx<"/res211">) => json({ id: 211, key: "res211" }),
  },
  "/res212/:id": {
    put: async (ctx: Ctx<"/res212/:id">) => json({ id: 212, key: ctx.params.id }),
  },
  "/res213": {
    get: async (ctx: Ctx<"/res213">) => json({ id: 213, key: "res213" }),
  },
  "/res214/:id": {
    post: async (ctx: Ctx<"/res214/:id">) => json({ id: 214, key: ctx.params.id }),
  },
  "/res215": {
    put: async (ctx: Ctx<"/res215">) => json({ id: 215, key: "res215" }),
  },
  "/res216/:id": {
    get: async (ctx: Ctx<"/res216/:id">) => json({ id: 216, key: ctx.params.id }),
  },
  "/res217": {
    post: withValidation(async (b: Body) => json({ id: 217, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res218/:id": {
    put: async (ctx: Ctx<"/res218/:id">) => json({ id: 218, key: ctx.params.id }),
  },
  "/res219": {
    get: async (ctx: Ctx<"/res219">) => json({ id: 219, key: "res219" }),
  },
  "/res220/:id": {
    post: async (ctx: Ctx<"/res220/:id">) => json({ id: 220, key: ctx.params.id }),
  },
  "/res221": {
    put: withValidation(async (b: Body) => json({ id: 221, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res222/:id": {
    get: async (ctx: Ctx<"/res222/:id">) => json({ id: 222, key: ctx.params.id }),
  },
  "/res223": {
    post: async (ctx: Ctx<"/res223">) => json({ id: 223, key: "res223" }),
  },
  "/res224/:id": {
    put: async (ctx: Ctx<"/res224/:id">) => json({ id: 224, key: ctx.params.id }),
  },
  "/res225": {
    get: async (ctx: Ctx<"/res225">) => json({ id: 225, key: "res225" }),
  },
  "/res226/:id": {
    post: async (ctx: Ctx<"/res226/:id">) => json({ id: 226, key: ctx.params.id }),
  },
  "/res227": {
    put: async (ctx: Ctx<"/res227">) => json({ id: 227, key: "res227" }),
  },
  "/res228/:id": {
    get: async (ctx: Ctx<"/res228/:id">) => json({ id: 228, key: ctx.params.id }),
  },
  "/res229": {
    post: withValidation(async (b: Body) => json({ id: 229, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res230/:id": {
    put: async (ctx: Ctx<"/res230/:id">) => json({ id: 230, key: ctx.params.id }),
  },
  "/res231": {
    get: async (ctx: Ctx<"/res231">) => json({ id: 231, key: "res231" }),
  },
  "/res232/:id": {
    post: async (ctx: Ctx<"/res232/:id">) => json({ id: 232, key: ctx.params.id }),
  },
  "/res233": {
    put: withValidation(async (b: Body) => json({ id: 233, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res234/:id": {
    get: async (ctx: Ctx<"/res234/:id">) => json({ id: 234, key: ctx.params.id }),
  },
  "/res235": {
    post: async (ctx: Ctx<"/res235">) => json({ id: 235, key: "res235" }),
  },
  "/res236/:id": {
    put: async (ctx: Ctx<"/res236/:id">) => json({ id: 236, key: ctx.params.id }),
  },
  "/res237": {
    get: async (ctx: Ctx<"/res237">) => json({ id: 237, key: "res237" }),
  },
  "/res238/:id": {
    post: async (ctx: Ctx<"/res238/:id">) => json({ id: 238, key: ctx.params.id }),
  },
  "/res239": {
    put: async (ctx: Ctx<"/res239">) => json({ id: 239, key: "res239" }),
  },
  "/res240/:id": {
    get: async (ctx: Ctx<"/res240/:id">) => json({ id: 240, key: ctx.params.id }),
  },
  "/res241": {
    post: withValidation(async (b: Body) => json({ id: 241, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res242/:id": {
    put: async (ctx: Ctx<"/res242/:id">) => json({ id: 242, key: ctx.params.id }),
  },
  "/res243": {
    get: async (ctx: Ctx<"/res243">) => json({ id: 243, key: "res243" }),
  },
  "/res244/:id": {
    post: async (ctx: Ctx<"/res244/:id">) => json({ id: 244, key: ctx.params.id }),
  },
  "/res245": {
    put: withValidation(async (b: Body) => json({ id: 245, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res246/:id": {
    get: async (ctx: Ctx<"/res246/:id">) => json({ id: 246, key: ctx.params.id }),
  },
  "/res247": {
    post: async (ctx: Ctx<"/res247">) => json({ id: 247, key: "res247" }),
  },
  "/res248/:id": {
    put: async (ctx: Ctx<"/res248/:id">) => json({ id: 248, key: ctx.params.id }),
  },
  "/res249": {
    get: async (ctx: Ctx<"/res249">) => json({ id: 249, key: "res249" }),
  },
  "/res250/:id": {
    post: async (ctx: Ctx<"/res250/:id">) => json({ id: 250, key: ctx.params.id }),
  },
  "/res251": {
    put: async (ctx: Ctx<"/res251">) => json({ id: 251, key: "res251" }),
  },
  "/res252/:id": {
    get: async (ctx: Ctx<"/res252/:id">) => json({ id: 252, key: ctx.params.id }),
  },
  "/res253": {
    post: withValidation(async (b: Body) => json({ id: 253, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res254/:id": {
    put: async (ctx: Ctx<"/res254/:id">) => json({ id: 254, key: ctx.params.id }),
  },
  "/res255": {
    get: async (ctx: Ctx<"/res255">) => json({ id: 255, key: "res255" }),
  },
  "/res256/:id": {
    post: async (ctx: Ctx<"/res256/:id">) => json({ id: 256, key: ctx.params.id }),
  },
  "/res257": {
    put: withValidation(async (b: Body) => json({ id: 257, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res258/:id": {
    get: async (ctx: Ctx<"/res258/:id">) => json({ id: 258, key: ctx.params.id }),
  },
  "/res259": {
    post: async (ctx: Ctx<"/res259">) => json({ id: 259, key: "res259" }),
  },
  "/res260/:id": {
    put: async (ctx: Ctx<"/res260/:id">) => json({ id: 260, key: ctx.params.id }),
  },
  "/res261": {
    get: async (ctx: Ctx<"/res261">) => json({ id: 261, key: "res261" }),
  },
  "/res262/:id": {
    post: async (ctx: Ctx<"/res262/:id">) => json({ id: 262, key: ctx.params.id }),
  },
  "/res263": {
    put: async (ctx: Ctx<"/res263">) => json({ id: 263, key: "res263" }),
  },
  "/res264/:id": {
    get: async (ctx: Ctx<"/res264/:id">) => json({ id: 264, key: ctx.params.id }),
  },
  "/res265": {
    post: withValidation(async (b: Body) => json({ id: 265, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res266/:id": {
    put: async (ctx: Ctx<"/res266/:id">) => json({ id: 266, key: ctx.params.id }),
  },
  "/res267": {
    get: async (ctx: Ctx<"/res267">) => json({ id: 267, key: "res267" }),
  },
  "/res268/:id": {
    post: async (ctx: Ctx<"/res268/:id">) => json({ id: 268, key: ctx.params.id }),
  },
  "/res269": {
    put: withValidation(async (b: Body) => json({ id: 269, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res270/:id": {
    get: async (ctx: Ctx<"/res270/:id">) => json({ id: 270, key: ctx.params.id }),
  },
  "/res271": {
    post: async (ctx: Ctx<"/res271">) => json({ id: 271, key: "res271" }),
  },
  "/res272/:id": {
    put: async (ctx: Ctx<"/res272/:id">) => json({ id: 272, key: ctx.params.id }),
  },
  "/res273": {
    get: async (ctx: Ctx<"/res273">) => json({ id: 273, key: "res273" }),
  },
  "/res274/:id": {
    post: async (ctx: Ctx<"/res274/:id">) => json({ id: 274, key: ctx.params.id }),
  },
  "/res275": {
    put: async (ctx: Ctx<"/res275">) => json({ id: 275, key: "res275" }),
  },
  "/res276/:id": {
    get: async (ctx: Ctx<"/res276/:id">) => json({ id: 276, key: ctx.params.id }),
  },
  "/res277": {
    post: withValidation(async (b: Body) => json({ id: 277, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res278/:id": {
    put: async (ctx: Ctx<"/res278/:id">) => json({ id: 278, key: ctx.params.id }),
  },
  "/res279": {
    get: async (ctx: Ctx<"/res279">) => json({ id: 279, key: "res279" }),
  },
  "/res280/:id": {
    post: async (ctx: Ctx<"/res280/:id">) => json({ id: 280, key: ctx.params.id }),
  },
  "/res281": {
    put: withValidation(async (b: Body) => json({ id: 281, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res282/:id": {
    get: async (ctx: Ctx<"/res282/:id">) => json({ id: 282, key: ctx.params.id }),
  },
  "/res283": {
    post: async (ctx: Ctx<"/res283">) => json({ id: 283, key: "res283" }),
  },
  "/res284/:id": {
    put: async (ctx: Ctx<"/res284/:id">) => json({ id: 284, key: ctx.params.id }),
  },
  "/res285": {
    get: async (ctx: Ctx<"/res285">) => json({ id: 285, key: "res285" }),
  },
  "/res286/:id": {
    post: async (ctx: Ctx<"/res286/:id">) => json({ id: 286, key: ctx.params.id }),
  },
  "/res287": {
    put: async (ctx: Ctx<"/res287">) => json({ id: 287, key: "res287" }),
  },
  "/res288/:id": {
    get: async (ctx: Ctx<"/res288/:id">) => json({ id: 288, key: ctx.params.id }),
  },
  "/res289": {
    post: withValidation(async (b: Body) => json({ id: 289, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res290/:id": {
    put: async (ctx: Ctx<"/res290/:id">) => json({ id: 290, key: ctx.params.id }),
  },
  "/res291": {
    get: async (ctx: Ctx<"/res291">) => json({ id: 291, key: "res291" }),
  },
  "/res292/:id": {
    post: async (ctx: Ctx<"/res292/:id">) => json({ id: 292, key: ctx.params.id }),
  },
  "/res293": {
    put: withValidation(async (b: Body) => json({ id: 293, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res294/:id": {
    get: async (ctx: Ctx<"/res294/:id">) => json({ id: 294, key: ctx.params.id }),
  },
  "/res295": {
    post: async (ctx: Ctx<"/res295">) => json({ id: 295, key: "res295" }),
  },
  "/res296/:id": {
    put: async (ctx: Ctx<"/res296/:id">) => json({ id: 296, key: ctx.params.id }),
  },
  "/res297": {
    get: async (ctx: Ctx<"/res297">) => json({ id: 297, key: "res297" }),
  },
  "/res298/:id": {
    post: async (ctx: Ctx<"/res298/:id">) => json({ id: 298, key: ctx.params.id }),
  },
  "/res299": {
    put: async (ctx: Ctx<"/res299">) => json({ id: 299, key: "res299" }),
  },
} as const

type Api = ClientOfContract<typeof contract>
declare const api: Api
const r0 = api["/res0/:id"].get({ params: { id: "1" } })
void r0.then((v) => v)
const r42 = api["/res42/:id"].get({ params: { id: "1" } })
void r42.then((v) => v)
const r85 = api["/res85"].post({ body: { name: "x", qty: 1 } })
void r85.then((v) => v)
const r128 = api["/res128/:id"].put({ params: { id: "1" } })
void r128.then((v) => v)
const r170 = api["/res170/:id"].put({ params: { id: "1" } })
void r170.then((v) => v)
const r213 = api["/res213"].get()
void r213.then((v) => v)
const r256 = api["/res256/:id"].post({ params: { id: "1" } })
void r256.then((v) => v)
const r299 = api["/res299"].put()
void r299.then((v) => v)
