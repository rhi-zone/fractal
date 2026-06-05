// spike/methods-fix/discharge.ts
//
// DISCHARGE soundness probes against candidate `methods` (Candidate A from
// proto.ts, re-declared minimally here with param/toFetch).
//
//   (3a) undischarged param obligation => `toFetch` REJECTS (compile error)
//   (3b) wrong-name `param` => REJECTED
//   (3c) discharged route => `toFetch` ACCEPTS
//   (3d) no-param handler works as Handler<{}>

export type Handler<P = {}> = (
  req: Request & { params: P },
) => Response | undefined | Promise<Response | undefined>;

export type Method =
  | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type Reflected<M, P = {}> = Handler<P> & { readonly meta: M };

export interface MethodsMeta<
  Verbs extends string,
  IO extends Record<string, { i: unknown; o: unknown }>,
> {
  readonly tag: "methods";
  readonly verbs: readonly Verbs[];
}

type MethodsIO<T> = {
  readonly [K in Extract<keyof T, string>]: { i: never; o: unknown };
};

export interface ParamMeta<N extends string, T, R> {
  readonly tag: "param";
  readonly name: N;
  readonly rest: R;
}

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

type ParamsOf<T> = UnionToIntersection<
  {
    [K in keyof T]: T[K] extends (req: Request & { params: infer P }) => unknown
      ? P
      : never;
  }[keyof T]
>;

// Candidate A `methods`.
declare function methods<
  const T extends Partial<Record<Method, Handler<any>>>,
>(
  table: T,
): Reflected<MethodsMeta<Extract<keyof T, string>, MethodsIO<T>>, ParamsOf<T>>;

// `param` — discharges via Omit (mirrors core).
declare function param<const N extends string, M, Q extends Record<N, string>>(
  name: N,
  inner: Reflected<M, Q>,
): Reflected<ParamMeta<N, string, M>, Omit<Q, N>>;

declare function toFetch(app: Handler<{}>): (req: Request) => Promise<Response>;

declare function json(x: unknown): Response;

// ---- (3d) no-param handler is Handler<{}> ----
const leafNoParam = methods({ GET: () => json(1) });
toFetch(leafNoParam); // OK

// ---- a leaf that DECLARES it needs {id} ----
const idLeaf = methods({
  GET: (req: Request & { params: { id: string } }) => json(req.params.id),
});

// ---- (3a) undischarged: feeding idLeaf straight to toFetch must FAIL ----
// @ts-expect-error — {id} obligation not discharged; not assignable to Handler<{}>.
toFetch(idLeaf);

// ---- (3c) discharged via param("id", …): ACCEPTS ----
const discharged = param("id", idLeaf);
toFetch(discharged); // OK — Omit<{id},"id"> = {}

// ---- (3b) wrong-name param => REJECTED ----
// @ts-expect-error — "slug" does not satisfy Q extends Record<"slug", string>
//   because idLeaf's Q is {id:string} (no "slug" key).
const wrong = param("slug", idLeaf);
void wrong;

export {};
