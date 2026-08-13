// `Handler` is the single framework type. There is no `Route`, `Segment`,
// `Router`, or `Node` type; a "route", a "router", and a "segment match" are
// all handlers. The trie is the nesting of handlers; the meta tree (on
// `.meta`) mirrors it for projection.
//
//   Handler<T, U, M> = a callable value `(t: T) => Promise<U>` that also
//   carries reflection metadata `.meta: M`. `M` is a plain data descriptor —
//   inert, walkable structure — attached to the handler, not a parallel type
//   hierarchy. Reflection (typed client + OpenAPI) is the only reason `M`
//   exists; it is the sole justified structure.
//
// Composition is function composition. `path`/`methods`/`param`/`choice`/
// `mount`/`validate`/middleware (in http.ts) are functions that take handlers
// and return a handler, not types, and not a fixed required set.
//
// This module is HTTP-free and Bun-free: it knows nothing of Request/Response.

// ============================================================================
// Handler — the single type. Callable + `.meta`.
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
  (t: T): Promise<U>;
  readonly meta: M;
}

/**
 * Attaches `meta` to a plain function, producing a `Handler`. The function is
 * the handler; `meta` is bolted on as a property. This is the only
 * constructor — every combinator ultimately routes through it.
 */
export function handler<T, U, M>(meta: M, fn: (t: T) => U | Promise<U>): Handler<T, U, M> {
  const h = (async (t: T) => fn(t)) as Handler<T, U, M> & { meta: M };
  h.meta = meta;
  return h;
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
  return handler(b.meta, async (input: A) => b(await a(input)));
}
