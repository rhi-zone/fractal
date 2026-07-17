// packages/openapi-api-projector/src/index.ts — @rhi-zone/fractal-openapi-api-projector
//
// OpenAPI 3.1 projection for the function-core tree.
//
// Walks a Node tree once, computing for each leaf node (node with handler):
//   - the codegen-style underscore name (for extractToolSchemas lookup)
//   - the HTTP path + verb (same logic as the direct tree-walk dispatch in
//     packages/http-api-projector/src/project.ts)
//   - the leaf's OWN tags (for verb derivation and documentation — no
//     ancestor inheritance; see docs/design/router-model.md — "Tags")
//
// In the new node model, leaf nodes (nodes with `handler`) live in `children`
// alongside branch nodes. A leaf child keyed `k` behaves exactly as an op
// keyed `k` did: its key contributes to path/name, its meta drives verb.
// A `fallback` (wildcard-capture) contributes `{name}` as a path segment,
// same as the HTTP projection.
//
// SELF-CONTAINED TREE WALK: OpenAPI walks the tree itself computing
// name+path+verb+schema together (mirroring the pattern used by toTools in
// packages/mcp), rather than depending on http/project.ts's dispatch
// internals. The path/verb derivation copies the same logic
// (inferSegment, verbFromTags) to guarantee paths match exactly.
//
// See:
//   packages/http-api-projector/src/project.ts — verbFromTags, meta.http DU (dispatch/directives)
//   packages/codegen/src/tree.ts — extractToolSchemas, SchemaMap
//   packages/api-tree/src/node.ts    — Node, Handler, fallback
//   packages/api-tree/src/tags.ts    — resolveTags

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import { getHttpMeta, verbFromTags } from "@rhi-zone/fractal-http-api-projector/project"
import type { SchemaMap } from "@rhi-zone/fractal-codegen"

// ============================================================================
// Types
// ============================================================================

/** Options for toOpenApi. */
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
// Internal: segment inference (mirrors packages/http-api-projector/src/project.ts exactly)
// ============================================================================

function inferSegment(name: string): string {
  const stripped = name
    .replace(/^(get|list|find|read|create|send|award|delete|remove)/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/^-/, "")
    .toLowerCase()
  return stripped.length > 0 ? stripped : name.toLowerCase()
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
// Internal: tree walk — computes (codenName, httpPath, verb, leafMeta) per leaf
// ============================================================================

type RouteEntry = {
  readonly codenName: string  // underscore-joined tree position (for schema lookup)
  readonly path: string       // HTTP path string e.g. /books/{bookId}/details
  readonly verb: string       // HTTP method in uppercase
  readonly meta: Meta         // leaf's own meta bag
}

function walkTree(
  n: Node,
  httpPrefix: string,
  namePrefix: string,
): RouteEntry[] {
  const out: RouteEntry[] = []

  // Attribute-dispatch: if this node has dispatch:"method", its leaf children
  // share the node's own HTTP path rather than getting a per-child segment.
  // Non-method dispatch (dispatch:"attr") is treated as segment-dispatch in
  // OpenAPI: each child gets a path segment equal to its key or segment rename.
  const thisHttp = getHttpMeta(n.meta)
  const methodDispatch = thisHttp.dispatch?.kind === "method"
  // "attr" dispatch → OpenAPI treats children as segment-dispatched (approximation)

  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      // Leaf node: build a route entry for it. Tags are read directly from
      // the leaf's own meta — no ancestor inheritance.
      const verb = verbFromTags(child.meta)
      const http = getHttpMeta(child.meta)

      const codenName = namePrefix.length > 0 ? `${namePrefix}_${key}` : key

      if (http.legacyPath !== undefined) {
        out.push({ codenName, path: http.legacyPath, verb, meta: child.meta })
      } else if (methodDispatch) {
        // Method-dispatch: leaf resolves to the parent's own path
        const path = httpPrefix === "" ? "/" : httpPrefix
        out.push({ codenName, path, verb, meta: child.meta })
      } else {
        // Segment-dispatch (default) or attr-dispatch (treated as segment for OpenAPI)
        const seg = http.segment ?? inferSegment(key)
        const path = `${httpPrefix}/${seg}`
        out.push({ codenName, path, verb, meta: child.meta })
      }
    } else {
      // Branch child
      const seg = getHttpMeta(child.meta).segment ?? key
      const newHttpPrefix = `${httpPrefix}/${seg}`
      const newNamePrefix = namePrefix.length > 0 ? `${namePrefix}_${key}` : key
      out.push(...walkTree(child, newHttpPrefix, newNamePrefix))
    }
  }

  if (n.fallback !== undefined) {
    const newHttpPrefix = `${httpPrefix}/{${n.fallback.name}}`
    const newNamePrefix = namePrefix.length > 0 ? `${namePrefix}_${n.fallback.name}` : n.fallback.name
    out.push(...walkTree(n.fallback.subtree, newHttpPrefix, newNamePrefix))
  }

  return out
}

// ============================================================================
// toOpenApi — public API
// ============================================================================

/**
 * Project a Node tree to an OpenAPI 3.1 document object.
 *
 * Each leaf node in the tree becomes one path item method entry. The path and
 * HTTP verb are derived by the same logic as the direct tree-walk dispatch in
 * packages/http — so the OpenAPI paths exactly match the live HTTP router.
 * Input/output schemas
 * come from extractToolSchemas (codegen) when a sourceFile or schemas map is
 * supplied; otherwise they degrade to `{ type: "object" }` placeholders.
 *
 * meta.openapi on a leaf carries per-operation OpenAPI overrides: operationId,
 * summary, description, tags, deprecated. Any unrecognised keys pass through.
 *
 * @param n    - The root node to project.
 * @param opts - Options: title, version, sourceFile, schemas.
 */
export async function toOpenApi(n: Node, opts: OpenApiOpts = {}): Promise<OpenApiDoc> {
  const title = opts.title ?? "API"
  const version = opts.version ?? "0.1.0"

  // Resolve schema map: caller-supplied > sourceFile > empty
  let schemas: SchemaMap = opts.schemas ?? {}
  if (Object.keys(schemas).length === 0 && opts.sourceFile !== undefined) {
    const { extractToolSchemas } = await import("@rhi-zone/fractal-codegen")
    schemas = extractToolSchemas(opts.sourceFile)
  }

  const entries = walkTree(n, "", "")

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
