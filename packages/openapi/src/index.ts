// packages/openapi/src/index.ts — @rhi-zone/fractal-openapi
//
// OpenAPI 3.0 / JSON-Schema projection for fractal.
//
// Walks the `.meta` tree of a Node to produce an OpenAPI 3.0 document or a
// JSON-Schema fragment. This is the proof-of-concept from spike/node-reflect.ts
// generalised and published as a package.
//
// Exports:
//   toOpenApi(node, info): OpenApiDocument
//   toJsonSchema(node, opts?): JsonSchemaFragment
//
// Meta kinds handled:
//   leaf, choice, path, methods, param, query, header, body, validate, typed,
//   capture, pipe, route  →  honoured
//   procedure, field  →  skipped (worker-kit; warn + skip)
//   unknown kind     →  warn + skip
//
// route: both-and combinator (fractal-http). Emits:
//   - collection ops at the current prefix (path-exhausted case)
//   - exact-child ops at prefix/seg for each child
//   - param ops at prefix/{name} for the param fallthrough child
//
// Standard Schema JSON-Schema trait: schemas on TypedMeta/ValidateMeta carry
// the JSON-Schema extracted by resolveSchema() (packages/core). If absent the
// field is `{}` (empty schema).

import type { Meta } from '@rhi-zone/fractal-core'

// ---------------------------------------------------------------------------
// Minimal hand-written OpenAPI 3.0 types — zero external dependency
// ---------------------------------------------------------------------------

export interface OpenApiInfo {
  title: string
  version: string
  description?: string
}

export interface OpenApiSchema {
  [key: string]: unknown
}

export interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  schema: OpenApiSchema
}

export interface OpenApiMediaTypeObject {
  schema: OpenApiSchema
}

export interface OpenApiRequestBody {
  required: boolean
  content: {
    'application/json': OpenApiMediaTypeObject
  }
}

export interface OpenApiOperation {
  parameters: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  security?: Array<Record<string, string[]>>
  responses: Record<string, { description: string }>
}

export type SecurityMetaScheme = Record<string, string[]>

/**
 * SecurityMeta: emitted by `withSecurity` NodeMiddleware.
 * The `schemes` array is appended to the OpenAPI `security` field on the operation.
 */
export type SecurityMeta = { kind: "security"; schemes: SecurityMetaScheme[]; child: import('@rhi-zone/fractal-core').Meta }

export type OpenApiPathItem = {
  [method: string]: OpenApiOperation
}

export interface OpenApiDocument {
  openapi: '3.0.3'
  info: OpenApiInfo
  paths: Record<string, OpenApiPathItem>
}

export interface JsonSchemaFragment {
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Walker context
// ---------------------------------------------------------------------------

interface WalkCtx {
  prefix: string
  method?: string
  params: OpenApiParameter[]
  security: Array<Record<string, string[]>>
  requestBody?: OpenApiRequestBody
}

function emptyCtx(): WalkCtx {
  return { prefix: '', params: [], security: [] }
}

type OpenApiPaths = Record<string, OpenApiPathItem>

function mergePaths(dst: OpenApiPaths, src: OpenApiPaths): void {
  for (const [p, verbs] of Object.entries(src)) {
    dst[p] = { ...(dst[p] ?? {}), ...verbs }
  }
}

// ---------------------------------------------------------------------------
// walk: recursive meta → OpenAPI paths
//
// The Meta union includes an open `{ kind: string; [key: string]: unknown }`
// catch-all variant whose fields are typed `unknown`. We cast `meta` to a
// plain record for field access — this is safe because each case is
// guarded by the `kind` discriminant.
// ---------------------------------------------------------------------------

function asR(meta: Meta): Record<string, unknown> {
  return meta as unknown as Record<string, unknown>
}

function childOf(meta: Meta): Meta {
  return (asR(meta)['child'] as Meta)
}

/**
 * metaOf: extract a Meta from either a raw Meta object OR a Node object (which
 * has a `.meta` field). Required because the tightened path/methods/route
 * combinators store full Node objects in their table fields (children, verbs,
 * param.child) to enable typed-client derivation, while the walker only needs
 * the meta.
 */
function metaOf(value: unknown): Meta {
  if (
    typeof value === 'object' &&
    value !== null &&
    'meta' in value &&
    typeof (value as Record<string, unknown>)['meta'] === 'object'
  ) {
    return (value as Record<string, unknown>)['meta'] as Meta
  }
  return value as Meta
}

function walk(meta: Meta, ctx: WalkCtx): OpenApiPaths {
  const m = asR(meta)
  switch (meta.kind) {
    case 'leaf': {
      if (!ctx.method) return {}
      const key = ctx.prefix || '/'
      const op: OpenApiOperation = {
        parameters: [...ctx.params],
        responses: { '200': { description: 'OK' } },
        ...(ctx.requestBody ? { requestBody: ctx.requestBody } : {}),
        ...(ctx.security.length > 0 ? { security: ctx.security } : {}),
      }
      return { [key]: { [ctx.method]: op } }
    }

    case 'choice': {
      const merged: OpenApiPaths = {}
      for (const child of m['children'] as unknown[]) {
        mergePaths(merged, walk(metaOf(child), ctx))
      }
      return merged
    }

    case 'path': {
      const merged: OpenApiPaths = {}
      for (const [seg, child] of Object.entries(m['children'] as Record<string, unknown>)) {
        mergePaths(merged, walk(metaOf(child), { ...ctx, prefix: `${ctx.prefix}/${seg}` }))
      }
      return merged
    }

    case 'methods': {
      const merged: OpenApiPaths = {}
      for (const [verb, child] of Object.entries(m['verbs'] as Record<string, unknown>)) {
        mergePaths(merged, walk(metaOf(child), { ...ctx, method: verb.toLowerCase() }))
      }
      return merged
    }

    case 'param': {
      const name = m['name'] as string
      const newParam: OpenApiParameter = {
        name,
        in: 'path',
        required: true,
        schema: (m['schema'] as OpenApiSchema | undefined) ?? { type: 'string' },
      }
      return walk(childOf(meta), {
        ...ctx,
        prefix: `${ctx.prefix}/{${name}}`,
        params: [...ctx.params, newParam],
      })
    }

    case 'query': {
      const newParam: OpenApiParameter = {
        name: m['name'] as string,
        in: 'query',
        required: false,
        schema: (m['schema'] as OpenApiSchema | undefined) ?? { type: 'string' },
      }
      return walk(childOf(meta), {
        ...ctx,
        params: [...ctx.params, newParam],
      })
    }

    case 'header': {
      const newParam: OpenApiParameter = {
        name: m['name'] as string,
        in: 'header',
        required: false,
        schema: (m['schema'] as OpenApiSchema | undefined) ?? { type: 'string' },
      }
      return walk(childOf(meta), {
        ...ctx,
        params: [...ctx.params, newParam],
      })
    }

    case 'body': {
      // child may be a ValidateMeta or leaf
      const childMeta = childOf(meta)
      if (childMeta.kind === 'validate') {
        const cm = asR(childMeta)
        const schema = (cm['schema'] as OpenApiSchema | undefined) ?? {}
        const requestBody: OpenApiRequestBody = {
          required: true,
          content: { 'application/json': { schema } },
        }
        // validate's own child is a leaf (or further subtree)
        return walk(childOf(childMeta), { ...ctx, requestBody })
      }
      // no validate — body with raw handler; walk child as-is
      return walk(childMeta, ctx)
    }

    case 'validate': {
      // validate as a direct child (should come via body, but handle directly too)
      const schema = (m['schema'] as OpenApiSchema | undefined) ?? {}
      const requestBody: OpenApiRequestBody = {
        required: true,
        content: { 'application/json': { schema } },
      }
      return walk(childOf(meta), { ...ctx, requestBody })
    }

    case 'typed': {
      // typed carries a JSON-Schema; propagate as requestBody to sub-tree
      const schema = (m['schema'] as OpenApiSchema | undefined) ?? {}
      const sub = walk(childOf(meta), ctx)
      if (Object.keys(schema).length > 0) {
        const requestBody: OpenApiRequestBody = {
          required: true,
          content: { 'application/json': { schema } },
        }
        for (const verbs of Object.values(sub)) {
          for (const op of Object.values(verbs)) {
            if (!op.requestBody) {
              op.requestBody = requestBody
            }
          }
        }
      }
      return sub
    }

    case 'capture': {
      // generic capture — no path segment contribution; walk child
      return walk(childOf(meta), ctx)
    }

    case 'pipe': {
      // pipe: walk the wrapped child
      return walk(childOf(meta), ctx)
    }

    case 'security': {
      // security middleware: add schemes to ctx.security, walk child
      const schemes = (m['schemes'] as SecurityMetaScheme[] | undefined) ?? []
      return walk(childOf(meta), {
        ...ctx,
        security: [...ctx.security, ...schemes],
      })
    }

    case 'route': {
      // both-and combinator (fractal-http route()).
      // Emits:
      //   - collection ops at the current prefix (path-exhausted case)
      //   - exact-child ops at prefix/seg for each child
      //   - param ops at prefix/{name} for the param fallthrough child
      const merged: OpenApiPaths = {}

      // Collection: walk at current prefix (path exhausted case)
      const collection = m['collection'] as { meta: Meta } | undefined
      if (collection !== undefined) {
        mergePaths(merged, walk(collection.meta, ctx))
      }

      // Exact children: walk each at prefix/seg
      const routeChildren = (m['children'] as Record<string, { meta: Meta }> | undefined) ?? {}
      for (const [seg, child] of Object.entries(routeChildren)) {
        mergePaths(merged, walk(child.meta, { ...ctx, prefix: `${ctx.prefix}/${seg}` }))
      }

      // Param fallthrough: walk at prefix/{name} with the param added to ctx
      const paramSpec = m['param'] as { name: string; child: { meta: Meta } } | undefined
      if (paramSpec !== undefined) {
        const newParam: OpenApiParameter = {
          name: paramSpec.name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }
        mergePaths(merged, walk(paramSpec.child.meta, {
          ...ctx,
          prefix: `${ctx.prefix}/{${paramSpec.name}}`,
          params: [...ctx.params, newParam],
        }))
      }

      return merged
    }

    case 'procedure':
    case 'field': {
      console.warn(
        `[fractal-openapi] walk: meta kind "${meta.kind}" is a worker-kit descriptor — skipping (not representable in OpenAPI)`,
      )
      return {}
    }

    default: {
      console.warn(
        `[fractal-openapi] walk: unknown meta kind "${meta.kind as string}" — skipping`,
      )
      return {}
    }
  }
}

// ---------------------------------------------------------------------------
// toOpenApi
// ---------------------------------------------------------------------------

/**
 * toOpenApi: walk a Node's `.meta` tree and produce an OpenAPI 3.0 document.
 *
 * @param node  Any fractal Node (the `.meta` field is all that is read)
 * @param info  OpenAPI info object (title, version, optional description)
 */
export function toOpenApi(
  node: { meta: Meta },
  info: OpenApiInfo,
): OpenApiDocument {
  const paths = walk(node.meta, emptyCtx())
  return {
    openapi: '3.0.3',
    info,
    paths,
  }
}

// ---------------------------------------------------------------------------
// toJsonSchema
// ---------------------------------------------------------------------------

export interface ToJsonSchemaOptions {
  /** Only include paths matching this prefix (default: all) */
  prefix?: string
}

/**
 * toJsonSchema: walk a Node's `.meta` tree and produce a minimal JSON-Schema
 * fragment describing the paths as an object with path keys.
 *
 * Primarily useful for extracting request body schemas for individual routes.
 */
export function toJsonSchema(
  node: { meta: Meta },
  _opts?: ToJsonSchemaOptions,
): JsonSchemaFragment {
  const paths = walk(node.meta, emptyCtx())
  const properties: Record<string, unknown> = {}
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const opSchemas: Record<string, unknown> = {}
    for (const [method, op] of Object.entries(pathItem)) {
      opSchemas[method] = {
        ...(op.requestBody ? { requestBody: op.requestBody.content['application/json'].schema } : {}),
        parameters: op.parameters,
      }
    }
    properties[pathKey] = opSchemas
  }
  return { type: 'object', properties }
}
