// packages/graphql-api-projector/src/resolve.bench.ts — @rhi-zone/fractal-graphql-api-projector
//
// Performance benchmarks for the GraphQL projector's execution hot path.
// Mirrors http-api-projector's route.bench.ts in spirit (hand-rolled timer,
// no test-framework bench runner — see note below) but the shape is
// different: route.bench.ts COMPARES several route-matching architectures
// against the same route tree, whereas this projector has exactly one
// implementation of each stage, so this file measures that one
// implementation across several DIMENSIONS instead:
//
//   1. Schema build time      — createGraphQLServer over trees of 10/50/200 leaves
//   2. SDL generation         — toSDL (projectGraphQL + toSchema) alone, same tree sizes
//   3. Query execution        — server.execute: single field / nested namespace / with variables
//   4. Mutation execution     — server.execute: flat top-level mutation dispatch
//   5. Subscription setup     — server.subscribe: parse+validate+subscribe latency (no draining)
//   6. HTTP handler round-trip — presets.ts's fetch handler, full POST /graphql cycle
//   7. Resolver overhead      — resolve.ts's createResolver wrapper vs a bare graphql-js resolver
//
// Run: bun run packages/graphql-api-projector/src/resolve.bench.ts
//
// NOTE on tooling: the task that produced this file asked for `vitest bench`,
// matching route.bench.ts's assumed style. Checked first: this monorepo has
// no `vitest` devDependency anywhere (grepped every package.json + bun.lock)
// and `npx vitest` isn't resolvable in this environment. route.bench.ts
// itself doesn't use vitest either — it's a hand-rolled `performance.now()`
// timer executed directly via `bun run` (see its own header comment: "no
// Bun.bench... a small hand-rolled timer instead"). This file follows that
// same actually-established convention rather than the assumed one.

import { api, op } from "@rhi-zone/fractal-api-tree/node"
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { createGraphQLServer } from "./server.ts"
import type { GraphQLServer } from "./server.ts"
import { createHttpGraphQLServer } from "./presets.ts"
import { toSDL } from "./schema.ts"
import { createResolver } from "./resolve.ts"
import type { FieldResolver } from "./resolve.ts"
import type { Dispatch, FieldTypeMap } from "./project.ts"

// ============================================================================
// Timer harness — same hand-rolled approach as route.bench.ts (sync + a
// promise-aware variant, since GraphQL execution is async top to bottom).
// ============================================================================

function timeOnce(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.min(iterations, 200); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return performance.now() - start
}

async function timeAsync(fn: () => Promise<unknown>, iterations: number): Promise<number> {
  const warmup = Math.min(iterations, 200)
  for (let i = 0; i < warmup; i++) await fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) await fn()
  return performance.now() - start
}

function report(label: string, ms: number, iterations: number, unit = "us"): void {
  const perCall = unit === "us" ? (ms / iterations) * 1000 : ms / iterations
  console.log(
    `${label.padEnd(34)} ${perCall.toFixed(perCall < 1 ? 3 : 1).padStart(10)} ${unit}/call  (${iterations.toLocaleString()} calls, ${ms.toFixed(1)}ms total)`,
  )
}

// ============================================================================
// Tree fixtures — programmatic construction, mirroring how route.bench.ts
// builds its route tree from a generator rather than hand-listing it.
// ============================================================================

const GROUP_SIZE = 10

/**
 * Build a Node tree with `leafCount` leaves spread across
 * `ceil(leafCount / GROUP_SIZE)` namespace branches (10 leaves each) — the
 * "branches" dimension. Leaves are a mix of operation types (the "mixed
 * operation types" dimension): ~80% query (`tags.readOnly`), ~16% mutation
 * (default, no tags), ~4% subscription (`tags.streaming`). The whole tree
 * carries one root-level `fallback` subtree (the "fallbacks" dimension) —
 * a captured wildcard segment feeding one more query leaf.
 */
function buildLeafTree(leafCount: number): Node {
  const groups = Math.max(1, Math.ceil(leafCount / GROUP_SIZE))
  const namespaces: Record<string, Node> = {}
  let remaining = leafCount
  for (let g = 0; g < groups; g++) {
    const countHere = Math.min(GROUP_SIZE, remaining)
    remaining -= countHere
    const leaves: Record<string, Node> = {}
    for (let i = 0; i < countHere; i++) {
      const idx = g * GROUP_SIZE + i
      if (idx % 23 === 22) {
        leaves[`leaf${i}`] = op(
          // eslint-disable-next-line @typescript-eslint/require-await -- async generator, not an async fn; no await needed for a single sync yield
          async function* leafSubscription(_input: unknown) {
            yield { idx }
          },
          { tags: { streaming: true } },
        )
      } else if (idx % 5 === 4) {
        leaves[`leaf${i}`] = op((input: unknown) => ({ idx, input }))
      } else {
        leaves[`leaf${i}`] = op((input: unknown) => ({ idx, input }), { tags: { readOnly: true } })
      }
    }
    namespaces[`ns${g}`] = api(leaves)
  }
  const fallbackSubtree = api({
    resolve: op((input: { slug: string }) => ({ slug: input.slug }), { tags: { readOnly: true } }),
  })
  return api(namespaces, { fallback: { name: "slug", subtree: fallbackSubtree } })
}

const TREE_SIZES = [10, 50, 200] as const

/**
 * A single fixed, hand-shaped tree for the query/mutation/subscription/
 * round-trip/resolver-overhead benchmarks below — small and deterministic
 * enough to write concrete query strings against, but still exercising a
 * branch (users/admin), a fallback, and all three operation types.
 */
const hotPathTree = api(
  {
    ping: op((_: unknown) => "pong", { tags: { readOnly: true } }),
    users: api({
      get: op(
        (input: { id: string }) => ({ id: input.id, name: "Alice", email: `${input.id}@example.com` }),
        { tags: { readOnly: true } },
      ),
      admin: api({
        settings: op((_: unknown) => ({ theme: "dark" }), { tags: { readOnly: true } }),
      }),
    }),
    createUser: op((input: { name: string }) => ({ id: "1", name: input.name })),
    events: op(
      // eslint-disable-next-line @typescript-eslint/require-await -- async generator, not an async fn
      async function* events(_input: unknown) {
        yield { tick: 1 }
      },
      { tags: { streaming: true } },
    ),
  },
  {
    fallback: {
      name: "slug",
      subtree: api({
        resolveSlug: op((input: { slug: string }) => ({ slug: input.slug }), { tags: { readOnly: true } }),
      }),
    },
  },
)

const hotPathTypes: FieldTypeMap = {
  users_get: { input: t(types.object({ id: t(types.string) })), output: t(types.ref("User")) },
  createUser: { input: t(types.object({ name: t(types.string) })), output: t(types.ref("User")) },
}
const hotPathNamedTypes = {
  User: t(types.object({ id: t(types.string), name: t(types.string), email: t(types.string) }), { typeName: "User" }),
}

// ============================================================================
// 1. Schema build time — createGraphQLServer over trees of varying size
// ============================================================================

function benchSchemaBuild(): void {
  console.log("=== 1. Schema build (createGraphQLServer) ===\n")
  for (const size of TREE_SIZES) {
    const tree = buildLeafTree(size)
    const iterations = size <= 10 ? 300 : size <= 50 ? 100 : 30
    const ms = timeOnce(() => createGraphQLServer(tree), iterations)
    report(`${size} leaves`, ms, iterations)
  }
  console.log()
}

// ============================================================================
// 2. SDL generation — toSDL (projectGraphQL + toSchema) alone, isolated from
// buildSchema/resolver wiring (both of which schema build above includes).
// ============================================================================

function benchSdlGeneration(): void {
  console.log("=== 2. SDL generation (toSDL) ===\n")
  for (const size of TREE_SIZES) {
    const tree = buildLeafTree(size)
    const iterations = size <= 10 ? 1000 : size <= 50 ? 300 : 80
    const ms = timeOnce(() => toSDL(tree), iterations)
    report(`${size} leaves`, ms, iterations)
  }
  console.log()
}

// ============================================================================
// 3. Query execution — server.execute (parse + validate + execute), three
// shapes: single field, nested namespace, with variables.
// ============================================================================

const queryCases: readonly { readonly name: string; readonly query: string; readonly variables?: Record<string, unknown> }[] = [
  { name: "single field", query: `{ ping }` },
  { name: "nested namespace", query: `{ users { admin { settings } } }` },
  {
    name: "with variables",
    query: `query($id: ID!) { users { get(id: $id) { id name email } } }`,
    variables: { id: "42" },
  },
]

async function benchQueryExecution(server: GraphQLServer): Promise<void> {
  console.log("=== 3. Query execution (server.execute) ===\n")
  const ITERATIONS = 3000
  for (const kase of queryCases) {
    const ms = await timeAsync(() => server.execute(kase.query, kase.variables), ITERATIONS)
    report(kase.name, ms, ITERATIONS)
  }
  console.log()
}

// ============================================================================
// 4. Mutation execution — flat top-level mutation field dispatch
// ============================================================================

async function benchMutationExecution(server: GraphQLServer): Promise<void> {
  console.log("=== 4. Mutation execution (server.execute) ===\n")
  const ITERATIONS = 3000
  const ms = await timeAsync(
    () => server.execute(`mutation { createUser(name: "Bob") { id name } }`),
    ITERATIONS,
  )
  report("flat mutation", ms, ITERATIONS)
  console.log()
}

// ============================================================================
// 5. Subscription setup — server.subscribe latency (parse + validate +
// subscribe field's own `subscribe` resolver returning the async iterable,
// WITHOUT draining any events off it — that's the one-time setup cost a
// transport pays per new subscription connection).
// ============================================================================

async function benchSubscriptionSetup(server: GraphQLServer): Promise<void> {
  console.log("=== 5. Subscription setup (server.subscribe) ===\n")
  const ITERATIONS = 3000
  const ms = await timeAsync(() => server.subscribe(`subscription { events }`), ITERATIONS)
  report("subscribe() setup", ms, ITERATIONS)
  console.log()
}

// ============================================================================
// 6. HTTP handler round-trip — presets.ts's createHttpGraphQLServer fetch
// handler, full POST /graphql cycle: JSON body parse -> execute -> JSON
// response serialize.
// ============================================================================

async function benchHttpRoundTrip(): Promise<void> {
  console.log("=== 6. HTTP handler round-trip (POST /graphql) ===\n")
  const handler = createHttpGraphQLServer(hotPathTree, { types: hotPathTypes, namedTypes: hotPathNamedTypes })
  const ITERATIONS = 2000
  const bodyText = JSON.stringify({ query: `{ users { get(id: "42") { id name email } } }` })
  const makeRequest = () =>
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyText,
    })
  const ms = await timeAsync(async () => {
    const res = await handler(makeRequest())
    await res.text()
  }, ITERATIONS)
  report("POST /graphql (nested + args)", ms, ITERATIONS)
  console.log()
}

// ============================================================================
// 7. Resolver overhead — resolve.ts's createResolver wrapper (input
// assembly via assemble(), Result-shape detection, middleware composition
// point) vs. a bare graphql-js-style resolver calling the same handler
// directly. Isolates the wrapper's own cost from graphql-js's execution
// engine (which both share equally, so it cancels out).
// ============================================================================

async function benchResolverOverhead(): Promise<void> {
  console.log("=== 7. Resolver overhead — wrapped vs raw ===\n")
  const rawHandler: Handler<{ id: string }, { id: string; name: string }> = (input) => ({ id: input.id, name: "Alice" })
  const dispatch: Dispatch = {
    handler: rawHandler as Handler,
    inputNames: ["id"],
    sourceMap: {},
    operationType: "query",
    meta: {},
  }
  const wrapped = createResolver(dispatch) as FieldResolver
  const rawResolver: FieldResolver = async (_parent, args) => rawHandler(args as { id: string })

  const ITERATIONS = 20_000
  const args = { id: "42" }
  const wrappedMs = await timeAsync(() => wrapped(undefined, args, undefined, undefined), ITERATIONS)
  const rawMs = await timeAsync(() => rawResolver(undefined, args, undefined, undefined), ITERATIONS)
  report("wrapped (createResolver)", wrappedMs, ITERATIONS)
  report("raw graphql-js-style", rawMs, ITERATIONS)
  const wrappedUs = (wrappedMs / ITERATIONS) * 1000
  const rawUs = (rawMs / ITERATIONS) * 1000
  console.log(
    `${"overhead".padEnd(34)} ${(wrappedUs - rawUs).toFixed(3).padStart(10)} us/call  (${(wrappedUs / rawUs).toFixed(2)}x raw)`,
  )
  console.log()
}

// ============================================================================
// Run
// ============================================================================

async function main(): Promise<void> {
  const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
  console.log(`=== graphql-api-projector benchmarks (${runtime}) ===\n`)

  benchSchemaBuild()
  benchSdlGeneration()

  const hotPathServer = createGraphQLServer(hotPathTree, { types: hotPathTypes, namedTypes: hotPathNamedTypes })
  await benchQueryExecution(hotPathServer)
  await benchMutationExecution(hotPathServer)
  await benchSubscriptionSetup(hotPathServer)
  await benchHttpRoundTrip()
  await benchResolverOverhead()

  console.log("=== Notes ===")
  console.log("- Query/mutation/subscription numbers include graphql-js's own parse+validate")
  console.log("  cost (server.execute/server.subscribe re-parse the document every call, matching")
  console.log("  a real per-request transport that doesn't cache parsed documents).")
  console.log("- HTTP round-trip additionally includes Request/Response construction and JSON")
  console.log("  (de)serialization on top of the same execute() call query execution measures.")
  console.log("- Resolver overhead isolates resolve.ts's createResolver wrapper (assemble() input")
  console.log("  assembly + Result-shape detection) from graphql-js's execution engine, which both")
  console.log("  the wrapped and raw resolver skip entirely here (called directly, not through")
  console.log("  execute()) — see benchQueryExecution above for the wrapper's cost IN CONTEXT.")
}

await main()
