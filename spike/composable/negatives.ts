// spike/composable/negatives.ts — @ts-expect-error negatives. If the typed
// client were degenerate (`any`), these would NOT error and tsgo would report
// TS2578 "unused @ts-expect-error". Their silence is the proof the client types.

import { lit, param, path, route, routes } from "./router"
import { json } from "./http"
import { client } from "./client"
import type { StandardSchema } from "@rhi-zone/fractal-core"

interface Body {
  readonly name: string
}
const bodySchema: StandardSchema<unknown, Body> = {
  "~standard": { version: 1, validate: (v) => ({ value: v as Body }) },
}

const getUser = route("GET", path(lit("users"), param("id")), async (ctx) =>
  json({ id: ctx.params.id, name: "x" }),
)
const createUser = route("POST", path(lit("users")), bodySchema, async (ctx) =>
  json({ ok: true, name: ctx.body.name }),
)
const api = routes(getUser, createUser)
const c = client(api)

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
const getById = route("GET", path(lit("items"), param("id", numCodec)), async (ctx) => {
  ctx.params.id satisfies number // refined by codec, not string
  return json({ id: ctx.params.id })
})
const c2 = client(routes(getById))
async function codecChecks() {
  // @ts-expect-error param is number now, not string
  await c2["/items/{id}"].get({ params: { id: "1" } })
  await c2["/items/{id}"].get({ params: { id: 1 } })
}

void [checks, codecChecks]
