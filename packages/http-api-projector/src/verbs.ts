// packages/http-api-projector/src/verbs.ts — @rhi-zone/fractal-http-api-projector
//
// Verb-helper bundles: `http.get`, `http.post`, `http.put`, `http.patch`,
// `http.delete`, `http.head`, `http.options`.
//
// Each helper is a METADATA VALUE (a leaf meta contribution value), NOT a function. It bundles:
//   - the verb pin (flat `meta.http.verb`/`meta.http.method` scalar keys) —
//     `verb` wins over tag-derived verb in verbFromTags
//   - the behavioral tags that verb implies (`meta.tags`)
//
// Usage:
//   op(fn, http.put)                    — verb PUT + idempotent tag
//   op(fn, http.put, { tags: { ... } }) — merges via mergeMeta, later-wins
//
// The bundled tags are what light up other projections for free:
//   http.get  → readOnly:true  → MCP readOnlyHint, CLI no-confirm
//   http.put  → idempotent:true → MCP idempotentHint
//   http.delete → destructive:true + idempotent:true → MCP destructiveHint + idempotentHint
//
// See docs/design/router-model.md §"Verb helpers are verb+implied-tags BUNDLES"

import { resolveSourceMap } from "@rhi-zone/fractal-api-tree";
import type {
  ResolvedSourceMap,
  SourceMapInput as ApiTreeSourceMapInput,
} from "@rhi-zone/fractal-api-tree";
import type { HttpLeafMeta, HttpLeafMetaProperties } from "./project.ts";
import type { HttpStore } from "./decode.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { HttpHandlerMiddleware } from "./route.ts";
import type { Fetch } from "./layers.ts";

// ============================================================================
// HttpMethods — extensible method union
// ============================================================================

/**
 * The known HTTP methods, as an interface so users can extend it via
 * declaration merging (e.g. WebDAV's PROPFIND/MKCOL) without forking this
 * package:
 *
 * ```ts
 * declare module "@rhi-zone/fractal-http-api-projector/verbs" {
 *   interface HttpMethods { PROPFIND: "PROPFIND"; MKCOL: "MKCOL" }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HttpMethods {
  GET: "GET";
  POST: "POST";
  PUT: "PUT";
  PATCH: "PATCH";
  DELETE: "DELETE";
  HEAD: "HEAD";
  OPTIONS: "OPTIONS";
}

/** A known HTTP method name — the key set of `HttpMethods`, open via merging. */
export type Method = keyof HttpMethods;

// ============================================================================
// Verb-helper bundle type
// ============================================================================

/**
 * A verb-helper bundle: a leaf meta CONTRIBUTION value carrying both the verb
 * (as two flat `meta.http.*` scalar keys, see below) and implied tags. Attach
 * to a handler via `op(fn, http.put)` or compose with extra contributions via
 * `op(fn, http.put, { tags: { deprecated: true } })`.
 *
 * Generic in `V` (the verb's own literal, e.g. `"GET"`) so `http.get`'s type
 * is `VerbBundle<"GET">` — `http.verb`/`http.method` carry the literal, not
 * just `string`. Defaults to `string` so a bare `VerbBundle` reference (no
 * type argument) keeps working wherever one already appeared.
 *
 * Deliberately a plain, self-contained object literal type — not `LeafMeta &
 * {...}` — matching the exact variant this bundle constructs rather than the
 * open `HttpLeafMetaProperties`/DU-shaped surface (see docs/design/
 * wire-profiles-and-staged-validation.md's "Exact-variant hygiene"). A
 * producer typed against the wide, all-optional properties interface would
 * widen `V`'s literal to `string` at the call site, and would let an unset
 * `sourceMap`/`middleware` field phantom-contribute an index-signature-erased
 * shape into `op()`'s static source-coverage check (`UncoveredSourceParams`,
 * api-tree's input.ts).
 */
export type VerbBundle<V extends string = string> = {
  readonly http: { readonly verb: V; readonly method: V };
  readonly tags: Record<string, boolean | undefined>;
};

/**
 * `const V` (TS 5.0+) keeps `verb`'s literal type at the call site instead of
 * widening to `string` — `httpVerbBundle("GET", {...})` infers `V = "GET"`,
 * so the returned bundle is `VerbBundle<"GET">`, not `VerbBundle<string>`.
 * This is what lets `http.get`/`http.post`/etc. below carry their literal
 * method through `op()` into a leaf's `meta` (see node.ts's `op()`) and, from
 * there, into `HttpManifest<N>` (http-manifest.ts).
 */
export function httpVerbBundle<const V extends string>(
  verb: V,
  tags: Record<string, boolean | undefined>,
): VerbBundle<V> {
  // Sets BOTH `http.verb` (read by `verbFromTags` in tags.ts — also used by
  // openapi/client's own self-contained tree walks) and `http.method` (read
  // by `applyMethods`, the HttpRoute rewriter in route.ts). Both flat keys
  // describe the same fact; two projectors read two names. Both resolve
  // last-wins, matching every other flat scalar `meta.http.*` key.
  return {
    http: { verb, method: verb },
    tags,
  };
}

// ============================================================================
// Verb-helper bundles
// ============================================================================

/**
 * `http.get` — verb GET + readOnly tag.
 * readOnly ⇒ idempotent (via lattice in resolveTags).
 * Lights up: MCP readOnlyHint, CLI no-confirm, HTTP GET.
 */
const get: VerbBundle<"GET"> = httpVerbBundle("GET", { readOnly: true });

/**
 * `http.post` — verb POST, no implied tags (plain mutation).
 * Conservative: unknown idempotency, unknown destructiveness.
 */
const post: VerbBundle<"POST"> = httpVerbBundle("POST", {});

/**
 * `http.put` — verb PUT + idempotent tag.
 * Lights up: MCP idempotentHint, gRPC idempotency, HTTP PUT.
 */
const put: VerbBundle<"PUT"> = httpVerbBundle("PUT", { idempotent: true });

/**
 * `http.patch` — verb PATCH, no implied tags (plain mutation).
 * Conservative: unknown idempotency.
 */
const patch: VerbBundle<"PATCH"> = httpVerbBundle("PATCH", {});

/**
 * `http.delete` — verb DELETE + destructive and idempotent tags.
 * Lights up: MCP destructiveHint + idempotentHint, CLI confirm, HTTP DELETE.
 */
const _delete: VerbBundle<"DELETE"> = httpVerbBundle("DELETE", {
  destructive: true,
  idempotent: true,
});

/**
 * `http.head` — verb HEAD + readOnly tag (semantically identical to GET).
 * Rarely needed directly — autoMethodLayer derives HEAD from GET automatically.
 */
const head: VerbBundle<"HEAD"> = httpVerbBundle("HEAD", { readOnly: true });

/**
 * `http.options` — verb OPTIONS + readOnly tag.
 * Rarely needed directly — autoMethodLayer handles OPTIONS automatically.
 */
const options: VerbBundle<"OPTIONS"> = httpVerbBundle("OPTIONS", { readOnly: true });

/**
 * `http.moveTo(path)` — DX helper for the flat `meta.http.moveTo` scalar key
 * (see route.ts § applyMoveTo for the path algebra). Returns a plain
 * contribution (no verb, no tags) so it composes with a verb bundle via
 * `mergeMeta`'s last-wins scalar merge:
 *
 * ```ts
 * op(fn, http.get, http.moveTo(".."))
 * // Equivalent to:
 * op(fn, http.get, { http: { moveTo: ".." } })
 * ```
 *
 * `const P` (same technique as `httpVerbBundle`'s `const V`) keeps the
 * argument's literal type — `http.moveTo("..")` returns a bundle whose
 * `http.moveTo` is `".."`, not `string`.
 *
 * Deliberately NOT `LeafMeta & {...}` — same reason as `VerbBundle` above
 * (see its doc comment).
 */
export function moveTo<const P extends string>(path: P): { readonly http: { readonly moveTo: P } } {
  return { http: { moveTo: path } };
}

/**
 * `paginated(options?)` — DX helper for the flat `meta.http.paginated` scalar
 * key (see extensions/pagination.ts's client extension). Optional: detection
 * of "is this endpoint paginated at all" already happens by convention — a
 * handler returning `CursorPage<T>`/`OffsetPage<T>`
 * (packages/api-tree/src/page.ts) is recognized at build time by the
 * extractor (extract.ts) and at client runtime by shape (`isPageShape`), the
 * same two-layer convention `AsyncIterable<T>` uses for streaming. Reach for
 * `paginated()` only to override a default the shape convention can't
 * express on its own — a non-default input field name for the
 * cursor/offset/limit, or an explicit style pin when a response genuinely
 * needs one:
 *
 * ```ts
 * op(listBooks, http.get, paginated({ style: "cursor", inputCursorParam: "after" }))
 * ```
 *
 * Returns a plain contribution (no verb, no tags) so it composes with a verb
 * bundle via `mergeMeta`'s last-wins scalar merge, same as `moveTo()` above.
 */
export function paginated(options: NonNullable<HttpLeafMetaProperties["paginated"]> = {}): {
  readonly http: { readonly paginated: NonNullable<HttpLeafMetaProperties["paginated"]> };
} {
  return { http: { paginated: options } };
}

// ============================================================================
// http.source(map) — per-param HTTP store overrides
// ============================================================================

/**
 * The shorthand + full form `http.source()`'s map argument accepts. A string
 * value is shorthand for "read this param from this store, under its own
 * name" — equivalent to `{ store: value }` (key omitted; `assemble()` in
 * api-tree/src/input.ts already defaults an omitted key to the param name, so
 * the expansion below fills it in explicitly rather than leaning on that
 * default, keeping the stored `SourceMap` shape self-describing). The full
 * form (`{ store, key? }`) is for when the param's own name diverges from the
 * store's key, e.g. pulling `months` from the request body's `budgetMonths`
 * field.
 *
 * `store` is typed to `HttpStore` (decode.ts) — the registered-store
 * registry, extensible via declaration merging — rather than a bare
 * `string`, so only stores some projector (or a user's own `declare module`)
 * actually registered compile. Deliberately NOT `string & {}`: that would
 * accept any string literal and defeat the "only registered stores compile"
 * property this type exists for.
 *
 * `SourceMapInput`/`ResolvedSourceMap`/the shorthand-expansion runtime logic
 * used to be defined here; both are now shared machinery in api-tree's
 * input.ts (`SourceMapInput<Store>`/`ResolvedSourceMap<M>`/
 * `resolveSourceMap`), generalized for every protocol's own `source()`
 * helper — see that module's doc for the full rationale. This alias just
 * narrows the shared generic to `HttpStore`, preserving this package's
 * existing public `SourceMapInput` export shape.
 */
export type SourceMapInput = ApiTreeSourceMapInput<HttpStore>;

/**
 * `http.source(map)` — declares which HTTP store (query, body, path, header,
 * caller) each of a leaf's params should be read from, overriding the
 * method-derived convention (`primaryStoreForMethod`, decode.ts) for just the
 * params listed here.
 *
 * Returns a bare `{ http: { sourceMap: M } }` contribution — a KEY-MERGED map
 * key, not a directive. Composing TWO `http.source()` calls now merges their
 * maps directly at `op()`'s own `FoldMeta<C>` fold (last-wins per key), the
 * same way `mergeMeta` already merges every other meta sub-bag:
 *
 * ```ts
 * op(fn, http.source({ year: "query" }), http.source({ months: "body" }))
 * // → meta.http.sourceMap === {
 * //     year: {store:"query",key:"year"},
 * //     months: {store:"body",key:"months"},
 * //   }
 * ```
 *
 * `getHttpMeta` (project.ts) reads `meta.http.sourceMap` directly — it's
 * already the resolved map the moment `op()`'s fold completes, with no
 * read-time collection step. `naiveTransform` (route.ts) copies it into the
 * matched route's `sources.sourceMap`, which `defaultDecode` (route.ts) then
 * consults during request assembly. (Before the http-directive-dissolution
 * migration this composed as a directive-array entry instead; see docs/design/
 * wire-profiles-and-staged-validation.md's "Prerequisite: meta unification"
 * for the rationale, and node.ts's `mergeRecords`/`MergeMetaValue` doc
 * comments for how the depth-capped object merge resolves two literal-keyed
 * maps like `ResolvedSourceMap<M>`.)
 *
 * String shorthand values are expanded to a full `ParamSource` HERE, eagerly,
 * at the value level — not left for `naiveTransform`/`assemble` (route.ts) to
 * interpret two shapes — so `meta.http.sourceMap` is always a uniform
 * `SourceMap`, the same shape CLI's `meta.cli.sourceMap` and MCP's own
 * sourceMap field already store.
 *
 * ```ts
 * op(getBudget, http.get, http.source({
 *   year: "query",
 *   months: { store: "body", key: "budgetMonths" },
 * }))
 * ```
 */
export function source<const M extends SourceMapInput>(
  map: M,
): { readonly http: { readonly sourceMap: ResolvedSourceMap<M> } } {
  return { http: { sourceMap: resolveSourceMap(map) } };
}

// ============================================================================
// http.validate(schema) — attach a Standard Schema validator to a route
// ============================================================================

/**
 * `http.validate(schema)` — attaches a Standard Schema
 * (https://standardschema.dev/) validator to a leaf: any object exposing
 * `~standard.validate` (Zod, Valibot, ArkType, and other Standard
 * Schema–compliant libraries all implement this out of the box). Returns a
 * bare `{ http: { validate: schema } }` contribution — a flat, last-wins
 * scalar key, same as `moveTo`/`paginated` above.
 *
 * `naiveTransform` (route.ts) reads `meta.http.validate` straight into the
 * leaf's `sources.validate` (single-valued — later call wins, same
 * convention every other flat scalar `meta.http.*` key already follows).
 * `runRoute` (route.ts) then runs the
 * schema — via `runStandardSchema`, decode.ts — against the request's
 * ALREADY-DECODED input bag (after stores → assembled input, before the
 * handler ever sees it): on success the handler receives the validator's own
 * (possibly coerced/transformed) output value instead of the raw assembled
 * bag; on failure the request short-circuits with a 422 response carrying
 * the validator's own `issues`, and the handler never runs.
 *
 * A route with no `http.validate()` call behaves exactly as before —
 * `sources.validate` is simply absent, and `runRoute` skips the validation
 * step entirely.
 *
 * ```ts
 * import { z } from "zod"
 *
 * op(createBook, http.post, http.validate(z.object({
 *   title: z.string().min(1),
 *   year: z.number().int(),
 * })))
 * ```
 */
export function validate(schema: StandardSchemaV1): {
  readonly http: { readonly validate: StandardSchemaV1 };
} {
  return { http: { validate: schema } };
}

// ============================================================================
// http.middleware(...)/http.handlerMiddleware(...) — subtree-scoped request
// wrapping. See docs/design/subtree-layers-spec.md and `HttpSharedMetaProperties`'s
// own `middleware`/`handlerMiddleware` doc comment (project.ts) for the full
// contract (two phases, ancestor-chain composition, ordering).
// ============================================================================

/**
 * `http.middleware(...fns)` — subtree-scoped, dispatch-around request
 * wrapping (`Fetch => Fetch`, the same shape `PresetOptions.middleware`
 * already uses globally, see preset.ts). Attach to a branch to scope every
 * leaf under it, or to a leaf to scope just that operation. Wraps BEFORE the
 * router matches, before decode, before `sources.validate` — the same wire
 * point `PresetOptions.middleware` already runs at, narrowed to a subtree
 * instead of every request.
 *
 * Returns a bare `{ http: { middleware: fns } }` contribution — a plain array
 * under a flat key, not a directive-per-argument encoding. This is
 * load-bearing: `MergeMetaValue`'s array branch (node.ts) concatenates two
 * `middleware` arrays without recursing into their elements, so a function
 * value inside the array is never merged as an object and keeps its call
 * signature. A bare (non-array) function-valued field wouldn't have this
 * property — two contributions setting the same bare key would strip its
 * call signature via `FoldMeta`'s object-merge branch instead (see the
 * regression test in subtree-layers.test.ts).
 * `http.middleware(a, b)` on ONE call already produces one array
 * (`[a, b]`); composing two SEPARATE `middleware()` contributions
 * concatenates their arrays the same way (`[a]` ++ `[b]` = `[a, b]`) — either
 * path lands on the identical ordered wrap list `getHttpMeta` (project.ts)
 * now reads straight off `meta.http.middleware`, no read-time collection
 * needed (the array IS the resolved list, the moment `op()`'s fold
 * completes).
 *
 * ```ts
 * api({ webhooks: api({ stripe: op(handleStripe) }) }, {
 *   meta: { http: middleware(captureRawRequest) },
 * })
 * // captureRawRequest now runs only for requests under /webhooks, not the
 * // whole tree — the motivating case docs/decisions/
 * // one-root-fractal-tree-2026-08-02.md §3.3/§7 names directly.
 * ```
 */
export function middleware(...fns: readonly ((inner: Fetch) => Fetch)[]): {
  readonly http: { readonly middleware: readonly ((inner: Fetch) => Fetch)[] };
} {
  return { http: { middleware: fns } };
}

/**
 * `http.handlerMiddleware(...fns)` — subtree-scoped, handler-around request
 * wrapping (`F => F` where `F = (input, stores) => result`, the same shape
 * `PresetOptions.handlerMiddleware` already uses globally). Wraps INSIDE
 * `runRoute` (route.ts) — after decode and `sources.validate`, before the
 * handler is called — same wire point as the global hook, narrowed to a
 * subtree. Same plain-array-under-a-flat-key shape as `middleware()` above,
 * for the identical reason (see its doc comment).
 *
 * ```ts
 * api({ admin: api({ ... }) }, {
 *   meta: { http: handlerMiddleware(requireAdminRole) },
 * })
 * ```
 */
export function handlerMiddleware(...fns: readonly HttpHandlerMiddleware[]): {
  readonly http: { readonly handlerMiddleware: readonly HttpHandlerMiddleware[] };
} {
  return { http: { handlerMiddleware: fns } };
}

// ============================================================================
// Exported namespace
// ============================================================================

/**
 * HTTP verb-helper bundles.
 *
 * Each is a metadata VALUE (not a wrapper fn) bundling a verb directive and
 * the behavioral tags that verb implies. Attach to a leaf node via `op`:
 *
 * ```ts
 * op(getBook,    http.get)
 * op(createBook, http.post)
 * op(replaceBook, http.put)
 * op(patchBook,  http.patch)
 * op(deleteBook, http.delete)
 * ```
 *
 * Compose with additional meta contributions (deep-merged, later-wins):
 * ```ts
 * op(fn, http.put, { tags: { deprecated: true } })
 * // → verb PUT, idempotent:true (from bundle), deprecated:true (from extra)
 * ```
 *
 * `http.moveTo(path)` composes the same way for repositioning a leaf:
 * ```ts
 * op(fn, http.get, http.moveTo(".."))
 * ```
 */
export const http = {
  get,
  post,
  put,
  patch,
  delete: _delete,
  head,
  options,
  moveTo,
  source,
  validate,
  middleware,
  handlerMiddleware,
  // Every entry is either a verb bundle (a meta contribution VALUE) or a helper
  // that RETURNS one. The parameter is `never[]` rather than a union of the
  // helpers' actual parameter types because `source` is generic (`const M`) —
  // contravariance makes any single-argument function assignable to a
  // `never`-parameter signature, so this keeps checking the part that matters
  // (each entry produces leaf meta) without having to restate a generic
  // signature that would immediately go stale.
} as const satisfies Record<string, VerbBundle | ((...args: never[]) => HttpLeafMeta)>;
