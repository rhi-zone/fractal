// spike/composable/router.ts — THE composable router model.
//
// One primitive: a route is a VALUE. A path is a composable struct of segment
// VALUES (never a string). Routers compose FLAT (an associative array of route
// values). `mount` is a flat value-transform: prepend prefix segments to each
// route. Three surfaces are projected from the SAME flat route data:
//   toHandler  — dispatch (walk segments+method, bind params, call handler)
//   client     — typed in-process client derived from the flat route array
//   toOpenApi  — structural projection (segments → /users/{id}, method → op)
//
// Per-route typing is LOCAL: params come from the param-segment STRUCTURE, not
// from parsing a path string. The router's type is the FLAT union of its route
// values — no deep accumulation chain. This is the whole point: linear cost.

import type { StandardSchema, InferOutput } from "@rhi-zone/fractal-api-tree"

// ============================================================================
// Segments — value structs. A path is Segment[]; its params come from the
// STRUCTURE (which segments are `param`), not from string parsing.
// ============================================================================

/** A literal path segment, e.g. lit("users") → matches "users". */
export interface LitSegment<V extends string = string> {
  readonly kind: "lit"
  readonly value: V
}

/** A param segment. `name` keys the params record; `codec` may refine its type
 *  (default string). The codec is a StandardSchema<string, T>: decode the raw
 *  path segment string into T. */
export interface ParamSegment<N extends string = string, T = unknown> {
  readonly kind: "param"
  readonly name: N
  // phantom carrier for the decoded type T (no runtime cost when absent)
  readonly codec?: StandardSchema<string, T>
}

// The Segment union admits any param-codec type (T = unknown) so a numeric
// codec's segment is still a Segment. ParamsOf recovers the precise T per route.
export type Segment = LitSegment | ParamSegment<string, unknown>

// --- constructors (values, not strings) ------------------------------------

export function lit<const V extends string>(value: V): LitSegment<V> {
  return { kind: "lit", value }
}

/** param("id") → {id:string}; param("id", codec) → {id: InferOutput<codec>}. */
export function param<const N extends string>(name: N): ParamSegment<N, string>
export function param<const N extends string, T>(
  name: N,
  codec: StandardSchema<string, T>,
): ParamSegment<N, T>
export function param(
  name: string,
  codec?: StandardSchema<string, unknown>,
): ParamSegment<string, unknown> {
  return codec === undefined ? { kind: "param", name } : { kind: "param", name, codec }
}

/** Compose segments into a path value. Variadic + flat — `path(a, b, c)` is
 *  exactly `[a, b, c]`. Associativity is structural (array concat). */
export function path<const S extends readonly Segment[]>(...segs: S): S {
  return segs
}

// --- params type, derived from the STRUCTURE of the segment tuple ----------
// Walk the tuple, collect each ParamSegment's {name: T}. This is a single pass
// over a tuple whose length is the path depth (~2–3), NOT over N routes. No
// template-literal string parsing, no accumulation across routes.

export type ParamsOf<S extends readonly Segment[]> = {
  readonly [Seg in Extract<S[number], ParamSegment> as Seg["name"]]: Seg extends ParamSegment<
    string,
    infer T
  >
    ? T
    : never
}

// ============================================================================
// Route — a VALUE. meta = {pattern, method, input?, output?}; handler = closure.
// The handler is the ONLY opaque leaf; everything else is inert data.
// ============================================================================

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

/** The context a route handler receives: typed params + a body accessor. The
 *  body type is `I` (the validated input, or never when there's no body). */
export interface RouteCtx<S extends readonly Segment[], I> {
  readonly params: ParamsOf<S>
  readonly body: I
  readonly request: Request
}

/** A route value. The pattern is data (Segment[]); `schema` (optional) is the
 *  body validator as data; `handler` is the opaque leaf. `__out` is a phantom
 *  carrying the handler's return for the typed client. */
// I/O are carried as PHANTOM optional fields (`__in`/`__out`), never as a
// variance-bearing position. The `schema` field is type-erased to
// `StandardSchema<unknown, unknown>` so it imposes no variance on `I`; the
// precise input lives only in the `__in` phantom (a bare property → invariant
// is harmless because it's optional & never read at runtime). This lets a flat
// collection bound `Route<...Segment[], Method>` admit body-less (`__in: never`)
// and validated (`__in: Body`) routes alike without collapsing either.
export interface Route<
  S extends readonly Segment[] = readonly Segment[],
  M extends Method = Method,
  I = unknown,
  O = unknown,
> {
  readonly pattern: S
  readonly method: M
  readonly schema?: StandardSchema<unknown, unknown>
  readonly handler: (ctx: RouteCtx<S, I>) => O | Promise<O>
  // phantom carriers — recovered by the client/openapi projections
  readonly __in?: I
  readonly __out?: O
}

/** Permissive element bound for flat collections. The `handler` position is
 *  contravariant in its ctx, so a fixed `I` would reject either body-less or
 *  validated routes. We bound by a structural shape whose handler accepts the
 *  bottom ctx (`never`) — every concrete route's handler is assignable to it —
 *  and whose phantoms are unconstrained, so each route keeps its own I/O on the
 *  inferred tuple. This is the element constraint; the inferred `R` is precise. */
export interface AnyRoute {
  readonly pattern: readonly Segment[]
  readonly method: Method
  readonly schema?: StandardSchema<unknown, unknown>
  readonly handler: (ctx: never) => unknown
  readonly __in?: unknown
  readonly __out?: unknown
}

/** route(method, path, handler) — no body. */
export function route<const S extends readonly Segment[], M extends Method, O>(
  method: M,
  pattern: S,
  handler: (ctx: RouteCtx<S, never>) => O | Promise<O>,
): Route<S, M, never, O>
/** route(method, path, schema, handler) — validated body of type InferOutput. */
export function route<
  const S extends readonly Segment[],
  M extends Method,
  V extends StandardSchema<unknown, unknown>,
  O,
>(
  method: M,
  pattern: S,
  schema: V,
  handler: (ctx: RouteCtx<S, InferOutput<V>>) => O | Promise<O>,
): Route<S, M, InferOutput<V>, O>
export function route(
  method: Method,
  pattern: readonly Segment[],
  schemaOrHandler: unknown,
  maybeHandler?: unknown,
): AnyRoute {
  if (maybeHandler === undefined) {
    return { pattern, method, handler: schemaOrHandler as Route["handler"] }
  }
  return {
    pattern,
    method,
    schema: schemaOrHandler as StandardSchema<unknown, unknown>,
    handler: maybeHandler as Route["handler"],
  }
}

// ============================================================================
// Router — a FLAT collection of route values. `routes(...)` / `merge` are
// associative array concatenation. `mount` is a flat value-transform.
// ============================================================================

/** A router IS its flat tuple of routes. No wrapper object, no accumulation
 *  state — the value and its type are the flat array. */
export type Router<R extends readonly AnyRoute[] = readonly AnyRoute[]> = R

/** Collect routes into a flat router value. `routes(a, b, c)` === `[a, b, c]`. */
export function routes<const R extends readonly AnyRoute[]>(...rs: R): R {
  return rs
}

/** Merge flat routers — associative concat. `merge(routes(a), routes(b))`. */
export function merge<const A extends readonly AnyRoute[], const B extends readonly AnyRoute[]>(
  a: A,
  b: B,
): readonly [...A, ...B] {
  return [...a, ...b]
}

/** mount(prefix, sub) — prepend `prefix` segments to EACH route's pattern. A
 *  pure flat value-transform; no string mount prefix, no nesting. */
export function mount<const P extends readonly Segment[], const R extends readonly AnyRoute[]>(
  prefix: P,
  sub: R,
): { readonly [K in keyof R]: MountRoute<P, R[K]> } {
  return sub.map((r) => ({ ...r, pattern: [...prefix, ...r.pattern] })) as {
    readonly [K in keyof R]: MountRoute<P, R[K]>
  }
}

type MountRoute<P extends readonly Segment[], R> =
  R extends Route<infer S, infer M, infer I, infer O>
    ? Route<readonly [...P, ...S], M, I, O>
    : never
