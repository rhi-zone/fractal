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
const h100 = route("POST", path(lit("res100"), param("id")), async (ctx) => json({ id: 100, key: ctx.params.id }))
const h101 = route("PUT", path(lit("res101")), bodySchema, async (ctx) => json({ id: 101, name: ctx.body.name, qty: ctx.body.qty }))
const h102 = route("GET", path(lit("res102"), param("id")), async (ctx) => json({ id: 102, key: ctx.params.id }))
const h103 = route("POST", path(lit("res103")), async (ctx) => json({ id: 103, key: "res103" }))
const h104 = route("PUT", path(lit("res104"), param("id")), async (ctx) => json({ id: 104, key: ctx.params.id }))
const h105 = route("GET", path(lit("res105")), async (ctx) => json({ id: 105, key: "res105" }))
const h106 = route("POST", path(lit("res106"), param("id")), async (ctx) => json({ id: 106, key: ctx.params.id }))
const h107 = route("PUT", path(lit("res107")), async (ctx) => json({ id: 107, key: "res107" }))
const h108 = route("GET", path(lit("res108"), param("id")), async (ctx) => json({ id: 108, key: ctx.params.id }))
const h109 = route("POST", path(lit("res109")), bodySchema, async (ctx) => json({ id: 109, name: ctx.body.name, qty: ctx.body.qty }))
const h110 = route("PUT", path(lit("res110"), param("id")), async (ctx) => json({ id: 110, key: ctx.params.id }))
const h111 = route("GET", path(lit("res111")), async (ctx) => json({ id: 111, key: "res111" }))
const h112 = route("POST", path(lit("res112"), param("id")), async (ctx) => json({ id: 112, key: ctx.params.id }))
const h113 = route("PUT", path(lit("res113")), bodySchema, async (ctx) => json({ id: 113, name: ctx.body.name, qty: ctx.body.qty }))
const h114 = route("GET", path(lit("res114"), param("id")), async (ctx) => json({ id: 114, key: ctx.params.id }))
const h115 = route("POST", path(lit("res115")), async (ctx) => json({ id: 115, key: "res115" }))
const h116 = route("PUT", path(lit("res116"), param("id")), async (ctx) => json({ id: 116, key: ctx.params.id }))
const h117 = route("GET", path(lit("res117")), async (ctx) => json({ id: 117, key: "res117" }))
const h118 = route("POST", path(lit("res118"), param("id")), async (ctx) => json({ id: 118, key: ctx.params.id }))
const h119 = route("PUT", path(lit("res119")), async (ctx) => json({ id: 119, key: "res119" }))
const h120 = route("GET", path(lit("res120"), param("id")), async (ctx) => json({ id: 120, key: ctx.params.id }))
const h121 = route("POST", path(lit("res121")), bodySchema, async (ctx) => json({ id: 121, name: ctx.body.name, qty: ctx.body.qty }))
const h122 = route("PUT", path(lit("res122"), param("id")), async (ctx) => json({ id: 122, key: ctx.params.id }))
const h123 = route("GET", path(lit("res123")), async (ctx) => json({ id: 123, key: "res123" }))
const h124 = route("POST", path(lit("res124"), param("id")), async (ctx) => json({ id: 124, key: ctx.params.id }))
const h125 = route("PUT", path(lit("res125")), bodySchema, async (ctx) => json({ id: 125, name: ctx.body.name, qty: ctx.body.qty }))
const h126 = route("GET", path(lit("res126"), param("id")), async (ctx) => json({ id: 126, key: ctx.params.id }))
const h127 = route("POST", path(lit("res127")), async (ctx) => json({ id: 127, key: "res127" }))
const h128 = route("PUT", path(lit("res128"), param("id")), async (ctx) => json({ id: 128, key: ctx.params.id }))
const h129 = route("GET", path(lit("res129")), async (ctx) => json({ id: 129, key: "res129" }))
const h130 = route("POST", path(lit("res130"), param("id")), async (ctx) => json({ id: 130, key: ctx.params.id }))
const h131 = route("PUT", path(lit("res131")), async (ctx) => json({ id: 131, key: "res131" }))
const h132 = route("GET", path(lit("res132"), param("id")), async (ctx) => json({ id: 132, key: ctx.params.id }))
const h133 = route("POST", path(lit("res133")), bodySchema, async (ctx) => json({ id: 133, name: ctx.body.name, qty: ctx.body.qty }))
const h134 = route("PUT", path(lit("res134"), param("id")), async (ctx) => json({ id: 134, key: ctx.params.id }))
const h135 = route("GET", path(lit("res135")), async (ctx) => json({ id: 135, key: "res135" }))
const h136 = route("POST", path(lit("res136"), param("id")), async (ctx) => json({ id: 136, key: ctx.params.id }))
const h137 = route("PUT", path(lit("res137")), bodySchema, async (ctx) => json({ id: 137, name: ctx.body.name, qty: ctx.body.qty }))
const h138 = route("GET", path(lit("res138"), param("id")), async (ctx) => json({ id: 138, key: ctx.params.id }))
const h139 = route("POST", path(lit("res139")), async (ctx) => json({ id: 139, key: "res139" }))
const h140 = route("PUT", path(lit("res140"), param("id")), async (ctx) => json({ id: 140, key: ctx.params.id }))
const h141 = route("GET", path(lit("res141")), async (ctx) => json({ id: 141, key: "res141" }))
const h142 = route("POST", path(lit("res142"), param("id")), async (ctx) => json({ id: 142, key: ctx.params.id }))
const h143 = route("PUT", path(lit("res143")), async (ctx) => json({ id: 143, key: "res143" }))
const h144 = route("GET", path(lit("res144"), param("id")), async (ctx) => json({ id: 144, key: ctx.params.id }))
const h145 = route("POST", path(lit("res145")), bodySchema, async (ctx) => json({ id: 145, name: ctx.body.name, qty: ctx.body.qty }))
const h146 = route("PUT", path(lit("res146"), param("id")), async (ctx) => json({ id: 146, key: ctx.params.id }))
const h147 = route("GET", path(lit("res147")), async (ctx) => json({ id: 147, key: "res147" }))
const h148 = route("POST", path(lit("res148"), param("id")), async (ctx) => json({ id: 148, key: ctx.params.id }))
const h149 = route("PUT", path(lit("res149")), bodySchema, async (ctx) => json({ id: 149, name: ctx.body.name, qty: ctx.body.qty }))
const h150 = route("GET", path(lit("res150"), param("id")), async (ctx) => json({ id: 150, key: ctx.params.id }))
const h151 = route("POST", path(lit("res151")), async (ctx) => json({ id: 151, key: "res151" }))
const h152 = route("PUT", path(lit("res152"), param("id")), async (ctx) => json({ id: 152, key: ctx.params.id }))
const h153 = route("GET", path(lit("res153")), async (ctx) => json({ id: 153, key: "res153" }))
const h154 = route("POST", path(lit("res154"), param("id")), async (ctx) => json({ id: 154, key: ctx.params.id }))
const h155 = route("PUT", path(lit("res155")), async (ctx) => json({ id: 155, key: "res155" }))
const h156 = route("GET", path(lit("res156"), param("id")), async (ctx) => json({ id: 156, key: ctx.params.id }))
const h157 = route("POST", path(lit("res157")), bodySchema, async (ctx) => json({ id: 157, name: ctx.body.name, qty: ctx.body.qty }))
const h158 = route("PUT", path(lit("res158"), param("id")), async (ctx) => json({ id: 158, key: ctx.params.id }))
const h159 = route("GET", path(lit("res159")), async (ctx) => json({ id: 159, key: "res159" }))
const h160 = route("POST", path(lit("res160"), param("id")), async (ctx) => json({ id: 160, key: ctx.params.id }))
const h161 = route("PUT", path(lit("res161")), bodySchema, async (ctx) => json({ id: 161, name: ctx.body.name, qty: ctx.body.qty }))
const h162 = route("GET", path(lit("res162"), param("id")), async (ctx) => json({ id: 162, key: ctx.params.id }))
const h163 = route("POST", path(lit("res163")), async (ctx) => json({ id: 163, key: "res163" }))
const h164 = route("PUT", path(lit("res164"), param("id")), async (ctx) => json({ id: 164, key: ctx.params.id }))
const h165 = route("GET", path(lit("res165")), async (ctx) => json({ id: 165, key: "res165" }))
const h166 = route("POST", path(lit("res166"), param("id")), async (ctx) => json({ id: 166, key: ctx.params.id }))
const h167 = route("PUT", path(lit("res167")), async (ctx) => json({ id: 167, key: "res167" }))
const h168 = route("GET", path(lit("res168"), param("id")), async (ctx) => json({ id: 168, key: ctx.params.id }))
const h169 = route("POST", path(lit("res169")), bodySchema, async (ctx) => json({ id: 169, name: ctx.body.name, qty: ctx.body.qty }))
const h170 = route("PUT", path(lit("res170"), param("id")), async (ctx) => json({ id: 170, key: ctx.params.id }))
const h171 = route("GET", path(lit("res171")), async (ctx) => json({ id: 171, key: "res171" }))
const h172 = route("POST", path(lit("res172"), param("id")), async (ctx) => json({ id: 172, key: ctx.params.id }))
const h173 = route("PUT", path(lit("res173")), bodySchema, async (ctx) => json({ id: 173, name: ctx.body.name, qty: ctx.body.qty }))
const h174 = route("GET", path(lit("res174"), param("id")), async (ctx) => json({ id: 174, key: ctx.params.id }))
const h175 = route("POST", path(lit("res175")), async (ctx) => json({ id: 175, key: "res175" }))
const h176 = route("PUT", path(lit("res176"), param("id")), async (ctx) => json({ id: 176, key: ctx.params.id }))
const h177 = route("GET", path(lit("res177")), async (ctx) => json({ id: 177, key: "res177" }))
const h178 = route("POST", path(lit("res178"), param("id")), async (ctx) => json({ id: 178, key: ctx.params.id }))
const h179 = route("PUT", path(lit("res179")), async (ctx) => json({ id: 179, key: "res179" }))
const h180 = route("GET", path(lit("res180"), param("id")), async (ctx) => json({ id: 180, key: ctx.params.id }))
const h181 = route("POST", path(lit("res181")), bodySchema, async (ctx) => json({ id: 181, name: ctx.body.name, qty: ctx.body.qty }))
const h182 = route("PUT", path(lit("res182"), param("id")), async (ctx) => json({ id: 182, key: ctx.params.id }))
const h183 = route("GET", path(lit("res183")), async (ctx) => json({ id: 183, key: "res183" }))
const h184 = route("POST", path(lit("res184"), param("id")), async (ctx) => json({ id: 184, key: ctx.params.id }))
const h185 = route("PUT", path(lit("res185")), bodySchema, async (ctx) => json({ id: 185, name: ctx.body.name, qty: ctx.body.qty }))
const h186 = route("GET", path(lit("res186"), param("id")), async (ctx) => json({ id: 186, key: ctx.params.id }))
const h187 = route("POST", path(lit("res187")), async (ctx) => json({ id: 187, key: "res187" }))
const h188 = route("PUT", path(lit("res188"), param("id")), async (ctx) => json({ id: 188, key: ctx.params.id }))
const h189 = route("GET", path(lit("res189")), async (ctx) => json({ id: 189, key: "res189" }))
const h190 = route("POST", path(lit("res190"), param("id")), async (ctx) => json({ id: 190, key: ctx.params.id }))
const h191 = route("PUT", path(lit("res191")), async (ctx) => json({ id: 191, key: "res191" }))
const h192 = route("GET", path(lit("res192"), param("id")), async (ctx) => json({ id: 192, key: ctx.params.id }))
const h193 = route("POST", path(lit("res193")), bodySchema, async (ctx) => json({ id: 193, name: ctx.body.name, qty: ctx.body.qty }))
const h194 = route("PUT", path(lit("res194"), param("id")), async (ctx) => json({ id: 194, key: ctx.params.id }))
const h195 = route("GET", path(lit("res195")), async (ctx) => json({ id: 195, key: "res195" }))
const h196 = route("POST", path(lit("res196"), param("id")), async (ctx) => json({ id: 196, key: ctx.params.id }))
const h197 = route("PUT", path(lit("res197")), bodySchema, async (ctx) => json({ id: 197, name: ctx.body.name, qty: ctx.body.qty }))
const h198 = route("GET", path(lit("res198"), param("id")), async (ctx) => json({ id: 198, key: ctx.params.id }))
const h199 = route("POST", path(lit("res199")), async (ctx) => json({ id: 199, key: "res199" }))
const h200 = route("PUT", path(lit("res200"), param("id")), async (ctx) => json({ id: 200, key: ctx.params.id }))
const h201 = route("GET", path(lit("res201")), async (ctx) => json({ id: 201, key: "res201" }))
const h202 = route("POST", path(lit("res202"), param("id")), async (ctx) => json({ id: 202, key: ctx.params.id }))
const h203 = route("PUT", path(lit("res203")), async (ctx) => json({ id: 203, key: "res203" }))
const h204 = route("GET", path(lit("res204"), param("id")), async (ctx) => json({ id: 204, key: ctx.params.id }))
const h205 = route("POST", path(lit("res205")), bodySchema, async (ctx) => json({ id: 205, name: ctx.body.name, qty: ctx.body.qty }))
const h206 = route("PUT", path(lit("res206"), param("id")), async (ctx) => json({ id: 206, key: ctx.params.id }))
const h207 = route("GET", path(lit("res207")), async (ctx) => json({ id: 207, key: "res207" }))
const h208 = route("POST", path(lit("res208"), param("id")), async (ctx) => json({ id: 208, key: ctx.params.id }))
const h209 = route("PUT", path(lit("res209")), bodySchema, async (ctx) => json({ id: 209, name: ctx.body.name, qty: ctx.body.qty }))
const h210 = route("GET", path(lit("res210"), param("id")), async (ctx) => json({ id: 210, key: ctx.params.id }))
const h211 = route("POST", path(lit("res211")), async (ctx) => json({ id: 211, key: "res211" }))
const h212 = route("PUT", path(lit("res212"), param("id")), async (ctx) => json({ id: 212, key: ctx.params.id }))
const h213 = route("GET", path(lit("res213")), async (ctx) => json({ id: 213, key: "res213" }))
const h214 = route("POST", path(lit("res214"), param("id")), async (ctx) => json({ id: 214, key: ctx.params.id }))
const h215 = route("PUT", path(lit("res215")), async (ctx) => json({ id: 215, key: "res215" }))
const h216 = route("GET", path(lit("res216"), param("id")), async (ctx) => json({ id: 216, key: ctx.params.id }))
const h217 = route("POST", path(lit("res217")), bodySchema, async (ctx) => json({ id: 217, name: ctx.body.name, qty: ctx.body.qty }))
const h218 = route("PUT", path(lit("res218"), param("id")), async (ctx) => json({ id: 218, key: ctx.params.id }))
const h219 = route("GET", path(lit("res219")), async (ctx) => json({ id: 219, key: "res219" }))
const h220 = route("POST", path(lit("res220"), param("id")), async (ctx) => json({ id: 220, key: ctx.params.id }))
const h221 = route("PUT", path(lit("res221")), bodySchema, async (ctx) => json({ id: 221, name: ctx.body.name, qty: ctx.body.qty }))
const h222 = route("GET", path(lit("res222"), param("id")), async (ctx) => json({ id: 222, key: ctx.params.id }))
const h223 = route("POST", path(lit("res223")), async (ctx) => json({ id: 223, key: "res223" }))
const h224 = route("PUT", path(lit("res224"), param("id")), async (ctx) => json({ id: 224, key: ctx.params.id }))
const h225 = route("GET", path(lit("res225")), async (ctx) => json({ id: 225, key: "res225" }))
const h226 = route("POST", path(lit("res226"), param("id")), async (ctx) => json({ id: 226, key: ctx.params.id }))
const h227 = route("PUT", path(lit("res227")), async (ctx) => json({ id: 227, key: "res227" }))
const h228 = route("GET", path(lit("res228"), param("id")), async (ctx) => json({ id: 228, key: ctx.params.id }))
const h229 = route("POST", path(lit("res229")), bodySchema, async (ctx) => json({ id: 229, name: ctx.body.name, qty: ctx.body.qty }))
const h230 = route("PUT", path(lit("res230"), param("id")), async (ctx) => json({ id: 230, key: ctx.params.id }))
const h231 = route("GET", path(lit("res231")), async (ctx) => json({ id: 231, key: "res231" }))
const h232 = route("POST", path(lit("res232"), param("id")), async (ctx) => json({ id: 232, key: ctx.params.id }))
const h233 = route("PUT", path(lit("res233")), bodySchema, async (ctx) => json({ id: 233, name: ctx.body.name, qty: ctx.body.qty }))
const h234 = route("GET", path(lit("res234"), param("id")), async (ctx) => json({ id: 234, key: ctx.params.id }))
const h235 = route("POST", path(lit("res235")), async (ctx) => json({ id: 235, key: "res235" }))
const h236 = route("PUT", path(lit("res236"), param("id")), async (ctx) => json({ id: 236, key: ctx.params.id }))
const h237 = route("GET", path(lit("res237")), async (ctx) => json({ id: 237, key: "res237" }))
const h238 = route("POST", path(lit("res238"), param("id")), async (ctx) => json({ id: 238, key: ctx.params.id }))
const h239 = route("PUT", path(lit("res239")), async (ctx) => json({ id: 239, key: "res239" }))
const h240 = route("GET", path(lit("res240"), param("id")), async (ctx) => json({ id: 240, key: ctx.params.id }))
const h241 = route("POST", path(lit("res241")), bodySchema, async (ctx) => json({ id: 241, name: ctx.body.name, qty: ctx.body.qty }))
const h242 = route("PUT", path(lit("res242"), param("id")), async (ctx) => json({ id: 242, key: ctx.params.id }))
const h243 = route("GET", path(lit("res243")), async (ctx) => json({ id: 243, key: "res243" }))
const h244 = route("POST", path(lit("res244"), param("id")), async (ctx) => json({ id: 244, key: ctx.params.id }))
const h245 = route("PUT", path(lit("res245")), bodySchema, async (ctx) => json({ id: 245, name: ctx.body.name, qty: ctx.body.qty }))
const h246 = route("GET", path(lit("res246"), param("id")), async (ctx) => json({ id: 246, key: ctx.params.id }))
const h247 = route("POST", path(lit("res247")), async (ctx) => json({ id: 247, key: "res247" }))
const h248 = route("PUT", path(lit("res248"), param("id")), async (ctx) => json({ id: 248, key: ctx.params.id }))
const h249 = route("GET", path(lit("res249")), async (ctx) => json({ id: 249, key: "res249" }))
const h250 = route("POST", path(lit("res250"), param("id")), async (ctx) => json({ id: 250, key: ctx.params.id }))
const h251 = route("PUT", path(lit("res251")), async (ctx) => json({ id: 251, key: "res251" }))
const h252 = route("GET", path(lit("res252"), param("id")), async (ctx) => json({ id: 252, key: ctx.params.id }))
const h253 = route("POST", path(lit("res253")), bodySchema, async (ctx) => json({ id: 253, name: ctx.body.name, qty: ctx.body.qty }))
const h254 = route("PUT", path(lit("res254"), param("id")), async (ctx) => json({ id: 254, key: ctx.params.id }))
const h255 = route("GET", path(lit("res255")), async (ctx) => json({ id: 255, key: "res255" }))
const h256 = route("POST", path(lit("res256"), param("id")), async (ctx) => json({ id: 256, key: ctx.params.id }))
const h257 = route("PUT", path(lit("res257")), bodySchema, async (ctx) => json({ id: 257, name: ctx.body.name, qty: ctx.body.qty }))
const h258 = route("GET", path(lit("res258"), param("id")), async (ctx) => json({ id: 258, key: ctx.params.id }))
const h259 = route("POST", path(lit("res259")), async (ctx) => json({ id: 259, key: "res259" }))
const h260 = route("PUT", path(lit("res260"), param("id")), async (ctx) => json({ id: 260, key: ctx.params.id }))
const h261 = route("GET", path(lit("res261")), async (ctx) => json({ id: 261, key: "res261" }))
const h262 = route("POST", path(lit("res262"), param("id")), async (ctx) => json({ id: 262, key: ctx.params.id }))
const h263 = route("PUT", path(lit("res263")), async (ctx) => json({ id: 263, key: "res263" }))
const h264 = route("GET", path(lit("res264"), param("id")), async (ctx) => json({ id: 264, key: ctx.params.id }))
const h265 = route("POST", path(lit("res265")), bodySchema, async (ctx) => json({ id: 265, name: ctx.body.name, qty: ctx.body.qty }))
const h266 = route("PUT", path(lit("res266"), param("id")), async (ctx) => json({ id: 266, key: ctx.params.id }))
const h267 = route("GET", path(lit("res267")), async (ctx) => json({ id: 267, key: "res267" }))
const h268 = route("POST", path(lit("res268"), param("id")), async (ctx) => json({ id: 268, key: ctx.params.id }))
const h269 = route("PUT", path(lit("res269")), bodySchema, async (ctx) => json({ id: 269, name: ctx.body.name, qty: ctx.body.qty }))
const h270 = route("GET", path(lit("res270"), param("id")), async (ctx) => json({ id: 270, key: ctx.params.id }))
const h271 = route("POST", path(lit("res271")), async (ctx) => json({ id: 271, key: "res271" }))
const h272 = route("PUT", path(lit("res272"), param("id")), async (ctx) => json({ id: 272, key: ctx.params.id }))
const h273 = route("GET", path(lit("res273")), async (ctx) => json({ id: 273, key: "res273" }))
const h274 = route("POST", path(lit("res274"), param("id")), async (ctx) => json({ id: 274, key: ctx.params.id }))
const h275 = route("PUT", path(lit("res275")), async (ctx) => json({ id: 275, key: "res275" }))
const h276 = route("GET", path(lit("res276"), param("id")), async (ctx) => json({ id: 276, key: ctx.params.id }))
const h277 = route("POST", path(lit("res277")), bodySchema, async (ctx) => json({ id: 277, name: ctx.body.name, qty: ctx.body.qty }))
const h278 = route("PUT", path(lit("res278"), param("id")), async (ctx) => json({ id: 278, key: ctx.params.id }))
const h279 = route("GET", path(lit("res279")), async (ctx) => json({ id: 279, key: "res279" }))
const h280 = route("POST", path(lit("res280"), param("id")), async (ctx) => json({ id: 280, key: ctx.params.id }))
const h281 = route("PUT", path(lit("res281")), bodySchema, async (ctx) => json({ id: 281, name: ctx.body.name, qty: ctx.body.qty }))
const h282 = route("GET", path(lit("res282"), param("id")), async (ctx) => json({ id: 282, key: ctx.params.id }))
const h283 = route("POST", path(lit("res283")), async (ctx) => json({ id: 283, key: "res283" }))
const h284 = route("PUT", path(lit("res284"), param("id")), async (ctx) => json({ id: 284, key: ctx.params.id }))
const h285 = route("GET", path(lit("res285")), async (ctx) => json({ id: 285, key: "res285" }))
const h286 = route("POST", path(lit("res286"), param("id")), async (ctx) => json({ id: 286, key: ctx.params.id }))
const h287 = route("PUT", path(lit("res287")), async (ctx) => json({ id: 287, key: "res287" }))
const h288 = route("GET", path(lit("res288"), param("id")), async (ctx) => json({ id: 288, key: ctx.params.id }))
const h289 = route("POST", path(lit("res289")), bodySchema, async (ctx) => json({ id: 289, name: ctx.body.name, qty: ctx.body.qty }))
const h290 = route("PUT", path(lit("res290"), param("id")), async (ctx) => json({ id: 290, key: ctx.params.id }))
const h291 = route("GET", path(lit("res291")), async (ctx) => json({ id: 291, key: "res291" }))
const h292 = route("POST", path(lit("res292"), param("id")), async (ctx) => json({ id: 292, key: ctx.params.id }))
const h293 = route("PUT", path(lit("res293")), bodySchema, async (ctx) => json({ id: 293, name: ctx.body.name, qty: ctx.body.qty }))
const h294 = route("GET", path(lit("res294"), param("id")), async (ctx) => json({ id: 294, key: ctx.params.id }))
const h295 = route("POST", path(lit("res295")), async (ctx) => json({ id: 295, key: "res295" }))
const h296 = route("PUT", path(lit("res296"), param("id")), async (ctx) => json({ id: 296, key: ctx.params.id }))
const h297 = route("GET", path(lit("res297")), async (ctx) => json({ id: 297, key: "res297" }))
const h298 = route("POST", path(lit("res298"), param("id")), async (ctx) => json({ id: 298, key: ctx.params.id }))
const h299 = route("PUT", path(lit("res299")), async (ctx) => json({ id: 299, key: "res299" }))
const h300 = route("GET", path(lit("res300"), param("id")), async (ctx) => json({ id: 300, key: ctx.params.id }))
const h301 = route("POST", path(lit("res301")), bodySchema, async (ctx) => json({ id: 301, name: ctx.body.name, qty: ctx.body.qty }))
const h302 = route("PUT", path(lit("res302"), param("id")), async (ctx) => json({ id: 302, key: ctx.params.id }))
const h303 = route("GET", path(lit("res303")), async (ctx) => json({ id: 303, key: "res303" }))
const h304 = route("POST", path(lit("res304"), param("id")), async (ctx) => json({ id: 304, key: ctx.params.id }))
const h305 = route("PUT", path(lit("res305")), bodySchema, async (ctx) => json({ id: 305, name: ctx.body.name, qty: ctx.body.qty }))
const h306 = route("GET", path(lit("res306"), param("id")), async (ctx) => json({ id: 306, key: ctx.params.id }))
const h307 = route("POST", path(lit("res307")), async (ctx) => json({ id: 307, key: "res307" }))
const h308 = route("PUT", path(lit("res308"), param("id")), async (ctx) => json({ id: 308, key: ctx.params.id }))
const h309 = route("GET", path(lit("res309")), async (ctx) => json({ id: 309, key: "res309" }))
const h310 = route("POST", path(lit("res310"), param("id")), async (ctx) => json({ id: 310, key: ctx.params.id }))
const h311 = route("PUT", path(lit("res311")), async (ctx) => json({ id: 311, key: "res311" }))
const h312 = route("GET", path(lit("res312"), param("id")), async (ctx) => json({ id: 312, key: ctx.params.id }))
const h313 = route("POST", path(lit("res313")), bodySchema, async (ctx) => json({ id: 313, name: ctx.body.name, qty: ctx.body.qty }))
const h314 = route("PUT", path(lit("res314"), param("id")), async (ctx) => json({ id: 314, key: ctx.params.id }))
const h315 = route("GET", path(lit("res315")), async (ctx) => json({ id: 315, key: "res315" }))
const h316 = route("POST", path(lit("res316"), param("id")), async (ctx) => json({ id: 316, key: ctx.params.id }))
const h317 = route("PUT", path(lit("res317")), bodySchema, async (ctx) => json({ id: 317, name: ctx.body.name, qty: ctx.body.qty }))
const h318 = route("GET", path(lit("res318"), param("id")), async (ctx) => json({ id: 318, key: ctx.params.id }))
const h319 = route("POST", path(lit("res319")), async (ctx) => json({ id: 319, key: "res319" }))
const h320 = route("PUT", path(lit("res320"), param("id")), async (ctx) => json({ id: 320, key: ctx.params.id }))
const h321 = route("GET", path(lit("res321")), async (ctx) => json({ id: 321, key: "res321" }))
const h322 = route("POST", path(lit("res322"), param("id")), async (ctx) => json({ id: 322, key: ctx.params.id }))
const h323 = route("PUT", path(lit("res323")), async (ctx) => json({ id: 323, key: "res323" }))
const h324 = route("GET", path(lit("res324"), param("id")), async (ctx) => json({ id: 324, key: ctx.params.id }))
const h325 = route("POST", path(lit("res325")), bodySchema, async (ctx) => json({ id: 325, name: ctx.body.name, qty: ctx.body.qty }))
const h326 = route("PUT", path(lit("res326"), param("id")), async (ctx) => json({ id: 326, key: ctx.params.id }))
const h327 = route("GET", path(lit("res327")), async (ctx) => json({ id: 327, key: "res327" }))
const h328 = route("POST", path(lit("res328"), param("id")), async (ctx) => json({ id: 328, key: ctx.params.id }))
const h329 = route("PUT", path(lit("res329")), bodySchema, async (ctx) => json({ id: 329, name: ctx.body.name, qty: ctx.body.qty }))
const h330 = route("GET", path(lit("res330"), param("id")), async (ctx) => json({ id: 330, key: ctx.params.id }))
const h331 = route("POST", path(lit("res331")), async (ctx) => json({ id: 331, key: "res331" }))
const h332 = route("PUT", path(lit("res332"), param("id")), async (ctx) => json({ id: 332, key: ctx.params.id }))
const h333 = route("GET", path(lit("res333")), async (ctx) => json({ id: 333, key: "res333" }))
const h334 = route("POST", path(lit("res334"), param("id")), async (ctx) => json({ id: 334, key: ctx.params.id }))
const h335 = route("PUT", path(lit("res335")), async (ctx) => json({ id: 335, key: "res335" }))
const h336 = route("GET", path(lit("res336"), param("id")), async (ctx) => json({ id: 336, key: ctx.params.id }))
const h337 = route("POST", path(lit("res337")), bodySchema, async (ctx) => json({ id: 337, name: ctx.body.name, qty: ctx.body.qty }))
const h338 = route("PUT", path(lit("res338"), param("id")), async (ctx) => json({ id: 338, key: ctx.params.id }))
const h339 = route("GET", path(lit("res339")), async (ctx) => json({ id: 339, key: "res339" }))
const h340 = route("POST", path(lit("res340"), param("id")), async (ctx) => json({ id: 340, key: ctx.params.id }))
const h341 = route("PUT", path(lit("res341")), bodySchema, async (ctx) => json({ id: 341, name: ctx.body.name, qty: ctx.body.qty }))
const h342 = route("GET", path(lit("res342"), param("id")), async (ctx) => json({ id: 342, key: ctx.params.id }))
const h343 = route("POST", path(lit("res343")), async (ctx) => json({ id: 343, key: "res343" }))
const h344 = route("PUT", path(lit("res344"), param("id")), async (ctx) => json({ id: 344, key: ctx.params.id }))
const h345 = route("GET", path(lit("res345")), async (ctx) => json({ id: 345, key: "res345" }))
const h346 = route("POST", path(lit("res346"), param("id")), async (ctx) => json({ id: 346, key: ctx.params.id }))
const h347 = route("PUT", path(lit("res347")), async (ctx) => json({ id: 347, key: "res347" }))
const h348 = route("GET", path(lit("res348"), param("id")), async (ctx) => json({ id: 348, key: ctx.params.id }))
const h349 = route("POST", path(lit("res349")), bodySchema, async (ctx) => json({ id: 349, name: ctx.body.name, qty: ctx.body.qty }))
const h350 = route("PUT", path(lit("res350"), param("id")), async (ctx) => json({ id: 350, key: ctx.params.id }))
const h351 = route("GET", path(lit("res351")), async (ctx) => json({ id: 351, key: "res351" }))
const h352 = route("POST", path(lit("res352"), param("id")), async (ctx) => json({ id: 352, key: ctx.params.id }))
const h353 = route("PUT", path(lit("res353")), bodySchema, async (ctx) => json({ id: 353, name: ctx.body.name, qty: ctx.body.qty }))
const h354 = route("GET", path(lit("res354"), param("id")), async (ctx) => json({ id: 354, key: ctx.params.id }))
const h355 = route("POST", path(lit("res355")), async (ctx) => json({ id: 355, key: "res355" }))
const h356 = route("PUT", path(lit("res356"), param("id")), async (ctx) => json({ id: 356, key: ctx.params.id }))
const h357 = route("GET", path(lit("res357")), async (ctx) => json({ id: 357, key: "res357" }))
const h358 = route("POST", path(lit("res358"), param("id")), async (ctx) => json({ id: 358, key: ctx.params.id }))
const h359 = route("PUT", path(lit("res359")), async (ctx) => json({ id: 359, key: "res359" }))
const h360 = route("GET", path(lit("res360"), param("id")), async (ctx) => json({ id: 360, key: ctx.params.id }))
const h361 = route("POST", path(lit("res361")), bodySchema, async (ctx) => json({ id: 361, name: ctx.body.name, qty: ctx.body.qty }))
const h362 = route("PUT", path(lit("res362"), param("id")), async (ctx) => json({ id: 362, key: ctx.params.id }))
const h363 = route("GET", path(lit("res363")), async (ctx) => json({ id: 363, key: "res363" }))
const h364 = route("POST", path(lit("res364"), param("id")), async (ctx) => json({ id: 364, key: ctx.params.id }))
const h365 = route("PUT", path(lit("res365")), bodySchema, async (ctx) => json({ id: 365, name: ctx.body.name, qty: ctx.body.qty }))
const h366 = route("GET", path(lit("res366"), param("id")), async (ctx) => json({ id: 366, key: ctx.params.id }))
const h367 = route("POST", path(lit("res367")), async (ctx) => json({ id: 367, key: "res367" }))
const h368 = route("PUT", path(lit("res368"), param("id")), async (ctx) => json({ id: 368, key: ctx.params.id }))
const h369 = route("GET", path(lit("res369")), async (ctx) => json({ id: 369, key: "res369" }))
const h370 = route("POST", path(lit("res370"), param("id")), async (ctx) => json({ id: 370, key: ctx.params.id }))
const h371 = route("PUT", path(lit("res371")), async (ctx) => json({ id: 371, key: "res371" }))
const h372 = route("GET", path(lit("res372"), param("id")), async (ctx) => json({ id: 372, key: ctx.params.id }))
const h373 = route("POST", path(lit("res373")), bodySchema, async (ctx) => json({ id: 373, name: ctx.body.name, qty: ctx.body.qty }))
const h374 = route("PUT", path(lit("res374"), param("id")), async (ctx) => json({ id: 374, key: ctx.params.id }))
const h375 = route("GET", path(lit("res375")), async (ctx) => json({ id: 375, key: "res375" }))
const h376 = route("POST", path(lit("res376"), param("id")), async (ctx) => json({ id: 376, key: ctx.params.id }))
const h377 = route("PUT", path(lit("res377")), bodySchema, async (ctx) => json({ id: 377, name: ctx.body.name, qty: ctx.body.qty }))
const h378 = route("GET", path(lit("res378"), param("id")), async (ctx) => json({ id: 378, key: ctx.params.id }))
const h379 = route("POST", path(lit("res379")), async (ctx) => json({ id: 379, key: "res379" }))
const h380 = route("PUT", path(lit("res380"), param("id")), async (ctx) => json({ id: 380, key: ctx.params.id }))
const h381 = route("GET", path(lit("res381")), async (ctx) => json({ id: 381, key: "res381" }))
const h382 = route("POST", path(lit("res382"), param("id")), async (ctx) => json({ id: 382, key: ctx.params.id }))
const h383 = route("PUT", path(lit("res383")), async (ctx) => json({ id: 383, key: "res383" }))
const h384 = route("GET", path(lit("res384"), param("id")), async (ctx) => json({ id: 384, key: ctx.params.id }))
const h385 = route("POST", path(lit("res385")), bodySchema, async (ctx) => json({ id: 385, name: ctx.body.name, qty: ctx.body.qty }))
const h386 = route("PUT", path(lit("res386"), param("id")), async (ctx) => json({ id: 386, key: ctx.params.id }))
const h387 = route("GET", path(lit("res387")), async (ctx) => json({ id: 387, key: "res387" }))
const h388 = route("POST", path(lit("res388"), param("id")), async (ctx) => json({ id: 388, key: ctx.params.id }))
const h389 = route("PUT", path(lit("res389")), bodySchema, async (ctx) => json({ id: 389, name: ctx.body.name, qty: ctx.body.qty }))
const h390 = route("GET", path(lit("res390"), param("id")), async (ctx) => json({ id: 390, key: ctx.params.id }))
const h391 = route("POST", path(lit("res391")), async (ctx) => json({ id: 391, key: "res391" }))
const h392 = route("PUT", path(lit("res392"), param("id")), async (ctx) => json({ id: 392, key: ctx.params.id }))
const h393 = route("GET", path(lit("res393")), async (ctx) => json({ id: 393, key: "res393" }))
const h394 = route("POST", path(lit("res394"), param("id")), async (ctx) => json({ id: 394, key: ctx.params.id }))
const h395 = route("PUT", path(lit("res395")), async (ctx) => json({ id: 395, key: "res395" }))
const h396 = route("GET", path(lit("res396"), param("id")), async (ctx) => json({ id: 396, key: ctx.params.id }))
const h397 = route("POST", path(lit("res397")), bodySchema, async (ctx) => json({ id: 397, name: ctx.body.name, qty: ctx.body.qty }))
const h398 = route("PUT", path(lit("res398"), param("id")), async (ctx) => json({ id: 398, key: ctx.params.id }))
const h399 = route("GET", path(lit("res399")), async (ctx) => json({ id: 399, key: "res399" }))
const h400 = route("POST", path(lit("res400"), param("id")), async (ctx) => json({ id: 400, key: ctx.params.id }))
const h401 = route("PUT", path(lit("res401")), bodySchema, async (ctx) => json({ id: 401, name: ctx.body.name, qty: ctx.body.qty }))
const h402 = route("GET", path(lit("res402"), param("id")), async (ctx) => json({ id: 402, key: ctx.params.id }))
const h403 = route("POST", path(lit("res403")), async (ctx) => json({ id: 403, key: "res403" }))
const h404 = route("PUT", path(lit("res404"), param("id")), async (ctx) => json({ id: 404, key: ctx.params.id }))
const h405 = route("GET", path(lit("res405")), async (ctx) => json({ id: 405, key: "res405" }))
const h406 = route("POST", path(lit("res406"), param("id")), async (ctx) => json({ id: 406, key: ctx.params.id }))
const h407 = route("PUT", path(lit("res407")), async (ctx) => json({ id: 407, key: "res407" }))
const h408 = route("GET", path(lit("res408"), param("id")), async (ctx) => json({ id: 408, key: ctx.params.id }))
const h409 = route("POST", path(lit("res409")), bodySchema, async (ctx) => json({ id: 409, name: ctx.body.name, qty: ctx.body.qty }))
const h410 = route("PUT", path(lit("res410"), param("id")), async (ctx) => json({ id: 410, key: ctx.params.id }))
const h411 = route("GET", path(lit("res411")), async (ctx) => json({ id: 411, key: "res411" }))
const h412 = route("POST", path(lit("res412"), param("id")), async (ctx) => json({ id: 412, key: ctx.params.id }))
const h413 = route("PUT", path(lit("res413")), bodySchema, async (ctx) => json({ id: 413, name: ctx.body.name, qty: ctx.body.qty }))
const h414 = route("GET", path(lit("res414"), param("id")), async (ctx) => json({ id: 414, key: ctx.params.id }))
const h415 = route("POST", path(lit("res415")), async (ctx) => json({ id: 415, key: "res415" }))
const h416 = route("PUT", path(lit("res416"), param("id")), async (ctx) => json({ id: 416, key: ctx.params.id }))
const h417 = route("GET", path(lit("res417")), async (ctx) => json({ id: 417, key: "res417" }))
const h418 = route("POST", path(lit("res418"), param("id")), async (ctx) => json({ id: 418, key: ctx.params.id }))
const h419 = route("PUT", path(lit("res419")), async (ctx) => json({ id: 419, key: "res419" }))
const h420 = route("GET", path(lit("res420"), param("id")), async (ctx) => json({ id: 420, key: ctx.params.id }))
const h421 = route("POST", path(lit("res421")), bodySchema, async (ctx) => json({ id: 421, name: ctx.body.name, qty: ctx.body.qty }))
const h422 = route("PUT", path(lit("res422"), param("id")), async (ctx) => json({ id: 422, key: ctx.params.id }))
const h423 = route("GET", path(lit("res423")), async (ctx) => json({ id: 423, key: "res423" }))
const h424 = route("POST", path(lit("res424"), param("id")), async (ctx) => json({ id: 424, key: ctx.params.id }))
const h425 = route("PUT", path(lit("res425")), bodySchema, async (ctx) => json({ id: 425, name: ctx.body.name, qty: ctx.body.qty }))
const h426 = route("GET", path(lit("res426"), param("id")), async (ctx) => json({ id: 426, key: ctx.params.id }))
const h427 = route("POST", path(lit("res427")), async (ctx) => json({ id: 427, key: "res427" }))
const h428 = route("PUT", path(lit("res428"), param("id")), async (ctx) => json({ id: 428, key: ctx.params.id }))
const h429 = route("GET", path(lit("res429")), async (ctx) => json({ id: 429, key: "res429" }))
const h430 = route("POST", path(lit("res430"), param("id")), async (ctx) => json({ id: 430, key: ctx.params.id }))
const h431 = route("PUT", path(lit("res431")), async (ctx) => json({ id: 431, key: "res431" }))
const h432 = route("GET", path(lit("res432"), param("id")), async (ctx) => json({ id: 432, key: ctx.params.id }))
const h433 = route("POST", path(lit("res433")), bodySchema, async (ctx) => json({ id: 433, name: ctx.body.name, qty: ctx.body.qty }))
const h434 = route("PUT", path(lit("res434"), param("id")), async (ctx) => json({ id: 434, key: ctx.params.id }))
const h435 = route("GET", path(lit("res435")), async (ctx) => json({ id: 435, key: "res435" }))
const h436 = route("POST", path(lit("res436"), param("id")), async (ctx) => json({ id: 436, key: ctx.params.id }))
const h437 = route("PUT", path(lit("res437")), bodySchema, async (ctx) => json({ id: 437, name: ctx.body.name, qty: ctx.body.qty }))
const h438 = route("GET", path(lit("res438"), param("id")), async (ctx) => json({ id: 438, key: ctx.params.id }))
const h439 = route("POST", path(lit("res439")), async (ctx) => json({ id: 439, key: "res439" }))
const h440 = route("PUT", path(lit("res440"), param("id")), async (ctx) => json({ id: 440, key: ctx.params.id }))
const h441 = route("GET", path(lit("res441")), async (ctx) => json({ id: 441, key: "res441" }))
const h442 = route("POST", path(lit("res442"), param("id")), async (ctx) => json({ id: 442, key: ctx.params.id }))
const h443 = route("PUT", path(lit("res443")), async (ctx) => json({ id: 443, key: "res443" }))
const h444 = route("GET", path(lit("res444"), param("id")), async (ctx) => json({ id: 444, key: ctx.params.id }))
const h445 = route("POST", path(lit("res445")), bodySchema, async (ctx) => json({ id: 445, name: ctx.body.name, qty: ctx.body.qty }))
const h446 = route("PUT", path(lit("res446"), param("id")), async (ctx) => json({ id: 446, key: ctx.params.id }))
const h447 = route("GET", path(lit("res447")), async (ctx) => json({ id: 447, key: "res447" }))
const h448 = route("POST", path(lit("res448"), param("id")), async (ctx) => json({ id: 448, key: ctx.params.id }))
const h449 = route("PUT", path(lit("res449")), bodySchema, async (ctx) => json({ id: 449, name: ctx.body.name, qty: ctx.body.qty }))
const h450 = route("GET", path(lit("res450"), param("id")), async (ctx) => json({ id: 450, key: ctx.params.id }))
const h451 = route("POST", path(lit("res451")), async (ctx) => json({ id: 451, key: "res451" }))
const h452 = route("PUT", path(lit("res452"), param("id")), async (ctx) => json({ id: 452, key: ctx.params.id }))
const h453 = route("GET", path(lit("res453")), async (ctx) => json({ id: 453, key: "res453" }))
const h454 = route("POST", path(lit("res454"), param("id")), async (ctx) => json({ id: 454, key: ctx.params.id }))
const h455 = route("PUT", path(lit("res455")), async (ctx) => json({ id: 455, key: "res455" }))
const h456 = route("GET", path(lit("res456"), param("id")), async (ctx) => json({ id: 456, key: ctx.params.id }))
const h457 = route("POST", path(lit("res457")), bodySchema, async (ctx) => json({ id: 457, name: ctx.body.name, qty: ctx.body.qty }))
const h458 = route("PUT", path(lit("res458"), param("id")), async (ctx) => json({ id: 458, key: ctx.params.id }))
const h459 = route("GET", path(lit("res459")), async (ctx) => json({ id: 459, key: "res459" }))
const h460 = route("POST", path(lit("res460"), param("id")), async (ctx) => json({ id: 460, key: ctx.params.id }))
const h461 = route("PUT", path(lit("res461")), bodySchema, async (ctx) => json({ id: 461, name: ctx.body.name, qty: ctx.body.qty }))
const h462 = route("GET", path(lit("res462"), param("id")), async (ctx) => json({ id: 462, key: ctx.params.id }))
const h463 = route("POST", path(lit("res463")), async (ctx) => json({ id: 463, key: "res463" }))
const h464 = route("PUT", path(lit("res464"), param("id")), async (ctx) => json({ id: 464, key: ctx.params.id }))
const h465 = route("GET", path(lit("res465")), async (ctx) => json({ id: 465, key: "res465" }))
const h466 = route("POST", path(lit("res466"), param("id")), async (ctx) => json({ id: 466, key: ctx.params.id }))
const h467 = route("PUT", path(lit("res467")), async (ctx) => json({ id: 467, key: "res467" }))
const h468 = route("GET", path(lit("res468"), param("id")), async (ctx) => json({ id: 468, key: ctx.params.id }))
const h469 = route("POST", path(lit("res469")), bodySchema, async (ctx) => json({ id: 469, name: ctx.body.name, qty: ctx.body.qty }))
const h470 = route("PUT", path(lit("res470"), param("id")), async (ctx) => json({ id: 470, key: ctx.params.id }))
const h471 = route("GET", path(lit("res471")), async (ctx) => json({ id: 471, key: "res471" }))
const h472 = route("POST", path(lit("res472"), param("id")), async (ctx) => json({ id: 472, key: ctx.params.id }))
const h473 = route("PUT", path(lit("res473")), bodySchema, async (ctx) => json({ id: 473, name: ctx.body.name, qty: ctx.body.qty }))
const h474 = route("GET", path(lit("res474"), param("id")), async (ctx) => json({ id: 474, key: ctx.params.id }))
const h475 = route("POST", path(lit("res475")), async (ctx) => json({ id: 475, key: "res475" }))
const h476 = route("PUT", path(lit("res476"), param("id")), async (ctx) => json({ id: 476, key: ctx.params.id }))
const h477 = route("GET", path(lit("res477")), async (ctx) => json({ id: 477, key: "res477" }))
const h478 = route("POST", path(lit("res478"), param("id")), async (ctx) => json({ id: 478, key: ctx.params.id }))
const h479 = route("PUT", path(lit("res479")), async (ctx) => json({ id: 479, key: "res479" }))
const h480 = route("GET", path(lit("res480"), param("id")), async (ctx) => json({ id: 480, key: ctx.params.id }))
const h481 = route("POST", path(lit("res481")), bodySchema, async (ctx) => json({ id: 481, name: ctx.body.name, qty: ctx.body.qty }))
const h482 = route("PUT", path(lit("res482"), param("id")), async (ctx) => json({ id: 482, key: ctx.params.id }))
const h483 = route("GET", path(lit("res483")), async (ctx) => json({ id: 483, key: "res483" }))
const h484 = route("POST", path(lit("res484"), param("id")), async (ctx) => json({ id: 484, key: ctx.params.id }))
const h485 = route("PUT", path(lit("res485")), bodySchema, async (ctx) => json({ id: 485, name: ctx.body.name, qty: ctx.body.qty }))
const h486 = route("GET", path(lit("res486"), param("id")), async (ctx) => json({ id: 486, key: ctx.params.id }))
const h487 = route("POST", path(lit("res487")), async (ctx) => json({ id: 487, key: "res487" }))
const h488 = route("PUT", path(lit("res488"), param("id")), async (ctx) => json({ id: 488, key: ctx.params.id }))
const h489 = route("GET", path(lit("res489")), async (ctx) => json({ id: 489, key: "res489" }))
const h490 = route("POST", path(lit("res490"), param("id")), async (ctx) => json({ id: 490, key: ctx.params.id }))
const h491 = route("PUT", path(lit("res491")), async (ctx) => json({ id: 491, key: "res491" }))
const h492 = route("GET", path(lit("res492"), param("id")), async (ctx) => json({ id: 492, key: ctx.params.id }))
const h493 = route("POST", path(lit("res493")), bodySchema, async (ctx) => json({ id: 493, name: ctx.body.name, qty: ctx.body.qty }))
const h494 = route("PUT", path(lit("res494"), param("id")), async (ctx) => json({ id: 494, key: ctx.params.id }))
const h495 = route("GET", path(lit("res495")), async (ctx) => json({ id: 495, key: "res495" }))
const h496 = route("POST", path(lit("res496"), param("id")), async (ctx) => json({ id: 496, key: ctx.params.id }))
const h497 = route("PUT", path(lit("res497")), bodySchema, async (ctx) => json({ id: 497, name: ctx.body.name, qty: ctx.body.qty }))
const h498 = route("GET", path(lit("res498"), param("id")), async (ctx) => json({ id: 498, key: ctx.params.id }))
const h499 = route("POST", path(lit("res499")), async (ctx) => json({ id: 499, key: "res499" }))
const h500 = route("PUT", path(lit("res500"), param("id")), async (ctx) => json({ id: 500, key: ctx.params.id }))
const h501 = route("GET", path(lit("res501")), async (ctx) => json({ id: 501, key: "res501" }))
const h502 = route("POST", path(lit("res502"), param("id")), async (ctx) => json({ id: 502, key: ctx.params.id }))
const h503 = route("PUT", path(lit("res503")), async (ctx) => json({ id: 503, key: "res503" }))
const h504 = route("GET", path(lit("res504"), param("id")), async (ctx) => json({ id: 504, key: ctx.params.id }))
const h505 = route("POST", path(lit("res505")), bodySchema, async (ctx) => json({ id: 505, name: ctx.body.name, qty: ctx.body.qty }))
const h506 = route("PUT", path(lit("res506"), param("id")), async (ctx) => json({ id: 506, key: ctx.params.id }))
const h507 = route("GET", path(lit("res507")), async (ctx) => json({ id: 507, key: "res507" }))
const h508 = route("POST", path(lit("res508"), param("id")), async (ctx) => json({ id: 508, key: ctx.params.id }))
const h509 = route("PUT", path(lit("res509")), bodySchema, async (ctx) => json({ id: 509, name: ctx.body.name, qty: ctx.body.qty }))
const h510 = route("GET", path(lit("res510"), param("id")), async (ctx) => json({ id: 510, key: ctx.params.id }))
const h511 = route("POST", path(lit("res511")), async (ctx) => json({ id: 511, key: "res511" }))
const h512 = route("PUT", path(lit("res512"), param("id")), async (ctx) => json({ id: 512, key: ctx.params.id }))
const h513 = route("GET", path(lit("res513")), async (ctx) => json({ id: 513, key: "res513" }))
const h514 = route("POST", path(lit("res514"), param("id")), async (ctx) => json({ id: 514, key: ctx.params.id }))
const h515 = route("PUT", path(lit("res515")), async (ctx) => json({ id: 515, key: "res515" }))
const h516 = route("GET", path(lit("res516"), param("id")), async (ctx) => json({ id: 516, key: ctx.params.id }))
const h517 = route("POST", path(lit("res517")), bodySchema, async (ctx) => json({ id: 517, name: ctx.body.name, qty: ctx.body.qty }))
const h518 = route("PUT", path(lit("res518"), param("id")), async (ctx) => json({ id: 518, key: ctx.params.id }))
const h519 = route("GET", path(lit("res519")), async (ctx) => json({ id: 519, key: "res519" }))
const h520 = route("POST", path(lit("res520"), param("id")), async (ctx) => json({ id: 520, key: ctx.params.id }))
const h521 = route("PUT", path(lit("res521")), bodySchema, async (ctx) => json({ id: 521, name: ctx.body.name, qty: ctx.body.qty }))
const h522 = route("GET", path(lit("res522"), param("id")), async (ctx) => json({ id: 522, key: ctx.params.id }))
const h523 = route("POST", path(lit("res523")), async (ctx) => json({ id: 523, key: "res523" }))
const h524 = route("PUT", path(lit("res524"), param("id")), async (ctx) => json({ id: 524, key: ctx.params.id }))
const h525 = route("GET", path(lit("res525")), async (ctx) => json({ id: 525, key: "res525" }))
const h526 = route("POST", path(lit("res526"), param("id")), async (ctx) => json({ id: 526, key: ctx.params.id }))
const h527 = route("PUT", path(lit("res527")), async (ctx) => json({ id: 527, key: "res527" }))
const h528 = route("GET", path(lit("res528"), param("id")), async (ctx) => json({ id: 528, key: ctx.params.id }))
const h529 = route("POST", path(lit("res529")), bodySchema, async (ctx) => json({ id: 529, name: ctx.body.name, qty: ctx.body.qty }))
const h530 = route("PUT", path(lit("res530"), param("id")), async (ctx) => json({ id: 530, key: ctx.params.id }))
const h531 = route("GET", path(lit("res531")), async (ctx) => json({ id: 531, key: "res531" }))
const h532 = route("POST", path(lit("res532"), param("id")), async (ctx) => json({ id: 532, key: ctx.params.id }))
const h533 = route("PUT", path(lit("res533")), bodySchema, async (ctx) => json({ id: 533, name: ctx.body.name, qty: ctx.body.qty }))
const h534 = route("GET", path(lit("res534"), param("id")), async (ctx) => json({ id: 534, key: ctx.params.id }))
const h535 = route("POST", path(lit("res535")), async (ctx) => json({ id: 535, key: "res535" }))
const h536 = route("PUT", path(lit("res536"), param("id")), async (ctx) => json({ id: 536, key: ctx.params.id }))
const h537 = route("GET", path(lit("res537")), async (ctx) => json({ id: 537, key: "res537" }))
const h538 = route("POST", path(lit("res538"), param("id")), async (ctx) => json({ id: 538, key: ctx.params.id }))
const h539 = route("PUT", path(lit("res539")), async (ctx) => json({ id: 539, key: "res539" }))
const h540 = route("GET", path(lit("res540"), param("id")), async (ctx) => json({ id: 540, key: ctx.params.id }))
const h541 = route("POST", path(lit("res541")), bodySchema, async (ctx) => json({ id: 541, name: ctx.body.name, qty: ctx.body.qty }))
const h542 = route("PUT", path(lit("res542"), param("id")), async (ctx) => json({ id: 542, key: ctx.params.id }))
const h543 = route("GET", path(lit("res543")), async (ctx) => json({ id: 543, key: "res543" }))
const h544 = route("POST", path(lit("res544"), param("id")), async (ctx) => json({ id: 544, key: ctx.params.id }))
const h545 = route("PUT", path(lit("res545")), bodySchema, async (ctx) => json({ id: 545, name: ctx.body.name, qty: ctx.body.qty }))
const h546 = route("GET", path(lit("res546"), param("id")), async (ctx) => json({ id: 546, key: ctx.params.id }))
const h547 = route("POST", path(lit("res547")), async (ctx) => json({ id: 547, key: "res547" }))
const h548 = route("PUT", path(lit("res548"), param("id")), async (ctx) => json({ id: 548, key: ctx.params.id }))
const h549 = route("GET", path(lit("res549")), async (ctx) => json({ id: 549, key: "res549" }))
const h550 = route("POST", path(lit("res550"), param("id")), async (ctx) => json({ id: 550, key: ctx.params.id }))
const h551 = route("PUT", path(lit("res551")), async (ctx) => json({ id: 551, key: "res551" }))
const h552 = route("GET", path(lit("res552"), param("id")), async (ctx) => json({ id: 552, key: ctx.params.id }))
const h553 = route("POST", path(lit("res553")), bodySchema, async (ctx) => json({ id: 553, name: ctx.body.name, qty: ctx.body.qty }))
const h554 = route("PUT", path(lit("res554"), param("id")), async (ctx) => json({ id: 554, key: ctx.params.id }))
const h555 = route("GET", path(lit("res555")), async (ctx) => json({ id: 555, key: "res555" }))
const h556 = route("POST", path(lit("res556"), param("id")), async (ctx) => json({ id: 556, key: ctx.params.id }))
const h557 = route("PUT", path(lit("res557")), bodySchema, async (ctx) => json({ id: 557, name: ctx.body.name, qty: ctx.body.qty }))
const h558 = route("GET", path(lit("res558"), param("id")), async (ctx) => json({ id: 558, key: ctx.params.id }))
const h559 = route("POST", path(lit("res559")), async (ctx) => json({ id: 559, key: "res559" }))
const h560 = route("PUT", path(lit("res560"), param("id")), async (ctx) => json({ id: 560, key: ctx.params.id }))
const h561 = route("GET", path(lit("res561")), async (ctx) => json({ id: 561, key: "res561" }))
const h562 = route("POST", path(lit("res562"), param("id")), async (ctx) => json({ id: 562, key: ctx.params.id }))
const h563 = route("PUT", path(lit("res563")), async (ctx) => json({ id: 563, key: "res563" }))
const h564 = route("GET", path(lit("res564"), param("id")), async (ctx) => json({ id: 564, key: ctx.params.id }))
const h565 = route("POST", path(lit("res565")), bodySchema, async (ctx) => json({ id: 565, name: ctx.body.name, qty: ctx.body.qty }))
const h566 = route("PUT", path(lit("res566"), param("id")), async (ctx) => json({ id: 566, key: ctx.params.id }))
const h567 = route("GET", path(lit("res567")), async (ctx) => json({ id: 567, key: "res567" }))
const h568 = route("POST", path(lit("res568"), param("id")), async (ctx) => json({ id: 568, key: ctx.params.id }))
const h569 = route("PUT", path(lit("res569")), bodySchema, async (ctx) => json({ id: 569, name: ctx.body.name, qty: ctx.body.qty }))
const h570 = route("GET", path(lit("res570"), param("id")), async (ctx) => json({ id: 570, key: ctx.params.id }))
const h571 = route("POST", path(lit("res571")), async (ctx) => json({ id: 571, key: "res571" }))
const h572 = route("PUT", path(lit("res572"), param("id")), async (ctx) => json({ id: 572, key: ctx.params.id }))
const h573 = route("GET", path(lit("res573")), async (ctx) => json({ id: 573, key: "res573" }))
const h574 = route("POST", path(lit("res574"), param("id")), async (ctx) => json({ id: 574, key: ctx.params.id }))
const h575 = route("PUT", path(lit("res575")), async (ctx) => json({ id: 575, key: "res575" }))
const h576 = route("GET", path(lit("res576"), param("id")), async (ctx) => json({ id: 576, key: ctx.params.id }))
const h577 = route("POST", path(lit("res577")), bodySchema, async (ctx) => json({ id: 577, name: ctx.body.name, qty: ctx.body.qty }))
const h578 = route("PUT", path(lit("res578"), param("id")), async (ctx) => json({ id: 578, key: ctx.params.id }))
const h579 = route("GET", path(lit("res579")), async (ctx) => json({ id: 579, key: "res579" }))
const h580 = route("POST", path(lit("res580"), param("id")), async (ctx) => json({ id: 580, key: ctx.params.id }))
const h581 = route("PUT", path(lit("res581")), bodySchema, async (ctx) => json({ id: 581, name: ctx.body.name, qty: ctx.body.qty }))
const h582 = route("GET", path(lit("res582"), param("id")), async (ctx) => json({ id: 582, key: ctx.params.id }))
const h583 = route("POST", path(lit("res583")), async (ctx) => json({ id: 583, key: "res583" }))
const h584 = route("PUT", path(lit("res584"), param("id")), async (ctx) => json({ id: 584, key: ctx.params.id }))
const h585 = route("GET", path(lit("res585")), async (ctx) => json({ id: 585, key: "res585" }))
const h586 = route("POST", path(lit("res586"), param("id")), async (ctx) => json({ id: 586, key: ctx.params.id }))
const h587 = route("PUT", path(lit("res587")), async (ctx) => json({ id: 587, key: "res587" }))
const h588 = route("GET", path(lit("res588"), param("id")), async (ctx) => json({ id: 588, key: ctx.params.id }))
const h589 = route("POST", path(lit("res589")), bodySchema, async (ctx) => json({ id: 589, name: ctx.body.name, qty: ctx.body.qty }))
const h590 = route("PUT", path(lit("res590"), param("id")), async (ctx) => json({ id: 590, key: ctx.params.id }))
const h591 = route("GET", path(lit("res591")), async (ctx) => json({ id: 591, key: "res591" }))
const h592 = route("POST", path(lit("res592"), param("id")), async (ctx) => json({ id: 592, key: ctx.params.id }))
const h593 = route("PUT", path(lit("res593")), bodySchema, async (ctx) => json({ id: 593, name: ctx.body.name, qty: ctx.body.qty }))
const h594 = route("GET", path(lit("res594"), param("id")), async (ctx) => json({ id: 594, key: ctx.params.id }))
const h595 = route("POST", path(lit("res595")), async (ctx) => json({ id: 595, key: "res595" }))
const h596 = route("PUT", path(lit("res596"), param("id")), async (ctx) => json({ id: 596, key: ctx.params.id }))
const h597 = route("GET", path(lit("res597")), async (ctx) => json({ id: 597, key: "res597" }))
const h598 = route("POST", path(lit("res598"), param("id")), async (ctx) => json({ id: 598, key: ctx.params.id }))
const h599 = route("PUT", path(lit("res599")), async (ctx) => json({ id: 599, key: "res599" }))

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
