// spike/worker.ts — Worker / in-process kit
//
// This is the agnosticism proof. The worker kit operates on a completely
// different request shape from HTTP: no path, no method, just a procedure
// name and a params record. The same core Handler<P> algebra applies.
//
// Nothing in this file references method, path, or HTTP verbs.
//
// All combinators return the core Handler<P, Res> type — there is no separate
// WorkerHandler type. Kit combinators internally access worker-specific fields
// (procedure, args) by casting. This keeps the core Handler as the universal
// type across all transports.
//
// ─── Worker capture / field combinator ────────────────────────────────────
// The HTTP kit pins V=string in its capture combinators (param/query/header)
// because text-protocol values arrive as strings. The Worker kit delivers
// ALREADY-TYPED values from IPC/shared memory — a procedure arg may be a
// number, an object, a buffer, anything. There is no string→T parse step.
//
// field<K, V, C, Res>(name, read, child) pins V to any type the transport
// delivers. V is inferred from the child's param requirement at K. A Worker
// call that puts { id: 42 } in its args delivers a number — no typed() needed.
//
// This is Fix 1's core proof: non-text transports deliver typed values
// directly through the params bag WITHOUT any typed()/parse step.

import { type Pass, pass, type Handler, type Req, capture } from "./core.ts"

// ---------------------------------------------------------------------------
// Worker request fields (kit-internal shape)
// ---------------------------------------------------------------------------

type WorkerFields = { procedure: string; args?: unknown[] }
type WorkerReq<P extends Record<string, unknown>> = Req<P> & WorkerFields

// ---------------------------------------------------------------------------
// Worker kit combinators
// ---------------------------------------------------------------------------

/**
 * procedure: dispatch by the `procedure` field on the request.
 * Returns Pass if no match.
 *
 * Unlike the HTTP `path` combinator, this does NOT consume a segment —
 * the full procedure name is matched as-is.
 */
export function procedure<P extends Record<string, unknown>, Res>(
  table: Record<string, Handler<P, Res>>,
): Handler<P, Res> {
  return async (req) => {
    const workerReq = req as WorkerReq<P>
    const h = table[workerReq.procedure]
    if (h === undefined) return pass
    return h(req)
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
 * This is the non-text capture proof: a Worker call { id: 42 } delivers a
 * number and field('id', child<{id:number}>) discharges it without any parse.
 *
 * The `read` function extracts the value from the request. If the value is
 * absent or invalid, returning pass causes this branch to pass through.
 *
 * Uses core's capture() primitive with V free.
 */
export function field<
  K extends string,
  V,
  C extends Record<K, V>,
  Res,
>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res> {
  return capture(name, read, child)
}

// ---------------------------------------------------------------------------
// Worker payload — EAGER (args already in memory)
//
// In a Worker/IPC call the arguments are already in memory — the payload is
// not a lazy stream; it does not need to be pulled. There is no body thunk.
// args?: unknown[] is immediately available on the request object.
//
// This contrasts explicitly with the HTTP kit's lazy body thunk. The delivery
// mode is the KIT's choice, not the core's.
// ---------------------------------------------------------------------------

// Re-export choice from core for convenience
export { choice } from "./core.ts"

// ---------------------------------------------------------------------------
// Worker dispatch entrypoint
// ---------------------------------------------------------------------------

export interface WorkerCallResult<T> {
  ok: boolean
  result: T | null
  error?: string
}

/**
 * Worker call shape. `params` is `Record<string, unknown>` — NOT string-only.
 * The Worker transport delivers pre-typed values: numbers, objects, arrays, etc.
 * This is intentional and is the distinction from HTTP's text-protocol params.
 */
export interface WorkerCall {
  procedure: string
  /** Pre-typed params — the Worker transport delivers these without any parse step. */
  params?: Record<string, unknown>
  args?: unknown[]
}

/**
 * dispatch: run a worker call through a fully-discharged handler.
 * Maps Pass → { ok: false, result: null, error: "not found" }.
 *
 * `h` must be `Handler<{}>` — any undischarged params are a compile error.
 */
export async function dispatch<Res>(
  h: Handler<Record<string, never>, Res>,
  call: WorkerCall,
): Promise<WorkerCallResult<Res>> {
  const req: WorkerReq<Record<string, never>> = {
    procedure: call.procedure,
    params: (call.params ?? {}) as Record<string, never>,
    ...(call.args !== undefined ? { args: call.args } : {}),
  }
  const res = await h(req)
  if (res === pass) return { ok: false, result: null, error: "procedure not found" }
  return { ok: true, result: res as Res }
}

// Re-export core for consumers that only import worker.ts
export type { Handler, Req, Pass } from "./core.ts"
export { pass, leaf, typed, pipe, run } from "./core.ts"
