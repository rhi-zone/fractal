// packages/core/src/index.ts — @rhi-zone/fractal-core
//
// The agnostic Handler core. Protocol-free: no HTTP verbs, URL paths,
// procedure names, or transport shape. The only structure required is
// that a request carries a `params` field.
//
// Protocol-specific combinators (path, methods, procedure) live in their
// kits. Core does NOT mention string as a constraint on params values.
// V is free; each kit pins it to whatever the transport delivers.

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
 * pipe: compose middleware left-to-right via reduceRight.
 * pipe(mw1, mw2)(h) = mw1(mw2(h))
 * mw1 is outermost and runs first; mw2 is closer to the base handler.
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
// V is FREE. Each kit pins V to whatever the transport delivers:
//   - HTTP kit: V = string (text-protocol values)
//   - Worker kit: V = number | object | … (pre-typed values from IPC/memory)
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
