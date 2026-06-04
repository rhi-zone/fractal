// spike/std/scale/generate.ts — emit std-model apps with N routes, deriving a
// typed client from FLAT `.meta`, for compile-cost measurement. Mirrors
// spike/scale's methodology (docs/design/scale.md) but for the std typed client
// (meta.ts + client.ts), to prove it scales ~linearly where the chained-builder
// baseline (variant A there) is quadratic and crashes stock tsc.
//
// Each app is one big `path({...})` of N resources. A deterministic mix:
//   - ~1/3 GET-only collections (typed return)
//   - ~1/3 GET + POST (POST carries a `validated(schema)` body → typed body)
//   - ~1/3 a `param("id", methods({GET}))` dynamic route (typed params)
// Patterns are unique per resource so the client keys distinctly. A handful of
// typed call-sites (params/body/return) across the span force the client type to
// instantiate at the start/middle/end of the route table — the same probe scheme
// spike/scale uses.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = join(import.meta.dir, "generated");

interface Res {
  readonly i: number;
  readonly kind: "get" | "getpost" | "param";
  readonly name: string;
}

function plan(n: number): Res[] {
  const out: Res[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 3 === 0 ? "get" : i % 3 === 1 ? "getpost" : "param";
    out.push({ i, kind, name: `res${i}` });
  }
  return out;
}

const HEADER = `// GENERATED — do not edit. std typed client at scale (see generate.ts).
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
`;

function emitApp(routes: Res[]): string {
  const lines: string[] = [HEADER];
  lines.push(`export const app = path({`);
  for (const r of routes) {
    if (r.kind === "get") {
      lines.push(
        `  ${r.name}: methods({ GET: () => json({ id: ${r.i}, kind: "get" as const }) }),`,
      );
    } else if (r.kind === "getpost") {
      lines.push(
        `  ${r.name}: methods({ GET: () => json({ id: ${r.i} }), POST: validated<typeof bodySchema, { ok: true; qty: number }>(bodySchema, (b) => json({ ok: true as const, qty: b.qty })) }),`,
      );
    } else {
      lines.push(
        `  ${r.name}: param("id", methods({ GET: () => json({ id: ${r.i}, kind: "param" as const }) })),`,
      );
    }
  }
  lines.push(`});`);
  lines.push(``);
  lines.push(`export const api = client(app);`);

  // typed call-site probes across the span (start/middle/end) force ClientOf to
  // instantiate keys throughout the table — the spike/scale probe scheme.
  const probes = sampleIndices(routes.length);
  for (const idx of probes) {
    const r = routes[idx]!;
    if (r.kind === "get") {
      lines.push(`void api["/${r.name}"].get().then((v) => v);`);
    } else if (r.kind === "getpost") {
      lines.push(
        `void api["/${r.name}"].post({ body: { name: "x", qty: 1 } }).then((v) => v);`,
      );
    } else {
      lines.push(
        `void api["/${r.name}/{id}"].get({ params: { id: "1" } }).then((v) => v);`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function sampleIndices(n: number): number[] {
  if (n <= 8) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let j = 0; j < 8; j++) out.push(Math.floor((j * (n - 1)) / 7));
  return [...new Set(out)];
}

const Ns = [10, 100, 300, 600, 900];

for (const n of Ns) {
  const file = join(OUT, `std-${n}.ts`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, emitApp(plan(n)));
}
console.log(`generated ${Ns.length} std-scale files into ${OUT}`);
