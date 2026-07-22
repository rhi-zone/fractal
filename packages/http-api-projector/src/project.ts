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
//                           by `kind` ("verb" | "segment" | "when" |
//                           "legacyPath" | "method" | "moveTo" | "response")
//
// `dispatch` markers (header/query/contentType attribute dispatch) and the
// `legacyPath`/`segment`/`when` directives were interpreted by a direct
// tree-walk dispatcher that has been retired in favor of the single
// `HttpRoute` pipeline below (naiveTransform → rewriters → makeRouterFromRoute,
// see route.ts). Attribute dispatch (header/query/contentType-based routing
// at the same path+method) has no equivalent in the new pipeline yet — it
// is an open design question, see TODO.md.
//
// See:
//   docs/design/router-model.md              — Node Shape, Dispatch, HTTP metadata
//   docs/design/routing-and-transforms.md    — HttpRoute pipeline, DX
//   docs/design/dispatch-extensibility.md    — DU + interpreter pattern

import { makeRouterFromRoute, naiveTransform } from "./route.ts"
import type { HttpRoute } from "./route.ts"
import type { Meta, Node } from "@rhi-zone/fractal-api-tree/node"

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
export type { Store, Stores, ParamSource, SourceMap } from "./decode.ts"
export { assemble, httpStores, primaryStoreForMethod } from "./decode.ts"

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

// Declaration merging: types this package's `meta.http` slot on the shared
// `Meta` open bag (see api-tree/src/node.ts) so consumers get a typed
// `meta.http` instead of an untyped index-signature fallback.
declare module "@rhi-zone/fractal-api-tree/node" {
  interface Meta {
    http?: HttpMeta
  }
}

// ============================================================================
// meta.http DU types
// ============================================================================

/**
 * A single HTTP directive — a tagged variant interpreted by the rewriter
 * pipeline (route.ts) or, for the retired variants below, by other
 * packages' own self-contained tree walks (openapi, client — see those
 * packages' `getHttpMeta`). Interpreter pattern: each variant is a
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
 * Interpreted by `verbFromTags` (tags.ts):
 *
 * - `{ kind: "verb", value }` — explicit verb override; wins over tags.
 *
 * Retired from http's own dispatch (the direct tree-walk dispatcher that
 * read these has been deleted) but still read by other packages' own
 * self-contained Node-tree walks (openapi, client) for their own,
 * independent projections:
 *
 * - `{ kind: "segment", value }`    — explicit path-segment rename.
 * - `{ kind: "when", value }`       — per-child match-value override for
 *   non-method attribute dispatch (key ≠ match value).
 * - `{ kind: "legacyPath", value }` — [DEBT] full-path override, bypasses
 *   the tree-walk address entirely.
 *
 * `method`'s `value` and `moveTo`'s `path` are generic (`M`/`P`, both
 * defaulting to plain `string`) so a constructor that knows its own literal
 * value — `http.get`/`http.post`/etc. and `http.moveTo(path)` (verbs.ts) —
 * can return `HttpDirective<"GET">` / a moveTo variant carrying `".."`
 * instead of widening to `string`. Every existing reference to the bare
 * `HttpDirective` (no type argument) keeps working unchanged — the defaults
 * reproduce today's `string`-typed fields exactly, so this is a
 * backwards-compatible narrowing, not a breaking change. The other variants
 * (`verb`/`segment`/`when`/`legacyPath`/`response`) aren't parameterized —
 * nothing in this task's scope constructs them with a literal to preserve.
 */
export type HttpDirective<M extends string = string, P extends string = string> =
  | { readonly kind: "verb"; readonly value: string }
  | { readonly kind: "segment"; readonly value: string }
  | { readonly kind: "when"; readonly value: string }
  | { readonly kind: "legacyPath"; readonly value: string }
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

// ============================================================================
// getHttpMeta — the ONE canonical `meta.http` parser
//
// Resolves the raw `meta.http` bag (dispatch marker + directives array) into
// a typed, fully-resolved shape. This is what openapi's and client's own
// self-contained tree walks read instead of each maintaining a divergent
// local copy (see docs/design — the pre-consolidation state had THREE
// separate typeof/null-checking parsers: this one, plus one apiece in
// openapi-api-projector and client-api-projector, with diverging field sets
// — `dispatch` collapsed vs. not, `moveTo`/`when`/`response` parsed vs.
// skipped, `dispatchKind` vs. `dispatch` naming).
//
// `dispatch` is collapsed from the raw marker (`{kind: "method" | "header" |
// "query" | "contentType"}`) to `{kind: "method" | "attr"}` — "attr" covers
// any non-method marker, matching how openapi/client both treat
// attribute-dispatched children (as segment-dispatch, an approximation; see
// those packages' own tree walks for how the collapsed value is used).
//
// Each directive kind is resolved to its own field — last directive of a
// given kind in the array wins, matching the pre-consolidation local walks'
// behavior (a plain for-loop overwriting as it goes).
// ============================================================================

/** Fully-resolved `meta.http` shape — see `getHttpMeta` above. */
export type HttpMeta = {
  /** Collapsed dispatch marker: "attr" covers any non-method marker. */
  readonly dispatch?: { readonly kind: "method" | "attr" }
  /** The raw directives array, passed through unresolved for callers that need it. */
  readonly directives?: readonly HttpDirective[]
  /** Resolved `{ kind: "verb" }` directive value. */
  readonly verb?: string
  /** Resolved `{ kind: "segment" }` directive value. */
  readonly segment?: string
  /** Resolved `{ kind: "legacyPath" }` directive value. */
  readonly legacyPath?: string
  /** Resolved `{ kind: "when" }` directive value. */
  readonly when?: string
  /** Resolved `{ kind: "method" }` directive value. */
  readonly method?: string
  /** Resolved `{ kind: "moveTo" }` directive path. */
  readonly moveTo?: string
  /** Resolved `{ kind: "response" }` directive fields. */
  readonly response?: { readonly status?: number; readonly headers?: Record<string, string> }
  /** Resolved `{ kind: "paginated" }` directive fields — see `paginated()` in verbs.ts. */
  readonly paginated?: {
    readonly style?: "cursor" | "offset"
    readonly inputCursorParam?: string
    readonly inputOffsetParam?: string
    readonly inputLimitParam?: string
  }
}

/** Parse `meta.http` into the resolved `HttpMeta` shape — see module doc above. */
export function getHttpMeta(meta: Meta): HttpMeta {
  const h = meta.http
  if (typeof h !== "object" || h === null) return {}

  const out: {
    dispatch?: { kind: "method" | "attr" }
    directives?: readonly HttpDirective[]
    verb?: string
    segment?: string
    legacyPath?: string
    when?: string
    method?: string
    moveTo?: string
    response?: { status?: number; headers?: Record<string, string> }
    paginated?: {
      style?: "cursor" | "offset"
      inputCursorParam?: string
      inputOffsetParam?: string
      inputLimitParam?: string
    }
  } = {}

  if (typeof h.dispatch === "object" && h.dispatch !== null) {
    out.dispatch = { kind: h.dispatch.kind === "method" ? "method" : "attr" }
  }

  if (Array.isArray(h.directives)) {
    const directives = h.directives
    out.directives = directives
    for (const d of directives) {
      switch (d.kind) {
        case "verb":
          out.verb = d.value
          break
        case "segment":
          out.segment = d.value
          break
        case "legacyPath":
          out.legacyPath = d.value
          break
        case "when":
          out.when = d.value
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
        case "paginated":
          out.paginated = {
            ...(d.style !== undefined ? { style: d.style } : {}),
            ...(d.inputCursorParam !== undefined ? { inputCursorParam: d.inputCursorParam } : {}),
            ...(d.inputOffsetParam !== undefined ? { inputOffsetParam: d.inputOffsetParam } : {}),
            ...(d.inputLimitParam !== undefined ? { inputLimitParam: d.inputLimitParam } : {}),
          }
          break
      }
    }
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
