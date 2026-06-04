// GENERATED — do not edit. std typed client at scale (see generate.ts).
import { methods, param, path, validated, type StandardSchemaV1 } from "../../meta.ts";
import { client } from "../../client.ts";
import { json } from "../../std.ts";

interface Body { readonly name: string; readonly qty: number }
const bodySchema: StandardSchemaV1<unknown, Body> = {
  "~standard": {
    version: 1,
    vendor: "scale-fixture",
    validate(v: unknown) {
      const o = v as Body;
      return { value: { name: String(o?.name ?? ""), qty: Number(o?.qty ?? 0) } };
    },
  },
};

export const app = path({
  res0: methods({ GET: () => json({ id: 0, kind: "get" as const }) }),
  res1: methods({ GET: () => json({ id: 1 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res2: param("id", methods({ GET: () => json({ id: 2, kind: "param" as const }) })),
  res3: methods({ GET: () => json({ id: 3, kind: "get" as const }) }),
  res4: methods({ GET: () => json({ id: 4 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res5: param("id", methods({ GET: () => json({ id: 5, kind: "param" as const }) })),
  res6: methods({ GET: () => json({ id: 6, kind: "get" as const }) }),
  res7: methods({ GET: () => json({ id: 7 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res8: param("id", methods({ GET: () => json({ id: 8, kind: "param" as const }) })),
  res9: methods({ GET: () => json({ id: 9, kind: "get" as const }) }),
  res10: methods({ GET: () => json({ id: 10 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res11: param("id", methods({ GET: () => json({ id: 11, kind: "param" as const }) })),
  res12: methods({ GET: () => json({ id: 12, kind: "get" as const }) }),
  res13: methods({ GET: () => json({ id: 13 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res14: param("id", methods({ GET: () => json({ id: 14, kind: "param" as const }) })),
  res15: methods({ GET: () => json({ id: 15, kind: "get" as const }) }),
  res16: methods({ GET: () => json({ id: 16 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res17: param("id", methods({ GET: () => json({ id: 17, kind: "param" as const }) })),
  res18: methods({ GET: () => json({ id: 18, kind: "get" as const }) }),
  res19: methods({ GET: () => json({ id: 19 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res20: param("id", methods({ GET: () => json({ id: 20, kind: "param" as const }) })),
  res21: methods({ GET: () => json({ id: 21, kind: "get" as const }) }),
  res22: methods({ GET: () => json({ id: 22 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res23: param("id", methods({ GET: () => json({ id: 23, kind: "param" as const }) })),
  res24: methods({ GET: () => json({ id: 24, kind: "get" as const }) }),
  res25: methods({ GET: () => json({ id: 25 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res26: param("id", methods({ GET: () => json({ id: 26, kind: "param" as const }) })),
  res27: methods({ GET: () => json({ id: 27, kind: "get" as const }) }),
  res28: methods({ GET: () => json({ id: 28 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res29: param("id", methods({ GET: () => json({ id: 29, kind: "param" as const }) })),
  res30: methods({ GET: () => json({ id: 30, kind: "get" as const }) }),
  res31: methods({ GET: () => json({ id: 31 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res32: param("id", methods({ GET: () => json({ id: 32, kind: "param" as const }) })),
  res33: methods({ GET: () => json({ id: 33, kind: "get" as const }) }),
  res34: methods({ GET: () => json({ id: 34 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res35: param("id", methods({ GET: () => json({ id: 35, kind: "param" as const }) })),
  res36: methods({ GET: () => json({ id: 36, kind: "get" as const }) }),
  res37: methods({ GET: () => json({ id: 37 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res38: param("id", methods({ GET: () => json({ id: 38, kind: "param" as const }) })),
  res39: methods({ GET: () => json({ id: 39, kind: "get" as const }) }),
  res40: methods({ GET: () => json({ id: 40 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res41: param("id", methods({ GET: () => json({ id: 41, kind: "param" as const }) })),
  res42: methods({ GET: () => json({ id: 42, kind: "get" as const }) }),
  res43: methods({ GET: () => json({ id: 43 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res44: param("id", methods({ GET: () => json({ id: 44, kind: "param" as const }) })),
  res45: methods({ GET: () => json({ id: 45, kind: "get" as const }) }),
  res46: methods({ GET: () => json({ id: 46 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res47: param("id", methods({ GET: () => json({ id: 47, kind: "param" as const }) })),
  res48: methods({ GET: () => json({ id: 48, kind: "get" as const }) }),
  res49: methods({ GET: () => json({ id: 49 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res50: param("id", methods({ GET: () => json({ id: 50, kind: "param" as const }) })),
  res51: methods({ GET: () => json({ id: 51, kind: "get" as const }) }),
  res52: methods({ GET: () => json({ id: 52 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res53: param("id", methods({ GET: () => json({ id: 53, kind: "param" as const }) })),
  res54: methods({ GET: () => json({ id: 54, kind: "get" as const }) }),
  res55: methods({ GET: () => json({ id: 55 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res56: param("id", methods({ GET: () => json({ id: 56, kind: "param" as const }) })),
  res57: methods({ GET: () => json({ id: 57, kind: "get" as const }) }),
  res58: methods({ GET: () => json({ id: 58 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res59: param("id", methods({ GET: () => json({ id: 59, kind: "param" as const }) })),
  res60: methods({ GET: () => json({ id: 60, kind: "get" as const }) }),
  res61: methods({ GET: () => json({ id: 61 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res62: param("id", methods({ GET: () => json({ id: 62, kind: "param" as const }) })),
  res63: methods({ GET: () => json({ id: 63, kind: "get" as const }) }),
  res64: methods({ GET: () => json({ id: 64 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res65: param("id", methods({ GET: () => json({ id: 65, kind: "param" as const }) })),
  res66: methods({ GET: () => json({ id: 66, kind: "get" as const }) }),
  res67: methods({ GET: () => json({ id: 67 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res68: param("id", methods({ GET: () => json({ id: 68, kind: "param" as const }) })),
  res69: methods({ GET: () => json({ id: 69, kind: "get" as const }) }),
  res70: methods({ GET: () => json({ id: 70 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res71: param("id", methods({ GET: () => json({ id: 71, kind: "param" as const }) })),
  res72: methods({ GET: () => json({ id: 72, kind: "get" as const }) }),
  res73: methods({ GET: () => json({ id: 73 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res74: param("id", methods({ GET: () => json({ id: 74, kind: "param" as const }) })),
  res75: methods({ GET: () => json({ id: 75, kind: "get" as const }) }),
  res76: methods({ GET: () => json({ id: 76 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res77: param("id", methods({ GET: () => json({ id: 77, kind: "param" as const }) })),
  res78: methods({ GET: () => json({ id: 78, kind: "get" as const }) }),
  res79: methods({ GET: () => json({ id: 79 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res80: param("id", methods({ GET: () => json({ id: 80, kind: "param" as const }) })),
  res81: methods({ GET: () => json({ id: 81, kind: "get" as const }) }),
  res82: methods({ GET: () => json({ id: 82 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res83: param("id", methods({ GET: () => json({ id: 83, kind: "param" as const }) })),
  res84: methods({ GET: () => json({ id: 84, kind: "get" as const }) }),
  res85: methods({ GET: () => json({ id: 85 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res86: param("id", methods({ GET: () => json({ id: 86, kind: "param" as const }) })),
  res87: methods({ GET: () => json({ id: 87, kind: "get" as const }) }),
  res88: methods({ GET: () => json({ id: 88 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res89: param("id", methods({ GET: () => json({ id: 89, kind: "param" as const }) })),
  res90: methods({ GET: () => json({ id: 90, kind: "get" as const }) }),
  res91: methods({ GET: () => json({ id: 91 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res92: param("id", methods({ GET: () => json({ id: 92, kind: "param" as const }) })),
  res93: methods({ GET: () => json({ id: 93, kind: "get" as const }) }),
  res94: methods({ GET: () => json({ id: 94 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res95: param("id", methods({ GET: () => json({ id: 95, kind: "param" as const }) })),
  res96: methods({ GET: () => json({ id: 96, kind: "get" as const }) }),
  res97: methods({ GET: () => json({ id: 97 }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),
  res98: param("id", methods({ GET: () => json({ id: 98, kind: "param" as const }) })),
  res99: methods({ GET: () => json({ id: 99, kind: "get" as const }) }),
});

export const api = client(app);
void api["/res0"].get().then((v) => v);
void api["/res14/{id}"].get({ params: { id: "1" } }).then((v) => v);
void api["/res28"].post({ body: { name: "x", qty: 1 } }).then((v) => v);
void api["/res42"].get().then((v) => v);
void api["/res56/{id}"].get({ params: { id: "1" } }).then((v) => v);
void api["/res70"].post({ body: { name: "x", qty: 1 } }).then((v) => v);
void api["/res84"].get().then((v) => v);
void api["/res99"].get().then((v) => v);
