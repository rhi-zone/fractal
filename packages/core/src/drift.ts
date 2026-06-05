// packages/core/src/drift.ts — @rhi-zone/fractal-core (drift-guard substrate)
//
// Type-level derivation of a route-entry UNION from a handler tree's inert
// `.meta`, plus a SOUND exact-equality assertion. None of it runs; it is all
// `type` (plus the `Assert<…> = true` witness const the generated guard emits).
//
// The contract: the SOURCE of truth is `typeof app`, whose type carries `.meta`
// (a tree of PathMeta / ChoiceMeta / ParamMeta / PrefixMeta / MethodsMeta). The
// GENERATED artifact (@rhi-zone/fractal-codegen) emits a concrete `GenUnion` — a
// union of `RouteEntry<"VERB /path", params, body, response>` — and a guard:
//
//   export const _drift: Assert<AssertExact<RouteUnion<typeof app>, GenUnion>> = true;
//
// `RouteUnion<typeof app>` re-derives the same union from `.meta`; `AssertExact`
// resolves to `true` iff the two unions are identical. Any drift — added /
// removed / renamed route, changed param / body / response shape — makes the
// derived union differ, `AssertExact` resolves to the `{ __drift__: … }` error
// object, and the `= true` assignment fails to typecheck. Generated depends on
// source (`import type` only — no runtime import, no cycle); source never imports
// generated.
//
// LINEARITY (load-bearing): the walk produces a UNION and NEVER merges it into a
// keyed object. Merging a union of N single-key objects re-scans the N-member
// union per key → O(N²), which crashed stock tsc at ~900 routes in the spike.
// A union stays one pass: building it is ~linear and `AssertExact` over two
// unions is sound. See spike/drift-guard/logs/table.md (f5, the linear winner).

import type {
  ChoiceMeta,
  MethodsMeta,
  ParamMeta,
  PathMeta,
  PrefixMeta,
} from "./index.ts";

// ============================================================================
// SOUND exact-equality. The function-identity invariant trick: two types are
// mutually-assignable-as-conditional-keys iff they are identical (catches both
// added AND removed members, and changed shapes — unlike loose `extends`).
// ============================================================================

export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Resolves to the literal `true` only when A and B are identical; otherwise to
 *  a descriptive error object (so the failure site names both sides). Used as
 *  `Assert<AssertExact<Derived, Generated>>` — when it resolves to anything other
 *  than `true`, the accompanying `const _: true = …` assignment fails. */
export type AssertExact<A, B> =
  Equals<A, B> extends true
    ? true
    : {
        __drift__: "derived (from source .meta) != generated artifact — REGENERATE";
        derived: A;
        generated: B;
      };

/** A `const`-level witness: assigning a non-`true` AssertExact result to `true`
 *  is the actual error. The generated guard does
 *  `export const _drift: Assert<AssertExact<D, G>> = true;`. */
export type Assert<T extends true> = T;

// ============================================================================
// The LINEAR derivation. We walk `.meta` ONCE accumulating a path string and
// param record, and at each `methods` node emit one UNION member per verb:
// `RouteEntry<"VERB /seg/{p}", params, body, response>`. No UnionToIntersection,
// no nested call-signature assembly, no object materialization — the expensive
// parts of the retired `Client<App>` walk are absent.
// ============================================================================

/** One route, as a concrete union member. `K` is the route key (`"GET /todos"`),
 *  `Params`/`Body`/`Response` mirror the generated side's projection of the same
 *  data. NB: an `interface` (not an inlined object) so the derived member is
 *  byte-identical to the generated `RouteEntry<…>` reference. */
export interface RouteEntry<K extends string, Params, Body, Response> {
  k: K;
  params: Params;
  body: Body;
  response: Response;
}

// Accumulated params: a record of name -> decoded type, built while descending
// `param` nodes.
type EmptyParams = {};

// CANONICALIZE a derived shape before comparison. The generated artifact is plain
// TS the codegen emits — always MUTABLE object/array members (codegen never emits
// `readonly`). The DERIVED shape, by contrast, picks up `readonly` from however
// the source's schema was typed (e.g. a `const`-mapped StandardSchema output is
// `{ readonly id: string }`). That `readonly`-ness is incidental — not a routing
// fact codegen can reproduce — so comparing it would false-positive on a clean
// app. `Canon` deep-strips `readonly` (and recurses through arrays/objects) so the
// guard compares the LOAD-BEARING shape: keys, value types, optionality. It still
// catches every real drift (added/removed/renamed key, changed value type, added/
// removed optionality) — it only neutralizes a modifier the artifact can't carry.
// Functions/primitives pass through unchanged. (Tuples are arrays here — none of
// the projected params/body/response are tuples.)
type Canon<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer E)[]
    ? Canon<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: Canon<T[K]> }
      : T;

type WalkUnion<M, Pfx extends string, P> =
  M extends MethodsMeta<infer Verbs, infer IO>
    ? {
        [V in Verbs]: RouteEntry<
          `${Uppercase<V & string>} ${Pfx}`,
          Canon<P>,
          Canon<V extends keyof IO ? (IO[V] extends { i: infer I } ? I : never) : never>,
          Canon<V extends keyof IO ? (IO[V] extends { o: infer O } ? O : never) : never>
        >;
      }[Verbs]
    : M extends PathMeta<infer R>
      ? { [K in keyof R]: WalkUnion<R[K], `${Pfx}/${K & string}`, P> }[keyof R]
      : M extends PrefixMeta<infer Pre, infer Rest>
        ? WalkUnion<Rest, `${Pfx}/${Pre & string}`, P>
        : M extends ParamMeta<infer N, infer T, infer Rest>
          ? WalkUnion<Rest, `${Pfx}/{${N & string}}`, P & { [K in N & string]: T }>
          : M extends ChoiceMeta<infer Alts>
            ? WalkUnionAlts<Alts, Pfx, P>
            : never;

type WalkUnionAlts<Alts, Pfx extends string, P> = Alts extends readonly [
  infer Head,
  ...infer Tail,
]
  ? WalkUnion<Head, Pfx, P> | WalkUnionAlts<Tail, Pfx, P>
  : never;

/** The LINEAR derivation: a UNION of route entries from a handler tree's `.meta`,
 *  ready for one `AssertExact` against the generated union. `App` is `typeof app`;
 *  we read its `.meta`. Never merged into a keyed object (that is the O(N²) trap). */
export type RouteUnion<App> = App extends { meta: infer M }
  ? WalkUnion<M, "", EmptyParams>
  : never;
