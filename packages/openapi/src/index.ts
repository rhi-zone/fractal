// packages/openapi/src/index.ts — @rhi-zone/fractal-openapi
//
// OpenAPI 3.1 projection for the function-core tree.
//
// Walks a Node tree once, computing for each leaf node (node with handler):
//   - the codegen-style underscore name (for extractToolSchemas lookup)
//   - the HTTP path + verb (same logic as buildRoutes in packages/http)
//   - the effective tags (for verb derivation and documentation)
//
// In the new node model, leaf nodes (nodes with `handler`) live in `children`
// alongside branch nodes. A leaf child keyed `k` behaves exactly as an op
// keyed `k` did: its key contributes to path/name, its meta drives verb.
//
// CORRELATION APPROACH (A — self-contained tree walk):
//   Rather than using buildRoutes and correlating by function identity,
//   we walk the tree ourselves computing name+path+verb+schema together.
//   This keeps openapi self-contained, avoids touching http/project.ts
//   (which has passing tests), and mirrors the pattern already used by
//   toTools in packages/mcp. The codegen name (underscore-joined tree
//   position) is computed alongside the HTTP path so schema lookup is
//   exact. The path/verb derivation copies the same logic as buildRoutes
//   (inferSegment, verbFromTags) to guarantee paths match exactly.
//
// See:
//   packages/http/src/project.ts — buildRoutes, verbFromTags, inferSegment
//   packages/codegen/src/tree.ts — extractToolSchemas, SchemaMap
//   packages/core/src/node.ts    — Node, Handler, ParamNode
//   packages/core/src/tags.ts    — effectiveTags, resolveTags

import { isParamNode, isLeaf } from "@rhi-zone/fractal-core/node"
import { effectiveTags, resolveTags } from "@rhi-zone/fractal-core/tags"
import type { Tags } from "@rhi-zone/fractal-core/tags"
import type { Meta, Node } from "@rhi-zone/fractal-core/node"
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
// Internal: verb derivation (mirrors packages/http/src/project.ts exactly)
// ============================================================================

function verbFromTags(meta: Meta): string {
  const rawHttp = meta.http
  if (typeof rawHttp === "object" && rawHttp !== null) {
    const httpVerb = (rawHttp as Record<string, unknown>).verb
    if (typeof httpVerb === "string") return httpVerb.toUpperCase()
  }
  const tags = resolveTags((meta.tags ?? {}) as Tags)
  if (tags.readOnly === true) return "GET"
  if (tags.idempotent === true && tags.destructive === true) return "DELETE"
  if (tags.idempotent === true) return "PUT"
  return "POST"
}

// ============================================================================
// Internal: segment inference (mirrors packages/http/src/project.ts exactly)
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
// Internal: safe http meta extraction (mirrors http/project.ts getHttpMeta)
// ============================================================================

type HttpMeta = {
  readonly verb?: string
  readonly segment?: string
  readonly legacyPath?: string
  readonly dispatch?: "method"
}

function getHttpMeta(meta: Meta): HttpMeta {
  const h = meta.http
  if (typeof h !== "object" || h === null) return {}
  const r = h as Record<string, unknown>
  const out: { verb?: string; segment?: string; legacyPath?: string; dispatch?: "method" } = {}
  if (typeof r.verb === "string") out.verb = r.verb
  if (typeof r.segment === "string") out.segment = r.segment
  if (typeof r.legacyPath === "string") out.legacyPath = r.legacyPath
  if (r.dispatch === "method") out.dispatch = "method"
  return out
}

// ============================================================================
// Internal: safe openapi meta extraction
// ============================================================================

type OpenApiMeta = {
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
  tagPath: Array<{ meta?: { tags?: Tags } }>,
): RouteEntry[] {
  const out: RouteEntry[] = []
  const nodePath = [...tagPath, n]

  // Attribute-dispatch: if this node has dispatch:"method", its leaf children
  // share the node's own HTTP path rather than getting a per-child segment.
  const thisHttp = getHttpMeta(n.meta)
  const methodDispatch = thisHttp.dispatch === "method"

  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isParamNode(child)) {
      const newHttpPrefix = `${httpPrefix}/{${child.name}}`
      const newNamePrefix = namePrefix.length > 0 ? `${namePrefix}_${child.name}` : child.name
      out.push(...walkTree(child.subtree, newHttpPrefix, newNamePrefix, nodePath))
    } else if (isLeaf(child)) {
      // Leaf node: build a route entry for it
      const leafPath = [...nodePath, child]
      const effective = effectiveTags(leafPath)
      const verbMeta: Meta = { ...child.meta, tags: effective }
      const verb = verbFromTags(verbMeta)
      const http = getHttpMeta(child.meta)

      const codenName = namePrefix.length > 0 ? `${namePrefix}_${key}` : key

      if (http.legacyPath !== undefined) {
        out.push({ codenName, path: http.legacyPath, verb, meta: child.meta })
      } else if (methodDispatch) {
        // Method-dispatch: leaf resolves to the parent's own path
        const path = httpPrefix === "" ? "/" : httpPrefix
        out.push({ codenName, path, verb, meta: child.meta })
      } else {
        const seg = http.segment ?? inferSegment(key)
        const path = `${httpPrefix}/${seg}`
        out.push({ codenName, path, verb, meta: child.meta })
      }
    } else {
      // Branch child
      const seg = getHttpMeta(child.meta).segment ?? key
      const newHttpPrefix = `${httpPrefix}/${seg}`
      const newNamePrefix = namePrefix.length > 0 ? `${namePrefix}_${key}` : key
      out.push(...walkTree(child, newHttpPrefix, newNamePrefix, nodePath))
    }
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
 * HTTP verb are derived by the same logic as buildRoutes in packages/http — so
 * the OpenAPI paths exactly match the live HTTP router. Input/output schemas
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

  const entries = walkTree(n, "", "", [])

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
