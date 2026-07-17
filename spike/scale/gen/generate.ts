// spike/scale/gen/generate.ts — emit fractal apps with N routes for compile-cost
// measurement. Four variants per N:
//
//   A  — current COUPLED router: chained builder accumulates the Routes tuple,
//        plus client(app) derivation + typed call-sites (forces ClientOf).
//   B  — PER-ROUTE typing only: same N handlers, each ctx.params/body/return
//        typed locally, but NO whole-app client / no consumption of the
//        accumulation tuple. Isolates per-route cost from accumulation cost.
//   C1 — DECOUPLED, contract-object: one object literal { "/p": { get: h } }
//        whose type is inferred once; a tRPC-style ClientOf maps the object.
//        No chained accumulation.
//   C2 — DECOUPLED, opt-in accumulation: routes are independent RouteSpec-shaped
//        consts; buildClient([...]) accumulates ONLY at that one call site.
//
// Routes are a deterministic mix of get/post/put with :id params and a few
// withValidation bodies. Patterns are unique per route so ClientOf keys distinctly.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const OUT = join(import.meta.dir, "..", "generated")

type Verb = "get" | "post" | "put"

interface Route {
  readonly i: number
  readonly verb: Verb
  readonly resource: string
  readonly hasParam: boolean
  readonly hasBody: boolean // post/put may carry a validated body
  readonly pattern: string
}

function plan(n: number): Route[] {
  const routes: Route[] = []
  for (let i = 0; i < n; i++) {
    const verb: Verb = i % 3 === 0 ? "get" : i % 3 === 1 ? "post" : "put"
    const resource = `res${i}`
    const hasParam = i % 2 === 0
    // ~1 in 4 mutating routes carry a validated body
    const hasBody = verb !== "get" && i % 4 === 1
    const pattern = hasParam ? `/${resource}/:id` : `/${resource}`
    routes.push({ i, verb, resource, hasParam, hasBody, pattern })
  }
  return routes
}

// A tiny inline Standard-Schema validator so withValidation has a real schema
// without pulling in zod (keeps the measurement about fractal, not zod).
const SCHEMA_HELPER = `
// Minimal Standard-Schema validator (no zod — isolate fractal's cost).
interface Body${"" /* keep generic name stable */} { readonly name: string; readonly qty: number }
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

// ---------------------------------------------------------------------------
// Variant A — coupled chained builder + client + typed call-sites
// ---------------------------------------------------------------------------
function variantA(routes: Route[]): string {
  const lines: string[] = []
  lines.push(`import { httpRouter, json, withValidation } from "@rhi-zone/fractal-http"`)
  lines.push(`import type { StandardSchema } from "@rhi-zone/fractal-api-tree"`)
  lines.push(`import { client } from "@rhi-zone/fractal-client"`)
  lines.push(SCHEMA_HELPER)
  lines.push(`const app = httpRouter()`)
  for (const r of routes) {
    if (r.hasBody) {
      // withValidation node → routeNode so __input/__output accumulate
      lines.push(
        `  .routeNode("${r.verb.toUpperCase()}", "${r.pattern}", withValidation(` +
          `async (b: Body) => json({ id: ${r.i}, name: b.name, qty: b.qty }), bodySchema))`,
      )
    } else {
      const paramExpr = r.hasParam ? `ctx.params.id` : `"${r.resource}"`
      lines.push(
        `  .${r.verb}("${r.pattern}", async (ctx) => json({ id: ${r.i}, key: ${paramExpr} }))`,
      )
    }
  }
  lines[lines.length - 1] += ""
  lines.push(``)
  lines.push(`const api = client(app)`)
  // A handful of typed call-sites across the route span so ClientOf instantiates
  // for keys at the start, middle, and end of the accumulation.
  const probes = sampleIndices(routes.length)
  for (const idx of probes) {
    const r = routes[idx]!
    const key = r.pattern
    const args: string[] = []
    if (r.hasParam) args.push(`params: { id: "1" }`)
    if (r.hasBody) args.push(`body: { name: "x", qty: 1 }`)
    const argObj = args.length ? `{ ${args.join(", ")} }` : ``
    lines.push(`const r${idx} = api["${key}"].${r.verb}(${argObj})`)
    // touch the awaited result so output inference is forced
    lines.push(`void r${idx}.then((v) => v)`)
  }
  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Variant B — per-route typing only, NO accumulation consumed
//
// We still register on the chained builder (so each handler's ctx.params / body
// / return is typed exactly as in A), but we NEVER read the Routes tuple: no
// client(app), no ClientOf, no RoutesOf. To make sure the accumulation tuple is
// not even retained on the final type, we annotate `app` to a Routes-erased
// HttpRouter shape so the huge tuple is discarded at the binding. This isolates
// the cost of typing N handlers from the cost of accumulating + mapping N specs.
// ---------------------------------------------------------------------------
function variantB(routes: Route[]): string {
  const lines: string[] = []
  lines.push(`import { json, withValidation } from "@rhi-zone/fractal-http"`)
  lines.push(`import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-api-tree"`)
  lines.push(SCHEMA_HELPER)
  // Each handler typed locally and standalone — no builder, no tuple at all.
  // This is the purest isolation of per-route typing cost.
  lines.push(`type Ctx<P extends string> = RoutingCtx & { params: PathParams<P> } & {`)
  lines.push(`  query: URLSearchParams; headers: Headers; body: () => Promise<unknown>; request: Request`)
  lines.push(`}`)
  for (const r of routes) {
    if (r.hasBody) {
      lines.push(
        `const h${r.i} = withValidation(async (b: Body) => json({ id: ${r.i}, name: b.name, qty: b.qty }), bodySchema)`,
      )
    } else {
      const paramExpr = r.hasParam ? `ctx.params.id` : `"${r.resource}"`
      lines.push(
        `const h${r.i} = async (ctx: Ctx<"${r.pattern}">) => json({ id: ${r.i}, key: ${paramExpr} })`,
      )
    }
  }
  // Touch every handler so each is type-checked (params/body/return inferred)
  // but NEVER feed them through the chained builder — so the accumulation tuple
  // is never formed. This is the pure per-route typing cost, no whole-app tuple.
  lines.push(``)
  lines.push(`void [`)
  lines.push(routes.map((r) => `  h${r.i},`).join("\n"))
  lines.push(`]`)
  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Variant C1 — decoupled CONTRACT OBJECT (tRPC-style). One object literal whose
// type is inferred once; a local ClientOf maps the object type. No chained
// accumulation, no growing tuple. Handlers are still per-route typed.
// ---------------------------------------------------------------------------
function variantC1(routes: Route[]): string {
  const lines: string[] = []
  lines.push(`import { json, withValidation } from "@rhi-zone/fractal-http"`)
  lines.push(`import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-api-tree"`)
  lines.push(`import type { ClientOfContract } from "../contract"`)
  lines.push(SCHEMA_HELPER)
  lines.push(`type Ctx<P extends string> = RoutingCtx & { params: PathParams<P> } & {`)
  lines.push(`  query: URLSearchParams; headers: Headers; body: () => Promise<unknown>; request: Request`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`const contract = {`)
  // group by pattern so each pattern key holds its methods
  const byPattern = new Map<string, Route[]>()
  for (const r of routes) {
    const arr = byPattern.get(r.pattern) ?? []
    arr.push(r)
    byPattern.set(r.pattern, arr)
  }
  for (const [pattern, rs] of byPattern) {
    lines.push(`  "${pattern}": {`)
    for (const r of rs) {
      if (r.hasBody) {
        lines.push(`    ${r.verb}: withValidation(async (b: Body) => json({ id: ${r.i}, name: b.name, qty: b.qty }), bodySchema),`)
      } else {
        const paramExpr = r.hasParam ? `ctx.params.id` : `"${r.resource}"`
        lines.push(`    ${r.verb}: async (ctx: Ctx<"${pattern}">) => json({ id: ${r.i}, key: ${paramExpr} }),`)
      }
    }
    lines.push(`  },`)
  }
  lines.push(`} as const`)
  lines.push(``)
  lines.push(`type Api = ClientOfContract<typeof contract>`)
  lines.push(`declare const api: Api`)
  const probes = sampleIndices(routes.length)
  for (const idx of probes) {
    const r = routes[idx]!
    const args: string[] = []
    if (r.hasParam) args.push(`params: { id: "1" }`)
    if (r.hasBody) args.push(`body: { name: "x", qty: 1 }`)
    const argObj = args.length ? `{ ${args.join(", ")} }` : ``
    lines.push(`const r${idx} = api["${r.pattern}"].${r.verb}(${argObj})`)
    lines.push(`void r${idx}.then((v) => v)`)
  }
  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Variant C2 — decoupled OPT-IN accumulation. Each route is an independent
// const of a RouteSpec-shaped descriptor; buildClient([...]) accumulates the
// tuple ONLY at that one call site (the router itself never threads a tuple).
// ---------------------------------------------------------------------------
function variantC2(routes: Route[]): string {
  const lines: string[] = []
  lines.push(`import { json, withValidation } from "@rhi-zone/fractal-http"`)
  lines.push(`import type { StandardSchema, RoutingCtx, PathParams } from "@rhi-zone/fractal-api-tree"`)
  lines.push(`import { buildClient, defineRoute } from "../contract"`)
  lines.push(SCHEMA_HELPER)
  lines.push(`type Ctx<P extends string> = RoutingCtx & { params: PathParams<P> } & {`)
  lines.push(`  query: URLSearchParams; headers: Headers; body: () => Promise<unknown>; request: Request`)
  lines.push(`}`)
  lines.push(``)
  const names: string[] = []
  for (const r of routes) {
    const name = `r${r.i}`
    names.push(name)
    if (r.hasBody) {
      lines.push(`const ${name} = defineRoute("${r.verb.toUpperCase()}", "${r.pattern}", withValidation(async (b: Body) => json({ id: ${r.i}, name: b.name, qty: b.qty }), bodySchema))`)
    } else {
      const paramExpr = r.hasParam ? `ctx.params.id` : `"${r.resource}"`
      lines.push(`const ${name} = defineRoute("${r.verb.toUpperCase()}", "${r.pattern}", async (ctx: Ctx<"${r.pattern}">) => json({ id: ${r.i}, key: ${paramExpr} }))`)
    }
  }
  lines.push(``)
  lines.push(`const api = buildClient([${names.join(", ")}])`)
  const probes = sampleIndices(routes.length)
  for (const idx of probes) {
    const r = routes[idx]!
    const args: string[] = []
    if (r.hasParam) args.push(`params: { id: "1" }`)
    if (r.hasBody) args.push(`body: { name: "x", qty: 1 }`)
    const argObj = args.length ? `{ ${args.join(", ")} }` : ``
    lines.push(`const probe${idx} = api["${r.pattern}"].${r.verb}(${argObj})`)
    lines.push(`void probe${idx}.then((v) => v)`)
  }
  return lines.join("\n") + "\n"
}

// Sample ~8 indices spread across the route span for typed call-site probes.
function sampleIndices(n: number): number[] {
  if (n <= 8) return Array.from({ length: n }, (_, i) => i)
  const k = 8
  const out: number[] = []
  for (let j = 0; j < k; j++) out.push(Math.floor((j * (n - 1)) / (k - 1)))
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------

const Ns = [10, 100, 300, 600, 900]

function emit(variant: string, n: number, src: string) {
  const file = join(OUT, `${variant}-${n}.ts`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, src)
}

for (const n of Ns) {
  const routes = plan(n)
  emit("A", n, variantA(routes))
  emit("B", n, variantB(routes))
  emit("C1", n, variantC1(routes))
  emit("C2", n, variantC2(routes))
}

console.log(`generated ${Ns.length * 4} files for N in [${Ns.join(", ")}] into ${OUT}`)
