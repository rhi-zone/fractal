import { json, withValidation } from "@rhi-zone/fractal-http-api-projector"
import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-api-tree"
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
  "/res300/:id": {
    get: async (ctx: Ctx<"/res300/:id">) => json({ id: 300, key: ctx.params.id }),
  },
  "/res301": {
    post: withValidation(async (b: Body) => json({ id: 301, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res302/:id": {
    put: async (ctx: Ctx<"/res302/:id">) => json({ id: 302, key: ctx.params.id }),
  },
  "/res303": {
    get: async (ctx: Ctx<"/res303">) => json({ id: 303, key: "res303" }),
  },
  "/res304/:id": {
    post: async (ctx: Ctx<"/res304/:id">) => json({ id: 304, key: ctx.params.id }),
  },
  "/res305": {
    put: withValidation(async (b: Body) => json({ id: 305, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res306/:id": {
    get: async (ctx: Ctx<"/res306/:id">) => json({ id: 306, key: ctx.params.id }),
  },
  "/res307": {
    post: async (ctx: Ctx<"/res307">) => json({ id: 307, key: "res307" }),
  },
  "/res308/:id": {
    put: async (ctx: Ctx<"/res308/:id">) => json({ id: 308, key: ctx.params.id }),
  },
  "/res309": {
    get: async (ctx: Ctx<"/res309">) => json({ id: 309, key: "res309" }),
  },
  "/res310/:id": {
    post: async (ctx: Ctx<"/res310/:id">) => json({ id: 310, key: ctx.params.id }),
  },
  "/res311": {
    put: async (ctx: Ctx<"/res311">) => json({ id: 311, key: "res311" }),
  },
  "/res312/:id": {
    get: async (ctx: Ctx<"/res312/:id">) => json({ id: 312, key: ctx.params.id }),
  },
  "/res313": {
    post: withValidation(async (b: Body) => json({ id: 313, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res314/:id": {
    put: async (ctx: Ctx<"/res314/:id">) => json({ id: 314, key: ctx.params.id }),
  },
  "/res315": {
    get: async (ctx: Ctx<"/res315">) => json({ id: 315, key: "res315" }),
  },
  "/res316/:id": {
    post: async (ctx: Ctx<"/res316/:id">) => json({ id: 316, key: ctx.params.id }),
  },
  "/res317": {
    put: withValidation(async (b: Body) => json({ id: 317, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res318/:id": {
    get: async (ctx: Ctx<"/res318/:id">) => json({ id: 318, key: ctx.params.id }),
  },
  "/res319": {
    post: async (ctx: Ctx<"/res319">) => json({ id: 319, key: "res319" }),
  },
  "/res320/:id": {
    put: async (ctx: Ctx<"/res320/:id">) => json({ id: 320, key: ctx.params.id }),
  },
  "/res321": {
    get: async (ctx: Ctx<"/res321">) => json({ id: 321, key: "res321" }),
  },
  "/res322/:id": {
    post: async (ctx: Ctx<"/res322/:id">) => json({ id: 322, key: ctx.params.id }),
  },
  "/res323": {
    put: async (ctx: Ctx<"/res323">) => json({ id: 323, key: "res323" }),
  },
  "/res324/:id": {
    get: async (ctx: Ctx<"/res324/:id">) => json({ id: 324, key: ctx.params.id }),
  },
  "/res325": {
    post: withValidation(async (b: Body) => json({ id: 325, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res326/:id": {
    put: async (ctx: Ctx<"/res326/:id">) => json({ id: 326, key: ctx.params.id }),
  },
  "/res327": {
    get: async (ctx: Ctx<"/res327">) => json({ id: 327, key: "res327" }),
  },
  "/res328/:id": {
    post: async (ctx: Ctx<"/res328/:id">) => json({ id: 328, key: ctx.params.id }),
  },
  "/res329": {
    put: withValidation(async (b: Body) => json({ id: 329, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res330/:id": {
    get: async (ctx: Ctx<"/res330/:id">) => json({ id: 330, key: ctx.params.id }),
  },
  "/res331": {
    post: async (ctx: Ctx<"/res331">) => json({ id: 331, key: "res331" }),
  },
  "/res332/:id": {
    put: async (ctx: Ctx<"/res332/:id">) => json({ id: 332, key: ctx.params.id }),
  },
  "/res333": {
    get: async (ctx: Ctx<"/res333">) => json({ id: 333, key: "res333" }),
  },
  "/res334/:id": {
    post: async (ctx: Ctx<"/res334/:id">) => json({ id: 334, key: ctx.params.id }),
  },
  "/res335": {
    put: async (ctx: Ctx<"/res335">) => json({ id: 335, key: "res335" }),
  },
  "/res336/:id": {
    get: async (ctx: Ctx<"/res336/:id">) => json({ id: 336, key: ctx.params.id }),
  },
  "/res337": {
    post: withValidation(async (b: Body) => json({ id: 337, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res338/:id": {
    put: async (ctx: Ctx<"/res338/:id">) => json({ id: 338, key: ctx.params.id }),
  },
  "/res339": {
    get: async (ctx: Ctx<"/res339">) => json({ id: 339, key: "res339" }),
  },
  "/res340/:id": {
    post: async (ctx: Ctx<"/res340/:id">) => json({ id: 340, key: ctx.params.id }),
  },
  "/res341": {
    put: withValidation(async (b: Body) => json({ id: 341, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res342/:id": {
    get: async (ctx: Ctx<"/res342/:id">) => json({ id: 342, key: ctx.params.id }),
  },
  "/res343": {
    post: async (ctx: Ctx<"/res343">) => json({ id: 343, key: "res343" }),
  },
  "/res344/:id": {
    put: async (ctx: Ctx<"/res344/:id">) => json({ id: 344, key: ctx.params.id }),
  },
  "/res345": {
    get: async (ctx: Ctx<"/res345">) => json({ id: 345, key: "res345" }),
  },
  "/res346/:id": {
    post: async (ctx: Ctx<"/res346/:id">) => json({ id: 346, key: ctx.params.id }),
  },
  "/res347": {
    put: async (ctx: Ctx<"/res347">) => json({ id: 347, key: "res347" }),
  },
  "/res348/:id": {
    get: async (ctx: Ctx<"/res348/:id">) => json({ id: 348, key: ctx.params.id }),
  },
  "/res349": {
    post: withValidation(async (b: Body) => json({ id: 349, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res350/:id": {
    put: async (ctx: Ctx<"/res350/:id">) => json({ id: 350, key: ctx.params.id }),
  },
  "/res351": {
    get: async (ctx: Ctx<"/res351">) => json({ id: 351, key: "res351" }),
  },
  "/res352/:id": {
    post: async (ctx: Ctx<"/res352/:id">) => json({ id: 352, key: ctx.params.id }),
  },
  "/res353": {
    put: withValidation(async (b: Body) => json({ id: 353, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res354/:id": {
    get: async (ctx: Ctx<"/res354/:id">) => json({ id: 354, key: ctx.params.id }),
  },
  "/res355": {
    post: async (ctx: Ctx<"/res355">) => json({ id: 355, key: "res355" }),
  },
  "/res356/:id": {
    put: async (ctx: Ctx<"/res356/:id">) => json({ id: 356, key: ctx.params.id }),
  },
  "/res357": {
    get: async (ctx: Ctx<"/res357">) => json({ id: 357, key: "res357" }),
  },
  "/res358/:id": {
    post: async (ctx: Ctx<"/res358/:id">) => json({ id: 358, key: ctx.params.id }),
  },
  "/res359": {
    put: async (ctx: Ctx<"/res359">) => json({ id: 359, key: "res359" }),
  },
  "/res360/:id": {
    get: async (ctx: Ctx<"/res360/:id">) => json({ id: 360, key: ctx.params.id }),
  },
  "/res361": {
    post: withValidation(async (b: Body) => json({ id: 361, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res362/:id": {
    put: async (ctx: Ctx<"/res362/:id">) => json({ id: 362, key: ctx.params.id }),
  },
  "/res363": {
    get: async (ctx: Ctx<"/res363">) => json({ id: 363, key: "res363" }),
  },
  "/res364/:id": {
    post: async (ctx: Ctx<"/res364/:id">) => json({ id: 364, key: ctx.params.id }),
  },
  "/res365": {
    put: withValidation(async (b: Body) => json({ id: 365, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res366/:id": {
    get: async (ctx: Ctx<"/res366/:id">) => json({ id: 366, key: ctx.params.id }),
  },
  "/res367": {
    post: async (ctx: Ctx<"/res367">) => json({ id: 367, key: "res367" }),
  },
  "/res368/:id": {
    put: async (ctx: Ctx<"/res368/:id">) => json({ id: 368, key: ctx.params.id }),
  },
  "/res369": {
    get: async (ctx: Ctx<"/res369">) => json({ id: 369, key: "res369" }),
  },
  "/res370/:id": {
    post: async (ctx: Ctx<"/res370/:id">) => json({ id: 370, key: ctx.params.id }),
  },
  "/res371": {
    put: async (ctx: Ctx<"/res371">) => json({ id: 371, key: "res371" }),
  },
  "/res372/:id": {
    get: async (ctx: Ctx<"/res372/:id">) => json({ id: 372, key: ctx.params.id }),
  },
  "/res373": {
    post: withValidation(async (b: Body) => json({ id: 373, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res374/:id": {
    put: async (ctx: Ctx<"/res374/:id">) => json({ id: 374, key: ctx.params.id }),
  },
  "/res375": {
    get: async (ctx: Ctx<"/res375">) => json({ id: 375, key: "res375" }),
  },
  "/res376/:id": {
    post: async (ctx: Ctx<"/res376/:id">) => json({ id: 376, key: ctx.params.id }),
  },
  "/res377": {
    put: withValidation(async (b: Body) => json({ id: 377, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res378/:id": {
    get: async (ctx: Ctx<"/res378/:id">) => json({ id: 378, key: ctx.params.id }),
  },
  "/res379": {
    post: async (ctx: Ctx<"/res379">) => json({ id: 379, key: "res379" }),
  },
  "/res380/:id": {
    put: async (ctx: Ctx<"/res380/:id">) => json({ id: 380, key: ctx.params.id }),
  },
  "/res381": {
    get: async (ctx: Ctx<"/res381">) => json({ id: 381, key: "res381" }),
  },
  "/res382/:id": {
    post: async (ctx: Ctx<"/res382/:id">) => json({ id: 382, key: ctx.params.id }),
  },
  "/res383": {
    put: async (ctx: Ctx<"/res383">) => json({ id: 383, key: "res383" }),
  },
  "/res384/:id": {
    get: async (ctx: Ctx<"/res384/:id">) => json({ id: 384, key: ctx.params.id }),
  },
  "/res385": {
    post: withValidation(async (b: Body) => json({ id: 385, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res386/:id": {
    put: async (ctx: Ctx<"/res386/:id">) => json({ id: 386, key: ctx.params.id }),
  },
  "/res387": {
    get: async (ctx: Ctx<"/res387">) => json({ id: 387, key: "res387" }),
  },
  "/res388/:id": {
    post: async (ctx: Ctx<"/res388/:id">) => json({ id: 388, key: ctx.params.id }),
  },
  "/res389": {
    put: withValidation(async (b: Body) => json({ id: 389, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res390/:id": {
    get: async (ctx: Ctx<"/res390/:id">) => json({ id: 390, key: ctx.params.id }),
  },
  "/res391": {
    post: async (ctx: Ctx<"/res391">) => json({ id: 391, key: "res391" }),
  },
  "/res392/:id": {
    put: async (ctx: Ctx<"/res392/:id">) => json({ id: 392, key: ctx.params.id }),
  },
  "/res393": {
    get: async (ctx: Ctx<"/res393">) => json({ id: 393, key: "res393" }),
  },
  "/res394/:id": {
    post: async (ctx: Ctx<"/res394/:id">) => json({ id: 394, key: ctx.params.id }),
  },
  "/res395": {
    put: async (ctx: Ctx<"/res395">) => json({ id: 395, key: "res395" }),
  },
  "/res396/:id": {
    get: async (ctx: Ctx<"/res396/:id">) => json({ id: 396, key: ctx.params.id }),
  },
  "/res397": {
    post: withValidation(async (b: Body) => json({ id: 397, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res398/:id": {
    put: async (ctx: Ctx<"/res398/:id">) => json({ id: 398, key: ctx.params.id }),
  },
  "/res399": {
    get: async (ctx: Ctx<"/res399">) => json({ id: 399, key: "res399" }),
  },
  "/res400/:id": {
    post: async (ctx: Ctx<"/res400/:id">) => json({ id: 400, key: ctx.params.id }),
  },
  "/res401": {
    put: withValidation(async (b: Body) => json({ id: 401, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res402/:id": {
    get: async (ctx: Ctx<"/res402/:id">) => json({ id: 402, key: ctx.params.id }),
  },
  "/res403": {
    post: async (ctx: Ctx<"/res403">) => json({ id: 403, key: "res403" }),
  },
  "/res404/:id": {
    put: async (ctx: Ctx<"/res404/:id">) => json({ id: 404, key: ctx.params.id }),
  },
  "/res405": {
    get: async (ctx: Ctx<"/res405">) => json({ id: 405, key: "res405" }),
  },
  "/res406/:id": {
    post: async (ctx: Ctx<"/res406/:id">) => json({ id: 406, key: ctx.params.id }),
  },
  "/res407": {
    put: async (ctx: Ctx<"/res407">) => json({ id: 407, key: "res407" }),
  },
  "/res408/:id": {
    get: async (ctx: Ctx<"/res408/:id">) => json({ id: 408, key: ctx.params.id }),
  },
  "/res409": {
    post: withValidation(async (b: Body) => json({ id: 409, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res410/:id": {
    put: async (ctx: Ctx<"/res410/:id">) => json({ id: 410, key: ctx.params.id }),
  },
  "/res411": {
    get: async (ctx: Ctx<"/res411">) => json({ id: 411, key: "res411" }),
  },
  "/res412/:id": {
    post: async (ctx: Ctx<"/res412/:id">) => json({ id: 412, key: ctx.params.id }),
  },
  "/res413": {
    put: withValidation(async (b: Body) => json({ id: 413, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res414/:id": {
    get: async (ctx: Ctx<"/res414/:id">) => json({ id: 414, key: ctx.params.id }),
  },
  "/res415": {
    post: async (ctx: Ctx<"/res415">) => json({ id: 415, key: "res415" }),
  },
  "/res416/:id": {
    put: async (ctx: Ctx<"/res416/:id">) => json({ id: 416, key: ctx.params.id }),
  },
  "/res417": {
    get: async (ctx: Ctx<"/res417">) => json({ id: 417, key: "res417" }),
  },
  "/res418/:id": {
    post: async (ctx: Ctx<"/res418/:id">) => json({ id: 418, key: ctx.params.id }),
  },
  "/res419": {
    put: async (ctx: Ctx<"/res419">) => json({ id: 419, key: "res419" }),
  },
  "/res420/:id": {
    get: async (ctx: Ctx<"/res420/:id">) => json({ id: 420, key: ctx.params.id }),
  },
  "/res421": {
    post: withValidation(async (b: Body) => json({ id: 421, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res422/:id": {
    put: async (ctx: Ctx<"/res422/:id">) => json({ id: 422, key: ctx.params.id }),
  },
  "/res423": {
    get: async (ctx: Ctx<"/res423">) => json({ id: 423, key: "res423" }),
  },
  "/res424/:id": {
    post: async (ctx: Ctx<"/res424/:id">) => json({ id: 424, key: ctx.params.id }),
  },
  "/res425": {
    put: withValidation(async (b: Body) => json({ id: 425, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res426/:id": {
    get: async (ctx: Ctx<"/res426/:id">) => json({ id: 426, key: ctx.params.id }),
  },
  "/res427": {
    post: async (ctx: Ctx<"/res427">) => json({ id: 427, key: "res427" }),
  },
  "/res428/:id": {
    put: async (ctx: Ctx<"/res428/:id">) => json({ id: 428, key: ctx.params.id }),
  },
  "/res429": {
    get: async (ctx: Ctx<"/res429">) => json({ id: 429, key: "res429" }),
  },
  "/res430/:id": {
    post: async (ctx: Ctx<"/res430/:id">) => json({ id: 430, key: ctx.params.id }),
  },
  "/res431": {
    put: async (ctx: Ctx<"/res431">) => json({ id: 431, key: "res431" }),
  },
  "/res432/:id": {
    get: async (ctx: Ctx<"/res432/:id">) => json({ id: 432, key: ctx.params.id }),
  },
  "/res433": {
    post: withValidation(async (b: Body) => json({ id: 433, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res434/:id": {
    put: async (ctx: Ctx<"/res434/:id">) => json({ id: 434, key: ctx.params.id }),
  },
  "/res435": {
    get: async (ctx: Ctx<"/res435">) => json({ id: 435, key: "res435" }),
  },
  "/res436/:id": {
    post: async (ctx: Ctx<"/res436/:id">) => json({ id: 436, key: ctx.params.id }),
  },
  "/res437": {
    put: withValidation(async (b: Body) => json({ id: 437, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res438/:id": {
    get: async (ctx: Ctx<"/res438/:id">) => json({ id: 438, key: ctx.params.id }),
  },
  "/res439": {
    post: async (ctx: Ctx<"/res439">) => json({ id: 439, key: "res439" }),
  },
  "/res440/:id": {
    put: async (ctx: Ctx<"/res440/:id">) => json({ id: 440, key: ctx.params.id }),
  },
  "/res441": {
    get: async (ctx: Ctx<"/res441">) => json({ id: 441, key: "res441" }),
  },
  "/res442/:id": {
    post: async (ctx: Ctx<"/res442/:id">) => json({ id: 442, key: ctx.params.id }),
  },
  "/res443": {
    put: async (ctx: Ctx<"/res443">) => json({ id: 443, key: "res443" }),
  },
  "/res444/:id": {
    get: async (ctx: Ctx<"/res444/:id">) => json({ id: 444, key: ctx.params.id }),
  },
  "/res445": {
    post: withValidation(async (b: Body) => json({ id: 445, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res446/:id": {
    put: async (ctx: Ctx<"/res446/:id">) => json({ id: 446, key: ctx.params.id }),
  },
  "/res447": {
    get: async (ctx: Ctx<"/res447">) => json({ id: 447, key: "res447" }),
  },
  "/res448/:id": {
    post: async (ctx: Ctx<"/res448/:id">) => json({ id: 448, key: ctx.params.id }),
  },
  "/res449": {
    put: withValidation(async (b: Body) => json({ id: 449, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res450/:id": {
    get: async (ctx: Ctx<"/res450/:id">) => json({ id: 450, key: ctx.params.id }),
  },
  "/res451": {
    post: async (ctx: Ctx<"/res451">) => json({ id: 451, key: "res451" }),
  },
  "/res452/:id": {
    put: async (ctx: Ctx<"/res452/:id">) => json({ id: 452, key: ctx.params.id }),
  },
  "/res453": {
    get: async (ctx: Ctx<"/res453">) => json({ id: 453, key: "res453" }),
  },
  "/res454/:id": {
    post: async (ctx: Ctx<"/res454/:id">) => json({ id: 454, key: ctx.params.id }),
  },
  "/res455": {
    put: async (ctx: Ctx<"/res455">) => json({ id: 455, key: "res455" }),
  },
  "/res456/:id": {
    get: async (ctx: Ctx<"/res456/:id">) => json({ id: 456, key: ctx.params.id }),
  },
  "/res457": {
    post: withValidation(async (b: Body) => json({ id: 457, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res458/:id": {
    put: async (ctx: Ctx<"/res458/:id">) => json({ id: 458, key: ctx.params.id }),
  },
  "/res459": {
    get: async (ctx: Ctx<"/res459">) => json({ id: 459, key: "res459" }),
  },
  "/res460/:id": {
    post: async (ctx: Ctx<"/res460/:id">) => json({ id: 460, key: ctx.params.id }),
  },
  "/res461": {
    put: withValidation(async (b: Body) => json({ id: 461, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res462/:id": {
    get: async (ctx: Ctx<"/res462/:id">) => json({ id: 462, key: ctx.params.id }),
  },
  "/res463": {
    post: async (ctx: Ctx<"/res463">) => json({ id: 463, key: "res463" }),
  },
  "/res464/:id": {
    put: async (ctx: Ctx<"/res464/:id">) => json({ id: 464, key: ctx.params.id }),
  },
  "/res465": {
    get: async (ctx: Ctx<"/res465">) => json({ id: 465, key: "res465" }),
  },
  "/res466/:id": {
    post: async (ctx: Ctx<"/res466/:id">) => json({ id: 466, key: ctx.params.id }),
  },
  "/res467": {
    put: async (ctx: Ctx<"/res467">) => json({ id: 467, key: "res467" }),
  },
  "/res468/:id": {
    get: async (ctx: Ctx<"/res468/:id">) => json({ id: 468, key: ctx.params.id }),
  },
  "/res469": {
    post: withValidation(async (b: Body) => json({ id: 469, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res470/:id": {
    put: async (ctx: Ctx<"/res470/:id">) => json({ id: 470, key: ctx.params.id }),
  },
  "/res471": {
    get: async (ctx: Ctx<"/res471">) => json({ id: 471, key: "res471" }),
  },
  "/res472/:id": {
    post: async (ctx: Ctx<"/res472/:id">) => json({ id: 472, key: ctx.params.id }),
  },
  "/res473": {
    put: withValidation(async (b: Body) => json({ id: 473, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res474/:id": {
    get: async (ctx: Ctx<"/res474/:id">) => json({ id: 474, key: ctx.params.id }),
  },
  "/res475": {
    post: async (ctx: Ctx<"/res475">) => json({ id: 475, key: "res475" }),
  },
  "/res476/:id": {
    put: async (ctx: Ctx<"/res476/:id">) => json({ id: 476, key: ctx.params.id }),
  },
  "/res477": {
    get: async (ctx: Ctx<"/res477">) => json({ id: 477, key: "res477" }),
  },
  "/res478/:id": {
    post: async (ctx: Ctx<"/res478/:id">) => json({ id: 478, key: ctx.params.id }),
  },
  "/res479": {
    put: async (ctx: Ctx<"/res479">) => json({ id: 479, key: "res479" }),
  },
  "/res480/:id": {
    get: async (ctx: Ctx<"/res480/:id">) => json({ id: 480, key: ctx.params.id }),
  },
  "/res481": {
    post: withValidation(async (b: Body) => json({ id: 481, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res482/:id": {
    put: async (ctx: Ctx<"/res482/:id">) => json({ id: 482, key: ctx.params.id }),
  },
  "/res483": {
    get: async (ctx: Ctx<"/res483">) => json({ id: 483, key: "res483" }),
  },
  "/res484/:id": {
    post: async (ctx: Ctx<"/res484/:id">) => json({ id: 484, key: ctx.params.id }),
  },
  "/res485": {
    put: withValidation(async (b: Body) => json({ id: 485, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res486/:id": {
    get: async (ctx: Ctx<"/res486/:id">) => json({ id: 486, key: ctx.params.id }),
  },
  "/res487": {
    post: async (ctx: Ctx<"/res487">) => json({ id: 487, key: "res487" }),
  },
  "/res488/:id": {
    put: async (ctx: Ctx<"/res488/:id">) => json({ id: 488, key: ctx.params.id }),
  },
  "/res489": {
    get: async (ctx: Ctx<"/res489">) => json({ id: 489, key: "res489" }),
  },
  "/res490/:id": {
    post: async (ctx: Ctx<"/res490/:id">) => json({ id: 490, key: ctx.params.id }),
  },
  "/res491": {
    put: async (ctx: Ctx<"/res491">) => json({ id: 491, key: "res491" }),
  },
  "/res492/:id": {
    get: async (ctx: Ctx<"/res492/:id">) => json({ id: 492, key: ctx.params.id }),
  },
  "/res493": {
    post: withValidation(async (b: Body) => json({ id: 493, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res494/:id": {
    put: async (ctx: Ctx<"/res494/:id">) => json({ id: 494, key: ctx.params.id }),
  },
  "/res495": {
    get: async (ctx: Ctx<"/res495">) => json({ id: 495, key: "res495" }),
  },
  "/res496/:id": {
    post: async (ctx: Ctx<"/res496/:id">) => json({ id: 496, key: ctx.params.id }),
  },
  "/res497": {
    put: withValidation(async (b: Body) => json({ id: 497, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res498/:id": {
    get: async (ctx: Ctx<"/res498/:id">) => json({ id: 498, key: ctx.params.id }),
  },
  "/res499": {
    post: async (ctx: Ctx<"/res499">) => json({ id: 499, key: "res499" }),
  },
  "/res500/:id": {
    put: async (ctx: Ctx<"/res500/:id">) => json({ id: 500, key: ctx.params.id }),
  },
  "/res501": {
    get: async (ctx: Ctx<"/res501">) => json({ id: 501, key: "res501" }),
  },
  "/res502/:id": {
    post: async (ctx: Ctx<"/res502/:id">) => json({ id: 502, key: ctx.params.id }),
  },
  "/res503": {
    put: async (ctx: Ctx<"/res503">) => json({ id: 503, key: "res503" }),
  },
  "/res504/:id": {
    get: async (ctx: Ctx<"/res504/:id">) => json({ id: 504, key: ctx.params.id }),
  },
  "/res505": {
    post: withValidation(async (b: Body) => json({ id: 505, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res506/:id": {
    put: async (ctx: Ctx<"/res506/:id">) => json({ id: 506, key: ctx.params.id }),
  },
  "/res507": {
    get: async (ctx: Ctx<"/res507">) => json({ id: 507, key: "res507" }),
  },
  "/res508/:id": {
    post: async (ctx: Ctx<"/res508/:id">) => json({ id: 508, key: ctx.params.id }),
  },
  "/res509": {
    put: withValidation(async (b: Body) => json({ id: 509, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res510/:id": {
    get: async (ctx: Ctx<"/res510/:id">) => json({ id: 510, key: ctx.params.id }),
  },
  "/res511": {
    post: async (ctx: Ctx<"/res511">) => json({ id: 511, key: "res511" }),
  },
  "/res512/:id": {
    put: async (ctx: Ctx<"/res512/:id">) => json({ id: 512, key: ctx.params.id }),
  },
  "/res513": {
    get: async (ctx: Ctx<"/res513">) => json({ id: 513, key: "res513" }),
  },
  "/res514/:id": {
    post: async (ctx: Ctx<"/res514/:id">) => json({ id: 514, key: ctx.params.id }),
  },
  "/res515": {
    put: async (ctx: Ctx<"/res515">) => json({ id: 515, key: "res515" }),
  },
  "/res516/:id": {
    get: async (ctx: Ctx<"/res516/:id">) => json({ id: 516, key: ctx.params.id }),
  },
  "/res517": {
    post: withValidation(async (b: Body) => json({ id: 517, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res518/:id": {
    put: async (ctx: Ctx<"/res518/:id">) => json({ id: 518, key: ctx.params.id }),
  },
  "/res519": {
    get: async (ctx: Ctx<"/res519">) => json({ id: 519, key: "res519" }),
  },
  "/res520/:id": {
    post: async (ctx: Ctx<"/res520/:id">) => json({ id: 520, key: ctx.params.id }),
  },
  "/res521": {
    put: withValidation(async (b: Body) => json({ id: 521, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res522/:id": {
    get: async (ctx: Ctx<"/res522/:id">) => json({ id: 522, key: ctx.params.id }),
  },
  "/res523": {
    post: async (ctx: Ctx<"/res523">) => json({ id: 523, key: "res523" }),
  },
  "/res524/:id": {
    put: async (ctx: Ctx<"/res524/:id">) => json({ id: 524, key: ctx.params.id }),
  },
  "/res525": {
    get: async (ctx: Ctx<"/res525">) => json({ id: 525, key: "res525" }),
  },
  "/res526/:id": {
    post: async (ctx: Ctx<"/res526/:id">) => json({ id: 526, key: ctx.params.id }),
  },
  "/res527": {
    put: async (ctx: Ctx<"/res527">) => json({ id: 527, key: "res527" }),
  },
  "/res528/:id": {
    get: async (ctx: Ctx<"/res528/:id">) => json({ id: 528, key: ctx.params.id }),
  },
  "/res529": {
    post: withValidation(async (b: Body) => json({ id: 529, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res530/:id": {
    put: async (ctx: Ctx<"/res530/:id">) => json({ id: 530, key: ctx.params.id }),
  },
  "/res531": {
    get: async (ctx: Ctx<"/res531">) => json({ id: 531, key: "res531" }),
  },
  "/res532/:id": {
    post: async (ctx: Ctx<"/res532/:id">) => json({ id: 532, key: ctx.params.id }),
  },
  "/res533": {
    put: withValidation(async (b: Body) => json({ id: 533, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res534/:id": {
    get: async (ctx: Ctx<"/res534/:id">) => json({ id: 534, key: ctx.params.id }),
  },
  "/res535": {
    post: async (ctx: Ctx<"/res535">) => json({ id: 535, key: "res535" }),
  },
  "/res536/:id": {
    put: async (ctx: Ctx<"/res536/:id">) => json({ id: 536, key: ctx.params.id }),
  },
  "/res537": {
    get: async (ctx: Ctx<"/res537">) => json({ id: 537, key: "res537" }),
  },
  "/res538/:id": {
    post: async (ctx: Ctx<"/res538/:id">) => json({ id: 538, key: ctx.params.id }),
  },
  "/res539": {
    put: async (ctx: Ctx<"/res539">) => json({ id: 539, key: "res539" }),
  },
  "/res540/:id": {
    get: async (ctx: Ctx<"/res540/:id">) => json({ id: 540, key: ctx.params.id }),
  },
  "/res541": {
    post: withValidation(async (b: Body) => json({ id: 541, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res542/:id": {
    put: async (ctx: Ctx<"/res542/:id">) => json({ id: 542, key: ctx.params.id }),
  },
  "/res543": {
    get: async (ctx: Ctx<"/res543">) => json({ id: 543, key: "res543" }),
  },
  "/res544/:id": {
    post: async (ctx: Ctx<"/res544/:id">) => json({ id: 544, key: ctx.params.id }),
  },
  "/res545": {
    put: withValidation(async (b: Body) => json({ id: 545, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res546/:id": {
    get: async (ctx: Ctx<"/res546/:id">) => json({ id: 546, key: ctx.params.id }),
  },
  "/res547": {
    post: async (ctx: Ctx<"/res547">) => json({ id: 547, key: "res547" }),
  },
  "/res548/:id": {
    put: async (ctx: Ctx<"/res548/:id">) => json({ id: 548, key: ctx.params.id }),
  },
  "/res549": {
    get: async (ctx: Ctx<"/res549">) => json({ id: 549, key: "res549" }),
  },
  "/res550/:id": {
    post: async (ctx: Ctx<"/res550/:id">) => json({ id: 550, key: ctx.params.id }),
  },
  "/res551": {
    put: async (ctx: Ctx<"/res551">) => json({ id: 551, key: "res551" }),
  },
  "/res552/:id": {
    get: async (ctx: Ctx<"/res552/:id">) => json({ id: 552, key: ctx.params.id }),
  },
  "/res553": {
    post: withValidation(async (b: Body) => json({ id: 553, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res554/:id": {
    put: async (ctx: Ctx<"/res554/:id">) => json({ id: 554, key: ctx.params.id }),
  },
  "/res555": {
    get: async (ctx: Ctx<"/res555">) => json({ id: 555, key: "res555" }),
  },
  "/res556/:id": {
    post: async (ctx: Ctx<"/res556/:id">) => json({ id: 556, key: ctx.params.id }),
  },
  "/res557": {
    put: withValidation(async (b: Body) => json({ id: 557, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res558/:id": {
    get: async (ctx: Ctx<"/res558/:id">) => json({ id: 558, key: ctx.params.id }),
  },
  "/res559": {
    post: async (ctx: Ctx<"/res559">) => json({ id: 559, key: "res559" }),
  },
  "/res560/:id": {
    put: async (ctx: Ctx<"/res560/:id">) => json({ id: 560, key: ctx.params.id }),
  },
  "/res561": {
    get: async (ctx: Ctx<"/res561">) => json({ id: 561, key: "res561" }),
  },
  "/res562/:id": {
    post: async (ctx: Ctx<"/res562/:id">) => json({ id: 562, key: ctx.params.id }),
  },
  "/res563": {
    put: async (ctx: Ctx<"/res563">) => json({ id: 563, key: "res563" }),
  },
  "/res564/:id": {
    get: async (ctx: Ctx<"/res564/:id">) => json({ id: 564, key: ctx.params.id }),
  },
  "/res565": {
    post: withValidation(async (b: Body) => json({ id: 565, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res566/:id": {
    put: async (ctx: Ctx<"/res566/:id">) => json({ id: 566, key: ctx.params.id }),
  },
  "/res567": {
    get: async (ctx: Ctx<"/res567">) => json({ id: 567, key: "res567" }),
  },
  "/res568/:id": {
    post: async (ctx: Ctx<"/res568/:id">) => json({ id: 568, key: ctx.params.id }),
  },
  "/res569": {
    put: withValidation(async (b: Body) => json({ id: 569, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res570/:id": {
    get: async (ctx: Ctx<"/res570/:id">) => json({ id: 570, key: ctx.params.id }),
  },
  "/res571": {
    post: async (ctx: Ctx<"/res571">) => json({ id: 571, key: "res571" }),
  },
  "/res572/:id": {
    put: async (ctx: Ctx<"/res572/:id">) => json({ id: 572, key: ctx.params.id }),
  },
  "/res573": {
    get: async (ctx: Ctx<"/res573">) => json({ id: 573, key: "res573" }),
  },
  "/res574/:id": {
    post: async (ctx: Ctx<"/res574/:id">) => json({ id: 574, key: ctx.params.id }),
  },
  "/res575": {
    put: async (ctx: Ctx<"/res575">) => json({ id: 575, key: "res575" }),
  },
  "/res576/:id": {
    get: async (ctx: Ctx<"/res576/:id">) => json({ id: 576, key: ctx.params.id }),
  },
  "/res577": {
    post: withValidation(async (b: Body) => json({ id: 577, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res578/:id": {
    put: async (ctx: Ctx<"/res578/:id">) => json({ id: 578, key: ctx.params.id }),
  },
  "/res579": {
    get: async (ctx: Ctx<"/res579">) => json({ id: 579, key: "res579" }),
  },
  "/res580/:id": {
    post: async (ctx: Ctx<"/res580/:id">) => json({ id: 580, key: ctx.params.id }),
  },
  "/res581": {
    put: withValidation(async (b: Body) => json({ id: 581, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res582/:id": {
    get: async (ctx: Ctx<"/res582/:id">) => json({ id: 582, key: ctx.params.id }),
  },
  "/res583": {
    post: async (ctx: Ctx<"/res583">) => json({ id: 583, key: "res583" }),
  },
  "/res584/:id": {
    put: async (ctx: Ctx<"/res584/:id">) => json({ id: 584, key: ctx.params.id }),
  },
  "/res585": {
    get: async (ctx: Ctx<"/res585">) => json({ id: 585, key: "res585" }),
  },
  "/res586/:id": {
    post: async (ctx: Ctx<"/res586/:id">) => json({ id: 586, key: ctx.params.id }),
  },
  "/res587": {
    put: async (ctx: Ctx<"/res587">) => json({ id: 587, key: "res587" }),
  },
  "/res588/:id": {
    get: async (ctx: Ctx<"/res588/:id">) => json({ id: 588, key: ctx.params.id }),
  },
  "/res589": {
    post: withValidation(async (b: Body) => json({ id: 589, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res590/:id": {
    put: async (ctx: Ctx<"/res590/:id">) => json({ id: 590, key: ctx.params.id }),
  },
  "/res591": {
    get: async (ctx: Ctx<"/res591">) => json({ id: 591, key: "res591" }),
  },
  "/res592/:id": {
    post: async (ctx: Ctx<"/res592/:id">) => json({ id: 592, key: ctx.params.id }),
  },
  "/res593": {
    put: withValidation(async (b: Body) => json({ id: 593, name: b.name, qty: b.qty }), bodySchema),
  },
  "/res594/:id": {
    get: async (ctx: Ctx<"/res594/:id">) => json({ id: 594, key: ctx.params.id }),
  },
  "/res595": {
    post: async (ctx: Ctx<"/res595">) => json({ id: 595, key: "res595" }),
  },
  "/res596/:id": {
    put: async (ctx: Ctx<"/res596/:id">) => json({ id: 596, key: ctx.params.id }),
  },
  "/res597": {
    get: async (ctx: Ctx<"/res597">) => json({ id: 597, key: "res597" }),
  },
  "/res598/:id": {
    post: async (ctx: Ctx<"/res598/:id">) => json({ id: 598, key: ctx.params.id }),
  },
  "/res599": {
    put: async (ctx: Ctx<"/res599">) => json({ id: 599, key: "res599" }),
  },
} as const

type Api = ClientOfContract<typeof contract>
declare const api: Api
const r0 = api["/res0/:id"].get({ params: { id: "1" } })
void r0.then((v) => v)
const r85 = api["/res85"].post({ body: { name: "x", qty: 1 } })
void r85.then((v) => v)
const r171 = api["/res171"].get()
void r171.then((v) => v)
const r256 = api["/res256/:id"].post({ params: { id: "1" } })
void r256.then((v) => v)
const r342 = api["/res342/:id"].get({ params: { id: "1" } })
void r342.then((v) => v)
const r427 = api["/res427"].post()
void r427.then((v) => v)
const r513 = api["/res513"].get()
void r513.then((v) => v)
const r599 = api["/res599"].put()
void r599.then((v) => v)
