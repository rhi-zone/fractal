// packages/api-tree/src/node.ts — @rhi-zone/fractal-api-tree  (new model, alongside legacy spine)
//
// The new fractal authoring model: Node / Handler / SharedMeta / LeafMeta /
// BranchMeta + constructors (op / api) + mergeMeta.
//
// Node shape:
//   - A LEAF node carries `handler` (the bare fn) and may have no `children`.
//   - A BRANCH node carries `children` and no handler.
//   - Both is valid (uncommon but valid).
//   - Every node carries `meta` (the open metadata bag).
//   - A node MAY carry `fallback: { name, subtree }` — when keyed dispatch at
//     this node finds no matching child, the fallback consumes the value,
//     binds it as a named parameter, and continues into `subtree`. Static
//     children always win; fallback fires only when no child matches.
//
// `op(fn, meta?)` produces a leaf node.
// `api(children, opts?)` produces a branch node.
//
// This module is SEPARATE from the legacy function-core spine in index.ts.
// Import directly from "./node.ts" until the two are merged.
//
// See:
//   docs/design/router-model.md — Node Shape (settled node shape + fallback)
// ============================================================================

import type { Tags } from "./tags.ts"

// ============================================================================
// Core types
// ============================================================================

/**
 * Open metadata bag — arbitrary keys, NOT a closed set. Split by ROLE
 * (shared / leaf-only / branch-only) instead of one flat interface, so a
 * consumer's `HasRequiredKeys`-driven requiredness (below) and a
 * projector's own namespaced fields (e.g. `http`, `mcp`) can each target the
 * tree position where they're actually meaningful.
 *
 * Two uses co-exist in this bag:
 *   1. Projection namespaces: `meta.http = { dispatch: {...}, directives: [...] }`
 *   2. Agnostic behavioral tags: `meta.tags = { readOnly: true }`
 *
 * Types (+ JSDoc) are the truth for domain data. This bag is ONLY for
 * non-type-expressible projection/taste concerns (verb, segment, idempotency,
 * auth). Never a second source for domain data.
 *
 * Core itself declares no protocol namespace and performs no `declare
 * module` augmentation — every projector exports its own namespaced
 * fragments as inert interfaces, and exactly one deployment-owned file
 * augments `SharedMeta`/`LeafMeta`/`BranchMeta` via `extends`. See
 * docs/design/meta-role-split-spec.md.
 */
export interface SharedMeta {
  /**
   * Agnostic description text — read by every projector (cli, mcp, graphql,
   * …) as a fallback beneath their own namespaced `description` override
   * (e.g. `meta.mcp.description`). See docs/design/converged-model.md's
   * precedence chain: `meta.mcp.description > meta.description >
   * derived.description > ...`. Read at both leaf and branch position.
   */
  description?: string
}

/** Meta carried by a LEAF node (an `op()` result). */
export interface LeafMeta extends SharedMeta {
  tags?: Tags
}

/** Meta carried by a BRANCH node (an `api()` result). */
export interface BranchMeta extends SharedMeta {}

/**
 * True when `T` has at least one required key. `{}` is assignable from (and
 * to) any object type with only optional keys, so `{} extends T` is false
 * exactly when `T` has a required key.
 *
 * Used to make `op()`/`api()`'s meta-contribution rest parameter require at
 * least one argument when a consumer declaration-merges a required field
 * onto `LeafMeta`/`BranchMeta` — fractal's own default (all-optional) keeps
 * the zero-contribution call legal.
 */
type HasRequiredKeys<T> = {} extends T ? false : true

// ============================================================================
// Type-level meta merge — mirrors `mergeRecords`'/`mergeMeta`'s runtime
// semantics (below) so `op()`'s return type can carry the EXACT merged meta
// type instead of widening every contribution to the erased `Meta`. This is
// what lets a leaf's meta — e.g. `op(fn, http.get, http.moveTo(".."))` from
// http-api-projector's verbs.ts — carry literal directive values
// (`"GET"`, `".."`) all the way into `Node["meta"]`, which
// `HttpManifest<N>` (packages/http-api-projector/src/http-manifest.ts) reads
// back out.
// ============================================================================

/** Force eager evaluation of a mapped/intersection type into a plain object type. */
type Simplify<T> = { readonly [K in keyof T]: T[K] } & {}

/**
 * `T`, intersected with an index signature — makes `op()`/`api()`'s own
 * precise `meta` return type freely assignable into `Node["meta"]`'s
 * generic, indexed erasure field (see that field's own doc comment,
 * node.ts) whenever a constructed node widens into a plain `Node<any>` slot
 * (a `children` map entry, `fallback.subtree`, any function parameter typed
 * plain `Node`) — which is EVERY ordinary use of `op()`/`api()` together
 * (`api({ child: op(fn, ...) })`'s own `C extends Record<string, Node<any>>`
 * constraint check is exactly such a widening).
 *
 * Needed for two distinct reasons depending on what `T` resolves to:
 *   - `T` a genuinely EMPTY contribution (`op(fn)`'s `FoldMeta<[]>` = the
 *     bare `object` type, or `api(children)`'s bare `BranchMeta` fallback)
 *     — the built-in `object` type carries no provable properties at all,
 *     so it fails to satisfy ANY indexed target on its own; a NAMED
 *     `interface` (`BranchMeta`) fails too, for an unrelated but equally
 *     real reason — TypeScript's assignability check treats a value typed
 *     by a plain `interface` reference as NOT implicitly satisfying an
 *     index signature (only fresh/anonymous object types and type aliases
 *     get that leniency), even though every one of `BranchMeta`'s own
 *     members is optional. Both were verified empirically (scratch `tsc`,
 *     not asserted from memory) to fail `: { readonly [k: string]: unknown
 *     } = value` on their own and succeed once intersected with the index
 *     signature at the SOURCE, which is what this type does.
 *   - `T` a REAL contribution (e.g. `op(fn, http.get)`'s `{ http: {...} }`)
 *     — this case doesn't strictly need the intersection on its own (an
 *     anonymous object literal type already satisfies an indexed target
 *     without it), but applying `Widen` unconditionally, rather than only
 *     in the degenerate branches, keeps `op()`/`api()`'s return type
 *     uniform and avoids a conditional split whose two branches would
 *     otherwise need to agree on assignability by different mechanisms.
 */
type Widen<T> = T & { readonly [key: string]: unknown }

/**
 * Merge two meta VALUES at the type level, matching `mergeRecords`: arrays
 * concatenate (`http.directives`'s case), two plain objects merge
 * recursively (`tags`/`http`'s case), anything else resolves to `B` (later
 * wins) — same three-way branch as the runtime function, just as a
 * conditional type instead of an `Array.isArray`/`typeof` check.
 *
 * `A`/`B` here are frequently an OPTIONAL property's type (e.g.
 * `Tags | undefined`, when only one of two merged contributions declares
 * that key required) — `mergeRecords` itself special-cases this at runtime
 * (`if (v === undefined) continue` — an absent contribution never overrides
 * an existing value). The leading `B extends undefined ? A : A extends
 * undefined ? B : ...` branch mirrors that, and DELIBERATELY distributes
 * over `A`/`B`'s naked union (rather than defeating distribution) — for
 * `MergeMetaValue<Record<...>, Tags | undefined>` this evaluates once per
 * union member of `B` and unions the results, producing exactly "the merged
 * object, OR plain `A` if the caller's `B` turns out to have been absent" —
 * which is the honest static type given the input actually is optional.
 *
 * `Depth` caps object recursion at 2 levels (Meta's own keys, e.g. `http`;
 * then that value's own keys, e.g. `directives`/`response`) — deep enough to
 * concatenate `http.directives` (an ARRAY field, whose branch above doesn't
 * even consult `Depth`) and to merge `http`'s own immediate fields, but not
 * so deep that an incidental nested object arbitrarily far down a
 * projector's own meta namespace (e.g. a `response` directive's `headers:
 * Record<string,string>`) gets recursively torn apart into a
 * per-string-key mapped type — `Record<string,string>`'s single index
 * signature has no discrete `keyof` for `Omit`/`Pick` to preserve modifiers
 * over, which produces a bogus optional string index incompatible with the
 * plain `Record<string,string>` `exactOptionalPropertyTypes` expects. Beyond
 * the cap, `MergeMetaValue` takes the plain-override branch (`B` wins) —
 * losing recursive-merge precision for that deep a nesting, never losing the
 * value itself.
 */
type MergeMetaValue<A, B, Depth extends readonly unknown[] = []> = B extends undefined
  ? A
  : A extends undefined
    ? B
    : A extends readonly unknown[]
      ? B extends readonly unknown[]
        ? readonly [...A, ...B]
        : B
      : A extends object
        ? B extends readonly unknown[]
          ? B
          : B extends object
            ? Depth["length"] extends 2
              ? B
              : MergeTwoMeta<A, B, [...Depth, unknown]>
            : B
        : B

/**
 * True when key `K` is optional on BOTH `A` and `B` — the only case where
 * the merged key may still be legally absent (if either contribution always
 * supplies it, the merge always will too, regardless of the other side).
 */
type IsOptionalOnBoth<A, B, K extends keyof A & keyof B> =
  {} extends Pick<A, K> ? ({} extends Pick<B, K> ? true : false) : false

/**
 * Merge two meta OBJECTS at the type level, key by key, via `MergeMetaValue`.
 * Built from `Omit`/`Pick`-shaped pieces (not one mapped type over
 * `keyof A | keyof B`) specifically so each key's optional/readonly modifier
 * survives — `Omit` is a homomorphic mapped type that copies a property's
 * own modifiers through; a single mapped type keyed by a COMPUTED union like
 * `keyof A | keyof B` is not homomorphic and would flatten every key back to
 * required, which fails under `exactOptionalPropertyTypes` the moment an
 * optional-only field (`tags?`, `description?`, …) meets `Node["meta"]`'s own
 * optional declaration. The keys common to both sides are split further, via
 * key remapping (`as`), into a required-in-the-merge piece and an
 * optional-in-the-merge piece (`IsOptionalOnBoth`) so THEIR modifier is
 * correct too, not just copied from whichever side happened to be picked.
 */
type MergeTwoMeta<A, B, Depth extends readonly unknown[] = []> =
  & Omit<A, keyof B>
  & Omit<B, keyof A>
  & {
      [K in keyof A & keyof B as IsOptionalOnBoth<A, B, K> extends true ? never : K]:
        // `NonNullable` — a key present in the merged object always has a
        // defined value (`mergeRecords` never assigns `undefined` itself;
        // it `continue`s past it), even though `MergeMetaValue<A[K], B[K]>`
        // can otherwise carry a stray `| undefined` through from an
        // optional-on-one-side source field. Required under
        // `exactOptionalPropertyTypes`: a property typed `X | undefined`
        // (present, but with an explicit `undefined` value type) is not the
        // same thing as one typed `X` that merely happens to be optional.
        NonNullable<MergeMetaValue<A[K], B[K], Depth>>
    }
  & {
      [K in keyof A & keyof B as IsOptionalOnBoth<A, B, K> extends true ? K : never]?:
        NonNullable<MergeMetaValue<A[K], B[K], Depth>>
    }

/**
 * Fold a tuple of meta contributions into their merged type, right-to-left
 * (equivalent to `mergeMeta`'s left-to-right runtime fold for this
 * operation — array concatenation and later-key-wins are both associative,
 * see node.test.ts for the check). `[]` folds to `{}`, a single contribution
 * folds to itself unchanged (no merge needed, and no risk of the recursive
 * case's `Simplify` masking a already-precise type).
 */
type FoldMeta<T extends readonly unknown[]> = T extends readonly []
  ? object
  : T extends readonly [infer Only]
    ? Only
    : T extends readonly [infer First, ...infer Rest extends readonly unknown[]]
      ? MergeTwoMeta<First, FoldMeta<Rest>>
      : object

/** `T`, or the merge-identity `object` when `T` is `undefined` — lets `FoldMetaList` (below) treat an absent contribution (`mergeMeta(undefined, ...)`) as a no-op, matching `mergeRecords`'s own `if (v === undefined) continue`. */
type DefinedOr<T> = T extends undefined ? object : T

/**
 * `FoldMeta`'s counterpart for `mergeMeta`'s own public signature: same
 * right-to-left fold, but over a tuple whose elements may individually be
 * `undefined` (an optional/absent contribution) — `op()`'s `C` never
 * contains a literal `undefined` element, so `FoldMeta` itself doesn't need
 * this; `mergeMeta` is called directly by consumers with an optional
 * contribution in the mix (`mergeMeta(baseMeta, overrideMeta)` where
 * `overrideMeta` may be `undefined`), so its own fold has to skip those the
 * same way the runtime function does.
 */
type FoldMetaList<T extends readonly unknown[]> = T extends readonly []
  ? object
  : T extends readonly [infer Only]
    ? DefinedOr<Only>
    : T extends readonly [infer First, ...infer Rest extends readonly unknown[]]
      ? MergeTwoMeta<DefinedOr<First>, FoldMetaList<Rest>>
      : object

/** The bare callable on a leaf node. Provenance-blind: handler sees one flat input. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler<I = any, O = any> = (input: I) => O | Promise<O>

/**
 * [CERTIFIED] One tree = grouping AND addressing.
 * A node's key IS its address segment; behavior (`handler`) carries none.
 * Both `op()` and `api()` lower to this value.
 *
 * - LEAF: `handler` is present (a callable). May have no `children`.
 * - BRANCH: `children` is present. May have no `handler`.
 * - Both is valid (uncommon).
 * - `fallback`: optional wildcard-capture subtree. When keyed dispatch at this
 *   node finds no child matching the current request value, the fallback
 *   consumes that value, binds it as `fallback.name` in the handler input,
 *   and continues into `fallback.subtree`. Static children always win.
 * - `meta` is always present.
 *
 * Generic over `H` (this node's own handler type), defaulting to the erased
 * `Handler` so `Node` keeps working everywhere it's used as a plain type
 * (projections, `Record<string, Node>`, etc.) — only `op()` call sites that
 * want the concrete handler type preserved need to lean on the generic;
 * nothing downstream has to opt in.
 *
 * `children`'s declared type here is intentionally the erased
 * `Record<string, Node>` — a `children` map keyed to each child's own exact
 * `Node<H>` can't be expressed as a *default* on a second type parameter
 * without TS rejecting it as a circular default (a generic parameter
 * defaulting to a map of the enclosing type is a known TS limitation, unlike
 * ordinary recursive aliases). `api()` instead preserves the concrete
 * children map by intersecting it onto its return type at the call site —
 * see `api()`'s own doc comment.
 *
 * `meta`'s generic (erased) field type is `SharedMeta`, not
 * `LeafMeta | BranchMeta` or `LeafMeta & BranchMeta` — a plain `Node<H>`
 * value (a map entry in `children`, a `fallback.subtree`, …) doesn't
 * statically know whether it's a leaf, a branch, or both (§ node doc above),
 * so its generic field can only safely promise what's valid at EVERY
 * position: `SharedMeta`. `op()`/`api()` each override `meta` on their own
 * return type with the role-precise `LeafMeta`/`BranchMeta`-checked type
 * (below) — reading a role-specific field (`.tags`, a leaf-only projector
 * fragment, …) off a generically-typed `Node`/`child` that a walk knows by
 * control flow to be a leaf or branch requires an explicit narrowing cast at
 * that read site, matching this design's intent that a position-invalid key
 * not silently typecheck (docs/design/meta-role-split-spec.md §5).
 *
 * The field's actual declared type is `SharedMeta & { readonly [key:
 * string]: unknown }`, not bare `SharedMeta` — an implementation point the
 * spec's own text doesn't cover (it only specifies `SharedMeta`/`LeafMeta`/
 * `BranchMeta`'s own shape and op()/api()'s return types, never this erased
 * field). Without the index signature, EVERY real op()/api() result (any
 * meta literal that doesn't happen to include a `description` key — i.e.
 * nearly all of them, since a projector's own namespaced key like `http`/
 * `mcp` is never `description`) fails to widen into a plain `Node<any>`
 * slot (a `children` map entry, `fallback.subtree`, any function parameter
 * typed plain `Node`): TypeScript's "weak type" detection flags an object
 * literal as an error when the TARGET type has only optional properties AND
 * the source shares NOT ONE property name with it — exactly what happens
 * once projectors stop declaration-merging their own keys onto
 * `SharedMeta`/`LeafMeta` (§9(4)) and this field is left with only
 * `description?`. Before this split, `Meta`'s own augmented shape usually
 * shared a key (`http`, `mcp`, …) with any real contribution, so the same
 * failure mode never surfaced. The index signature is added ONLY here, on
 * this one erased field — never on `SharedMeta`/`LeafMeta`/`BranchMeta`
 * themselves, which stay exactly the shape §2 specifies — and restores the
 * "open metadata bag, arbitrary keys" character this module's own doc
 * comment (top of file) already claims for it, structurally rather than by
 * accidental key overlap with whichever projectors happen to be augmenting.
 * It does not weaken op()/api()'s own enforcement (`HasRequiredKeys`/
 * `FoldMeta`, §2a) — that runs entirely against `LeafMeta`/`BranchMeta`
 * directly at each call's own return type, never against this field.
 */
export type Node<H extends Handler = Handler> = {
  readonly handler?: H
  readonly children?: Readonly<Record<string, Node>>
  readonly fallback?: { readonly name: string; readonly subtree: Node }
  readonly meta: SharedMeta & { readonly [key: string]: unknown }
}

// ============================================================================
// Discriminators
// ============================================================================

export const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && "meta" in v

/** True when `n` is a leaf node (carries a handler). */
export const isLeaf = (n: Node): boolean => n.handler !== undefined

// ============================================================================
// Meta merge
// ============================================================================

/**
 * Recursively merge two record-like values with precedence: `value` wins
 * per key. Plain objects merge deeper; arrays concatenate; anything else
 * (including a type mismatch) resolves to `value`.
 */
function mergeRecords(
  existing: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue
    const e = out[key]
    if (Array.isArray(e) && Array.isArray(v)) {
      out[key] = [...e, ...v]
    } else if (
      typeof e === "object" && e !== null && !Array.isArray(e) &&
      typeof v === "object" && v !== null && !Array.isArray(v)
    ) {
      out[key] = mergeRecords(e as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[key] = v
    }
  }
  return out
}

/**
 * Deep-merge meta bags with precedence: later bags win per key;
 * `undefined` defers (does not override a previously-set value).
 *
 * Merge is fully recursive: plain objects merge deeper (e.g. tags, http
 * sub-bags), arrays concatenate (e.g. `http.directives`), and scalars are
 * overwritten by the later bag.
 *
 * Generic in `T` (the exact tuple of arguments), threaded through
 * `FoldMetaList<T>` the same way `op()` threads its own contributions
 * through `FoldMeta<C>` — this is what lets a direct call like
 * `mergeMeta(http.get, http.moveTo(".."))` carry `.http`'s literal shape
 * (and the `"GET"` verb literal) in its return type, without core knowing
 * anything about `http` — the literal type comes entirely from the
 * arguments' own inferred types, not from any declared `LeafMeta`/`Meta`
 * shape (docs/design/meta-role-split-spec.md §2: projectors no longer
 * augment core's role interfaces at all).
 */
export function mergeMeta<const T extends readonly (object | undefined)[]>(
  ...metas: T
): Simplify<FoldMetaList<T>> {
  let out: Record<string, unknown> = {}
  for (const m of metas) {
    if (m === undefined) continue
    out = mergeRecords(out, m as Record<string, unknown>)
  }
  return out as Simplify<FoldMetaList<T>>
}

// ============================================================================
// Constructors
// ============================================================================

/**
 * Produce a leaf node: a Node carrying a handler and merged meta.
 *
 * `op(fn)` — bare fn → leaf with empty meta.
 * `op(fn, meta)` — leaf with a single meta bag.
 * `op(fn, ...contributions)` — leaf with multiple meta bags deep-merged
 *   left-to-right via `mergeMeta` (later wins per key; undefined defers).
 *   A verb-bundle + extra tags compose without either clobbering the other.
 *
 * The result IS a Node (not a separate `{fn, meta}` record). Projections
 * detect a leaf by `node.handler !== undefined`.
 *
 * Generic in `H` (the exact handler type): `op(fn)`'s result carries `fn`'s
 * real signature as `["handler"]`, not the erased `Handler`. This is
 * what lets `api({ getBook: op((input: {id: string}) => ...) })` produce a
 * tree whose `children.getBook.handler` still has `fn`'s real input/output
 * types instead of `Handler`'s `(input: any) => any`.
 *
 * The return type marks `handler` as present (not the optional `handler?`
 * `Node<H>` declares) — `op()` always sets it, and callers that need to
 * distinguish a leaf from a branch generically (e.g. a recursive projection
 * over an arbitrary tree, computing its own return type from the input's
 * shape) can key a conditional type off "does this type have a required
 * `handler`," which a branch produced by `api()` alone never structurally
 * satisfies.
 *
 * Generic in `C` (the exact tuple of meta contributions) the same way `H` is
 * generic in the handler: a `const` type parameter (see `api()`'s `F` for
 * the same technique) keeps each contribution's own literal type instead of
 * widening to the erased base type, and the return type's `meta` field is
 * `FoldMeta<C>` — the type-level equivalent of `mergeMeta(...contributions)`
 * above. This is what lets `op(fn, http.get)`'s `.meta` carry the literal
 * `"GET"` (see verbs.ts) rather than `string`, all the way through into
 * `HttpManifest<N>` (packages/http-api-projector/src/http-manifest.ts).
 *
 * When `HasRequiredKeys<LeafMeta>` is true (a consumer declaration-merged a
 * required field onto `LeafMeta` — e.g. the sibling codebase's `scopes` on every op, see
 * docs/design/meta-role-split-spec.md §5/§7), `contributions` is checked
 * against `FoldMeta<C> extends LeafMeta` — the FOLDED (right-to-left merged)
 * contribution, not each contribution individually. This is deliberate, not
 * incidental: constraining each element of `C` to individually extend
 * `LeafMeta` would make a single `VerbBundle` contribution (e.g.
 * `http.get`'s own `{ http: {...} }`, carrying no `scopes` of its own) fail
 * to typecheck on its own, before it's ever composed with the contribution
 * that supplies `scopes` — breaking exactly the "verb bundle + extra tags
 * compose" DX this function exists for. Folding first means only the
 * COMPOSED result has to satisfy `LeafMeta`. When the fold doesn't satisfy
 * `LeafMeta` (a required member like `scopes` is missing from every
 * contribution combined), `contributions` falls back to the erased
 * `[LeafMeta, ...LeafMeta[]]` — a shape no literal-preserving call can
 * satisfy either (each individual contribution still lacks `scopes`), so the
 * call is a compile error pointing at the missing-argument shape rather than
 * silently widening.
 */
/**
 * Structurally extracts the `E` in a handler's `Result<T, E>` return type —
 * PROBE: matches the DU's raw `{ kind: "err"; error: E }` shape rather than
 * the `Result<T, E>` alias itself. Matching the alias name (`R extends
 * Result<any, infer E>`) does not work here: with `skipLibCheck: true`,
 * alias instantiations are left unresolved by the checker (see the
 * ARCHITECTURE NOTE in extract.ts), so a pattern keyed to the alias's own
 * identity always misses and falls through. The raw shape pattern sidesteps
 * that because it matches the union's structure, not the alias reference.
 *
 * The non-matching branch must be `never`, not `unknown` — a distributive
 * conditional applied to a union return type (e.g. an unannotated arrow
 * inferring `Result<Book,ApiError> | Result<never,never>`) evaluates the
 * non-matching branch once per union member, and `unknown` absorbs the
 * whole union (`unknown | ApiError` collapses to `unknown`) where `never`
 * disappears (`never | ApiError` stays `ApiError`).
 */
type ExtractErrorKind<H> = H extends (...args: any[]) => infer R
  ? R extends Promise<infer R2>
    ? R2 extends { kind: "err"; error: infer E } ? E : never
    : R extends { kind: "err"; error: infer E } ? E : never
  : never

export function op<H extends Handler, const C extends readonly unknown[] = []>(
  fn: H,
  ...contributions: HasRequiredKeys<LeafMeta> extends true
    ? FoldMeta<C> extends LeafMeta ? C : [LeafMeta, ...LeafMeta[]]
    : C
): Omit<Node, "handler" | "meta"> & {
  readonly handler: H
  readonly meta: Widen<Simplify<FoldMeta<C>>>
  readonly __errorKind?: ExtractErrorKind<H>
} {
  const meta = contributions.length === 0
    ? {}
    : contributions.length === 1
      ? contributions[0]!
      // `contributions` is validated (by the parameter's own conditional type,
      // above) to fold into something satisfying `LeafMeta` by the time any
      // call actually reaches here — the cast is only to cross `mergeMeta`'s
      // `object | undefined` runtime-array constraint from the still-generic
      // `C`, not a widening of what's already been typechecked at the call site.
      : mergeMeta(...(contributions as readonly (object | undefined)[]))
  return { handler: fn, meta } as Omit<Node, "handler" | "meta"> & {
    readonly handler: H
    readonly meta: Widen<Simplify<FoldMeta<C>>>
  }
}

/**
 * Produce a branch node: a Node carrying children (and optional meta/fallback).
 * Leaf nodes (callables) belong in `children` keyed by name — they ARE nodes,
 * created with `op()`.
 *
 * `api(children, opts?)` — positional children for the common case, an
 * options object for the rare stuff (meta, fallback). `opts` becomes a
 * required argument (and `opts.meta` a required field) when a consumer
 * declaration-merges a required field onto `BranchMeta` — the same
 * `HasRequiredKeys<BranchMeta>` rest-tuple technique `op()` uses above
 * (against `LeafMeta`), applied to a single options object instead of a
 * spread of contributions. `opts.meta` is single-valued (no fold), so unlike
 * `op()`'s `LeafMeta` check this one is unchanged in kind by the fold-before-
 * check fix (docs/design/meta-role-split-spec.md §2a) — there is nothing to
 * fold, just the one value checked directly.
 *
 * `api()` is the (only) branch-node constructor.
 *
 * Generic in `C` (the exact children map): the input `children` object's
 * per-key `Node<H>` types survive into the result's `children`, instead of
 * widening to `Record<string, Node>`. So `api({ getBook: op(fn) })` yields a
 * `Node` whose `children.getBook.handler` is still `fn`'s real type.
 *
 * Generic in `F` (the exact fallback shape) the same way: `opts.fallback`'s
 * literal `{ name, subtree }` — subtree included — survives into the
 * result's `fallback`, instead of widening `subtree` to the erased `Node`
 * OR widening `name` to plain `string`. Defaults to `undefined` (no
 * `fallback` key on the result at all) when `opts.fallback` isn't passed, so
 * a plain `api(children)` call doesn't grow a spurious optional `fallback`
 * field.
 *
 * `F` is a `const` type parameter (TS 5.0+) — without `const`, TS widens a
 * literal it infers for an object property whose declared type, at the
 * generic-inference site, is a bare (non-generic) `string`; `name: string`
 * inside `F`'s constraint is exactly that site, so `api(children, {
 * fallback: { name: "bookId", subtree } })` would infer `F["name"]` as
 * `string`, not `"bookId"`. `const F` tells inference to keep the argument's
 * literal types (as if every literal in it were written `as const`) rather
 * than widening to their base types — the same effect `as const` has on a
 * value, applied automatically to this parameter's inference. With it,
 * `fallback.name` survives as a literal all the way through `checker
 * .getTypeOfSymbolAtLocation` in tree.ts's walker, no AST fallback needed.
 *
 * Generic in `M` (the exact meta type) the same way as `F`: a `const` type
 * parameter so `api(children, { meta: { mcp: { segment: "products" } } })`
 * infers `M` as the literal `{ readonly mcp: { readonly segment: "products"
 * } } }`, not the widened `{ mcp?: { segment?: string } }` a plain
 * `BranchMeta` parameter would force. Unlike `op()`'s `C` (a tuple of
 * contributions folded via `FoldMeta`), `api()` only ever takes a single
 * `opts.meta` value, so no fold is needed — `M` flows straight through to
 * the result's `meta` field. Defaults to `undefined` (mirroring `F`'s
 * default), in which case the result falls back to the erased `BranchMeta`
 * — `api()`'s own `meta` field is always PRESENT on `Node` (unlike
 * `fallback`, which is optional), so the `undefined` case widens to
 * `BranchMeta` rather than omitting the field. This is what lets a branch's
 * `meta.mcp.segment` survive as a literal into tree.ts's `mcpMetaOverride`
 * walk, matching how `op()`'s meta contributions already do for a leaf's
 * `meta.mcp.name` — see tree.ts's module doc comment for the walker side of
 * this fix.
 *
 * See docs/design/routing-and-transforms.md § DX — constructor sugar.
 */
export function api<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  C extends Readonly<Record<string, Node<any>>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F extends { readonly name: string; readonly subtree: Node<any> } | undefined = undefined,
  const M extends BranchMeta | undefined = undefined,
>(
  children: C,
  ...rest: HasRequiredKeys<BranchMeta> extends true
    ? [opts: { meta: M; fallback?: F }]
    : [opts?: { meta?: M; fallback?: F }]
): Omit<Node, "children" | "fallback" | "meta">
  & { readonly children: C }
  & { readonly meta: Widen<M extends undefined ? BranchMeta : Simplify<M>> }
  & (F extends undefined ? object : { readonly fallback: F }) {
  const opts = rest[0]
  return {
    ...(children !== undefined ? { children } : {}),
    ...(opts?.fallback !== undefined ? { fallback: opts.fallback } : {}),
    meta: opts?.meta ?? {},
  } as Omit<Node, "children" | "fallback" | "meta">
    & { readonly children: C }
    & { readonly meta: Widen<M extends undefined ? BranchMeta : Simplify<M>> }
    & (F extends undefined ? object : { readonly fallback: F })
}
