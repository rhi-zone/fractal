// packages/core/src/index.ts — @rhi-zone/fractal-core
//
// The agnostic Node core. Protocol-free: no HTTP verbs, URL paths,
// procedure names, or transport shape. The only structure required is
// that a request carries a `params` field.
//
// The composition unit is:
//   Node<P,Res,M extends Meta = Meta> = { meta: M; handler: Handler<P,Res> }
//
// The third type parameter M carries the precise meta type of the node,
// enabling typed-client derivation from the tree structure. It defaults to
// the wide `Meta` union so existing Node<P,Res> usages compile unchanged.
//
// `meta` is the reflection descriptor (walkable, serialisable).
// `handler` is the executable ((req) => Promise<Res|Pass>).
//
// Protocol-specific combinators (path, methods, procedure) live in their
// kits. Core does NOT mention string as a constraint on params values.
// V is free; each kit pins it to whatever the transport delivers.

import type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec'

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

const PASS = Symbol("fractal.Pass")
/** Pass = "not me, try the next handler". */
export type Pass = typeof PASS
export const pass: Pass = PASS

// ---------------------------------------------------------------------------
// Core request type
// ---------------------------------------------------------------------------

export type Req<P extends Record<string, unknown> = Record<string, never>> = {
  params: P
} & Record<string, unknown>

// ---------------------------------------------------------------------------
// Handler — the executable half of a Node
// ---------------------------------------------------------------------------

export type Handler<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
> = (req: Req<P>) => Promise<Res | Pass>

// ---------------------------------------------------------------------------
// Meta — the reflection descriptor
// ---------------------------------------------------------------------------

export type LeafMeta   = { kind: "leaf" }
export type ChoiceMeta = { kind: "choice"; children: Meta[] }
export type CaptureMeta = { kind: "capture"; name: string; child: Meta }
export type TypedMeta  = { kind: "typed"; schema: Record<string, unknown>; child: Meta }
export type PipeMeta   = { kind: "pipe"; metas: Meta[]; child: Meta }

// ---------------------------------------------------------------------------
// Standard Schema helpers
// ---------------------------------------------------------------------------

/** Re-export for consumers that import only fractal-core */
export type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec'

/**
 * resolveSchema: extract a JSON-Schema object from a StandardJSONSchemaV1 trait.
 * Returns `{}` (empty object) and logs a warning if the trait is absent or throws.
 * Target is always 'openapi-3.0' for projection use.
 */
export function resolveSchema(
  schema: StandardSchemaV1 | (StandardSchemaV1 & StandardJSONSchemaV1),
  mode: 'input' | 'output' = 'output',
): Record<string, unknown> {
  const ss = (schema as Partial<StandardJSONSchemaV1>)['~standard']
  if (!ss || typeof (ss as Partial<StandardJSONSchemaV1.Props>).jsonSchema === 'undefined') {
    return {}
  }
  const converter = (ss as StandardJSONSchemaV1.Props).jsonSchema
  try {
    return mode === 'input'
      ? converter.input({ target: 'openapi-3.0' })
      : converter.output({ target: 'openapi-3.0' })
  } catch {
    console.warn('[fractal-core] resolveSchema: jsonSchema conversion threw; degrading to {}')
    return {}
  }
}

/**
 * Meta is the reflection descriptor for a Node.
 * Kits extend this union with transport-specific variants (PathMeta,
 * MethodsMeta, ProcedureMeta, …) by re-exporting an extended Meta type.
 * Core only defines the variants it introduces directly.
 */
export type Meta =
  | LeafMeta
  | ChoiceMeta
  | CaptureMeta
  | TypedMeta
  | PipeMeta
  | { kind: string; [key: string]: unknown }   // open: kit-specific variants

// ---------------------------------------------------------------------------
// Node — THE composition unit
//
// NOTE: 'Node' would clash with lib.dom's Node interface. We export it as
// a named type only; consumers that also use lib.dom should import and alias
// (e.g. `import type { Node as FNode } from '@rhi-zone/fractal-core'`).
// ---------------------------------------------------------------------------

export type Node<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
  M extends Meta = Meta,
> = {
  meta: M
  handler: Handler<P, Res>
}

// ---------------------------------------------------------------------------
// NodeMiddleware
// ---------------------------------------------------------------------------

/**
 * NodeMiddleware: a function that wraps a Node to produce a new Node.
 * Can contribute to both the handler and the meta descriptor.
 * M defaults to Meta (wide) so existing middleware compiles without annotation.
 */
export type NodeMiddleware<P extends Record<string, unknown>, Res, M extends Meta = Meta> = (
  n: Node<P, Res, M>,
) => Node<P, Res>

/**
 * pipe: compose NodeMiddlewares left-to-right via reduceRight.
 * pipe(mw1, mw2)(n) = mw1(mw2(n))
 * mw1 is outermost and runs first; mw2 is closer to the base node.
 * The resulting node's meta records the middleware chain.
 */
export function pipe<P extends Record<string, unknown>, Res>(
  ...mws: NodeMiddleware<P, Res>[]
): NodeMiddleware<P, Res> {
  return (n) => mws.reduceRight((acc, mw) => mw(acc), n)
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Tries nodes in order; returns the first non-Pass result.
 * choice() is the general alternation primitive. Its branches are collapsed —
 * literal keys from each branch are NOT preserved in the meta type. This makes
 * choice() opaque to the typed client (just as pred is opaque to OpenAPI).
 * Use `route()` (in fractal-http) for collection+children+param routing that
 * must be traversable by the typed client.
 */
export function choice<P extends Record<string, unknown>, Res>(
  ...ns: Node<P, Res>[]
): Node<P, Res, ChoiceMeta> {
  return {
    meta: { kind: "choice", children: ns.map((n) => n.meta) },
    handler: async (req) => {
      for (const n of ns) {
        const res = await n.handler(req)
        if (res !== pass) return res
      }
      return pass
    },
  }
}

// ---------------------------------------------------------------------------
// Generic capture primitive
//
// capture<K, V, C, Res>(name, read, child) is the core capture algebra.
// V is FREE. Each kit pins V to whatever the transport delivers:
//   - HTTP kit: V = string (text-protocol values)
//   - Worker kit: V = number | object | … (pre-typed values from IPC/memory)
// ---------------------------------------------------------------------------

export function capture<
  K extends string,
  V,
  C extends Record<K, V>,
  Res,
  M extends Meta = Meta,
>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Node<C, Res, M>,
): Node<Omit<C, K>, Res, CaptureMeta> {
  return {
    meta: { kind: "capture", name, child: child.meta },
    handler: async (req) => {
      const value = read(req)
      if (value === pass) return pass
      const enriched = {
        ...req,
        params: { ...(req.params as object), [name]: value } as unknown as C,
      } as Req<C>
      return child.handler(enriched)
    },
  }
}

// ---------------------------------------------------------------------------
// Typed: sync, eager refinement of params values
//
// Accepts either:
//   - a raw parse function: (raw: Record<string, unknown>) => Out
//   - a StandardSchemaV1: schema['~standard'].validate is called; must be SYNC
//     (typed is a sync combinator — it does not await at composition or at
//     request time for the params path). If the schema validate returns a
//     Promise, it is awaited but this is a degraded usage; prefer sync schemas
//     in the params path.
// ---------------------------------------------------------------------------

export function typed<
  Out extends Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(
  schemaOrParse: StandardSchemaV1<Record<string, unknown>, Out> | ((raw: Record<string, unknown>) => Out),
): <M extends Meta>(inner: Node<P & Out, Res, M>) => Node<P, Res, TypedMeta> {
  // Determine whether we have a StandardSchemaV1 or a raw parse fn
  const isStdSchema = (
    typeof schemaOrParse === 'object' &&
    schemaOrParse !== null &&
    '~standard' in schemaOrParse
  )

  // Extract JSON-Schema for meta (best-effort; `{}` if unavailable)
  const jsonSchema: Record<string, unknown> = isStdSchema
    ? resolveSchema(schemaOrParse as StandardSchemaV1, 'output')
    : {}

  const parse = isStdSchema
    ? async (raw: Record<string, unknown>): Promise<Out> => {
        const result = await (schemaOrParse as StandardSchemaV1<Record<string, unknown>, Out>)['~standard'].validate(raw)
        if (result.issues) {
          throw new Error(
            `[fractal-core] typed: validation failed — ${result.issues.map((i) => i.message).join(', ')}`,
          )
        }
        return result.value
      }
    : (raw: Record<string, unknown>) => Promise.resolve((schemaOrParse as (raw: Record<string, unknown>) => Out)(raw))

  return (inner) => ({
    meta: { kind: "typed", schema: jsonSchema, child: inner.meta },
    handler: async (req) => {
      const parsed = await parse(req.params as Record<string, unknown>)
      const enriched: Req<P & Out> = {
        ...req,
        params: { ...(req.params as object), ...parsed } as P & Out,
      }
      return inner.handler(enriched)
    },
  })
}

/**
 * Leaf: wraps a plain async function into a Node.
 * This is the ONLY place application logic lives.
 * meta descriptor: { kind: "leaf" }
 * Returns Node<P, Res, LeafMeta> so the precise meta type is preserved.
 */
export function leaf<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(fn: (req: Req<P>) => Promise<Res>): Node<P, Res, LeafMeta> {
  return { meta: { kind: "leaf" }, handler: fn }
}

/**
 * Run: the entrypoint. Accepts only a fully-discharged Node (P = {}).
 * A Pass from the root handler becomes a "not found" sentinel (null).
 */
export async function run<Res>(
  n: Node<Record<string, never>, Res>,
  req: Req<Record<string, never>>,
): Promise<Res | null> {
  const res = await n.handler(req)
  if (res === pass) return null
  return res as Res
}
