// @ts-expect-error negatives proving the typed client is non-degenerate: if
// the client were `any`, these calls would type-check and tsgo would report
// TS2578 "unused @ts-expect-error" — their silence is the proof.
//
// This file is typechecked as part of spike/iron/tsconfig.json. To confirm the
// negatives are load-bearing rather than vacuously passing, flip any one
// `@ts-expect-error` case into a real positive; the typecheck then fails with
// TS2578 "unused @ts-expect-error".

import { choice, route, path, lit, param, json } from "./http.ts";
import { client } from "./client.ts";
import type { StandardSchema } from "@rhi-zone/fractal-api-tree";

interface Body {
  readonly name: string;
}
const bodySchema: StandardSchema<unknown, Body> = {
  "~standard": { version: 1, validate: (v) => ({ value: v as Body }) },
};

const app = choice(
  route("GET", path(lit("users"), param("id")), async (ctx) =>
    json({ id: ctx.params.id, name: "x" }),
  ),
  route("POST", path(lit("users")), bodySchema, async (ctx) =>
    json({ ok: true, name: ctx.input.name }),
  ),
);
const c = client(app);

async function checks() {
  // positive: typed result
  const u = await c["/users/{id}"].get({ params: { id: "1" } });
  u.name satisfies string;

  // @ts-expect-error missing required params
  c["/users/{id}"].get();
  // @ts-expect-error wrong param key
  c["/users/{id}"].get({ params: { wrong: "1" } });

  const created = await c["/users"].post({ body: { name: "y" } });
  created.name satisfies string;
  // @ts-expect-error body required
  c["/users"].post();
  // @ts-expect-error wrong body shape
  c["/users"].post({ body: { nope: 1 } });

  // @ts-expect-error unknown route key
  c["/nope"].get();
}

// param codec refines the param type: param("id", numCodec) → {id:number}
const numCodec: StandardSchema<string, number> = {
  "~standard": { version: 1, validate: (s) => ({ value: Number(s) }) },
};
const c2 = client(
  choice(
    route("GET", path(lit("items"), param("id", numCodec)), async (ctx) => {
      ctx.params.id satisfies number; // refined by codec to number
      return json({ id: ctx.params.id });
    }),
  ),
);
async function codecChecks() {
  // @ts-expect-error param is now typed as number
  await c2["/items/{id}"].get({ params: { id: "1" } });
  await c2["/items/{id}"].get({ params: { id: 1 } });
}

void [checks, codecChecks];
