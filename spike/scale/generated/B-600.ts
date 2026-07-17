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
const h300 = async (ctx: Ctx<"/res300/:id">) => json({ id: 300, key: ctx.params.id })
const h301 = withValidation(async (b: Body) => json({ id: 301, name: b.name, qty: b.qty }), bodySchema)
const h302 = async (ctx: Ctx<"/res302/:id">) => json({ id: 302, key: ctx.params.id })
const h303 = async (ctx: Ctx<"/res303">) => json({ id: 303, key: "res303" })
const h304 = async (ctx: Ctx<"/res304/:id">) => json({ id: 304, key: ctx.params.id })
const h305 = withValidation(async (b: Body) => json({ id: 305, name: b.name, qty: b.qty }), bodySchema)
const h306 = async (ctx: Ctx<"/res306/:id">) => json({ id: 306, key: ctx.params.id })
const h307 = async (ctx: Ctx<"/res307">) => json({ id: 307, key: "res307" })
const h308 = async (ctx: Ctx<"/res308/:id">) => json({ id: 308, key: ctx.params.id })
const h309 = async (ctx: Ctx<"/res309">) => json({ id: 309, key: "res309" })
const h310 = async (ctx: Ctx<"/res310/:id">) => json({ id: 310, key: ctx.params.id })
const h311 = async (ctx: Ctx<"/res311">) => json({ id: 311, key: "res311" })
const h312 = async (ctx: Ctx<"/res312/:id">) => json({ id: 312, key: ctx.params.id })
const h313 = withValidation(async (b: Body) => json({ id: 313, name: b.name, qty: b.qty }), bodySchema)
const h314 = async (ctx: Ctx<"/res314/:id">) => json({ id: 314, key: ctx.params.id })
const h315 = async (ctx: Ctx<"/res315">) => json({ id: 315, key: "res315" })
const h316 = async (ctx: Ctx<"/res316/:id">) => json({ id: 316, key: ctx.params.id })
const h317 = withValidation(async (b: Body) => json({ id: 317, name: b.name, qty: b.qty }), bodySchema)
const h318 = async (ctx: Ctx<"/res318/:id">) => json({ id: 318, key: ctx.params.id })
const h319 = async (ctx: Ctx<"/res319">) => json({ id: 319, key: "res319" })
const h320 = async (ctx: Ctx<"/res320/:id">) => json({ id: 320, key: ctx.params.id })
const h321 = async (ctx: Ctx<"/res321">) => json({ id: 321, key: "res321" })
const h322 = async (ctx: Ctx<"/res322/:id">) => json({ id: 322, key: ctx.params.id })
const h323 = async (ctx: Ctx<"/res323">) => json({ id: 323, key: "res323" })
const h324 = async (ctx: Ctx<"/res324/:id">) => json({ id: 324, key: ctx.params.id })
const h325 = withValidation(async (b: Body) => json({ id: 325, name: b.name, qty: b.qty }), bodySchema)
const h326 = async (ctx: Ctx<"/res326/:id">) => json({ id: 326, key: ctx.params.id })
const h327 = async (ctx: Ctx<"/res327">) => json({ id: 327, key: "res327" })
const h328 = async (ctx: Ctx<"/res328/:id">) => json({ id: 328, key: ctx.params.id })
const h329 = withValidation(async (b: Body) => json({ id: 329, name: b.name, qty: b.qty }), bodySchema)
const h330 = async (ctx: Ctx<"/res330/:id">) => json({ id: 330, key: ctx.params.id })
const h331 = async (ctx: Ctx<"/res331">) => json({ id: 331, key: "res331" })
const h332 = async (ctx: Ctx<"/res332/:id">) => json({ id: 332, key: ctx.params.id })
const h333 = async (ctx: Ctx<"/res333">) => json({ id: 333, key: "res333" })
const h334 = async (ctx: Ctx<"/res334/:id">) => json({ id: 334, key: ctx.params.id })
const h335 = async (ctx: Ctx<"/res335">) => json({ id: 335, key: "res335" })
const h336 = async (ctx: Ctx<"/res336/:id">) => json({ id: 336, key: ctx.params.id })
const h337 = withValidation(async (b: Body) => json({ id: 337, name: b.name, qty: b.qty }), bodySchema)
const h338 = async (ctx: Ctx<"/res338/:id">) => json({ id: 338, key: ctx.params.id })
const h339 = async (ctx: Ctx<"/res339">) => json({ id: 339, key: "res339" })
const h340 = async (ctx: Ctx<"/res340/:id">) => json({ id: 340, key: ctx.params.id })
const h341 = withValidation(async (b: Body) => json({ id: 341, name: b.name, qty: b.qty }), bodySchema)
const h342 = async (ctx: Ctx<"/res342/:id">) => json({ id: 342, key: ctx.params.id })
const h343 = async (ctx: Ctx<"/res343">) => json({ id: 343, key: "res343" })
const h344 = async (ctx: Ctx<"/res344/:id">) => json({ id: 344, key: ctx.params.id })
const h345 = async (ctx: Ctx<"/res345">) => json({ id: 345, key: "res345" })
const h346 = async (ctx: Ctx<"/res346/:id">) => json({ id: 346, key: ctx.params.id })
const h347 = async (ctx: Ctx<"/res347">) => json({ id: 347, key: "res347" })
const h348 = async (ctx: Ctx<"/res348/:id">) => json({ id: 348, key: ctx.params.id })
const h349 = withValidation(async (b: Body) => json({ id: 349, name: b.name, qty: b.qty }), bodySchema)
const h350 = async (ctx: Ctx<"/res350/:id">) => json({ id: 350, key: ctx.params.id })
const h351 = async (ctx: Ctx<"/res351">) => json({ id: 351, key: "res351" })
const h352 = async (ctx: Ctx<"/res352/:id">) => json({ id: 352, key: ctx.params.id })
const h353 = withValidation(async (b: Body) => json({ id: 353, name: b.name, qty: b.qty }), bodySchema)
const h354 = async (ctx: Ctx<"/res354/:id">) => json({ id: 354, key: ctx.params.id })
const h355 = async (ctx: Ctx<"/res355">) => json({ id: 355, key: "res355" })
const h356 = async (ctx: Ctx<"/res356/:id">) => json({ id: 356, key: ctx.params.id })
const h357 = async (ctx: Ctx<"/res357">) => json({ id: 357, key: "res357" })
const h358 = async (ctx: Ctx<"/res358/:id">) => json({ id: 358, key: ctx.params.id })
const h359 = async (ctx: Ctx<"/res359">) => json({ id: 359, key: "res359" })
const h360 = async (ctx: Ctx<"/res360/:id">) => json({ id: 360, key: ctx.params.id })
const h361 = withValidation(async (b: Body) => json({ id: 361, name: b.name, qty: b.qty }), bodySchema)
const h362 = async (ctx: Ctx<"/res362/:id">) => json({ id: 362, key: ctx.params.id })
const h363 = async (ctx: Ctx<"/res363">) => json({ id: 363, key: "res363" })
const h364 = async (ctx: Ctx<"/res364/:id">) => json({ id: 364, key: ctx.params.id })
const h365 = withValidation(async (b: Body) => json({ id: 365, name: b.name, qty: b.qty }), bodySchema)
const h366 = async (ctx: Ctx<"/res366/:id">) => json({ id: 366, key: ctx.params.id })
const h367 = async (ctx: Ctx<"/res367">) => json({ id: 367, key: "res367" })
const h368 = async (ctx: Ctx<"/res368/:id">) => json({ id: 368, key: ctx.params.id })
const h369 = async (ctx: Ctx<"/res369">) => json({ id: 369, key: "res369" })
const h370 = async (ctx: Ctx<"/res370/:id">) => json({ id: 370, key: ctx.params.id })
const h371 = async (ctx: Ctx<"/res371">) => json({ id: 371, key: "res371" })
const h372 = async (ctx: Ctx<"/res372/:id">) => json({ id: 372, key: ctx.params.id })
const h373 = withValidation(async (b: Body) => json({ id: 373, name: b.name, qty: b.qty }), bodySchema)
const h374 = async (ctx: Ctx<"/res374/:id">) => json({ id: 374, key: ctx.params.id })
const h375 = async (ctx: Ctx<"/res375">) => json({ id: 375, key: "res375" })
const h376 = async (ctx: Ctx<"/res376/:id">) => json({ id: 376, key: ctx.params.id })
const h377 = withValidation(async (b: Body) => json({ id: 377, name: b.name, qty: b.qty }), bodySchema)
const h378 = async (ctx: Ctx<"/res378/:id">) => json({ id: 378, key: ctx.params.id })
const h379 = async (ctx: Ctx<"/res379">) => json({ id: 379, key: "res379" })
const h380 = async (ctx: Ctx<"/res380/:id">) => json({ id: 380, key: ctx.params.id })
const h381 = async (ctx: Ctx<"/res381">) => json({ id: 381, key: "res381" })
const h382 = async (ctx: Ctx<"/res382/:id">) => json({ id: 382, key: ctx.params.id })
const h383 = async (ctx: Ctx<"/res383">) => json({ id: 383, key: "res383" })
const h384 = async (ctx: Ctx<"/res384/:id">) => json({ id: 384, key: ctx.params.id })
const h385 = withValidation(async (b: Body) => json({ id: 385, name: b.name, qty: b.qty }), bodySchema)
const h386 = async (ctx: Ctx<"/res386/:id">) => json({ id: 386, key: ctx.params.id })
const h387 = async (ctx: Ctx<"/res387">) => json({ id: 387, key: "res387" })
const h388 = async (ctx: Ctx<"/res388/:id">) => json({ id: 388, key: ctx.params.id })
const h389 = withValidation(async (b: Body) => json({ id: 389, name: b.name, qty: b.qty }), bodySchema)
const h390 = async (ctx: Ctx<"/res390/:id">) => json({ id: 390, key: ctx.params.id })
const h391 = async (ctx: Ctx<"/res391">) => json({ id: 391, key: "res391" })
const h392 = async (ctx: Ctx<"/res392/:id">) => json({ id: 392, key: ctx.params.id })
const h393 = async (ctx: Ctx<"/res393">) => json({ id: 393, key: "res393" })
const h394 = async (ctx: Ctx<"/res394/:id">) => json({ id: 394, key: ctx.params.id })
const h395 = async (ctx: Ctx<"/res395">) => json({ id: 395, key: "res395" })
const h396 = async (ctx: Ctx<"/res396/:id">) => json({ id: 396, key: ctx.params.id })
const h397 = withValidation(async (b: Body) => json({ id: 397, name: b.name, qty: b.qty }), bodySchema)
const h398 = async (ctx: Ctx<"/res398/:id">) => json({ id: 398, key: ctx.params.id })
const h399 = async (ctx: Ctx<"/res399">) => json({ id: 399, key: "res399" })
const h400 = async (ctx: Ctx<"/res400/:id">) => json({ id: 400, key: ctx.params.id })
const h401 = withValidation(async (b: Body) => json({ id: 401, name: b.name, qty: b.qty }), bodySchema)
const h402 = async (ctx: Ctx<"/res402/:id">) => json({ id: 402, key: ctx.params.id })
const h403 = async (ctx: Ctx<"/res403">) => json({ id: 403, key: "res403" })
const h404 = async (ctx: Ctx<"/res404/:id">) => json({ id: 404, key: ctx.params.id })
const h405 = async (ctx: Ctx<"/res405">) => json({ id: 405, key: "res405" })
const h406 = async (ctx: Ctx<"/res406/:id">) => json({ id: 406, key: ctx.params.id })
const h407 = async (ctx: Ctx<"/res407">) => json({ id: 407, key: "res407" })
const h408 = async (ctx: Ctx<"/res408/:id">) => json({ id: 408, key: ctx.params.id })
const h409 = withValidation(async (b: Body) => json({ id: 409, name: b.name, qty: b.qty }), bodySchema)
const h410 = async (ctx: Ctx<"/res410/:id">) => json({ id: 410, key: ctx.params.id })
const h411 = async (ctx: Ctx<"/res411">) => json({ id: 411, key: "res411" })
const h412 = async (ctx: Ctx<"/res412/:id">) => json({ id: 412, key: ctx.params.id })
const h413 = withValidation(async (b: Body) => json({ id: 413, name: b.name, qty: b.qty }), bodySchema)
const h414 = async (ctx: Ctx<"/res414/:id">) => json({ id: 414, key: ctx.params.id })
const h415 = async (ctx: Ctx<"/res415">) => json({ id: 415, key: "res415" })
const h416 = async (ctx: Ctx<"/res416/:id">) => json({ id: 416, key: ctx.params.id })
const h417 = async (ctx: Ctx<"/res417">) => json({ id: 417, key: "res417" })
const h418 = async (ctx: Ctx<"/res418/:id">) => json({ id: 418, key: ctx.params.id })
const h419 = async (ctx: Ctx<"/res419">) => json({ id: 419, key: "res419" })
const h420 = async (ctx: Ctx<"/res420/:id">) => json({ id: 420, key: ctx.params.id })
const h421 = withValidation(async (b: Body) => json({ id: 421, name: b.name, qty: b.qty }), bodySchema)
const h422 = async (ctx: Ctx<"/res422/:id">) => json({ id: 422, key: ctx.params.id })
const h423 = async (ctx: Ctx<"/res423">) => json({ id: 423, key: "res423" })
const h424 = async (ctx: Ctx<"/res424/:id">) => json({ id: 424, key: ctx.params.id })
const h425 = withValidation(async (b: Body) => json({ id: 425, name: b.name, qty: b.qty }), bodySchema)
const h426 = async (ctx: Ctx<"/res426/:id">) => json({ id: 426, key: ctx.params.id })
const h427 = async (ctx: Ctx<"/res427">) => json({ id: 427, key: "res427" })
const h428 = async (ctx: Ctx<"/res428/:id">) => json({ id: 428, key: ctx.params.id })
const h429 = async (ctx: Ctx<"/res429">) => json({ id: 429, key: "res429" })
const h430 = async (ctx: Ctx<"/res430/:id">) => json({ id: 430, key: ctx.params.id })
const h431 = async (ctx: Ctx<"/res431">) => json({ id: 431, key: "res431" })
const h432 = async (ctx: Ctx<"/res432/:id">) => json({ id: 432, key: ctx.params.id })
const h433 = withValidation(async (b: Body) => json({ id: 433, name: b.name, qty: b.qty }), bodySchema)
const h434 = async (ctx: Ctx<"/res434/:id">) => json({ id: 434, key: ctx.params.id })
const h435 = async (ctx: Ctx<"/res435">) => json({ id: 435, key: "res435" })
const h436 = async (ctx: Ctx<"/res436/:id">) => json({ id: 436, key: ctx.params.id })
const h437 = withValidation(async (b: Body) => json({ id: 437, name: b.name, qty: b.qty }), bodySchema)
const h438 = async (ctx: Ctx<"/res438/:id">) => json({ id: 438, key: ctx.params.id })
const h439 = async (ctx: Ctx<"/res439">) => json({ id: 439, key: "res439" })
const h440 = async (ctx: Ctx<"/res440/:id">) => json({ id: 440, key: ctx.params.id })
const h441 = async (ctx: Ctx<"/res441">) => json({ id: 441, key: "res441" })
const h442 = async (ctx: Ctx<"/res442/:id">) => json({ id: 442, key: ctx.params.id })
const h443 = async (ctx: Ctx<"/res443">) => json({ id: 443, key: "res443" })
const h444 = async (ctx: Ctx<"/res444/:id">) => json({ id: 444, key: ctx.params.id })
const h445 = withValidation(async (b: Body) => json({ id: 445, name: b.name, qty: b.qty }), bodySchema)
const h446 = async (ctx: Ctx<"/res446/:id">) => json({ id: 446, key: ctx.params.id })
const h447 = async (ctx: Ctx<"/res447">) => json({ id: 447, key: "res447" })
const h448 = async (ctx: Ctx<"/res448/:id">) => json({ id: 448, key: ctx.params.id })
const h449 = withValidation(async (b: Body) => json({ id: 449, name: b.name, qty: b.qty }), bodySchema)
const h450 = async (ctx: Ctx<"/res450/:id">) => json({ id: 450, key: ctx.params.id })
const h451 = async (ctx: Ctx<"/res451">) => json({ id: 451, key: "res451" })
const h452 = async (ctx: Ctx<"/res452/:id">) => json({ id: 452, key: ctx.params.id })
const h453 = async (ctx: Ctx<"/res453">) => json({ id: 453, key: "res453" })
const h454 = async (ctx: Ctx<"/res454/:id">) => json({ id: 454, key: ctx.params.id })
const h455 = async (ctx: Ctx<"/res455">) => json({ id: 455, key: "res455" })
const h456 = async (ctx: Ctx<"/res456/:id">) => json({ id: 456, key: ctx.params.id })
const h457 = withValidation(async (b: Body) => json({ id: 457, name: b.name, qty: b.qty }), bodySchema)
const h458 = async (ctx: Ctx<"/res458/:id">) => json({ id: 458, key: ctx.params.id })
const h459 = async (ctx: Ctx<"/res459">) => json({ id: 459, key: "res459" })
const h460 = async (ctx: Ctx<"/res460/:id">) => json({ id: 460, key: ctx.params.id })
const h461 = withValidation(async (b: Body) => json({ id: 461, name: b.name, qty: b.qty }), bodySchema)
const h462 = async (ctx: Ctx<"/res462/:id">) => json({ id: 462, key: ctx.params.id })
const h463 = async (ctx: Ctx<"/res463">) => json({ id: 463, key: "res463" })
const h464 = async (ctx: Ctx<"/res464/:id">) => json({ id: 464, key: ctx.params.id })
const h465 = async (ctx: Ctx<"/res465">) => json({ id: 465, key: "res465" })
const h466 = async (ctx: Ctx<"/res466/:id">) => json({ id: 466, key: ctx.params.id })
const h467 = async (ctx: Ctx<"/res467">) => json({ id: 467, key: "res467" })
const h468 = async (ctx: Ctx<"/res468/:id">) => json({ id: 468, key: ctx.params.id })
const h469 = withValidation(async (b: Body) => json({ id: 469, name: b.name, qty: b.qty }), bodySchema)
const h470 = async (ctx: Ctx<"/res470/:id">) => json({ id: 470, key: ctx.params.id })
const h471 = async (ctx: Ctx<"/res471">) => json({ id: 471, key: "res471" })
const h472 = async (ctx: Ctx<"/res472/:id">) => json({ id: 472, key: ctx.params.id })
const h473 = withValidation(async (b: Body) => json({ id: 473, name: b.name, qty: b.qty }), bodySchema)
const h474 = async (ctx: Ctx<"/res474/:id">) => json({ id: 474, key: ctx.params.id })
const h475 = async (ctx: Ctx<"/res475">) => json({ id: 475, key: "res475" })
const h476 = async (ctx: Ctx<"/res476/:id">) => json({ id: 476, key: ctx.params.id })
const h477 = async (ctx: Ctx<"/res477">) => json({ id: 477, key: "res477" })
const h478 = async (ctx: Ctx<"/res478/:id">) => json({ id: 478, key: ctx.params.id })
const h479 = async (ctx: Ctx<"/res479">) => json({ id: 479, key: "res479" })
const h480 = async (ctx: Ctx<"/res480/:id">) => json({ id: 480, key: ctx.params.id })
const h481 = withValidation(async (b: Body) => json({ id: 481, name: b.name, qty: b.qty }), bodySchema)
const h482 = async (ctx: Ctx<"/res482/:id">) => json({ id: 482, key: ctx.params.id })
const h483 = async (ctx: Ctx<"/res483">) => json({ id: 483, key: "res483" })
const h484 = async (ctx: Ctx<"/res484/:id">) => json({ id: 484, key: ctx.params.id })
const h485 = withValidation(async (b: Body) => json({ id: 485, name: b.name, qty: b.qty }), bodySchema)
const h486 = async (ctx: Ctx<"/res486/:id">) => json({ id: 486, key: ctx.params.id })
const h487 = async (ctx: Ctx<"/res487">) => json({ id: 487, key: "res487" })
const h488 = async (ctx: Ctx<"/res488/:id">) => json({ id: 488, key: ctx.params.id })
const h489 = async (ctx: Ctx<"/res489">) => json({ id: 489, key: "res489" })
const h490 = async (ctx: Ctx<"/res490/:id">) => json({ id: 490, key: ctx.params.id })
const h491 = async (ctx: Ctx<"/res491">) => json({ id: 491, key: "res491" })
const h492 = async (ctx: Ctx<"/res492/:id">) => json({ id: 492, key: ctx.params.id })
const h493 = withValidation(async (b: Body) => json({ id: 493, name: b.name, qty: b.qty }), bodySchema)
const h494 = async (ctx: Ctx<"/res494/:id">) => json({ id: 494, key: ctx.params.id })
const h495 = async (ctx: Ctx<"/res495">) => json({ id: 495, key: "res495" })
const h496 = async (ctx: Ctx<"/res496/:id">) => json({ id: 496, key: ctx.params.id })
const h497 = withValidation(async (b: Body) => json({ id: 497, name: b.name, qty: b.qty }), bodySchema)
const h498 = async (ctx: Ctx<"/res498/:id">) => json({ id: 498, key: ctx.params.id })
const h499 = async (ctx: Ctx<"/res499">) => json({ id: 499, key: "res499" })
const h500 = async (ctx: Ctx<"/res500/:id">) => json({ id: 500, key: ctx.params.id })
const h501 = async (ctx: Ctx<"/res501">) => json({ id: 501, key: "res501" })
const h502 = async (ctx: Ctx<"/res502/:id">) => json({ id: 502, key: ctx.params.id })
const h503 = async (ctx: Ctx<"/res503">) => json({ id: 503, key: "res503" })
const h504 = async (ctx: Ctx<"/res504/:id">) => json({ id: 504, key: ctx.params.id })
const h505 = withValidation(async (b: Body) => json({ id: 505, name: b.name, qty: b.qty }), bodySchema)
const h506 = async (ctx: Ctx<"/res506/:id">) => json({ id: 506, key: ctx.params.id })
const h507 = async (ctx: Ctx<"/res507">) => json({ id: 507, key: "res507" })
const h508 = async (ctx: Ctx<"/res508/:id">) => json({ id: 508, key: ctx.params.id })
const h509 = withValidation(async (b: Body) => json({ id: 509, name: b.name, qty: b.qty }), bodySchema)
const h510 = async (ctx: Ctx<"/res510/:id">) => json({ id: 510, key: ctx.params.id })
const h511 = async (ctx: Ctx<"/res511">) => json({ id: 511, key: "res511" })
const h512 = async (ctx: Ctx<"/res512/:id">) => json({ id: 512, key: ctx.params.id })
const h513 = async (ctx: Ctx<"/res513">) => json({ id: 513, key: "res513" })
const h514 = async (ctx: Ctx<"/res514/:id">) => json({ id: 514, key: ctx.params.id })
const h515 = async (ctx: Ctx<"/res515">) => json({ id: 515, key: "res515" })
const h516 = async (ctx: Ctx<"/res516/:id">) => json({ id: 516, key: ctx.params.id })
const h517 = withValidation(async (b: Body) => json({ id: 517, name: b.name, qty: b.qty }), bodySchema)
const h518 = async (ctx: Ctx<"/res518/:id">) => json({ id: 518, key: ctx.params.id })
const h519 = async (ctx: Ctx<"/res519">) => json({ id: 519, key: "res519" })
const h520 = async (ctx: Ctx<"/res520/:id">) => json({ id: 520, key: ctx.params.id })
const h521 = withValidation(async (b: Body) => json({ id: 521, name: b.name, qty: b.qty }), bodySchema)
const h522 = async (ctx: Ctx<"/res522/:id">) => json({ id: 522, key: ctx.params.id })
const h523 = async (ctx: Ctx<"/res523">) => json({ id: 523, key: "res523" })
const h524 = async (ctx: Ctx<"/res524/:id">) => json({ id: 524, key: ctx.params.id })
const h525 = async (ctx: Ctx<"/res525">) => json({ id: 525, key: "res525" })
const h526 = async (ctx: Ctx<"/res526/:id">) => json({ id: 526, key: ctx.params.id })
const h527 = async (ctx: Ctx<"/res527">) => json({ id: 527, key: "res527" })
const h528 = async (ctx: Ctx<"/res528/:id">) => json({ id: 528, key: ctx.params.id })
const h529 = withValidation(async (b: Body) => json({ id: 529, name: b.name, qty: b.qty }), bodySchema)
const h530 = async (ctx: Ctx<"/res530/:id">) => json({ id: 530, key: ctx.params.id })
const h531 = async (ctx: Ctx<"/res531">) => json({ id: 531, key: "res531" })
const h532 = async (ctx: Ctx<"/res532/:id">) => json({ id: 532, key: ctx.params.id })
const h533 = withValidation(async (b: Body) => json({ id: 533, name: b.name, qty: b.qty }), bodySchema)
const h534 = async (ctx: Ctx<"/res534/:id">) => json({ id: 534, key: ctx.params.id })
const h535 = async (ctx: Ctx<"/res535">) => json({ id: 535, key: "res535" })
const h536 = async (ctx: Ctx<"/res536/:id">) => json({ id: 536, key: ctx.params.id })
const h537 = async (ctx: Ctx<"/res537">) => json({ id: 537, key: "res537" })
const h538 = async (ctx: Ctx<"/res538/:id">) => json({ id: 538, key: ctx.params.id })
const h539 = async (ctx: Ctx<"/res539">) => json({ id: 539, key: "res539" })
const h540 = async (ctx: Ctx<"/res540/:id">) => json({ id: 540, key: ctx.params.id })
const h541 = withValidation(async (b: Body) => json({ id: 541, name: b.name, qty: b.qty }), bodySchema)
const h542 = async (ctx: Ctx<"/res542/:id">) => json({ id: 542, key: ctx.params.id })
const h543 = async (ctx: Ctx<"/res543">) => json({ id: 543, key: "res543" })
const h544 = async (ctx: Ctx<"/res544/:id">) => json({ id: 544, key: ctx.params.id })
const h545 = withValidation(async (b: Body) => json({ id: 545, name: b.name, qty: b.qty }), bodySchema)
const h546 = async (ctx: Ctx<"/res546/:id">) => json({ id: 546, key: ctx.params.id })
const h547 = async (ctx: Ctx<"/res547">) => json({ id: 547, key: "res547" })
const h548 = async (ctx: Ctx<"/res548/:id">) => json({ id: 548, key: ctx.params.id })
const h549 = async (ctx: Ctx<"/res549">) => json({ id: 549, key: "res549" })
const h550 = async (ctx: Ctx<"/res550/:id">) => json({ id: 550, key: ctx.params.id })
const h551 = async (ctx: Ctx<"/res551">) => json({ id: 551, key: "res551" })
const h552 = async (ctx: Ctx<"/res552/:id">) => json({ id: 552, key: ctx.params.id })
const h553 = withValidation(async (b: Body) => json({ id: 553, name: b.name, qty: b.qty }), bodySchema)
const h554 = async (ctx: Ctx<"/res554/:id">) => json({ id: 554, key: ctx.params.id })
const h555 = async (ctx: Ctx<"/res555">) => json({ id: 555, key: "res555" })
const h556 = async (ctx: Ctx<"/res556/:id">) => json({ id: 556, key: ctx.params.id })
const h557 = withValidation(async (b: Body) => json({ id: 557, name: b.name, qty: b.qty }), bodySchema)
const h558 = async (ctx: Ctx<"/res558/:id">) => json({ id: 558, key: ctx.params.id })
const h559 = async (ctx: Ctx<"/res559">) => json({ id: 559, key: "res559" })
const h560 = async (ctx: Ctx<"/res560/:id">) => json({ id: 560, key: ctx.params.id })
const h561 = async (ctx: Ctx<"/res561">) => json({ id: 561, key: "res561" })
const h562 = async (ctx: Ctx<"/res562/:id">) => json({ id: 562, key: ctx.params.id })
const h563 = async (ctx: Ctx<"/res563">) => json({ id: 563, key: "res563" })
const h564 = async (ctx: Ctx<"/res564/:id">) => json({ id: 564, key: ctx.params.id })
const h565 = withValidation(async (b: Body) => json({ id: 565, name: b.name, qty: b.qty }), bodySchema)
const h566 = async (ctx: Ctx<"/res566/:id">) => json({ id: 566, key: ctx.params.id })
const h567 = async (ctx: Ctx<"/res567">) => json({ id: 567, key: "res567" })
const h568 = async (ctx: Ctx<"/res568/:id">) => json({ id: 568, key: ctx.params.id })
const h569 = withValidation(async (b: Body) => json({ id: 569, name: b.name, qty: b.qty }), bodySchema)
const h570 = async (ctx: Ctx<"/res570/:id">) => json({ id: 570, key: ctx.params.id })
const h571 = async (ctx: Ctx<"/res571">) => json({ id: 571, key: "res571" })
const h572 = async (ctx: Ctx<"/res572/:id">) => json({ id: 572, key: ctx.params.id })
const h573 = async (ctx: Ctx<"/res573">) => json({ id: 573, key: "res573" })
const h574 = async (ctx: Ctx<"/res574/:id">) => json({ id: 574, key: ctx.params.id })
const h575 = async (ctx: Ctx<"/res575">) => json({ id: 575, key: "res575" })
const h576 = async (ctx: Ctx<"/res576/:id">) => json({ id: 576, key: ctx.params.id })
const h577 = withValidation(async (b: Body) => json({ id: 577, name: b.name, qty: b.qty }), bodySchema)
const h578 = async (ctx: Ctx<"/res578/:id">) => json({ id: 578, key: ctx.params.id })
const h579 = async (ctx: Ctx<"/res579">) => json({ id: 579, key: "res579" })
const h580 = async (ctx: Ctx<"/res580/:id">) => json({ id: 580, key: ctx.params.id })
const h581 = withValidation(async (b: Body) => json({ id: 581, name: b.name, qty: b.qty }), bodySchema)
const h582 = async (ctx: Ctx<"/res582/:id">) => json({ id: 582, key: ctx.params.id })
const h583 = async (ctx: Ctx<"/res583">) => json({ id: 583, key: "res583" })
const h584 = async (ctx: Ctx<"/res584/:id">) => json({ id: 584, key: ctx.params.id })
const h585 = async (ctx: Ctx<"/res585">) => json({ id: 585, key: "res585" })
const h586 = async (ctx: Ctx<"/res586/:id">) => json({ id: 586, key: ctx.params.id })
const h587 = async (ctx: Ctx<"/res587">) => json({ id: 587, key: "res587" })
const h588 = async (ctx: Ctx<"/res588/:id">) => json({ id: 588, key: ctx.params.id })
const h589 = withValidation(async (b: Body) => json({ id: 589, name: b.name, qty: b.qty }), bodySchema)
const h590 = async (ctx: Ctx<"/res590/:id">) => json({ id: 590, key: ctx.params.id })
const h591 = async (ctx: Ctx<"/res591">) => json({ id: 591, key: "res591" })
const h592 = async (ctx: Ctx<"/res592/:id">) => json({ id: 592, key: ctx.params.id })
const h593 = withValidation(async (b: Body) => json({ id: 593, name: b.name, qty: b.qty }), bodySchema)
const h594 = async (ctx: Ctx<"/res594/:id">) => json({ id: 594, key: ctx.params.id })
const h595 = async (ctx: Ctx<"/res595">) => json({ id: 595, key: "res595" })
const h596 = async (ctx: Ctx<"/res596/:id">) => json({ id: 596, key: ctx.params.id })
const h597 = async (ctx: Ctx<"/res597">) => json({ id: 597, key: "res597" })
const h598 = async (ctx: Ctx<"/res598/:id">) => json({ id: 598, key: ctx.params.id })
const h599 = async (ctx: Ctx<"/res599">) => json({ id: 599, key: "res599" })

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
  h300,
  h301,
  h302,
  h303,
  h304,
  h305,
  h306,
  h307,
  h308,
  h309,
  h310,
  h311,
  h312,
  h313,
  h314,
  h315,
  h316,
  h317,
  h318,
  h319,
  h320,
  h321,
  h322,
  h323,
  h324,
  h325,
  h326,
  h327,
  h328,
  h329,
  h330,
  h331,
  h332,
  h333,
  h334,
  h335,
  h336,
  h337,
  h338,
  h339,
  h340,
  h341,
  h342,
  h343,
  h344,
  h345,
  h346,
  h347,
  h348,
  h349,
  h350,
  h351,
  h352,
  h353,
  h354,
  h355,
  h356,
  h357,
  h358,
  h359,
  h360,
  h361,
  h362,
  h363,
  h364,
  h365,
  h366,
  h367,
  h368,
  h369,
  h370,
  h371,
  h372,
  h373,
  h374,
  h375,
  h376,
  h377,
  h378,
  h379,
  h380,
  h381,
  h382,
  h383,
  h384,
  h385,
  h386,
  h387,
  h388,
  h389,
  h390,
  h391,
  h392,
  h393,
  h394,
  h395,
  h396,
  h397,
  h398,
  h399,
  h400,
  h401,
  h402,
  h403,
  h404,
  h405,
  h406,
  h407,
  h408,
  h409,
  h410,
  h411,
  h412,
  h413,
  h414,
  h415,
  h416,
  h417,
  h418,
  h419,
  h420,
  h421,
  h422,
  h423,
  h424,
  h425,
  h426,
  h427,
  h428,
  h429,
  h430,
  h431,
  h432,
  h433,
  h434,
  h435,
  h436,
  h437,
  h438,
  h439,
  h440,
  h441,
  h442,
  h443,
  h444,
  h445,
  h446,
  h447,
  h448,
  h449,
  h450,
  h451,
  h452,
  h453,
  h454,
  h455,
  h456,
  h457,
  h458,
  h459,
  h460,
  h461,
  h462,
  h463,
  h464,
  h465,
  h466,
  h467,
  h468,
  h469,
  h470,
  h471,
  h472,
  h473,
  h474,
  h475,
  h476,
  h477,
  h478,
  h479,
  h480,
  h481,
  h482,
  h483,
  h484,
  h485,
  h486,
  h487,
  h488,
  h489,
  h490,
  h491,
  h492,
  h493,
  h494,
  h495,
  h496,
  h497,
  h498,
  h499,
  h500,
  h501,
  h502,
  h503,
  h504,
  h505,
  h506,
  h507,
  h508,
  h509,
  h510,
  h511,
  h512,
  h513,
  h514,
  h515,
  h516,
  h517,
  h518,
  h519,
  h520,
  h521,
  h522,
  h523,
  h524,
  h525,
  h526,
  h527,
  h528,
  h529,
  h530,
  h531,
  h532,
  h533,
  h534,
  h535,
  h536,
  h537,
  h538,
  h539,
  h540,
  h541,
  h542,
  h543,
  h544,
  h545,
  h546,
  h547,
  h548,
  h549,
  h550,
  h551,
  h552,
  h553,
  h554,
  h555,
  h556,
  h557,
  h558,
  h559,
  h560,
  h561,
  h562,
  h563,
  h564,
  h565,
  h566,
  h567,
  h568,
  h569,
  h570,
  h571,
  h572,
  h573,
  h574,
  h575,
  h576,
  h577,
  h578,
  h579,
  h580,
  h581,
  h582,
  h583,
  h584,
  h585,
  h586,
  h587,
  h588,
  h589,
  h590,
  h591,
  h592,
  h593,
  h594,
  h595,
  h596,
  h597,
  h598,
  h599,
]
