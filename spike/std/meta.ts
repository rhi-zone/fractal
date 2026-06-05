// spike/std/meta.ts — the inert `.meta` descriptor for the std model, plus
// the meta-carrying variants of the combinators. ADDITIVE: it re-exports the
// runtime from std.ts unchanged and only BOLTS an inert `.meta` onto the
// handlers it returns. Runtime behaviour is byte-identical to std.ts — every
// combinator here delegates to the std.ts implementation and only attaches a
// data property the runtime never reads.
//
// The ONLY framework type is still `Handler`. The meta types below describe
// DATA (segments, verbs, dynamic positions, input/output phantoms). They
// parameterise an optional `.meta` slot — they are NOT a Route/Router/Node/Ctx
// runtime hierarchy. `M exists ONLY because reflection needs walkable structure.`
//
// Shapes ported from spike/iron/http.ts (EndMeta/ChoiceMeta/PrefixMeta/param/
// lit) and adapted to std's RECORD-based combinators (`path(record)` /
// `methods(record)` instead of iron's `route(method, segs, fn)`).

import {
  choice as choiceRT,
  methods as methodsRT,
  mount as mountRT,
  param as paramRT,
  path as pathRT,
  type Handler,
  type Method,
} from "./std.ts";

// ============================================================================
// A Handler that ALSO carries inert reflection data. The runtime arrow is the
// exact std `Handler`; `meta` is bolted on as a property, read only by type-
// level projections (Client<App>) and the runtime client walker — never by the
// dispatch path. `M = undefined` for a handler with no reflection need.
// ============================================================================

export type Reflected<M, P = {}> = Handler<P> & { readonly meta: M };

/** Attach `meta` to an existing std Handler, producing a Reflected handler. The
 *  handler IS the std handler; `meta` is a bolted-on property. `P` is the handler's
 *  captured-param obligation, threaded so `param` can discharge it (rule 3). */
function withMeta<M, P = {}>(h: Handler<P>, meta: M): Reflected<M, P> {
  const r = h as Reflected<M, P> & { meta: M };
  (r as { meta: M }).meta = meta;
  return r;
}

// ============================================================================
// Standard Schema — TYPES ONLY (rule 4). We do NOT depend on the concrete
// `@standard-schema/spec` package; we mirror its `~standard` shape so any
// conforming validator (zod/valibot/arktype/…) plugs in, and tests use a hand-
// rolled fixture. `Output` is the validated type the client body is typed as.
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
// META — the inert DATA descriptor shapes. Each is a plain object literal a
// combinator attaches; the projections walk them by `tag`. (No handler-shaped
// type among them — a handler stays `Handler`.)
// ============================================================================

/** A literal path segment (consumed by `path`/`mount`). */
export interface LitMeta<V extends string> {
  readonly tag: "lit";
  readonly value: V;
}
/** A dynamic path segment: name + decoded type T (phantom). std reads the value
 *  directly off the Request; this only records the position + type for the client. */
export interface ParamMeta<N extends string, T, R> {
  readonly tag: "param";
  readonly name: N;
  readonly rest: R; // the inner handler's meta (what follows the dynamic segment)
  readonly __t?: T; // phantom decoded param type
}
/** An endpoint: the closed verb set, with per-verb input (body) + output phantoms.
 *  No segments here — the path is consumed by the enclosing `path`/`mount`/`param`. */
export interface MethodsMeta<
  Verbs extends string,
  IO extends Record<string, { i: unknown; o: unknown }>,
> {
  readonly tag: "methods";
  readonly verbs: readonly Verbs[];
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

// ============================================================================
// COMBINATORS — meta-carrying. Each delegates to the std.ts runtime (identical
// behaviour) and bolts on the structural meta. Drop-in replacements for the
// bare std combinators when you want a typed client.
// ============================================================================

/** `methods(table)` with an inert verb-set meta. Runtime = std `methods`. */
export function methods<
  P = {},
  const T extends Partial<Record<Method, Handler<P>>> = Partial<
    Record<Method, Handler<P>>
  >,
>(
  table: T,
): Reflected<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, P> {
  const verbs = Object.keys(table) as Extract<keyof T, string>[];
  return withMeta<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, P>(
    methodsRT<P>(table),
    { tag: "methods", verbs },
  );
}

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

/** `path(record)` with an inert record-of-meta. Runtime = std `path`. */
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

/** `mount(prefix, inner)` with an inert prefix meta. Runtime = std `mount`. */
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

/** `choice(...alts)` with an inert tuple-of-alt-metas. Runtime = std `choice`.
 *  This is what lets the client see THROUGH choice (the iron flat-union move):
 *  the meta keeps every alt's structure rather than collapsing to one handler. */
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
 * `param(name, inner)` — a DYNAMIC segment. std reads the id directly off the
 * Request (rule 4); this combinator only advances the URL past the segment
 * (rule 5, via `rest`) and records the position + decoded type in `.meta` so the
 * typed client can require a `params` arg. It is NOT a capture/value combinator:
 * it binds no value into a ctx (there is no ctx) — the inner handler still reads
 * the value with `segments(req)[0]` if it wants it.
 *
 * Overloads: bare `param("id")` → `{id: string}`; `param("id", codec)` →
 * `{id: InferOutput<codec>}` (the codec is type-only here — std doesn't decode).
 */
export function param<
  const N extends string,
  M,
  Q extends Record<N, string>,
>(
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
  arg2: Reflected<unknown, Record<string, string>> | StandardSchemaV1<string, unknown>,
  arg3?: Reflected<unknown, Record<string, string>>,
): Reflected<ParamMeta<string, unknown, unknown>, Record<string, string>> {
  const inner = (arg3 ?? arg2) as Reflected<unknown, Record<string, string>>;
  // Runtime: delegate to std's `param`, which reads the dynamic segment off the
  // Request, BINDS it into `req.params[name]`, advances the URL past it, and
  // delegates to `inner`. The captured value is read off `req.params` (rule 4)
  // — the Request stays the only side channel (no ctx object). `paramValue` is
  // the convenience accessor over `req.params`.
  const h = paramRT(name, inner);
  return withMeta<ParamMeta<string, unknown, unknown>, Record<string, string>>(
    h as Handler<Record<string, string>>,
    { tag: "param", name, rest: inner.meta },
  );
}

// ============================================================================
// Validation — ORTHOGONAL, opt-in (rule 4). `validated(schema, fn)` wraps a
// body-consuming handler: it validates `await req.json()` against a Standard
// Schema, renders 400 on failure, and attaches the input type to `.meta` so the
// client's request body is typed. Stays a plain std `Handler`.
// ============================================================================

// Phantom-tagged handler variants the methods-meta extractor reads. They are
// `Handler` at runtime (identical dispatch); the extra phantom carriers hold the
// typed body/output for the client and are never present at runtime. A REQUIRED
// brand symbol (not just optional `__i`/`__o`) lets the meta extractor's
// conditional types discriminate these from a PLAIN `Handler` exactly — an
// optional-only phantom would be matched by any handler (every prop optional).
declare const VALIDATED: unique symbol;
declare const RETURNS: unique symbol;
export type ValidatedHandler<I, O> = Handler & {
  readonly [VALIDATED]: { i: I; o: O };
};
export type ReturnsHandler<O> = Handler & { readonly [RETURNS]: O };

/**
 * `validated(schema, fn)` — orthogonal body validation. Returns a plain std
 * `Handler` (so it slots straight into a `methods` table). On a request it:
 *   1. reads `await req.json()`,
 *   2. validates it against `schema` (Standard Schema),
 *   3. on issues → `400` JSON `{ error, issues }`,
 *   4. on success → calls `fn(value, req)` with the *typed* validated value.
 * The input type `InferOutput<schema>` is carried as a phantom so the typed
 * client requires a correctly-shaped `body`. `out` (optional) annotates the
 * response body type for client return typing.
 */
export function validated<S extends StandardSchemaV1<unknown, unknown>, O = unknown>(
  schema: S,
  fn: (
    value: InferOutput<S>,
    req: Request,
  ) => Response | undefined | Promise<Response | undefined>,
): ValidatedHandler<InferOutput<S>, O> {
  const h: Handler = async (req) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "INVALID_JSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const r = await schema["~standard"].validate(raw);
    if ("issues" in r && r.issues !== undefined) {
      return new Response(
        JSON.stringify({ error: "VALIDATION", issues: r.issues }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return fn((r as { value: InferOutput<S> }).value, req);
  };
  return h as ValidatedHandler<InferOutput<S>, O>;
}

/** `returns<O>(handler)` — annotate a non-validated handler's output type so the
 *  client return is typed, without forcing a body. Identity at runtime. */
export function returns<O>(h: Handler): ReturnsHandler<O> {
  return h as ReturnsHandler<O>;
}

/** Read a dynamic segment value off the Request, where `param(name, …)` bound it
 *  into `req.params`. Keeps "params are read off the Request" literally true after
 *  `param` advanced past the segment. Convenience over `req.params[name]`. */
export function paramValue(req: Request, name: string): string | undefined {
  const params = (req as Partial<{ params: Record<string, string> }>).params;
  return params?.[name] ?? undefined;
}
