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
//      `applyMethods`, `applyMoveTo`, `applyResponse`. `composeTransforms`
//      chains them into a single `HttpRoute => HttpRoute`.
//   4. `makeRouterFromRoute` — the simple exact-path/method dispatcher over
//      an `HttpRoute` tree (no attribute dispatch, no match conditions —
//      those remain the direct tree-walk dispatcher's domain; see project.ts).

import { isLeaf } from "@rhi-zone/fractal-core/node"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-core/node"
import type { Result } from "@rhi-zone/fractal-core"
import type { HttpDirective } from "./project.ts"
import { bulkCollect, httpStores, primaryStoreForMethod, assemble } from "./decode.ts"
import type { SourceMap } from "./decode.ts"

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
  /**
   * Full custom decode override — when provided, the stores-based system is
   * bypassed entirely and this function is responsible for producing the
   * handler's input from the raw request. Backward-compatible: existing
   * `decode: (req, meta) => input` pipelines continue to work unchanged.
   */
  decode?: (req: Request, meta: Meta) => unknown | Promise<unknown>
  /**
   * Declarative source configuration for the stores-based decode system.
   * Only takes effect when `decode` is NOT set (the function override wins).
   *
   * - `sourceMap`: per-param overrides — e.g. `{ apiKey: { store: "header", key: "x-api-key" } }`
   * - `paramNames`: explicit list of param names to extract (when absent,
   *    bulk-collects all available values — backward compat with old defaultDecode)
   * - `transform`: optional reshape after assembly, before the handler sees the input
   */
  sources?: {
    readonly sourceMap?: SourceMap
    readonly paramNames?: readonly string[]
    readonly transform?: (bag: Record<string, unknown>) => Record<string, unknown>
  }
  inputTransforms?: Array<(input: unknown, meta: Meta) => unknown | Promise<unknown>>
  /**
   * Validate + coerce the assembled input bag after inputTransforms run.
   * Run sequentially, in array order: each validator's `Ok` value feeds the
   * next validator's input; the first `Err` short-circuits the whole chain
   * with a 400 response containing that error (later validators do not run).
   * When absent or empty, input passes through to the handler unchanged.
   */
  validate?: Array<
    (input: Record<string, unknown>) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>
  >
  outputTransforms?: Array<(output: unknown, meta: Meta) => unknown | Promise<unknown>>
  encode?: (output: unknown, meta: Meta) => Response | Promise<Response>
  resTransforms?: Array<(res: Response, meta: Meta) => Response | Promise<Response>>
}

// ============================================================================
// HttpRoute type + constructor
// ============================================================================

/**
 * Generic in `H` (a method entry's own handler type), defaulting to the
 * erased `Handler` — same convention as `Node<H>` (see node.ts). Plain
 * `HttpRoute` (no type argument) keeps working everywhere it's used as an
 * erased type (dispatch, `Record<string, HttpRoute>`, etc.); only the
 * type-preserving rewriters below (`naiveTransform`, `applyMethods`,
 * `applyResponse`, `createApplyValidation`) lean on the generic via their own
 * recursively-computed return types — nothing else has to opt in.
 */
export type HttpRoute<H extends Handler = Handler> = {
  readonly methods?: Readonly<
    Record<string, { readonly handler: H; readonly meta: Meta; readonly pipeline?: Pipeline }>
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

/**
 * The precise `HttpRoute` shape `naiveTransform` produces for a given input
 * tree type `N` — computed recursively from `N`'s own children/fallback,
 * mirroring the actual leaf-into-`methods.POST`, branch-into-`children`
 * mechanics below at the type level. This is what lets `getBook`'s real
 * `(input: {id:string}) => Book` signature survive `naiveTransform` as
 * `route.children.getBook.methods.POST.handler`, instead of widening to the
 * erased `Handler`.
 *
 * Each branch below is a plain conditional (not `infer ... : never`) so a
 * node that is neither/both leaf-and-branch contributes exactly the fields it
 * has — `Node`'s own optional fields never leak in as "present but any",
 * because `op()`'s return type marks `handler` as present (not optional)
 * when it truly is a leaf; a pure branch's type has no `handler` key at all
 * to match against.
 *
 * `fallback.subtree`'s precision is only as good as what `api()` was handed —
 * `api()`'s own return type doesn't thread a generic through `opts.fallback`
 * (see node.ts), so a fallback subtree is typically already the erased `Node`
 * by the time it reaches here; this type still recurses correctly in that
 * case, just inherits that upstream limitation rather than papering over it.
 */
export type NaiveRoute<N extends Node> =
  & (N extends { readonly handler: infer H extends Handler }
      ? { readonly methods: { readonly POST: { readonly handler: H; readonly meta: Meta } } }
      : {})
  & (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? { readonly children: { readonly [K in keyof C]: NaiveRoute<C[K]> } }
      : {})
  & (N extends { readonly fallback: { readonly name: infer Nm extends string; readonly subtree: infer S extends Node } }
      ? { readonly fallback: { readonly name: Nm; readonly subtree: NaiveRoute<S> } }
      : {})
  & { readonly meta: Meta }

export function naiveTransform<N extends Node>(node: N): NaiveRoute<N> {
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
  return httpRoute({ methods, children, fallback, meta: node.meta }) as NaiveRoute<N>
}

// ============================================================================
// 2a. applyMethods — reads `{ kind: "method", value }` directives from a
// method entry's own meta and renames the method key accordingly (POST, the
// naiveTransform default, becomes GET/PUT/DELETE/…).
// ============================================================================

/**
 * The `HttpRoute` shape after `applyMethods` rewrites a tree of type `R`.
 * The rename target (`directive.value`) comes out of the open `meta` bag as
 * a plain runtime `string` — never a literal type (see `HttpDirective` in
 * project.ts and `Meta` in node.ts) — so the resulting method KEY can't be
 * tracked statically; only the entry's VALUE (its handler type) survives.
 * `methods` is therefore widened to `Record<string, ...>` over the union of
 * the input methods' entry types — for the common case of a single method
 * entry (e.g. straight out of `naiveTransform`) that union has exactly one
 * member, so the handler type comes through with full precision even though
 * the key is no longer tracked.
 */
export type ApplyMethodsRoute<R extends HttpRoute> =
  & (R extends { readonly methods: infer M extends Readonly<Record<string, { readonly handler: Handler; readonly meta: Meta }>> }
      ? { readonly methods: Readonly<Record<string, M[keyof M]>> }
      : {})
  & (R extends { readonly children: infer C extends Readonly<Record<string, HttpRoute>> }
      ? { readonly children: { readonly [K in keyof C]: ApplyMethodsRoute<C[K]> } }
      : {})
  & (R extends { readonly fallback: { readonly name: infer Nm extends string; readonly subtree: infer S extends HttpRoute } }
      ? { readonly fallback: { readonly name: Nm; readonly subtree: ApplyMethodsRoute<S> } }
      : {})
  & { readonly meta: Meta }

export function applyMethods<R extends HttpRoute>(route: R): ApplyMethodsRoute<R> {
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
  return httpRoute({ methods, children, fallback, meta: route.meta }) as ApplyMethodsRoute<R>
}

// ============================================================================
// 2b. applyMoveTo — reads `{ kind: "moveTo", path }` directives and moves
// whole route subtrees within the tree, per the relative-path algebra in
// docs/design/routing-and-transforms.md:
//
//   "." (exactly)  — identity, node stays at its current position.
//   Any other path is resolved relative to the node's OWN position
//   (standard filesystem-style semantics):
//     ".."         — go up to parent
//     "../newname" — rename (sibling with a different name)
//     "*"          — push a wildcard (fallback) segment below self
//     "."          (as a path component) — no-op, stays at self
//     any other token — push that literal segment below self
//
// Two-phase: (1) walk the tree, detaching every subtree that carries a
// `moveTo` directive on its own top-level meta and recording its resolved
// absolute target path; (2) re-insert each detached subtree at its target,
// creating intermediate branch/fallback nodes as needed and merging methods
// when multiple subtrees converge on the same target (the REST-resource
// motivating example: get/update/delete all move to the same `*` position).
//
// [convention] When moveTo creates a NEW wildcard segment (no existing
// `fallback` at that position), the fallback parameter name defaults to
// `"param"` — the design doc leaves the wildcard's parameter name as coming
// "from the node's own metadata," which is not yet wired up. Prefer an
// already-present `fallback.name` at the target position when one exists.
// ============================================================================

type PendingMove = { readonly targetPath: readonly string[]; readonly subtree: HttpRoute }

function resolveMoveTo(itemPath: readonly string[], path: string): string[] {
  if (path === ".") return [...itemPath]
  const out = [...itemPath]
  for (const tok of path.split("/").filter((t) => t.length > 0)) {
    if (tok === ".") continue
    else if (tok === "..") out.pop()
    else out.push(tok)
  }
  return out
}

function isMoveToDirective(d: HttpDirective): d is Extract<HttpDirective, { kind: "moveTo" }> {
  return d.kind === "moveTo"
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
      const directive = directivesOf(child.meta).find(isMoveToDirective)
      if (directive !== undefined) {
        const target = resolveMoveTo(childPath, directive.path)
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
    const directive = directivesOf(fallback.subtree.meta).find(isMoveToDirective)
    if (directive !== undefined) {
      const target = resolveMoveTo(childPath, directive.path)
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
        `applyMoveTo: conflicting route — ${method} ${displayPath} is defined by more than one node`,
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
 * a `moveTo: "../api/v2/users"` directive — and every intermediate segment that
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
 * Applies every `moveTo` directive detached from the tree by `detach`.
 * Reinserted sequentially via `insertAt`, so conflicts between two DIFFERENT
 * placed subtrees converging on the same path+method are caught exactly like
 * a conflict between a placed subtree and a node already sitting at the
 * target — both funnel through `mergeRoutes`'s check.
 *
 * Unlike `naiveTransform`/`applyMethods`/`applyResponse`, this is NOT
 * generic over the input's handler type(s) — deliberately, not by omission.
 * `directive.path` (the move target) is a plain runtime `string` read out of
 * the open `meta` bag; TypeScript has no way to know, for a given input tree
 * type, WHERE a subtree ends up without parsing that string as a type-level
 * template literal and re-deriving the whole tree shape from it. Doing that
 * would need `HttpDirective`/`Meta` to carry a typed, literal directive
 * language instead of today's open `{ [key: string]: unknown }` bag — a
 * separate, much larger design question (typed directives), not a narrower
 * fix within this rewriter. `applyMoveTo` returns the erased `HttpRoute`
 * because moved subtrees' positions are genuinely unknowable statically, not
 * because threading the generic through was skipped.
 */
export function applyMoveTo(route: HttpRoute): HttpRoute {
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

/**
 * The `HttpRoute` shape after `applyResponse` rewrites a tree of type `R`.
 * Whether a given method entry's handler gets wrapped depends on whether a
 * `response` directive is present in its `meta` — a runtime fact, unknowable
 * statically (see `ApplyMethodsRoute` above and `applyMoveTo`'s doc comment)
 * — so each entry's resulting handler type is honestly a union of
 * "unwrapped, original type" and "wrapped, `ResponseOverride`-producing
 * type" rather than one or the other. Unlike `applyMethods`, this rewriter
 * never renames a method key, so — different from `ApplyMethodsRoute` —
 * `methods` keeps the exact key set of `M` instead of widening to
 * `Record<string, ...>`.
 */
type ResponseWrappedHandler = (input: unknown) => Promise<ResponseOverride>

export type ApplyResponseRoute<R extends HttpRoute> =
  & (R extends { readonly methods: infer M extends Readonly<Record<string, { readonly handler: Handler; readonly meta: Meta }>> }
      ? { readonly methods: { readonly [K in keyof M]: { readonly handler: M[K]["handler"] | ResponseWrappedHandler; readonly meta: Meta } } }
      : {})
  & (R extends { readonly children: infer C extends Readonly<Record<string, HttpRoute>> }
      ? { readonly children: { readonly [K in keyof C]: ApplyResponseRoute<C[K]> } }
      : {})
  & (R extends { readonly fallback: { readonly name: infer Nm extends string; readonly subtree: infer S extends HttpRoute } }
      ? { readonly fallback: { readonly name: Nm; readonly subtree: ApplyResponseRoute<S> } }
      : {})
  & { readonly meta: Meta }

export function applyResponse<R extends HttpRoute>(route: R): ApplyResponseRoute<R> {
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
  return httpRoute({ methods, children, fallback, meta: route.meta }) as ApplyResponseRoute<R>
}

// ============================================================================
// 2d. createApplyValidation — runtime injection of generated validators into
// a route tree's `pipeline.validate` slot.
//
// Unlike the other rewriters above (each a plain `HttpRoute => HttpRoute`),
// validator wiring is keyed: codegen owns a namespace of route-path →
// validator functions and hands it a KEY (typically the module/file that
// generated it), so multiple independent codegen runs can each register
// their own validator set without colliding. `createApplyValidation`
// closes over the full `ValidatorMap` and returns the `applyValidation(key,
// route)` rewriter codegen actually calls at each call site:
//
//   const applyValidation = createApplyValidation(generatedValidators)
//   const routed = applyValidation("books", httpProjection(api))
//
// A `key` not present in the map is a no-op passthrough — this is what lets
// codegen emit a stub (`createApplyValidation({})`) before any validators
// exist for a given tree, per docs/design/routing-and-transforms.md.
// ============================================================================

/** A single leaf's validator: same shape as `Pipeline["validate"]`. */
export type Validator = (
  bag: Record<string, unknown>,
) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>

/**
 * outer key = the string key passed to `applyValidation(key, route)`.
 * inner key = route path (path segments joined with `/`; a fallback segment
 * is rendered as `:name` — e.g. `"books/:bookId"` — matching the `:id`-style
 * convention used throughout the design docs).
 */
export type ValidatorMap = Record<string, Record<string, Validator>>

/** Route-path string for a tree position, fallback segments rendered as `:name`. */
function pathKey(path: readonly string[]): string {
  return path.join("/")
}

/**
 * Generic identity in `R` — unlike `applyMethods`/`applyResponse`,
 * `injectValidators` never renames a method key or replaces a handler; it
 * only appends to `entry.pipeline.validate`, whose type (`Pipeline`) is the
 * same whether or not a validator actually matched at a given tree position
 * (itself a dynamic lookup — see `forKey[pathKey(path)]` below). So the
 * input's precise type, whatever it is, is exactly the output's type; no
 * recomputed mapped type is needed the way `naiveTransform` et al. need one.
 */
function injectValidators<R extends HttpRoute>(
  route: R,
  forKey: Readonly<Record<string, Validator>>,
  path: readonly string[],
): R {
  const validator = forKey[pathKey(path)]
  let methods = route.methods
  if (methods !== undefined && validator !== undefined) {
    methods = Object.fromEntries(
      Object.entries(methods).map(([method, entry]) => [
        method,
        {
          ...entry,
          pipeline: {
            ...entry.pipeline,
            // Append — a generated validator composes alongside any
            // hand-authored ones already on this method, it never clobbers
            // them.
            validate: [...(entry.pipeline?.validate ?? []), validator],
          },
        },
      ]),
    )
  }
  const children = route.children !== undefined
    ? Object.fromEntries(
        Object.entries(route.children).map(([key, child]) => [
          key,
          injectValidators(child, forKey, [...path, key]),
        ]),
      )
    : undefined
  const fallback = route.fallback !== undefined
    ? {
        name: route.fallback.name,
        subtree: injectValidators(route.fallback.subtree, forKey, [...path, `:${route.fallback.name}`]),
      }
    : undefined
  return httpRoute({ methods, children, fallback, meta: route.meta, pipeline: route.pipeline }) as R
}

/**
 * Build an `applyValidation(key, route)` rewriter over a fixed `ValidatorMap`.
 *
 * - `key` not present in `validators` → `route` is returned unchanged (the
 *   stub/pass-through case — see `docs/design/routing-and-transforms.md`).
 * - Otherwise walks `route`, and for every leaf method whose tree position
 *   matches a path in `validators[key]`, APPENDS that validator onto the
 *   method's `pipeline.validate` array — composing alongside (not clobbering)
 *   any validators already there, hand-authored or from a prior
 *   `applyValidation` call. Other pipeline fields are untouched.
 * - Each `key` may be used at most once across the lifetime of the returned
 *   function — a second `applyValidation(sameKey, ...)` call throws. This
 *   catches accidental double-registration of the same generated validator
 *   set (e.g. codegen run twice, or two trees both claiming the same key).
 */
export function createApplyValidation(
  validators: ValidatorMap,
): <R extends HttpRoute>(key: string, route: R) => R {
  const usedKeys = new Set<string>()
  return <R extends HttpRoute>(key: string, route: R): R => {
    if (usedKeys.has(key)) {
      throw new Error(`applyValidation: key "${key}" has already been used`)
    }
    usedKeys.add(key)
    const forKey = validators[key]
    if (forKey === undefined) return route
    return injectValidators(route, forKey, [])
  }
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
 * arrays concatenate (node-level transforms run first, method-level after) —
 * `validate` is one of these array stages (node-level validators run before
 * method-level ones); single-valued stages (`decode`/`encode`) take the more
 * specific (method-level) value when both are configured.
 */
function mergePipelines(node: Pipeline | undefined, method: Pipeline | undefined): Pipeline {
  if (node === undefined) return method ?? {}
  if (method === undefined) return node
  const decode = method.decode ?? node.decode
  const sources = method.sources ?? node.sources
  const encode = method.encode ?? node.encode
  return {
    reqTransforms: [...(node.reqTransforms ?? []), ...(method.reqTransforms ?? [])],
    ...(decode !== undefined ? { decode } : {}),
    ...(sources !== undefined ? { sources } : {}),
    inputTransforms: [...(node.inputTransforms ?? []), ...(method.inputTransforms ?? [])],
    validate: [...(node.validate ?? []), ...(method.validate ?? [])],
    outputTransforms: [...(node.outputTransforms ?? []), ...(method.outputTransforms ?? [])],
    ...(encode !== undefined ? { encode } : {}),
    resTransforms: [...(node.resTransforms ?? []), ...(method.resTransforms ?? [])],
  }
}

/**
 * Split a URL pathname into non-empty segments without the split+filter
 * double allocation (`"/".split()` then `.filter(s => s.length > 0)` builds
 * two arrays; this builds one).
 */
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

/**
 * `segs`/`idx`/`slugs` walk a single path through the tree — static children
 * always win over `fallback` (see module doc), so there is never more than
 * one branch in flight at a time. That makes `slugs` safe to mutate in place
 * across the whole descent instead of spreading a fresh object per dynamic
 * segment: no sibling call ever observes a stale or partially-built copy,
 * because there is no sibling call.
 */
function collectRouteCandidates(
  route: HttpRoute,
  segs: readonly string[],
  idx: number,
  slugs: Record<string, string>,
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
    slugs[route.fallback.name] = seg
    return collectRouteCandidates(route.fallback.subtree, segs, idx + 1, slugs)
  }
  return []
}

/** All candidate methods reachable at the exact path of `url`. */
export function routeCandidatesForUrl(root: HttpRoute, url: string): RouteCandidate[] {
  const segs = splitPath(new URL(url).pathname)
  return collectRouteCandidates(root, segs, 0, {})
}

/**
 * Single-method match for the exact path of `segs`, looked up directly from
 * the leaf's `methods` map instead of building the full candidate array and
 * filtering by method afterward — the hot path `makeRouterFromRoute` runs on
 * every request. Same single-path-descent argument as
 * `collectRouteCandidates` justifies mutating `slugs` in place.
 */
function matchRoute(
  route: HttpRoute,
  segs: readonly string[],
  idx: number,
  method: string,
  slugs: Record<string, string>,
): { entry: { handler: Handler; meta: Meta; pipeline?: Pipeline }; routePipeline: Pipeline | undefined; slugs: Record<string, string> } | undefined {
  if (idx === segs.length) {
    const entry = route.methods?.[method]
    if (entry === undefined) return undefined
    return { entry, routePipeline: route.pipeline, slugs }
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

function jsonRouteResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(value), { ...init, headers })
}

/**
 * Stores-based default decode: exposes the request as named stores (path,
 * query, header, body), then assembles the handler's input bag using
 * conventions (method → primary store) + optional per-param overrides.
 *
 * When `sources.paramNames` is provided, the assembler reads exactly those
 * params from the appropriate stores. When absent (the common case until
 * codegen-derived param lists are wired in), falls back to bulk-collecting
 * all available values — producing the same flat bag the old defaultDecode
 * returned.
 *
 * The body is parsed once here and passed to the stores factory. Methods
 * that conventionally carry no body (GET/HEAD/DELETE) skip body parsing
 * entirely.
 */
async function defaultDecode(
  req: Request,
  slugs: Readonly<Record<string, string>>,
  sources?: Pipeline["sources"],
): Promise<unknown> {
  const url = new URL(req.url)
  const primary = primaryStoreForMethod(req.method)

  // Parse body for methods that conventionally carry one
  let parsedBody: unknown = undefined
  if (primary === "body") {
    const ct = req.headers.get("Content-Type") ?? ""
    if (ct.includes("application/json")) {
      parsedBody = await req.json()
    }
  }

  let bag: Record<string, unknown>

  if (sources?.paramNames !== undefined && sources.paramNames.length > 0) {
    // Declarative path: assemble from named stores using explicit param list
    const stores = httpStores(req, slugs, parsedBody)
    const pathParamNames = Object.keys(slugs)
    bag = assemble(stores, sources.paramNames, sources.sourceMap ?? {}, primary, pathParamNames)
  } else {
    // Bulk-collect path: backward compat — merge all available values
    bag = bulkCollect(slugs, url.searchParams, parsedBody, primary)
  }

  // Optional transform after assembly
  if (sources?.transform !== undefined) {
    bag = sources.transform(bag)
  }

  return bag
}

/** Default `encode`: a 200 JSON response. */
function defaultEncode(output: unknown): Response {
  return jsonRouteResponse(output, { status: 200 })
}

/** Default error encode: a 400 JSON response wrapping the error value. */
function defaultEncodeError(error: unknown): Response {
  return jsonRouteResponse({ error }, { status: 400 })
}

/**
 * Exact Result<T, E> check: matches the core `Result` DU shape
 * `{ kind: "ok", value } | { kind: "err", error }`. Only triggers when
 * `kind` is exactly `"ok"` or `"err"` — user data with an unrelated
 * `kind` field won't false-positive.
 */
function isResult(v: unknown): v is { kind: "ok"; value: unknown } | { kind: "err"; error: unknown } {
  if (typeof v !== "object" || v === null || !("kind" in v)) return false
  const kind = (v as { kind: unknown }).kind
  return kind === "ok" || kind === "err"
}

export function makeRouterFromRoute(root: HttpRoute): (req: Request) => Promise<Response> {
  return async (req) => {
    const segs = splitPath(new URL(req.url).pathname)
    const matched = matchRoute(root, segs, 0, req.method, {})
    if (matched === undefined) return new Response("Not Found", { status: 404 })

    const meta = matched.entry.meta
    const pipeline = mergePipelines(matched.routePipeline, matched.entry.pipeline)
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
        : await defaultDecode(request, matched.slugs, pipeline.sources)
    } catch {
      return jsonRouteResponse({ error: "invalid JSON body" }, { status: 400 })
    }

    try {
      for (const transform of inputTransforms) input = await transform(input, meta)

      // Validate slot: runs after inputTransforms, before handler. Sequential
      // — each validator's Ok value feeds the next validator's input; the
      // first Err short-circuits the whole chain with a 400 response.
      for (const validator of pipeline.validate ?? []) {
        const result = await validator(input as Record<string, unknown>)
        if (result.kind === "err") {
          return jsonRouteResponse({ error: result.error }, { status: 400 })
        }
        input = result.value
      }

      let output: unknown = await (matched.entry.handler(input) as Promise<unknown>)
      for (const transform of outputTransforms) output = await transform(output, meta)

      // Result unwrapping: if the handler returned a Result<T, E>, separate
      // the success and error paths before encoding. The check is exact —
      // typeof + boolean — to avoid false-positives on user data that happens
      // to have an `ok` field with a non-boolean value.
      if (isResult(output)) {
        if (output.kind === "ok") {
          output = output.value
        } else {
          let response: Response = pipeline.encode !== undefined
            ? await pipeline.encode(output.error, meta)
            : defaultEncodeError(output.error)
          for (const transform of resTransforms) response = await transform(response, meta)
          return response
        }
      }

      let response: Response = isResponseOverride(output)
        ? jsonRouteResponse(output.body, output.init)
        : pipeline.encode !== undefined
          ? await pipeline.encode(output, meta)
          : defaultEncode(output)

      for (const transform of resTransforms) response = await transform(response, meta)

      return response
    } catch {
      return jsonRouteResponse({ error: "internal server error" }, { status: 500 })
    }
  }
}
