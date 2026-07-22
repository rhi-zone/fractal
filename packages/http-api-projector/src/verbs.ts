// packages/http-api-projector/src/verbs.ts — @rhi-zone/fractal-http-api-projector
//
// Verb-helper bundles: `http.get`, `http.post`, `http.put`, `http.patch`,
// `http.delete`, `http.head`, `http.options`.
//
// Each helper is a METADATA VALUE (a Meta object), NOT a function. It bundles:
//   - the verb pin (a `{kind:"verb",value}` directive in `meta.http.directives`)
//     — wins over tag-derived verb in verbFromTags
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

import type { Meta } from "@rhi-zone/fractal-api-tree/node"
import type { ParamSource } from "@rhi-zone/fractal-api-tree"
import type { HttpDirective } from "./project.ts"
import type { HttpStore } from "./decode.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

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
  GET: "GET"
  POST: "POST"
  PUT: "PUT"
  PATCH: "PATCH"
  DELETE: "DELETE"
  HEAD: "HEAD"
  OPTIONS: "OPTIONS"
}

/** A known HTTP method name — the key set of `HttpMethods`, open via merging. */
export type Method = keyof HttpMethods

// ============================================================================
// Verb-helper bundle type
// ============================================================================

/**
 * A verb-helper bundle: a Meta value carrying both a verb directive and
 * implied tags. Attach to a handler via `op(fn, http.put)` or compose with
 * extra contributions via `op(fn, http.put, { tags: { openWorld: true } })`.
 *
 * Generic in `V` (the verb's own literal, e.g. `"GET"`) so `http.get`'s type
 * is `VerbBundle<"GET">` — the `method` directive's `value` carries the
 * literal, not just `string`. Defaults to `string` so a bare `VerbBundle`
 * reference (no type argument) keeps working wherever one already appeared.
 *
 * Deliberately NOT `Meta & {...}` (an earlier revision was) — `Meta`'s own
 * `http?: HttpMeta` (declaration-merged in project.ts) declares `directives?:
 * readonly HttpDirective[]`, a LOOSE array type; intersecting it with this
 * type's own literal 2-tuple produces `readonly HttpDirective[] & readonly
 * [...]`, and TypeScript does not reliably preserve tuple arity when
 * spreading/recursing over an intersection like that (confirmed directly: a
 * `[...A, ...B]` concatenation of two such intersections collapses to a
 * plain, non-tuple array, and `infer`-based rest-decomposition through it can
 * even produce a distributed union of results depending on which conjunct
 * TS's inference draws from at each step) — which silently defeated
 * `HttpManifest<N>`'s method extraction the moment two contributions were
 * merged (`op(fn, http.get, http.moveTo(".."))`, this package's own
 * `examples/library-api/src/tree.ts` pattern). A plain, self-contained object
 * type is still structurally assignable to `Meta` (all of `Meta`'s own
 * fields are optional) without ever forming that intersection.
 */
export type VerbBundle<V extends string = string> = {
  readonly http: { readonly directives: readonly [HttpDirective<V>, HttpDirective<V>] }
  readonly tags: Record<string, boolean | undefined>
}

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
  // Carries BOTH the `kind: "verb"` directive (read by `verbFromTags` in
  // tags.ts — also used by openapi/client's own self-contained tree walks)
  // and the `kind: "method"` directive (read by `applyMethods`, the
  // HttpRoute rewriter in route.ts). Both directives describe the same
  // fact; two projectors read two shapes.
  return {
    http: { directives: [{ kind: "verb", value: verb }, { kind: "method", value: verb }] },
    tags,
  }
}

// ============================================================================
// Verb-helper bundles
// ============================================================================

/**
 * `http.get` — verb GET + readOnly tag.
 * readOnly ⇒ idempotent (via lattice in resolveTags).
 * Lights up: MCP readOnlyHint, CLI no-confirm, HTTP GET.
 */
const get: VerbBundle<"GET"> = httpVerbBundle("GET", { readOnly: true })

/**
 * `http.post` — verb POST, no implied tags (plain mutation).
 * Conservative: unknown idempotency, unknown destructiveness.
 */
const post: VerbBundle<"POST"> = httpVerbBundle("POST", {})

/**
 * `http.put` — verb PUT + idempotent tag.
 * Lights up: MCP idempotentHint, gRPC idempotency, HTTP PUT.
 */
const put: VerbBundle<"PUT"> = httpVerbBundle("PUT", { idempotent: true })

/**
 * `http.patch` — verb PATCH, no implied tags (plain mutation).
 * Conservative: unknown idempotency.
 */
const patch: VerbBundle<"PATCH"> = httpVerbBundle("PATCH", {})

/**
 * `http.delete` — verb DELETE + destructive and idempotent tags.
 * Lights up: MCP destructiveHint + idempotentHint, CLI confirm, HTTP DELETE.
 */
const _delete: VerbBundle<"DELETE"> = httpVerbBundle("DELETE", { destructive: true, idempotent: true })

/**
 * `http.head` — verb HEAD + readOnly tag (semantically identical to GET).
 * Rarely needed directly — autoMethodLayer derives HEAD from GET automatically.
 */
const head: VerbBundle<"HEAD"> = httpVerbBundle("HEAD", { readOnly: true })

/**
 * `http.options` — verb OPTIONS + readOnly tag.
 * Rarely needed directly — autoMethodLayer handles OPTIONS automatically.
 */
const options: VerbBundle<"OPTIONS"> = httpVerbBundle("OPTIONS", { readOnly: true })

/** A `{ kind: "moveTo" }` directive carrying its `path` as literal `P`. */
type MoveToDirective<P extends string> = Extract<HttpDirective<string, P>, { readonly kind: "moveTo" }>

/**
 * `http.moveTo(path)` — DX helper for the `{ kind: "moveTo", path }` directive
 * (see project.ts § HttpDirective and route.ts § applyMoveTo). Returns a
 * plain `Meta` (no verb, no tags) so it composes with a verb bundle via
 * `mergeMeta`'s array-concatenation of `http.directives`:
 *
 * ```ts
 * op(fn, http.get, http.moveTo(".."))
 * // Equivalent to:
 * op(fn, http.get, { http: { directives: [{ kind: "moveTo", path: ".." }] } })
 * ```
 *
 * `const P` (same technique as `httpVerbBundle`'s `const V`) keeps the
 * argument's literal type — `http.moveTo("..")` returns a bundle whose
 * `directives[0].path` is `".."`, not `string`.
 *
 * Deliberately NOT `Meta & {...}` — same reason as `VerbBundle` above (see
 * its doc comment): intersecting with `Meta`'s own declaration-merged,
 * loosely-typed `http?: HttpMeta` would contaminate this literal 1-tuple the
 * same way, defeating array concatenation across contributions.
 */
export function moveTo<const P extends string>(
  path: P,
): { readonly http: { readonly directives: readonly [MoveToDirective<P>] } } {
  return {
    http: { directives: [{ kind: "moveTo", path } as MoveToDirective<P>] },
  }
}

/** A `{ kind: "paginated" }` directive. See `paginated()` below. */
type PaginatedDirective = Extract<HttpDirective, { readonly kind: "paginated" }>

/**
 * `paginated(options?)` — DX helper for the `{ kind: "paginated" }` directive
 * (see project.ts § HttpDirective and extensions/pagination.ts's client
 * extension). Optional: detection of "is this endpoint paginated at all"
 * already happens by convention — a handler returning `CursorPage<T>`/
 * `OffsetPage<T>` (packages/api-tree/src/page.ts) is recognized at build time
 * by the extractor (extract.ts) and at client runtime by shape
 * (`isPageShape`), the same two-layer convention `AsyncIterable<T>` uses for
 * streaming. Reach for `paginated()` only to override a default the shape
 * convention can't express on its own — a non-default input field name for
 * the cursor/offset/limit, or an explicit style pin when a response
 * genuinely needs one:
 *
 * ```ts
 * op(listBooks, http.get, paginated({ style: "cursor", inputCursorParam: "after" }))
 * ```
 *
 * Returns a plain `Meta` (no verb, no tags) so it composes with a verb
 * bundle via `mergeMeta`'s array-concatenation of `http.directives`, same as
 * `moveTo()` above.
 */
export function paginated(
  options: Omit<PaginatedDirective, "kind"> = {},
): { readonly http: { readonly directives: readonly [PaginatedDirective] } } {
  return {
    http: { directives: [{ kind: "paginated", ...options } as PaginatedDirective] },
  }
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
 */
export type SourceMapInput = Readonly<
  Record<string, HttpStore | { readonly store: HttpStore; readonly key?: string }>
>

/** A `{ kind: "source" }` directive carrying a whole `http.source()` call's map. */
type SourceDirective = Extract<HttpDirective, { readonly kind: "source" }>

/**
 * `http.source(map)` — declares which HTTP store (query, body, path, header,
 * caller) each of a leaf's params should be read from, overriding the
 * method-derived convention (`primaryStoreForMethod`, decode.ts) for just the
 * params listed here.
 *
 * Returns a `{ kind: "source", map }` DIRECTIVE (like `moveTo`/`paginated`
 * above) — appended to `meta.http.directives` — rather than setting a plain
 * merged object directly on `meta.http.sourceMap`. This is NOT the same
 * choice `moveTo`/`paginated` made for their own reasons (literal-type
 * preservation, see `VerbBundle`'s doc comment in this file): here it's
 * because `mergeMeta`'s TYPE-LEVEL counterpart (`FoldMeta`/`MergeTwoMeta`,
 * node.ts) cannot soundly merge two open `Record<string, ParamSource>`
 * index-signature objects — recursing into a keyed mapped type over an
 * index-signature-only type is a genuine TypeScript limitation, surfacing a
 * spurious `| undefined` on every merged entry. Arrays dodge this class of
 * problem entirely (`MergeMetaValue`'s array branch concatenates without
 * recursing into elements), so composing TWO `http.source()` calls produces
 * TWO directive entries instead of one type-level-merged object:
 *
 * ```ts
 * op(fn, http.source({ year: "query" }), http.source({ months: "body" }))
 * // → meta.http.directives === [
 * //     { kind: "source", map: { year: {store:"query",key:"year"} } },
 * //     { kind: "source", map: { months: {store:"body",key:"months"} } },
 * //   ]
 * ```
 *
 * `getHttpMeta` (project.ts) resolves the array of `source` directives back
 * into a single `sourceMap`, in array order (later call's keys win on
 * overlap — same "later wins per key" semantics as every other meta merge,
 * just resolved at READ time instead of at merge time). `naiveTransform`
 * (route.ts) reads that resolved map into the matched route's
 * `sources.sourceMap`, which `defaultDecode` (route.ts) then consults during
 * request assembly.
 *
 * String shorthand values are expanded to a full `ParamSource` HERE, eagerly,
 * at the value level — not left for `naiveTransform`/`assemble` (route.ts) to
 * interpret two shapes — so each directive's `map` is always a uniform
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
export function source(map: SourceMapInput): { readonly http: { readonly directives: readonly [SourceDirective] } } {
  const sourceMap: Record<string, ParamSource> = {}
  for (const [key, value] of Object.entries(map)) {
    sourceMap[key] = typeof value === "string" ? { store: value, key } : value
  }
  return { http: { directives: [{ kind: "source", map: sourceMap } as SourceDirective] } }
}

// ============================================================================
// http.validate(schema) — attach a Standard Schema validator to a route
// ============================================================================

/** A `{ kind: "validate" }` directive carrying a `http.validate()` call's Standard Schema. */
type ValidateDirective = Extract<HttpDirective, { readonly kind: "validate" }>

/**
 * `http.validate(schema)` — attaches a Standard Schema
 * (https://standardschema.dev/) validator to a leaf: any object exposing
 * `~standard.validate` (Zod, Valibot, ArkType, and other Standard
 * Schema–compliant libraries all implement this out of the box). Returns a
 * `{ kind: "validate", schema }` DIRECTIVE (like `moveTo`/`paginated`/
 * `source` above) — appended to `meta.http.directives` — rather than a plain
 * merged field, following the same directive-array composition every other
 * `http.*` helper here uses.
 *
 * `naiveTransform` (route.ts) resolves the LAST `validate` directive on a
 * leaf's meta into that leaf's `sources.validate` (single-valued — later
 * call wins, same convention `getHttpMeta`, project.ts, already applies to
 * `verb`/`method`/`moveTo`/`response`). `runRoute` (route.ts) then runs the
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
export function validate(
  schema: StandardSchemaV1,
): { readonly http: { readonly directives: readonly [ValidateDirective] } } {
  return { http: { directives: [{ kind: "validate", schema } as ValidateDirective] } }
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
 * op(fn, http.put, { tags: { openWorld: true } })
 * // → verb PUT, idempotent:true (from bundle), openWorld:true (from extra)
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
} as const satisfies Record<
  string,
  VerbBundle | ((path: string) => Meta) | ((map: SourceMapInput) => Meta) | ((schema: StandardSchemaV1) => Meta)
>
