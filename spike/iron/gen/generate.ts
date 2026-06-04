// spike/iron/gen/generate.ts — emit N-route apps in the IRON handler-only model,
// using the SAME route plan as spike/scale + spike/composable (deterministic
// get/post/put mix, :id params, ~1-in-4 mutating routes with a validated body)
// so instantiation counts are directly comparable to the chained (A) and
// composable-with-struct (D) variants.
//
// Variant I — the iron model: `choice(route(method, path(lit, param), fn), ...)`
// where the ONLY type is Handler. `client(app)` is derived and typed call-site
// probes spread across the span force the Walk<M> mapped type to instantiate.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const OUT = join(import.meta.dir, "..", "generated")

type Verb = "get" | "post" | "put"
interface R {
  i: number
  verb: Verb
  resource: string
  hasParam: boolean
  hasBody: boolean
}

function plan(n: number): R[] {
  const out: R[] = []
  for (let i = 0; i < n; i++) {
    const verb: Verb = i % 3 === 0 ? "get" : i % 3 === 1 ? "post" : "put"
    out.push({
      i,
      verb,
      resource: `res${i}`,
      hasParam: i % 2 === 0,
      hasBody: verb !== "get" && i % 4 === 1,
    })
  }
  return out
}

const SCHEMA = `
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
`

function sampleIndices(n: number): number[] {
  if (n <= 8) return Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  for (let j = 0; j < 8; j++) out.push(Math.floor((j * (n - 1)) / 7))
  return [...new Set(out)]
}

// the structural path key the client uses: lit→/res, param→/{id}
function keyOf(r: R): string {
  return r.hasParam ? `/${r.resource}/{id}` : `/${r.resource}`
}

// Variant I — the iron model with a derived client + typed probes.
function variantI(routes: R[]): string {
  const L: string[] = []
  L.push(`import { choice, route, path, lit, param, json } from "../http.ts"`)
  L.push(`import { client } from "../client.ts"`)
  L.push(`import type { StandardSchema } from "@rhi-zone/fractal-core"`)
  L.push(SCHEMA)
  L.push(`const app = choice(`)
  for (const r of routes) {
    const pathExpr = r.hasParam
      ? `path(lit("${r.resource}"), param("id"))`
      : `path(lit("${r.resource}"))`
    if (r.hasBody) {
      L.push(
        `  route("${r.verb.toUpperCase()}", ${pathExpr}, bodySchema, ` +
          `async (ctx) => json({ id: ${r.i}, name: ctx.input.name, qty: ctx.input.qty })),`,
      )
    } else {
      const key = r.hasParam ? `ctx.params.id` : `"${r.resource}"`
      L.push(
        `  route("${r.verb.toUpperCase()}", ${pathExpr}, ` +
          `async (ctx) => json({ id: ${r.i}, key: ${key} })),`,
      )
    }
  }
  L.push(`)`)
  L.push(``)
  L.push(`const api = client(app)`)
  for (const idx of sampleIndices(routes.length)) {
    const r = routes[idx]!
    const args: string[] = []
    if (r.hasParam) args.push(`params: { id: "1" }`)
    if (r.hasBody) args.push(`body: { name: "x", qty: 1 }`)
    const argObj = args.length ? `{ ${args.join(", ")} }` : ``
    L.push(`const r${idx} = api["${keyOf(r)}"].${r.verb}(${argObj})`)
    L.push(`void r${idx}.then((v) => v)`)
  }
  return L.join("\n") + "\n"
}

// Variant J — per-route typing only (no client) — isolates per-route cost.
function variantJ(routes: R[]): string {
  const L: string[] = []
  L.push(`import { route, path, lit, param, json } from "../http.ts"`)
  L.push(`import type { StandardSchema } from "@rhi-zone/fractal-core"`)
  L.push(SCHEMA)
  const names: string[] = []
  for (const r of routes) {
    const pathExpr = r.hasParam
      ? `path(lit("${r.resource}"), param("id"))`
      : `path(lit("${r.resource}"))`
    const name = `h${r.i}`
    names.push(name)
    if (r.hasBody) {
      L.push(
        `const ${name} = route("${r.verb.toUpperCase()}", ${pathExpr}, bodySchema, ` +
          `async (ctx) => json({ id: ${r.i}, name: ctx.input.name, qty: ctx.input.qty }))`,
      )
    } else {
      const key = r.hasParam ? `ctx.params.id` : `"${r.resource}"`
      L.push(
        `const ${name} = route("${r.verb.toUpperCase()}", ${pathExpr}, ` +
          `async (ctx) => json({ id: ${r.i}, key: ${key} }))`,
      )
    }
  }
  L.push(``)
  L.push(`void [`)
  L.push(names.map((n) => `  ${n},`).join("\n"))
  L.push(`]`)
  return L.join("\n") + "\n"
}

const Ns = [10, 100, 300, 600, 900]

function emit(variant: string, n: number, src: string) {
  const file = join(OUT, `${variant}-${n}.ts`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, src)
}

for (const n of Ns) {
  const p = plan(n)
  emit("I", n, variantI(p))
  emit("J", n, variantJ(p))
}

console.log(`generated ${Ns.length * 2} iron files into ${OUT}`)
