// spike/iron/http.ts — the HTTP conveniences, as FUNCTIONS over the one type.
//
// `path` / `param` / `methods` / `choice` / `mount` / `validate` are ordinary
// functions that take handlers and return a handler-with-`.meta`. They are NOT
// types and NOT a fixed required set — just userland conveniences over the one
// primitive (`Handler` from core.ts). A "route" is a handler; a "router" is a
// handler (built by `choice`); a "segment match" is a handler.
//
// The handler's runtime arrow here is `(ctx: Ctx) => Promise<Reply>`: it reads
// a request facet (method/segments/params/body), dispatches, and returns a
// reply descriptor that the serve adapter renders. The `.meta` it carries is a
// plain DATA tree mirroring the dispatch structure, walked by the projections.
//
// This module is Bun-free. It uses only WHATWG `Request`/`Response` (the http
// surface). The runtime touch (`Bun.serve`) lives in serve.ts.

import { type Handler, handler } from "./core.ts"
import type { StandardSchema, InferOutput } from "@rhi-zone/fractal-core"

// ============================================================================
// The request facet a handler reads, and the reply it returns. These are not
// "framework types" in the iron sense — they are the T and U of the arrow, the
// data a handler consumes/produces. The ONLY framework *type* remains Handler.
// ============================================================================

/** What a dispatch handler reads: the remaining path segments, the method, the
 *  params bound so far, and a lazy body accessor. A plain data record. */
export interface Ctx<P> {
  readonly segments: readonly string[] // unconsumed path segments
  readonly method: string
  readonly params: P
  readonly body: () => Promise<unknown>
  readonly request: Request
}

/** A reply descriptor: status + a body value + content kind. Plain data; the
 *  serve adapter renders it to a `Response`. `null` means "no match here". */
export interface Reply<T = unknown> {
  readonly status: number
  readonly value: T
  readonly kind: "json" | "text" | "binary" | "sse"
  readonly headers?: Readonly<Record<string, string>>
  readonly __out?: T // phantom: the typed-client output carrier
}

// reply constructors (status-aware, content-aware)
export function json<const T>(value: T, status = 200): Reply<T> {
  return { status, value, kind: "json" }
}
export function text(value: string, status = 200): Reply<string> {
  return { status, value, kind: "text" }
}
export function binary(value: Uint8Array, status = 200): Reply<Uint8Array> {
  return { status, value, kind: "binary" }
}
export function sse(value: ReadableStream, status = 200): Reply<ReadableStream> {
  return { status, value, kind: "sse" }
}

// ============================================================================
// META — the inert DATA descriptor tree. This is the value of `M`, NOT a
// framework type hierarchy. Each shape is a plain object literal a combinator
// attaches. The projections (client/toOpenApi) walk these by their `tag`.
// The TYPES below exist only to type the `M` slot of `Handler`; they describe
// DATA, not handlers. (They are not `Route`/`Segment`/`Router`/`Node` — there
// is no handler-shaped type among them; a handler stays `Handler`.)
// ============================================================================

// A param meta leaf carries the param name and decoded type T as a phantom.
interface ParamMeta<N extends string, T> {
  readonly tag: "param"
  readonly name: N
  readonly __t?: T
}
// A literal path segment.
interface LitMeta<V extends string> {
  readonly tag: "lit"
  readonly value: V
}
// An endpoint: the path segments, the method, body type I + output O (phantom).
interface EndMeta<Segs extends readonly unknown[], M extends string, I, O> {
  readonly tag: "end"
  readonly segs: Segs
  readonly method: M
  readonly hasBody: boolean
  readonly __i?: I
  readonly __o?: O
}
// A choice of alternative endpoint handlers (the "router"): a tuple of metas.
interface ChoiceMeta<Ms extends readonly unknown[]> {
  readonly tag: "choice"
  readonly alts: Ms
}
// A path-prefixed handler (mount): prefix literals + an inner meta.
interface PrefixMeta<Pre extends readonly unknown[], R> {
  readonly tag: "prefix"
  readonly pre: Pre
  readonly rest: R
}

// the output body type carried in EndMeta.__o, distributed over a reply union.
type OutOf<R> = R extends Reply<infer T> ? T : never

// the params record folded from a segment tuple's `param` leaves (a single pass
// over a short tuple — path depth ~2-4 — NOT over N routes).
type ParamsOf<Segs extends readonly unknown[]> = {
  readonly [S in Extract<Segs[number], ParamMeta<string, unknown>> as S["name"]]: S extends ParamMeta<
    string,
    infer T
  >
    ? T
    : never
}

// ============================================================================
// segment constructors — FUNCTIONS returning inert segment DATA (typed inline,
// no exported segment TYPE). `path(...)` collects them into a tuple value.
// ============================================================================

/** A literal segment value: `lit("users")` matches the path part "users". */
export function lit<const V extends string>(value: V): LitMeta<V> {
  return { tag: "lit", value }
}
/** A param segment: `param("id")` binds `{id:string}`; with a codec, `{id:T}`. */
export function param<const N extends string>(name: N): ParamMeta<N, string>
export function param<const N extends string, T>(
  name: N,
  codec: StandardSchema<string, T>,
): ParamMeta<N, T> & { readonly codec: StandardSchema<string, T> }
export function param(
  name: string,
  codec?: StandardSchema<string, unknown>,
): ParamMeta<string, unknown> & { readonly codec?: StandardSchema<string, unknown> } {
  return codec === undefined ? { tag: "param", name } : { tag: "param", name, codec }
}
/** Collect segments into a path tuple value. `path(a,b,c)` ≡ `[a,b,c]`. */
export function path<const Segs extends readonly (LitMeta<string> | ParamMeta<string, unknown>)[]>(
  ...segs: Segs
): Segs {
  return segs
}

// ============================================================================
// endpoint combinators — FUNCTIONS taking (method, path, handler) and returning
// a handler-with-meta. Handler-last → clean inference; params fold from `path`.
// ============================================================================

/** `route(method, path, fn)` — an endpoint handler (no body). Matches when the
 *  segments + method line up; binds params from the `path` structure; runs `fn`.
 *  A "route" is just a handler. */
export function route<
  const Segs extends readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
  const M extends string,
  R extends Reply<unknown>,
>(
  method: M,
  segs: Segs,
  fn: (ctx: Ctx<ParamsOf<Segs>>) => R | Promise<R>,
): Handler<Ctx<unknown>, R | null, EndMeta<Segs, M, never, OutOf<R>>>
/** `route(method, path, schema, fn)` — an endpoint with a validated body of
 *  type `InferOutput<V>`; `fn` reads `ctx.input`. */
export function route<
  const Segs extends readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
  const M extends string,
  V extends StandardSchema<unknown, unknown>,
  R extends Reply<unknown>,
>(
  method: M,
  segs: Segs,
  schema: V,
  fn: (ctx: Ctx<ParamsOf<Segs>> & { readonly input: InferOutput<V> }) => R | Promise<R>,
): Handler<Ctx<unknown>, R | null, EndMeta<Segs, M, InferOutput<V>, OutOf<R>>>
export function route(
  method: string,
  segs: readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
  schemaOrFn: unknown,
  maybeFn?: unknown,
): Handler<Ctx<unknown>, Reply<unknown> | null, EndMeta<readonly unknown[], string, unknown, unknown>> {
  const hasBody = maybeFn !== undefined
  const schema = hasBody ? (schemaOrFn as StandardSchema<unknown, unknown>) : undefined
  // localized `as` — runtime only; the overloads above keep the type surface clean.
  const fn = (hasBody ? maybeFn : schemaOrFn) as (ctx: unknown) => Reply<unknown> | Promise<Reply<unknown>>
  return handler(
    { tag: "end", segs, method, hasBody },
    async (ctx: Ctx<unknown>) => {
      const bound = matchSegments(segs, ctx.segments)
      if (bound === null) return null
      if (ctx.method !== method && method !== "*") return null
      const base = { ...ctx, params: bound }
      if (schema === undefined) return fn(base)
      const raw = await ctx.body()
      const r = schema["~standard"].validate(raw)
      if (r.issues !== undefined) {
        return { status: 422, value: { error: "VALIDATION", issues: r.issues }, kind: "json" }
      }
      return fn({ ...base, input: r.value })
    },
  )
}

// match a segment tuple against request path parts; bind+decode params or null.
function matchSegments(
  segs: readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
  parts: readonly string[],
): Record<string, unknown> | null {
  if (segs.length !== parts.length) return null
  const params: Record<string, unknown> = {}
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const part = parts[i]!
    if (s.tag === "lit") {
      if (s.value !== part) return null
    } else {
      const codec = (s as { codec?: StandardSchema<string, unknown> }).codec
      if (codec !== undefined) {
        const r = codec["~standard"].validate(part)
        if (r.issues !== undefined) return null
        params[s.name] = r.value
      } else {
        params[s.name] = part
      }
    }
  }
  return params
}

/** `choice(...alts)` — the "router": try each handler in order; first non-null
 *  reply wins, else null (caller renders 404, or 405 when a path matched but the
 *  method didn't). A router is a handler. Meta = ChoiceMeta of the alt metas. */
export function choice<const Hs extends readonly Handler<Ctx<unknown>, Reply | null, unknown>[]>(
  ...alts: Hs
): Handler<Ctx<unknown>, Reply | null, ChoiceMeta<{ readonly [K in keyof Hs]: Hs[K]["meta"] }>> {
  const metas = alts.map((a) => a.meta) as { readonly [K in keyof Hs]: Hs[K]["meta"] }
  return handler({ tag: "choice", alts: metas }, async (ctx: Ctx<unknown>) => {
    for (const alt of alts) {
      const out = await alt(ctx)
      if (out !== null && out !== undefined) return out
    }
    return null
  })
}

/** `mount(prefix, sub)` — path-prefix an entire sub-handler. The prefix parts
 *  are stripped before delegating; the meta nests under PrefixMeta. A mounted
 *  sub-app is still a handler. */
export function mount<const Pre extends readonly string[], U, MI>(
  prefix: Pre,
  sub: Handler<Ctx<unknown>, U, MI>,
): Handler<Ctx<unknown>, U | null, PrefixMeta<Pre, MI>> {
  return handler(
    { tag: "prefix", pre: prefix, rest: sub.meta },
    async (ctx: Ctx<unknown>) => {
      for (let i = 0; i < prefix.length; i++) {
        if (ctx.segments[i] !== prefix[i]) return null
      }
      return sub({ ...ctx, segments: ctx.segments.slice(prefix.length) })
    },
  )
}

// ============================================================================
// serve — a handler IS the app. `toHandler` turns it into a WHATWG fetch
// handler, adding 404 / 405+Allow / auto-HEAD around the root handler. The root
// handler does the matching; `toHandler` only frames the result as a Response.
// ============================================================================

/** Turn the root handler into `(Request) => Promise<Response>`. The handler is
 *  the app; serve runs it. Adds 405+Allow (methods that match the path but not
 *  the verb), auto-HEAD (run GET, drop body), and renders the Reply. */
export function toHandler<P>(
  app: Handler<Ctx<P>, Reply | null, unknown>,
): (req: Request) => Promise<Response> {
  // collect, from the meta tree, which methods are registered at each path —
  // used for 405 Allow. Walk once (structure is small).
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segments = url.pathname.split("/").filter((s) => s.length > 0)
    const wantHead = req.method.toUpperCase() === "HEAD"
    const method = wantHead ? "GET" : req.method.toUpperCase()
    let bodyPulled: Promise<unknown> | undefined
    const ctx: Ctx<P> = {
      segments,
      method,
      params: {} as P,
      body: () => (bodyPulled ??= req.json().catch(() => undefined)),
      request: req,
    }
    const reply = await app(ctx)
    if (reply === null) {
      // distinguish 405 from 404: re-walk meta for methods registered at path
      const allow = allowedMethods(app.meta, segments)
      if (allow.length > 0) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: [...allow, "HEAD", "OPTIONS"].join(", ") },
        })
      }
      return new Response("Not Found", { status: 404 })
    }
    return render(reply, wantHead)
  }
}

function render(reply: Reply, head: boolean): Response {
  const body = head ? null : bodyFor(reply)
  const headers = new Headers(reply.headers)
  if (reply.kind === "json") headers.set("content-type", "application/json")
  else if (reply.kind === "text") headers.set("content-type", "text/plain")
  else if (reply.kind === "sse") headers.set("content-type", "text/event-stream")
  return new Response(body, { status: reply.status, headers })
}
function bodyFor(reply: Reply): BodyInit | null {
  switch (reply.kind) {
    case "json":
      return JSON.stringify(reply.value)
    case "text":
      return String(reply.value)
    case "binary":
      return (reply.value as Uint8Array).buffer as ArrayBuffer
    case "sse":
      return reply.value as ReadableStream
  }
}

// walk the meta DATA tree to find methods registered at a given path (for 405).
function allowedMethods(meta: unknown, segments: readonly string[]): string[] {
  const out = new Set<string>()
  walk(meta, segments, out)
  return [...out].sort()
}
function walk(meta: unknown, segs: readonly string[], out: Set<string>): void {
  if (typeof meta !== "object" || meta === null) return
  const m = meta as { tag?: string }
  if (m.tag === "end") {
    const end = meta as EndMeta<readonly (LitMeta<string> | ParamMeta<string, unknown>)[], string, unknown, unknown>
    if (segsMatch(end.segs, segs)) out.add(end.method)
    return
  }
  if (m.tag === "prefix") {
    const pm = meta as PrefixMeta<readonly string[], unknown>
    for (let i = 0; i < pm.pre.length; i++) if (pm.pre[i] !== segs[i]) return
    walk(pm.rest, segs.slice(pm.pre.length), out)
    return
  }
  if (m.tag === "choice") {
    for (const alt of (meta as ChoiceMeta<readonly unknown[]>).alts) walk(alt, segs, out)
  }
}
// shape-match a segment tuple against path parts (lit must equal; param is free).
function segsMatch(
  segs: readonly (LitMeta<string> | ParamMeta<string, unknown>)[],
  parts: readonly string[],
): boolean {
  if (segs.length !== parts.length) return false
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    if (s.tag === "lit" && s.value !== parts[i]) return false
  }
  return true
}

// re-export the meta shape types for the projections (they are DATA-descriptor
// types parameterising the `M` slot — not handler types).
export type { ParamMeta, LitMeta, EndMeta, ChoiceMeta, PrefixMeta }
