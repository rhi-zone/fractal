// packages/http-api-projector/src/route.bench.ts — @rhi-zone/fractal-http-api-projector
//
// Benchmark: compare route-matching architectures on the same route tree.
//
//   1. Segment trie (current)   — route.ts's actual matching algorithm
//   2. Full-path Map            — Map<"METHOD pathname", handler>, exact match only
//   3. Single regex per method  — one alternation regex, one .exec() per request
//   4. Compiled switch function — new Function()-generated nested switch, depth-specialized
//   5. Character-level radix trie — walk raw chars, no split, no per-segment allocation
//   6. Flat DFA transition table  — Uint32Array table[state*128+charCode] -> next state
//   7. Compiled char-level function — new Function()-generated nested if/else on charCodeAt(i)
//
// Run: bun run packages/http-api-projector/src/route.bench.ts
//
// NOTE on fidelity: route.ts's own `splitPath`/`matchRoute` are NOT exported
// (they're private to the module — see route.ts:687,747). This file does not
// modify route.ts (hard constraint), so architecture (1) below is a verbatim
// port of that private algorithm, re-declared locally, rather than an import.
// `httpRoute`/`HttpRoute` (the public tree constructor + type) ARE imported
// from route.ts and used to build the real tree architecture (1) walks, so
// the *tree* under test is the real production shape even though the *walk*
// function is a local copy of the private one.
// ============================================================================

import { httpRoute, type HttpRoute } from "./route.ts"
import type { Handler } from "@rhi-zone/fractal-api-tree/node"
import os from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ============================================================================
// Route table — the fixture every architecture compiles from
// ============================================================================

type RouteDef = { readonly method: string; readonly path: string; readonly name: string }

// ~32 static routes (depths 1-4), ~15 dynamic routes (1-2 params), a few deep
// (5+ segments) routes, mixed GET/POST/PUT/DELETE.
const baseRouteDefs: readonly RouteDef[] = [
  // static
  { method: "GET", path: "/", name: "root" },
  { method: "GET", path: "/users", name: "listUsers" },
  { method: "POST", path: "/users", name: "createUser" },
  { method: "GET", path: "/books", name: "listBooks" },
  { method: "POST", path: "/books", name: "createBook" },
  { method: "GET", path: "/api/v1/health", name: "health" },
  { method: "GET", path: "/api/v1/status", name: "status" },
  { method: "GET", path: "/api/v1/version", name: "version" },
  { method: "GET", path: "/static/about", name: "about" },
  { method: "GET", path: "/static/contact", name: "contact" },
  { method: "GET", path: "/static/docs/getting-started", name: "gettingStarted" },
  { method: "GET", path: "/static/docs/api-reference", name: "apiReference" },
  { method: "GET", path: "/static/docs/guides/quickstart", name: "quickstart" },
  { method: "GET", path: "/static/docs/guides/advanced", name: "advanced" },
  { method: "GET", path: "/static/docs/guides/faq", name: "faq" },
  { method: "GET", path: "/admin", name: "admin" },
  { method: "GET", path: "/admin/dashboard", name: "adminDashboard" },
  { method: "GET", path: "/admin/settings", name: "adminSettings" },
  { method: "GET", path: "/admin/users", name: "adminUsers" },
  { method: "GET", path: "/admin/logs", name: "adminLogs" },
  { method: "GET", path: "/login", name: "loginPage" },
  { method: "POST", path: "/login", name: "login" },
  { method: "POST", path: "/logout", name: "logout" },
  { method: "GET", path: "/signup", name: "signupPage" },
  { method: "POST", path: "/signup", name: "signup" },
  { method: "GET", path: "/health", name: "rootHealth" },
  { method: "GET", path: "/about", name: "rootAbout" },
  { method: "GET", path: "/contact", name: "rootContact" },
  { method: "GET", path: "/terms", name: "terms" },
  { method: "GET", path: "/privacy", name: "privacy" },
  { method: "GET", path: "/favicon.ico", name: "favicon" },
  { method: "GET", path: "/robots.txt", name: "robots" },

  // dynamic (1-2 params)
  { method: "GET", path: "/users/:id", name: "getUser" },
  { method: "PUT", path: "/users/:id", name: "updateUser" },
  { method: "DELETE", path: "/users/:id", name: "deleteUser" },
  { method: "GET", path: "/users/:id/profile", name: "userProfile" },
  { method: "GET", path: "/users/:id/settings", name: "userSettings" },
  { method: "GET", path: "/users/:id/posts", name: "userPosts" },
  { method: "GET", path: "/users/:id/posts/:postId", name: "userPost" },
  { method: "GET", path: "/books/:id", name: "getBook" },
  { method: "PUT", path: "/books/:id", name: "updateBook" },
  { method: "DELETE", path: "/books/:id", name: "deleteBook" },
  { method: "GET", path: "/books/:id/reviews", name: "bookReviews" },
  { method: "POST", path: "/books/:id/reviews", name: "createBookReview" },
  { method: "GET", path: "/books/:bookId/reviews/:reviewId", name: "bookReview" },
  { method: "GET", path: "/orgs/:orgId/teams/:teamId", name: "orgTeam" },
  { method: "GET", path: "/orgs/:orgId/teams/:teamId/members", name: "orgTeamMembers" },

  // deep (5+ segments)
  { method: "GET", path: "/static/docs/guides/advanced/topics/performance", name: "perfTopic" },
  { method: "GET", path: "/admin/settings/security/audit/logs", name: "auditLogs" },
  { method: "GET", path: "/api/v1/orgs/:orgId/teams/:teamId/members/:memberId", name: "orgTeamMember" },
]

// ============================================================================
// Long-path routes — /a/bb/ccc/dddd/eeeee/... segments of increasing length
// (letter cycling a-z), built up until the pathname reaches the target char
// count. One static route and one dynamic route (fallback param on the last
// segment) per target length: ~200, ~1k, ~2k, ~4k, ~8k chars.
// ============================================================================

/** Segments of increasing length ("a", "bb", "ccc", ...) until the joined `/`-path reaches `targetLen` chars. */
function buildDeepSegments(targetLen: number): string[] {
  const segs: string[] = []
  let len = 0
  let n = 1
  while (len < targetLen) {
    const ch = String.fromCharCode(97 + (segs.length % 26)) // 'a'..'z', cycling
    const seg = ch.repeat(n)
    segs.push(seg)
    len += seg.length + 1 // +1 for the leading "/"
    n++
  }
  return segs
}

const LONG_PATH_TARGETS: readonly { readonly label: string; readonly chars: number }[] = [
  { label: "200", chars: 200 },
  { label: "1k", chars: 1000 },
  { label: "2k", chars: 2000 },
  { label: "4k", chars: 4000 },
  { label: "8k", chars: 8000 },
]

type LongPathFixture = {
  readonly label: string
  readonly staticPath: string
  readonly dynamicPath: string // last segment replaced with ":id"
  readonly dynamicConcretePath: string // ":id" replaced back with a concrete value, for dispatch tests
  readonly dynamicConcreteValue: string
}

const longPathFixtures: readonly LongPathFixture[] = LONG_PATH_TARGETS.map(({ label, chars }) => {
  const segs = buildDeepSegments(chars)
  const staticPath = `/${segs.join("/")}`
  const lastLen = segs[segs.length - 1]!.length
  const dynamicConcreteValue = "9".repeat(lastLen) // same length as the segment it replaces, for a comparable path length
  const dynamicSegs = [...segs.slice(0, -1), ":id"]
  const dynamicConcreteSegs = [...segs.slice(0, -1), dynamicConcreteValue]
  return {
    label,
    staticPath,
    dynamicPath: `/${dynamicSegs.join("/")}`,
    dynamicConcretePath: `/${dynamicConcreteSegs.join("/")}`,
    dynamicConcreteValue,
  }
})

const longRouteDefs: readonly RouteDef[] = longPathFixtures.flatMap((f) => [
  { method: "GET", path: f.staticPath, name: `long${f.label}Static` },
  { method: "GET", path: f.dynamicPath, name: `long${f.label}Dynamic` },
])

// ============================================================================
// Pathological cases — each stresses a different dimension than the base
// tree above (which is a realistic ~47-route app). All are additive: they
// enlarge the SAME tree every architecture builds, so a regression in one
// architecture's handling of (say) wide branching shows up as a bad number
// in that architecture's column for that dispatch case, not as a separate
// benchmark run.
// ============================================================================

// --- Case A: wide branching — one node (/api/v1/*) with 120 static
// siblings, to stress hash lookups (Map/segment trie) vs regex alternation
// vs switch/trie branching at a single level.
const WIDE_BRANCH_COUNT = 120
const wideBranchDefs: readonly RouteDef[] = Array.from({ length: WIDE_BRANCH_COUNT }, (_, i) => ({
  method: "GET",
  path: `/api/v1/resource${String(i).padStart(3, "0")}`,
  name: `wideResource${i}`,
}))

// --- Case B: deep narrow tree — 25 levels, one child each, short segments.
// Stresses per-level overhead: segment trie pays splitPath + N lookups,
// compiled fn pays N startsWith/switch checks, char-level architectures pay
// N traversal steps regardless of segment count.
const DEEP_NARROW_LEVELS = 24 // + the "deep" root segment = 25 levels total
const deepNarrowSegs = Array.from({ length: DEEP_NARROW_LEVELS }, (_, i) => String.fromCharCode(97 + (i % 26)))
const deepNarrowPath = `/deep/${deepNarrowSegs.join("/")}`
const deepNarrowDef: RouteDef = { method: "GET", path: deepNarrowPath, name: "deepNarrow" }

// --- Case C: many dynamic segments — 4 `:param` captures in one path.
// Tests param-extraction overhead (object writes, capture groups, etc.)
// across architectures, independent of tree size/shape.
const manyDynamicPath = "/orgs/:orgId/teams/:teamId/members/:memberId/roles/:roleId"
const manyDynamicDef: RouteDef = { method: "GET", path: manyDynamicPath, name: "orgTeamMemberRole" }
const manyDynamicConcretePath = "/orgs/o1/teams/t1/members/m1/roles/r1"

// --- Case D: large tree + long paths combined — 200+ routes (mix of
// static and dynamic) plus a couple of 4k+ char paths woven into that same
// mixed set, so the "large tree" and "long path" dimensions compound rather
// than being tested in isolation.
const BULK_STATIC_COUNT = 150
const bulkStaticDefs: readonly RouteDef[] = Array.from({ length: BULK_STATIC_COUNT }, (_, i) => ({
  method: "GET",
  path: `/bulk/item${String(i).padStart(3, "0")}`,
  name: `bulkStatic${i}`,
}))

const BULK_DYN_COUNT = 50
const bulkDynDefs: readonly RouteDef[] = Array.from({ length: BULK_DYN_COUNT }, (_, i) => ({
  method: "GET",
  path: `/bulk/dyn/${String(i).padStart(3, "0")}/:id`,
  name: `bulkDyn${i}`,
}))

const bulkLongSegs = buildDeepSegments(4500)
const bulkLongStaticPath = `/bulk/long/${bulkLongSegs.join("/")}`
const bulkLongDynSegs = [...bulkLongSegs.slice(0, -1), ":id"]
const bulkLongDynPath = `/bulk/long/${bulkLongDynSegs.join("/")}`
const bulkLongDynValue = "z".repeat(bulkLongSegs[bulkLongSegs.length - 1]!.length)
const bulkLongDynConcretePath = `/bulk/long/${[...bulkLongSegs.slice(0, -1), bulkLongDynValue].join("/")}`

const bulkLongDefs: readonly RouteDef[] = [
  { method: "GET", path: bulkLongStaticPath, name: "bulkLongStatic" },
  { method: "GET", path: bulkLongDynPath, name: "bulkLongDynamic" },
]

// --- Case E: unbalanced tree — one very deep branch (18 levels) hanging
// off the same parent as 60 shallow (2-level) siblings, to test whether an
// architecture optimized for one shape degrades on the other living right
// next to it.
const UNEVEN_DEEP_LEVELS = 16 // + "uneven"/"deep" prefix = 18 levels total
const unevenDeepSegs = Array.from({ length: UNEVEN_DEEP_LEVELS }, (_, i) => String.fromCharCode(97 + (i % 26)))
const unevenDeepPath = `/uneven/deep/${unevenDeepSegs.join("/")}`
const unevenDeepDef: RouteDef = { method: "GET", path: unevenDeepPath, name: "unevenDeep" }

const UNEVEN_SHALLOW_COUNT = 60
const unevenShallowDefs: readonly RouteDef[] = Array.from({ length: UNEVEN_SHALLOW_COUNT }, (_, i) => ({
  method: "GET",
  path: `/uneven/shallow${String(i).padStart(3, "0")}`,
  name: `unevenShallow${i}`,
}))

// --- Case F: nesting + branching combined — a tree that branches at THREE
// successive depths (10 x 10 x 5 = 500 leaves), unlike Case A (branches once,
// at one depth) or Case B (never branches, just deep). Forces the dispatcher
// to re-resolve a branch point repeatedly as it descends, not just once.
const GRID_L1 = 10
const GRID_L2 = 10
const GRID_L3 = 5
const gridDefs: RouteDef[] = []
for (let a = 0; a < GRID_L1; a++) {
  for (let b = 0; b < GRID_L2; b++) {
    for (let c = 0; c < GRID_L3; c++) {
      gridDefs.push({ method: "GET", path: `/grid/l1-${a}/l2-${b}/l3-${c}`, name: `grid_${a}_${b}_${c}` })
    }
  }
}
const gridEarlyPath = gridDefs[0]!.path
const gridMiddlePath = gridDefs[Math.floor(gridDefs.length / 2)]!.path
const gridLatePath = gridDefs[gridDefs.length - 1]!.path

// --- Case G: nesting + branching + long paths, all three at once — same
// three-deep branching shape as Case F (4 x 4 x 3 = 48 leaves) but each
// segment is ~1400 chars, so every leaf path is 4k+ chars. Stresses whatever
// architectures degrade separately on branching (A) and on long paths (long
// fixtures) simultaneously, in combination rather than in isolation.
const LONG_GRID_L1 = 4
const LONG_GRID_L2 = 4
const LONG_GRID_L3 = 3
const LONG_GRID_SEG_LEN = 1400
function longGridSeg(prefix: string, i: number): string {
  const idx = String(i)
  return `${prefix}${idx}${"x".repeat(Math.max(0, LONG_GRID_SEG_LEN - prefix.length - idx.length))}`
}
const longGridDefs: RouteDef[] = []
for (let a = 0; a < LONG_GRID_L1; a++) {
  for (let b = 0; b < LONG_GRID_L2; b++) {
    for (let c = 0; c < LONG_GRID_L3; c++) {
      const path = `/longgrid/${longGridSeg("a", a)}/${longGridSeg("b", b)}/${longGridSeg("c", c)}`
      longGridDefs.push({ method: "GET", path, name: `longGrid_${a}_${b}_${c}` })
    }
  }
}
const longGridEarlyPath = longGridDefs[0]!.path
const longGridLatePath = longGridDefs[longGridDefs.length - 1]!.path

const routeDefs: readonly RouteDef[] = [
  ...baseRouteDefs,
  ...longRouteDefs,
  ...wideBranchDefs,
  deepNarrowDef,
  manyDynamicDef,
  ...bulkStaticDefs,
  ...bulkDynDefs,
  ...bulkLongDefs,
  unevenDeepDef,
  ...unevenShallowDefs,
  ...gridDefs,
  ...longGridDefs,
]

/** One shared stub handler body — identical across all routes and architectures. */
function makeHandler(name: string): Handler {
  return (input: unknown) => ({ name, input })
}

const handlersByName = new Map<string, Handler>(routeDefs.map((r) => [r.name, makeHandler(r.name)]))

function splitSegs(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0)
}

/** Generated-source size for the two `new Function()`-codegen architectures (4, 7) —
 *  populated by buildCompiledSwitch/buildCompiledCharFn at module-load time, when
 *  the "production" (full routeDefs) instance of each is built. Not applicable to
 *  the other five architectures, which don't generate source text. */
const codegenSizes: Record<string, { readonly chars: number; readonly bytes: number }> = {}

// ============================================================================
// 1. Segment trie (current) — HttpRoute tree + a local verbatim port of
// route.ts's private splitPath/matchRoute (see file-header note).
// ============================================================================

function buildHttpRouteTree(routes: readonly RouteDef[]): HttpRoute {
  type Mutable = {
    methods: Record<string, { handler: Handler; meta: Record<string, never> }>
    children: Map<string, Mutable>
    fallback?: { name: string; node: Mutable }
  }
  const makeNode = (): Mutable => ({ methods: {}, children: new Map() })
  const root = makeNode()

  for (const route of routes) {
    let node = root
    for (const seg of splitSegs(route.path)) {
      if (seg.startsWith(":")) {
        const name = seg.slice(1)
        if (node.fallback === undefined) node.fallback = { name, node: makeNode() }
        node = node.fallback.node
      } else {
        let child = node.children.get(seg)
        if (child === undefined) {
          child = makeNode()
          node.children.set(seg, child)
        }
        node = child
      }
    }
    node.methods[route.method] = { handler: handlersByName.get(route.name)!, meta: {} }
  }

  const toHttpRoute = (node: Mutable): HttpRoute =>
    httpRoute({
      methods: Object.keys(node.methods).length > 0 ? node.methods : undefined,
      children: node.children.size > 0
        ? Object.fromEntries([...node.children].map(([k, c]) => [k, toHttpRoute(c)]))
        : undefined,
      fallback: node.fallback !== undefined
        ? { name: node.fallback.name, subtree: toHttpRoute(node.fallback.node) }
        : undefined,
      meta: {},
    })

  return toHttpRoute(root)
}

/** Verbatim port of route.ts's private `splitPath` (route.ts:687). */
function splitPath(pathname: string): string[] {
  const segs: string[] = []
  let start = 0
  for (let i = 0; i <= pathname.length; i++) {
    if (i === pathname.length || pathname.charCodeAt(i) === 47 /* "/" */) {
      if (i > start) segs.push(pathname.slice(start, i))
      start = i + 1
    }
  }
  return segs
}

/** Verbatim port of route.ts's private `matchRoute` (route.ts:747). */
function matchRoute(
  route: HttpRoute,
  segs: readonly string[],
  idx: number,
  method: string,
  slugs: Record<string, string>,
): { handler: Handler; slugs: Record<string, string> } | undefined {
  if (idx === segs.length) {
    const entry = route.methods?.[method]
    if (entry === undefined) return undefined
    return { handler: entry.handler, slugs }
  }
  const seg = segs[idx]!
  const child = route.children?.[seg]
  if (child !== undefined) {
    return matchRoute(child, segs, idx + 1, method, slugs)
  }
  if (route.fallback !== undefined) {
    slugs[route.fallback.name] = seg
    return matchRoute(route.fallback.subtree, segs, idx + 1, method, slugs)
  }
  return undefined
}

const trieTree = buildHttpRouteTree(routeDefs)

function trieDispatch(pathname: string, method: string): { handler: Handler; slugs: Record<string, string> } | undefined {
  const segs = splitPath(pathname)
  return matchRoute(trieTree, segs, 0, method, {})
}

// ============================================================================
// 2. Full-path Map — Map<"METHOD pathname", handler>. Static routes go in
// verbatim; dynamic routes are expanded with concrete values so the dispatch
// benchmark's dynamic-hit case has an entry to find. This is the "ceiling"
// case — a map lookup is as fast as matching gets, but only handles routes
// whose exact concrete path is known ahead of time.
// ============================================================================

const fullPathMap = new Map<string, { handler: Handler; slugs: Record<string, string> }>()

// Concrete values used to expand dynamic routes into the map, and to build
// the "dynamic hit" dispatch test path shared across all five architectures.
const EXPANSIONS: Record<string, Record<string, string>> = {
  "/users/:id": { id: "42" },
  "/users/:id/profile": { id: "42" },
  ...Object.fromEntries(longPathFixtures.map((f) => [f.dynamicPath, { id: f.dynamicConcreteValue }])),
  [manyDynamicPath]: { orgId: "o1", teamId: "t1", memberId: "m1", roleId: "r1" },
  "/bulk/dyn/025/:id": { id: "xyz123" },
  [bulkLongDynPath]: { id: bulkLongDynValue },
}

for (const route of routeDefs) {
  const segs = splitSegs(route.path)
  const hasParam = segs.some((s) => s.startsWith(":"))
  if (!hasParam) {
    fullPathMap.set(`${route.method} /${segs.join("/")}`, { handler: handlersByName.get(route.name)!, slugs: {} })
    continue
  }
  const values = EXPANSIONS[route.path]
  if (values === undefined) continue // not expanded — full-path map can't serve this route at all
  const concreteSegs = segs.map((s) => (s.startsWith(":") ? values[s.slice(1)]! : s))
  fullPathMap.set(`${route.method} /${concreteSegs.join("/")}`, {
    handler: handlersByName.get(route.name)!,
    slugs: values,
  })
}

function fullPathMapDispatch(pathname: string, method: string) {
  return fullPathMap.get(`${method} ${pathname}`)
}

// ============================================================================
// 3. Single regex per method — one alternation regex per HTTP method. Each
// route becomes `(litpart(capture)litpart...)` — an OUTER capture group
// wrapping the whole route (to identify which alternative matched) plus one
// INNER capture group per param (to extract slug values).
// ============================================================================

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

type RegexRouteMeta = { readonly outerGroup: number; readonly paramGroups: readonly { name: string; group: number }[]; readonly handler: Handler }

function buildMethodRegex(routes: readonly RouteDef[]): { regex: RegExp; routeMetas: readonly RegexRouteMeta[] } {
  const routeMetas: RegexRouteMeta[] = []
  let groupCounter = 0 // group 0 is the whole match; first custom group is 1
  const alternatives = routes.map((route) => {
    const segs = splitSegs(route.path)
    // Group numbers are assigned left-to-right by OPENING paren position in
    // the final regex text — the outer group's "(" appears before any inner
    // param group's "(" (the alternative is literally `(\/inner)`), so the
    // outer group's number must be claimed first, not last.
    const outerGroup = ++groupCounter
    const paramGroups: { name: string; group: number }[] = []
    const inner = segs
      .map((seg) => {
        if (seg.startsWith(":")) {
          const group = ++groupCounter
          paramGroups.push({ name: seg.slice(1), group })
          return "([^/]+)"
        }
        return escapeRe(seg)
      })
      .join("\\/")
    routeMetas.push({ outerGroup, paramGroups, handler: handlersByName.get(route.name)! })
    return `(\\/${inner})`
  })
  const regex = new RegExp(`^(?:${alternatives.join("|")})$`)
  return { regex, routeMetas }
}

const regexByMethod = new Map(
  [...new Set(routeDefs.map((r) => r.method))].map((method) => [
    method,
    buildMethodRegex(routeDefs.filter((r) => r.method === method)),
  ]),
)

function regexDispatch(pathname: string, method: string): { handler: Handler; slugs: Record<string, string> } | undefined {
  const compiled = regexByMethod.get(method)
  if (compiled === undefined) return undefined
  const match = compiled.regex.exec(pathname)
  if (match === null) return undefined
  for (const meta of compiled.routeMetas) {
    if (match[meta.outerGroup] === undefined) continue
    const slugs: Record<string, string> = {}
    for (const p of meta.paramGroups) slugs[p.name] = match[p.group]!
    return { handler: meta.handler, slugs }
  }
  return undefined
}

// ============================================================================
// 4. Compiled switch function — codegen a JS function with nested
// depth-specialized `if`/`switch` over `segs[0]`, `segs[1]`, ... (literal
// indices, no runtime split-then-loop) via `new Function()`. Handlers are
// passed in as a closed-over array argument (`new Function` can't close over
// module scope, so free variables are threaded in explicitly).
// ============================================================================

function buildCompiledSwitch(routes: readonly RouteDef[]): (pathname: string, method: string) => { handler: Handler; slugs: Record<string, string> } | undefined {
  type Mutable = {
    methods: Record<string, number> // method -> handler index
    children: Map<string, Mutable>
    fallback?: { name: string; node: Mutable }
  }
  const makeNode = (): Mutable => ({ methods: {}, children: new Map() })
  const root = makeNode()
  const handlers: Handler[] = []
  const handlerIndex = new Map<string, number>()
  const indexOf = (name: string): number => {
    let i = handlerIndex.get(name)
    if (i === undefined) {
      i = handlers.length
      handlers.push(handlersByName.get(name)!)
      handlerIndex.set(name, i)
    }
    return i
  }

  for (const route of routes) {
    let node = root
    for (const seg of splitSegs(route.path)) {
      if (seg.startsWith(":")) {
        const name = seg.slice(1)
        if (node.fallback === undefined) node.fallback = { name, node: makeNode() }
        node = node.fallback.node
      } else {
        let child = node.children.get(seg)
        if (child === undefined) {
          child = makeNode()
          node.children.set(seg, child)
        }
        node = child
      }
    }
    node.methods[route.method] = indexOf(route.name)
  }

  let paramCounter = 0
  function gen(node: Mutable, depth: number, slugAssigns: readonly string[]): string {
    let code = ""
    const methodEntries = Object.entries(node.methods)
    if (methodEntries.length > 0) {
      code += `if (segs.length === ${depth}) {\n`
      for (const [method, hIdx] of methodEntries) {
        const slugsObj = slugAssigns.length > 0 ? `{ ${slugAssigns.join(", ")} }` : "{}"
        code += `  if (method === ${JSON.stringify(method)}) return { handler: handlers[${hIdx}], slugs: ${slugsObj} }\n`
      }
      code += `}\n`
    }
    if (node.children.size > 0) {
      code += `if (segs.length > ${depth}) {\n`
      code += `switch (segs[${depth}]) {\n`
      for (const [seg, child] of node.children) {
        code += `case ${JSON.stringify(seg)}: {\n${gen(child, depth + 1, slugAssigns)}\nbreak\n}\n`
      }
      code += `}\n`
      code += `}\n`
    }
    if (node.fallback !== undefined) {
      const pvar = `p${paramCounter++}`
      code += `if (segs.length > ${depth}) {\n`
      code += `const ${pvar} = segs[${depth}]\n`
      code += gen(node.fallback.node, depth + 1, [...slugAssigns, `${JSON.stringify(node.fallback.name)}: ${pvar}`])
      code += `}\n`
    }
    return code
  }

  const body = `${gen(root, 0, [])}\nreturn undefined\n`
  codegenSizes["4. Compiled switch (new Function)"] = { chars: body.length, bytes: Buffer.byteLength(body, "utf8") }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- deliberate: this IS the "compiled switch" architecture under test
  const fn = new Function("segs", "method", "handlers", body) as (
    segs: readonly string[],
    method: string,
    handlers: readonly Handler[],
  ) => { handler: Handler; slugs: Record<string, string> } | undefined

  return (pathname: string, method: string) => fn(splitPath(pathname), method, handlers)
}

const compiledSwitchDispatch = buildCompiledSwitch(routeDefs)

// ============================================================================
// 5. Character-level radix trie — walk the raw pathname char-by-char against
// a compressed prefix tree. No `split`, no per-segment array allocation.
// Static edges store a literal substring; one dynamic ("param") edge per
// node consumes chars up to the next "/" or end-of-string.
// ============================================================================

type RadixNode = {
  prefix: string
  children: RadixNode[]
  param?: { name: string; node: RadixNode }
  methods?: Record<string, Handler>
}

function newRadixNode(prefix: string): RadixNode {
  return { prefix, children: [] }
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/** Split `child` at `len` chars into a new intermediate node, preserving its subtree below the split. */
function splitRadixNode(child: RadixNode, len: number): void {
  const tail: RadixNode = {
    prefix: child.prefix.slice(len),
    children: child.children,
    ...(child.param !== undefined ? { param: child.param } : {}),
    ...(child.methods !== undefined ? { methods: child.methods } : {}),
  }
  child.prefix = child.prefix.slice(0, len)
  child.children = [tail]
  delete child.param
  delete child.methods
}

function insertRadix(node: RadixNode, path: string, method: string, handler: Handler): void {
  if (path.length === 0) {
    node.methods = node.methods ?? {}
    node.methods[method] = handler
    return
  }
  if (path[0] === ":") {
    const slashIdx = path.indexOf("/")
    const name = slashIdx === -1 ? path.slice(1) : path.slice(1, slashIdx)
    const rest = slashIdx === -1 ? "" : path.slice(slashIdx)
    if (node.param === undefined) node.param = { name, node: newRadixNode("") }
    insertRadix(node.param.node, rest, method, handler)
    return
  }
  // literal chunk up to the next ':' (if any) is what we may share/split against existing children
  const paramIdx = path.indexOf(":")
  const literal = paramIdx === -1 ? path : path.slice(0, paramIdx)
  const restAfterLiteral = paramIdx === -1 ? "" : path.slice(paramIdx)

  for (const child of node.children) {
    const cp = commonPrefixLen(child.prefix, literal)
    if (cp === 0) continue
    if (cp < child.prefix.length) splitRadixNode(child, cp)
    insertRadix(child, literal.slice(cp) + restAfterLiteral, method, handler)
    return
  }
  const newChild = newRadixNode(literal)
  node.children.push(newChild)
  insertRadix(newChild, restAfterLiteral, method, handler)
}

function buildRadixTrie(routes: readonly RouteDef[]): RadixNode {
  const root = newRadixNode("")
  for (const route of routes) {
    insertRadix(root, route.path, route.method, handlersByName.get(route.name)!)
  }
  return root
}

const radixRoot = buildRadixTrie(routeDefs)

function radixDispatch(pathname: string, method: string): { handler: Handler; slugs: Record<string, string> } | undefined {
  const slugs: Record<string, string> = {}
  let node = radixRoot
  let i = 0
  const len = pathname.length
  for (;;) {
    // consume this node's own prefix
    const prefix = node.prefix
    const plen = prefix.length
    if (plen > 0) {
      if (i + plen > len) return undefined
      for (let k = 0; k < plen; k++) {
        if (pathname.charCodeAt(i + k) !== prefix.charCodeAt(k)) return undefined
      }
      i += plen
    }
    if (i === len) {
      const entry = node.methods?.[method]
      return entry !== undefined ? { handler: entry, slugs } : undefined
    }
    const c = pathname.charCodeAt(i)
    let next: RadixNode | undefined
    for (const child of node.children) {
      if (child.prefix.charCodeAt(0) === c) {
        next = child
        break
      }
    }
    if (next !== undefined) {
      node = next
      continue
    }
    if (node.param !== undefined) {
      let end = i
      while (end < len && pathname.charCodeAt(end) !== 47 /* "/" */) end++
      slugs[node.param.name] = pathname.slice(i, end)
      i = end
      node = node.param.node
      continue
    }
    return undefined
  }
}

// ============================================================================
// 6. Flat DFA transition table — compile route paths into a flat
// Uint32Array-backed automaton: table[state * 128 + charCode] -> next state
// (0 = dead). One table per HTTP method (like architecture 3). Literal
// segments become one state per character; a dynamic ("param") segment
// becomes a single self-looping state that consumes every non-"/" char and
// hands control to whatever continuation follows the "/". Same
// no-backtracking contract as architecture 5: a literal edge claiming a
// character always wins over a sibling param edge at that position, and
// once a literal branch is taken there is no falling back to a param
// alternative deeper in — this file's fixed route set never needs that
// (verified by the correctness check architectures 1-5 already pass).
// ============================================================================

type DfaCharTrieNode = {
  readonly id: number
  readonly literalChildren: Map<number, DfaCharTrieNode>
  paramChild?: { readonly name: string; readonly node: DfaCharTrieNode }
  readonly isParamState: boolean
  handler?: Handler
}

function newDfaNode(nextId: () => number, isParamState: boolean): DfaCharTrieNode {
  return { id: nextId(), literalChildren: new Map(), isParamState }
}

function insertDfaChars(root: DfaCharTrieNode, path: string, handler: Handler, nextId: () => number): void {
  let node = root
  let i = 0
  while (i < path.length) {
    if (path[i] === ":") {
      let j = i + 1
      while (j < path.length && path[j] !== "/") j++
      const name = path.slice(i + 1, j)
      if (node.paramChild === undefined) node.paramChild = { name, node: newDfaNode(nextId, true) }
      node = node.paramChild.node
      i = j
    } else {
      const code = path.charCodeAt(i)
      let child = node.literalChildren.get(code)
      if (child === undefined) {
        child = newDfaNode(nextId, false)
        node.literalChildren.set(code, child)
      }
      node = child
      i++
    }
  }
  node.handler = handler
}

/** Iterative (not recursive) so an 8k-char route's char-per-state chain can't blow the call stack. */
function collectDfaNodes(root: DfaCharTrieNode): DfaCharTrieNode[] {
  const out: DfaCharTrieNode[] = []
  const stack: DfaCharTrieNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    out.push(node)
    for (const child of node.literalChildren.values()) stack.push(child)
    if (node.paramChild !== undefined) stack.push(node.paramChild.node)
  }
  return out
}

type MethodDfa = {
  readonly table: Uint32Array
  readonly paramNameOfState: readonly (string | undefined)[]
  readonly terminalOf: readonly (Handler | undefined)[]
  readonly startState: number
}

function buildMethodDfa(routes: readonly RouteDef[]): MethodDfa {
  let idCounter = 0
  const nextId = () => ++idCounter // states are 1..N; 0 is reserved for "dead"
  const root = newDfaNode(nextId, false)
  for (const route of routes) {
    insertDfaChars(root, route.path, handlersByName.get(route.name)!, nextId)
  }

  const allNodes = collectDfaNodes(root)
  const numStates = idCounter
  const table = new Uint32Array((numStates + 1) * 128)
  const paramNameOfState: (string | undefined)[] = new Array(numStates + 1)
  const terminalOf: (Handler | undefined)[] = new Array(numStates + 1)

  for (const node of allNodes) {
    const row = node.id * 128
    for (let c = 0; c < 128; c++) {
      table[row + c] = c === 47 ? 0 : node.isParamState ? node.id : 0
    }
    for (const [code, child] of node.literalChildren) table[row + code] = child.id
    if (node.paramChild !== undefined) {
      const pid = node.paramChild.node.id
      paramNameOfState[pid] = node.paramChild.name
      for (let c = 0; c < 128; c++) {
        if (c === 47) continue
        if (!node.literalChildren.has(c)) table[row + c] = pid
      }
    }
    terminalOf[node.id] = node.handler
  }

  return { table, paramNameOfState, terminalOf, startState: root.id }
}

const dfaByMethod = new Map(
  [...new Set(routeDefs.map((r) => r.method))].map((method) => [
    method,
    buildMethodDfa(routeDefs.filter((r) => r.method === method)),
  ]),
)

function dfaDispatch(pathname: string, method: string): { handler: Handler; slugs: Record<string, string> } | undefined {
  const dfa = dfaByMethod.get(method)
  if (dfa === undefined) return undefined
  const { table, paramNameOfState, terminalOf, startState } = dfa
  const len = pathname.length
  let state = startState
  const slugs: Record<string, string> = {}
  let paramName: string | undefined
  let paramStart = 0
  let i = 0
  for (; i < len; i++) {
    const c = pathname.charCodeAt(i)
    const next = table[state * 128 + c]!
    if (next === 0) return undefined
    if (next !== state) {
      if (paramName !== undefined) {
        slugs[paramName] = pathname.slice(paramStart, i)
        paramName = undefined
      }
      const enteredName = paramNameOfState[next]
      if (enteredName !== undefined) {
        paramName = enteredName
        paramStart = i
      }
    }
    state = next
  }
  if (paramName !== undefined) slugs[paramName] = pathname.slice(paramStart, i)
  const handler = terminalOf[state]
  return handler !== undefined ? { handler, slugs } : undefined
}

// ============================================================================
// 7. Compiled char-level function — codegen a nested if/else chain over
// `s.charCodeAt(i)` via `new Function()`. The transitions themselves ARE the
// generated code — no table, no object property lookups — and V8 JIT-compiles
// the result like any other hot function. Combines all methods into one tree
// (like architecture 4's `buildCompiledSwitch`), but char-indexed instead of
// segment-indexed, and follows the same no-backtracking contract as
// architectures 5/6: at a given node, a literal `charCodeAt(i)` match is tried
// first for each of that node's literal edges, and only the (single, shared)
// param edge is tried as the final `else` when none of them match — never as
// a fallback after a literal branch has already been entered and advanced `i`.
// ============================================================================

type CharFnTrieNode = {
  readonly literalChildren: Map<number, CharFnTrieNode>
  paramChild?: { readonly name: string; readonly node: CharFnTrieNode }
  readonly methods: Map<string, number> // method -> handler index
}

function newCharFnNode(): CharFnTrieNode {
  return { literalChildren: new Map(), methods: new Map() }
}

function insertCharFn(root: CharFnTrieNode, path: string, method: string, handlerIdx: number): void {
  let node = root
  let i = 0
  while (i < path.length) {
    if (path[i] === ":") {
      let j = i + 1
      while (j < path.length && path[j] !== "/") j++
      const name = path.slice(i + 1, j)
      if (node.paramChild === undefined) node.paramChild = { name, node: newCharFnNode() }
      node = node.paramChild.node
      i = j
    } else {
      const code = path.charCodeAt(i)
      let child = node.literalChildren.get(code)
      if (child === undefined) {
        child = newCharFnNode()
        node.literalChildren.set(code, child)
      }
      node = child
      i++
    }
  }
  node.methods.set(method, handlerIdx)
}

function buildCompiledCharFn(
  routes: readonly RouteDef[],
  codegenKey = "7. Compiled char-level fn",
): (pathname: string, method: string) => { handler: Handler; slugs: Record<string, string> } | undefined {
  const root = newCharFnNode()
  const handlers: Handler[] = []
  const handlerIndex = new Map<string, number>()
  const indexOf = (name: string): number => {
    let idx = handlerIndex.get(name)
    if (idx === undefined) {
      idx = handlers.length
      handlers.push(handlersByName.get(name)!)
      handlerIndex.set(name, idx)
    }
    return idx
  }

  for (const route of routes) {
    insertCharFn(root, route.path, route.method, indexOf(route.name))
  }

  let paramCounter = 0

  // Follow a run of unbranching single-literal-child nodes (no param, no
  // terminal in between) and fold it into one string, so a long unbranching
  // literal run (e.g. an 8k-char static route) compiles to ONE `startsWith`
  // check instead of one nested `if` per character. Without this, codegen
  // recursion depth (and the resulting generated source's AST nesting depth)
  // scales with path length and blows V8's parser/call stack well before 8k
  // chars — a real limitation of naive char-by-char codegen, worked around
  // here the same way a real compiler would: batch the unambiguous run.
  function chaseChunk(node: CharFnTrieNode): { chunk: string; target: CharFnTrieNode } {
    let chunk = ""
    let cur = node
    for (;;) {
      if (cur.methods.size > 0) break
      if (cur.paramChild !== undefined) break
      if (cur.literalChildren.size !== 1) break
      const [code, child] = [...cur.literalChildren][0]!
      chunk += String.fromCharCode(code)
      cur = child
    }
    return { chunk, target: cur }
  }

  function gen(node: CharFnTrieNode, slugAssigns: readonly string[]): string {
    let code = ""
    if (node.methods.size > 0) {
      code += `if (i === len) {\n`
      for (const [method, hIdx] of node.methods) {
        const slugsObj = slugAssigns.length > 0 ? `{ ${slugAssigns.join(", ")} }` : "{}"
        code += `if (method === ${JSON.stringify(method)}) return { handler: handlers[${hIdx}], slugs: ${slugsObj} }\n`
      }
      code += `}\n`
    }

    const branches: string[] = []
    if (node.literalChildren.size > 0) {
      for (const [charCode, firstChild] of node.literalChildren) {
        const { chunk, target } = chaseChunk(firstChild)
        const fullChunk = String.fromCharCode(charCode) + chunk
        branches.push(
          `if (s.startsWith(${JSON.stringify(fullChunk)}, i)) {\ni += ${fullChunk.length}\n${gen(target, slugAssigns)}\n}`,
        )
      }
    }
    if (node.paramChild !== undefined) {
      const pvar = `p${paramCounter++}`
      const nextSlugAssigns = [...slugAssigns, `${JSON.stringify(node.paramChild.name)}: ${pvar}`]
      branches.push(
        `{\nconst start${pvar} = i\nwhile (i < len && s.charCodeAt(i) !== 47) i++\nconst ${pvar} = s.slice(start${pvar}, i)\n${gen(node.paramChild.node, nextSlugAssigns)}\n}`,
      )
    }
    if (branches.length > 0) {
      code += `if (i < len) {\n`
      code += branches.join(" else ")
      code += `\n}\n`
    }
    return code
  }

  const body = `let i = 0\nconst len = s.length\n${gen(root, [])}\nreturn undefined\n`
  codegenSizes[codegenKey] = { chars: body.length, bytes: Buffer.byteLength(body, "utf8") }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- deliberate: this IS the "compiled char-level function" architecture under test
  const fn = new Function("s", "method", "handlers", body) as (
    s: string,
    method: string,
    handlers: readonly Handler[],
  ) => { handler: Handler; slugs: Record<string, string> } | undefined

  return (pathname: string, method: string) => fn(pathname, method, handlers)
}

const compiledCharFnDispatch = buildCompiledCharFn(routeDefs)

// ============================================================================
// 8. Hybrid Map + compiled char-level fn — partition routeDefs at build time
// into static routes (no `:param` segment anywhere in the path) and dynamic
// routes (at least one `:param` segment). Static routes go into a
// `Map<pathname, methods>` — one hash lookup, no traversal at all. Dynamic
// routes ONLY feed architecture 7's compiled-char-fn codegen (reusing
// `buildCompiledCharFn` as-is), producing a SMALLER generated function than
// arch 7's (which compiles all ~993 routes, static ones included). At
// dispatch: `map.get(pathname)` first; on a miss (either the path isn't in
// the map, or it is but this method isn't registered for it) fall through to
// the dynamic-only compiled fn.
// ============================================================================

function isDynamicRoute(route: RouteDef): boolean {
  return splitSegs(route.path).some((seg) => seg.startsWith(":"))
}

const hybridStaticDefs = routeDefs.filter((r) => !isDynamicRoute(r))
const hybridDynamicDefs = routeDefs.filter(isDynamicRoute)

function buildHybridStaticMap(routes: readonly RouteDef[]): Map<string, Record<string, Handler>> {
  const map = new Map<string, Record<string, Handler>>()
  for (const route of routes) {
    const pathname = `/${splitSegs(route.path).join("/")}`
    let methods = map.get(pathname)
    if (methods === undefined) {
      methods = {}
      map.set(pathname, methods)
    }
    methods[route.method] = handlersByName.get(route.name)!
  }
  return map
}

const hybridStaticMap = buildHybridStaticMap(hybridStaticDefs)
const hybridDynamicDispatch = buildCompiledCharFn(hybridDynamicDefs, "8. Hybrid — dynamic-only compiled char fn")

function hybridDispatch(pathname: string, method: string): { handler: Handler; slugs: Record<string, string> } | undefined {
  const methods = hybridStaticMap.get(pathname)
  if (methods !== undefined) {
    const handler = methods[method]
    if (handler !== undefined) return { handler, slugs: {} }
  }
  return hybridDynamicDispatch(pathname, method)
}

// ============================================================================
// Benchmark harness — no Bun.bench (checked: not present in this Bun build,
// `typeof Bun.bench === "undefined"`); a small hand-rolled timer instead.
// ============================================================================

type Dispatch = (pathname: string, method: string) => { handler: Handler; slugs: Record<string, string> } | undefined

const architectures: readonly { readonly name: string; readonly dispatch: Dispatch }[] = [
  { name: "1. Segment trie (current)", dispatch: trieDispatch },
  { name: "2. Full-path Map", dispatch: fullPathMapDispatch },
  { name: "3. Single regex/method", dispatch: regexDispatch },
  { name: "4. Compiled switch (new Function)", dispatch: compiledSwitchDispatch },
  { name: "5. Char-level radix trie", dispatch: radixDispatch },
  { name: "6. Flat DFA table", dispatch: dfaDispatch },
  { name: "7. Compiled char-level fn", dispatch: compiledCharFnDispatch },
  { name: "8. Hybrid Map+charFn", dispatch: hybridDispatch },
]

const dispatchCases: readonly { readonly name: string; readonly pathname: string; readonly method: string }[] = [
  { name: "static hit", pathname: "/static/about", method: "GET" },
  { name: "dynamic hit", pathname: "/users/42", method: "GET" },
  { name: "deep hit", pathname: "/static/docs/guides/quickstart", method: "GET" },
  { name: "miss (404)", pathname: "/nope/not/a/route", method: "GET" },
  ...longPathFixtures.flatMap((f) => [
    { name: `static ${f.label}`, pathname: f.staticPath, method: "GET" },
    { name: `dynamic ${f.label}`, pathname: f.dynamicConcretePath, method: "GET" },
  ]),

  // Case A: wide branching (120 siblings under /api/v1/*) — early/middle/late child.
  { name: "wide early", pathname: "/api/v1/resource000", method: "GET" },
  { name: "wide middle", pathname: "/api/v1/resource060", method: "GET" },
  { name: "wide late", pathname: "/api/v1/resource119", method: "GET" },

  // Case B: deep narrow tree (25 levels, one child each).
  { name: "deep narrow", pathname: deepNarrowPath, method: "GET" },

  // Case C: many dynamic segments (4 params in one path).
  { name: "many dynamic", pathname: manyDynamicConcretePath, method: "GET" },

  // Case D: large tree (200+ routes) + long paths, combined in one mixed set.
  { name: "bulk static", pathname: "/bulk/item075", method: "GET" },
  { name: "bulk dynamic", pathname: "/bulk/dyn/025/xyz123", method: "GET" },
  { name: "bulk long static", pathname: bulkLongStaticPath, method: "GET" },
  { name: "bulk long dynamic", pathname: bulkLongDynConcretePath, method: "GET" },

  // Case E: unbalanced tree — 60 shallow (2-level) siblings vs. one 18-level chain.
  { name: "uneven deep", pathname: unevenDeepPath, method: "GET" },
  { name: "uneven shallow", pathname: "/uneven/shallow030", method: "GET" },

  // Case F: nesting + branching — branches at 3 successive depths (500 leaves).
  { name: "grid early", pathname: gridEarlyPath, method: "GET" },
  { name: "grid middle", pathname: gridMiddlePath, method: "GET" },
  { name: "grid late", pathname: gridLatePath, method: "GET" },

  // Case G: nesting + branching + long paths, all combined (48 leaves, 4k+ chars each).
  { name: "long grid early", pathname: longGridEarlyPath, method: "GET" },
  { name: "long grid late", pathname: longGridLatePath, method: "GET" },
]

// --- correctness check: every architecture must agree on every case before
// timing numbers are worth trusting.
function checkCorrectness(): void {
  console.log("=== Correctness check ===\n")
  let allOk = true
  for (const kase of dispatchCases) {
    const results = architectures.map((a) => a.dispatch(kase.pathname, kase.method))
    const names = results.map((r) => (r === undefined ? "MISS" : (r.handler as (i: unknown) => { name: string })(undefined).name))
    const slugsStrs = results.map((r) => (r === undefined ? "-" : JSON.stringify(r.slugs)))
    const allSame = names.every((n) => n === names[0])
    if (!allSame) allOk = false
    console.log(`${kase.name.padEnd(14)} ${kase.method} ${kase.pathname}`)
    for (let i = 0; i < architectures.length; i++) {
      console.log(`  ${architectures[i]!.name.padEnd(34)} -> ${String(names[i]).padEnd(20)} slugs=${slugsStrs[i]}`)
    }
    console.log(allSame ? "  agree: yes" : "  agree: NO — architectures disagree, timings below are not meaningful")
    console.log()
  }
  if (!allOk) throw new Error("architectures disagree on at least one case — fix before trusting bench numbers")
}

function timeOnce(fn: () => unknown, iterations: number): number {
  // warmup
  for (let i = 0; i < Math.min(iterations, 10_000); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const end = performance.now()
  return end - start
}

// JIT-hoisting fix: calling dispatch(sameStringLiteral, sameStringLiteral)
// 500k times in a row lets the engine prove the arguments never change
// across iterations — some of the compiled/no-branch architectures were
// measured faster than they'd ever be in real traffic because of this.
// Pre-generate VARIANT_COUNT distinct string objects with IDENTICAL content
// per case (built via split/join so each is a fresh object, not an interned
// re-use of the same one) and index into that array with a per-iteration
// counter, so the call target is a runtime array read the engine can't
// prove constant — the same fix applied uniformly to all 7 architectures,
// not just one.
const VARIANT_COUNT = 8

function makeVariants(s: string): string[] {
  return Array.from({ length: VARIANT_COUNT }, () => s.split("").join(""))
}

function timeDispatch(dispatch: Dispatch, pathname: string, method: string, iterations: number): number {
  const pathnames = makeVariants(pathname)
  const methods = makeVariants(method)
  const n = VARIANT_COUNT
  // warmup
  for (let i = 0; i < Math.min(iterations, 10_000); i++) dispatch(pathnames[i % n]!, methods[i % n]!)
  const start = performance.now()
  for (let i = 0; i < iterations; i++) dispatch(pathnames[i % n]!, methods[i % n]!)
  const end = performance.now()
  return end - start
}

const DISPATCH_ITERATIONS = 500_000
const BUILD_ITERATIONS = 200
const MEMORY_SAMPLES = 3

// ============================================================================
// System info — captured so a saved results file can be compared across
// machines/runs without guessing what hardware/runtime produced it.
// ============================================================================

type SystemInfo = {
  readonly timestamp: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string
  readonly cpuCount: number
  readonly cpuSpeedMhz: number
  readonly totalMemGB: number
  readonly freeMemGB: number
  readonly runtime: string
  readonly runtimeVersion: string
  readonly nodeVersions: Readonly<Record<string, string | undefined>>
}

function collectSystemInfo(): SystemInfo {
  const cpus = os.cpus()
  const runtime = typeof Bun !== "undefined" ? "bun" : "node"
  const runtimeVersion = typeof Bun !== "undefined" ? Bun.version : process.version
  return {
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed ?? 0,
    totalMemGB: os.totalmem() / 2 ** 30,
    freeMemGB: os.freemem() / 2 ** 30,
    runtime,
    runtimeVersion,
    nodeVersions: { ...process.versions },
  }
}

/** Force a GC pass if the runtime exposes one (Bun always does; Node needs --expose-gc). */
function forceGc(): void {
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true)
    return
  }
  if (typeof (globalThis as { gc?: () => void }).gc === "function") {
    ;(globalThis as { gc: () => void }).gc()
  }
}

// Measuring a SINGLE build's memory footprint via process.memoryUsage() was
// tried first and rejected: verified experimentally (see scratch tests run
// during development) that Bun/JSC's heapUsed counter only becomes visible in
// ~10-30MB increments — a single ~700-route tree's allocation doesn't move it
// at all, reading a flat 0 regardless of architecture. Typed arrays (the DFA
// table's Uint32Array) additionally don't count against heapUsed under ANY
// size — they show up under `external` instead, confirmed by allocating a
// bare 20MB Uint32Array and observing heapUsed delta = 0, external delta = 0
// too until several are retained simultaneously past the same threshold.
// Fix: build N copies, retain all of them, force GC once more (with them
// still referenced, so it's a real live-set measurement, not pre-collection
// noise), then divide the delta by N. This is the same amortization trick
// the timing benchmarks already use for build-cost — it works here for the
// same reason: the fixed one-shot measurement floor is the problem, not the
// technique. A FIXED batch size doesn't fit every architecture, though: a
// batch of 50 was plenty to reveal the DFA table's (already-large) per-build
// allocation but stayed at a flat 0 for every lean architecture (segment
// trie, Map, regex, compiled fns) whose few-hundred-KB structures still
// didn't clear the threshold at 50x. So the batch size is calibrated per
// architecture instead: time one build, then pick a batch that fills a fixed
// time budget — cheap builds get a big batch (pushes small structures well
// past the visibility floor), the already-expensive DFA build gets a small
// one (it doesn't need amplification, and 50x of an already-88ms build would
// dominate this phase's runtime for no accuracy benefit).
const MEMORY_TIME_BUDGET_MS = 500
const MEMORY_MIN_BATCH = 5
const MEMORY_MAX_BATCH = 2000

function calibrateMemoryBatchSize(build: () => unknown): number {
  const t0 = performance.now()
  const probe = build()
  const singleMs = Math.max(0.001, performance.now() - t0)
  void probe
  return Math.max(MEMORY_MIN_BATCH, Math.min(MEMORY_MAX_BATCH, Math.round(MEMORY_TIME_BUDGET_MS / singleMs)))
}

type MemoryDelta = { readonly heapBytes: number; readonly externalBytes: number; readonly batchSize: number }

function measureBuildMemory(build: () => unknown): MemoryDelta {
  const batchSize = calibrateMemoryBatchSize(build)
  const heapDeltas: number[] = []
  const externalDeltas: number[] = []
  for (let round = 0; round < MEMORY_SAMPLES; round++) {
    forceGc()
    const before = process.memoryUsage()
    const built: unknown[] = []
    for (let i = 0; i < batchSize; i++) built.push(build())
    forceGc() // scavenge/compact WHILE `built` is still referenced — this is what makes the live set visible
    const after = process.memoryUsage()
    heapDeltas.push(Math.max(0, after.heapUsed - before.heapUsed) / batchSize)
    externalDeltas.push(Math.max(0, after.external - before.external) / batchSize)
    void built
  }
  heapDeltas.sort((a, b) => a - b)
  externalDeltas.sort((a, b) => a - b)
  const mid = Math.floor(MEMORY_SAMPLES / 2)
  return { heapBytes: heapDeltas[mid]!, externalBytes: externalDeltas[mid]!, batchSize }
}

type BuildResult = {
  readonly name: string
  readonly perBuildUs: number
  readonly totalMs: number
  readonly heapDeltaBytes: number
  readonly externalDeltaBytes: number
  readonly memoryBatchSize: number
}

function benchBuildPhase(): readonly BuildResult[] {
  console.log("=== Build/compile phase (one-time cost + memory) ===\n")
  const builders: readonly { readonly name: string; readonly build: () => unknown }[] = [
    { name: "1. Segment trie", build: () => buildHttpRouteTree(routeDefs) },
    { name: "2. Full-path Map", build: () => {
      const m = new Map<string, unknown>()
      for (const route of routeDefs) {
        const segs = splitSegs(route.path)
        if (segs.some((s) => s.startsWith(":"))) continue
        m.set(`${route.method} /${segs.join("/")}`, handlersByName.get(route.name))
      }
      return m
    } },
    { name: "3. Single regex/method", build: () => {
      const built: unknown[] = []
      for (const method of new Set(routeDefs.map((r) => r.method))) {
        built.push(buildMethodRegex(routeDefs.filter((r) => r.method === method)))
      }
      return built
    } },
    { name: "4. Compiled switch", build: () => buildCompiledSwitch(routeDefs) },
    { name: "5. Char-level radix trie", build: () => buildRadixTrie(routeDefs) },
    { name: "6. Flat DFA table", build: () => {
      const built: unknown[] = []
      for (const method of new Set(routeDefs.map((r) => r.method))) {
        built.push(buildMethodDfa(routeDefs.filter((r) => r.method === method)))
      }
      return built
    } },
    { name: "7. Compiled char-level fn", build: () => buildCompiledCharFn(routeDefs) },
    { name: "8. Hybrid Map+charFn", build: () => ({
      map: buildHybridStaticMap(hybridStaticDefs),
      dynamicFn: buildCompiledCharFn(hybridDynamicDefs, "8. Hybrid — dynamic-only compiled char fn"),
    }) },
  ]
  const results: BuildResult[] = []
  for (const b of builders) {
    const ms = timeOnce(() => b.build(), BUILD_ITERATIONS)
    const perBuildUs = (ms / BUILD_ITERATIONS) * 1000
    const { heapBytes, externalBytes, batchSize } = measureBuildMemory(b.build)
    results.push({
      name: b.name,
      perBuildUs,
      totalMs: ms,
      heapDeltaBytes: heapBytes,
      externalDeltaBytes: externalBytes,
      memoryBatchSize: batchSize,
    })
    const heapKB = (heapBytes / 1024).toFixed(1)
    const externalKB = (externalBytes / 1024).toFixed(1)
    console.log(
      `${b.name.padEnd(28)} ${perBuildUs.toFixed(2).padStart(10)} us/build  (${BUILD_ITERATIONS} builds, ${ms.toFixed(1)}ms total)   ~${heapKB.padStart(9)} KB heap  ~${externalKB.padStart(9)} KB external  (batch of ${batchSize}, median of ${MEMORY_SAMPLES})`,
    )
  }
  console.log()
  if (Object.keys(codegenSizes).length > 0) {
    console.log("Generated source size (new Function() codegen architectures only):")
    for (const [name, size] of Object.entries(codegenSizes)) {
      console.log(`  ${name.padEnd(34)} ${size.chars.toLocaleString().padStart(10)} chars  ${size.bytes.toLocaleString().padStart(10)} bytes`)
    }
    console.log()
  }
  return results
}

type DispatchResult = {
  readonly architecture: string
  readonly cases: Readonly<Record<string, number>> // case name -> ns/request
}

function benchDispatchPhase(): readonly DispatchResult[] {
  console.log("=== Dispatch phase (hot path, ns/request) ===\n")
  const header = `${"".padEnd(34)} ${dispatchCases.map((c) => c.name.padEnd(16)).join("")}`
  console.log(header)
  const results: DispatchResult[] = []
  for (const arch of architectures) {
    const cells: string[] = []
    const cases: Record<string, number> = {}
    for (const kase of dispatchCases) {
      const ms = timeDispatch(arch.dispatch, kase.pathname, kase.method, DISPATCH_ITERATIONS)
      const ns = (ms / DISPATCH_ITERATIONS) * 1_000_000
      cases[kase.name] = ns
      cells.push(`${ns.toFixed(1).padStart(8)} ns  `.padEnd(16))
    }
    results.push({ architecture: arch.name, cases })
    console.log(`${arch.name.padEnd(34)} ${cells.join("")}`)
  }
  console.log()
  return results
}

/** Write the full run (system info, route-tree size, build cost + memory,
 *  codegen size, dispatch matrix) to a timestamped JSON file so runs can be
 *  diffed across machines/commits instead of only living in scrollback. */
function saveResults(system: SystemInfo, build: readonly BuildResult[], dispatch: readonly DispatchResult[]): string {
  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bench-results")
  mkdirSync(outDir, { recursive: true })
  const stamp = system.timestamp.replace(/[:.]/g, "-")
  const outFile = path.join(outDir, `route-bench-${stamp}.json`)
  const payload = {
    system,
    routeCount: routeDefs.length,
    dispatchCaseCount: dispatchCases.length,
    codegenSizes,
    build,
    dispatch,
  }
  writeFileSync(outFile, JSON.stringify(payload, null, 2))
  return outFile
}

checkCorrectness()
const systemInfo = collectSystemInfo()
console.log("=== System info ===\n")
console.log(`${systemInfo.runtime} ${systemInfo.runtimeVersion} on ${systemInfo.platform}/${systemInfo.arch}`)
console.log(`${systemInfo.cpuModel} x${systemInfo.cpuCount} @ ${systemInfo.cpuSpeedMhz}MHz, ${systemInfo.totalMemGB.toFixed(1)}GB RAM (${systemInfo.freeMemGB.toFixed(1)}GB free)`)
console.log()

const buildResults = benchBuildPhase()
const dispatchResults = benchDispatchPhase()

console.log("=== Notes ===")
console.log("- Full-path Map only serves the routes it was seeded with; its dynamic-hit")
console.log("  number covers exactly one hardcoded /users/42, not general param matching.")
console.log("- All numbers include the dispatch() closure call overhead, not just the")
console.log("  core algorithm — kept identical across architectures so it cancels out.")
console.log("- Memory: heap KB is process.memoryUsage().heapUsed delta, external KB is")
console.log("  the .external delta (catches ArrayBuffer-backed data, e.g. arch 6's Uint32Array")
console.log("  table, which heapUsed does NOT count at all). Both are averaged over a batch")
console.log("  of retained builds, median of a few rounds — a single build's delta is too")
console.log("  small to register on this engine's heap-accounting granularity (~10MB+ steps).")
console.log("- Neither counter captures new Function()'s compiled bytecode/machine code —")
console.log("  generated source chars/bytes (above) is the available proxy for architectures 4/7.")

const savedTo = saveResults(systemInfo, buildResults, dispatchResults)
console.log(`\nResults saved to ${savedTo}`)
