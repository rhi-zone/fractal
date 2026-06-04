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
});

export const api = client(app);
void api["/res0"].get().then((v) => v);
void api["/res1"].post({ body: { name: "x", qty: 1 } }).then((v) => v);
void api["/res2/{id}"].get({ params: { id: "1" } }).then((v) => v);
void api["/res3"].get().then((v) => v);
void api["/res5/{id}"].get({ params: { id: "1" } }).then((v) => v);
void api["/res6"].get().then((v) => v);
void api["/res7"].post({ body: { name: "x", qty: 1 } }).then((v) => v);
void api["/res9"].get().then((v) => v);
