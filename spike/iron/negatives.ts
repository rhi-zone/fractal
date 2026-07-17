// spike/iron/negatives.ts — @ts-expect-error negatives proving the typed client
// is non-degenerate. If the client were `any`, these would NOT error and tsgo
// would report TS2578 "unused @ts-expect-error". Their silence is the proof.
//
// A deliberate MUTATION at the bottom (commented) can be uncommented to flip a
// negative into a positive — it then SHOULD trigger TS2578, proving the
// negatives are load-bearing (run.ts exercises this).

import { choice, route, path, lit, param, json } from "./http.ts"
import { client } from "./client.ts"
import type { StandardSchema } from "@rhi-zone/fractal-api-tree"

interface Body {
  readonly name: string
}
const bodySchema: StandardSchema<unknown, Body> = {
  "~standard": { version: 1, validate: (v) => ({ value: v as Body }) },
}

const app = choice(
  route("GET", path(lit("users"), param("id")), async (ctx) => json({ id: ctx.params.id, name: "x" })),
  route("POST", path(lit("users")), bodySchema, async (ctx) => json({ ok: true, name: ctx.input.name })),
)
const c = client(app)

async function checks() {
  // positive: typed result
  const u = await c["/users/{id}"].get({ params: { id: "1" } })
  u.name satisfies string

  // @ts-expect-error missing required params
  c["/users/{id}"].get()
  // @ts-expect-error wrong param key
  c["/users/{id}"].get({ params: { wrong: "1" } })

  const created = await c["/users"].post({ body: { name: "y" } })
  created.name satisfies string
  // @ts-expect-error body required
  c["/users"].post()
  // @ts-expect-error wrong body shape
  c["/users"].post({ body: { nope: 1 } })

  // @ts-expect-error unknown route key
  c["/nope"].get()
}

// param codec refines the param type: param("id", numCodec) → {id:number}
const numCodec: StandardSchema<string, number> = {
  "~standard": { version: 1, validate: (s) => ({ value: Number(s) }) },
}
const c2 = client(
  choice(
    route("GET", path(lit("items"), param("id", numCodec)), async (ctx) => {
      ctx.params.id satisfies number // refined by codec, not string
      return json({ id: ctx.params.id })
    }),
  ),
)
async function codecChecks() {
  // @ts-expect-error param is number now, not string
  await c2["/items/{id}"].get({ params: { id: "1" } })
  await c2["/items/{id}"].get({ params: { id: 1 } })
}

void [checks, codecChecks]
