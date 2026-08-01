// packages/http-api-projector/src/project.ts — @rhi-zone/fractal-http-api-projector
//
// The HTTP projection surface: produces the `HttpRoute` tree from an API
// `Node` tree (`toHttpRoutes`, a thin wrapper over `naiveTransform` in
// route.ts) and builds a fetch handler from it (`makeRouter`, over
// `makeRouterFromRoute`). Also carries the `meta.http` DU types the
// rewriters (route.ts) and the projector's own re-exports interpret, and
// `verbFromTags` — verb derivation from the tag lattice, re-exported here
// from tags.ts for backwards-compatible import paths.
//
// meta.http is a DU interpreted by the rewriter pipeline (interpreter
// pattern), not a fixed record of named keys:
//   meta.http.directives  — an array of HttpDirective DU values, each tagged
//                           by `kind` ("verb" | "method" | "moveTo" |
//                           "response" | "paginated" | "source" | "validate")
//
// The `dispatch` marker (header/query/contentType attribute dispatch) and
// the `segment`/`when`/`legacyPath` directives — read by a direct tree-walk
// dispatcher that has since been retired in favor of the single `HttpRoute`
// pipeline below (naiveTransform → rewriters → makeRouterFromRoute, see
// route.ts) — were DELETED (not given a typed home): verified read nowhere
// else in the tree (see docs/design/meta-role-split-spec.md §4/§9(6)).
// Attribute dispatch (header/query/contentType-based routing at the same
// path+method) has no equivalent in the new pipeline yet — it is an open
// design question, see TODO.md.
//
// This package performs NO `declare module` augmentation of api-tree's
// `SharedMeta`/`LeafMeta`/`BranchMeta` — it exports its own `http`/`openapi`
// namespaced fragments (`HttpSharedMeta`/`HttpLeafMeta` here and in
// openapi.ts, combined in meta.ts) as inert interfaces. A deployment is the
// only place that ever augments core's role interfaces — see
// docs/design/meta-role-split-spec.md §2/§3.
//
// See:
//   docs/design/router-model.md              — Node Shape, Dispatch, HTTP metadata
//   docs/design/routing-and-transforms.md    — HttpRoute pipeline, DX
//   docs/design/dispatch-extensibility.md    — DU + interpreter pattern
//   docs/design/meta-role-split-spec.md      — SharedMeta/LeafMeta/BranchMeta split

import { makeRouterFromRoute, naiveTransform } from "./route.ts"
import type { HttpHandlerMiddleware, HttpRoute } from "./route.ts"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import type { SourceMap, StandardSchemaV1 } from "./decode.ts"
// `Fetch` is layers.ts's own type (`(req: Request) => Promise<Response>`) —
// reused here, not redeclared (see `HttpDirective`'s `middleware` variant
// doc below). Type-only: layers.ts VALUE-imports `allowHeader` from this
// file, so a value import here would cycle; a type import is erased at
// emit and creates no runtime cycle, the same reasoning route.ts's own
// module doc already applies to its (reverse-direction) type-only import of
// `HttpDirective`/`HttpLeafMeta`/`HttpSharedMeta` from this file.
import type { Fetch } from "./layers.ts"

export { verbFromTags } from "./tags.ts"
export type { HttpRoute } from "./route.ts"
export {
  applyMethods,
  applyMoveTo,
  applyResponse,
  composeTransforms,
  httpRoute,
  isHttpRoute,
  isResponseOverride,
  makeRouterFromRoute,
  naiveTransform,
  routeCandidatesForUrl,
} from "./route.ts"
export type { ResponseOverride } from "./route.ts"
export type { Store, Stores, ParamSource, SourceMap, StandardSchemaV1, StandardSchemaOutcome } from "./decode.ts"
export { assemble, httpStores, primaryStoreForMethod, runStandardSchema } from "./decode.ts"

/**
 * Produce the HTTP route tree from an API tree — the naive transform (see
 * route.ts): every child becomes a path-segment child, every handler
 * becomes a single POST entry. The baseline the rewriters (`applyMethods`,
 * `applyMoveTo`, `applyResponse`, chained via `composeTransforms`) start
 * from.
 */
export function toHttpRoutes(node: Node): HttpRoute {
  return naiveTransform(node)
}

// ============================================================================
// meta.http DU types
// ============================================================================

/**
 * A single HTTP directive — a tagged variant interpreted by the rewriter
 * pipeline (route.ts). Interpreter pattern: each variant is a
 * self-describing value, not a fixed record field.
 *
 * Interpreted by the HttpRoute rewriters in route.ts — see
 * docs/design/routing-and-transforms.md:
 *
 * - `{ kind: "method", value }` — sets the HTTP method on a route's method
 *   entry (read by `applyMethods`; renames the `methods` key).
 * - `{ kind: "moveTo", path }` — relative node placement in the output route
 *   tree (read by `applyMoveTo`; see route.ts for the path algebra — paths
 *   resolve relative to the node's own position, using standard
 *   filesystem-style relative semantics: `..` = parent, `../foo` = sibling
 *   rename, `*` = wildcard segment).
 * - `{ kind: "response", status?, headers? }` — response overrides,
 *   materialized into the handler via composition (read by `applyResponse`).
 * - `{ kind: "paginated", style?, cursorParam?, offsetParam?, limitParam? }`
 *   — pagination hints, read by `extensions/pagination.ts`'s client
 *   extension (see `paginated()` in verbs.ts). Detection of "is this
 *   endpoint paginated at all" is a RUNTIME shape check on the actual
 *   response (`isPageShape`, mirroring streaming's `isStreamEffect`
 *   convention) — this directive only overrides the client's defaults
 *   (which style to trust when the shape is ambiguous, and which input
 *   field name carries the cursor/offset/limit) when they don't apply.
 *
 * - `{ kind: "source", map }` — per-param HTTP store overrides, one directive
 *   PER `http.source()` CALL (see verbs.ts), each carrying that call's whole
 *   (shorthand-expanded) `SourceMap`. Deliberately a directive — appended to
 *   the array — rather than a plain merged object on `meta.http.sourceMap`:
 *   `mergeMeta`'s type-level counterpart (`FoldMeta`/`MergeTwoMeta`, node.ts)
 *   can't soundly merge two open `Record<string, ParamSource>` index-signature
 *   types at the type level (a real TypeScript limitation — recursing into an
 *   index-signature-only object via a keyed mapped type surfaces spurious
 *   `| undefined` on every entry), the same class of problem `VerbBundle`'s
 *   own doc comment (above) already works around for arrays vs.
 *   intersections. Arrays dodge it entirely: `MergeMetaValue`'s array branch
 *   concatenates without recursing into elements, so two `http.source()`
 *   calls compose as two separate directive entries instead of one merged
 *   object. `getHttpMeta` (below) resolves the array of `source` directives
 *   into a single `sourceMap` field, in array order (later directive's keys
 *   win on overlap) — `naiveTransform` (route.ts) reads THAT resolved map
 *   into the matched route's `sources.sourceMap`.
 *
 * - `{ kind: "validate"; schema }` — a Standard Schema
 *   (https://standardschema.dev/) validator attached via `http.validate()`
 *   (verbs.ts). `naiveTransform` (route.ts) reads the LAST such directive
 *   (later call wins, same convention as every other single-valued
 *   directive here) into the matched route's `sources.validate`; `runRoute`
 *   (route.ts) runs it (via `runStandardSchema`, decode.ts) on the assembled
 *   input, after decode and before the handler. See decode.ts's own module
 *   doc for how this differs from type-ir's `fromStandardSchema` (shape
 *   ingestion) and api-tree's `wrapValidators` (AOT-compiled validators).
 *
 * - `{ kind: "middleware"; value }` — a subtree-scoped, dispatch-around
 *   `Fetch => Fetch` wrapper, attached via `http.middleware(...)`
 *   (verbs.ts). Valid at BOTH leaf and branch position — a branch scopes the
 *   wrapper to its whole subtree, a leaf scopes it to just itself. One
 *   directive PER function passed to `http.middleware(...)` (variadic; each
 *   argument becomes its own directive entry, same "one call, N array
 *   entries" shape `http.source()`'s directive already establishes above).
 *   `getHttpMeta` (below) collects every `middleware` directive in a
 *   resolved `directives` array, IN ARRAY ORDER, into
 *   `resolved.middleware`; `collectRoutes` (compile.ts) further composes
 *   this per-node array with every ANCESTOR branch's own resolved
 *   `middleware` array (root-to-leaf, root's entries outermost) into one
 *   per-leaf wrap chain — see docs/design/subtree-layers-spec.md §5. Wraps
 *   at the SAME point `PresetOptions.middleware` (preset.ts) wraps the whole
 *   compiled router today — before the router even matches a route, before
 *   decode, before `sources.validate` — just narrowed to requests that match
 *   a leaf under the declaring node instead of every request.
 * - `{ kind: "handlerMiddleware"; value }` — a subtree-scoped, handler-around
 *   `F => F` wrapper (`F = (input, stores) => result`), attached via
 *   `http.handlerMiddleware(...)` (verbs.ts). Also valid at both leaf and
 *   branch position, also one directive per function argument, also
 *   collected (array order) into `resolved.handlerMiddleware` by
 *   `getHttpMeta` and further ancestor-composed by `collectRoutes`
 *   (compile.ts), same as `middleware` above. Wraps at the SAME point
 *   `PresetOptions.handlerMiddleware` already threads into `runRoute`
 *   (route.ts) today — after decode and `sources.validate`, before the
 *   handler is called — just narrowed to a subtree.
 *
 *   **Both `middleware` and `handlerMiddleware` MUST stay directive-array-
 *   authored — never collapsed into a bare (non-array) function-valued field
 *   on `HttpSharedMetaProperties.http` (e.g. `http: { middleware: fn }`
 *   directly, bypassing `directives`).** This is not a style preference: a
 *   scratch `tsc` check (docs/design/subtree-layers-spec.md §6/§7, reproduced
 *   as a permanent regression test in subtree-layers.test.ts) confirmed that
 *   when two separate `op()` meta contributions both set the SAME bare
 *   function-valued key, `FoldMeta`/`MergeTwoMeta`'s mapped-type merge
 *   (`Omit`/`Pick` over `keyof`, api-tree's node.ts) silently strips the
 *   function's call signature — `keyof` a plain function type is empty, so
 *   the merge's `Omit<A,keyof B> & Omit<B,keyof A> & {...}` intersection
 *   reduces the folded member toward `{}` (structurally a function still
 *   satisfies `extends object`, so `MergeMetaValue` takes the OBJECT-merge
 *   branch, not the array-concatenation branch). `MergeMetaValue`'s ARRAY
 *   branch (node.ts) concatenates without recursing into elements, so a
 *   function VALUE living inside an array member is never merged as an
 *   object and keeps its call signature — exactly the same class of hazard
 *   (and the same fix) the `source` directive's own doc comment above
 *   already documents for `Record<string,ParamSource>` index-signature
 *   merging.
 *
 * Interpreted by `verbFromTags` (tags.ts):
 *
 * - `{ kind: "verb", value }` — explicit verb override; wins over tags.
 *
 * `method`'s `value` and `moveTo`'s `path` are generic (`M`/`P`, both
 * defaulting to plain `string`) so a constructor that knows its own literal
 * value — `http.get`/`http.post`/etc. and `http.moveTo(path)` (verbs.ts) —
 * can return `HttpDirective<"GET">` / a moveTo variant carrying `".."`
 * instead of widening to `string`. Every existing reference to the bare
 * `HttpDirective` (no type argument) keeps working unchanged — the defaults
 * reproduce today's `string`-typed fields exactly, so this is a
 * backwards-compatible narrowing, not a breaking change. The other variants
 * (`verb`/`response`) aren't parameterized — nothing in this task's scope
 * constructs them with a literal to preserve.
 *
 * `source`'s `map` is generic in `S` for the same reason, added later: a
 * literal-preserving `http.source()` (verbs.ts) returns a directive whose map
 * still carries each param's own key and resolved store as literal types, so a
 * type-level walk over the directive tuple can answer "which store does param X
 * come from" — the mechanism `op()`'s source-coverage check runs on
 * (docs/design/typed-store-spec.md §6). The default (`SourceMap`) reproduces
 * the previous erased field exactly.
 */
export type HttpDirective<
  M extends string = string,
  P extends string = string,
  S extends SourceMap = SourceMap,
> =
  | { readonly kind: "verb"; readonly value: string }
  | { readonly kind: "method"; readonly value: M }
  | { readonly kind: "moveTo"; readonly path: P }
  | {
      readonly kind: "response"
      readonly status?: number
      readonly headers?: Record<string, string>
    }
  | {
      readonly kind: "paginated"
      readonly style?: "cursor" | "offset"
      readonly inputCursorParam?: string
      readonly inputOffsetParam?: string
      readonly inputLimitParam?: string
    }
  | { readonly kind: "source"; readonly map: S }
  | { readonly kind: "validate"; readonly schema: StandardSchemaV1 }
  | { readonly kind: "middleware"; readonly value: (inner: Fetch) => Fetch }
  | { readonly kind: "handlerMiddleware"; readonly value: HttpHandlerMiddleware }

// ============================================================================
// meta.http — role-split fragments (see docs/design/meta-role-split-spec.md
// §2/§4). `HttpSharedMetaProperties`/`HttpLeafMetaProperties` are the
// RESOLVED shape (what `getHttpMeta` produces) — a deployment that wants to
// require `http.method` on every op, for instance, extends `LeafMeta` with
// `HttpLeafMeta` (below) and adds `http: { method: string } & ...` on top.
// These are NOT the raw authoring shape (`{ directives: HttpDirective[] }`)
// contributions like `http.get`/`http.moveTo()` (verbs.ts) actually produce
// — `op()`'s own literal-preserving return type (`FoldMeta<C>`, node.ts)
// carries that raw shape through independently of what's declared here;
// this interface only has to be assignable FROM it (every field here is
// optional), never equal to it.
// ============================================================================

/** `meta.http` fields valid at BOTH leaf and branch position. */
export interface HttpSharedMetaProperties {
  /** Resolved `{ kind: "moveTo" }` directive path — single-op or whole-subtree relocation (route.ts § applyMoveTo; placement axis left open, see spec §8). */
  readonly moveTo?: string
  /** The raw directives array, passed through unresolved for callers that need it (e.g. `getHttpMeta`'s own resolution, `route.ts`'s rewriters). */
  readonly directives?: readonly HttpDirective[]
  /**
   * Resolved `{ kind: "middleware" }` directives — every `http.middleware(...)`
   * function on THIS node's own `directives` array, in array order (this
   * node's own contribution only; ancestor composition happens later, at
   * `collectRoutes`/router-compile time, see docs/design/
   * subtree-layers-spec.md §5). Valid at leaf or branch position: a branch
   * scopes its subtree, a leaf scopes only itself.
   */
  readonly middleware?: readonly ((inner: Fetch) => Fetch)[]
  /**
   * Resolved `{ kind: "handlerMiddleware" }` directives — every
   * `http.handlerMiddleware(...)` function on THIS node's own `directives`
   * array, in array order. Same ancestor-composition note as `middleware`
   * above applies.
   */
  readonly handlerMiddleware?: readonly HttpHandlerMiddleware[]
}

/** Wraps `HttpSharedMetaProperties` under the `http` key — extend `SharedMeta` with this in a deployment's augmentation file. */
export interface HttpSharedMeta {
  readonly http?: HttpSharedMetaProperties
}

/** `meta.http` fields valid at LEAF (operation) position only. */
export interface HttpLeafMetaProperties extends HttpSharedMetaProperties {
  /** Resolved `{ kind: "method" }` directive value. */
  readonly method?: string
  /** Resolved `{ kind: "verb" }` directive value. */
  readonly verb?: string
  /** Resolved `{ kind: "response" }` directive fields. */
  readonly response?: { readonly status?: number; readonly headers?: Record<string, string> }
  /** Resolved `{ kind: "paginated" }` directive fields — see `paginated()` in verbs.ts. */
  readonly paginated?: {
    readonly style?: "cursor" | "offset"
    readonly inputCursorParam?: string
    readonly inputOffsetParam?: string
    readonly inputLimitParam?: string
  }
  /** Resolved `{ kind: "validate" }` directive schema — see `http.validate()` in verbs.ts. */
  readonly validate?: StandardSchemaV1
  /** Per-param HTTP store overrides — see `http.source()` in verbs.ts. */
  readonly sourceMap?: SourceMap
}

/** Wraps `HttpLeafMetaProperties` under the `http` key — extend `LeafMeta` with this in a deployment's augmentation file. */
export interface HttpLeafMeta {
  readonly http?: HttpLeafMetaProperties
}

// ============================================================================
// getHttpMeta — the ONE canonical `meta.http` parser
//
// Resolves the raw `meta.http` bag (directives array) into a typed,
// fully-resolved shape. Three resolution shapes coexist here:
//   - "last-wins scalar" (verb/method/moveTo/response/paginated/validate) —
//     last directive of a given kind in the array wins, matching the
//     pre-consolidation local walks' behavior (a plain for-loop overwriting
//     as it goes).
//   - "collect-and-merge" (sourceMap) — every `source` directive's map is
//     folded key-by-key, later call's keys win on overlap.
//   - "collect-into-ordered-list" (middleware/handlerMiddleware) — every
//     directive of the kind is APPENDED, in array order, into an ordered
//     wrap list. Not last-wins (a later `http.middleware()` call doesn't
//     replace an earlier one — subtree middleware compose, they don't
//     override) and not key-merged (there's no key to merge on, only
//     position in the wrap chain). This is this node's OWN resolved list
//     only; ancestor composition (root-to-leaf) happens later, at
//     `collectRoutes`/router-compile time (compile.ts) — see
//     docs/design/subtree-layers-spec.md §5.
// ============================================================================

/** Parse `meta.http` into the resolved `HttpLeafMetaProperties` shape — see module doc above. */
export function getHttpMeta(meta: HttpLeafMeta): HttpLeafMetaProperties {
  const h = meta.http
  if (typeof h !== "object" || h === null) return {}

  const out: {
    directives?: readonly HttpDirective[]
    sourceMap?: SourceMap
    validate?: StandardSchemaV1
    verb?: string
    method?: string
    moveTo?: string
    response?: { status?: number; headers?: Record<string, string> }
    paginated?: {
      style?: "cursor" | "offset"
      inputCursorParam?: string
      inputOffsetParam?: string
      inputLimitParam?: string
    }
    middleware?: readonly ((inner: Fetch) => Fetch)[]
    handlerMiddleware?: readonly HttpHandlerMiddleware[]
  } = {}

  if (Array.isArray(h.directives)) {
    const directives = h.directives
    out.directives = directives
    let middleware: Array<(inner: Fetch) => Fetch> | undefined
    let handlerMiddleware: HttpHandlerMiddleware[] | undefined
    for (const d of directives) {
      switch (d.kind) {
        case "verb":
          out.verb = d.value
          break
        case "method":
          out.method = d.value
          break
        case "moveTo":
          out.moveTo = d.path
          break
        case "response":
          out.response = {
            ...(d.status !== undefined ? { status: d.status } : {}),
            ...(d.headers !== undefined ? { headers: d.headers } : {}),
          }
          break
        case "source":
          // Fold in array order — a param name repeated across multiple
          // `http.source()` calls resolves to the LATER call's entry, same
          // "later wins per key" convention as every other meta merge.
          out.sourceMap = { ...out.sourceMap, ...d.map }
          break
        case "validate":
          // Last directive wins — same "later wins" convention as verb/
          // method/moveTo/response above (unlike `source`, which folds
          // key-by-key since each call only carries a partial map).
          out.validate = d.schema
          break
        case "paginated":
          out.paginated = {
            ...(d.style !== undefined ? { style: d.style } : {}),
            ...(d.inputCursorParam !== undefined ? { inputCursorParam: d.inputCursorParam } : {}),
            ...(d.inputOffsetParam !== undefined ? { inputOffsetParam: d.inputOffsetParam } : {}),
            ...(d.inputLimitParam !== undefined ? { inputLimitParam: d.inputLimitParam } : {}),
          }
          break
        case "middleware":
          // Collect-into-ordered-list, not last-wins — see module doc above.
          middleware = middleware ?? []
          middleware.push(d.value)
          break
        case "handlerMiddleware":
          handlerMiddleware = handlerMiddleware ?? []
          handlerMiddleware.push(d.value)
          break
      }
    }
    if (middleware !== undefined) out.middleware = middleware
    if (handlerMiddleware !== undefined) out.handlerMiddleware = handlerMiddleware
  }

  return out
}

// ============================================================================
// Response helpers
// ============================================================================

/** Build a sorted Allow header string from a set of HTTP method strings. */
export function allowHeader(verbs: Iterable<string>): string {
  return [...new Set(verbs)].sort().join(", ")
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  return new Response(JSON.stringify(value), { ...init, headers })
}

// ============================================================================
// Core router — exact verb+path dispatch over an HttpRoute tree
//
// No HEAD-from-GET, no OPTIONS auto-response, no 405+Allow.
// Those HTTP-correctness behaviors live in the auto-method layer (layers.ts)
// and are droppable: the router functions correctly as a pure dispatcher
// without them, returning 404 for any request with no exact match.
// ============================================================================

/** Build a fetch handler from an `HttpRoute` tree — see `makeRouterFromRoute` in route.ts. */
export function makeRouter(root: HttpRoute): (req: Request) => Promise<Response> {
  return makeRouterFromRoute(root)
}
