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

import { type Pass, pass, type Handler, type Req } from "./core.ts"

// ---------------------------------------------------------------------------
// Worker request fields (kit-internal shape)
// ---------------------------------------------------------------------------

type WorkerFields = { procedure: string; args?: unknown[] }
type WorkerReq<P> = Req<P> & WorkerFields

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
export function procedure<P, Res>(
  table: Record<string, Handler<P, Res>>,
): Handler<P, Res> {
  return async (req) => {
    const workerReq = req as WorkerReq<P>
    const h = table[workerReq.procedure]
    if (h === undefined) return pass
    return h(req)
  }
}

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
 * dispatch: run a worker call through a fully-discharged handler.
 * Maps Pass → { ok: false, result: null, error: "not found" }.
 *
 * `h` must be `Handler<{}>` — any undischarged params are a compile error.
 */
export async function dispatch<Res>(
  h: Handler<Record<string, never>, Res>,
  call: { procedure: string; params?: Record<string, string>; args?: unknown[] },
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
