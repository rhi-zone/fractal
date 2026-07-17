// packages/openapi-api-projector/src/index.ts — @rhi-zone/fractal-openapi-api-projector
//
// OpenAPI 3.1 projection — now built directly on the HTTP projector's own
// `HttpRoute` tree instead of re-walking the raw `Node` tree.
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
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import { httpProjection } from "@rhi-zone/fractal-http-api-projector/dx"
import type { HttpRoute } from "@rhi-zone/fractal-http-api-projector/route"
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
}

/** A JSON-Schema-compatible object (open bag — OpenAPI 3.1 allows any $schema). */
export type OpenApiSchema = Record<string, unknown>

/** A single OpenAPI 3.1 path item method entry. */
export type OpenApiOperation = {
  readonly operationId: string
  readonly summary?: string
  readonly description?: string
  readonly tags?: string[]
  readonly deprecated?: boolean
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

/** Per-operation OpenAPI overrides read from `meta.openapi` — see `toOpenApi`. */
export type OpenApiMeta = {
  readonly operationId?: string
  readonly summary?: string
  readonly description?: string
  readonly tags?: string[]
  readonly deprecated?: boolean
  readonly [key: string]: unknown
}

function getOpenApiMeta(meta: Meta): OpenApiMeta {
  const o = meta.openapi
  if (typeof o !== "object" || o === null) return {}
  return o as OpenApiMeta
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
    nameLeaves(n.fallback.subtree, seg, out)
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
// Internal: HttpRoute walk — computes (codenName, path, verb, meta) per method
// ============================================================================

type RouteEntry = {
  readonly codenName: string // underscore-joined name (for schema lookup + default operationId)
  readonly path: string // HTTP path string e.g. /books/{bookId}/details
  readonly verb: string // HTTP method in uppercase
  readonly meta: Meta // the method entry's own meta bag
}

function walkRoute(
  route: HttpRoute,
  path: string,
  names: ReadonlyMap<Handler, string> | undefined,
): RouteEntry[] {
  const out: RouteEntry[] = []

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const codenName = names?.get(entry.handler) ?? nameFromPath(path === "" ? "/" : path, verb)
    out.push({ codenName, path: path === "" ? "/" : path, verb, meta: entry.meta })
  }

  for (const [key, child] of Object.entries(route.children ?? {})) {
    out.push(...walkRoute(child, `${path}/${key}`, names))
  }

  if (route.fallback !== undefined) {
    out.push(...walkRoute(route.fallback.subtree, `${path}/{${route.fallback.name}}`, names))
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
 * @param route - The (already rewritten) HttpRoute tree to project.
 * @param opts  - Options: title, version, sourceFile, schemas.
 */
export async function toOpenApiFromRoute(route: HttpRoute, opts: OpenApiOpts = {}): Promise<OpenApiDoc> {
  return buildDoc(route, opts, undefined)
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
 * @param opts - Options: title, version, sourceFile, schemas.
 */
export async function toOpenApi(n: Node, opts: OpenApiOpts = {}): Promise<OpenApiDoc> {
  const route = httpProjection(n)
  const names = buildNameMap(n)
  return buildDoc(route, opts, names)
}

// ============================================================================
// Shared doc builder
// ============================================================================

async function buildDoc(
  route: HttpRoute,
  opts: OpenApiOpts,
  names: ReadonlyMap<Handler, string> | undefined,
): Promise<OpenApiDoc> {
  const title = opts.title ?? "API"
  const version = opts.version ?? "0.1.0"

  // Resolve schema map: caller-supplied > sourceFile > empty
  let schemas: SchemaMap = opts.schemas ?? {}
  if (Object.keys(schemas).length === 0 && opts.sourceFile !== undefined) {
    const { extractToolSchemas } = await import("@rhi-zone/fractal-api-tree/tree")
    schemas = extractToolSchemas(opts.sourceFile)
  }

  const entries = walkRoute(route, "", names)

  const paths: Record<string, Record<string, OpenApiOperation>> = {}

  for (const entry of entries) {
    const { codenName, path, verb, meta } = entry
    const method = verb.toLowerCase()
    const openApiMeta = getOpenApiMeta(meta)
    const toolSchema = schemas[codenName]

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
    const { operationId: _oid, summary, description, tags: opTags, deprecated, ...extraOpenApiMeta } = openApiMeta

    const operation: OpenApiOperation = {
      operationId,
      ...(typeof summary === "string" ? { summary } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(Array.isArray(opTags) ? { tags: opTags } : {}),
      ...(deprecated === true ? { deprecated: true } : {}),
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
  }
}
