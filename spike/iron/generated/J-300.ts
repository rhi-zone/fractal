import { route, path, lit, param, json } from "../http.ts"
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
const h1 = route("POST", path(lit("res1")), bodySchema, async (ctx) => json({ id: 1, name: ctx.input.name, qty: ctx.input.qty }))
const h2 = route("PUT", path(lit("res2"), param("id")), async (ctx) => json({ id: 2, key: ctx.params.id }))
const h3 = route("GET", path(lit("res3")), async (ctx) => json({ id: 3, key: "res3" }))
const h4 = route("POST", path(lit("res4"), param("id")), async (ctx) => json({ id: 4, key: ctx.params.id }))
const h5 = route("PUT", path(lit("res5")), bodySchema, async (ctx) => json({ id: 5, name: ctx.input.name, qty: ctx.input.qty }))
const h6 = route("GET", path(lit("res6"), param("id")), async (ctx) => json({ id: 6, key: ctx.params.id }))
const h7 = route("POST", path(lit("res7")), async (ctx) => json({ id: 7, key: "res7" }))
const h8 = route("PUT", path(lit("res8"), param("id")), async (ctx) => json({ id: 8, key: ctx.params.id }))
const h9 = route("GET", path(lit("res9")), async (ctx) => json({ id: 9, key: "res9" }))
const h10 = route("POST", path(lit("res10"), param("id")), async (ctx) => json({ id: 10, key: ctx.params.id }))
const h11 = route("PUT", path(lit("res11")), async (ctx) => json({ id: 11, key: "res11" }))
const h12 = route("GET", path(lit("res12"), param("id")), async (ctx) => json({ id: 12, key: ctx.params.id }))
const h13 = route("POST", path(lit("res13")), bodySchema, async (ctx) => json({ id: 13, name: ctx.input.name, qty: ctx.input.qty }))
const h14 = route("PUT", path(lit("res14"), param("id")), async (ctx) => json({ id: 14, key: ctx.params.id }))
const h15 = route("GET", path(lit("res15")), async (ctx) => json({ id: 15, key: "res15" }))
const h16 = route("POST", path(lit("res16"), param("id")), async (ctx) => json({ id: 16, key: ctx.params.id }))
const h17 = route("PUT", path(lit("res17")), bodySchema, async (ctx) => json({ id: 17, name: ctx.input.name, qty: ctx.input.qty }))
const h18 = route("GET", path(lit("res18"), param("id")), async (ctx) => json({ id: 18, key: ctx.params.id }))
const h19 = route("POST", path(lit("res19")), async (ctx) => json({ id: 19, key: "res19" }))
const h20 = route("PUT", path(lit("res20"), param("id")), async (ctx) => json({ id: 20, key: ctx.params.id }))
const h21 = route("GET", path(lit("res21")), async (ctx) => json({ id: 21, key: "res21" }))
const h22 = route("POST", path(lit("res22"), param("id")), async (ctx) => json({ id: 22, key: ctx.params.id }))
const h23 = route("PUT", path(lit("res23")), async (ctx) => json({ id: 23, key: "res23" }))
const h24 = route("GET", path(lit("res24"), param("id")), async (ctx) => json({ id: 24, key: ctx.params.id }))
const h25 = route("POST", path(lit("res25")), bodySchema, async (ctx) => json({ id: 25, name: ctx.input.name, qty: ctx.input.qty }))
const h26 = route("PUT", path(lit("res26"), param("id")), async (ctx) => json({ id: 26, key: ctx.params.id }))
const h27 = route("GET", path(lit("res27")), async (ctx) => json({ id: 27, key: "res27" }))
const h28 = route("POST", path(lit("res28"), param("id")), async (ctx) => json({ id: 28, key: ctx.params.id }))
const h29 = route("PUT", path(lit("res29")), bodySchema, async (ctx) => json({ id: 29, name: ctx.input.name, qty: ctx.input.qty }))
const h30 = route("GET", path(lit("res30"), param("id")), async (ctx) => json({ id: 30, key: ctx.params.id }))
const h31 = route("POST", path(lit("res31")), async (ctx) => json({ id: 31, key: "res31" }))
const h32 = route("PUT", path(lit("res32"), param("id")), async (ctx) => json({ id: 32, key: ctx.params.id }))
const h33 = route("GET", path(lit("res33")), async (ctx) => json({ id: 33, key: "res33" }))
const h34 = route("POST", path(lit("res34"), param("id")), async (ctx) => json({ id: 34, key: ctx.params.id }))
const h35 = route("PUT", path(lit("res35")), async (ctx) => json({ id: 35, key: "res35" }))
const h36 = route("GET", path(lit("res36"), param("id")), async (ctx) => json({ id: 36, key: ctx.params.id }))
const h37 = route("POST", path(lit("res37")), bodySchema, async (ctx) => json({ id: 37, name: ctx.input.name, qty: ctx.input.qty }))
const h38 = route("PUT", path(lit("res38"), param("id")), async (ctx) => json({ id: 38, key: ctx.params.id }))
const h39 = route("GET", path(lit("res39")), async (ctx) => json({ id: 39, key: "res39" }))
const h40 = route("POST", path(lit("res40"), param("id")), async (ctx) => json({ id: 40, key: ctx.params.id }))
const h41 = route("PUT", path(lit("res41")), bodySchema, async (ctx) => json({ id: 41, name: ctx.input.name, qty: ctx.input.qty }))
const h42 = route("GET", path(lit("res42"), param("id")), async (ctx) => json({ id: 42, key: ctx.params.id }))
const h43 = route("POST", path(lit("res43")), async (ctx) => json({ id: 43, key: "res43" }))
const h44 = route("PUT", path(lit("res44"), param("id")), async (ctx) => json({ id: 44, key: ctx.params.id }))
const h45 = route("GET", path(lit("res45")), async (ctx) => json({ id: 45, key: "res45" }))
const h46 = route("POST", path(lit("res46"), param("id")), async (ctx) => json({ id: 46, key: ctx.params.id }))
const h47 = route("PUT", path(lit("res47")), async (ctx) => json({ id: 47, key: "res47" }))
const h48 = route("GET", path(lit("res48"), param("id")), async (ctx) => json({ id: 48, key: ctx.params.id }))
const h49 = route("POST", path(lit("res49")), bodySchema, async (ctx) => json({ id: 49, name: ctx.input.name, qty: ctx.input.qty }))
const h50 = route("PUT", path(lit("res50"), param("id")), async (ctx) => json({ id: 50, key: ctx.params.id }))
const h51 = route("GET", path(lit("res51")), async (ctx) => json({ id: 51, key: "res51" }))
const h52 = route("POST", path(lit("res52"), param("id")), async (ctx) => json({ id: 52, key: ctx.params.id }))
const h53 = route("PUT", path(lit("res53")), bodySchema, async (ctx) => json({ id: 53, name: ctx.input.name, qty: ctx.input.qty }))
const h54 = route("GET", path(lit("res54"), param("id")), async (ctx) => json({ id: 54, key: ctx.params.id }))
const h55 = route("POST", path(lit("res55")), async (ctx) => json({ id: 55, key: "res55" }))
const h56 = route("PUT", path(lit("res56"), param("id")), async (ctx) => json({ id: 56, key: ctx.params.id }))
const h57 = route("GET", path(lit("res57")), async (ctx) => json({ id: 57, key: "res57" }))
const h58 = route("POST", path(lit("res58"), param("id")), async (ctx) => json({ id: 58, key: ctx.params.id }))
const h59 = route("PUT", path(lit("res59")), async (ctx) => json({ id: 59, key: "res59" }))
const h60 = route("GET", path(lit("res60"), param("id")), async (ctx) => json({ id: 60, key: ctx.params.id }))
const h61 = route("POST", path(lit("res61")), bodySchema, async (ctx) => json({ id: 61, name: ctx.input.name, qty: ctx.input.qty }))
const h62 = route("PUT", path(lit("res62"), param("id")), async (ctx) => json({ id: 62, key: ctx.params.id }))
const h63 = route("GET", path(lit("res63")), async (ctx) => json({ id: 63, key: "res63" }))
const h64 = route("POST", path(lit("res64"), param("id")), async (ctx) => json({ id: 64, key: ctx.params.id }))
const h65 = route("PUT", path(lit("res65")), bodySchema, async (ctx) => json({ id: 65, name: ctx.input.name, qty: ctx.input.qty }))
const h66 = route("GET", path(lit("res66"), param("id")), async (ctx) => json({ id: 66, key: ctx.params.id }))
const h67 = route("POST", path(lit("res67")), async (ctx) => json({ id: 67, key: "res67" }))
const h68 = route("PUT", path(lit("res68"), param("id")), async (ctx) => json({ id: 68, key: ctx.params.id }))
const h69 = route("GET", path(lit("res69")), async (ctx) => json({ id: 69, key: "res69" }))
const h70 = route("POST", path(lit("res70"), param("id")), async (ctx) => json({ id: 70, key: ctx.params.id }))
const h71 = route("PUT", path(lit("res71")), async (ctx) => json({ id: 71, key: "res71" }))
const h72 = route("GET", path(lit("res72"), param("id")), async (ctx) => json({ id: 72, key: ctx.params.id }))
const h73 = route("POST", path(lit("res73")), bodySchema, async (ctx) => json({ id: 73, name: ctx.input.name, qty: ctx.input.qty }))
const h74 = route("PUT", path(lit("res74"), param("id")), async (ctx) => json({ id: 74, key: ctx.params.id }))
const h75 = route("GET", path(lit("res75")), async (ctx) => json({ id: 75, key: "res75" }))
const h76 = route("POST", path(lit("res76"), param("id")), async (ctx) => json({ id: 76, key: ctx.params.id }))
const h77 = route("PUT", path(lit("res77")), bodySchema, async (ctx) => json({ id: 77, name: ctx.input.name, qty: ctx.input.qty }))
const h78 = route("GET", path(lit("res78"), param("id")), async (ctx) => json({ id: 78, key: ctx.params.id }))
const h79 = route("POST", path(lit("res79")), async (ctx) => json({ id: 79, key: "res79" }))
const h80 = route("PUT", path(lit("res80"), param("id")), async (ctx) => json({ id: 80, key: ctx.params.id }))
const h81 = route("GET", path(lit("res81")), async (ctx) => json({ id: 81, key: "res81" }))
const h82 = route("POST", path(lit("res82"), param("id")), async (ctx) => json({ id: 82, key: ctx.params.id }))
const h83 = route("PUT", path(lit("res83")), async (ctx) => json({ id: 83, key: "res83" }))
const h84 = route("GET", path(lit("res84"), param("id")), async (ctx) => json({ id: 84, key: ctx.params.id }))
const h85 = route("POST", path(lit("res85")), bodySchema, async (ctx) => json({ id: 85, name: ctx.input.name, qty: ctx.input.qty }))
const h86 = route("PUT", path(lit("res86"), param("id")), async (ctx) => json({ id: 86, key: ctx.params.id }))
const h87 = route("GET", path(lit("res87")), async (ctx) => json({ id: 87, key: "res87" }))
const h88 = route("POST", path(lit("res88"), param("id")), async (ctx) => json({ id: 88, key: ctx.params.id }))
const h89 = route("PUT", path(lit("res89")), bodySchema, async (ctx) => json({ id: 89, name: ctx.input.name, qty: ctx.input.qty }))
const h90 = route("GET", path(lit("res90"), param("id")), async (ctx) => json({ id: 90, key: ctx.params.id }))
const h91 = route("POST", path(lit("res91")), async (ctx) => json({ id: 91, key: "res91" }))
const h92 = route("PUT", path(lit("res92"), param("id")), async (ctx) => json({ id: 92, key: ctx.params.id }))
const h93 = route("GET", path(lit("res93")), async (ctx) => json({ id: 93, key: "res93" }))
const h94 = route("POST", path(lit("res94"), param("id")), async (ctx) => json({ id: 94, key: ctx.params.id }))
const h95 = route("PUT", path(lit("res95")), async (ctx) => json({ id: 95, key: "res95" }))
const h96 = route("GET", path(lit("res96"), param("id")), async (ctx) => json({ id: 96, key: ctx.params.id }))
const h97 = route("POST", path(lit("res97")), bodySchema, async (ctx) => json({ id: 97, name: ctx.input.name, qty: ctx.input.qty }))
const h98 = route("PUT", path(lit("res98"), param("id")), async (ctx) => json({ id: 98, key: ctx.params.id }))
const h99 = route("GET", path(lit("res99")), async (ctx) => json({ id: 99, key: "res99" }))
const h100 = route("POST", path(lit("res100"), param("id")), async (ctx) => json({ id: 100, key: ctx.params.id }))
const h101 = route("PUT", path(lit("res101")), bodySchema, async (ctx) => json({ id: 101, name: ctx.input.name, qty: ctx.input.qty }))
const h102 = route("GET", path(lit("res102"), param("id")), async (ctx) => json({ id: 102, key: ctx.params.id }))
const h103 = route("POST", path(lit("res103")), async (ctx) => json({ id: 103, key: "res103" }))
const h104 = route("PUT", path(lit("res104"), param("id")), async (ctx) => json({ id: 104, key: ctx.params.id }))
const h105 = route("GET", path(lit("res105")), async (ctx) => json({ id: 105, key: "res105" }))
const h106 = route("POST", path(lit("res106"), param("id")), async (ctx) => json({ id: 106, key: ctx.params.id }))
const h107 = route("PUT", path(lit("res107")), async (ctx) => json({ id: 107, key: "res107" }))
const h108 = route("GET", path(lit("res108"), param("id")), async (ctx) => json({ id: 108, key: ctx.params.id }))
const h109 = route("POST", path(lit("res109")), bodySchema, async (ctx) => json({ id: 109, name: ctx.input.name, qty: ctx.input.qty }))
const h110 = route("PUT", path(lit("res110"), param("id")), async (ctx) => json({ id: 110, key: ctx.params.id }))
const h111 = route("GET", path(lit("res111")), async (ctx) => json({ id: 111, key: "res111" }))
const h112 = route("POST", path(lit("res112"), param("id")), async (ctx) => json({ id: 112, key: ctx.params.id }))
const h113 = route("PUT", path(lit("res113")), bodySchema, async (ctx) => json({ id: 113, name: ctx.input.name, qty: ctx.input.qty }))
const h114 = route("GET", path(lit("res114"), param("id")), async (ctx) => json({ id: 114, key: ctx.params.id }))
const h115 = route("POST", path(lit("res115")), async (ctx) => json({ id: 115, key: "res115" }))
const h116 = route("PUT", path(lit("res116"), param("id")), async (ctx) => json({ id: 116, key: ctx.params.id }))
const h117 = route("GET", path(lit("res117")), async (ctx) => json({ id: 117, key: "res117" }))
const h118 = route("POST", path(lit("res118"), param("id")), async (ctx) => json({ id: 118, key: ctx.params.id }))
const h119 = route("PUT", path(lit("res119")), async (ctx) => json({ id: 119, key: "res119" }))
const h120 = route("GET", path(lit("res120"), param("id")), async (ctx) => json({ id: 120, key: ctx.params.id }))
const h121 = route("POST", path(lit("res121")), bodySchema, async (ctx) => json({ id: 121, name: ctx.input.name, qty: ctx.input.qty }))
const h122 = route("PUT", path(lit("res122"), param("id")), async (ctx) => json({ id: 122, key: ctx.params.id }))
const h123 = route("GET", path(lit("res123")), async (ctx) => json({ id: 123, key: "res123" }))
const h124 = route("POST", path(lit("res124"), param("id")), async (ctx) => json({ id: 124, key: ctx.params.id }))
const h125 = route("PUT", path(lit("res125")), bodySchema, async (ctx) => json({ id: 125, name: ctx.input.name, qty: ctx.input.qty }))
const h126 = route("GET", path(lit("res126"), param("id")), async (ctx) => json({ id: 126, key: ctx.params.id }))
const h127 = route("POST", path(lit("res127")), async (ctx) => json({ id: 127, key: "res127" }))
const h128 = route("PUT", path(lit("res128"), param("id")), async (ctx) => json({ id: 128, key: ctx.params.id }))
const h129 = route("GET", path(lit("res129")), async (ctx) => json({ id: 129, key: "res129" }))
const h130 = route("POST", path(lit("res130"), param("id")), async (ctx) => json({ id: 130, key: ctx.params.id }))
const h131 = route("PUT", path(lit("res131")), async (ctx) => json({ id: 131, key: "res131" }))
const h132 = route("GET", path(lit("res132"), param("id")), async (ctx) => json({ id: 132, key: ctx.params.id }))
const h133 = route("POST", path(lit("res133")), bodySchema, async (ctx) => json({ id: 133, name: ctx.input.name, qty: ctx.input.qty }))
const h134 = route("PUT", path(lit("res134"), param("id")), async (ctx) => json({ id: 134, key: ctx.params.id }))
const h135 = route("GET", path(lit("res135")), async (ctx) => json({ id: 135, key: "res135" }))
const h136 = route("POST", path(lit("res136"), param("id")), async (ctx) => json({ id: 136, key: ctx.params.id }))
const h137 = route("PUT", path(lit("res137")), bodySchema, async (ctx) => json({ id: 137, name: ctx.input.name, qty: ctx.input.qty }))
const h138 = route("GET", path(lit("res138"), param("id")), async (ctx) => json({ id: 138, key: ctx.params.id }))
const h139 = route("POST", path(lit("res139")), async (ctx) => json({ id: 139, key: "res139" }))
const h140 = route("PUT", path(lit("res140"), param("id")), async (ctx) => json({ id: 140, key: ctx.params.id }))
const h141 = route("GET", path(lit("res141")), async (ctx) => json({ id: 141, key: "res141" }))
const h142 = route("POST", path(lit("res142"), param("id")), async (ctx) => json({ id: 142, key: ctx.params.id }))
const h143 = route("PUT", path(lit("res143")), async (ctx) => json({ id: 143, key: "res143" }))
const h144 = route("GET", path(lit("res144"), param("id")), async (ctx) => json({ id: 144, key: ctx.params.id }))
const h145 = route("POST", path(lit("res145")), bodySchema, async (ctx) => json({ id: 145, name: ctx.input.name, qty: ctx.input.qty }))
const h146 = route("PUT", path(lit("res146"), param("id")), async (ctx) => json({ id: 146, key: ctx.params.id }))
const h147 = route("GET", path(lit("res147")), async (ctx) => json({ id: 147, key: "res147" }))
const h148 = route("POST", path(lit("res148"), param("id")), async (ctx) => json({ id: 148, key: ctx.params.id }))
const h149 = route("PUT", path(lit("res149")), bodySchema, async (ctx) => json({ id: 149, name: ctx.input.name, qty: ctx.input.qty }))
const h150 = route("GET", path(lit("res150"), param("id")), async (ctx) => json({ id: 150, key: ctx.params.id }))
const h151 = route("POST", path(lit("res151")), async (ctx) => json({ id: 151, key: "res151" }))
const h152 = route("PUT", path(lit("res152"), param("id")), async (ctx) => json({ id: 152, key: ctx.params.id }))
const h153 = route("GET", path(lit("res153")), async (ctx) => json({ id: 153, key: "res153" }))
const h154 = route("POST", path(lit("res154"), param("id")), async (ctx) => json({ id: 154, key: ctx.params.id }))
const h155 = route("PUT", path(lit("res155")), async (ctx) => json({ id: 155, key: "res155" }))
const h156 = route("GET", path(lit("res156"), param("id")), async (ctx) => json({ id: 156, key: ctx.params.id }))
const h157 = route("POST", path(lit("res157")), bodySchema, async (ctx) => json({ id: 157, name: ctx.input.name, qty: ctx.input.qty }))
const h158 = route("PUT", path(lit("res158"), param("id")), async (ctx) => json({ id: 158, key: ctx.params.id }))
const h159 = route("GET", path(lit("res159")), async (ctx) => json({ id: 159, key: "res159" }))
const h160 = route("POST", path(lit("res160"), param("id")), async (ctx) => json({ id: 160, key: ctx.params.id }))
const h161 = route("PUT", path(lit("res161")), bodySchema, async (ctx) => json({ id: 161, name: ctx.input.name, qty: ctx.input.qty }))
const h162 = route("GET", path(lit("res162"), param("id")), async (ctx) => json({ id: 162, key: ctx.params.id }))
const h163 = route("POST", path(lit("res163")), async (ctx) => json({ id: 163, key: "res163" }))
const h164 = route("PUT", path(lit("res164"), param("id")), async (ctx) => json({ id: 164, key: ctx.params.id }))
const h165 = route("GET", path(lit("res165")), async (ctx) => json({ id: 165, key: "res165" }))
const h166 = route("POST", path(lit("res166"), param("id")), async (ctx) => json({ id: 166, key: ctx.params.id }))
const h167 = route("PUT", path(lit("res167")), async (ctx) => json({ id: 167, key: "res167" }))
const h168 = route("GET", path(lit("res168"), param("id")), async (ctx) => json({ id: 168, key: ctx.params.id }))
const h169 = route("POST", path(lit("res169")), bodySchema, async (ctx) => json({ id: 169, name: ctx.input.name, qty: ctx.input.qty }))
const h170 = route("PUT", path(lit("res170"), param("id")), async (ctx) => json({ id: 170, key: ctx.params.id }))
const h171 = route("GET", path(lit("res171")), async (ctx) => json({ id: 171, key: "res171" }))
const h172 = route("POST", path(lit("res172"), param("id")), async (ctx) => json({ id: 172, key: ctx.params.id }))
const h173 = route("PUT", path(lit("res173")), bodySchema, async (ctx) => json({ id: 173, name: ctx.input.name, qty: ctx.input.qty }))
const h174 = route("GET", path(lit("res174"), param("id")), async (ctx) => json({ id: 174, key: ctx.params.id }))
const h175 = route("POST", path(lit("res175")), async (ctx) => json({ id: 175, key: "res175" }))
const h176 = route("PUT", path(lit("res176"), param("id")), async (ctx) => json({ id: 176, key: ctx.params.id }))
const h177 = route("GET", path(lit("res177")), async (ctx) => json({ id: 177, key: "res177" }))
const h178 = route("POST", path(lit("res178"), param("id")), async (ctx) => json({ id: 178, key: ctx.params.id }))
const h179 = route("PUT", path(lit("res179")), async (ctx) => json({ id: 179, key: "res179" }))
const h180 = route("GET", path(lit("res180"), param("id")), async (ctx) => json({ id: 180, key: ctx.params.id }))
const h181 = route("POST", path(lit("res181")), bodySchema, async (ctx) => json({ id: 181, name: ctx.input.name, qty: ctx.input.qty }))
const h182 = route("PUT", path(lit("res182"), param("id")), async (ctx) => json({ id: 182, key: ctx.params.id }))
const h183 = route("GET", path(lit("res183")), async (ctx) => json({ id: 183, key: "res183" }))
const h184 = route("POST", path(lit("res184"), param("id")), async (ctx) => json({ id: 184, key: ctx.params.id }))
const h185 = route("PUT", path(lit("res185")), bodySchema, async (ctx) => json({ id: 185, name: ctx.input.name, qty: ctx.input.qty }))
const h186 = route("GET", path(lit("res186"), param("id")), async (ctx) => json({ id: 186, key: ctx.params.id }))
const h187 = route("POST", path(lit("res187")), async (ctx) => json({ id: 187, key: "res187" }))
const h188 = route("PUT", path(lit("res188"), param("id")), async (ctx) => json({ id: 188, key: ctx.params.id }))
const h189 = route("GET", path(lit("res189")), async (ctx) => json({ id: 189, key: "res189" }))
const h190 = route("POST", path(lit("res190"), param("id")), async (ctx) => json({ id: 190, key: ctx.params.id }))
const h191 = route("PUT", path(lit("res191")), async (ctx) => json({ id: 191, key: "res191" }))
const h192 = route("GET", path(lit("res192"), param("id")), async (ctx) => json({ id: 192, key: ctx.params.id }))
const h193 = route("POST", path(lit("res193")), bodySchema, async (ctx) => json({ id: 193, name: ctx.input.name, qty: ctx.input.qty }))
const h194 = route("PUT", path(lit("res194"), param("id")), async (ctx) => json({ id: 194, key: ctx.params.id }))
const h195 = route("GET", path(lit("res195")), async (ctx) => json({ id: 195, key: "res195" }))
const h196 = route("POST", path(lit("res196"), param("id")), async (ctx) => json({ id: 196, key: ctx.params.id }))
const h197 = route("PUT", path(lit("res197")), bodySchema, async (ctx) => json({ id: 197, name: ctx.input.name, qty: ctx.input.qty }))
const h198 = route("GET", path(lit("res198"), param("id")), async (ctx) => json({ id: 198, key: ctx.params.id }))
const h199 = route("POST", path(lit("res199")), async (ctx) => json({ id: 199, key: "res199" }))
const h200 = route("PUT", path(lit("res200"), param("id")), async (ctx) => json({ id: 200, key: ctx.params.id }))
const h201 = route("GET", path(lit("res201")), async (ctx) => json({ id: 201, key: "res201" }))
const h202 = route("POST", path(lit("res202"), param("id")), async (ctx) => json({ id: 202, key: ctx.params.id }))
const h203 = route("PUT", path(lit("res203")), async (ctx) => json({ id: 203, key: "res203" }))
const h204 = route("GET", path(lit("res204"), param("id")), async (ctx) => json({ id: 204, key: ctx.params.id }))
const h205 = route("POST", path(lit("res205")), bodySchema, async (ctx) => json({ id: 205, name: ctx.input.name, qty: ctx.input.qty }))
const h206 = route("PUT", path(lit("res206"), param("id")), async (ctx) => json({ id: 206, key: ctx.params.id }))
const h207 = route("GET", path(lit("res207")), async (ctx) => json({ id: 207, key: "res207" }))
const h208 = route("POST", path(lit("res208"), param("id")), async (ctx) => json({ id: 208, key: ctx.params.id }))
const h209 = route("PUT", path(lit("res209")), bodySchema, async (ctx) => json({ id: 209, name: ctx.input.name, qty: ctx.input.qty }))
const h210 = route("GET", path(lit("res210"), param("id")), async (ctx) => json({ id: 210, key: ctx.params.id }))
const h211 = route("POST", path(lit("res211")), async (ctx) => json({ id: 211, key: "res211" }))
const h212 = route("PUT", path(lit("res212"), param("id")), async (ctx) => json({ id: 212, key: ctx.params.id }))
const h213 = route("GET", path(lit("res213")), async (ctx) => json({ id: 213, key: "res213" }))
const h214 = route("POST", path(lit("res214"), param("id")), async (ctx) => json({ id: 214, key: ctx.params.id }))
const h215 = route("PUT", path(lit("res215")), async (ctx) => json({ id: 215, key: "res215" }))
const h216 = route("GET", path(lit("res216"), param("id")), async (ctx) => json({ id: 216, key: ctx.params.id }))
const h217 = route("POST", path(lit("res217")), bodySchema, async (ctx) => json({ id: 217, name: ctx.input.name, qty: ctx.input.qty }))
const h218 = route("PUT", path(lit("res218"), param("id")), async (ctx) => json({ id: 218, key: ctx.params.id }))
const h219 = route("GET", path(lit("res219")), async (ctx) => json({ id: 219, key: "res219" }))
const h220 = route("POST", path(lit("res220"), param("id")), async (ctx) => json({ id: 220, key: ctx.params.id }))
const h221 = route("PUT", path(lit("res221")), bodySchema, async (ctx) => json({ id: 221, name: ctx.input.name, qty: ctx.input.qty }))
const h222 = route("GET", path(lit("res222"), param("id")), async (ctx) => json({ id: 222, key: ctx.params.id }))
const h223 = route("POST", path(lit("res223")), async (ctx) => json({ id: 223, key: "res223" }))
const h224 = route("PUT", path(lit("res224"), param("id")), async (ctx) => json({ id: 224, key: ctx.params.id }))
const h225 = route("GET", path(lit("res225")), async (ctx) => json({ id: 225, key: "res225" }))
const h226 = route("POST", path(lit("res226"), param("id")), async (ctx) => json({ id: 226, key: ctx.params.id }))
const h227 = route("PUT", path(lit("res227")), async (ctx) => json({ id: 227, key: "res227" }))
const h228 = route("GET", path(lit("res228"), param("id")), async (ctx) => json({ id: 228, key: ctx.params.id }))
const h229 = route("POST", path(lit("res229")), bodySchema, async (ctx) => json({ id: 229, name: ctx.input.name, qty: ctx.input.qty }))
const h230 = route("PUT", path(lit("res230"), param("id")), async (ctx) => json({ id: 230, key: ctx.params.id }))
const h231 = route("GET", path(lit("res231")), async (ctx) => json({ id: 231, key: "res231" }))
const h232 = route("POST", path(lit("res232"), param("id")), async (ctx) => json({ id: 232, key: ctx.params.id }))
const h233 = route("PUT", path(lit("res233")), bodySchema, async (ctx) => json({ id: 233, name: ctx.input.name, qty: ctx.input.qty }))
const h234 = route("GET", path(lit("res234"), param("id")), async (ctx) => json({ id: 234, key: ctx.params.id }))
const h235 = route("POST", path(lit("res235")), async (ctx) => json({ id: 235, key: "res235" }))
const h236 = route("PUT", path(lit("res236"), param("id")), async (ctx) => json({ id: 236, key: ctx.params.id }))
const h237 = route("GET", path(lit("res237")), async (ctx) => json({ id: 237, key: "res237" }))
const h238 = route("POST", path(lit("res238"), param("id")), async (ctx) => json({ id: 238, key: ctx.params.id }))
const h239 = route("PUT", path(lit("res239")), async (ctx) => json({ id: 239, key: "res239" }))
const h240 = route("GET", path(lit("res240"), param("id")), async (ctx) => json({ id: 240, key: ctx.params.id }))
const h241 = route("POST", path(lit("res241")), bodySchema, async (ctx) => json({ id: 241, name: ctx.input.name, qty: ctx.input.qty }))
const h242 = route("PUT", path(lit("res242"), param("id")), async (ctx) => json({ id: 242, key: ctx.params.id }))
const h243 = route("GET", path(lit("res243")), async (ctx) => json({ id: 243, key: "res243" }))
const h244 = route("POST", path(lit("res244"), param("id")), async (ctx) => json({ id: 244, key: ctx.params.id }))
const h245 = route("PUT", path(lit("res245")), bodySchema, async (ctx) => json({ id: 245, name: ctx.input.name, qty: ctx.input.qty }))
const h246 = route("GET", path(lit("res246"), param("id")), async (ctx) => json({ id: 246, key: ctx.params.id }))
const h247 = route("POST", path(lit("res247")), async (ctx) => json({ id: 247, key: "res247" }))
const h248 = route("PUT", path(lit("res248"), param("id")), async (ctx) => json({ id: 248, key: ctx.params.id }))
const h249 = route("GET", path(lit("res249")), async (ctx) => json({ id: 249, key: "res249" }))
const h250 = route("POST", path(lit("res250"), param("id")), async (ctx) => json({ id: 250, key: ctx.params.id }))
const h251 = route("PUT", path(lit("res251")), async (ctx) => json({ id: 251, key: "res251" }))
const h252 = route("GET", path(lit("res252"), param("id")), async (ctx) => json({ id: 252, key: ctx.params.id }))
const h253 = route("POST", path(lit("res253")), bodySchema, async (ctx) => json({ id: 253, name: ctx.input.name, qty: ctx.input.qty }))
const h254 = route("PUT", path(lit("res254"), param("id")), async (ctx) => json({ id: 254, key: ctx.params.id }))
const h255 = route("GET", path(lit("res255")), async (ctx) => json({ id: 255, key: "res255" }))
const h256 = route("POST", path(lit("res256"), param("id")), async (ctx) => json({ id: 256, key: ctx.params.id }))
const h257 = route("PUT", path(lit("res257")), bodySchema, async (ctx) => json({ id: 257, name: ctx.input.name, qty: ctx.input.qty }))
const h258 = route("GET", path(lit("res258"), param("id")), async (ctx) => json({ id: 258, key: ctx.params.id }))
const h259 = route("POST", path(lit("res259")), async (ctx) => json({ id: 259, key: "res259" }))
const h260 = route("PUT", path(lit("res260"), param("id")), async (ctx) => json({ id: 260, key: ctx.params.id }))
const h261 = route("GET", path(lit("res261")), async (ctx) => json({ id: 261, key: "res261" }))
const h262 = route("POST", path(lit("res262"), param("id")), async (ctx) => json({ id: 262, key: ctx.params.id }))
const h263 = route("PUT", path(lit("res263")), async (ctx) => json({ id: 263, key: "res263" }))
const h264 = route("GET", path(lit("res264"), param("id")), async (ctx) => json({ id: 264, key: ctx.params.id }))
const h265 = route("POST", path(lit("res265")), bodySchema, async (ctx) => json({ id: 265, name: ctx.input.name, qty: ctx.input.qty }))
const h266 = route("PUT", path(lit("res266"), param("id")), async (ctx) => json({ id: 266, key: ctx.params.id }))
const h267 = route("GET", path(lit("res267")), async (ctx) => json({ id: 267, key: "res267" }))
const h268 = route("POST", path(lit("res268"), param("id")), async (ctx) => json({ id: 268, key: ctx.params.id }))
const h269 = route("PUT", path(lit("res269")), bodySchema, async (ctx) => json({ id: 269, name: ctx.input.name, qty: ctx.input.qty }))
const h270 = route("GET", path(lit("res270"), param("id")), async (ctx) => json({ id: 270, key: ctx.params.id }))
const h271 = route("POST", path(lit("res271")), async (ctx) => json({ id: 271, key: "res271" }))
const h272 = route("PUT", path(lit("res272"), param("id")), async (ctx) => json({ id: 272, key: ctx.params.id }))
const h273 = route("GET", path(lit("res273")), async (ctx) => json({ id: 273, key: "res273" }))
const h274 = route("POST", path(lit("res274"), param("id")), async (ctx) => json({ id: 274, key: ctx.params.id }))
const h275 = route("PUT", path(lit("res275")), async (ctx) => json({ id: 275, key: "res275" }))
const h276 = route("GET", path(lit("res276"), param("id")), async (ctx) => json({ id: 276, key: ctx.params.id }))
const h277 = route("POST", path(lit("res277")), bodySchema, async (ctx) => json({ id: 277, name: ctx.input.name, qty: ctx.input.qty }))
const h278 = route("PUT", path(lit("res278"), param("id")), async (ctx) => json({ id: 278, key: ctx.params.id }))
const h279 = route("GET", path(lit("res279")), async (ctx) => json({ id: 279, key: "res279" }))
const h280 = route("POST", path(lit("res280"), param("id")), async (ctx) => json({ id: 280, key: ctx.params.id }))
const h281 = route("PUT", path(lit("res281")), bodySchema, async (ctx) => json({ id: 281, name: ctx.input.name, qty: ctx.input.qty }))
const h282 = route("GET", path(lit("res282"), param("id")), async (ctx) => json({ id: 282, key: ctx.params.id }))
const h283 = route("POST", path(lit("res283")), async (ctx) => json({ id: 283, key: "res283" }))
const h284 = route("PUT", path(lit("res284"), param("id")), async (ctx) => json({ id: 284, key: ctx.params.id }))
const h285 = route("GET", path(lit("res285")), async (ctx) => json({ id: 285, key: "res285" }))
const h286 = route("POST", path(lit("res286"), param("id")), async (ctx) => json({ id: 286, key: ctx.params.id }))
const h287 = route("PUT", path(lit("res287")), async (ctx) => json({ id: 287, key: "res287" }))
const h288 = route("GET", path(lit("res288"), param("id")), async (ctx) => json({ id: 288, key: ctx.params.id }))
const h289 = route("POST", path(lit("res289")), bodySchema, async (ctx) => json({ id: 289, name: ctx.input.name, qty: ctx.input.qty }))
const h290 = route("PUT", path(lit("res290"), param("id")), async (ctx) => json({ id: 290, key: ctx.params.id }))
const h291 = route("GET", path(lit("res291")), async (ctx) => json({ id: 291, key: "res291" }))
const h292 = route("POST", path(lit("res292"), param("id")), async (ctx) => json({ id: 292, key: ctx.params.id }))
const h293 = route("PUT", path(lit("res293")), bodySchema, async (ctx) => json({ id: 293, name: ctx.input.name, qty: ctx.input.qty }))
const h294 = route("GET", path(lit("res294"), param("id")), async (ctx) => json({ id: 294, key: ctx.params.id }))
const h295 = route("POST", path(lit("res295")), async (ctx) => json({ id: 295, key: "res295" }))
const h296 = route("PUT", path(lit("res296"), param("id")), async (ctx) => json({ id: 296, key: ctx.params.id }))
const h297 = route("GET", path(lit("res297")), async (ctx) => json({ id: 297, key: "res297" }))
const h298 = route("POST", path(lit("res298"), param("id")), async (ctx) => json({ id: 298, key: ctx.params.id }))
const h299 = route("PUT", path(lit("res299")), async (ctx) => json({ id: 299, key: "res299" }))

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
