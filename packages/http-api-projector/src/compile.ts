// packages/http-api-projector/src/compile.ts — @rhi-zone/fractal-http-api-projector
//
// Composable, independent route compilers — each takes an `HttpRoute` and
// produces the same `(req: Request) => Promise<Response>` dispatch contract
// as `makeRouterFromRoute` (route.ts), but compiles the match step
// differently. Ported from the architectures benchmarked in
// `route.bench.ts` (architectures 5, 7, 8 — the ones that beat the baseline
// segment trie without regressing on any pathological case).
//
// The decomposition is two layers:
//   - `Matcher`  — `(pathname, method) => RouteMatch | undefined`, pure path
//     matching, no dispatch. `radixMatcher`, `compiledCharMatcher`,
//     `mapMatcher` each build one; `chainMatchers` composes several in order.
//   - `toRouter` — wraps a `Matcher` with the same dispatch (`runRoute`,
//     imported from route.ts) that `makeRouterFromRoute` runs, plus the 404
//     fallback.
//
// `radixRouter`/`compiledCharRouter`/`mapCharRouter` are `toRouter(matcher)`
// convenience wrappers for the three benchmarked shapes.

import type { AsyncLocalStorage } from "node:async_hooks"
import type { Handler, Meta } from "@rhi-zone/fractal-api-tree/node"
import { runRoute, splitPath } from "./route.ts"
import type { HttpRoute, Sources } from "./route.ts"

// ============================================================================
// Shared types
// ============================================================================

export type RouteMatch = {
  readonly handler: Handler
  readonly meta: Meta
  readonly sources?: Sources
  readonly slugs: Record<string, string>
}

export type Matcher = (pathname: string, method: string) => RouteMatch | undefined

export type CompiledRouter = (req: Request) => Promise<Response>

/** Wraps a `Matcher` with request dispatch + 404 fallback — same contract as `makeRouterFromRoute`. */
export function toRouter(matcher: Matcher): CompiledRouter {
  return async (req) => {
    const pathname = new URL(req.url).pathname
    const match = matcher(pathname, req.method)
    if (match === undefined) return new Response("Not Found", { status: 404 })
    return runRoute(req, match.handler, match.meta, match.sources, match.slugs)
  }
}

/** Try each matcher in order; the first non-`undefined` result wins. */
export function chainMatchers(...matchers: readonly Matcher[]): Matcher {
  return (pathname, method) => {
    for (const matcher of matchers) {
      const result = matcher(pathname, method)
      if (result !== undefined) return result
    }
    return undefined
  }
}

// ============================================================================
// HttpRoute => flat route list — shared by every compiler below. Walks the
// tree once, producing one entry per (path, method), with dynamic segments
// rendered as `:name` (route.ts's own tree-walk convention).
// ============================================================================

type CollectedRoute = {
  readonly path: string
  readonly method: string
  readonly handler: Handler
  readonly meta: Meta
  readonly sources?: Sources
}

function collectRoutes(route: HttpRoute, segs: readonly string[]): CollectedRoute[] {
  const out: CollectedRoute[] = []
  for (const [method, entry] of Object.entries(route.methods ?? {})) {
    out.push({
      path: segs.length > 0 ? `/${segs.join("/")}` : "/",
      method,
      handler: entry.handler,
      meta: entry.meta,
      ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
    })
  }
  if (route.children !== undefined) {
    for (const [key, child] of Object.entries(route.children)) {
      out.push(...collectRoutes(child, [...segs, key]))
    }
  }
  if (route.fallback !== undefined) {
    out.push(...collectRoutes(route.fallback.subtree, [...segs, `:${route.fallback.name}`]))
  }
  return out
}

function isDynamicPath(path: string): boolean {
  return splitPath(path).some((seg) => seg.startsWith(":"))
}

// ============================================================================
// radixMatcher — character-level radix trie (route.bench.ts architecture 5).
// Walks raw pathname chars against a compressed prefix tree: no splitPath,
// no per-segment allocation. Static edges store a literal substring; one
// dynamic ("param") edge per node consumes chars up to the next "/" or EOS.
// ============================================================================

type RadixNode = {
  prefix: string
  children: RadixNode[]
  param?: { readonly name: string; readonly node: RadixNode }
  methods?: Record<string, CollectedRoute>
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

function insertRadix(node: RadixNode, path: string, method: string, route: CollectedRoute): void {
  if (path.length === 0) {
    node.methods = node.methods ?? {}
    node.methods[method] = route
    return
  }
  if (path[0] === ":") {
    const slashIdx = path.indexOf("/")
    const name = slashIdx === -1 ? path.slice(1) : path.slice(1, slashIdx)
    const rest = slashIdx === -1 ? "" : path.slice(slashIdx)
    if (node.param === undefined) node.param = { name, node: newRadixNode("") }
    insertRadix(node.param.node, rest, method, route)
    return
  }
  const paramIdx = path.indexOf(":")
  const literal = paramIdx === -1 ? path : path.slice(0, paramIdx)
  const restAfterLiteral = paramIdx === -1 ? "" : path.slice(paramIdx)

  for (const child of node.children) {
    const cp = commonPrefixLen(child.prefix, literal)
    if (cp === 0) continue
    if (cp < child.prefix.length) splitRadixNode(child, cp)
    insertRadix(child, literal.slice(cp) + restAfterLiteral, method, route)
    return
  }
  const newChild = newRadixNode(literal)
  node.children.push(newChild)
  insertRadix(newChild, restAfterLiteral, method, route)
}

function buildRadixTrie(routes: readonly CollectedRoute[]): RadixNode {
  const root = newRadixNode("")
  for (const route of routes) insertRadix(root, route.path, route.method, route)
  return root
}

function radixDispatch(root: RadixNode, pathname: string, method: string): RouteMatch | undefined {
  const slugs: Record<string, string> = {}
  let node = root
  let i = 0
  const len = pathname.length
  for (;;) {
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
      return entry !== undefined
        ? {
            handler: entry.handler,
            meta: entry.meta,
            ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
            slugs,
          }
        : undefined
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

function buildRadixMatcher(routes: readonly CollectedRoute[]): Matcher {
  const root = buildRadixTrie(routes)
  return (pathname, method) => radixDispatch(root, pathname, method)
}

export function radixMatcher(route: HttpRoute): Matcher {
  return buildRadixMatcher(collectRoutes(route, []))
}

export function radixRouter(route: HttpRoute): CompiledRouter {
  return toRouter(radixMatcher(route))
}

// ============================================================================
// compiledCharMatcher — codegen a JS function via `new Function()` with the
// routing logic inlined as nested if/else on `s.charCodeAt(i)`
// (route.bench.ts architecture 7). Unbranching literal runs are compressed
// into a single `startsWith(chunk, i)` call — the key optimization the
// benchmark found — instead of one nested `if` per character.
// ============================================================================

type CharFnTrieNode = {
  readonly literalChildren: Map<number, CharFnTrieNode>
  paramChild?: { readonly name: string; readonly node: CharFnTrieNode }
  readonly methods: Map<string, number>
}

function newCharFnNode(): CharFnTrieNode {
  return { literalChildren: new Map(), methods: new Map() }
}

function insertCharFn(root: CharFnTrieNode, path: string, method: string, routeIdx: number): void {
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
  node.methods.set(method, routeIdx)
}

/** Follow a run of unbranching single-literal-child nodes and fold it into one string —
 *  see route.bench.ts's `chaseChunk` for the full rationale (compiles a long unbranching
 *  literal run to one `startsWith` check instead of one nested `if` per character). */
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

function buildCompiledCharMatcher(routes: readonly CollectedRoute[]): Matcher {
  const root = newCharFnNode()
  for (let i = 0; i < routes.length; i++) {
    insertCharFn(root, routes[i]!.path, routes[i]!.method, i)
  }

  let paramCounter = 0

  function gen(node: CharFnTrieNode, slugAssigns: readonly string[]): string {
    let code = ""
    if (node.methods.size > 0) {
      code += `if (i === len) {\n`
      for (const [method, idx] of node.methods) {
        const slugsObj = slugAssigns.length > 0 ? `{ ${slugAssigns.join(", ")} }` : "{}"
        code += `if (method === ${JSON.stringify(method)}) return { handler: entries[${idx}].handler, meta: entries[${idx}].meta, sources: entries[${idx}].sources, slugs: ${slugsObj} }\n`
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
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- deliberate: this IS the "compiled char-level function" architecture
  const fn = new Function("s", "method", "entries", body) as (
    s: string,
    method: string,
    entries: readonly CollectedRoute[],
  ) => RouteMatch | undefined

  return (pathname, method) => fn(pathname, method, routes)
}

export function compiledCharMatcher(route: HttpRoute): Matcher {
  return buildCompiledCharMatcher(collectRoutes(route, []))
}

export function compiledCharRouter(route: HttpRoute): CompiledRouter {
  return toRouter(compiledCharMatcher(route))
}

// ============================================================================
// mapMatcher — static-only `Map<pathname, Record<method, entry>>` (the
// static half of route.bench.ts architecture 8). Only serves routes whose
// path has no dynamic segment; a route with a `:param` anywhere is silently
// excluded (composed with a dynamic matcher via `chainMatchers`/`mapCharRouter`).
// ============================================================================

function buildMapMatcher(routes: readonly CollectedRoute[]): Matcher {
  const map = new Map<string, Record<string, CollectedRoute>>()
  for (const route of routes) {
    let methods = map.get(route.path)
    if (methods === undefined) {
      methods = {}
      map.set(route.path, methods)
    }
    methods[route.method] = route
  }
  return (pathname, method) => {
    const entry = map.get(pathname)?.[method]
    return entry !== undefined
      ? {
          handler: entry.handler,
          meta: entry.meta,
          ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
          slugs: {},
        }
      : undefined
  }
}

export function mapMatcher(route: HttpRoute): Matcher {
  return buildMapMatcher(collectRoutes(route, []).filter((r) => !isDynamicPath(r.path)))
}

// ============================================================================
// mapCharRouter — the specialized hybrid (route.bench.ts architecture 8):
// static routes go into a `Map` (one hash lookup, no traversal); dynamic
// routes ONLY feed a compiled char fn, producing a smaller generated
// function than compiling the whole tree would. `Map.get` first, fall
// through to the compiled char fn on a miss.
// ============================================================================

export function mapCharRouter(route: HttpRoute): CompiledRouter {
  const routes = collectRoutes(route, [])
  const staticMatcher = buildMapMatcher(routes.filter((r) => !isDynamicPath(r.path)))
  const dynamicMatcher = buildCompiledCharMatcher(routes.filter((r) => isDynamicPath(r.path)))
  return toRouter(chainMatchers(staticMatcher, dynamicMatcher))
}

// ============================================================================
// withALS — per-request AsyncLocalStorage context, composable over any
// `CompiledRouter`. `runRoute` (route.ts) is a clean linear `await` chain
// with no concurrent branches in flight, so a context entered once per
// request via `storage.run` stays correctly scoped to that request's whole
// dispatch — no leakage across concurrent requests, no manual propagation
// needed at each stage.
// ============================================================================

/**
 * Wrap `router` so every request runs inside its own `AsyncLocalStorage`
 * context. `init` computes the per-request context value from the incoming
 * `Request`; `router` (and everything it calls, transitively) can then read
 * it via `storage.getStore()`. Composable: since the return type is itself a
 * `CompiledRouter`, `withALS` can wrap the output of `radixRouter`,
 * `toRouter`, `makeRouterFromRoute`, or another `withALS` layer.
 */
export function withALS<T>(
  router: CompiledRouter,
  storage: AsyncLocalStorage<T>,
  init: (req: Request) => T,
): CompiledRouter {
  return (req) => storage.run(init(req), () => router(req))
}
