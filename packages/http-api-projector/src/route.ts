// packages/http-api-projector/src/route.ts — @rhi-zone/fractal-http-api-projector
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
//
// Dispatch (decode → handler → encode) is NOT an interceptable multi-stage
// pipeline — that abstraction (reqTransforms/inputTransforms/validate/
// outputTransforms/resTransforms, plus per-route `decode`/`encode`
// overrides) was removed: nothing in this codebase used those hooks outside
// of tests exercising the mechanism itself. AOT-COMPILED validation happens
// at the `Node` level, before this file's transforms ever run — see
// `@rhi-zone/fractal-api-tree/build`'s `wrapValidators`, which wraps a
// leaf's handler directly. What's left here is `runRoute` (below): decode
// the request via `sources` (still genuinely per-route — each route has its
// own parameter names and source overrides), optionally run a Standard
// Schema validator declared via `http.validate()` (verbs.ts) against the
// decoded input, call the handler, encode the response. Simple, linear, no
// loop over stage arrays — the one added step (Standard Schema validation)
// is a fixed, single check on `sources.validate`, not a re-introduction of
// the removed interceptable-array abstraction.

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import {
  composeErrorEncoders,
  isCursorPage,
  isOffsetPage,
  isPageShape,
  isResultShape,
  isStreamChunk,
  isStreamProgress,
  matchKind,
} from "@rhi-zone/fractal-api-tree"
import type { DetectionOptions, ErrorEncoder, Page, Stores } from "@rhi-zone/fractal-api-tree"
import type { HttpDirective } from "./project.ts"
import { httpStores, primaryStoreForMethod, assemble, parseRequestBody, runStandardSchema } from "./decode.ts"
import type { ParamSource, SourceMap, StandardSchemaV1 } from "./decode.ts"

// ============================================================================
// Sources — declarative per-route decode configuration. Real, protocol-
// specific work (which store a param comes from), not part of any removed
// interceptable-pipeline machinery.
// ============================================================================

export type Sources = {
  /** per-param overrides — e.g. `{ apiKey: { store: "header", key: "x-api-key" } }` */
  readonly sourceMap?: SourceMap
  /** explicit list of param names to extract (when absent, bulk-collects all available values) */
  readonly paramNames?: readonly string[]
  /** optional reshape after assembly, before the handler sees the input */
  readonly transform?: (bag: Record<string, unknown>) => Record<string, unknown>
  /**
   * A Standard Schema (https://standardschema.dev/) validator attached via
   * `http.validate()` (verbs.ts) — run by `runRoute` against the assembled
   * input, after decode/transform and before the handler. See
   * `http.validate()`'s own doc comment for the full contract.
   */
  readonly validate?: StandardSchemaV1
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
 * `applyResponse`) lean on the generic via their own recursively-computed
 * return types — nothing else has to opt in.
 */
export type HttpRoute<H extends Handler = Handler> = {
  readonly methods?: Readonly<
    Record<string, { readonly handler: H; readonly meta: Meta; readonly sources?: Sources }>
  >
  readonly children?: Readonly<Record<string, HttpRoute>>
  readonly fallback?: { readonly name: string; readonly subtree: HttpRoute }
  readonly meta: Meta
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
  methods?: Record<string, { handler: Handler; meta: Meta; sources?: Sources }> | undefined
  children?: Record<string, HttpRoute> | undefined
  fallback?: { name: string; subtree: HttpRoute } | undefined
  meta?: Meta | undefined
}): HttpRoute {
  const route: HttpRoute = {
    ...(def.methods !== undefined ? { methods: def.methods } : {}),
    ...(def.children !== undefined ? { children: def.children } : {}),
    ...(def.fallback !== undefined ? { fallback: def.fallback } : {}),
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

/**
 * Resolves `meta.http.sourceMap` — the `{ kind: "source", map }` directives
 * `http.source()` (verbs.ts) appends, folded into a single `SourceMap` — back
 * out of a node/entry's meta. Folds in array order: a param name repeated
 * across multiple `http.source()` calls resolves to the LATER call's entry,
 * same "later wins per key" convention `getHttpMeta` (project.ts) applies for
 * its own copy of this same resolution (this function is route.ts's OWN copy,
 * not a call to `getHttpMeta` — route.ts can't import project.ts, since
 * project.ts imports FROM route.ts and a reverse import would cycle).
 */
function sourceMapOf(meta: Meta): SourceMap | undefined {
  let merged: Record<string, ParamSource> | undefined
  for (const d of directivesOf(meta)) {
    if (d.kind === "source") merged = { ...merged, ...d.map }
  }
  return merged
}

/**
 * Resolves `meta.http`'s `{ kind: "validate", schema }` directive
 * (`http.validate()`, verbs.ts) back out of a node/entry's meta — the LAST
 * such directive wins (single-valued, unlike `sourceMapOf`'s per-key fold
 * above; a leaf attaching more than one validator is replacing the prior
 * one, not composing with it — same "later wins" convention `getHttpMeta`
 * (project.ts) already applies to `verb`/`method`/`moveTo`/`response`).
 */
function validateOf(meta: Meta): StandardSchemaV1 | undefined {
  let schema: StandardSchemaV1 | undefined
  for (const d of directivesOf(meta)) {
    if (d.kind === "validate") schema = d.schema
  }
  return schema
}

/**
 * Resolves `meta.http`'s `{ kind: "paginated" }` directive (`paginated()`,
 * verbs.ts) back out of a node/entry's meta — the LAST such directive wins,
 * same "later wins" convention `validateOf` above applies. Route.ts's OWN
 * copy of this resolution, not a call to `getHttpMeta` (project.ts) — same
 * reason `sourceMapOf`/`validateOf` above are self-contained: project.ts
 * imports FROM route.ts, so a reverse import would cycle.
 */
function paginatedDirectiveOf(
  meta: Meta,
): Extract<HttpDirective, { readonly kind: "paginated" }> | undefined {
  let directive: Extract<HttpDirective, { readonly kind: "paginated" }> | undefined
  for (const d of directivesOf(meta)) {
    if (d.kind === "paginated") directive = d
  }
  return directive
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
 *
 * `sources` is always OPTIONAL here, regardless of whether the input leaf's
 * meta actually carries `http.source()` directives — whether it does is a
 * runtime fact read out of the open `meta` bag (`sourceMapOf`, below), not
 * something knowable from `N`'s static shape, so the type can't narrow it to
 * "present" the way `handler`/`meta` are.
 */
export type NaiveRoute<N extends Node> =
  & (N extends { readonly handler: infer H extends Handler }
      ? { readonly methods: { readonly POST: { readonly handler: H; readonly meta: Meta; readonly sources?: Sources } } }
      : {})
  & (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? { readonly children: { readonly [K in keyof C]: NaiveRoute<C[K]> } }
      : {})
  & (N extends { readonly fallback: { readonly name: infer Nm extends string; readonly subtree: infer S extends Node } }
      ? { readonly fallback: { readonly name: Nm; readonly subtree: NaiveRoute<S> } }
      : {})
  & { readonly meta: Meta }

export function naiveTransform<N extends Node>(node: N): NaiveRoute<N> {
  const sourceMap = sourceMapOf(node.meta)
  const validateSchema = validateOf(node.meta)
  const sources: Sources | undefined =
    sourceMap !== undefined || validateSchema !== undefined
      ? {
          ...(sourceMap !== undefined ? { sourceMap } : {}),
          ...(validateSchema !== undefined ? { validate: validateSchema } : {}),
        }
      : undefined
  const methods = isLeaf(node)
    ? {
        POST: {
          handler: node.handler!,
          meta: node.meta,
          ...(sources !== undefined ? { sources } : {}),
        },
      }
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
// Shared visitor — walks children/fallback so individual rewriters only need
// to express their own per-node transform.
// ============================================================================

/**
 * Pre-order tree visitor shared by the rewriters below that don't need extra
 * context (path accumulation, etc.) beyond the current node. `fn` transforms
 * a single node — its own `methods`/`meta` — and returns it; `mapRoute` is
 * responsible for the recursion into `children`/`fallback`, applying `fn` to
 * `route` FIRST, then recursing into the fields of the result. Pre-order
 * (rather than post-order) is the right choice here because none of
 * `applyMethods`/`applyResponse` read a node's children to decide how to
 * transform that node — each only inspects the node's own `methods`/`meta`
 * — so the two orders are behaviorally identical for them; pre-order is
 * picked because it lets `fn` return an entirely different node before its
 * children are visited, matching how each rewriter already reads (transform
 * self, then thread through children/fallback).
 *
 * Not generic over `HttpRoute<H>`'s handler-type parameter — like
 * `applyMoveTo`, a caller-supplied `fn: HttpRoute => HttpRoute` can't
 * preserve a specific `H` through the type system without re-deriving a
 * mapped type per call site (see `ApplyMethodsRoute`/`ApplyResponseRoute`
 * above), which is exactly why `applyMethods`/`applyResponse` keep their own
 * hand-written recursion instead of delegating to `mapRoute` — they need the
 * type-preserving variant. `mapRoute` is the erased-type building block for
 * rewriters that don't need that precision, and for any user-authored
 * rewriter reaching for it via the package export.
 */
export function mapRoute(route: HttpRoute, fn: (node: HttpRoute) => HttpRoute): HttpRoute {
  const mapped = fn(route)
  const children = mapped.children !== undefined
    ? Object.fromEntries(Object.entries(mapped.children).map(([k, c]) => [k, mapRoute(c, fn)]))
    : undefined
  const fallback = mapped.fallback !== undefined
    ? { name: mapped.fallback.name, subtree: mapRoute(mapped.fallback.subtree, fn) }
    : undefined
  return httpRoute({ methods: mapped.methods, children, fallback, meta: mapped.meta })
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
  return mapRoute(route, (node) => {
    let methods = node.methods
    if (methods !== undefined) {
      const rebuilt: Record<string, { handler: Handler; meta: Meta; sources?: Sources }> = {}
      let changed = false
      for (const [key, entry] of Object.entries(methods)) {
        const directive = directivesOf(entry.meta).find(
          (d): d is Extract<HttpDirective, { kind: "method" }> => d.kind === "method",
        )
        const newKey = directive !== undefined ? directive.value.toUpperCase() : key
        if (newKey !== key) changed = true
        rebuilt[newKey] = directive !== undefined
          ? {
              handler: entry.handler,
              meta: withoutDirective(entry.meta, directive),
              ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
            }
          : entry
      }
      methods = changed ? rebuilt : methods
    }
    return httpRoute({ methods, children: node.children, fallback: node.fallback, meta: node.meta })
  }) as ApplyMethodsRoute<R>
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
  return mapRoute(route, (node) => {
    let methods = node.methods
    if (methods !== undefined) {
      const rebuilt: Record<string, { handler: Handler; meta: Meta; sources?: Sources }> = {}
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
          ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
        }
      }
      methods = changed ? rebuilt : methods
    }
    return httpRoute({ methods, children: node.children, fallback: node.fallback, meta: node.meta })
  }) as ApplyResponseRoute<R>
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
}

/**
 * Split a URL pathname into non-empty segments without the split+filter
 * double allocation (`"/".split()` then `.filter(s => s.length > 0)` builds
 * two arrays; this builds one).
 */
export function splitPath(pathname: string): string[] {
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
): { entry: { handler: Handler; meta: Meta; sources?: Sources }; slugs: Record<string, string> } | undefined {
  if (idx === segs.length) {
    const entry = route.methods?.[method]
    if (entry === undefined) return undefined
    return { entry, slugs }
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

/**
 * True when `v` is an async iterable — a handler that returns one is
 * streamed (see `streamAsSse` below) instead of buffered through
 * `defaultEncode`. Structural (`Symbol.asyncIterator` presence), matching
 * how `isResultShape`/`isResponseOverride` recognize their shapes: a runtime
 * check on the returned value, not a static handler-type annotation.
 */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  )
}

const encoder = new TextEncoder()

/** Format one SSE frame: `event: <name>\ndata: <json>\n\n` (event line
 *  omitted for the unnamed/default event, matching the SSE spec). */
function sseFrame(data: unknown, event?: string): Uint8Array {
  const lines: string[] = []
  if (event !== undefined) lines.push(`event: ${event}`)
  lines.push(`data: ${JSON.stringify(data)}`)
  lines.push("", "")
  return encoder.encode(lines.join("\n"))
}

/**
 * Encode an async iterable handler result as a Server-Sent Events response.
 * Each yielded value is inspected: `StreamProgress`/`StreamChunk` (see
 * `@rhi-zone/fractal-api-tree`) become `event: progress`/plain `data:`
 * frames respectively (a chunk's own `data` field is unwrapped so the SSE
 * payload is the inner value, not the `{ kind: "chunk", data }` wrapper);
 * any other yielded value falls back to a plain `data:` frame, untagged.
 * The generator's return value (its completion payload, distinct from what
 * it yields) is sent as a final `event: done` frame before the stream
 * closes — this is why the loop below uses a manual `.next()` call instead
 * of `for await`, which discards a generator's return value.
 */
function streamAsSse(iterable: AsyncIterable<unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const iterator = iterable[Symbol.asyncIterator]()
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done) {
            controller.enqueue(sseFrame(step.value, "done"))
            break
          }
          const value: unknown = step.value
          if (isStreamProgress(value)) {
            const { kind: _kind, ...progress } = value
            controller.enqueue(sseFrame(progress, "progress"))
          } else if (isStreamChunk(value)) {
            controller.enqueue(sseFrame(value.data))
          } else {
            controller.enqueue(sseFrame(value))
          }
        }
      } catch (error) {
        controller.error(error)
        return
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function jsonRouteResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(value), { ...init, headers })
}

/**
 * Encode a `ResponseOverride` into a `Response` — the counterpart to
 * `jsonRouteResponse` for the override path. Historically every override
 * body was `JSON.stringify`'d regardless of shape, which broke binary
 * responses, streams, and anything already serialized by the handler. Now:
 *
 *   - `body instanceof Response` — the handler built the whole response
 *     itself (its own headers/status/body); return it directly, `init` is
 *     ignored (there is nothing left to merge it into).
 *   - `ReadableStream` / `ArrayBuffer` / `Uint8Array` / `Blob` / `null` /
 *     `undefined` — already a valid `BodyInit` (or an intentionally empty
 *     body); passed straight to `new Response()` with `init` untouched, so
 *     whatever Content-Type the handler set on `init.headers` survives
 *     unmangled.
 *   - `string` — ambiguous: could be a plain-text/HTML body the handler
 *     already serialized, or a `Node` handler's raw JSON-shaped output that
 *     happens to be typed as `string`. Disambiguated via `init.headers`: an
 *     EXPLICIT non-JSON Content-Type means the handler already serialized
 *     the body itself, so it passes through as-is; otherwise falls back to
 *     the original `JSON.stringify` behavior for backwards compatibility.
 *   - anything else (objects, numbers, arrays, …) — unchanged: JSON.stringify
 *     via `jsonRouteResponse`.
 */
function encodeOverride(override: ResponseOverride): Response {
  const { body, init } = override

  if (body instanceof Response) return body

  if (
    body instanceof ReadableStream ||
    body instanceof ArrayBuffer ||
    body instanceof Uint8Array ||
    body instanceof Blob ||
    body === null ||
    body === undefined
  ) {
    return new Response(body as BodyInit | null | undefined, init)
  }

  if (typeof body === "string") {
    const headers = new Headers(init?.headers)
    const contentType = headers.get("Content-Type")
    const isExplicitlyNonJson = contentType !== null && !contentType.includes("application/json")
    if (isExplicitlyNonJson) return new Response(body, { ...init, headers })
  }

  return jsonRouteResponse(body, init)
}

/**
 * Stores-based decode: exposes the request as named stores (path, query,
 * header, body), then assembles the handler's input bag using conventions
 * (method → primary store) + optional per-param overrides declared via
 * `sources` on the matched method entry.
 *
 * When `sources.paramNames` is provided, the assembler reads exactly those
 * params from the appropriate stores. When absent (no codegen-derived param
 * list wired in for this route), `paramNames` is computed the same way
 * cli-api-projector's `buildInput` and mcp-api-projector's `assembleInput`
 * do: the union of every key any store could actually produce (path slugs,
 * query keys, body keys) plus any name declared purely via `sourceMap` —
 * then run through the same `assemble` call as the declarative path. No
 * separate bulk-merge codepath.
 *
 * The body is parsed once here, via `parseRequestBody` (decode.ts) — which
 * one is JSON, multipart, url-encoded, text, or binary based on
 * Content-Type. Methods that conventionally carry no body (GET/HEAD/DELETE)
 * skip body parsing entirely.
 *
 * Returns the `stores` alongside the assembled `input` bag — `stores` is
 * threaded into `HttpHandlerMiddleware` (see below), which sees both the
 * assembled input AND the raw pre-assembly stores; the handler itself only
 * ever sees `input`.
 */
async function defaultDecode(
  req: Request,
  slugs: Readonly<Record<string, string>>,
  sources?: Sources,
): Promise<{ readonly input: unknown; readonly stores: Stores }> {
  const url = new URL(req.url)
  const primary = primaryStoreForMethod(req.method)

  // Parse body for methods that conventionally carry one — Content-Type
  // drives which WHATWG parser handles it (see `parseRequestBody`).
  let parsedBody: unknown = undefined
  if (primary === "body") {
    parsedBody = await parseRequestBody(req)
  }

  const stores = httpStores(req, slugs, parsedBody)
  const pathParamNames = Object.keys(slugs)
  const sourceMap = sources?.sourceMap ?? {}

  const paramNames =
    sources?.paramNames !== undefined && sources.paramNames.length > 0
      ? sources.paramNames
      : [
          ...new Set([
            ...pathParamNames,
            ...url.searchParams.keys(),
            ...(typeof parsedBody === "object" && parsedBody !== null
              ? Object.keys(parsedBody as Record<string, unknown>)
              : []),
            ...Object.keys(sourceMap),
          ]),
        ]

  let bag = assemble(stores, paramNames, sourceMap, primary, pathParamNames)

  // Optional transform after assembly
  if (sources?.transform !== undefined) {
    bag = sources.transform(bag)
  }

  return { input: bag, stores }
}

/**
 * Build the `Link: <url>; rel="next"` header for a page-shaped response
 * (`CursorPage<T>`/`OffsetPage<T>`, see `@rhi-zone/fractal-api-tree/page`) —
 * the server-side counterpart to `extensions/pagination.ts`'s client-side
 * `nextRequestFor`: same URL algebra (clone the request URL, overwrite just
 * the cursor/offset query param, preserve every other one — `limit`,
 * filters, etc.), just emitted as a response header instead of consumed to
 * build the next `Request`. RFC 8288 (`Link` header, §3) is the honest wire
 * signal for "there is a next page and here's its URL" — a client that
 * doesn't use this package's own `pagination()` extension (a bare `fetch`
 * caller, curl, a different SDK) can still discover it.
 *
 * Only meaningful for GET/HEAD/DELETE-style (query-param) requests — the
 * conventional shape for a read/list endpoint (`http.get`, verbs.ts) and the
 * only shape whose input the client encodes into the URL rather than a JSON
 * body, so a next-page URL can be derived without knowing the body schema.
 * Any other method (or `hasMore: false`) contributes no `Link` header —
 * silently, not an error: the pagination data itself is still in the JSON
 * body regardless, this header is a convenience on top, not the only way to
 * discover the next page.
 */
function pageLinkHeader(req: Request, output: Page<unknown>, meta: Meta): string | undefined {
  if (!output.hasMore) return undefined
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") return undefined

  const directive = paginatedDirectiveOf(meta)
  const cursorParam = directive?.inputCursorParam ?? "cursor"
  const offsetParam = directive?.inputOffsetParam ?? "offset"

  const url = new URL(req.url)
  if (isOffsetPage(output)) {
    url.searchParams.set(offsetParam, String(output.offset + output.items.length))
  } else if (isCursorPage(output) && output.cursor !== undefined) {
    url.searchParams.set(cursorParam, output.cursor)
  } else {
    return undefined
  }
  return `<${url.toString()}>; rel="next"`
}

/** Default `encode`: a 200 JSON response, with a `Link: ...; rel="next"` header attached when `output` is page-shaped and has a next page (see `pageLinkHeader`). */
function defaultEncode(output: unknown, req?: Request, meta?: Meta): Response {
  if (req !== undefined && meta !== undefined && isPageShape(output)) {
    const link = pageLinkHeader(req, output, meta)
    if (link !== undefined) return jsonRouteResponse(output, { status: 200, headers: { Link: link } })
  }
  return jsonRouteResponse(output, { status: 200 })
}

/** Default error encode: a 400 JSON response wrapping the error value. */
function defaultEncodeError(error: unknown): Response {
  return jsonRouteResponse({ error }, { status: 400 })
}

// ============================================================================
// Structured error types — composable error-to-transport mapping
//
// A handler's `Result.err(E)` value is transport-agnostic (e.g.
// `{ kind: "notFound", message: "Book not found" }`). `errorEncoder` (see
// `PresetOptions.errorEncoder`/`runRoute`'s parameter below) maps `E` to an
// `HttpErrorResponse`; `undefined` means "not recognized," which falls back
// to `defaultEncodeError`'s 400. `thrownErrorEncoder` is the parallel hook
// for a THROWN error (a handler that throws instead of returning
// `Result.err`) — same `(error: unknown) => HttpErrorResponse | undefined`
// shape, called from `runRoute`'s catch block; `undefined` (including when
// `thrownErrorEncoder` itself is omitted) falls back to the existing 500
// "internal server error" response. See
// docs/design/middleware-and-caller-context.md.
// ============================================================================

/** An error encoder's HTTP-specific target shape — status + optional body/headers. */
export type HttpErrorResponse = {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

/** `ErrorEncoder<E, HttpErrorResponse>` — maps a handler's error value to an HTTP response. */
export type HttpErrorEncoder<E = unknown> = ErrorEncoder<E, HttpErrorResponse>

/**
 * Same shape as `HttpErrorEncoder` — maps a THROWN error (caught in
 * `runRoute`'s catch block) to an `HttpErrorResponse`, instead of a
 * `Result.err(E)` value. A distinct alias (not just reuse-in-place) because
 * the two hooks answer different questions even though the signature is
 * identical: `errorEncoder` sees an expected, handler-signaled `E`;
 * `thrownErrorEncoder` sees whatever `catch` caught, which may not even be an
 * `Error` instance. `undefined` (including when `thrownErrorEncoder` itself
 * is omitted) falls back to the existing 500 "internal server error".
 */
export type ThrownErrorEncoder = HttpErrorEncoder

/**
 * Pre-built `HttpErrorEncoder`: maps error `kind` values to HTTP status
 * codes, e.g. `httpErrors({ notFound: 404, conflict: 409, forbidden: 403 })`.
 * Internally a `composeErrorEncoders` over one `matchKind` per mapping entry
 * — first match wins (object key order). The response body defaults to the
 * error value itself, matching `defaultEncodeError`'s `{ error }` wrapping
 * shape isn't reused here since the status is already known; instead the raw
 * error is sent as the body directly.
 */
export function httpErrors<E = unknown>(mapping: Record<string, number>): HttpErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, status]) =>
    matchKind<HttpErrorResponse>(kind, { status }),
  )
  const composed = composeErrorEncoders(...encoders)
  return (error) => {
    const matched = composed(error)
    if (matched === undefined) return undefined
    return { status: matched.status, body: error }
  }
}

/** Encode an `HttpErrorResponse` into a `Response`. */
function encodeHttpError(response: HttpErrorResponse): Response {
  const init: ResponseInit = { status: response.status }
  if (response.headers !== undefined) init.headers = response.headers
  return jsonRouteResponse(response.body, init)
}

// ============================================================================
// Handler-level middleware — around-hooks wrapping the handler call itself,
// distinct from the protocol-level `Fetch => Fetch` middleware in layers.ts/
// preset.ts (`PresetOptions.middleware`). Mirrors CliMiddleware
// (cli-api-projector/src/cli.ts) and McpMiddleware
// (mcp-api-projector/src/server.ts): all three projectors share the same
// shape — `F => F` where `F = (input, stores) => result` (see
// docs/design/middleware-and-caller-context.md). Sits INSIDE `runRoute` —
// after decode, before encode — so it sees (and can transform) the assembled
// input bag and the raw pre-assembly stores (`httpStores()`, decode.ts), with
// the handler's raw return value returned back out. The handler itself is
// `(input) => result` — it never receives `stores`; that's structural (see
// the `(input, _stores) => handler(input)` base in `runRoute`), not a
// convention to remember.
// ============================================================================

/**
 * An HTTP handler middleware wraps the handler-invoking function `next`
 * (itself `F => F`, see module doc above). Middleware compose like an onion:
 * the first entry in `handlerMiddleware` (runRoute's parameter, threaded from
 * `PresetOptions.handlerMiddleware`) is the OUTERMOST wrapper — same
 * convention as `CliMiddleware`/`McpMiddleware`.
 */
export type HttpHandlerMiddleware = (
  next: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>

/**
 * Compose `middleware` around `base`, first entry outermost. An empty array
 * returns `base` unchanged (identity — no wrapping overhead).
 */
function composeHandlerMiddleware(
  middleware: readonly HttpHandlerMiddleware[],
  base: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
): (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown> {
  let wrapped = base
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped)
  }
  return wrapped
}

/**
 * Runs a single matched `(handler, meta, sources, slugs)`: decode the
 * request, call the handler, encode the response. No interceptable
 * PROTOCOL-level stages — see the module doc above for why. Shared by
 * `makeRouterFromRoute` (below) and `toRouter` (compile.ts's compiled
 * matchers), so every dispatcher in this package encodes requests/responses
 * identically. `handlerMiddleware` (see `HttpHandlerMiddleware` above) is the
 * one interceptable HANDLER-level hook — applied around the handler call
 * itself, after decode and before encode/Result-unwrapping. `detection`
 * (see `DetectionOptions`, `@rhi-zone/fractal-api-tree`) gates the two
 * structural sniffs of the handler's return value — `result` for
 * `isResultShape`, `streaming` for the `isAsyncIterable` check below (and,
 * transitively, `streamAsSse`'s `StreamEffect` tag interpretation, since
 * disabling `streaming` skips entering `streamAsSse` at all). Both default
 * to `true` when `detection` is omitted. `ResponseOverride` detection is
 * never gated — see its own doc comment above for why. `errorEncoder` maps a
 * `Result.err(E)` value to an `HttpErrorResponse`; `thrownErrorEncoder` is
 * its parallel for whatever the catch block below actually caught (a thrown
 * error, not a `Result`) — both fall back to their own default (400 / 500
 * respectively) when the encoder is absent or returns `undefined`.
 */
export async function runRoute(
  req: Request,
  handler: Handler,
  meta: Meta,
  sources: Sources | undefined,
  slugs: Readonly<Record<string, string>>,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
): Promise<Response> {
  const detectStreaming = detection?.streaming ?? true
  const detectResult = detection?.result ?? true
  let input: unknown
  let stores: Stores
  try {
    const decoded = await defaultDecode(req, slugs, sources)
    input = decoded.input
    stores = decoded.stores
  } catch {
    return jsonRouteResponse({ error: "invalid request body" }, { status: 400 })
  }

  try {
    // Standard Schema validation (`http.validate()`, verbs.ts) — runs on the
    // freshly-assembled input, after decode/transform and before the
    // handler ever sees it. A rejection short-circuits with a 422 carrying
    // the validator's own `issues`; the handler never runs (mirrors how a
    // `wrapValidators`-wrapped handler's `err(...)` Result short-circuits
    // below, but resolved HERE — before the handler is even called — since a
    // Standard Schema validator isn't wired onto the handler itself, only
    // declared on this route's `sources`). A genuine THROW out of
    // `~standard.validate` (a broken validator, not an expected rejection)
    // falls through to this same try's catch block below, same as any other
    // unexpected handler-path failure.
    if (sources?.validate !== undefined) {
      const result = await runStandardSchema(sources.validate, input)
      if (!result.ok) {
        return jsonRouteResponse(
          { error: "validation failed", issues: result.issues },
          { status: 422 },
        )
      }
      input = result.value
    }

    // Bridge the plain handler `(input) => result` into `F => F`'s base case
    // `(input, stores) => handler(input)` — the handler never sees `stores`,
    // structurally (see HttpHandlerMiddleware's module doc above).
    const base = (input: Record<string, unknown>, _stores: Stores) =>
      (handler as (input: Record<string, unknown>) => unknown | Promise<unknown>)(input)
    const middleware = handlerMiddleware ?? []
    const callHandler = middleware.length === 0
      ? base
      : composeHandlerMiddleware(middleware, base)
    let output: unknown = await (callHandler(input as Record<string, unknown>, stores) as Promise<unknown>)

    // Streaming: an async-iterable result (e.g. an async generator handler)
    // is streamed as Server-Sent Events instead of buffered — checked before
    // Result-unwrapping since neither a Result nor a ResponseOverride is an
    // async iterable, so there's no ambiguity between the three shapes.
    if (detectStreaming && isAsyncIterable(output)) return streamAsSse(output)

    // Result unwrapping: if the handler returned a Result<T, E>, separate
    // the success and error paths before encoding — a 400, not the catch
    // block's 500, since an err Result is an expected outcome the handler
    // chose to signal, not an unexpected failure. This is also how a
    // `wrapValidators`-wrapped handler (@rhi-zone/fractal-api-tree/build)
    // signals a validation rejection: it returns `err(validationErrors)`
    // rather than throwing, so it lands here as a discriminated-union check
    // on the return value, not a catch. The check is exact — typeof + kind
    // — to avoid false-positives on user data that happens to have a `kind`
    // field with an unrelated value.
    if (detectResult && isResultShape(output)) {
      if (output.kind === "err") {
        const encoded = errorEncoder?.(output.error)
        return encoded !== undefined ? encodeHttpError(encoded) : defaultEncodeError(output.error)
      }
      output = output.value
    }

    return isResponseOverride(output)
      ? encodeOverride(output)
      : defaultEncode(output, req, meta)
  } catch (error) {
    const encoded = thrownErrorEncoder?.(error)
    return encoded !== undefined
      ? encodeHttpError(encoded)
      : jsonRouteResponse({ error: "internal server error" }, { status: 500 })
  }
}

export function makeRouterFromRoute(
  root: HttpRoute,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const segs = splitPath(new URL(req.url).pathname)
    const matched = matchRoute(root, segs, 0, req.method, {})
    if (matched === undefined) return new Response("Not Found", { status: 404 })

    return runRoute(req, matched.entry.handler, matched.entry.meta, matched.entry.sources, matched.slugs, handlerMiddleware, detection, errorEncoder, thrownErrorEncoder)
  }
}
