// spike/drift-guard/naive.ts
//
// Formulation #1's heavy derivation: re-walk `.meta` into the FULL nested
// ApiClient shape (path → { verb: (args) => Promise<response> }) — the same
// nested call-signature assembly the RETIRED `Client<App>` did. This is the
// baseline expected to blow up; we measure it to prove the naive approach is
// unacceptable.

import type {
  ChoiceMeta,
  MethodsMeta,
  ParamMeta,
  PathMeta,
  PrefixMeta,
} from "@rhi-zone/fractal-core";

// Reuse the flat walk machinery's primitives but assemble the NESTED, grouped
// call-signature client (the expensive form): group by path, build per-verb call
// signatures `(args:{params;body}) => Promise<response>`.

type EmptyParams = {};

// One flat entry carries everything; we then GROUP flat entries by path and build
// nested call sigs. The grouping + call-sig assembly is the heavy part.
interface Flat {
  readonly k: string; // "GET /res0/{id}"
  readonly path: string; // "/res0/{id}"
  readonly verb: string; // "get"
  readonly params: unknown;
  readonly body: unknown;
  readonly response: unknown;
}

type WalkFlat<M, Pfx extends string, P> =
  M extends MethodsMeta<infer Verbs, infer IO>
    ? {
        [V in Verbs]: {
          readonly k: `${Uppercase<V & string>} ${Pfx}`;
          readonly path: Pfx;
          readonly verb: Lowercase<V & string>;
          readonly params: P;
          readonly body: V extends keyof IO ? (IO[V] extends { i: infer I } ? I : never) : never;
          readonly response: V extends keyof IO ? (IO[V] extends { o: infer O } ? O : never) : never;
        };
      }[Verbs]
    : M extends PathMeta<infer R>
      ? { [K in keyof R]: WalkFlat<R[K], `${Pfx}/${K & string}`, P> }[keyof R]
      : M extends PrefixMeta<infer Pre, infer Rest>
        ? WalkFlat<Rest, `${Pfx}/${Pre & string}`, P>
        : M extends ParamMeta<infer N, infer T, infer Rest>
          ? WalkFlat<Rest, `${Pfx}/{${N & string}}`, P & { [K in N & string]: T }>
          : M extends ChoiceMeta<infer Alts>
            ? WalkAltsFlat<Alts, Pfx, P>
            : never;

type WalkAltsFlat<Alts, Pfx extends string, P> = Alts extends readonly [
  infer Head,
  ...infer Tail,
]
  ? WalkFlat<Head, Pfx, P> | WalkAltsFlat<Tail, Pfx, P>
  : never;

// Build a call signature from a flat entry (the heavy nested assembly).
type CallSig<F extends Flat> = F["params"] extends Record<string, never>
  ? F["body"] extends never
    ? () => Promise<F["response"]>
    : (args: { body: F["body"] }) => Promise<F["response"]>
  : F["body"] extends never
    ? (args: { params: F["params"] }) => Promise<F["response"]>
    : (args: { params: F["params"]; body: F["body"] }) => Promise<F["response"]>;

// Group the union of flat entries by path, then by verb → call sig. This is the
// nested fold that, combined with the per-path key narrowing, is the quadratic
// hot spot (each path member filters the WHOLE flat union).
export type ClientShapeFromMeta<App> = App extends { meta: infer M }
  ? Group<WalkFlat<M, "", EmptyParams> & Flat>
  : never;

type AllPaths<F extends Flat> = F["path"];

type Group<F extends Flat> = {
  [P in AllPaths<F>]: {
    [V in (F extends { path: P } ? F : never)["verb"]]: CallSig<
      Extract<F, { path: P; verb: V }>
    >;
  };
};
