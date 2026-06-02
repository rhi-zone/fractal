// spike/core.ts — agnostic Handler core
//
// The core is deliberately protocol-free. It knows nothing about HTTP verbs,
// URL paths, procedure names, or any transport shape. The only structure it
// requires is that a request carries a `params` field — the slot into which
// `param` (and its kit-specific cousins) inject captured values.
//
// Protocol-specific combinators (path, methods, procedure) live in their kits.
// The path-consuming `param` combinator lives in the HTTP kit — it must consume
// a path segment, which is an HTTP-specific concept. The type-discharge pattern
// (Omit<C,K>) it uses is the same algebra defined here.

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
// ---------------------------------------------------------------------------

export type Req<P> = { params: P } & Record<string, unknown>

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type Handler<P = Record<string, never>, Res = unknown> = (
  req: Req<P>,
) => Promise<Res | Pass>

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type Middleware<P, Res> = (h: Handler<P, Res>) => Handler<P, Res>

/**
 * pipe: compose middleware left-to-right.
 * pipe(mw1, mw2)(h) = mw2(mw1(h))
 * Applies mw1 first, then mw2 outermost.
 */
export function pipe<P, Res>(
  ...mws: Middleware<P, Res>[]
): Middleware<P, Res> {
  return (h) => mws.reduceRight((acc, mw) => mw(acc), h)
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Tries handlers in order; returns the first non-Pass result. */
export function choice<P, Res>(...hs: Handler<P, Res>[]): Handler<P, Res> {
  return async (req) => {
    for (const h of hs) {
      const res = await h(req)
      if (res !== pass) return res
    }
    return pass
  }
}

/**
 * Typed: refines raw string params into a typed shape `Out`.
 * Discharges `Out` from the inner handler's requirements.
 *
 * The `parse` function takes the raw params record and returns `Out`.
 * A real Standard Schema validator would slot in here — the spike uses a
 * plain synchronous parser. The interface accommodates async too.
 */
export function typed<Out, P = Record<string, never>, Res = unknown>(
  parse: (raw: Record<string, string>) => Out,
): (inner: Handler<P & Out, Res>) => Handler<P, Res> {
  return (inner) =>
    async (req) => {
      const parsed = parse(req.params as Record<string, string>)
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
export function leaf<P = Record<string, never>, Res = unknown>(
  fn: (req: Req<P>) => Promise<Res>,
): Handler<P, Res> {
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
