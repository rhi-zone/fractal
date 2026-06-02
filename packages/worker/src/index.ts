// packages/worker/src/index.ts — @rhi-zone/fractal-worker
//
// Worker / in-process kit built on @rhi-zone/fractal-core.
//
// Every combinator produces/consumes Node<P,Res> = { meta, handler }.
//
// Provides:
//   - procedure(table): dispatch by the `procedure` field on the request
//   - field(name, read, child): captures a value from params with free V type
//   - dispatch(node, call): run a worker call through a fully-discharged Node
//
// The worker kit operates on a different request shape from HTTP: no path,
// no method, just a procedure name and a params record. The same core
// Handler<P> algebra applies.
//
// V is FREE in field() — pinned by the child's type requirement, not by this
// combinator. Worker transports deliver already-typed values (number, object, …)
// directly from IPC/shared memory without any string→T parse step.
// This contrasts with the HTTP kit's V=string pinning.

import { type Pass, pass, type Handler, type Req, type Node, capture } from '@rhi-zone/fractal-core'

// ---------------------------------------------------------------------------
// Worker request fields (kit-internal shape)
// ---------------------------------------------------------------------------

type WorkerFields = { procedure: string; args?: unknown[] }
type WorkerReq<P extends Record<string, unknown>> = Req<P> & WorkerFields

// ---------------------------------------------------------------------------
// Worker-specific meta variants
// ---------------------------------------------------------------------------

export type ProcedureMeta = { kind: "procedure"; procedures: Record<string, import('@rhi-zone/fractal-core').Meta> }
export type FieldMeta     = { kind: "field"; name: string; child: import('@rhi-zone/fractal-core').Meta }

// ---------------------------------------------------------------------------
// Worker kit combinators
// ---------------------------------------------------------------------------

/**
 * procedure: dispatch by the `procedure` field on the request.
 * Returns Pass if no match.
 *
 * Unlike the HTTP `path` combinator, this does NOT consume a segment —
 * the full procedure name is matched as-is.
 *
 * meta: { kind: "procedure", procedures: { [name]: child.meta } }
 */
export function procedure<P extends Record<string, unknown>, Res>(
  table: Record<string, Node<P, Res>>,
): Node<P, Res> {
  const procedureMetas: Record<string, import('@rhi-zone/fractal-core').Meta> = {}
  for (const [k, n] of Object.entries(table)) {
    procedureMetas[k] = n.meta
  }
  return {
    meta: { kind: "procedure", procedures: procedureMetas } satisfies ProcedureMeta,
    handler: async (req) => {
      const workerReq = req as WorkerReq<P>
      const n = table[workerReq.procedure]
      if (n === undefined) return pass
      return n.handler(req)
    },
  }
}

/**
 * field: captures a value from the Worker call's params bag, injecting it
 * as req.params[name] with the type V the child expects.
 *
 * V is FREE — pinned by the child's type requirement, not by this combinator.
 * The Worker transport delivers pre-typed values (number, object, …) directly
 * from IPC/shared memory. There is NO string→T parse step; no typed() needed.
 *
 * Uses core's capture() primitive with V free.
 *
 * meta: { kind: "field", name, child: child.meta }
 */
export function field<
  K extends string,
  V,
  C extends Record<K, V>,
  Res,
>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Node<C, Res>,
): Node<Omit<C, K>, Res> {
  const captured = capture(name, read, child)
  return {
    ...captured,
    meta: { kind: "field", name, child: child.meta } satisfies FieldMeta,
  }
}

// ---------------------------------------------------------------------------
// Worker dispatch entrypoint
// ---------------------------------------------------------------------------

export interface WorkerCallResult<T> {
  ok: boolean
  result: T | null
  error?: string
}

/**
 * Worker call shape. `params` is Record<string, unknown> — NOT string-only.
 * The Worker transport delivers pre-typed values: numbers, objects, arrays, etc.
 */
export interface WorkerCall {
  procedure: string
  /** Pre-typed params — the Worker transport delivers these without any parse step. */
  params?: Record<string, unknown>
  args?: unknown[]
}

/**
 * dispatch: run a worker call through a fully-discharged Node.
 * Maps Pass → { ok: false, result: null, error: "procedure not found" }.
 *
 * `n` must be Node<{}> — any undischarged params are a compile error.
 */
export async function dispatch<Res>(
  n: Node<Record<string, never>, Res>,
  call: WorkerCall,
): Promise<WorkerCallResult<Res>> {
  const req: WorkerReq<Record<string, never>> = {
    procedure: call.procedure,
    params: (call.params ?? {}) as Record<string, never>,
    ...(call.args !== undefined ? { args: call.args } : {}),
  }
  const res = await n.handler(req)
  if (res === pass) return { ok: false, result: null, error: 'procedure not found' }
  return { ok: true, result: res as Res }
}

// Re-export core for consumers that only import fractal-worker
export type { Handler, Req, Pass, Node, Meta, NodeMiddleware } from '@rhi-zone/fractal-core'
export { pass, leaf, typed, pipe, run, choice } from '@rhi-zone/fractal-core'
