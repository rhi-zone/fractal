// packages/http-api-projector/src/project.ts — @rhi-zone/fractal-http-api-projector
//
// The HTTP projection surface: produces the `HttpRoute` tree from an API
// `Node` tree (`toHttpRoutes`, a thin wrapper over `naiveTransform` in
// route.ts) and builds a fetch handler from it (`makeRouter`, over
// `makeRouterFromRoute`). Also carries the `meta.http` flat-bag types the
// rewriters (route.ts) and the projector's own re-exports interpret, and
// `verbFromTags` — verb derivation from the tag lattice, re-exported here
// from tags.ts for backwards-compatible import paths.
//
// meta.http is a FLAT, namespaced bag of scalar/map/array keys — fold
// semantics follow value shape (docs/design/wire-profiles-and-staged-
// validation.md's "Prerequisite: meta unification (directive dissolution)"):
//   meta.http.verb/method/moveTo/response/paginated/validate — at-most-one,
//     flat scalar keys, last-wins (mergeMeta's ordinary scalar-override rule)
//   meta.http.sourceMap        — keyed partial contribution, flat map key,
//                                key-merged (later call's keys win on overlap)
//   meta.http.middleware/handlerMiddleware — genuinely multiple/ordered,
//                                plain arrays, append (concatenate)
//
// The flat design above governs `meta.http.directives` too:
// `FoldMeta`/`MergeTwoMeta` (api-tree's node.ts) fold flat scalar/map/array
// keys directly, including index-signature maps and bare functions, through
// the existing `FoldMeta`/`MergeTwoMeta`/`mergeRecords` machinery (see
// node.ts's `mergeRecords` doc comment for the runtime/type depth-cap parity
// it enforces). The resolved shape is the authored shape directly — there is
// no fold-by-`kind` step at read time; `getHttpMeta` is a thin pass-through
// (see its own doc comment below).
//
// The `dispatch` marker (header/query/contentType attribute dispatch) and
// the `segment`/`when`/`legacyPath` directives have no typed home in this
// module (see docs/design/meta-role-split-spec.md §4/§9(6)); that
// functionality lives in the single `HttpRoute` pipeline below
// (naiveTransform → rewriters → makeRouterFromRoute, see route.ts). Attribute
// dispatch (header/query/contentType-based routing at the same path+method)
// has no equivalent in the new pipeline yet — it is an open design question,
// see TODO.md.
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

import { makeRouterFromRoute, naiveTransform } from "./route.ts";
import type { HttpHandlerMiddleware, HttpRoute } from "./route.ts";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import type { EncodingMap, SourceMap, StandardSchemaV1 } from "./decode.ts";
// `Fetch` is layers.ts's own type (`(req: Request) => Promise<Response>`) —
// reused here, not redeclared (see `HttpSharedMetaProperties`'s `middleware`
// field doc below). Type-only: layers.ts VALUE-imports `allowHeader` from
// this file, so a value import here would cycle; a type import is erased at
// emit and creates no runtime cycle, the same reasoning route.ts's own
// module doc already applies to its (reverse-direction) type-only import of
// `HttpLeafMeta`/`HttpSharedMeta` from this file.
import type { Fetch } from "./layers.ts";

export { verbFromTags } from "./tags.ts";
export type { HttpRoute } from "./route.ts";
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
} from "./route.ts";
export type { ResponseOverride } from "./route.ts";
export type {
  Store,
  Stores,
  ParamSource,
  SourceMap,
  StandardSchemaV1,
  StandardSchemaOutcome,
} from "./decode.ts";
export { assemble, httpStores, primaryStoreForMethod, runStandardSchema } from "./decode.ts";

/**
 * Produce the HTTP route tree from an API tree — the naive transform (see
 * route.ts): every child becomes a path-segment child, every handler
 * becomes a single POST entry. The baseline the rewriters (`applyMethods`,
 * `applyMoveTo`, `applyResponse`, chained via `composeTransforms`) start
 * from.
 */
export function toHttpRoutes(node: Node): HttpRoute {
  return naiveTransform(node);
}

// ============================================================================
// meta.http — role-split fragments (see docs/design/meta-role-split-spec.md
// §2/§4). `HttpSharedMetaProperties`/`HttpLeafMetaProperties` serve as both
// the authoring shape and the resolved shape — the flat design collapses the
// two into one (docs/design/wire-profiles-and-staged-validation.md's
// "Prerequisite: meta unification" section: "the resolved shape becomes the
// authored shape"). A deployment that wants to require `http.method` on
// every op, for instance, extends `LeafMeta` with `HttpLeafMeta` (below) and
// adds `http: { method: string } & ...` on top.
// ============================================================================

/**
 * `meta.http` fields valid at both leaf and branch position — all flat
 * scalar/array keys, folded by `mergeMeta`/`FoldMeta` (api-tree's node.ts)
 * the same way every other meta sub-bag is: shape determines fold semantics
 * (docs/design/wire-profiles-and-staged-validation.md's "The rule: fold
 * semantics follow value shape").
 */
export interface HttpSharedMetaProperties {
  /** At-most-one relative node placement — single-op or whole-subtree relocation (route.ts § applyMoveTo; placement axis left open, see spec §8). Last-wins. */
  readonly moveTo?: string;
  /**
   * Genuinely multiple/ordered — every `http.middleware(...)` function
   * contributed to THIS node (this node's own contribution only; ancestor
   * composition happens later, at `collectRoutes`/router-compile time, see
   * docs/design/subtree-layers-spec.md §5). A plain array: `MergeMetaValue`'s
   * array-concatenation branch (node.ts) appends without recursing into
   * elements, so composing two `http.middleware(...)` contributions never
   * strips a function value's call signature the way a bare (non-array)
   * function-valued field would (see `middleware()`'s own doc comment,
   * verbs.ts). Valid at leaf or branch position: a branch scopes its
   * subtree, a leaf scopes only itself.
   */
  readonly middleware?: readonly ((inner: Fetch) => Fetch)[];
  /** Genuinely multiple/ordered — same shape and same reasoning as `middleware` above, for `http.handlerMiddleware(...)`. */
  readonly handlerMiddleware?: readonly HttpHandlerMiddleware[];
}

/** Wraps `HttpSharedMetaProperties` under the `http` key — extend `SharedMeta` with this in a deployment's augmentation file. */
export interface HttpSharedMeta {
  readonly http?: HttpSharedMetaProperties;
}

/** `meta.http` fields valid at LEAF (operation) position only — same flat, shape-folded convention as `HttpSharedMetaProperties` above. */
export interface HttpLeafMetaProperties extends HttpSharedMetaProperties {
  /** At-most-one — sets the HTTP method on a route's method entry (read by `applyMethods`, route.ts; renames the `methods` key). Last-wins. */
  readonly method?: string;
  /** At-most-one — explicit verb override; wins over tag-derived verb in `verbFromTags` (tags.ts). Last-wins. Set alongside `method` by every `http.*` verb bundle (`httpVerbBundle`, verbs.ts) — two flat keys describing one fact, read by two different projectors. */
  readonly verb?: string;
  /** At-most-one — response overrides, materialized into the handler via composition (read by `applyResponse`, route.ts). Last-wins (the whole `{status,headers}` object, not merged field-by-field — see node.ts's `mergeRecords`/`MergeMetaValue` depth-cap doc comments). */
  readonly response?: { readonly status?: number; readonly headers?: Record<string, string> };
  /** At-most-one — pagination hints, read by `extensions/pagination.ts`'s client extension (see `paginated()` in verbs.ts). Detection of "is this endpoint paginated at all" is a RUNTIME shape check on the actual response (`isPageShape`); this only overrides the client's defaults when they don't apply. Last-wins. */
  readonly paginated?: {
    readonly style?: "cursor" | "offset";
    readonly inputCursorParam?: string;
    readonly inputOffsetParam?: string;
    readonly inputLimitParam?: string;
  };
  /**
   * At-most-one — a Standard Schema (https://standardschema.dev/) validator
   * attached via `http.validate()` (verbs.ts). `naiveTransform` (route.ts)
   * reads this straight into the matched route's `sources.validate`;
   * `runRoute` (route.ts) runs it (via `runStandardSchema`, decode.ts) on the
   * assembled input, after decode and before the handler. Last-wins. See
   * decode.ts's own module doc for how this differs from type-ir's
   * `fromStandardSchema` (shape ingestion) and api-tree's `applyValidation`
   * (codegen-derived validators wired directly onto a handler).
   */
  readonly validate?: StandardSchemaV1;
  /**
   * Keyed partial contribution — per-param HTTP store overrides (see
   * `http.source()` in verbs.ts). A flat MAP key: key-merged, later call's
   * keys win on overlap, via the SAME `FoldMeta`/`MergeTwoMeta` depth-capped
   * object merge (node.ts) every other nested meta object already uses — no
   * special-casing needed once the map's keys are literal (not an
   * index-signature-erased `Record<string, ParamSource>`), see `source()`'s
   * own doc comment (verbs.ts) for the empirical verification.
   */
  readonly sourceMap?: SourceMap;
  /**
   * Keyed partial contribution — per-field wire-encoding overrides layered
   * on top of `sourceMap`'s per-field STORE choice (phase B/E, docs/design/
   * wire-profiles-and-staged-validation.md). A flat MAP key: key-merged,
   * later call's keys win on overlap, same convention `sourceMap` above
   * follows. Each entry is either a base-profile-name STRING (overriding
   * that field's derived wire profile outright — `wire-derive.ts`'s
   * `deriveFieldProfiles` result, overridden per-field by
   * `extractWireApplyValidationTypeRefs`, api-tree's apply-validation-
   * build.ts) or a custom decoder FUNCTION run at WRAP time instead of the
   * fused default decode (`createApplyValidation`, api-tree's
   * apply-validation.ts). Declared here structurally (see `EncodingMap`'s
   * own doc comment, api-tree's input.ts) — a function entry's own param/
   * return types are checked separately, against the literal object passed
   * to `op()`, by `MismatchedEncodingMapDecoders`/`CheckedContributions`
   * (api-tree's input.ts/node.ts), not by this declared field type.
   */
  readonly encodingMap?: EncodingMap;
}

/** Wraps `HttpLeafMetaProperties` under the `http` key — extend `LeafMeta` with this in a deployment's augmentation file. */
export interface HttpLeafMeta {
  readonly http?: HttpLeafMetaProperties;
}

/**
 * Read `meta.http` off a leaf's meta — a thin, typed accessor, not a resolver.
 * `op()`'s own `mergeMeta`/`FoldMeta` fold (api-tree's node.ts) already
 * produces the resolved `HttpLeafMetaProperties` shape the moment a leaf's
 * meta contributions compose, so this function computes nothing — `meta.http`
 * IS that shape by construction. Kept as a named function, rather than
 * inlining `meta.http` at each call site, for the stable read-site API
 * existing callers (`extensions/pagination.ts`, `compile.ts`'s
 * `collectRoutes`, verbs.test.ts, …) depend on, and for the `null`/non-object
 * guard a plain field read wouldn't give for free.
 */
export function getHttpMeta(meta: HttpLeafMeta): HttpLeafMetaProperties {
  const h = meta.http;
  if (typeof h !== "object" || h === null) return {};
  return h;
}

// ============================================================================
// Response helpers
// ============================================================================

/** Build a sorted Allow header string from a set of HTTP method strings. */
export function allowHeader(verbs: Iterable<string>): string {
  return [...new Set(verbs)].sort().join(", ");
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
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
  return makeRouterFromRoute(root);
}
