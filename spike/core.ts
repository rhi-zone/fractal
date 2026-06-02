// spike/core.ts — agnostic Handler core
//
// The core is deliberately protocol-free. It knows nothing about HTTP verbs,
// URL paths, procedure names, or any transport shape. The only structure it
// requires is that a request carries a `params` field — the slot into which
// capture combinators inject values.
//
// Protocol-specific combinators (path, methods, procedure) live in their kits.
// The capture combinators in each kit use the same Omit<C,K> discharge algebra
// defined here, but each kit pins the value type V to whatever the transport
// delivers: HTTP kits pin V=string (URL segments, query params, headers are
// always text); Worker/IPC kits pin V to pre-typed values (number, object, …).
//
// Core does NOT mention string as a constraint on params values. V is free.

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

// The PASS sentinel uses a Symbol so it is a real runtime value.
// The `declare const` trick used in routing.ts (type-only verification) cannot
// run — Symbol gives us both the unique type and the real value.
const PASS = Symbol("fractal.Pass")
/** Pass = "not me, try the next handler". */
export type Pass = typeof PASS
export const pass: Pass = PASS

// ---------------------------------------------------------------------------
// Core request type
//
// The minimum the core needs: a `params` record. Kits extend this with their
// own fields (path/method for HTTP; procedure for Worker) and pass those richer
// shapes to handlers. The `& Record<string, unknown>` allows kit-specific fields
// to flow through without each leaf needing to declare them.
//
// NOTE: params is Record<string, unknown> — NOT Record<string, string>.
// The value type is the transport's choice. HTTP kits deliver strings; Worker
// kits may deliver numbers, objects, or any pre-typed value. Core is agnostic.
// ---------------------------------------------------------------------------

export type Req<P extends Record<string, unknown> = Record<string, never>> = {
  params: P
} & Record<string, unknown>

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type Handler<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
> = (req: Req<P>) => Promise<Res | Pass>

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type Middleware<P extends Record<string, unknown>, Res> = (
  h: Handler<P, Res>,
) => Handler<P, Res>

/**
 * pipe: compose middleware left-to-right.
 * pipe(mw1, mw2)(h) = mw2(mw1(h))
 * Applies mw1 first, then mw2 outermost.
 */
export function pipe<P extends Record<string, unknown>, Res>(
  ...mws: Middleware<P, Res>[]
): Middleware<P, Res> {
  return (h) => mws.reduceRight((acc, mw) => mw(acc), h)
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Tries handlers in order; returns the first non-Pass result. */
export function choice<P extends Record<string, unknown>, Res>(
  ...hs: Handler<P, Res>[]
): Handler<P, Res> {
  return async (req) => {
    for (const h of hs) {
      const res = await h(req)
      if (res !== pass) return res
    }
    return pass
  }
}

// ---------------------------------------------------------------------------
// Generic capture primitive
//
// capture<K, V, C, Res>(name, read, child) is the core capture algebra.
// It reads a value of type V from the request using `read`, and — if the read
// succeeds — injects it as params[name] and calls child with the enriched req.
// If `read` returns the PASS sentinel, the capture passes through.
//
// V is FREE. Each kit pins V to whatever the transport delivers:
//   - HTTP kit: V = string (text-protocol values)
//   - Worker kit: V = number | object | … (pre-typed values from IPC/memory)
//
// C is the child's full param requirement (must include K:V).
// Returns Handler<Omit<C,K>, Res> — discharges exactly K.
//
// Kit-specific capture combinators (param, query, header, field, …) are thin
// wrappers over this primitive that supply the `read` function and pin V.
// ---------------------------------------------------------------------------

export function capture<
  K extends string,
  V,
  C extends Record<K, V>,
  Res,
>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const value = read(req)
    if (value === pass) return pass
    const enriched = {
      ...req,
      params: { ...(req.params as object), [name]: value } as unknown as C,
    } as Req<C>
    return child(enriched)
  }
}

// ---------------------------------------------------------------------------
// Typed: sync, eager refinement of params values
//
// Typed refines the raw params bag into a typed shape Out.
// The `parse` function takes the raw params record (Record<string,unknown>) and
// returns Out. It is SYNC and EAGER — it reads values that are already in the
// params bag (put there by prior capture combinators or the caller).
//
// Contrast with the HTTP kit's validate() which is ASYNC and LAZY — it pulls
// a lazy body handle. typed() has nothing to do with request bodies.
//
// The parse function receives Record<string,unknown> — NOT Record<string,string>.
// Individual kit captures may have injected strings or richer types; typed()
// does not assume the value type, only that the params bag is a plain record.
// ---------------------------------------------------------------------------

export function typed<
  Out extends Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(
  parse: (raw: Record<string, unknown>) => Out,
): (inner: Handler<P & Out, Res>) => Handler<P, Res> {
  return (inner) =>
    async (req) => {
      const parsed = parse(req.params as Record<string, unknown>)
      const enriched: Req<P & Out> = {
        ...req,
        params: { ...(req.params as object), ...parsed } as P & Out,
      }
      return inner(enriched)
    }
}

/**
 * Leaf: wraps a plain async function into a Handler.
 * This is the ONLY place application logic lives.
 */
export function leaf<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(fn: (req: Req<P>) => Promise<Res>): Handler<P, Res> {
  return fn
}

/**
 * Run: the entrypoint. Accepts only a fully-discharged handler (P = {}).
 * A Pass from the root handler becomes a "not found" sentinel (null).
 */
export async function run<Res>(
  h: Handler<Record<string, never>, Res>,
  req: Req<Record<string, never>>,
): Promise<Res | null> {
  const res = await h(req)
  if (res === pass) return null
  return res as Res
}
