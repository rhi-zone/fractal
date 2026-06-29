// packages/core/src/index.ts — @rhi-zone/fractal-core
//
// The function-core model (see docs/design/function-core-and-projection.md).
//
// The base IS the function category: plain functions `A => B` composed with
// ordinary composition. `Result<T, E>` plus the two DERIVED combinators this
// slice needs — Kleisli composition (thread a Result / short-circuit) and the
// record/applicative combinator (`collect`, run a set of field-producers and
// gather their outputs, short-circuiting on the first failure) — are built ON
// TOP, never primitive.
//
// On top of that sits the protocol-NEUTRAL routing tree (the verified
// "Candidate D" combinators: path / param / group / methods / route + the `app`
// root anchor). The tree is a runtime VALUE that carries structure + functions
// only — segment names, param levels, capability producers, the verb table, and
// at the leaf the producer defs + handler. Per-leaf TYPES are inferred (no
// runtime meta sidecar): the handler's `options` record is fully inferred from
// the enclosing params, capabilities, and leaf producer fields.

// ============================================================================
// The function category — the base
// ============================================================================

export type Fn<A, B> = (a: A) => B;

/** Ordinary function composition: `compose(f)(g)` is `a => g(f(a))`. */
export const compose =
  <A, B>(f: Fn<A, B>) =>
  <C>(g: Fn<B, C>): Fn<A, C> =>
  (a) =>
    g(f(a));

/** Left-to-right value threading: `pipe(a, f, g)` is `g(f(a))`. */
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, f: Fn<A, B>): B;
export function pipe<A, B, C>(a: A, f: Fn<A, B>, g: Fn<B, C>): C;
export function pipe<A, B, C, D>(
  a: A,
  f: Fn<A, B>,
  g: Fn<B, C>,
  h: Fn<C, D>,
): D;
export function pipe(a: unknown, ...fns: Fn<unknown, unknown>[]): unknown {
  return fns.reduce((acc, fn) => fn(acc), a);
}

// ============================================================================
// Result<T, E> — the fallible-value type
// ============================================================================

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(
  r: Result<T, E>,
): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(
  r: Result<T, E>,
): r is { ok: false; error: E } => !r.ok;

/** Map the success value; pass an error through untouched. */
export const map = <T, E, U>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** Monadic bind: run `f` on the success value, short-circuit on error. The
 *  primitive Kleisli composition is built from. */
export const bind = <T, E, U>(
  r: Result<T, E>,
  f: (t: T) => Result<U, E>,
): Result<U, E> => (r.ok ? f(r.value) : r);

/** Fold a Result into a single value by matching both arms. The final encode
 *  stage `Result<T, E> => Response` is exactly `match(r, { ok, err })`. */
export const match = <T, E, R>(
  r: Result<T, E>,
  arms: { ok: (t: T) => R; err: (e: E) => R },
): R => (r.ok ? arms.ok(r.value) : arms.err(r.error));

// ============================================================================
// Derived combinators — Kleisli + applicative. NEVER the base.
// ============================================================================

/** Kleisli composition over Result: `composeK(f)(g) = a => bind(f(a), g)`.
 *  Threads a Result through a fallible chain, short-circuiting on the first
 *  error. Derived from `compose` + `bind`. */
export const composeK =
  <A, B, E>(f: Fn<A, Result<B, E>>) =>
  <C>(g: Fn<B, Result<C, E>>): Fn<A, Result<C, E>> =>
  (a) =>
    bind(f(a), g);

/** The record / applicative combinator. Given a record of field-producers that
 *  each read a common input `I` and yield a `Result`, return one function that
 *  runs them all and collects their outputs into a record — short-circuiting on
 *  the FIRST failure. This is the `buildOptions` mechanism: run each field's
 *  producer, gather the typed values. */
export function collect<
  I,
  E,
  F extends Record<string, (i: I) => Result<unknown, E>>,
>(
  producers: F,
): (
  i: I,
) => Result<
  { [K in keyof F]: F[K] extends (i: I) => Result<infer V, E> ? V : never },
  E
> {
  const keys = Object.keys(producers);
  return (i) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const r = producers[k]!(i);
      if (!r.ok) return r as Result<never, E>;
      out[k] = r.value;
    }
    return ok(
      out as {
        [K in keyof F]: F[K] extends (i: I) => Result<infer V, E> ? V : never;
      },
    );
  };
}

// ============================================================================
// Schema<T> — a minimal one-directional validator/coercer.
//
// Provisionally SCHEMA-style producers per the design doc: a leaf's `query` /
// `body` carry a `Schema<T>` value per field. A schema is just a fallible
// transform `unknown => Result<T, SchemaIssue>` — no bidirectionality.
// ============================================================================

export interface SchemaIssue {
  readonly message: string;
  /** Optional field path, for nested object validation. */
  readonly path?: readonly string[];
}

export interface Schema<T> {
  readonly parse: (raw: unknown) => Result<T, SchemaIssue>;
}

export type InferSchema<S> = S extends Schema<infer T> ? T : never;

/** A required string. Query values arrive as `string | null`; `null`/`undefined`
 *  (a missing param) is an error. */
export const str = (): Schema<string> => ({
  parse: (raw) =>
    typeof raw === "string"
      ? ok(raw)
      : err({ message: "expected a string" }),
});

/** A number coerced from a string (query) or accepted as a number (body). */
export const num = (): Schema<number> => ({
  parse: (raw) => {
    const n = typeof raw === "string" ? Number(raw) : raw;
    return typeof n === "number" && !Number.isNaN(n)
      ? ok(n)
      : err({ message: "expected a number" });
  },
});

/** A boolean coerced from `"true"`/`"false"` (query) or accepted as a boolean. */
export const bool = (): Schema<boolean> => ({
  parse: (raw) => {
    if (typeof raw === "boolean") return ok(raw);
    if (raw === "true") return ok(true);
    if (raw === "false") return ok(false);
    return err({ message: "expected a boolean" });
  },
});

/** An object schema built from per-field schemas. Uses the `collect`
 *  applicative over the fields, short-circuiting on the first invalid field. */
export function obj<F extends Record<string, Schema<unknown>>>(
  fields: F,
): Schema<{ [K in keyof F]: InferSchema<F[K]> }> {
  const keys = Object.keys(fields);
  return {
    parse: (raw) => {
      if (typeof raw !== "object" || raw === null) {
        return err({ message: "expected an object" });
      }
      const src = raw as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const r = fields[k]!.parse(src[k]);
        if (!r.ok) {
          return err({ message: r.error.message, path: [k, ...(r.error.path ?? [])] });
        }
        out[k] = r.value;
      }
      return ok(out as { [K in keyof F]: InferSchema<F[K]> });
    },
  };
}

// ============================================================================
// The routing tree — protocol-neutral, the authored primitive.
//
// `Node<C>` is the OPAQUE public type the combinators speak; `C` is the
// accumulated context (path-params + capabilities) flowing TOP-DOWN. The runtime
// value behind every `Node` is one of the `RuntimeNode` shapes below — the tree
// carries structure + functions only (no per-leaf types/schemas as meta).
// ============================================================================

export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** The opaque node type the combinators expose. `C` (the accumulated context)
 *  lives ONLY as a phantom — the inference machinery (NoInfer + the `app`
 *  anchor) flows it top-down; authors never write it. */
export interface Node<C> {
  readonly __c?: C;
  readonly kind: NodeKind;
}

export type NodeKind = "path" | "param" | "group" | "methods" | "route";

// The concrete runtime shapes. A `Node` value IS one of these; the protocol
// renderer (http) reads them by `kind`. They are intentionally context-blind
// (`RuntimeNode`, not `Node<C>`): the runtime needs structure, not the type.
export type RuntimeNode =
  | RuntimePathNode
  | RuntimeParamNode
  | RuntimeGroupNode
  | RuntimeMethodsNode
  | RuntimeRouteNode;

export interface RuntimePathNode {
  readonly kind: "path";
  readonly routes: Record<string, RuntimeNode>;
}
export interface RuntimeParamNode {
  readonly kind: "param";
  readonly name: string;
  readonly child: RuntimeNode;
}
export interface RuntimeGroupNode {
  readonly kind: "group";
  readonly key: string;
  readonly produce: (
    req: Request,
  ) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;
  readonly child: RuntimeNode;
}
export interface RuntimeMethodsNode {
  readonly kind: "methods";
  readonly table: Partial<Record<Method, RuntimeNode>>;
}
export interface RuntimeRouteNode {
  readonly kind: "route";
  readonly query?: Record<string, Schema<unknown>>;
  readonly body?: Schema<unknown>;
  readonly handler: (
    opts: Record<string, unknown>,
  ) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;
}

/** Bridge a typed `Node` to its runtime shape (the renderer's entry point). */
export const toRuntime = (n: Node<unknown>): RuntimeNode =>
  n as unknown as RuntimeNode;

// ---- type-level helpers for the leaf inference -----------------------------

/** Map a `query` record of `Schema<T>` to its `{ field: T }` value record. */
export type QueryFields<Q> = {
  [K in keyof Q]: Q[K] extends Schema<infer T> ? T : never;
};

/** Flatten an intersection into a single object literal (for readable hovers). */
export type Flatten<T> = { [K in keyof T]: T[K] } & {};

// ---- the combinators -------------------------------------------------------
//
// WHY the inference works (load-bearing — do not remove the NoInfer markers or
// the `app` anchor): NoInfer<C> on every child/table/handler position closes the
// only bottom-up inference site, so each call's `C` is pinned solely by its
// parent's contextual return type. `app(root: Node<{}>)` seeds `C = {}` at the
// outermost call; from there `C` flows top-down, accumulating exactly one level
// per `param` (`Record<N, string>`) / `group` (`Record<N, V>`) down to each leaf.

/** Literal-segment split: keys map a path segment to its child node. */
export function path<C>(routes: Record<string, Node<NoInfer<C>>>): Node<C> {
  return {
    kind: "path",
    routes: routes as unknown as Record<string, RuntimeNode>,
  } as unknown as Node<C>;
}

/** Dynamic-segment split: binds path-param `name` (typed `string`) into the
 *  context for the whole `child` subtree. */
export function param<C, N extends string>(
  name: N,
  child: Node<NoInfer<C> & Record<N, string>>,
): Node<C> {
  return {
    kind: "param",
    name,
    child: child as unknown as RuntimeNode,
  } as unknown as Node<C>;
}

/** Capability over a subtree: `produce` is a server-side function yielding the
 *  capability `key: V` (or short-circuiting with an error), added to the context
 *  for `child`. This is the only place auth / db-handle / request-id enter — as
 *  an ordinary context field, indistinguishable to the handler. */
export function group<C, N extends string, V>(
  key: N,
  produce: (
    req: Request,
  ) => Result<V, unknown> | Promise<Result<V, unknown>>,
  child: Node<NoInfer<C> & Record<N, V>>,
): Node<C> {
  return {
    kind: "group",
    key,
    produce: produce as RuntimeGroupNode["produce"],
    child: child as unknown as RuntimeNode,
  } as unknown as Node<C>;
}

/** Verb split: maps each HTTP method to its child node (a `route` leaf). */
export function methods<C>(
  table: Partial<Record<Method, Node<NoInfer<C>>>>,
): Node<C> {
  return {
    kind: "methods",
    table: table as unknown as Partial<Record<Method, RuntimeNode>>,
  } as unknown as Node<C>;
}

/** The leaf. Producers are flat in the def (`query`, `body`). The handler
 *  receives a flat, fully-inferred, provenance-blind `options` record =
 *  (ancestor path-params) & (capabilities) & (this leaf's producer fields). */
export function route<
  C,
  Q extends Record<string, Schema<unknown>> = {},
  B = never,
>(def: {
  query?: Q;
  body?: Schema<B>;
  handler: (
    opts: Flatten<
      NoInfer<C> & QueryFields<Q> & ([B] extends [never] ? {} : { body: B })
    >,
  ) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;
}): Node<C> {
  const node: RuntimeRouteNode = {
    kind: "route",
    handler: def.handler as RuntimeRouteNode["handler"],
  };
  if (def.query !== undefined) {
    (node as { query?: Record<string, Schema<unknown>> }).query =
      def.query as Record<string, Schema<unknown>>;
  }
  if (def.body !== undefined) {
    (node as { body?: Schema<unknown> }).body = def.body as Schema<unknown>;
  }
  return node as unknown as Node<C>;
}

/** The root anchor. Seeds `C = {}` so the top-down context flow begins. Returns
 *  the tree so a protocol package can render it to a dispatcher. */
export function app(root: Node<{}>): Node<{}> {
  return root;
}
