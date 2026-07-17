// spike/scale/correctness.ts — prove the derived clients are REAL (not `any`):
// positive call-sites type, and negative ones fail (@ts-expect-error fires).
// Covers A (coupled), C1 (contract object), C2 (opt-in). If any @ts-expect-error
// does NOT error, tsc reports TS2578 "Unused '@ts-expect-error'" → the client is
// degenerate and the measurement would be meaningless.

import { httpRouter, json, withValidation } from "@rhi-zone/fractal-http"
import type { StandardSchema } from "@rhi-zone/fractal-api-tree"
import { client } from "@rhi-zone/fractal-client"
import { buildClient, defineRoute, type ClientOfContract } from "./contract"

interface Body { readonly name: string; readonly qty: number }
const bodySchema: StandardSchema<unknown, Body> = {
  "~standard": { version: 1, validate: (v) => ({ value: v as Body }) },
}

// ---- A (coupled) ----------------------------------------------------------
const app = httpRouter()
  .get("/users/:id", async (ctx) => json({ id: ctx.params.id, name: "x" }))
  .post("/users", withValidation(async (b: Body) => json({ id: 1, ...b }), bodySchema) as never)
  .routeNode("POST", "/items", withValidation(async (b: Body) => json({ ok: true, qty: b.qty }), bodySchema))
const a = client(app)

async function aChecks() {
  const u = await a["/users/:id"].get({ params: { id: "1" } })
  u.name satisfies string
  // @ts-expect-error missing required params
  a["/users/:id"].get()
  // @ts-expect-error wrong param key
  a["/users/:id"].get({ params: { wrong: "1" } })
  const it = await a["/items"].post({ body: { name: "x", qty: 2 } })
  it.qty satisfies number
  // @ts-expect-error body required
  a["/items"].post()
  // @ts-expect-error unknown route key
  a["/nope"].get()
}

// ---- C1 (contract object) -------------------------------------------------
const contract = {
  "/users/:id": {
    get: async (ctx: { params: { id: string } }) => json({ id: ctx.params.id, name: "x" }),
  },
  "/items": {
    post: withValidation(async (b: Body) => json({ ok: true, qty: b.qty }), bodySchema),
  },
} as const
type C1 = ClientOfContract<typeof contract>
declare const c1: C1

async function c1Checks() {
  const u = await c1["/users/:id"].get({ params: { id: "1" } })
  u.name satisfies string
  // @ts-expect-error params required
  c1["/users/:id"].get()
  const it = await c1["/items"].post({ body: { name: "x", qty: 2 } })
  it.qty satisfies number
  // @ts-expect-error body required
  c1["/items"].post()
  // @ts-expect-error unknown route
  c1["/nope"].get()
}

// ---- C2 (opt-in accumulation) --------------------------------------------
const r0 = defineRoute("GET", "/users/:id", async (ctx: { params: { id: string } }) => json({ id: ctx.params.id, name: "x" }))
const r1 = defineRoute("POST", "/items", withValidation(async (b: Body) => json({ ok: true, qty: b.qty }), bodySchema))
const c2 = buildClient([r0, r1])

async function c2Checks() {
  const u = await c2["/users/:id"].get({ params: { id: "1" } })
  u.name satisfies string
  // @ts-expect-error params required
  c2["/users/:id"].get()
  const it = await c2["/items"].post({ body: { name: "x", qty: 2 } })
  it.qty satisfies number
  // @ts-expect-error unknown route
  c2["/nope"].get()
}

void [aChecks, c1Checks, c2Checks]
