// @rhi-zone/fractal-standard-schema
// OpenAPI / JSON-Schema / doc projection from Standard-Schema-annotated trees.
//
// Two-phase walk of the reflectable core IR:
//   Phase A (routing) — recurse `branch` only, accumulating path segments from
//     child keys (mirrors the dispatcher: only `branch` consumes a path segment).
//     Each non-branch child subtree is one endpoint at POST /<segments…>.
//   Phase B (introspection) — descend `annotated`/`seq` of an endpoint subtree,
//     collecting the input schema (first role:'input' in left-first order, since
//     only the head consumes the raw body), the output schema (outermost
//     role:'output', since `returns` wraps the endpoint), capability annotations,
//     an optional `kind:'http'` method override, and the streaming marker.
//
// Zero runtime deps: the OpenAPI types below are hand-written (no `openapi-types`).

import type { AnyNode, SchemaAnnotationValue } from '@rhi-zone/fractal-core'

// ---------------------------------------------------------------------------
// Minimal OpenAPI 3.0 types (hand-written; zero runtime).
// ---------------------------------------------------------------------------

export interface OpenApiInfo {
  readonly title: string
  readonly version: string
  readonly description?: string
}

export interface MediaType {
  readonly schema?: object
}

export interface RequestBody {
  readonly required?: boolean
  readonly content: Readonly<Record<string, MediaType>>
}

export interface ResponseObject {
  readonly description: string
  readonly content?: Readonly<Record<string, MediaType>>
}

export type Responses = Readonly<Record<string, ResponseObject>>

export interface Operation {
  readonly operationId?: string
  readonly requestBody?: RequestBody
  readonly responses: Responses
  readonly security?: ReadonlyArray<Readonly<Record<string, readonly string[]>>>
}

export type PathItem = Readonly<Partial<Record<string, Operation>>>

export interface SecurityScheme {
  readonly type: string
  readonly scheme?: string
  readonly bearerFormat?: string
}

export interface Components {
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>
}

export interface OpenApiDocument {
  readonly openapi: string
  readonly info: OpenApiInfo
  readonly paths: Readonly<Record<string, PathItem>>
  readonly components?: Components
}

// ---------------------------------------------------------------------------
// Standard-Schema JSON-Schema trait (draft 1.1). The installed
// @standard-schema/spec may not yet declare it, so we model it structurally and
// read it defensively rather than depend on an exported type.
// ---------------------------------------------------------------------------

type SchemaRole = 'input' | 'output'

interface StandardJsonSchemaTrait {
  readonly '~standard'?: {
    readonly jsonSchema?: Partial<
      Record<SchemaRole, (opts: { target: string }) => object>
    >
  }
}

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

/**
 * Emit a warning without depending on the DOM lib. `console` is not in this
 * package's `lib` (target ES2022, no DOM); reach it through `globalThis` with a
 * structural type and a runtime guard so the projection degrades silently if the
 * host has no console.
 */
const warn = (message: string): void => {
  const c = (globalThis as { console?: { warn?: (msg: string) => void } }).console
  c?.warn?.(`[fractal-standard-schema] ${message}`)
}

const isPlainJsonSchema = (value: object): boolean =>
  Object.prototype.hasOwnProperty.call(value, 'type') ||
  Object.prototype.hasOwnProperty.call(value, '$ref') ||
  Object.prototype.hasOwnProperty.call(value, 'properties') ||
  Object.prototype.hasOwnProperty.call(value, 'anyOf')

/**
 * Resolve a `SchemaAnnotationValue.schema` to a JSON-Schema object for `role`.
 * 1. Standard-Schema jsonSchema trait (`~standard.jsonSchema[role]`), if a fn.
 *    Called with the spec-required `{ target }`; may throw per spec → fall through.
 * 2. A plain JSON-Schema-shaped object, returned verbatim (e.g. TypeBox).
 * 3. Otherwise `{}` (plus a warning), keeping the document valid.
 */
const resolveSchema = (
  value: SchemaAnnotationValue['schema'],
  role: SchemaRole,
  warnings: string[],
): object => {
  if (value && typeof value === 'object') {
    const trait = (value as StandardJsonSchemaTrait)['~standard']
    const fn = trait?.jsonSchema?.[role]
    if (typeof fn === 'function') {
      try {
        return fn({ target: 'openapi-3.0' })
      } catch {
        // spec permits throwing; fall through to other strategies.
      }
    }
    if (isPlainJsonSchema(value)) return value
  }
  warnings.push(`could not resolve ${role} schema; emitting empty schema {}`)
  return {}
}

// ---------------------------------------------------------------------------
// Endpoint introspection (Phase B)
// ---------------------------------------------------------------------------

interface HttpAnnotationValue {
  readonly method?: string
}

interface EnforceLike {
  readonly enforce?: unknown
}

interface Endpoint {
  readonly inputSchema?: SchemaAnnotationValue['schema']
  readonly outputSchema?: SchemaAnnotationValue['schema']
  readonly method: string
  readonly streaming: boolean
  readonly securityKinds: readonly string[]
}

/** A leaf carries `mode: 'stream'` iff it is a streaming leaf (absent ⇒ unary). */
const isStreamLeaf = (n: AnyNode): boolean =>
  n.tag === 'leaf' && (n as { mode?: string }).mode === 'stream'

const introspect = (node: AnyNode): Endpoint => {
  let inputSchema: SchemaAnnotationValue['schema'] | undefined
  let outputSchema: SchemaAnnotationValue['schema'] | undefined
  let method = 'post'
  let streaming = false
  const securityKinds: string[] = []

  const visit = (n: AnyNode): void => {
    switch (n.tag) {
      case 'annotated': {
        const { kind, value } = n.annotation
        if (kind === 'schema' && value && typeof value === 'object') {
          const sv = value as SchemaAnnotationValue
          if (sv.role === 'input' && inputSchema === undefined) {
            // First role:'input' in left-first order wins (head consumes body).
            inputSchema = sv.schema
          } else if (sv.role === 'output' && outputSchema === undefined) {
            // Outermost role:'output' wins (`returns` wraps the endpoint).
            outputSchema = sv.schema
          }
        } else if (kind === 'http' && value && typeof value === 'object') {
          const m = (value as HttpAnnotationValue).method
          if (typeof m === 'string') method = m.toLowerCase()
        } else if (
          kind === 'auth' ||
          (value !== null &&
            typeof value === 'object' &&
            typeof (value as EnforceLike).enforce === 'function')
        ) {
          // A capability annotation: a known security kind, or any annotation
          // whose value carries an `enforce` gate.
          securityKinds.push(kind)
        }
        visit(n.child)
        return
      }
      case 'seq':
        visit(n.left)
        visit(n.right)
        return
      case 'leaf':
        if (isStreamLeaf(n)) streaming = true
        return
      case 'branch':
        // A nested branch under an endpoint is not part of this endpoint's I/O.
        return
    }
  }
  visit(node)

  return {
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    method,
    streaming,
    securityKinds,
  }
}

// ---------------------------------------------------------------------------
// Routing descent (Phase A)
// ---------------------------------------------------------------------------

interface RoutedEndpoint {
  readonly segments: readonly string[]
  readonly node: AnyNode
}

const collectEndpoints = (
  node: AnyNode,
  segments: readonly string[],
  out: RoutedEndpoint[],
): void => {
  if (node.tag === 'branch') {
    for (const [key, child] of Object.entries(node.children)) {
      collectEndpoints(child as AnyNode, [...segments, key], out)
    }
    return
  }
  out.push({ segments, node })
}

// ---------------------------------------------------------------------------
// Security schemes
// ---------------------------------------------------------------------------

const securitySchemeFor = (kind: string): SecurityScheme | undefined =>
  kind === 'auth' ? { type: 'http', scheme: 'bearer' } : undefined

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Project a fractal tree into an OpenAPI 3.0 document. */
export const toOpenApi = (tree: AnyNode, info: OpenApiInfo): OpenApiDocument => {
  const warnings: string[] = []
  const routed: RoutedEndpoint[] = []
  collectEndpoints(tree, [], routed)

  const paths: Record<string, Record<string, Operation>> = {}
  const securitySchemes: Record<string, SecurityScheme> = {}

  for (const { segments, node } of routed) {
    const ep = introspect(node)
    const path = `/${segments.join('/')}`

    const responseSchema =
      ep.outputSchema !== undefined
        ? resolveSchema(ep.outputSchema, 'output', warnings)
        : undefined

    const successContent: Record<string, MediaType> = ep.streaming
      ? {
          'application/x-ndjson': {
            ...(responseSchema !== undefined ? { schema: responseSchema } : {}),
          },
        }
      : {
          'application/json': {
            ...(responseSchema !== undefined ? { schema: responseSchema } : {}),
          },
        }

    const responses: Responses = {
      '200': {
        description: ep.streaming ? 'one JSON instance per event/line' : 'OK',
        content: successContent,
      },
    }

    const security: Array<Record<string, readonly string[]>> = []
    for (const kind of ep.securityKinds) {
      const scheme = securitySchemeFor(kind)
      if (scheme === undefined) {
        warnings.push(`unknown security kind '${kind}'; skipping`)
        continue
      }
      securitySchemes[kind] = scheme
      security.push({ [kind]: [] })
    }

    const requestBody: RequestBody | undefined =
      ep.inputSchema !== undefined
        ? {
            required: true,
            content: {
              'application/json': {
                schema: resolveSchema(ep.inputSchema, 'input', warnings),
              },
            },
          }
        : undefined

    const operation: Operation = {
      responses,
      ...(requestBody !== undefined ? { requestBody } : {}),
      ...(security.length > 0 ? { security } : {}),
    }

    const pathItem = (paths[path] ??= {})
    pathItem[ep.method] = operation
  }

  for (const w of warnings) warn(w)

  return {
    openapi: '3.0.3',
    info,
    paths,
    ...(Object.keys(securitySchemes).length > 0
      ? { components: { securitySchemes } }
      : {}),
  }
}

/**
 * Resolve the relevant schema (default role `input`) within a node subtree to a
 * JSON-Schema object, or `undefined` if no matching schema annotation exists.
 */
export const toJsonSchema = (
  node: AnyNode,
  opts?: { role?: SchemaRole },
): object | undefined => {
  const role = opts?.role ?? 'input'
  const ep = introspect(node)
  const value = role === 'input' ? ep.inputSchema : ep.outputSchema
  if (value === undefined) return undefined
  const warnings: string[] = []
  const out = resolveSchema(value, role, warnings)
  for (const w of warnings) warn(w)
  return out
}
