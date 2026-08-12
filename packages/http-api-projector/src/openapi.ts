// packages/http-api-projector/src/openapi.ts — @rhi-zone/fractal-http-api-projector
//
// OpenAPI 3.1 projection — merged into http-api-projector (2026-07-18):
// OpenAPI only ever describes HTTP APIs, so it's inherently an HTTP concern
// rather than a separate projection package. Built directly on this
// package's own `HttpRoute` tree instead of re-walking the raw `Node` tree.
//
// Previously this module re-derived verb/segment/path from `meta.http`
// directives and `meta.tags` via its own self-contained tree walk (mirroring
// the retired direct dispatcher). That duplicated exactly what the HttpRoute
// pipeline (`naiveTransform` → `applyMethods`/`applyMoveTo`/`applyResponse`,
// see packages/http-api-projector/src/route.ts) already computes: after the
// rewriters run, the tree's structure IS the URL structure — children keys
// are path segments, `fallback` is the wildcard segment, and `methods` is
// already keyed by the resolved HTTP verb. Walking `HttpRoute` needs no
// segment inference, no verb derivation, no dispatch-marker interpretation.
//
// Two entry points:
//   - `toOpenApiFromRoute(route, opts)` — the core: walks an already-
//     projected `HttpRoute` tree. Operation naming falls back to a
//     path-derived name when no better name is available (see
//     `nameFromPath` below) — a `Node`-derived name map produces more
//     conventional dotted names (see `toOpenApi`).
//   - `toOpenApi(node, opts)` — convenience: projects `node` via
//     `httpProjection` (the standard rewriter pipeline) and also walks the
//     raw `Node` tree once to build a handler → codegen-name map (the same
//     underscore-joined name `extractToolSchemas` and the old tree-walk
//     produced), so operationId/schema-lookup naming is unchanged from
//     before this migration.
//
// See:
//   packages/http-api-projector/src/route.ts    — HttpRoute, naiveTransform, rewriters
//   packages/http-api-projector/src/dx.ts       — httpProjection preset
//   packages/api-tree/src/tree.ts               — extractToolSchemas, SchemaMap
//   packages/api-tree/src/node.ts               — Node, Handler, fallback

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Handler, LeafMeta, Node } from "@rhi-zone/fractal-api-tree/node"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import { httpProjection } from "./dx.ts"
import type { HttpRoute } from "./route.ts"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"

// ============================================================================
// Types
// ============================================================================

/** Options for toOpenApi / toOpenApiFromRoute. */
export type OpenApiOpts = {
  /** Document title (info.title). Defaults to "API". */
  readonly title?: string
  /** Document version (info.version). Defaults to "0.1.0". */
  readonly version?: string
  /**
   * Path to the source file for codegen schema extraction. When provided,
   * extractToolSchemas is called and the resulting schemas are used for
   * requestBody and 200 response schemas. When absent, schemas degrade to
   * `{ type: "object" }` placeholders.
   */
  readonly sourceFile?: string
  /**
   * Pre-computed schema map (from extractToolSchemas). Takes precedence over
   * sourceFile when both are provided. Use this to avoid re-running the
   * TypeScript compiler when the map is already available.
   */
  readonly schemas?: SchemaMap
  /**
   * Spec-level default security requirement (`OpenApiDoc.security`) — applies
   * to every operation that doesn't set its own `meta.openapi.security`. A
   * plain document-level option (same footing as `title`/`version`), NOT
   * read off any tree-authored `meta` value — `openapi.security` on `meta`
   * means exactly one thing now, a per-operation requirement
   * (`HttpLeafMeta`); see docs/design/meta-role-split-spec.md §6 for why the
   * prior root-position reading of the same key was removed rather than kept
   * as a second meaning.
   */
  readonly defaultSecurity?: OpenApiSecurityRequirement[]
  /**
   * `toOpenApi(n, { sourceFile })` only: the exporting binding name for `n` in
   * `sourceFile` — the same `treeId` `extractRouteSchemas` (api-tree/tree.ts)
   * prefixes every key with (`${treeId}/${path}`), and the same value a
   * caller passes as `wrapValidators`' own initial `path` argument
   * (build.ts) to line up with that prefix. Required only when `sourceFile`
   * exports MORE than one tree — `toOpenApi` has no way to tell which export
   * `n` (a plain runtime value with no reflection back to its binding) came
   * from, so `resolveTreeId` throws rather than guessing when there's more
   * than one candidate. Omit it for the common single-tree-per-file case:
   * the sole `treeId` present in the extracted schema map is inferred
   * automatically. Ignored when `opts.schemas` is supplied directly (no
   * `sourceFile` auto-discovery happens, so there is no `treeId` to resolve).
   */
  readonly treeId?: string
}

/** A JSON-Schema-compatible object (open bag — OpenAPI 3.1 allows any $schema). */
export type OpenApiSchema = Record<string, unknown>

/**
 * An OpenAPI 3.1 security scheme object (`components/securitySchemes/<name>`)
 * — open bag since the shape varies by `type` (`http`, `apiKey`, `oauth2`,
 * `openIdConnect`); the OpenAPI projector doesn't validate the shape, only
 * merges it through from `meta.openapi.securitySchemes`.
 */
export type OpenApiSecurityScheme = Record<string, unknown>

/**
 * An OpenAPI 3.1 security requirement object — one entry per alternative
 * (OR); an entry naming multiple scheme keys requires ALL of them (AND). The
 * array value is the list of scopes for oauth2/openIdConnect schemes, `[]`
 * otherwise.
 */
export type OpenApiSecurityRequirement = Record<string, string[]>

/** A single OpenAPI 3.1 path item method entry. */
export type OpenApiOperation = {
  readonly operationId: string
  readonly summary?: string
  readonly description?: string
  readonly tags?: string[]
  readonly deprecated?: boolean
  readonly security?: OpenApiSecurityRequirement[]
  readonly parameters?: OpenApiParameter[]
  readonly requestBody?: {
    readonly required: boolean
    readonly content: {
      readonly "application/json": {
        readonly schema: OpenApiSchema
      }
    }
  }
  readonly responses: {
    readonly "200": {
      readonly description: string
      readonly content: {
        readonly "application/json": {
          readonly schema: OpenApiSchema
        }
      }
    }
  }
  readonly [key: string]: unknown
}

/** An OpenAPI 3.1 path parameter. */
export type OpenApiParameter = {
  readonly name: string
  readonly in: "path"
  readonly required: true
  readonly schema: { readonly type: "string" }
}

/** An OpenAPI 3.1 document (partial — the fields this projection emits). */
export type OpenApiDoc = {
  readonly openapi: "3.1.0"
  readonly info: {
    readonly title: string
    readonly version: string
  }
  readonly paths: Record<string, Record<string, OpenApiOperation>>
  /**
   * Spec-level default security requirement — applies to every operation
   * that doesn't override it with its own `meta.openapi.security`. Sourced
   * from `OpenApiOpts.defaultSecurity` (an explicit builder option), NOT
   * from any tree-authored `meta` value — `openapi.security` on `meta` now
   * means exactly one thing (a per-operation requirement, `HttpLeafMeta`);
   * the spec-level default is a document-level choice, same footing as
   * `title`/`version`/`servers`, not a value smuggled onto the root node's
   * meta where it used to read exactly like a per-operation override that
   * happened to be authored one level up (docs/design/meta-role-split-spec.md
   * §6). Absent when the caller doesn't pass `defaultSecurity`.
   */
  readonly security?: OpenApiSecurityRequirement[]
  /**
   * Present only when at least one node in the tree carries
   * `meta.openapi.securitySchemes` — merged from every such node (see
   * `collectSecuritySchemes` below).
   */
  readonly components?: {
    readonly securitySchemes: Record<string, OpenApiSecurityScheme>
  }
}

// ============================================================================
// Internal: extract path parameters from an OpenAPI path string
// ============================================================================

/** Extract param names from path segments like /books/{bookId}/details → ["bookId"]. */
function pathParams(path: string): string[] {
  const params: string[] = []
  for (const seg of path.split("/")) {
    if (seg.startsWith("{") && seg.endsWith("}")) {
      params.push(seg.slice(1, -1))
    }
  }
  return params
}

// ============================================================================
// Internal: safe openapi meta extraction
// ============================================================================

// ============================================================================
// meta.openapi — role-split fragments (see
// docs/design/meta-role-split-spec.md §2/§4/§6). `openapi.security` has
// exactly ONE meaning now — a per-operation requirement, `HttpLeafMeta`-only
// (§6): the prior ROOT-position "spec-level default" reading of the same
// key was a dual-meaning defect, now fixed by moving that concern to
// `OpenApiOpts.defaultSecurity` (a plain builder option, see `OpenApiDoc`
// above) instead of a second meaning for the same tree-authored field.
// ============================================================================

/** `meta.openapi` fields valid at BOTH leaf and branch position. */
export interface OpenApiSharedMetaProperties {
  /**
   * Security scheme definitions — can be authored on any node in the tree;
   * the OpenAPI projector walks the whole tree (and every method entry) and
   * merges every node's `securitySchemes` bag into `components.securitySchemes`
   * (see `collectSecuritySchemes`). Not itself emitted on any operation.
   */
  readonly securitySchemes?: Record<string, OpenApiSecurityScheme>
}

/** Wraps `OpenApiSharedMetaProperties` under the `openapi` key — combined into `HttpSharedMeta` (see meta.ts). */
export interface OpenApiSharedMeta {
  readonly openapi?: OpenApiSharedMetaProperties
}

/** `meta.openapi` fields valid at LEAF (operation) position only — see `toOpenApi`. */
export interface OpenApiLeafMetaProperties extends OpenApiSharedMetaProperties {
  readonly operationId?: string
  readonly summary?: string
  readonly description?: string
  readonly tags?: string[]
  readonly deprecated?: boolean
  /**
   * Per-operation security requirement — set on a method entry's own meta.
   * "This operation requires scheme A OR scheme B": `[{ a: [] }, { b: [] }]`.
   * The spec-level default is `OpenApiOpts.defaultSecurity`, not a second
   * meaning of this same field (§6) — see `OpenApiDoc.security`'s doc above.
   */
  readonly security?: OpenApiSecurityRequirement[]
  readonly [key: string]: unknown
}

/** Wraps `OpenApiLeafMetaProperties` under the `openapi` key — combined into `HttpLeafMeta` (see meta.ts). */
export interface OpenApiLeafMeta {
  readonly openapi?: OpenApiLeafMetaProperties
}

/** Public alias kept for the exported "resolved per-operation openapi meta" shape — see `getOpenApiMeta`. */
export type OpenApiMeta = OpenApiLeafMetaProperties

function getOpenApiSharedMeta(meta: OpenApiSharedMeta): OpenApiSharedMetaProperties {
  const o = meta.openapi
  if (typeof o !== "object" || o === null) return {}
  return o
}

function getOpenApiMeta(meta: OpenApiLeafMeta): OpenApiLeafMetaProperties {
  const o = meta.openapi
  if (typeof o !== "object" || o === null) return {}
  return o
}

// ============================================================================
// Internal: security scheme collection — walks the whole HttpRoute tree
// merging every node's (and every method entry's) `meta.openapi.
// securitySchemes` bag into one map. Definitions may be authored anywhere in
// the tree; a later-visited node's scheme with the same name overwrites an
// earlier one (last-write-wins — same merge semantics as a plain object
// spread), so a shared scheme is expected to be authored once and reused by
// name from `meta.openapi.security` elsewhere.
// ============================================================================

function collectSecuritySchemes(
  route: HttpRoute,
  out: Record<string, OpenApiSecurityScheme>,
): void {
  // `securitySchemes` is a SHARED-role field (read at both leaf and branch
  // position, per docs/design/meta-role-split-spec.md §4) — `route.meta`/
  // `entry.meta`'s own declared type (`HttpRoute`, route.ts) carries only
  // this package's `http` namespace, not `openapi`, so the cast here is
  // reading a field the expression's own static type doesn't declare, not
  // widening past a real constraint (see route.ts's `RouteMeta`/
  // `RouteLeafMeta` doc comment for why no OTHER cast in this file needs
  // this — this is the one place `openapi` fields are read directly off an
  // `HttpRoute` value rather than through `RouteEntry.meta`, below).
  const nodeSchemes = getOpenApiSharedMeta(route.meta as OpenApiSharedMeta).securitySchemes
  if (typeof nodeSchemes === "object" && nodeSchemes !== null) {
    Object.assign(out, nodeSchemes)
  }
  for (const entry of Object.values(route.methods ?? {})) {
    const entrySchemes = getOpenApiSharedMeta(entry.meta as OpenApiSharedMeta).securitySchemes
    if (typeof entrySchemes === "object" && entrySchemes !== null) {
      Object.assign(out, entrySchemes)
    }
  }
  for (const child of Object.values(route.children ?? {})) {
    collectSecuritySchemes(child, out)
  }
  if (route.fallback !== undefined) {
    collectSecuritySchemes(route.fallback.subtree, out)
  }
}

// ============================================================================
// Internal: handler → codegen-name map, built from the raw Node tree
//
// Mirrors extractToolSchemas'/the pre-migration walkTree's underscore-joined
// name construction, but keyed by handler IDENTITY rather than tree
// position — because after `applyMoveTo` runs, a handler's position in the
// final HttpRoute tree is no longer its authored tree position (e.g.
// read/replace/remove co-locate onto their parent's fallback position). This
// is what lets `toOpenApi(node, ...)` keep producing the same
// `books.bookId.read`-style operationIds and codegen schema-map lookups as
// before this migration, without the OpenAPI walk itself re-deriving path.
//
// Degrades gracefully when a handler isn't found in the map (e.g. it was
// re-wrapped by `applyResponse`, which produces a new function — response
// overrides are rare and this only affects that operation's default name,
// never correctness of path/verb): callers fall back to a path-derived name.
// ============================================================================

function nameLeaves(n: Node, prefix: string, out: Map<Handler, string>): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    const seg = prefix.length > 0 ? `${prefix}_${key}` : key
    if (isLeaf(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(child.handler!, seg)
    } else {
      nameLeaves(child, seg, out)
    }
  }
  if (n.fallback !== undefined) {
    const seg = prefix.length > 0 ? `${prefix}_${n.fallback.name}` : n.fallback.name

    // Same bare-leaf `fallback.subtree` case as client.ts's
    // `collectHandlerNames`/`collectCodegenNames` — key it directly at `seg`
    // (no extra segment beyond the fallback's own name) instead of
    // recursing into a leaf's nonexistent `children`.
    if (isLeaf(n.fallback.subtree)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(n.fallback.subtree.handler!, seg)
    } else {
      nameLeaves(n.fallback.subtree, seg, out)
    }
  }
}

/** Build the handler → codegen-name map for a Node tree — see module doc above. */
function buildNameMap(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>()
  nameLeaves(n, "", out)
  return out
}

/** Fallback name derived purely from path + verb, for handlers absent from a name map. */
function nameFromPath(path: string, verb: string): string {
  const base = path === "/"
    ? "root"
    : path
        .split("/")
        .filter((s) => s.length > 0)
        .map((s) => (s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s))
        .join("_")
  return `${base}_${verb.toLowerCase()}`
}

// ============================================================================
// buildPathMap — handler -> tree-relative "/"-joined PATH, for schema
// correlation (as opposed to buildNameMap's underscore-joined codegen NAME,
// used for operationId defaults) — see extractRouteSchemas's doc
// (api-tree/tree.ts) for why these are two genuinely different keyings, not
// a separator swap of the same string: a bare tool name is unique only
// within one standalone tree; a tree path stays unique once several files'
// trees are nested as branches under one composed root, because each
// file's own path is still relative to ITS OWN subtree, and merging several
// files' SchemaMaps (each produced by extractRouteSchemas) into one object
// for a composed root's toOpenApi call only works if the correlation done
// here uses that SAME path-keyed convention, not the name-keyed one.
// ============================================================================

function pathLeaves(n: Node, prefix: readonly string[], out: Map<Handler, string>): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    const seg = [...prefix, key]
    if (isLeaf(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(child.handler!, seg.join("/"))
    } else {
      pathLeaves(child, seg, out)
    }
  }
  if (n.fallback !== undefined) {
    // `:name` (colon-prefixed), matching extractRouteTypeRefs's own
    // fallback path segment (api-tree/tree.ts) — the SAME convention
    // `wrapValidators`'s runtime `path.join("/")` lookup key already uses,
    // deliberately different from buildNameMap's bare-name fallback segment
    // (that one feeds operationId defaults, not schema/validator lookup).
    const seg = [...prefix, `:${n.fallback.name}`]
    if (isLeaf(n.fallback.subtree)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(n.fallback.subtree.handler!, seg.join("/"))
    } else {
      pathLeaves(n.fallback.subtree, seg, out)
    }
  }
}

/**
 * Build the handler → tree-relative "/"-joined path map for a `Node` tree —
 * see module doc above. `prefix` seeds the walk's accumulated path — pass
 * `[treeId]` to match `extractRouteSchemas`' `${treeId}/${path}` keying (see
 * `resolveTreeId`/`OpenApiOpts.treeId`); omitted (`[]`) reproduces the prior,
 * unprefixed behavior for a caller-supplied (non-auto-discovered) schema map.
 */
function buildPathMap(n: Node, prefix: readonly string[] = []): Map<Handler, string> {
  const out = new Map<Handler, string>()
  pathLeaves(n, prefix, out)
  return out
}

/**
 * Every distinct `treeId` prefix present in a `SchemaMap`'s own keys — a
 * `${treeId}/${path}` key's `treeId` is everything before the first `/`
 * (`treeId` is a JS binding name, so it never contains one itself). Used only
 * to INFER the sole `treeId` in the common single-tree-per-file case; see
 * `resolveTreeId`.
 */
function distinctTreeIds(schemas: SchemaMap): string[] {
  const ids = new Set<string>()
  for (const key of Object.keys(schemas)) {
    const slash = key.indexOf("/")
    ids.add(slash === -1 ? key : key.slice(0, slash))
  }
  return [...ids]
}

/**
 * Resolve the `treeId` `buildPathMap` needs to line up with
 * `extractRouteSchemas`' `${treeId}/${path}` keying (tree.ts) — see
 * `OpenApiOpts.treeId`'s doc comment for the full rationale. An explicit
 * `treeId` always wins; otherwise inferred from `schemas`' own keys when
 * exactly one distinct prefix is present. More than one throws — silently
 * picking one (or trying every prefix and taking the first hit) would risk
 * correlating `n` against a DIFFERENT tree's schema, exactly the
 * silent-wrong-schema failure mode `extractRouteSchemas`' `treeId` prefix was
 * introduced to prevent (see that function's own doc comment). Returns
 * `undefined` (no prefix) when `schemas` is empty — nothing to correlate
 * against, so the existing `{ type: "object" }` placeholder degrade still
 * applies, unchanged.
 */
function resolveTreeId(schemas: SchemaMap, explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit
  const ids = distinctTreeIds(schemas)
  if (ids.length > 1) {
    throw new Error(
      `toOpenApi: sourceFile exports ${ids.length} trees (${ids.join(", ")}) — schema correlation ` +
        `can't tell which one "n" is. Pass opts.treeId to disambiguate.`,
    )
  }
  return ids[0]
}

// ============================================================================
// listRoutes — public API: HttpRoute walk, one entry per (path, method)
// ============================================================================

/** One `(path, method)` leaf produced by walking an `HttpRoute` tree — see `listRoutes`. */
export type RouteEntry = {
  /** Underscore-joined name (default operationId source) — see `nameFromPath`. */
  readonly codenName: string
  /**
   * Tree-relative "/"-joined path (schema-map lookup key when the schema
   * map was built via `extractRouteSchemas`, api-tree/tree.ts) — see
   * `buildPathMap`'s module doc for why this is a DIFFERENT key from
   * `codenName`, not the same string with a different separator. Falls
   * back to a path-derived `"/"`-joined key (mirroring `nameFromPath`'s own
   * fallback shape) when `pathMap` is omitted or has no entry for a given
   * handler, the same degrade `codenName` already has for `names`.
   */
  readonly schemaKey: string
  /** HTTP path string, e.g. `/books/{bookId}/details`. */
  readonly path: string
  /** HTTP method, in whatever case the route tree's `methods` keys use (uppercase for trees built via `httpProjection`). */
  readonly verb: string
  /** The method entry's own meta bag. */
  readonly meta: LeafMeta & OpenApiLeafMeta
}

/** Fallback "/"-joined path+verb key, for handlers absent from a `pathMap` — mirrors `nameFromPath`'s shape with `/` instead of `_`. */
function pathKeyFromPath(path: string, verb: string): string {
  const base = path === "/"
    ? ""
    : path
        .split("/")
        .filter((s) => s.length > 0)
        .map((s) => (s.startsWith("{") && s.endsWith("}") ? `:${s.slice(1, -1)}` : s))
        .join("/")
  return base.length > 0 ? `${base}/${verb.toLowerCase()}` : verb.toLowerCase()
}

/**
 * Enumerate every `(path, method)` leaf of an already-projected `HttpRoute`
 * tree, in tree order. Path and verb come directly from the route tree's own
 * structure (children keys, `fallback`, `methods` keys) — exactly matching
 * what `makeRouterFromRoute` dispatches against and what `toOpenApiFromRoute`
 * projects into path items. This is the shared walk both `toOpenApi`/
 * `toOpenApiFromRoute` (this module) and any other consumer that needs a
 * flat route inventory from the same tree (e.g. deriving a route table
 * without building a full OpenAPI document) should use — do not re-walk
 * `HttpRoute` independently.
 *
 * `codenName` falls back to a path-derived name (`nameFromPath`) when `names`
 * is omitted or doesn't have an entry for a given handler — a bare
 * `HttpRoute` has no memory of the authored `Node` tree position a moved
 * handler started at. Pass the handler → codegen-name map built from the
 * original `Node` tree (see `toOpenApi`'s internal `buildNameMap`) to recover
 * conventional dotted names.
 *
 * @param route   - The (already rewritten) HttpRoute tree to walk.
 * @param path    - Path prefix accumulated so far; omit at the top-level call.
 * @param names   - Optional handler → codegen-name map for `codenName`.
 * @param pathMap - Optional handler → tree-path map for `schemaKey` (see `buildPathMap`).
 */
export function listRoutes(
  route: HttpRoute,
  path = "",
  names?: ReadonlyMap<Handler, string>,
  pathMap?: ReadonlyMap<Handler, string>,
): RouteEntry[] {
  const out: RouteEntry[] = []

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const codenName = names?.get(entry.handler) ?? nameFromPath(path === "" ? "/" : path, verb)
    const schemaKey = pathMap?.get(entry.handler) ?? pathKeyFromPath(path === "" ? "/" : path, verb)
    out.push({ codenName, schemaKey, path: path === "" ? "/" : path, verb, meta: entry.meta })
  }

  for (const [key, child] of Object.entries(route.children ?? {})) {
    out.push(...listRoutes(child, `${path}/${key}`, names, pathMap))
  }

  if (route.fallback !== undefined) {
    out.push(
      ...listRoutes(route.fallback.subtree, `${path}/{${route.fallback.name}}`, names, pathMap),
    )
  }

  return out
}

// ============================================================================
// toOpenApiFromRoute — public API (core)
// ============================================================================

/**
 * Project an already-projected `HttpRoute` tree to an OpenAPI 3.1 document
 * object. Each `methods` entry becomes one path item method entry — path and
 * verb come directly from the route tree's own structure (children keys,
 * `fallback`, `methods` keys), exactly matching what `makeRouterFromRoute`
 * dispatches against.
 *
 * Operation naming (operationId default + codegen schema-map lookup) falls
 * back to a path-derived name (`nameFromPath`) since a bare `HttpRoute` has
 * no memory of the authored tree position a moved handler started at. Use
 * `toOpenApi(node, opts)` when the original `Node` tree is available for
 * conventional dotted operationIds.
 *
 * meta.openapi on a method entry carries per-operation OpenAPI overrides:
 * operationId, summary, description, tags, deprecated. Any unrecognised keys
 * pass through.
 *
 * `deprecated` also reads from the tree-level `meta.tags.deprecated` (the
 * standard cross-projector tag — see api-tree/src/tags.ts) so CLI/MCP/HTTP
 * all see the same authored fact. `meta.openapi.deprecated` is a
 * per-projection override and wins when explicitly set (backward compat with
 * documents authored before `deprecated` became a tree-level tag).
 *
 * @param route - The (already rewritten) HttpRoute tree to project.
 * @param opts  - Options: title, version, sourceFile, schemas.
 */
export async function toOpenApiFromRoute(route: HttpRoute, opts: OpenApiOpts = {}): Promise<OpenApiDoc> {
  return buildDoc(route, opts, undefined, undefined)
}

// ============================================================================
// toOpenApi — public API (Node convenience wrapper)
// ============================================================================

/**
 * Project a `Node` tree to an OpenAPI 3.1 document object. Internally
 * projects `n` via `httpProjection` (the standard `naiveTransform` +
 * `applyMethods`/`applyMoveTo`/`applyResponse` pipeline — the same one
 * `createFetch`/`httpRoutes` use) and walks the resulting `HttpRoute`, so
 * the emitted paths exactly match the live HTTP router. Input/output schemas
 * come from extractToolSchemas (codegen) when a sourceFile or schemas map is
 * supplied; otherwise they degrade to `{ type: "object" }` placeholders.
 *
 * @param n    - The root node to project.
 * @param opts - Options: title, version, sourceFile, schemas, treeId.
 */
export async function toOpenApi(n: Node, opts: OpenApiOpts = {}): Promise<OpenApiDoc> {
  const route = httpProjection(n)
  const names = buildNameMap(n)

  // Auto-discovery (`sourceFile`, no caller-supplied `schemas`) keys every
  // entry `${treeId}/${path}` (extractRouteSchemas) — `buildPathMap` must be
  // seeded with the SAME `treeId` or every lookup misses and silently
  // degrades to the `{ type: "object" }` placeholder (TODO.md's "toOpenApi
  // auto-discovery key mismatch" entry). Resolved here, once, so both the
  // schema map and the path map `buildDoc` receives are already correlated
  // — a caller-supplied `opts.schemas` skips this entirely (no `sourceFile`
  // extraction to correlate against, `buildPathMap` stays unprefixed exactly
  // as before this fix).
  let schemas: SchemaMap = opts.schemas ?? {}
  let treeId: string | undefined
  if (Object.keys(schemas).length === 0 && opts.sourceFile !== undefined) {
    // `webpackIgnore` (Rspack honors the webpack-prefixed spelling too, see
    // the comment on buildDoc's identical import below) — found via
    // examples/doc-site-verification's real `docusaurus build` pass
    // (docs/design/mocked-fetch-backend.md's dated write-up): without this,
    // a bundler eagerly resolves THIS dynamic import's whole target module
    // graph (api-tree's tree.ts -> extract.ts -> type-ir's
    // from-typescript.ts, which imports the real `typescript` package and
    // Node's `node:fs`/`node:path`) even though the import only actually
    // fires when a caller passes `opts.sourceFile` — which `preset.ts`'s
    // `createFetch`/`toDropInFetch` (documented as usable client-side for a
    // doc-embedded live playground with no deployed server yet, per
    // mocked-fetch-backend.md) never does. Bundlers resolve a dynamic
    // `import()`'s target chunk at BUILD time regardless of whether the
    // runtime branch guarding it ever executes, so without this comment
    // *every* browser consumer of `createFetch`/`toOpenApiFromRoute` fails
    // to bundle at all, not just ones that pass `sourceFile`. The magic
    // comment tells the bundler to leave this as a literal runtime
    // `import()` instead of pre-bundling it — correct here because
    // `sourceFile` extraction is inherently Node-only (real filesystem +
    // TypeScript compiler) and was never going to work in a browser bundle
    // regardless; this only stops it from poisoning callers who never use it.
    const { extractRouteSchemas } = await import(/* webpackIgnore: true */ "@rhi-zone/fractal-api-tree/tree")
    schemas = extractRouteSchemas(opts.sourceFile)
    treeId = resolveTreeId(schemas, opts.treeId)
  }

  const pathMap = buildPathMap(n, treeId !== undefined ? [treeId] : [])
  return buildDoc(route, { ...opts, schemas }, names, pathMap)
}

// ============================================================================
// Shared doc builder
// ============================================================================

async function buildDoc(
  route: HttpRoute,
  opts: OpenApiOpts,
  names: ReadonlyMap<Handler, string> | undefined,
  pathMap: ReadonlyMap<Handler, string> | undefined,
): Promise<OpenApiDoc> {
  const title = opts.title ?? "API"
  const version = opts.version ?? "0.1.0"

  // Resolve schema map: caller-supplied > sourceFile > empty. The
  // auto-discovery path uses extractRouteSchemas (path-keyed), matching
  // this module's own preferred schemaKey lookup above — a caller-supplied
  // `opts.schemas` may still be either convention (or a merge of several
  // files' extractRouteSchemas output), handled by the fallback chain above.
  let schemas: SchemaMap = opts.schemas ?? {}
  if (Object.keys(schemas).length === 0 && opts.sourceFile !== undefined) {
    // See the identical import's doc comment in `toOpenApi` above — same
    // bundler-safety `webpackIgnore` fix, same reason.
    const { extractRouteSchemas } = await import(/* webpackIgnore: true */ "@rhi-zone/fractal-api-tree/tree")
    schemas = extractRouteSchemas(opts.sourceFile)
  }

  const entries = listRoutes(route, "", names, pathMap)

  // Security schemes: merged from every node in the tree (see
  // collectSecuritySchemes doc above). Only emitted on the doc when at least
  // one scheme was found — an empty components.securitySchemes would be
  // noise on documents that don't use this feature.
  const securitySchemes: Record<string, OpenApiSecurityScheme> = {}
  collectSecuritySchemes(route, securitySchemes)

  // Spec-level default security: an explicit builder option now, not read
  // off any node's meta — see `OpenApiOpts.defaultSecurity`'s doc comment
  // and docs/design/meta-role-split-spec.md §6.
  const rootSecurity = opts.defaultSecurity

  const paths: Record<string, Record<string, OpenApiOperation>> = {}

  for (const entry of entries) {
    const { codenName, schemaKey, path, verb, meta } = entry
    const method = verb.toLowerCase()
    const openApiMeta = getOpenApiMeta(meta)
    // Path-keyed lookup first (schemas built via extractRouteSchemas — the
    // convention that stays unique under composition, buildPathMap's module
    // doc), falling back to the legacy name-keyed lookup (schemas built via
    // extractToolSchemas, or hand-authored with that convention) — a pure
    // fallback CHAIN, not a replacement, so every existing caller passing a
    // name-keyed SchemaMap keeps resolving exactly as before.
    const toolSchema = schemas[schemaKey] ?? schemas[codenName]

    // Derive operationId from meta.openapi.operationId, or from the codegen name
    const operationId = typeof openApiMeta.operationId === "string"
      ? openApiMeta.operationId
      : codenName.replace(/_/g, ".")

    // Path parameters: extracted from the computed path
    const paramNames = pathParams(path)
    const parameters: OpenApiParameter[] = paramNames.map((name) => ({
      name,
      in: "path" as const,
      required: true as const,
      schema: { type: "string" as const },
    }))

    // requestBody: for non-GET methods that have a non-empty inputSchema
    const inputSchema = toolSchema?.inputSchema as OpenApiSchema | undefined
    const hasRequestBody = method !== "get" && inputSchema !== undefined &&
      !(Object.keys(inputSchema).length === 1 && inputSchema["type"] === "object" &&
        inputSchema["properties"] === undefined)

    const requestBody = hasRequestBody
      ? {
          required: true as const,
          content: {
            "application/json": {
              schema: inputSchema as OpenApiSchema,
            },
          },
        }
      : undefined

    // 200 response schema from codegen output
    const outputSchema: OpenApiSchema = (toolSchema?.outputSchema as OpenApiSchema | undefined) ?? { type: "object" }

    // Build operation, merging any passthrough keys from meta.openapi
    const {
      operationId: _oid,
      summary,
      description,
      tags: opTags,
      deprecated,
      security: opSecurity,
      securitySchemes: _securitySchemes,
      ...extraOpenApiMeta
    } = openApiMeta

    // deprecated: meta.openapi.deprecated (per-projection override) wins when
    // explicitly set; otherwise fall back to the tree-level meta.tags.deprecated
    // tag so the same authored fact reaches every projector.
    const resolvedDeprecated = deprecated === true
      ? true
      : resolveTags((meta.tags ?? {}) as Tags).deprecated === true

    const operation: OpenApiOperation = {
      operationId,
      ...(typeof summary === "string" ? { summary } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(Array.isArray(opTags) ? { tags: opTags } : {}),
      ...(resolvedDeprecated ? { deprecated: true } : {}),
      ...(Array.isArray(opSecurity) ? { security: opSecurity } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
      responses: {
        "200": {
          description: "Success",
          content: {
            "application/json": {
              schema: outputSchema,
            },
          },
        },
      },
      ...extraOpenApiMeta,
    }

    if (paths[path] === undefined) {
      paths[path] = {}
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    paths[path]![method] = operation
  }

  return {
    openapi: "3.1.0",
    info: { title, version },
    paths,
    ...(Array.isArray(rootSecurity) ? { security: rootSecurity } : {}),
    ...(Object.keys(securitySchemes).length > 0 ? { components: { securitySchemes } } : {}),
  }
}

// ============================================================================
// mergeOpenApiDocs — public API
// ============================================================================

/**
 * Merge multiple OpenAPI documents (each produced by `toOpenApi`/
 * `toOpenApiFromRoute` over a different tree) into one. Mirrors
 * `applyMoveTo`'s route-tree merge (`mergeRoutes` in route.ts): a path+method
 * defined by more than one input document is a genuine authoring conflict —
 * which operation would serve the request? — not something a merge can
 * silently resolve, so this throws naming the exact path and method that
 * collided, in the same style as `mergeRoutes`'s conflict message.
 *
 * `components.securitySchemes` is merged by scheme name across every doc,
 * with the same conflict philosophy: a name defined by more than one
 * document throws rather than picking one side's definition, since a shared
 * scheme name is expected to be authored once (see `collectSecuritySchemes`'
 * doc comment on same-tree scheme merging, which — unlike this cross-document
 * merge — uses last-write-wins because it's merging one authored tree's own
 * intentionally-shared definitions, not independently-authored documents).
 *
 * `openapi`/`info`/`security` are taken from the first document in `docs`;
 * merging across documents authored with different title/version/security is
 * not a case this function reconciles — pass a shared `opts.title`/
 * `opts.version` to the builders that produced `docs`, or override the
 * returned document's `info` directly.
 *
 * @param docs - The documents to merge, in priority order for `info`/`security` (at least one required).
 */
export function mergeOpenApiDocs(docs: readonly OpenApiDoc[]): OpenApiDoc {
  if (docs.length === 0) {
    throw new Error("mergeOpenApiDocs: at least one document is required")
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const first = docs[0]!

  const paths: Record<string, Record<string, OpenApiOperation>> = {}
  const securitySchemes: Record<string, OpenApiSecurityScheme> = {}

  for (const doc of docs) {
    for (const [path, methods] of Object.entries(doc.paths)) {
      const existing = paths[path] ?? {}
      for (const [method, operation] of Object.entries(methods)) {
        if (method in existing) {
          throw new Error(
            `mergeOpenApiDocs: conflicting route — ${method} ${path} is defined by more than one document`,
          )
        }
        existing[method] = operation
      }
      paths[path] = existing
    }

    for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
      if (name in securitySchemes) {
        throw new Error(
          `mergeOpenApiDocs: conflicting security scheme — "${name}" is defined by more than one document`,
        )
      }
      securitySchemes[name] = scheme
    }
  }

  return {
    openapi: first.openapi,
    info: first.info,
    paths,
    ...(first.security !== undefined ? { security: first.security } : {}),
    ...(Object.keys(securitySchemes).length > 0 ? { components: { securitySchemes } } : {}),
  }
}
