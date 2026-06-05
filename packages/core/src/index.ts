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
 * Method dispatch. Only fires when the path is FULLY consumed.
 *   - segment remaining          -> undefined (not mine)
 *   - consumed + method in table -> call it
 *   - consumed + method missing  -> 405 with `Allow` header
 *   - HEAD with GET present      -> run GET, return its response with null body
 *   - OPTIONS (if not in table)  -> 204 + Allow
 */
function methodsRT<P = {}>(
  table: Partial<Record<Method, Handler<P>>>,
): Handler<P> {
  const verbs = Object.keys(table) as Method[];
  const allow = verbs.join(", ");
  return async (req) => {
    if (segments(req).length > 0) return undefined; // path not fully consumed
    const method = req.method as Method;

    const direct = table[method];
    if (direct !== undefined) return direct(req);

    if (method === "HEAD" && table.GET !== undefined) {
      const res = await table.GET(req);
      if (res === undefined) return undefined;
      return new Response(null, res);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: allow } });
    }

    return new Response(`Method Not Allowed`, {
      status: 405,
      headers: { Allow: allow },
    });
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
// property, read only by type-level projections (Client<App>) and the runtime
// client walker — never by the dispatch path. `M = undefined` for a handler with
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
// ============================================================================

/** `methods(table)` — method dispatch with an inert verb-set meta. */
export function methods<
  P = {},
  const T extends Partial<Record<Method, Handler<P>>> = Partial<
    Record<Method, Handler<P>>
  >,
>(
  table: T,
): Reflected<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, P> {
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
  return withMeta<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, P>(
    methodsRT<P>(table),
    { tag: "methods", verbs, ...(hasSchemas ? { schemas } : {}) },
  );
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
  const h = paramRT(name, inner);
  return withMeta<ParamMeta<string, unknown, unknown>, Record<string, string>>(
    h as Handler<Record<string, string>>,
    { tag: "param", name, rest: inner.meta },
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
