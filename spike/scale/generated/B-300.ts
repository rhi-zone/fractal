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
const h100 = async (ctx: Ctx<"/res100/:id">) => json({ id: 100, key: ctx.params.id })
const h101 = withValidation(async (b: Body) => json({ id: 101, name: b.name, qty: b.qty }), bodySchema)
const h102 = async (ctx: Ctx<"/res102/:id">) => json({ id: 102, key: ctx.params.id })
const h103 = async (ctx: Ctx<"/res103">) => json({ id: 103, key: "res103" })
const h104 = async (ctx: Ctx<"/res104/:id">) => json({ id: 104, key: ctx.params.id })
const h105 = async (ctx: Ctx<"/res105">) => json({ id: 105, key: "res105" })
const h106 = async (ctx: Ctx<"/res106/:id">) => json({ id: 106, key: ctx.params.id })
const h107 = async (ctx: Ctx<"/res107">) => json({ id: 107, key: "res107" })
const h108 = async (ctx: Ctx<"/res108/:id">) => json({ id: 108, key: ctx.params.id })
const h109 = withValidation(async (b: Body) => json({ id: 109, name: b.name, qty: b.qty }), bodySchema)
const h110 = async (ctx: Ctx<"/res110/:id">) => json({ id: 110, key: ctx.params.id })
const h111 = async (ctx: Ctx<"/res111">) => json({ id: 111, key: "res111" })
const h112 = async (ctx: Ctx<"/res112/:id">) => json({ id: 112, key: ctx.params.id })
const h113 = withValidation(async (b: Body) => json({ id: 113, name: b.name, qty: b.qty }), bodySchema)
const h114 = async (ctx: Ctx<"/res114/:id">) => json({ id: 114, key: ctx.params.id })
const h115 = async (ctx: Ctx<"/res115">) => json({ id: 115, key: "res115" })
const h116 = async (ctx: Ctx<"/res116/:id">) => json({ id: 116, key: ctx.params.id })
const h117 = async (ctx: Ctx<"/res117">) => json({ id: 117, key: "res117" })
const h118 = async (ctx: Ctx<"/res118/:id">) => json({ id: 118, key: ctx.params.id })
const h119 = async (ctx: Ctx<"/res119">) => json({ id: 119, key: "res119" })
const h120 = async (ctx: Ctx<"/res120/:id">) => json({ id: 120, key: ctx.params.id })
const h121 = withValidation(async (b: Body) => json({ id: 121, name: b.name, qty: b.qty }), bodySchema)
const h122 = async (ctx: Ctx<"/res122/:id">) => json({ id: 122, key: ctx.params.id })
const h123 = async (ctx: Ctx<"/res123">) => json({ id: 123, key: "res123" })
const h124 = async (ctx: Ctx<"/res124/:id">) => json({ id: 124, key: ctx.params.id })
const h125 = withValidation(async (b: Body) => json({ id: 125, name: b.name, qty: b.qty }), bodySchema)
const h126 = async (ctx: Ctx<"/res126/:id">) => json({ id: 126, key: ctx.params.id })
const h127 = async (ctx: Ctx<"/res127">) => json({ id: 127, key: "res127" })
const h128 = async (ctx: Ctx<"/res128/:id">) => json({ id: 128, key: ctx.params.id })
const h129 = async (ctx: Ctx<"/res129">) => json({ id: 129, key: "res129" })
const h130 = async (ctx: Ctx<"/res130/:id">) => json({ id: 130, key: ctx.params.id })
const h131 = async (ctx: Ctx<"/res131">) => json({ id: 131, key: "res131" })
const h132 = async (ctx: Ctx<"/res132/:id">) => json({ id: 132, key: ctx.params.id })
const h133 = withValidation(async (b: Body) => json({ id: 133, name: b.name, qty: b.qty }), bodySchema)
const h134 = async (ctx: Ctx<"/res134/:id">) => json({ id: 134, key: ctx.params.id })
const h135 = async (ctx: Ctx<"/res135">) => json({ id: 135, key: "res135" })
const h136 = async (ctx: Ctx<"/res136/:id">) => json({ id: 136, key: ctx.params.id })
const h137 = withValidation(async (b: Body) => json({ id: 137, name: b.name, qty: b.qty }), bodySchema)
const h138 = async (ctx: Ctx<"/res138/:id">) => json({ id: 138, key: ctx.params.id })
const h139 = async (ctx: Ctx<"/res139">) => json({ id: 139, key: "res139" })
const h140 = async (ctx: Ctx<"/res140/:id">) => json({ id: 140, key: ctx.params.id })
const h141 = async (ctx: Ctx<"/res141">) => json({ id: 141, key: "res141" })
const h142 = async (ctx: Ctx<"/res142/:id">) => json({ id: 142, key: ctx.params.id })
const h143 = async (ctx: Ctx<"/res143">) => json({ id: 143, key: "res143" })
const h144 = async (ctx: Ctx<"/res144/:id">) => json({ id: 144, key: ctx.params.id })
const h145 = withValidation(async (b: Body) => json({ id: 145, name: b.name, qty: b.qty }), bodySchema)
const h146 = async (ctx: Ctx<"/res146/:id">) => json({ id: 146, key: ctx.params.id })
const h147 = async (ctx: Ctx<"/res147">) => json({ id: 147, key: "res147" })
const h148 = async (ctx: Ctx<"/res148/:id">) => json({ id: 148, key: ctx.params.id })
const h149 = withValidation(async (b: Body) => json({ id: 149, name: b.name, qty: b.qty }), bodySchema)
const h150 = async (ctx: Ctx<"/res150/:id">) => json({ id: 150, key: ctx.params.id })
const h151 = async (ctx: Ctx<"/res151">) => json({ id: 151, key: "res151" })
const h152 = async (ctx: Ctx<"/res152/:id">) => json({ id: 152, key: ctx.params.id })
const h153 = async (ctx: Ctx<"/res153">) => json({ id: 153, key: "res153" })
const h154 = async (ctx: Ctx<"/res154/:id">) => json({ id: 154, key: ctx.params.id })
const h155 = async (ctx: Ctx<"/res155">) => json({ id: 155, key: "res155" })
const h156 = async (ctx: Ctx<"/res156/:id">) => json({ id: 156, key: ctx.params.id })
const h157 = withValidation(async (b: Body) => json({ id: 157, name: b.name, qty: b.qty }), bodySchema)
const h158 = async (ctx: Ctx<"/res158/:id">) => json({ id: 158, key: ctx.params.id })
const h159 = async (ctx: Ctx<"/res159">) => json({ id: 159, key: "res159" })
const h160 = async (ctx: Ctx<"/res160/:id">) => json({ id: 160, key: ctx.params.id })
const h161 = withValidation(async (b: Body) => json({ id: 161, name: b.name, qty: b.qty }), bodySchema)
const h162 = async (ctx: Ctx<"/res162/:id">) => json({ id: 162, key: ctx.params.id })
const h163 = async (ctx: Ctx<"/res163">) => json({ id: 163, key: "res163" })
const h164 = async (ctx: Ctx<"/res164/:id">) => json({ id: 164, key: ctx.params.id })
const h165 = async (ctx: Ctx<"/res165">) => json({ id: 165, key: "res165" })
const h166 = async (ctx: Ctx<"/res166/:id">) => json({ id: 166, key: ctx.params.id })
const h167 = async (ctx: Ctx<"/res167">) => json({ id: 167, key: "res167" })
const h168 = async (ctx: Ctx<"/res168/:id">) => json({ id: 168, key: ctx.params.id })
const h169 = withValidation(async (b: Body) => json({ id: 169, name: b.name, qty: b.qty }), bodySchema)
const h170 = async (ctx: Ctx<"/res170/:id">) => json({ id: 170, key: ctx.params.id })
const h171 = async (ctx: Ctx<"/res171">) => json({ id: 171, key: "res171" })
const h172 = async (ctx: Ctx<"/res172/:id">) => json({ id: 172, key: ctx.params.id })
const h173 = withValidation(async (b: Body) => json({ id: 173, name: b.name, qty: b.qty }), bodySchema)
const h174 = async (ctx: Ctx<"/res174/:id">) => json({ id: 174, key: ctx.params.id })
const h175 = async (ctx: Ctx<"/res175">) => json({ id: 175, key: "res175" })
const h176 = async (ctx: Ctx<"/res176/:id">) => json({ id: 176, key: ctx.params.id })
const h177 = async (ctx: Ctx<"/res177">) => json({ id: 177, key: "res177" })
const h178 = async (ctx: Ctx<"/res178/:id">) => json({ id: 178, key: ctx.params.id })
const h179 = async (ctx: Ctx<"/res179">) => json({ id: 179, key: "res179" })
const h180 = async (ctx: Ctx<"/res180/:id">) => json({ id: 180, key: ctx.params.id })
const h181 = withValidation(async (b: Body) => json({ id: 181, name: b.name, qty: b.qty }), bodySchema)
const h182 = async (ctx: Ctx<"/res182/:id">) => json({ id: 182, key: ctx.params.id })
const h183 = async (ctx: Ctx<"/res183">) => json({ id: 183, key: "res183" })
const h184 = async (ctx: Ctx<"/res184/:id">) => json({ id: 184, key: ctx.params.id })
const h185 = withValidation(async (b: Body) => json({ id: 185, name: b.name, qty: b.qty }), bodySchema)
const h186 = async (ctx: Ctx<"/res186/:id">) => json({ id: 186, key: ctx.params.id })
const h187 = async (ctx: Ctx<"/res187">) => json({ id: 187, key: "res187" })
const h188 = async (ctx: Ctx<"/res188/:id">) => json({ id: 188, key: ctx.params.id })
const h189 = async (ctx: Ctx<"/res189">) => json({ id: 189, key: "res189" })
const h190 = async (ctx: Ctx<"/res190/:id">) => json({ id: 190, key: ctx.params.id })
const h191 = async (ctx: Ctx<"/res191">) => json({ id: 191, key: "res191" })
const h192 = async (ctx: Ctx<"/res192/:id">) => json({ id: 192, key: ctx.params.id })
const h193 = withValidation(async (b: Body) => json({ id: 193, name: b.name, qty: b.qty }), bodySchema)
const h194 = async (ctx: Ctx<"/res194/:id">) => json({ id: 194, key: ctx.params.id })
const h195 = async (ctx: Ctx<"/res195">) => json({ id: 195, key: "res195" })
const h196 = async (ctx: Ctx<"/res196/:id">) => json({ id: 196, key: ctx.params.id })
const h197 = withValidation(async (b: Body) => json({ id: 197, name: b.name, qty: b.qty }), bodySchema)
const h198 = async (ctx: Ctx<"/res198/:id">) => json({ id: 198, key: ctx.params.id })
const h199 = async (ctx: Ctx<"/res199">) => json({ id: 199, key: "res199" })
const h200 = async (ctx: Ctx<"/res200/:id">) => json({ id: 200, key: ctx.params.id })
const h201 = async (ctx: Ctx<"/res201">) => json({ id: 201, key: "res201" })
const h202 = async (ctx: Ctx<"/res202/:id">) => json({ id: 202, key: ctx.params.id })
const h203 = async (ctx: Ctx<"/res203">) => json({ id: 203, key: "res203" })
const h204 = async (ctx: Ctx<"/res204/:id">) => json({ id: 204, key: ctx.params.id })
const h205 = withValidation(async (b: Body) => json({ id: 205, name: b.name, qty: b.qty }), bodySchema)
const h206 = async (ctx: Ctx<"/res206/:id">) => json({ id: 206, key: ctx.params.id })
const h207 = async (ctx: Ctx<"/res207">) => json({ id: 207, key: "res207" })
const h208 = async (ctx: Ctx<"/res208/:id">) => json({ id: 208, key: ctx.params.id })
const h209 = withValidation(async (b: Body) => json({ id: 209, name: b.name, qty: b.qty }), bodySchema)
const h210 = async (ctx: Ctx<"/res210/:id">) => json({ id: 210, key: ctx.params.id })
const h211 = async (ctx: Ctx<"/res211">) => json({ id: 211, key: "res211" })
const h212 = async (ctx: Ctx<"/res212/:id">) => json({ id: 212, key: ctx.params.id })
const h213 = async (ctx: Ctx<"/res213">) => json({ id: 213, key: "res213" })
const h214 = async (ctx: Ctx<"/res214/:id">) => json({ id: 214, key: ctx.params.id })
const h215 = async (ctx: Ctx<"/res215">) => json({ id: 215, key: "res215" })
const h216 = async (ctx: Ctx<"/res216/:id">) => json({ id: 216, key: ctx.params.id })
const h217 = withValidation(async (b: Body) => json({ id: 217, name: b.name, qty: b.qty }), bodySchema)
const h218 = async (ctx: Ctx<"/res218/:id">) => json({ id: 218, key: ctx.params.id })
const h219 = async (ctx: Ctx<"/res219">) => json({ id: 219, key: "res219" })
const h220 = async (ctx: Ctx<"/res220/:id">) => json({ id: 220, key: ctx.params.id })
const h221 = withValidation(async (b: Body) => json({ id: 221, name: b.name, qty: b.qty }), bodySchema)
const h222 = async (ctx: Ctx<"/res222/:id">) => json({ id: 222, key: ctx.params.id })
const h223 = async (ctx: Ctx<"/res223">) => json({ id: 223, key: "res223" })
const h224 = async (ctx: Ctx<"/res224/:id">) => json({ id: 224, key: ctx.params.id })
const h225 = async (ctx: Ctx<"/res225">) => json({ id: 225, key: "res225" })
const h226 = async (ctx: Ctx<"/res226/:id">) => json({ id: 226, key: ctx.params.id })
const h227 = async (ctx: Ctx<"/res227">) => json({ id: 227, key: "res227" })
const h228 = async (ctx: Ctx<"/res228/:id">) => json({ id: 228, key: ctx.params.id })
const h229 = withValidation(async (b: Body) => json({ id: 229, name: b.name, qty: b.qty }), bodySchema)
const h230 = async (ctx: Ctx<"/res230/:id">) => json({ id: 230, key: ctx.params.id })
const h231 = async (ctx: Ctx<"/res231">) => json({ id: 231, key: "res231" })
const h232 = async (ctx: Ctx<"/res232/:id">) => json({ id: 232, key: ctx.params.id })
const h233 = withValidation(async (b: Body) => json({ id: 233, name: b.name, qty: b.qty }), bodySchema)
const h234 = async (ctx: Ctx<"/res234/:id">) => json({ id: 234, key: ctx.params.id })
const h235 = async (ctx: Ctx<"/res235">) => json({ id: 235, key: "res235" })
const h236 = async (ctx: Ctx<"/res236/:id">) => json({ id: 236, key: ctx.params.id })
const h237 = async (ctx: Ctx<"/res237">) => json({ id: 237, key: "res237" })
const h238 = async (ctx: Ctx<"/res238/:id">) => json({ id: 238, key: ctx.params.id })
const h239 = async (ctx: Ctx<"/res239">) => json({ id: 239, key: "res239" })
const h240 = async (ctx: Ctx<"/res240/:id">) => json({ id: 240, key: ctx.params.id })
const h241 = withValidation(async (b: Body) => json({ id: 241, name: b.name, qty: b.qty }), bodySchema)
const h242 = async (ctx: Ctx<"/res242/:id">) => json({ id: 242, key: ctx.params.id })
const h243 = async (ctx: Ctx<"/res243">) => json({ id: 243, key: "res243" })
const h244 = async (ctx: Ctx<"/res244/:id">) => json({ id: 244, key: ctx.params.id })
const h245 = withValidation(async (b: Body) => json({ id: 245, name: b.name, qty: b.qty }), bodySchema)
const h246 = async (ctx: Ctx<"/res246/:id">) => json({ id: 246, key: ctx.params.id })
const h247 = async (ctx: Ctx<"/res247">) => json({ id: 247, key: "res247" })
const h248 = async (ctx: Ctx<"/res248/:id">) => json({ id: 248, key: ctx.params.id })
const h249 = async (ctx: Ctx<"/res249">) => json({ id: 249, key: "res249" })
const h250 = async (ctx: Ctx<"/res250/:id">) => json({ id: 250, key: ctx.params.id })
const h251 = async (ctx: Ctx<"/res251">) => json({ id: 251, key: "res251" })
const h252 = async (ctx: Ctx<"/res252/:id">) => json({ id: 252, key: ctx.params.id })
const h253 = withValidation(async (b: Body) => json({ id: 253, name: b.name, qty: b.qty }), bodySchema)
const h254 = async (ctx: Ctx<"/res254/:id">) => json({ id: 254, key: ctx.params.id })
const h255 = async (ctx: Ctx<"/res255">) => json({ id: 255, key: "res255" })
const h256 = async (ctx: Ctx<"/res256/:id">) => json({ id: 256, key: ctx.params.id })
const h257 = withValidation(async (b: Body) => json({ id: 257, name: b.name, qty: b.qty }), bodySchema)
const h258 = async (ctx: Ctx<"/res258/:id">) => json({ id: 258, key: ctx.params.id })
const h259 = async (ctx: Ctx<"/res259">) => json({ id: 259, key: "res259" })
const h260 = async (ctx: Ctx<"/res260/:id">) => json({ id: 260, key: ctx.params.id })
const h261 = async (ctx: Ctx<"/res261">) => json({ id: 261, key: "res261" })
const h262 = async (ctx: Ctx<"/res262/:id">) => json({ id: 262, key: ctx.params.id })
const h263 = async (ctx: Ctx<"/res263">) => json({ id: 263, key: "res263" })
const h264 = async (ctx: Ctx<"/res264/:id">) => json({ id: 264, key: ctx.params.id })
const h265 = withValidation(async (b: Body) => json({ id: 265, name: b.name, qty: b.qty }), bodySchema)
const h266 = async (ctx: Ctx<"/res266/:id">) => json({ id: 266, key: ctx.params.id })
const h267 = async (ctx: Ctx<"/res267">) => json({ id: 267, key: "res267" })
const h268 = async (ctx: Ctx<"/res268/:id">) => json({ id: 268, key: ctx.params.id })
const h269 = withValidation(async (b: Body) => json({ id: 269, name: b.name, qty: b.qty }), bodySchema)
const h270 = async (ctx: Ctx<"/res270/:id">) => json({ id: 270, key: ctx.params.id })
const h271 = async (ctx: Ctx<"/res271">) => json({ id: 271, key: "res271" })
const h272 = async (ctx: Ctx<"/res272/:id">) => json({ id: 272, key: ctx.params.id })
const h273 = async (ctx: Ctx<"/res273">) => json({ id: 273, key: "res273" })
const h274 = async (ctx: Ctx<"/res274/:id">) => json({ id: 274, key: ctx.params.id })
const h275 = async (ctx: Ctx<"/res275">) => json({ id: 275, key: "res275" })
const h276 = async (ctx: Ctx<"/res276/:id">) => json({ id: 276, key: ctx.params.id })
const h277 = withValidation(async (b: Body) => json({ id: 277, name: b.name, qty: b.qty }), bodySchema)
const h278 = async (ctx: Ctx<"/res278/:id">) => json({ id: 278, key: ctx.params.id })
const h279 = async (ctx: Ctx<"/res279">) => json({ id: 279, key: "res279" })
const h280 = async (ctx: Ctx<"/res280/:id">) => json({ id: 280, key: ctx.params.id })
const h281 = withValidation(async (b: Body) => json({ id: 281, name: b.name, qty: b.qty }), bodySchema)
const h282 = async (ctx: Ctx<"/res282/:id">) => json({ id: 282, key: ctx.params.id })
const h283 = async (ctx: Ctx<"/res283">) => json({ id: 283, key: "res283" })
const h284 = async (ctx: Ctx<"/res284/:id">) => json({ id: 284, key: ctx.params.id })
const h285 = async (ctx: Ctx<"/res285">) => json({ id: 285, key: "res285" })
const h286 = async (ctx: Ctx<"/res286/:id">) => json({ id: 286, key: ctx.params.id })
const h287 = async (ctx: Ctx<"/res287">) => json({ id: 287, key: "res287" })
const h288 = async (ctx: Ctx<"/res288/:id">) => json({ id: 288, key: ctx.params.id })
const h289 = withValidation(async (b: Body) => json({ id: 289, name: b.name, qty: b.qty }), bodySchema)
const h290 = async (ctx: Ctx<"/res290/:id">) => json({ id: 290, key: ctx.params.id })
const h291 = async (ctx: Ctx<"/res291">) => json({ id: 291, key: "res291" })
const h292 = async (ctx: Ctx<"/res292/:id">) => json({ id: 292, key: ctx.params.id })
const h293 = withValidation(async (b: Body) => json({ id: 293, name: b.name, qty: b.qty }), bodySchema)
const h294 = async (ctx: Ctx<"/res294/:id">) => json({ id: 294, key: ctx.params.id })
const h295 = async (ctx: Ctx<"/res295">) => json({ id: 295, key: "res295" })
const h296 = async (ctx: Ctx<"/res296/:id">) => json({ id: 296, key: ctx.params.id })
const h297 = async (ctx: Ctx<"/res297">) => json({ id: 297, key: "res297" })
const h298 = async (ctx: Ctx<"/res298/:id">) => json({ id: 298, key: ctx.params.id })
const h299 = async (ctx: Ctx<"/res299">) => json({ id: 299, key: "res299" })

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
  h100,
  h101,
  h102,
  h103,
  h104,
  h105,
  h106,
  h107,
  h108,
  h109,
  h110,
  h111,
  h112,
  h113,
  h114,
  h115,
  h116,
  h117,
  h118,
  h119,
  h120,
  h121,
  h122,
  h123,
  h124,
  h125,
  h126,
  h127,
  h128,
  h129,
  h130,
  h131,
  h132,
  h133,
  h134,
  h135,
  h136,
  h137,
  h138,
  h139,
  h140,
  h141,
  h142,
  h143,
  h144,
  h145,
  h146,
  h147,
  h148,
  h149,
  h150,
  h151,
  h152,
  h153,
  h154,
  h155,
  h156,
  h157,
  h158,
  h159,
  h160,
  h161,
  h162,
  h163,
  h164,
  h165,
  h166,
  h167,
  h168,
  h169,
  h170,
  h171,
  h172,
  h173,
  h174,
  h175,
  h176,
  h177,
  h178,
  h179,
  h180,
  h181,
  h182,
  h183,
  h184,
  h185,
  h186,
  h187,
  h188,
  h189,
  h190,
  h191,
  h192,
  h193,
  h194,
  h195,
  h196,
  h197,
  h198,
  h199,
  h200,
  h201,
  h202,
  h203,
  h204,
  h205,
  h206,
  h207,
  h208,
  h209,
  h210,
  h211,
  h212,
  h213,
  h214,
  h215,
  h216,
  h217,
  h218,
  h219,
  h220,
  h221,
  h222,
  h223,
  h224,
  h225,
  h226,
  h227,
  h228,
  h229,
  h230,
  h231,
  h232,
  h233,
  h234,
  h235,
  h236,
  h237,
  h238,
  h239,
  h240,
  h241,
  h242,
  h243,
  h244,
  h245,
  h246,
  h247,
  h248,
  h249,
  h250,
  h251,
  h252,
  h253,
  h254,
  h255,
  h256,
  h257,
  h258,
  h259,
  h260,
  h261,
  h262,
  h263,
  h264,
  h265,
  h266,
  h267,
  h268,
  h269,
  h270,
  h271,
  h272,
  h273,
  h274,
  h275,
  h276,
  h277,
  h278,
  h279,
  h280,
  h281,
  h282,
  h283,
  h284,
  h285,
  h286,
  h287,
  h288,
  h289,
  h290,
  h291,
  h292,
  h293,
  h294,
  h295,
  h296,
  h297,
  h298,
  h299,
]
