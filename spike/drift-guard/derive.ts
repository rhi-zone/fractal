// spike/drift-guard/derive.ts
//
// Type-level derivation of a FLAT route map from a handler tree's `.meta`, plus a
// SOUND exact-equality assertion. This is the substrate the four guard
// formulations share. None of it runs; it is all `type`.
//
// The source of truth is `typeof app` whose type carries `.meta` (a tree of
// PathMeta / ChoiceMeta / ParamMeta / PrefixMeta / MethodsMeta). The generated
// artifact is a flat record. The guard re-derives the flat map from `.meta` and
// asserts it equals the generated map — so any drift (added/removed/renamed
// route, changed param/body/response shape) is a `tsc` error.

import type {
  ChoiceMeta,
  MethodsMeta,
  ParamMeta,
  PathMeta,
  PrefixMeta,
} from "@rhi-zone/fractal-api-tree";

// ============================================================================
// SOUND exact-equality. The function-identity invariant trick: two types are
// mutually-assignable-as-conditional-keys iff they are identical (catches both
// added AND removed members, and changed shapes — unlike loose `extends`).
// ============================================================================

export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// `AssertExact<A, B>` resolves to the literal `true` only when A and B are
// identical; otherwise to a descriptive error object (so the failure site names
// both sides). Used as `type _ = AssertExact<Derived, Generated>` — when it
// resolves to anything other than `true`, an accompanying `const _: true = …`
// assignment fails to typecheck.
export type AssertExact<A, B> =
  Equals<A, B> extends true
    ? true
    : { __drift__: "derived (from source .meta) != generated artifact"; derived: A; generated: B };

// A `const`-level witness: assigning a non-`true` AssertExact result to `true`
// is the actual error. Re-exported so each formulation just does
// `export const _guard: Assert<AssertExact<D, G>> = true;`
export type Assert<T extends true> = T;

// ============================================================================
// The cheap FLAT derivation. We walk `.meta` ONCE accumulating a path string and
// param list, and at each `methods` node emit one flat entry per verb keyed
// `"VERB /seg/{p}"`. No UnionToIntersection, no nested call-signature assembly —
// the expensive parts of the retired `Client<App>` walk are absent. The result
// is a flat object type whose keys are the route keys and whose values are the
// `{ params; body; response }` triples.
// ============================================================================

// Verbs that may appear in a MethodsMeta (closed set, ≤7).
type LowerVerb<V extends string> = V extends "GET"
  ? "get"
  : V extends "POST"
    ? "post"
    : V extends "PUT"
      ? "put"
      : V extends "DELETE"
        ? "delete"
        : V extends "PATCH"
          ? "patch"
          : V extends "HEAD"
            ? "head"
            : V extends "OPTIONS"
              ? "options"
              : Lowercase<V>;

// The per-route value. We keep params as a record name->type, body as the input
// phantom, response as the output phantom. These come straight off the meta
// phantoms (`__io`) and the accumulated params — no schema resolution needed for
// the structural compare (the GENERATED side mirrors the same projection).
// NB: members are NON-readonly and the type is inlined (not an interface) so the
// derived shape is byte-identical to the generated `{ params; body; response }`.
// `AssertExact` is sound — a `readonly` mismatch WOULD make it (correctly) fail —
// so the generated side and this must agree on modifiers exactly.
export type RouteShape<Params, Body, Response> = {
  params: Params;
  body: Body;
  response: Response;
};

// Accumulated params: a record of name -> decoded type, built while descending
// `param` nodes.
type EmptyParams = {};

// Emit the flat entries for a single `methods` node, given the accumulated path
// key prefix `Pfx` (e.g. "/users/{id}") and accumulated params `P`.
type EmitMethods<M, Pfx extends string, P> =
  M extends MethodsMeta<infer Verbs, infer IO>
    ? {
        // one key per verb: "GET /users/{id}"
        [V in Verbs as `${Uppercase<V & string>} ${Pfx}`]: RouteShape<
          P,
          V extends keyof IO ? (IO[V] extends { i: infer I } ? I : never) : never,
          V extends keyof IO ? (IO[V] extends { o: infer O } ? O : never) : never
        >;
      }
    : {};

// The recursive walk. Returns a flat object type (union of single-key objects
// merged). We use a mapped-type merge via intersection at the `path`/`choice`
// fan-out, then flatten with `Flatten` at the top.
export type Walk<M, Pfx extends string, P> =
  // methods: leaf — emit verb entries.
  M extends MethodsMeta<string, Record<string, { i: unknown; o: unknown }>>
    ? EmitMethods<M, Pfx, P>
    : // path: fan out over the record keys, descending each with seg appended.
      M extends PathMeta<infer R>
      ? UnionToObj<
          {
            [K in keyof R]: Walk<R[K], `${Pfx}/${K & string}`, P>;
          }[keyof R]
        >
      : // prefix: append the single literal segment.
        M extends PrefixMeta<infer Pre, infer Rest>
        ? Walk<Rest, `${Pfx}/${Pre & string}`, P>
        : // param: append `/{name}` and add the param to P.
          M extends ParamMeta<infer N, infer T, infer Rest>
          ? Walk<Rest, `${Pfx}/{${N & string}}`, P & { [K in N & string]: T }>
          : // choice: fan out over the tuple of alts at the SAME path.
            M extends ChoiceMeta<infer Alts>
            ? UnionToObj<WalkAlts<Alts, Pfx, P>>
            : {};

// Walk a tuple of choice alts → a UNION of their flat maps.
type WalkAlts<Alts, Pfx extends string, P> = Alts extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Walk<Head, Pfx, P> | WalkAlts<Tail, Pfx, P>
  : never;

// Merge a UNION of single-/multi-key object types into one object type WITHOUT
// UnionToIntersection over the whole client (which is what blew up). We collect
// the union of all keys, then for each key pick its value from whichever member
// has it. This is linear in total entries, not quadratic.
type UnionToObj<U> = {
  [K in U extends unknown ? keyof U : never]: U extends Record<K, infer V>
    ? V
    : never;
};

// Public entry: derive the flat route map from a handler tree type. `App` is
// `typeof app`; we read its `.meta`.
export type FlatRoutes<App> = App extends { meta: infer M }
  ? Flatten<Walk<M, "", EmptyParams>>
  : never;

// Force-evaluate an object type (so the assertion compares resolved members, and
// so error messages print the resolved shape).
type Flatten<T> = { [K in keyof T]: T[K] } & {};

// ============================================================================
// f5 — the LINEAR winner. Derive a UNION of single-route ENTRY objects
// `{ k; params; body; response }` and compare it against the generated union
// with one `AssertExact`. The key difference from FlatRoutes: we NEVER merge the
// union into a keyed object (no `UnionToObj`). Merging is the O(N²) step — for
// each of N keys it re-scans the N-member union. A union stays one pass: building
// it is ~linear and `AssertExact` over two unions is sound (it catches added /
// removed / renamed routes and any param/body/response shape change, incl. subtle
// widenings — verified in the spike). This is what codegen should emit.
// ============================================================================

export interface RouteEntry<K extends string, Params, Body, Response> {
  k: K;
  params: Params;
  body: Body;
  response: Response;
}

type WalkUnion<M, Pfx extends string, P> =
  M extends MethodsMeta<infer Verbs, infer IO>
    ? {
        [V in Verbs]: RouteEntry<
          `${Uppercase<V & string>} ${Pfx}`,
          P,
          V extends keyof IO ? (IO[V] extends { i: infer I } ? I : never) : never,
          V extends keyof IO ? (IO[V] extends { o: infer O } ? O : never) : never
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

/** The LINEAR derivation: a union of route entries, ready for one AssertExact
 *  against the generated union. */
export type RouteUnion<App> = App extends { meta: infer M }
  ? WalkUnion<M, "", EmptyParams>
  : never;
