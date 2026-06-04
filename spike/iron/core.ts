// spike/iron/core.ts — THE IRON CONSTRAINT.
//
// The ONLY framework type is `Handler`. There is no `Route`, no `Segment`, no
// `Router`, no `Node` type. A "route", a "router", a "segment match" are all
// just handlers. The trie is the nesting of handlers; the meta tree (on
// `.meta`) mirrors it for projection.
//
//   Handler<T, U, M> = a callable value `(t: T) => Promise<U>` that ALSO carries
//   reflection metadata `.meta: M`. `M` is a plain DATA descriptor — inert,
//   walkable structure — attached to the handler, NOT a parallel type hierarchy.
//   `M` exists ONLY because reflection (typed client + OpenAPI) needs walkable
//   structure; it is the sole justified structure.
//
// Composition is function composition. `path`/`methods`/`param`/`choice`/
// `mount`/`validate`/middleware (in http.ts) are FUNCTIONS that take handlers
// and return a handler — not types, not a fixed required set.
//
// This module is HTTP-free and Bun-free. It knows nothing of Request/Response.

// ============================================================================
// Handler — the ONE type. Callable + `.meta`.
// ============================================================================

/**
 * The single framework type. A handler is a callable `(t: T) => Promise<U>`
 * that carries inert reflection data `.meta: M`.
 *
 * `T`/`U` are the runtime arrow (what the handler computes). `M` is a plain
 * data descriptor of the handler's structure, used by projections (`client`,
 * `toOpenApi`) — it is data attached to the function, never a separate type
 * hierarchy. A handler with no reflection need carries `M = undefined`.
 */
export interface Handler<in out T, out U, out M = undefined> {
  (t: T): Promise<U>
  readonly meta: M
}

/**
 * Attach `meta` to a plain function, producing a `Handler`. The function IS the
 * handler; `meta` is bolted on as a property. This is the only constructor —
 * every combinator ultimately routes through it.
 */
export function handler<T, U, M>(meta: M, fn: (t: T) => U | Promise<U>): Handler<T, U, M> {
  const h = (async (t: T) => fn(t)) as Handler<T, U, M> & { meta: M }
  h.meta = meta
  return h
}

/**
 * Function composition: run `a`, feed its result to `b`. The composed handler
 * carries `b`'s meta by default (the outer-facing structure). Composition is
 * just functions — no combinator object.
 */
export function compose<A, B, C, MB>(
  a: Handler<A, B, unknown>,
  b: Handler<B, C, MB>,
): Handler<A, C, MB> {
  return handler(b.meta, async (input: A) => b(await a(input)))
}
