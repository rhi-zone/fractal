// packages/http/src/route.ts — @rhi-zone/fractal-http
//
// The HTTP route tree — a SEPARATE type from the API tree (`Node`). The API
// tree is organized by domain (children are operations); the route tree is
// organized by protocol (path segments, HTTP methods). A transform pipeline
// produces the route tree from the API tree:
//
//   Node --naiveTransform--> HttpRoute --rewriters--> HttpRoute --makeRouter--> Fetch
//
// See docs/design/routing-and-transforms.md for the full design.
//
// Three pieces live here:
//   1. `HttpRoute` — the route tree type + `httpRoute()` constructor.
//   2. `naiveTransform` — the mechanical `Node => HttpRoute` baseline: every
//      child becomes a path-segment child, every handler becomes a single
//      POST entry. No inference, no convention.
//   3. Rewriters — `HttpRoute => HttpRoute` functions, each reading one kind
//      of directive from `meta.http.directives` and reshaping the tree:
//      `applyMethods`, `applyPlacement`, `applyResponse`. `composeTransforms`
//      chains them into a single `HttpRoute => HttpRoute`.
//   4. `makeRouterFromRoute` — the simple exact-path/method dispatcher over
//      an `HttpRoute` tree (no attribute dispatch, no match conditions —
//      those remain the direct tree-walk dispatcher's domain; see project.ts).

import { isLeaf } from "@rhi-zone/fractal-core/node"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-core/node"
import type { HttpDirective } from "./project.ts"

// ============================================================================
// Pipeline — interceptable request/response stages (docs/design/
// routing-and-transforms.md § "Interceptable pipeline").
//
//   Request
//     → reqTransforms  (Req => Req, in order)
//     → decode         (Request => T)
//     → inputTransforms (T => T, in order)     — audit, validation, session injection
//     → handler        (T => U)
//     → outputTransforms (U => U, in order)    — redaction, enrichment
//     → encode         (U => Response)
//     → resTransforms  (Res => Res, in order)  — CORS, compression, caching
//   Response
//
// `decode`/`encode` are the symmetric protocol boundary; every stage sees the
// operation's `Meta`. Configurable per-route (on an `HttpRoute` node) or
// per-method (on a method entry) — `makeRouterFromRoute` merges the two when
// both are present, method-level transforms running after node-level ones.
// ============================================================================

export type Pipeline = {
  reqTransforms?: Array<(req: Request, meta: Meta) => Request | Promise<Request>>
  decode?: (req: Request, meta: Meta) => unknown | Promise<unknown>
  inputTransforms?: Array<(input: unknown, meta: Meta) => unknown | Promise<unknown>>
  outputTransforms?: Array<(output: unknown, meta: Meta) => unknown | Promise<unknown>>
  encode?: (output: unknown, meta: Meta) => Response | Promise<Response>
  resTransforms?: Array<(res: Response, meta: Meta) => Response | Promise<Response>>
}

// ============================================================================
// HttpRoute type + constructor
// ============================================================================

export type HttpRoute = {
  readonly methods?: Readonly<
    Record<string, { readonly handler: Handler; readonly meta: Meta; readonly pipeline?: Pipeline }>
  >
  readonly children?: Readonly<Record<string, HttpRoute>>
  readonly fallback?: { readonly name: string; readonly subtree: HttpRoute }
  readonly meta: Meta
  readonly pipeline?: Pipeline
}

/**
 * Runtime brand for `HttpRoute` values — lets `makeRouter` distinguish an
 * `HttpRoute` from a `Node` at its overload boundary (both shapes carry
 * `children`/`meta`; the brand is the only reliable discriminator). Every
 * route produced by `httpRoute()` (and therefore by `naiveTransform` and the
 * rewriters, which all go through it) carries the brand.
 */
const routeBrand = new WeakSet<object>()

/** Construct an `HttpRoute` value. Registers the value for `isHttpRoute`. */
export function httpRoute(def: {
  methods?: Record<string, { handler: Handler; meta: Meta; pipeline?: Pipeline }> | undefined
  children?: Record<string, HttpRoute> | undefined
  fallback?: { name: string; subtree: HttpRoute } | undefined
  meta?: Meta | undefined
  pipeline?: Pipeline | undefined
}): HttpRoute {
  const route: HttpRoute = {
    ...(def.methods !== undefined ? { methods: def.methods } : {}),
    ...(def.children !== undefined ? { children: def.children } : {}),
    ...(def.fallback !== undefined ? { fallback: def.fallback } : {}),
    ...(def.pipeline !== undefined ? { pipeline: def.pipeline } : {}),
    meta: def.meta ?? {},
  }
  routeBrand.add(route)
  return route
}

/** True when `v` is an `HttpRoute` produced by `httpRoute()`. */
export function isHttpRoute(v: unknown): v is HttpRoute {
  return typeof v === "object" && v !== null && routeBrand.has(v)
}

// ============================================================================
// Directive helpers — shared by the rewriters below
// ============================================================================

function directivesOf(meta: Meta): readonly HttpDirective[] {
  const h = meta.http
  if (typeof h !== "object" || h === null) return []
  const d = (h as { directives?: unknown }).directives
  return Array.isArray(d) ? (d as HttpDirective[]) : []
}

function withoutDirective(meta: Meta, directive: HttpDirective): Meta {
  const h = meta.http as { directives?: readonly HttpDirective[] } | undefined
  if (h === undefined) return meta
  return {
    ...meta,
    http: { ...h, directives: (h.directives ?? []).filter((d) => d !== directive) },
  }
}

// ============================================================================
// 1. Naive transform: Node => HttpRoute
//
// Every child becomes a path-segment child. Every handler becomes a single
// POST entry in `methods`. Meta is copied through unchanged. Recursive.
// ============================================================================

export function naiveTransform(node: Node): HttpRoute {
  const methods = isLeaf(node)
    ? { POST: { handler: node.handler!, meta: node.meta } }
    : undefined
  const children = node.children !== undefined
    ? Object.fromEntries(
        Object.entries(node.children).map(([key, child]) => [key, naiveTransform(child)]),
      )
    : undefined
  const fallback = node.fallback !== undefined
    ? { name: node.fallback.name, subtree: naiveTransform(node.fallback.subtree) }
    : undefined
  return httpRoute({ methods, children, fallback, meta: node.meta })
}

// ============================================================================
// 2a. applyMethods — reads `{ kind: "method", value }` directives from a
// method entry's own meta and renames the method key accordingly (POST, the
// naiveTransform default, becomes GET/PUT/DELETE/…).
// ============================================================================

export function applyMethods(route: HttpRoute): HttpRoute {
  let methods = route.methods
  if (methods !== undefined) {
    const rebuilt: Record<string, { handler: Handler; meta: Meta }> = {}
    let changed = false
    for (const [key, entry] of Object.entries(methods)) {
      const directive = directivesOf(entry.meta).find(
        (d): d is Extract<HttpDirective, { kind: "method" }> => d.kind === "method",
      )
      const newKey = directive !== undefined ? directive.value.toUpperCase() : key
      if (newKey !== key) changed = true
      rebuilt[newKey] = directive !== undefined
        ? { handler: entry.handler, meta: withoutDirective(entry.meta, directive) }
        : entry
    }
    methods = changed ? rebuilt : methods
  }
  const children = route.children !== undefined
    ? Object.fromEntries(Object.entries(route.children).map(([k, c]) => [k, applyMethods(c)]))
    : undefined
  const fallback = route.fallback !== undefined
    ? { name: route.fallback.name, subtree: applyMethods(route.fallback.subtree) }
    : undefined
  return httpRoute({ methods, children, fallback, meta: route.meta })
}

// ============================================================================
// 2b. applyPlacement — reads `{ kind: "place", path }` directives and moves
// whole route subtrees within the tree, per the relative-path algebra in
// docs/design/routing-and-transforms.md:
//
//   "." (exactly)  — identity, node stays at its current position.
//   Any other path is resolved relative to the node's CONTAINING position
//   (its parent, i.e. the position with the node's own key dropped — mirrors
//   Unix "a file's '.' is the directory containing it"):
//     "."          (as a path component) — no-op, stays at the parent
//     ".."         — pop one more level
//     "*"          — push a wildcard (fallback) segment
//     any other token — push that literal segment
//
// Two-phase: (1) walk the tree, detaching every subtree that carries a
// `place` directive on its own top-level meta and recording its resolved
// absolute target path; (2) re-insert each detached subtree at its target,
// creating intermediate branch/fallback nodes as needed and merging methods
// when multiple subtrees converge on the same target (the REST-resource
// motivating example: get/update/delete all move to the same `*` position).
//
// [convention] When placement creates a NEW wildcard segment (no existing
// `fallback` at that position), the fallback parameter name defaults to
// `"param"` — the design doc leaves the wildcard's parameter name as coming
// "from the node's own metadata," which is not yet wired up. Prefer an
// already-present `fallback.name` at the target position when one exists.
// ============================================================================

type PendingMove = { readonly targetPath: readonly string[]; readonly subtree: HttpRoute }

function resolvePlacement(itemPath: readonly string[], path: string): string[] {
  if (path === ".") return [...itemPath]
  const base = itemPath.slice(0, -1)
  const out = [...base]
  for (const tok of path.split("/").filter((t) => t.length > 0)) {
    if (tok === ".") continue
    else if (tok === "..") out.pop()
    else out.push(tok)
  }
  return out
}

function isPlaceDirective(d: HttpDirective): d is Extract<HttpDirective, { kind: "place" }> {
  return d.kind === "place"
}

function detach(
  route: HttpRoute,
  path: readonly string[],
  moves: PendingMove[],
): HttpRoute {
  let children = route.children
  if (children !== undefined) {
    const rebuilt: Record<string, HttpRoute> = {}
    for (const [key, child] of Object.entries(children)) {
      const childPath = [...path, key]
      const directive = directivesOf(child.meta).find(isPlaceDirective)
      if (directive !== undefined) {
        const target = resolvePlacement(childPath, directive.path)
        const strippedChild = { ...child, meta: withoutDirective(child.meta, directive) }
        moves.push({ targetPath: target, subtree: detach(strippedChild, childPath, moves) })
        continue
      }
      rebuilt[key] = detach(child, childPath, moves)
    }
    children = rebuilt
  }

  let fallback = route.fallback
  if (fallback !== undefined) {
    const childPath = [...path, "*"]
    const directive = directivesOf(fallback.subtree.meta).find(isPlaceDirective)
    if (directive !== undefined) {
      const target = resolvePlacement(childPath, directive.path)
      const strippedChild = { ...fallback.subtree, meta: withoutDirective(fallback.subtree.meta, directive) }
      moves.push({ targetPath: target, subtree: detach(strippedChild, childPath, moves) })
      fallback = undefined
    } else {
      fallback = { name: fallback.name, subtree: detach(fallback.subtree, childPath, moves) }
    }
  }

  return httpRoute({ methods: route.methods, children, fallback, meta: route.meta })
}

/**
 * Merge an incoming subtree into the route already occupying a target
 * position — this is what makes converging placements (the REST-resource
 * motivating example: get/update/delete all landing on the same `*`
 * position) group naturally. Throws when `incoming` and `target` both define
 * the same HTTP method: two operations placed at the same path+method is a
 * genuine authoring conflict (which handler would serve the request?), not
 * something a merge can silently resolve.
 */
function mergeRoutes(target: HttpRoute, incoming: HttpRoute, path: readonly string[]): HttpRoute {
  const targetMethods = target.methods ?? {}
  const incomingMethods = incoming.methods ?? {}
  for (const method of Object.keys(incomingMethods)) {
    if (method in targetMethods) {
      const displayPath = path.length === 0 ? "/" : `/${path.join("/")}`
      throw new Error(
        `applyPlacement: conflicting route — ${method} ${displayPath} is defined by more than one node`,
      )
    }
  }
  return httpRoute({
    methods: { ...targetMethods, ...incomingMethods },
    children: { ...target.children, ...incoming.children },
    fallback: incoming.fallback ?? target.fallback,
    meta: target.meta,
  })
}

/**
 * Insert `subtree` at `targetPath` within `root`, creating intermediate
 * branch/fallback nodes along the way when they don't already exist
 * (mkdir-p: `targetPath` may name several segments deep — e.g. resolved from
 * a `place: "api/v2/users"` directive — and every intermediate segment that
 * isn't already present in the tree is created as a plain, empty `HttpRoute`
 * node so the walk can continue).
 */
function insertAt(root: HttpRoute, targetPath: readonly string[], subtree: HttpRoute, fullPath: readonly string[]): HttpRoute {
  if (targetPath.length === 0) return mergeRoutes(root, subtree, fullPath)
  const [head, ...rest] = targetPath as [string, ...string[]]

  if (head === "*") {
    const name = root.fallback?.name ?? "param"
    const base = root.fallback?.subtree ?? httpRoute({ meta: {} })
    return httpRoute({
      methods: root.methods,
      children: root.children,
      fallback: { name, subtree: insertAt(base, rest, subtree, fullPath) },
      meta: root.meta,
    })
  }

  // mkdir-p: create the intermediate node when it doesn't already exist.
  const base = root.children?.[head] ?? httpRoute({ meta: {} })
  return httpRoute({
    methods: root.methods,
    children: { ...root.children, [head]: insertAt(base, rest, subtree, fullPath) },
    fallback: root.fallback,
    meta: root.meta,
  })
}

/**
 * Applies every `place` directive detached from the tree by `detach`.
 * Reinserted sequentially via `insertAt`, so conflicts between two DIFFERENT
 * placed subtrees converging on the same path+method are caught exactly like
 * a conflict between a placed subtree and a node already sitting at the
 * target — both funnel through `mergeRoutes`'s check.
 */
export function applyPlacement(route: HttpRoute): HttpRoute {
  const moves: PendingMove[] = []
  const stripped = detach(route, [], moves)
  return moves.reduce((acc, m) => insertAt(acc, m.targetPath, m.subtree, m.targetPath), stripped)
}

// ============================================================================
// 2c. applyResponse — reads `{ kind: "response", status?, headers? }`
// directives and wraps the handler (function composition, NOT metadata on
// the route) so it produces a value carrying the response override. The
// override is materialized into the handler's return value via a branded
// wrapper that `makeRouterFromRoute` (and any other HttpRoute consumer)
// recognizes; everything else about the handler is untouched.
// ============================================================================

const RESPONSE_OVERRIDE = Symbol("httpResponseOverride")

export type ResponseOverride = {
  readonly [RESPONSE_OVERRIDE]: true
  readonly body: unknown
  readonly init: ResponseInit
}

export function isResponseOverride(v: unknown): v is ResponseOverride {
  return typeof v === "object" && v !== null && RESPONSE_OVERRIDE in v
}

function wrapResponse(
  handler: Handler,
  status: number | undefined,
  headers: Record<string, string> | undefined,
): Handler {
  return async (input: unknown) => {
    const body: unknown = await handler(input)
    const init: ResponseInit = {}
    if (status !== undefined) init.status = status
    if (headers !== undefined) init.headers = headers
    const override: ResponseOverride = { [RESPONSE_OVERRIDE]: true, body, init }
    return override
  }
}

export function applyResponse(route: HttpRoute): HttpRoute {
  let methods = route.methods
  if (methods !== undefined) {
    const rebuilt: Record<string, { handler: Handler; meta: Meta }> = {}
    let changed = false
    for (const [key, entry] of Object.entries(methods)) {
      const directive = directivesOf(entry.meta).find(
        (d): d is Extract<HttpDirective, { kind: "response" }> => d.kind === "response",
      )
      if (directive === undefined) {
        rebuilt[key] = entry
        continue
      }
      changed = true
      rebuilt[key] = {
        handler: wrapResponse(entry.handler, directive.status, directive.headers),
        meta: withoutDirective(entry.meta, directive),
      }
    }
    methods = changed ? rebuilt : methods
  }
  const children = route.children !== undefined
    ? Object.fromEntries(Object.entries(route.children).map(([k, c]) => [k, applyResponse(c)]))
    : undefined
  const fallback = route.fallback !== undefined
    ? { name: route.fallback.name, subtree: applyResponse(route.fallback.subtree) }
    : undefined
  return httpRoute({ methods, children, fallback, meta: route.meta })
}

// ============================================================================
// 3. composeTransforms — chain rewriters into a single Tree => Tree
// ============================================================================

export function composeTransforms(
  ...transforms: Array<(r: HttpRoute) => HttpRoute>
): (r: HttpRoute) => HttpRoute {
  return (r) => transforms.reduce((acc, t) => t(acc), r)
}

// ============================================================================
// 4. makeRouterFromRoute — simple exact-path/method dispatcher over an
// HttpRoute tree. No attribute dispatch, no match conditions, no legacyPath
// — those remain the direct tree-walk (`Node`) dispatcher's domain. This is
// the dispatcher for the new, simpler HttpRoute model: path comes purely
// from tree structure (children keys + fallback), method from the `methods`
// key.
// ============================================================================

type RouteCandidate = {
  readonly method: string
  readonly handler: Handler
  readonly meta: Meta
  readonly slugs: Readonly<Record<string, string>>
  readonly pipeline: Pipeline
}

/**
 * Merge a route node's pipeline with a method entry's pipeline. Transform
 * arrays concatenate (node-level transforms run first, method-level after);
 * single-valued stages (`decode`/`encode`) take the more specific
 * (method-level) value when both are configured.
 */
function mergePipelines(node: Pipeline | undefined, method: Pipeline | undefined): Pipeline {
  if (node === undefined) return method ?? {}
  if (method === undefined) return node
  const decode = method.decode ?? node.decode
  const encode = method.encode ?? node.encode
  return {
    reqTransforms: [...(node.reqTransforms ?? []), ...(method.reqTransforms ?? [])],
    ...(decode !== undefined ? { decode } : {}),
    inputTransforms: [...(node.inputTransforms ?? []), ...(method.inputTransforms ?? [])],
    outputTransforms: [...(node.outputTransforms ?? []), ...(method.outputTransforms ?? [])],
    ...(encode !== undefined ? { encode } : {}),
    resTransforms: [...(node.resTransforms ?? []), ...(method.resTransforms ?? [])],
  }
}

function collectRouteCandidates(
  route: HttpRoute,
  segs: readonly string[],
  idx: number,
  slugs: Readonly<Record<string, string>>,
): RouteCandidate[] {
  if (idx === segs.length) {
    return Object.entries(route.methods ?? {}).map(([method, entry]) => ({
      method,
      handler: entry.handler,
      meta: entry.meta,
      slugs,
      pipeline: mergePipelines(route.pipeline, entry.pipeline),
    }))
  }
  const seg = segs[idx]!
  const child = route.children?.[seg]
  if (child !== undefined) {
    return collectRouteCandidates(child, segs, idx + 1, slugs)
  }
  if (route.fallback !== undefined) {
    return collectRouteCandidates(route.fallback.subtree, segs, idx + 1, {
      ...slugs,
      [route.fallback.name]: seg,
    })
  }
  return []
}

/** All candidate methods reachable at the exact path of `url`. */
export function routeCandidatesForUrl(root: HttpRoute, url: string): RouteCandidate[] {
  const segs = new URL(url).pathname.split("/").filter((s) => s.length > 0)
  return collectRouteCandidates(root, segs, 0, {})
}

function jsonRouteResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(value), { ...init, headers })
}

/**
 * Default `decode`: merges fallback slugs and query params into the input
 * object (unconditionally — they're part of the request's address, not its
 * body), then adds the JSON body for methods that conventionally carry one.
 * `GET`/`HEAD`/`DELETE` never attempt to read a body. [placeholder] — real
 * input parsing (headers, cookies, richer body negotiation) is still open;
 * see docs/design/routing-and-transforms.md § "Interceptable pipeline".
 */
async function defaultDecode(req: Request, slugs: Readonly<Record<string, string>>): Promise<unknown> {
  const input: Record<string, unknown> = { ...slugs }
  const url = new URL(req.url)
  for (const [k, v] of url.searchParams) input[k] = v

  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return input

  const ct = req.headers.get("Content-Type") ?? ""
  if (ct.includes("application/json")) {
    const body: unknown = await req.json()
    if (typeof body === "object" && body !== null) Object.assign(input, body)
  }
  return input
}

/** Default `encode`: a 200 JSON response. */
function defaultEncode(output: unknown): Response {
  return jsonRouteResponse(output, { status: 200 })
}

export function makeRouterFromRoute(root: HttpRoute): (req: Request) => Promise<Response> {
  return async (req) => {
    const candidates = routeCandidatesForUrl(root, req.url)
    const matched = candidates.find((c) => c.method === req.method)
    if (matched === undefined) return new Response("Not Found", { status: 404 })

    const { meta, pipeline } = matched
    const reqTransforms = pipeline.reqTransforms ?? []
    const inputTransforms = pipeline.inputTransforms ?? []
    const outputTransforms = pipeline.outputTransforms ?? []
    const resTransforms = pipeline.resTransforms ?? []

    let request = req
    for (const transform of reqTransforms) request = await transform(request, meta)

    let input: unknown
    try {
      input = pipeline.decode !== undefined
        ? await pipeline.decode(request, meta)
        : await defaultDecode(request, matched.slugs)
    } catch {
      return jsonRouteResponse({ error: "invalid JSON body" }, { status: 400 })
    }

    try {
      for (const transform of inputTransforms) input = await transform(input, meta)

      let output: unknown = await (matched.handler(input) as Promise<unknown>)
      for (const transform of outputTransforms) output = await transform(output, meta)

      let response: Response = isResponseOverride(output)
        ? jsonRouteResponse(output.body, output.init)
        : pipeline.encode !== undefined
          ? await pipeline.encode(output, meta)
          : defaultEncode(output)

      for (const transform of resTransforms) response = await transform(response, meta)

      return response
    } catch (e: unknown) {
      return jsonRouteResponse({ error: String(e) }, { status: 500 })
    }
  }
}
