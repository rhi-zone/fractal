// Prototype for the `methods` type-inference fix. A self-contained mirror of
// the minimal core types. Probes candidate `methods` signatures for:
//   (1) literal verb sets in `.meta` (never the full Method union),
//   (2) param obligation P extracted from the handlers (no explicit type-arg),
//   (3) discharge soundness preserved (param/Omit; toFetch requires Handler<{}>).
//
// Run with both:
//   tsgo --noEmit spike/methods-fix/proto.ts
//   tsc   --noEmit --strict spike/methods-fix/proto.ts

// Minimal core mirror

export type Handler<P = {}> = (
  req: Request & { params: P },
) => Response | undefined | Promise<Response | undefined>;

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type Reflected<M, P = {}> = Handler<P> & { readonly meta: M };

export interface SchemaRef {
  readonly input?: unknown;
  readonly output?: unknown;
}
export type WithSchema = { readonly __schema?: SchemaRef };

export interface MethodsMeta<
  Verbs extends string,
  IO extends Record<string, { i: unknown; o: unknown }>,
> {
  readonly tag: "methods";
  readonly verbs: readonly Verbs[];
  readonly schemas?: Readonly<Record<string, SchemaRef>>;
  readonly __io?: IO;
}

declare const VALIDATED: unique symbol;
declare const RETURNS: unique symbol;
export type ValidatedHandler<I, O> = Handler & {
  readonly [VALIDATED]: { i: I; o: O };
};
export type ReturnsHandler<O> = Handler & { readonly [RETURNS]: O };

type MethodsIO<T> = {
  readonly [K in Extract<keyof T, string>]: T[K] extends ValidatedHandler<infer I, infer O>
    ? { i: I; o: O }
    : T[K] extends ReturnsHandler<infer O>
      ? { i: never; o: Awaited<O> }
      : { i: never; o: unknown };
};

// Helpers for param extraction

// The standard UnionToIntersection.
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

// Extracts P from a table of handlers. Each handler is `Handler<P_k>`; the
// result is the intersection of all the P_k (a route that needs {id} and a
// route that needs {slug} makes the methods node need {id} & {slug}). P sits
// contravariantly inside `Request & { params: P }`, so whether `infer P`
// resolves there as expected isn't guaranteed by the variance rules alone —
// the probes below (Goal 2) check it empirically.
type ParamsOf<T> =
  UnionToIntersection<
    {
      [K in keyof T]: T[K] extends (req: Request & { params: infer P }) => unknown ? P : never;
    }[keyof T]
  > extends infer R
    ? // Collapses `unknown`/`{}` cleanly.
      R
    : never;

declare function withMeta<M, P = {}>(h: Handler<P>, meta: M): Reflected<M, P>;
declare function methodsRT<P = {}>(table: Partial<Record<Method, Handler<P>>>): Handler<P>;

// Candidate A — extracts P from handlers; verbs are literal via `const T`.
//
// No explicit P type-arg: `const T` is the sole inference site, so
// `.meta.verbs` is the literal union of the table's keys, and P is derived
// from the table.
declare function methodsA<const T extends Partial<Record<Method, Handler<any>>>>(
  table: T,
): Reflected<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, ParamsOf<T>>;

// Candidate B — like the old signature but with P after T and inferred from T,
// keeping the bound `Handler<P>` so the table is constrained by P. This risks
// re-introducing the inference coupling; it tests whether the bound matters.
// Probed only if A fails on discharge.

// Probes

declare function json(x: unknown): Response;

// Type-equality utility.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Goal 1: literal verbs.
const r1 = methodsA({ GET: () => json(1), POST: () => json(2) });
type R1Verbs = typeof r1.meta extends MethodsMeta<infer V, any> ? V : never;
// Must be exactly "GET" | "POST", not the full Method union.
type _G1a = Expect<Equals<R1Verbs, "GET" | "POST">>;
// @ts-expect-error — verbs must not widen to the full Method set.
type _G1neg = Expect<Equals<R1Verbs, Method>>;

const r1g = methodsA({ GET: () => json(1) });
type R1gVerbs = typeof r1g.meta extends MethodsMeta<infer V, any> ? V : never;
type _G1b = Expect<Equals<R1gVerbs, "GET">>;

// Goal 2: param extraction from handlers, with no explicit type-arg.
const rp = methodsA({ GET: (req) => json(req.params.id) });
type RpP = typeof rp extends Reflected<any, infer P> ? P : never;
// Probes whether `req.params.id` is readable with no annotation on `req` —
// i.e. whether `infer P` through the contravariant intersection resolves to
// {id:string} for an inline arrow.
type _G2_RpP = RpP;
// Verified on tsgo 7.0 + tsc 6.0.3: an inline arrow whose param type is left
// to inference has its `req` contextually typed by the table bound, so
// `req.params` is `any` and the extracted P collapses to `any`. The {id}
// obligation cannot be recovered from an unstated type; the residual is that
// the handler's param type must be declared to carry an obligation.
type _G2_RpP_isAny = Expect<Equals<RpP, any>>;

// A handler that declares its obligation explicitly.
const declHandler = (req: Request & { params: { id: string } }) => json(req.params.id);
const rp2 = methodsA({ GET: declHandler });
type Rp2P = typeof rp2 extends Reflected<any, infer P> ? P : never;
type _G2a = Expect<Equals<Rp2P, { id: string }>>;

// Two handlers with different obligations intersect.
const declA = (req: Request & { params: { id: string } }) => json(req.params.id);
const declB = (req: Request & { params: { slug: string } }) => json(req.params.slug);
const rp3 = methodsA({ GET: declA, POST: declB });
type Rp3P = typeof rp3 extends Reflected<any, infer P> ? P : never;
type _G2b = Expect<Equals<Rp3P, { id: string } & { slug: string }>>;

// A no-param handler resolves P to `unknown` (a single-member UnionToIntersection
// of `unknown`). `Handler<unknown>` is still assignable past `toFetch`'s
// `Handler<{}>`, so a no-param app stays sound (see discharge.ts 3d).
const rNo = methodsA({ GET: () => json(1) });
type RNoP = typeof rNo extends Reflected<any, infer P> ? P : never;
type _G2_RNoP_isUnknown = Expect<Equals<RNoP, unknown>>;
