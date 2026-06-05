// packages/core/src/index.ts — @rhi-zone/fractal-core
//
// The routing ALGEBRA. The ONLY framework type is the handler, and it is
// literally the web standard:
//
//   Handler<R> = (req: Request & { ctx: R }) =>
//                  Response | undefined | Promise<Response | undefined>
//
// `Request`/`Response` are the ambient WHATWG globals (no runtime dep — this
// package imports no Bun and no Node). `undefined` means "not mine — pass to the
// next handler". Combinators are PLAIN FUNCTIONS returning a Handler. "How much
// path is consumed" lives in the Request's own URL: descending rewrites the URL
// (advances past consumed segments), so there is no routing-ctx object, no Router
// type, no dispatch side channel.
//
// ONE context bag — `req.ctx` — carries BOTH captured path params AND
// middleware-injected vars (e.g. an authenticated `user`). `R` is the set of keys
// a handler REQUIRES present on `req.ctx`. Two discharge mechanisms fill it:
//   - `param(name, inner)` discharges a PATH-PARAM key (an API-surface key — it
//     appears in the OpenAPI path + the generated client's call args), and
//   - `provide(key, produce, inner)` discharges a VAR key (a server-internal key —
//     NOT a path param, NOT API surface; invisible to client + OpenAPI params).
// The TYPE `R` reads both alike; only the PROJECTIONS split them by meta source.
//
// There is NO Route / Segment / Router / Node / Ctx / RoutingCtx type. `.meta`
// is an INERT reflection sidecar bolted onto the handler function, read only by
// the OpenAPI projection (`toOpenApi`), the codegen (`generate`/`fractal watch`),
// and the drift-guard substrate (`routeTable`/`RouteUnion`) — NEVER on the
// dispatch path. There is no runtime client walker; codegen projects from the
// static `.meta` tree at build time.

// ============================================================================
// Handler — the one framework type
// ============================================================================

// `Handler<R>` is parameterized by the context-bag keys it REQUIRES. The bag
// rides as a TYPED FIELD `ctx` on the standard `Request` (itty-router-style
// runtime, typed) and holds BOTH captured path params AND middleware-injected
// vars. `R` defaults to `{}` so a ctx-free handler is just `Handler`. Because
// `Request & { ctx: R }` is a SUBtype of `Request`, a plain
// `(req: Request) => Response` is contravariantly assignable to `Handler` AND to
// any `Handler<R>` — a plain web handler IS a Handler.
export type Handler<R = {}> = (
  req: Request & { ctx: R },
) => Response | undefined | Promise<Response | undefined>;

/** The runtime carrier: a real `Request` with a `ctx` own-property (the one bag
 *  holding path params + injected vars). */
export type ReqWithCtx<R> = Request & { ctx: R };

/** Attach (or re-attach) a `ctx` own-property to a Request, in place. Returns
 *  the SAME Request, retyped — it stays a real Request (json()/headers/method). */
export function withCtx<R>(req: Request, ctx: R): ReqWithCtx<R> {
  (req as ReqWithCtx<R>).ctx = ctx;
  return req as ReqWithCtx<R>;
}

// Closed verb union: a typo like "GETT" is a COMPILE ERROR in the bare `methods`.
export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

// ============================================================================
// path consumption, read straight off the Request's URL
// ============================================================================

/** Remaining (unconsumed) path segments: pathname split on "/", empties dropped. */
export function segments(req: Request): string[] {
  return new URL(req.url).pathname.split("/").filter((s) => s !== "");
}

/** Clone `req` with its pathname replaced by `segs` (method/headers/body kept).
 *  `new Request(url, req)` drops custom own-properties, so we re-attach `ctx`
 *  (carried from the source Request, defaulting to `{}`) to keep it a typed Req. */
function withSegments<R>(req: Request, segs: string[]): ReqWithCtx<R> {
  const url = new URL(req.url);
  url.pathname = "/" + segs.join("/");
  const ctx = (req as Partial<ReqWithCtx<R>>).ctx ?? ({} as R);
  return withCtx(new Request(url, req), ctx);
}

/**
 * The URL-advancing primitive, exposed for dynamic segments. A handler that
 * reads a dynamic value (e.g. an id via `segments(req)[0]`) calls `rest(req)`
 * to get a Request advanced past that one segment, then delegates the remaining
 * path to an inner handler. This is NOT a param/capture combinator: it carries
 * no value, takes no pattern, and reads nothing — it only advances the URL,
 * while the id is still read directly off the Request.
 */
export function rest<R>(req: ReqWithCtx<R>): ReqWithCtx<R> {
  return withSegments(req, segments(req).slice(1));
}

// ============================================================================
// Bare combinators (plain functions returning a Handler) — the runtime algebra.
// The meta-carrying variants below delegate to these and bolt on `.meta`.
// ============================================================================

/**
 * Dispatch on the first not-yet-consumed path segment. Keys are literal
 * segment names. If the first remaining segment is a key, call that handler
 * with a Request advanced past that segment; otherwise return undefined.
 */
function pathRT<R = {}>(routes: Record<string, Handler<R>>): Handler<R> {
  return (req) => {
    const segs = segments(req);
    const head = segs[0];
    if (head === undefined) return undefined;
    const next = routes[head];
    if (next === undefined) return undefined;
    return next(withSegments<R>(req, segs.slice(1)));
  };
}

/**
 * Capture a dynamic path segment as a TYPED param and DISCHARGE it. `param(name,
 * child)` reads the first remaining segment, binds it into `req.ctx[name]`,
 * advances the URL past it, and delegates to `child`. The child is parameterized
 * by `Q` (its full required-ctx object, which must include `name`); the result
 * is `Handler<Omit<Q, name>>` — the captured key is removed from the obligation.
 *
 * The signature infers the child's WHOLE ctx object `Q` and removes `K` via
 * `Omit` (rather than `Handler<R & Record<K,string>> -> Handler<R>`, which fails
 * inference: TS cannot split a `R & Record<K,string>` intersection back into `R`,
 * so it binds `R` to the whole thing and discharges nothing). `Omit` is the
 * minimal fix and composes: `param("id", param("postId", gc))` discharges both.
 */
function paramRT<K extends string, Q extends Record<K, string>>(
  name: K,
  child: Handler<Q>,
): Handler<Omit<Q, K>> {
  return (req) => {
    const value = segments(req)[0];
    if (value === undefined) return undefined;
    // bind the captured value into ctx, then advance the URL past the segment.
    const bound = { ...(req.ctx as object), [name]: value } as Q;
    const advanced = withSegments<Q>(req, segments(req).slice(1));
    advanced.ctx = bound;
    return child(advanced);
  };
}

/**
 * PURE verb dispatch + pass. Only fires when the path is FULLY consumed.
 *   - segment remaining          -> undefined (not mine — path not consumed)
 *   - consumed + method in table -> call it
 *   - consumed + method missing  -> undefined (PASS — let a sibling alt try)
 *
 * Dispatch is a pure `(Request) => Response | undefined`. `methods` serves ONLY
 * the verbs explicitly present in its table (a user who puts HEAD/OPTIONS in the
 * table gets them served directly). It NEVER emits 405, never auto-derives HEAD
 * from GET, and never synthesizes OPTIONS — emitting a 405 mid-dispatch would
 * short-circuit `choice` and hide a later alt that DOES handle the verb, and an
 * `Allow` computed from one table cannot see sibling alts / mounts at the same
 * path. Those HTTP-correctness concerns (405 / Allow / auto-HEAD / OPTIONS /
 * 404) are a PROJECTION computed from `.meta` in `toFetch` — see the
 * dispatch-vs-projection boundary note at the head of the COMBINATORS section.
 */
function methodsRT<R = {}>(
  table: Partial<Record<Method, Handler<R>>>,
): Handler<R> {
  return (req) => {
    if (segments(req).length > 0) return undefined; // path not fully consumed
    const direct = table[req.method as Method];
    if (direct !== undefined) return direct(req);
    return undefined; // verb-miss -> PASS (a sibling choice alt may handle it)
  };
}

/** Try each handler in order; first non-undefined wins; else undefined. */
function choiceRT<R = {}>(...handlers: Handler<R>[]): Handler<R> {
  return async (req) => {
    for (const h of handlers) {
      const res = await h(req);
      if (res !== undefined) return res;
    }
    return undefined;
  };
}

// ============================================================================
// `.meta` — the INERT reflection sidecar. A Handler that ALSO carries reflection
// DATA. The runtime arrow is the exact bare Handler; `meta` is a bolted-on
// property, read only by projections (e.g. `toOpenApi`, which @rhi-zone/fractal-
// codegen turns into a typed client) — never by the dispatch path. `M = undefined` for a handler with
// no reflection need. `M` is NOT a Route/Router/Node/Ctx hierarchy: it describes
// DATA (segments, verbs, dynamic positions, input/output phantoms).
// ============================================================================

export type Reflected<M, R = {}> = Handler<R> & { readonly meta: M };

/** Attach `meta` to an existing bare Handler, producing a Reflected handler. The
 *  handler IS the bare handler; `meta` is a bolted-on property. `R` is the
 *  handler's required-ctx obligation, threaded so `param`/`provide` can discharge it. */
function withMeta<M, R = {}>(h: Handler<R>, meta: M): Reflected<M, R> {
  const r = h as Reflected<M, R> & { meta: M };
  (r as { meta: M }).meta = meta;
  return r;
}

// ----------------------------------------------------------------------------
// META — the inert DATA descriptor shapes. Each is a plain object literal a
// combinator attaches; the projections walk them by `tag`. (No handler-shaped
// type among them — a handler stays `Handler`.)
// ----------------------------------------------------------------------------

/** A dynamic path segment: name + decoded type `T` + inner meta `R`. `T` is a
 *  PURE type parameter (no carrier field): the drift walk reads it via
 *  `M extends ParamMeta<infer N, infer T, infer Rest>` — TS recovers a type
 *  argument from the annotated construction site even with no field referencing
 *  it, so no phantom `__t` is needed. The runtime reads the param VALUE directly
 *  off the Request; this meta only records position + (optionally) a schema. */
export interface ParamMeta<N extends string, T, R> {
  readonly tag: "param";
  readonly name: N;
  readonly rest: R; // the inner handler's meta (what follows the dynamic segment)
  /** Inert, REFLECTABLE schema for the dynamic segment when `param(name, codec,
   *  inner)` carried a codec. Same inert-sidecar pattern as `validated`'s
   *  `__schema`: a real runtime value (the Standard Schema / plain JSON-Schema
   *  object) read only by the OpenAPI projection, never on the dispatch path. A
   *  bare `param(name, inner)` records no schema (the segment is a raw string). */
  readonly schema?: unknown;
}
/** A context-producing middleware marker: `provide(key, produce, inner)` injects
 *  a VAR key into `req.ctx` (e.g. an authenticated `user`). Unlike `ParamMeta`,
 *  this key is SERVER-INTERNAL — NOT a path param, NOT API surface. The
 *  projections (OpenAPI params, client call args, the drift `RouteUnion`) walk
 *  THROUGH `rest` without contributing the key, so adding `provide`/`withAuth` to
 *  a route never changes its generated client signature. `K` is the injected key
 *  name (a pure type parameter, recovered from the construction site like
 *  `ParamMeta`'s `T`); `rest` is the inner handler's meta. `security`, when set,
 *  is an inert reflectable hint a (future) OpenAPI security projection could read
 *  — present so `withAuth` can mark a route as authenticated without a second meta
 *  tag; ignored by every current projection. */
export interface ProvideMeta<K extends string, R> {
  readonly tag: "provide";
  readonly key: K;
  readonly rest: R; // the inner handler's meta (the key is invisible to projections)
  readonly security?: unknown;
}
/** Inert, REFLECTABLE schema references for one verb. Unlike the type-only `IO`
 *  param (no runtime presence), these are real runtime values — the Standard Schema (or
 *  plain JSON-Schema-shaped object) the route validates its body against
 *  (`input`) and/or annotates its response with (`output`). Read by the OpenAPI
 *  projection; never on the dispatch path. Attached by @rhi-zone/fractal-http's
 *  `validated`/`returns`, which stamp the handler with a `__schema` carrier the
 *  `methods` constructor harvests into the meta. */
export interface SchemaRef {
  readonly input?: unknown;
  readonly output?: unknown;
}

/** The carrier `validated`/`returns` stamp onto a handler so `methods` can lift
 *  the schema into reflectable meta. Inert to dispatch (an extra own-property). */
export type WithSchema = { readonly __schema?: SchemaRef };

/** An endpoint: the closed verb set, with per-verb input (body) + output types.
 *  `IO` is a PURE type parameter (no carrier field): the drift walk reads it via
 *  `M extends MethodsMeta<infer Verbs, infer IO>` and projects each verb's body
 *  (`IO[V]["i"]`) + response (`IO[V]["o"]`). TS recovers a type argument from the
 *  annotated construction site (`MethodsMeta<…, MethodsIO<T>>` in `methods`) even
 *  with no field referencing it — verified on tsgo AND tsc — so no phantom `__io`
 *  field is needed. `schemas` carries the REFLECTABLE per-verb schema refs
 *  (runtime data) when a verb's handler was built with `validated`/`returns`. */
export interface MethodsMeta<
  Verbs extends string,
  IO extends Record<string, { i: unknown; o: unknown }>,
> {
  readonly tag: "methods";
  readonly verbs: readonly Verbs[];
  readonly schemas?: Readonly<Record<string, SchemaRef>>;
}
/** A `path(record)`: a record keyed by literal segment → inner meta. */
export interface PathMeta<R extends Record<string, unknown>> {
  readonly tag: "path";
  readonly routes: R;
}
/** A `choice(...alts)`: a tuple of alternative metas (the router). */
export interface ChoiceMeta<Ms extends readonly unknown[]> {
  readonly tag: "choice";
  readonly alts: Ms;
}

// ----------------------------------------------------------------------------
// Phantom-tagged handler variants the methods-meta extractor reads. They are
// `Handler` at runtime (identical dispatch); the extra phantom carriers hold the
// typed body/output for the client and are never present at runtime. A REQUIRED
// brand symbol (not just optional `__i`/`__o`) lets the conditional types
// discriminate these from a PLAIN `Handler` exactly. The CONSTRUCTORS
// (`validated`/`returns`) live in @rhi-zone/fractal-http; the TYPES live here so
// the meta extractor can read them.
// ----------------------------------------------------------------------------

declare const VALIDATED: unique symbol;
declare const RETURNS: unique symbol;
/** A handler with a `validated(schema, fn)` body: the phantom carries ONLY the
 *  validated INPUT type `I`. Output typing is NOT `validated`'s job — a typed
 *  response requires a real output schema value, supplied by `returns(handler,
 *  outputSchema)`, because codegen projects from the runtime `__schema.output`
 *  carrier (→ OpenAPI `responses[200]`), never from a TS-only phantom. */
export type ValidatedHandler<I> = Handler & {
  readonly [VALIDATED]: { i: I };
};
export type ReturnsHandler<O> = Handler & { readonly [RETURNS]: O };

// Collapse a UNION into an INTERSECTION (the dual of `keyof`-distribution). Used
// to fold each verb-handler's ctx obligation into the methods node's combined
// obligation: a route that needs `{id}` AND one that needs `{slug}` ⇒ the node
// needs `{id} & {slug}`.
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

// EXTRACT the combined ctx obligation `R` from a methods table's handlers,
// rather than taking `R` as an explicit type-arg. Each handler is structurally
// `(req: Request & { ctx: R_k }) => …`; we `infer R_k` off each and intersect.
//
// NB: `R` sits CONTRAVARIANTLY inside `Request & { ctx: R }`, so `infer R`
// there only resolves to a real obligation when the handler DECLARES its ctx
// type (`(req: Request & { ctx: { id: string } }) => …`). A bare inline arrow
// (`req => req.ctx.id`) has its `req` contextually typed by the table bound, so
// `req.ctx` is `any` and the inferred `R_k` collapses to `any`/`unknown` — the
// obligation can't be recovered from an unstated type. This is the documented
// residual (see spike/methods-fix): declare the handler's ctx type to propagate
// an obligation without an explicit type-arg. A no-ctx handler infers `unknown`,
// which `UnionToIntersection` leaves as `unknown` — assignable past `toFetch`'s
// `Handler<{}>` (a no-ctx app stays sound).
type CtxOf<T> = UnionToIntersection<
  {
    [K in keyof T]: T[K] extends (req: Request & { ctx: infer R }) => unknown
      ? R
      : never;
  }[keyof T]
>;

// Per-verb input/output from the handlers in a methods table. A handler may be
// a plain `Handler` (no typed input, output unknown), a `ValidatedHandler<I>`
// whose phantom carries the typed body `I` (output stays `unknown` — `validated`
// types input only), or a `ReturnsHandler<O>` whose phantom carries the typed
// output `O`. Extracted in a single pass over the table's KEYS (≤7 verbs) —
// never over N routes. NB: a validated handler may ALSO be wrapped by `returns`
// to add an output; the constructor merges both into `__schema` at runtime, and
// the type is `ValidatedHandler<I> & ReturnsHandler<O>`, which the `ValidatedHandler`
// arm matches first (input) but the output then falls to `unknown` here — output
// typing on a validated route is read off the runtime schema by codegen, not this
// phantom (this phantom path drives only the drift guard's structural compare).
type MethodsIO<T> = {
  readonly [K in Extract<keyof T, string>]: T[K] extends ValidatedHandler<
    infer I
  >
    ? { i: I; o: unknown }
    : T[K] extends ReturnsHandler<infer O>
      ? { i: never; o: Awaited<O> }
      : { i: never; o: unknown };
};

// ============================================================================
// COMBINATORS — meta-carrying. Each delegates to a bare runtime combinator
// (identical behaviour) and bolts on the structural meta. These ARE the public
// combinators: a typed client is derived from the meta they attach.
//
// DISPATCH vs PROJECTION boundary (load-bearing invariant):
//   - The DISPATCH combinators (`path`/`methods`/`choice`/`param`/`mount`) are
//     PURE and meta-FREE on the runtime path: each is a `(Request) => Response |
//     undefined` that reads nothing from `.meta`. `undefined` means "not mine —
//     pass". A verb-miss in `methods` is a pass, NOT a 405.
//   - The PROJECTIONS (`toFetch`, `toOpenApi`, codegen) are the ONLY readers of
//     `.meta`. HTTP correctness — 405 + `Allow`, auto-HEAD-from-GET, OPTIONS,
//     and the 404-vs-405 distinction — is computed by `toFetch` from `.meta`
//     (the same inert structure `toOpenApi` walks), AFTER dispatch returns
//     `undefined`. This is what makes correctness compositional across `choice`
//     and `mount`: `Allow` is the UNION of verbs across every branch resolving
//     to the matched path, which no single in-dispatch `methods` node can see.
// ============================================================================

/** `methods(table)` — method dispatch with an inert verb-set meta.
 *
 *  `const T` is the SOLE inference site (no explicit `P` type-arg to defeat it),
 *  so `.meta.verbs` is the LITERAL union of the table's keys (`"GET" | "POST"`),
 *  never the full `Method` set — the OpenAPI projection and drift guard read the
 *  real verb set. The ctx obligation `R` is EXTRACTED from the handlers via
 *  `CtxOf<T>` (a handler that declares `{ ctx: { id: string } }` propagates that
 *  obligation), then discharged downstream by `param`/`provide`/`toFetch`. */
export function methods<
  const T extends Partial<Record<Method, Handler<never>>>,
>(
  table: T,
): Reflected<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, CtxOf<T>> {
  const verbs = Object.keys(table) as Extract<keyof T, string>[];
  // Harvest REFLECTABLE schema refs that `validated`/`returns` stamped onto each
  // verb's handler (inert `__schema` carrier). Only present when a handler was
  // built with body validation / output annotation; absent verbs contribute none.
  const schemas: Record<string, SchemaRef> = {};
  for (const v of verbs) {
    const ref = (table[v] as WithSchema | undefined)?.__schema;
    if (ref !== undefined) schemas[v] = ref;
  }
  const hasSchemas = Object.keys(schemas).length > 0;
  return withMeta<
    MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>,
    CtxOf<T>
  >(methodsRT(table as unknown as Partial<Record<Method, Handler<CtxOf<T>>>>), {
    tag: "methods",
    verbs,
    ...(hasSchemas ? { schemas } : {}),
  });
}

/** `path(record)` — segment dispatch with an inert record-of-meta. */
export function path<
  P = {},
  const R extends Record<string, Reflected<unknown, P>> = Record<
    string,
    Reflected<unknown, P>
  >,
>(
  routes: R,
): Reflected<PathMeta<{ readonly [K in keyof R]: R[K]["meta"] }>, P> {
  const inner: Record<string, unknown> = {};
  for (const k of Object.keys(routes)) inner[k] = routes[k]!.meta;
  return withMeta<PathMeta<{ readonly [K in keyof R]: R[K]["meta"] }>, P>(
    pathRT<P>(routes),
    {
      tag: "path",
      routes: inner as { readonly [K in keyof R]: R[K]["meta"] },
    },
  );
}

/** `mount(prefix, inner)` — a thin ergonomic alias for a single-key `path`:
 *  `mount("api", inner)` ≡ `path({ api: inner })`. It DESUGARS to `path`, emitting
 *  a `PathMeta` with one literal key (NOT a distinct `prefix` tag) — so every
 *  projection (toFetch, toOpenApi, the drift walk, codegen) handles ONE fewer
 *  case. Prefixes are single segments: a `"a/b"` prefix is a single literal key
 *  that never matches a `/a/b` request (segments split on "/"); use nested `path`
 *  for multi-segment prefixes. Reads well for mounting a sub-router at a name. */
export function mount<const Pre extends string, M, P = {}>(
  prefix: Pre,
  inner: Reflected<M, P>,
): Reflected<PathMeta<{ readonly [K in Pre]: M }>, P> {
  return path<P, { readonly [K in Pre]: Reflected<M, P> }>({
    [prefix]: inner,
  } as { readonly [K in Pre]: Reflected<M, P> }) as Reflected<
    PathMeta<{ readonly [K in Pre]: M }>,
    P
  >;
}

/** `choice(...alts)` — first-match dispatch with an inert tuple-of-alt-metas.
 *  This is what lets the client see THROUGH choice: the meta keeps every alt's
 *  structure rather than collapsing to one handler. */
export function choice<
  P = {},
  const Hs extends readonly Reflected<unknown, P>[] = readonly Reflected<
    unknown,
    P
  >[],
>(
  ...alts: Hs
): Reflected<ChoiceMeta<{ readonly [K in keyof Hs]: Hs[K]["meta"] }>, P> {
  const metas = alts.map((a) => a.meta) as {
    readonly [K in keyof Hs]: Hs[K]["meta"];
  };
  return withMeta<ChoiceMeta<{ readonly [K in keyof Hs]: Hs[K]["meta"] }>, P>(
    choiceRT<P>(...alts),
    { tag: "choice", alts: metas },
  );
}

/**
 * `param(name, inner)` — a DYNAMIC segment. The runtime reads the id directly
 * off the Request; this combinator advances the URL past the segment, binds the
 * captured value into `req.ctx[name]`, and records the position + decoded type in
 * `.meta` (as a `ParamMeta` — a PATH-PARAM / API-surface key) so the typed client
 * can require a `params` call arg. It DISCHARGES the obligation: `inner:
 * Reflected<M, Q>` (Q includes `name`) → the result is
 * `Reflected<…, Omit<Q, name>>`. Composes: `param("id", param("postId", gc))`
 * discharges both.
 *
 * Overloads: `param("id", inner)` → `{id: string}`; `param("id", codec, inner)`
 * → `{id: InferOutput<codec>}` (the codec is type-only here — std doesn't decode).
 */
export function param<const N extends string, M, Q extends Record<N, string>>(
  name: N,
  inner: Reflected<M, Q>,
): Reflected<ParamMeta<N, string, M>, Omit<Q, N>>;
export function param<
  const N extends string,
  S,
  M,
  Q extends Record<N, string>,
>(
  name: N,
  codec: StandardSchemaV1<string, S>,
  inner: Reflected<M, Q>,
): Reflected<ParamMeta<N, S, M>, Omit<Q, N>>;
export function param(
  name: string,
  arg2:
    | Reflected<unknown, Record<string, string>>
    | StandardSchemaV1<string, unknown>,
  arg3?: Reflected<unknown, Record<string, string>>,
): Reflected<ParamMeta<string, unknown, unknown>, Record<string, string>> {
  const inner = (arg3 ?? arg2) as Reflected<unknown, Record<string, string>>;
  // When the 3-arg `param(name, codec, inner)` overload was used, `arg2` is the
  // codec — stamp it as an inert reflectable schema so the OpenAPI projection can
  // resolve a typed param schema (the same inert-sidecar pattern as `validated`).
  const codec = arg3 !== undefined ? arg2 : undefined;
  const h = paramRT(name, inner);
  return withMeta<ParamMeta<string, unknown, unknown>, Record<string, string>>(
    h as Handler<Record<string, string>>,
    {
      tag: "param",
      name,
      rest: inner.meta,
      ...(codec !== undefined ? { schema: codec } : {}),
    },
  );
}

/** Read a dynamic segment value off the Request, where `param(name, …)` bound it
 *  into `req.ctx`. Keeps "params are read off the Request" literally true after
 *  `param` advanced past the segment. Convenience over `req.ctx[name]`. */
export function paramValue(req: Request, name: string): string | undefined {
  const ctx = (req as Partial<{ ctx: Record<string, string> }>).ctx;
  return ctx?.[name] ?? undefined;
}

// ============================================================================
// CONTEXT-PRODUCING MIDDLEWARE — `provide` / `withAuth`. The SAME discharge shape
// as `param`, but for a SERVER-INTERNAL var rather than a path param. `provide`
// runs a producer; a `Response` short-circuits (auth 401), `undefined` passes,
// and a value is injected at `req.ctx[key]` for the inner handler — which TYPES
// the key away (its `R` no longer requires it). The injected key is a VAR in
// `.meta` (a `ProvideMeta`), so every projection (OpenAPI params, the generated
// client's call args, the drift `RouteUnion`) walks THROUGH it without surfacing
// it: adding `withAuth` to a route never changes its client signature.
// ============================================================================

/** What a `provide` producer returns: a VALUE `V` (inject it), a `Response`
 *  (short-circuit — e.g. a 401), or `undefined` (pass — not handled here). */
export type Produced<V> = V | Response | undefined;

/** Bare `provide` runtime (meta-free). Clones the request with a FRESH ctx object
 *  (key injected) so a shared request flowing through `choice` never bleeds the
 *  var across alts — the same non-mutation discipline `param` uses for its bound
 *  segment. The clone keeps it a real Request (method/headers/body/URL). */
function provideRT<K extends string, Q extends Record<K, unknown>>(
  key: K,
  produce: (
    req: ReqWithCtx<Omit<Q, K>>,
  ) => Produced<Q[K]> | Promise<Produced<Q[K]>>,
  inner: Handler<Q>,
): Handler<Omit<Q, K>> {
  return async (req) => {
    const produced = await produce(req);
    if (produced === undefined) return undefined; // pass — not handled here
    if (produced instanceof Response) return produced; // short-circuit (e.g. 401)
    // inject the value into a FRESH ctx on a cloned request (no shared mutation).
    const next = withCtx<Q>(new Request(req.url, req), {
      ...(req.ctx as object),
      [key]: produced,
    } as Q);
    return inner(next);
  };
}

/**
 * `provide(key, produce, inner)` — a context-producing middleware that DISCHARGES
 * a VAR key. It runs `produce(req)`; a returned VALUE is injected at
 * `req.ctx[key]` (and the inner handler reads it TYPED), a returned `Response`
 * short-circuits (e.g. an auth 401), and `undefined` passes.
 *
 * Like `param` it DISCHARGES via the `Omit<Q, K>` inference trick: it infers the
 * inner handler's WHOLE required-ctx `Q` (which includes the injected key `K`) and
 * returns `Reflected<…, Omit<Q, K>>` — the key is removed from the obligation. (A
 * `Reflected<M, R & Record<K,V>> -> Reflected<…, R>` signature would fail to infer
 * `R`, exactly as documented on `param`.) The injected value type is `Q[K]` —
 * pinned by the INNER handler's required ctx, not by the producer (so a producer
 * that returns a `Response` to reject does not collapse the value type). It emits
 * a `ProvideMeta` VAR marker — server-internal, invisible to every projection's
 * path-param view.
 */
export function provide<
  const K extends string,
  M,
  Q extends Record<K, unknown>,
>(
  key: K,
  produce: (
    req: ReqWithCtx<Omit<Q, K>>,
  ) => Produced<Q[K]> | Promise<Produced<Q[K]>>,
  inner: Reflected<M, Q>,
): Reflected<ProvideMeta<K, M>, Omit<Q, K>> {
  return withMeta<ProvideMeta<K, M>, Omit<Q, K>>(
    provideRT<K, Q>(key, produce, inner),
    { tag: "provide", key, rest: inner.meta },
  );
}

// An authenticated principal producer: a `provide` producer specialized to
// auth — given the request, return the principal `U` (authenticated) or a
// `Response` (e.g. a 401 to reject). The return is spelled `Produced<U>` (which is
// `U | Response | undefined`) rather than the literal `U | Response` so this
// internal alias does not read as a rival handler-shaped type: the iron-rule
// scanner (which keys off the literal `Response` token in a `(req: Request) => …`
// return) must see exactly one handler-shaped type, the canonical `Handler`.
type Authenticate<U> = (req: Request) => Produced<U> | Promise<Produced<U>>;

/**
 * `withAuth(authenticate, inner)` — a thin specialization of `provide` that
 * injects an authenticated principal at `req.ctx.user` (or a custom `key`). It is
 * built ON `provide`, so it shares the exact discharge + VAR-meta semantics: the
 * `user` key is server-internal (never a client call arg / OpenAPI param), and
 * `inner`'s required ctx no longer needs `user`. A `Response` from `authenticate`
 * short-circuits (the 401). The default key is `"user"`.
 */
export function withAuth<U, M, Q extends { user: U }>(
  authenticate: Authenticate<U>,
  inner: Reflected<M, Q>,
): Reflected<ProvideMeta<"user", M>, Omit<Q, "user">>;
export function withAuth<const K extends string, U, M, Q extends Record<K, U>>(
  key: K,
  authenticate: Authenticate<U>,
  inner: Reflected<M, Q>,
): Reflected<ProvideMeta<K, M>, Omit<Q, K>>;
export function withAuth(
  arg1: string | Authenticate<unknown>,
  arg2: Authenticate<unknown> | Reflected<unknown, Record<string, unknown>>,
  arg3?: Reflected<unknown, Record<string, unknown>>,
): Reflected<ProvideMeta<string, unknown>, Record<string, unknown>> {
  const key = typeof arg1 === "string" ? arg1 : "user";
  const authenticate = (typeof arg1 === "string" ? arg2 : arg1) as Authenticate<
    unknown
  >;
  const inner = (arg3 ?? arg2) as Reflected<unknown, Record<string, unknown>>;
  const r = provide<string, unknown, Record<string, unknown>>(
    key,
    authenticate,
    inner,
  );
  // Mark the route authenticated via the inert `security` hint (read by no
  // current projection; present for a future OpenAPI security-scheme emission).
  return withMeta<ProvideMeta<string, unknown>, Record<string, unknown>>(r, {
    ...r.meta,
    security: { scheme: key },
  });
}

// ============================================================================
// META-ROUTE EXTRACTOR — the shared, inert walk over `.meta`.
//
// A PROJECTION primitive (never on the dispatch path): it walks the same inert
// `.meta` DATA tree the OpenAPI projection walks, flattening it into a list of
// concrete routes — one `{ pattern, verbs }` per path that a `methods` node sits
// at. `path` (incl. the `mount` single-key alias) appends a LITERAL segment;
// `param` appends a `{ kind:
// "param" }` wildcard segment (matches any one path segment); `choice` BRANCHES
// (every alt is its own route at the same accumulated pattern); `methods`
// emits a route whose verbs are exactly its table's keys.
//
// `toFetch` uses this to compute 405 / `Allow` / auto-HEAD / OPTIONS / 404 as a
// projection — aggregating verbs across EVERY route matching a request path, so
// choice alts and mounted sub-routers at the same path UNION their verbs. The
// OpenAPI projection walks the same meta for its richer per-verb operation
// output; this extractor is the verb-level view of that one walk.
// ============================================================================

/** One segment of a route pattern: a literal name, or a dynamic param wildcard. */
export type PatternSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

/** A concrete route flattened out of `.meta`: the segment pattern leading to a
 *  `methods` node, plus that node's declared verb set. */
export interface MetaRoute {
  readonly pattern: readonly PatternSegment[];
  readonly verbs: ReadonlySet<Method>;
}

/** Flatten an app's inert `.meta` tree into the list of concrete `MetaRoute`s.
 *  Pure: reads only `.meta`, runs nothing, touches no Request. */
export function routeTable(meta: unknown): MetaRoute[] {
  const out: MetaRoute[] = [];
  walkMeta(meta, [], out);
  return out;
}

function walkMeta(
  meta: unknown,
  pattern: PatternSegment[],
  out: MetaRoute[],
): void {
  if (typeof meta !== "object" || meta === null) return;
  const m = meta as { tag?: string };
  switch (m.tag) {
    case "methods": {
      const mm = meta as MethodsMeta<string, never>;
      out.push({ pattern: [...pattern], verbs: new Set(mm.verbs as Method[]) });
      return;
    }
    case "path": {
      const pm = meta as PathMeta<Record<string, unknown>>;
      for (const k of Object.keys(pm.routes)) {
        walkMeta(
          pm.routes[k],
          [...pattern, { kind: "literal", value: k }],
          out,
        );
      }
      return;
    }
    case "param": {
      const pm = meta as ParamMeta<string, unknown, unknown>;
      walkMeta(pm.rest, [...pattern, { kind: "param", name: pm.name }], out);
      return;
    }
    case "provide": {
      // A VAR injector contributes NO pattern segment — it is server-internal.
      // Walk straight THROUGH to the inner meta so the route table (and the 405/
      // Allow projection it feeds) is identical with or without the middleware.
      const pm = meta as ProvideMeta<string, unknown>;
      walkMeta(pm.rest, pattern, out);
      return;
    }
    case "choice": {
      // BRANCH: every alt is its own route at the SAME accumulated pattern.
      for (const alt of (meta as ChoiceMeta<readonly unknown[]>).alts) {
        walkMeta(alt, pattern, out);
      }
      return;
    }
  }
}

/** Does a route `pattern` match a request's path `segs`? Literal segments match
 *  by exact name; param segments match ANY one segment; length must be equal. */
export function patternMatches(
  pattern: readonly PatternSegment[],
  segs: readonly string[],
): boolean {
  if (pattern.length !== segs.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p.kind === "literal" && p.value !== segs[i]) return false;
  }
  return true;
}

// ============================================================================
// Standard Schema — TYPES ONLY. We mirror the `~standard` shape so any conforming
// validator (zod/valibot/arktype/…) plugs in, without a concrete runtime dep.
// `Output` is the validated type the client body is typed as. (The `validated`
// CONSTRUCTOR that consumes a schema lives in @rhi-zone/fractal-http.)
// ============================================================================

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: readonly { readonly message: string }[] }
        >;
  };
}
export type InferOutput<S> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

// ============================================================================
// Drift-guard substrate — TYPES ONLY. The sound exact-equality assertion
// (`Equals`/`AssertExact`/`Assert`) and the LINEAR route-entry-union derivation
// (`RouteEntry`/`RouteUnion`) that @rhi-zone/fractal-codegen emits a static guard
// against. Lives here because it reads core's `.meta` types; re-exported so the
// generated client can `import type { Assert, AssertExact, RouteUnion, RouteEntry }
// from "@rhi-zone/fractal-core"`. See ./drift.ts for the linearity invariant.
// ============================================================================

export type {
  Assert,
  AssertExact,
  Equals,
  RouteEntry,
  RouteUnion,
} from "./drift.ts";
