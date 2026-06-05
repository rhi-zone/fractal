// packages/core/src/index.ts — @rhi-zone/fractal-core
//
// The routing ALGEBRA. The ONLY framework type is the handler, and it is
// literally the web standard:
//
//   Handler<P> = (req: Request & { params: P }) =>
//                  Response | undefined | Promise<Response | undefined>
//
// `Request`/`Response` are the ambient WHATWG globals (no runtime dep — this
// package imports no Bun and no Node). `undefined` means "not mine — pass to the
// next handler". Combinators are PLAIN FUNCTIONS returning a Handler. "How much
// path is consumed" lives in the Request's own URL: descending rewrites the URL
// (advances past consumed segments), so there is no ctx object, no Router type,
// no side channel.
//
// There is NO Route / Segment / Router / Node / Ctx / RoutingCtx type. `.meta`
// is an INERT reflection sidecar bolted onto the handler function, read only by
// the type-level client / OpenAPI projections and the runtime client walker —
// NEVER on the dispatch path.

// ============================================================================
// Handler — the one framework type
// ============================================================================

// `Handler<P>` is parameterized by its captured path params. The params ride as
// a TYPED FIELD on the standard `Request` (itty-router-style runtime, typed).
// `P` defaults to `{}` so a paramless handler is just `Handler`. Because
// `Request & { params: P }` is a SUBtype of `Request`, a plain
// `(req: Request) => Response` is contravariantly assignable to `Handler` AND to
// any `Handler<P>` — a plain web handler IS a Handler.
export type Handler<P = {}> = (
  req: Request & { params: P },
) => Response | undefined | Promise<Response | undefined>;

/** The runtime carrier: a real `Request` with a `params` own-property. */
export type ReqWithParams<P> = Request & { params: P };

/** Attach (or re-attach) a `params` own-property to a Request, in place. Returns
 *  the SAME Request, retyped — it stays a real Request (json()/headers/method). */
export function withParams<P>(req: Request, params: P): ReqWithParams<P> {
  (req as ReqWithParams<P>).params = params;
  return req as ReqWithParams<P>;
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
 *  `new Request(url, req)` drops custom own-properties, so we re-attach `params`
 *  (carried from the source Request, defaulting to `{}`) to keep it a typed Req. */
function withSegments<P>(req: Request, segs: string[]): ReqWithParams<P> {
  const url = new URL(req.url);
  url.pathname = "/" + segs.join("/");
  const params = (req as Partial<ReqWithParams<P>>).params ?? ({} as P);
  return withParams(new Request(url, req), params);
}

/**
 * The URL-advancing primitive, exposed for dynamic segments. A handler that
 * reads a dynamic value (e.g. an id via `segments(req)[0]`) calls `rest(req)`
 * to get a Request advanced past that one segment, then delegates the remaining
 * path to an inner handler. This is NOT a param/capture combinator: it carries
 * no value, takes no pattern, and reads nothing — it only advances the URL,
 * while the id is still read directly off the Request.
 */
export function rest<P>(req: ReqWithParams<P>): ReqWithParams<P> {
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
function pathRT<P = {}>(routes: Record<string, Handler<P>>): Handler<P> {
  return (req) => {
    const segs = segments(req);
    const head = segs[0];
    if (head === undefined) return undefined;
    const next = routes[head];
    if (next === undefined) return undefined;
    return next(withSegments<P>(req, segs.slice(1)));
  };
}

/**
 * Consume a literal prefix segment, then delegate to `inner`. Convenience over
 * `path` for a single fixed prefix. Same URL-advancing mechanism.
 */
function mountRT<P = {}>(prefix: string, inner: Handler<P>): Handler<P> {
  return pathRT<P>({ [prefix]: inner });
}

/**
 * Capture a dynamic path segment as a TYPED param and DISCHARGE it. `param(name,
 * child)` reads the first remaining segment, binds it into `req.params[name]`,
 * advances the URL past it, and delegates to `child`. The child is parameterized
 * by `Q` (its full captured-param object, which must include `name`); the result
 * is `Handler<Omit<Q, name>>` — the captured key is removed from the obligation.
 *
 * The signature infers the child's WHOLE param object `Q` and removes `K` via
 * `Omit` (rather than `Handler<P & Record<K,string>> -> Handler<P>`, which fails
 * inference: TS cannot split a `P & Record<K,string>` intersection back into `P`,
 * so it binds `P` to the whole thing and discharges nothing). `Omit` is the
 * minimal fix and composes: `param("id", param("postId", gc))` discharges both.
 */
function paramRT<K extends string, Q extends Record<K, string>>(
  name: K,
  child: Handler<Q>,
): Handler<Omit<Q, K>> {
  return (req) => {
    const value = segments(req)[0];
    if (value === undefined) return undefined;
    // bind the captured value into params, then advance the URL past the segment.
    const bound = { ...(req.params as object), [name]: value } as Q;
    const advanced = withSegments<Q>(req, segments(req).slice(1));
    advanced.params = bound;
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
function methodsRT<P = {}>(
  table: Partial<Record<Method, Handler<P>>>,
): Handler<P> {
  return (req) => {
    if (segments(req).length > 0) return undefined; // path not fully consumed
    const direct = table[req.method as Method];
    if (direct !== undefined) return direct(req);
    return undefined; // verb-miss -> PASS (a sibling choice alt may handle it)
  };
}

/** Try each handler in order; first non-undefined wins; else undefined. */
function choiceRT<P = {}>(...handlers: Handler<P>[]): Handler<P> {
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

export type Reflected<M, P = {}> = Handler<P> & { readonly meta: M };

/** Attach `meta` to an existing bare Handler, producing a Reflected handler. The
 *  handler IS the bare handler; `meta` is a bolted-on property. `P` is the
 *  handler's captured-param obligation, threaded so `param` can discharge it. */
function withMeta<M, P = {}>(h: Handler<P>, meta: M): Reflected<M, P> {
  const r = h as Reflected<M, P> & { meta: M };
  (r as { meta: M }).meta = meta;
  return r;
}

// ----------------------------------------------------------------------------
// META — the inert DATA descriptor shapes. Each is a plain object literal a
// combinator attaches; the projections walk them by `tag`. (No handler-shaped
// type among them — a handler stays `Handler`.)
// ----------------------------------------------------------------------------

/** A dynamic path segment: name + decoded type T (phantom). The runtime reads
 *  the value directly off the Request; this only records position + type. */
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
  readonly __t?: T; // phantom decoded param type
}
/** Inert, REFLECTABLE schema references for one verb. Unlike the phantom `__io`
 *  (erased at runtime), these are real runtime values — the Standard Schema (or
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

/** An endpoint: the closed verb set, with per-verb input (body) + output phantoms.
 *  `schemas` carries the REFLECTABLE per-verb schema refs (runtime data) when a
 *  verb's handler was built with `validated`/`returns`. */
export interface MethodsMeta<
  Verbs extends string,
  IO extends Record<string, { i: unknown; o: unknown }>,
> {
  readonly tag: "methods";
  readonly verbs: readonly Verbs[];
  readonly schemas?: Readonly<Record<string, SchemaRef>>;
  readonly __io?: IO; // phantom per-verb { input, output }
}
/** A `path(record)`: a record keyed by literal segment → inner meta. */
export interface PathMeta<R extends Record<string, unknown>> {
  readonly tag: "path";
  readonly routes: R;
}
/** A `mount(prefix, inner)`: a single literal prefix + inner meta. */
export interface PrefixMeta<P extends string, R> {
  readonly tag: "prefix";
  readonly pre: P;
  readonly rest: R;
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
export type ValidatedHandler<I, O> = Handler & {
  readonly [VALIDATED]: { i: I; o: O };
};
export type ReturnsHandler<O> = Handler & { readonly [RETURNS]: O };

// Collapse a UNION into an INTERSECTION (the dual of `keyof`-distribution). Used
// to fold each verb-handler's param obligation into the methods node's combined
// obligation: a route that needs `{id}` AND one that needs `{slug}` ⇒ the node
// needs `{id} & {slug}`.
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

// EXTRACT the combined param obligation `P` from a methods table's handlers,
// rather than taking `P` as an explicit type-arg. Each handler is structurally
// `(req: Request & { params: P_k }) => …`; we `infer P_k` off each and intersect.
//
// NB: `P` sits CONTRAVARIANTLY inside `Request & { params: P }`, so `infer P`
// there only resolves to a real obligation when the handler DECLARES its param
// type (`(req: Request & { params: { id: string } }) => …`). A bare inline arrow
// (`req => req.params.id`) has its `req` contextually typed by the table bound, so
// `req.params` is `any` and the inferred `P_k` collapses to `any`/`unknown` — the
// obligation can't be recovered from an unstated type. This is the documented
// residual (see spike/methods-fix): declare the handler's param type to propagate
// an obligation without an explicit type-arg. A no-param handler infers `unknown`,
// which `UnionToIntersection` leaves as `unknown` — assignable past `toFetch`'s
// `Handler<{}>` (a no-param app stays sound).
type ParamsOf<T> = UnionToIntersection<
  {
    [K in keyof T]: T[K] extends (req: Request & { params: infer P }) => unknown
      ? P
      : never;
  }[keyof T]
>;

// Per-verb input/output from the handlers in a methods table. A handler may be
// a plain `Handler` (output unknown) or a `Validated<I,O>`-tagged handler whose
// phantom carries the typed body I and output O. Extracted in a single pass over
// the table's KEYS (≤7 verbs) — never over N routes.
type MethodsIO<T> = {
  readonly [K in Extract<keyof T, string>]: T[K] extends ValidatedHandler<
    infer I,
    infer O
  >
    ? { i: I; o: O }
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
 *  real verb set. The param obligation `P` is EXTRACTED from the handlers via
 *  `ParamsOf<T>` (a handler that declares `{ params: { id: string } }` propagates
 *  that obligation), then discharged downstream by `param`/`toFetch`. */
export function methods<
  const T extends Partial<Record<Method, Handler<never>>>,
>(
  table: T,
): Reflected<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, ParamsOf<T>> {
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
    ParamsOf<T>
  >(methodsRT(table as unknown as Partial<Record<Method, Handler<ParamsOf<T>>>>), {
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

/** `mount(prefix, inner)` — consume a literal prefix with an inert prefix meta. */
export function mount<const Pre extends string, M, P = {}>(
  prefix: Pre,
  inner: Reflected<M, P>,
): Reflected<PrefixMeta<Pre, M>, P> {
  return withMeta<PrefixMeta<Pre, M>, P>(mountRT<P>(prefix, inner), {
    tag: "prefix",
    pre: prefix,
    rest: inner.meta,
  });
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
 * captured value into `req.params[name]`, and records the position + decoded
 * type in `.meta` so the typed client can require a `params` arg. It DISCHARGES
 * the obligation: `inner: Reflected<M, Q>` (Q includes `name`) → the result is
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
 *  into `req.params`. Keeps "params are read off the Request" literally true
 *  after `param` advanced past the segment. Convenience over `req.params[name]`. */
export function paramValue(req: Request, name: string): string | undefined {
  const params = (req as Partial<{ params: Record<string, string> }>).params;
  return params?.[name] ?? undefined;
}

// ============================================================================
// META-ROUTE EXTRACTOR — the shared, inert walk over `.meta`.
//
// A PROJECTION primitive (never on the dispatch path): it walks the same inert
// `.meta` DATA tree the OpenAPI projection walks, flattening it into a list of
// concrete routes — one `{ pattern, verbs }` per path that a `methods` node sits
// at. `path`/`prefix` append a LITERAL segment; `param` appends a `{ kind:
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
    case "prefix": {
      const pm = meta as PrefixMeta<string, unknown>;
      walkMeta(pm.rest, [...pattern, { kind: "literal", value: pm.pre }], out);
      return;
    }
    case "param": {
      const pm = meta as ParamMeta<string, unknown, unknown>;
      walkMeta(pm.rest, [...pattern, { kind: "param", name: pm.name }], out);
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
