// spike/composable/client.ts — typed client projection (surface #2).
//
// client(router) → a typed surface keyed by route, derived from the FLAT route
// array. NO chained accumulation: one mapped type walks the flat tuple R, and
// each route's call signature comes from its OWN segment structure (params),
// its body type I, and its return O. In-process transport: the client builds a
// Request and feeds it to toHandler, OR (here) calls the handler directly.
//
// The key access is a structural path key derived from the segments
// ("/users/{id}"), so distinct routes key distinctly without string patterns.

import type { Route, AnyRoute, Segment, ParamSegment, ParamsOf } from "./router"
import { toHandler, type Json } from "./http"

// --- a stable string KEY for a route, derived from its segment STRUCTURE -----
// lit("users"), param("id") → "/users/{id}". This is a type-level fold over the
// segment tuple (depth ~2–3), not over N routes.
type KeyOf<S extends readonly Segment[]> = S extends readonly [infer H, ...infer Rest]
  ? H extends { readonly kind: "lit"; readonly value: infer V extends string }
    ? Rest extends readonly Segment[] ? `/${V}${KeyOf<Rest>}` : `/${V}`
    : H extends ParamSegment<infer N, unknown>
      ? Rest extends readonly Segment[] ? `/{${N}}${KeyOf<Rest>}` : `/{${N}}`
      : ""
  : ""

// recover the domain type from a Json<T> return (phantom __body), else the raw.
type BodyOf<O> = Awaited<O> extends Json<infer T> ? T : Awaited<O>

type HasParams<S extends readonly Segment[]> = keyof ParamsOf<S> extends never ? false : true
type HasBody<I> = [I] extends [never] ? false : true

type CallArgs<S extends readonly Segment[], I> = (HasParams<S> extends true
  ? { params: ParamsOf<S> }
  : Record<never, never>) &
  (HasBody<I> extends true ? { body: I } : Record<never, never>)

type CallSig<S extends readonly Segment[], I, O> = keyof CallArgs<S, I> extends never
  ? () => Promise<BodyOf<O>>
  : (args: CallArgs<S, I>) => Promise<BodyOf<O>>

/** The typed client surface: one mapped type over the FLAT route tuple. For
 *  each route value, key by its structural path, then by lowercased method. */
export type Client<R extends readonly AnyRoute[]> = {
  readonly [Rt in R[number] as KeyOf<Rt["pattern"]>]: {
    readonly [M in Rt["method"] as Lowercase<M>]: Rt extends Route<
      infer S,
      M,
      infer I,
      infer O
    >
      ? CallSig<S, I, O>
      : never
  }
}

// --- runtime key (mirrors KeyOf) -------------------------------------------
function keyOf(pattern: readonly Segment[]): string {
  let k = ""
  for (const s of pattern) k += s.kind === "lit" ? `/${s.value}` : `/{${(s as ParamSegment).name}}`
  return k
}

function pathOf(pattern: readonly Segment[], params: Record<string, string>): string {
  let p = ""
  for (const s of pattern)
    p += s.kind === "lit" ? `/${s.value}` : `/${params[(s as ParamSegment).name]}`
  return p
}

/** Build the in-process typed client. Each method builds a real Request and
 *  dispatches through `toHandler` — server-identical results, no separate
 *  code path. Derived entirely from the flat route array. */
export function client<const R extends readonly AnyRoute[]>(router: R): Client<R> {
  const dispatch = toHandler(router)
  const surface: Record<string, Record<string, unknown>> = {}
  for (const r of router) {
    const key = keyOf(r.pattern)
    const m = r.method.toLowerCase()
    ;(surface[key] ??= {})[m] = async (args?: { params?: Record<string, string>; body?: unknown }) => {
      const p = pathOf(r.pattern, args?.params ?? {})
      const init: RequestInit = { method: r.method }
      if (args?.body !== undefined) {
        init.body = JSON.stringify(args.body)
        init.headers = { "content-type": "application/json" }
      }
      const res = await dispatch(new Request(`http://local${p}`, init))
      return res.json()
    }
  }
  return surface as Client<R>
}
