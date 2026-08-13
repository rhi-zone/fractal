// Shared input-source resolution mechanism: a request/invocation is exposed
// as named stores — uniform key-value interfaces over all input sources
// (path, query, header, body for HTTP; flag, positional for CLI; argument
// for MCP; ...). An assembler reads params from stores based on conventions
// + optional per-param overrides.
//
// This is the one resolution mechanism every projector shares. http-api-
// projector's Stores/SourceMap/assemble re-export from here, so CLI and MCP
// projectors (which would otherwise each carry their own parallel resolution
// logic) use the same types and the same `assemble` function.
//
// The convention: each projector defines its own "primary store" — the
// default source for params not explicitly overridden — and, optionally,
// a set of path/positional param names that always take precedence. HTTP's
// convention: GET/HEAD/DELETE → "query", POST/PUT/PATCH → "body", with
// route-slug params always from "path".

import type { WireOf, WireProfileName } from "@rhi-zone/fractal-type-ir";

// ============================================================================
// Store interface
// ============================================================================

/**
 * A named key-value interface over a single input source. Plain property
 * access — `store[key]`, not `store.get(key)`. Object-backed stores (path
 * slugs, parsed body, ...) are used directly; method-backed sources
 * (URLSearchParams, Headers) are wrapped in a Proxy with plain-property
 * semantics by the projector that builds them (see `httpStores` in
 * http-api-projector/src/decode.ts) rather than by this shared type.
 */
export type Store = Record<string, unknown>;

/**
 * The `caller` store's shape — auth/identity context, populated by every
 * projector (see `CoreStores.caller`). Deliberately `Store` (a plain bag of
 * unknown-typed fields) at the CORE declaration: no single concrete shape
 * unifies HTTP's raw header pass-through, CLI's environment, and MCP's
 * `authInfo`/`sessionId` + optional `createMessage`/`sendLog`. A deployment
 * wanting a richer `caller` composes it in its own augmentation, the same way
 * it composes any other store member (docs/design/typed-store-spec.md §2).
 */
export type CallerStoreShape = Store;

/**
 * The store members CORE itself declares, split out from `StoreRegistry` (which
 * `StoreRegistry` then extends) purely so `RequiredServiceStoreKeys` has a way
 * to tell a core-owned required member apart from a DEPLOYMENT-provided one.
 * Nothing else should reference this — read sites use `Stores`.
 *
 * `caller` is declared HERE, in api-tree, rather than per-projector — unlike
 * `path`/`query`/`header`/etc. (which are genuinely projector-specific), every
 * projector populates a `caller` store (auth/identity context; see
 * docs/design/middleware-and-caller-context.md), so it belongs on the shared
 * registry instead of being redundantly declared three times. HTTP populates
 * it from auth headers/cookies, CLI from environment, MCP from the SDK's
 * `authInfo`/`sessionId` — see each projector's stores factory
 * (`httpStores`, `buildInput`, `assembleArgumentInput`).
 */
export interface CoreStores {
  caller: CallerStoreShape;
}

/**
 * Registry of store names AND their value shapes, populated via declaration
 * merging. Core declares only `caller` (via `CoreStores`); a DEPLOYMENT's own
 * single augmentation file adds everything else, by extending the inert
 * fragment interfaces each projector exports (`HttpStores`, `CliStores`,
 * `McpStores`, `JsonRpcStores`, `GraphQLStores`) plus whatever service stores
 * that deployment provides. Projector packages never augment this themselves —
 * see docs/design/typed-store-spec.md §3, and the sibling rule for `Meta` in
 * docs/design/meta-role-split-spec.md §9(4): a projector-owned `declare module`
 * makes the type surface depend on which packages happen to be in the
 * compilation rather than on what the deployment actually composes.
 *
 * Two KINDS of member coexist here, distinguished by OPTIONALITY alone (not by
 * a second registry or a wrapper type) — see `Stores`:
 *
 * - **Projector-built, per-request data stores** (`path`, `query`, `body`,
 *   `flag`, `argument`, `params`, …) are declared OPTIONAL, because any single
 *   projector only ever builds the subset it defines: a compilation merging
 *   HTTP's and CLI's fragments together doesn't mean a given request populates
 *   both.
 * - **Deployment-provided, long-lived service stores** (a tabular-data source,
 *   a domain read-model, …) are declared REQUIRED, because the deployment's
 *   single registration site (`ServiceStores`) is checked structurally against
 *   every required member — a missing one is a compile error THERE, not a
 *   silent `undefined` at some read site later.
 */
export interface StoreRegistry extends CoreStores {}

/**
 * All input stores available for a given request/invocation — an identity
 * projection over `StoreRegistry`, not a `Partial<>`-style blanket-`?` mapped
 * type. Each member's own optionality, declared by whoever added that
 * member, survives unchanged to every read site: an optional projector store
 * needs a guard (`stores.query?.q`), a required service store does not
 * (`stores.tabularSource.read(...)`). A blanket-optional mapped type would
 * make a required service store silently `| undefined` again, the exact hole
 * docs/design/typed-store-spec.md §9(2) rules out.
 *
 * `stores.someUndeclaredName` is a compile-time error — the property this
 * type exists to enforce.
 */
export type Stores = Readonly<{ [K in keyof StoreRegistry]: StoreRegistry[K] }>;

/**
 * The keys of `StoreRegistry` whose members are REQUIRED (no `?`) — the
 * service-store kind, per `StoreRegistry`'s doc above. `-?` strips optionality
 * before the `{} extends Pick<...>` probe so an already-optional member is the
 * one that resolves to `never`.
 */
export type RequiredStoreKeys = {
  [K in keyof StoreRegistry]-?: {} extends Pick<StoreRegistry, K> ? never : K;
}[keyof StoreRegistry];

/**
 * The required members a DEPLOYMENT must supply — `RequiredStoreKeys` minus the
 * ones core declares itself (`caller`, which every projector builds per-request
 * rather than the deployment registering once).
 */
export type RequiredServiceStoreKeys = Exclude<RequiredStoreKeys, keyof CoreStores>;

/**
 * The single registration object a deployment supplies for its service stores
 * (docs/design/typed-store-spec.md §4). Annotate ONE `const` at the composition
 * root with this type and a missing service store is a compile error at that
 * site:
 *
 * ```ts
 * const serviceStores: ServiceStores = {
 *   tabularSource: createSomeTabularSource(...),
 * }
 * ```
 *
 * One object, checked once, at the composition root: this is what makes the
 * completeness property (§9(6)) hold — a required store supplied ad hoc
 * across several call sites, each building its own partial `Stores`-shaped
 * value, would not be checked anywhere. Projector data stores are not
 * registered here; they stay per-request-built by the dispatching projector,
 * which is precisely what their optionality buys.
 *
 * Resolves to `{}` in a compilation whose merged registry declares no service
 * stores at all — a deployment with none simply never needs the registration
 * site.
 */
export type ServiceStores = Readonly<Pick<StoreRegistry, RequiredServiceStoreKeys>>;

/**
 * The portion of the merged registry a PROJECTOR builds on its own, per
 * request: everything in `Stores` except the deployment-registered service
 * stores. Each projector's own bag type is this intersected with its exported
 * fragment (`HttpStoreBag = ProjectorStores & HttpStores`, and so on).
 *
 * Derived from `Stores` by `Omit`, NOT by re-mapping with a `?` modifier —
 * every remaining member keeps its own declared optionality (`caller` stays
 * REQUIRED here, projector data stores stay optional), so this is not a
 * back-door reintroduction of the blanket-optional shape
 * docs/design/typed-store-spec.md §9(2) rules out. `Stores` itself is
 * unchanged and remains the read-site type.
 *
 * Why the split exists: §4 has a service store merged into the per-request bag
 * by threading the registered `ServiceStores` value into each projector's own
 * store-builder — but §8 explicitly defers HOW that threading reaches each of
 * the five projectors' preset options ("an implementation-order question").
 * Until it lands, a projector genuinely does not have the service stores in
 * hand when it builds a request's bag, and this type says exactly that instead
 * of overstating what a builder produces. When the threading does land, each
 * `XStoreBag` widens back to `Stores & XStores` and this type goes away.
 */
export type ProjectorStores = Omit<Stores, RequiredServiceStoreKeys>;

// ============================================================================
// Per-param source override
// ============================================================================

/**
 * Declares where a specific parameter should be read from, overriding the
 * default convention. Used for cases like pulling a param from a header or
 * from a query param on a POST request.
 */
export interface ParamSource {
  readonly store: string;
  readonly key?: string; // defaults to param name when omitted
}

/**
 * Map of param names to their source overrides. Only params listed here
 * diverge from the convention; all others follow the primary-store rule.
 */
export type SourceMap = Readonly<Record<string, ParamSource>>;

/**
 * One `meta.<NS>.encodingMap` entry's two authorable shapes (phase B/E,
 * docs/design/wire-profiles-and-staged-validation.md): a base-profile-name
 * STRING (`WireProfileName` — `"identity" | "json" | "query" | "argv"`)
 * naming one of type-ir's uniform wire profiles outright, or a custom
 * decoder FUNCTION run at WRAP time (`apply-validation.ts`'s
 * `createApplyValidation`) instead of the fused default decode — see
 * `readMetaEncodingMapProfileNames`/`readMetaEncodingMapFunctionFields`
 * (tree.ts) for how codegen reads each form off a leaf's own `meta`
 * statically.
 *
 * The function arm is typed maximally permissively (`(w: never) =>
 * unknown`, assignable-from any concrete decoder signature by ordinary
 * function-type contravariance) rather than pinned to a specific `(w: X) =>
 * Y` — this field's declared type only needs to answer "is a callable
 * allowed here at all", the same EXISTENCE-only question
 * `readMetaEncodingMapFunctionFields` asks of the checker; a REAL decoder's
 * own param/return types are checked elsewhere, against the literal object
 * actually passed to `op()`, never against this declared field type (see
 * `MismatchedEncodingMapDecoders`/`EncodingMapWireOf` below, and
 * `SourceMapInput`'s own doc comment two sections down for the general
 * "declared-field-type vs. checked-literal" split this mirrors for
 * `sourceMap`). Pinning it narrower here would buy nothing (the exactness
 * check already lives downstream) and would risk exactly the kind of
 * widening-through-a-typed-intermediate hazard that comment warns about.
 */
export type EncodingMap = Readonly<Record<string, WireProfileName | ((w: never) => unknown)>>;

// ============================================================================
// source() authoring helper — shared machinery for every protocol's
// `<proto>.source(map)`
//
// The literal-key-preserving mapped type and the shorthand-expansion runtime
// logic live here so cli/mcp/graphql/json-rpc can each grow their own thin
// `<proto>.source()` helper without re-deriving the same mapped type per
// package — see docs/design/wire-profiles-and-staged-validation.md's
// "Prerequisite: meta unification" §"UncoveredSourceParams generalizes".
//
// A `source()` helper matters because a raw object literal is not enough on
// its own: TS's `const C` inference on `op()`'s own `contributions` parameter
// keeps a literal's keys literal today, but nothing enforces that against
// `sourceMap`'s declared type on each protocol's `LeafMetaProperties` — a
// value passed through any intermediately-typed variable or helper widens
// `sourceMap` back to the index-signature `SourceMap`, silently defeating
// `UncoveredSourceParams`/`FindStoreForParam` for that param, the same hazard
// an un-exact-typed HTTP verb bundle has (see `VerbBundle`'s doc comment,
// http-api-projector's verbs.ts, for the original case this shape guards
// against). A `source()` helper makes literal-preservation the default
// authoring path instead of an accidental property of writing the object
// literal inline.
// ============================================================================

/**
 * The shorthand input a `<proto>.source(map)` helper accepts: each key's
 * value is either a bare store name (shorthand for `{ store, key: <param
 * name> }`) or a full `ParamSource`-shaped override. Generic in `Store` so
 * each protocol's own helper can narrow it to that protocol's registered
 * store names (e.g. HTTP's `HttpStore`, a declaration-mergeable registry —
 * see http-api-projector's `HttpStoreRegistry`); defaults to plain `string`
 * for a protocol that has no such registry yet.
 */
export type SourceMapInput<Store extends string = string> = Readonly<
  Record<string, Store | { readonly store: Store; readonly key?: string }>
>;

/**
 * The `SourceMap` a `SourceMapInput` expands to, with each key's own literal
 * association PRESERVED — the type-level counterpart of the shorthand
 * expansion `resolveSourceMap` performs at runtime (a bare `"query"` becomes
 * `{ store: "query", key: <param name> }`).
 *
 * Homomorphic over `M`, so a `const`-inferred literal input (`{ year:
 * "query" }`) yields a literal output (`{ year: { store: "query"; key:
 * "year" } }`) rather than collapsing to `Readonly<Record<string,
 * ParamSource>>`. That literal association is exactly what a type-level read
 * of a namespace's `sourceMap` needs to answer "which store does param X
 * come from" — see `FindStoreForParam` above.
 *
 * Both branches are written to be PROVABLY `ParamSource`-shaped for a still-
 * generic `M` (the shorthand branch by intersecting the store with `string`,
 * the full-form branch by intersecting the input entry with `ParamSource`
 * itself) — a conditional type does not narrow `M[K]` in either branch, so
 * without those intersections `ResolvedSourceMap<M>` cannot satisfy
 * `SourceMap`'s own index-signature constraint.
 */
export type ResolvedSourceMap<M extends SourceMapInput> = {
  readonly [K in keyof M]: M[K] extends string
    ? { readonly store: M[K] & string; readonly key: K & string }
    : M[K] & ParamSource;
};

/**
 * Expands a `SourceMapInput`'s string shorthand to full `ParamSource` entries
 * — the runtime half of `ResolvedSourceMap`. Shared by every protocol's
 * `source()` helper so the expansion logic (and the literal-preserving
 * `const M` inference on the caller's map argument) lives in exactly one
 * place, not once per protocol.
 */
export function resolveSourceMap<const M extends SourceMapInput>(map: M): ResolvedSourceMap<M> {
  const sourceMap: Record<string, ParamSource> = {};
  for (const [key, value] of Object.entries(map)) {
    sourceMap[key] = typeof value === "string" ? { store: value, key } : value;
  }
  return sourceMap as ResolvedSourceMap<M>;
}

// ============================================================================
// Static source coverage — the type-level half of the resolution order
//
// docs/design/typed-store-spec.md §6 splits "where does this param come from"
// by how much of it `op()` can see at its own call site. Only ONE of the three
// resolution steps is statically visible there: the per-param overrides a
// `source()`-style helper declares, which live in the leaf's own meta as a
// flat, namespaced `sourceMap` key (`meta.http.sourceMap`, `meta.cli.sourceMap`,
// …). The other two are NOT, and are not papered over here:
//
//   - a PATH-param match depends on where the leaf is mounted in the tree, which
//     is a property of the tree passed to `api()`, not of the leaf's own `op()`
//     arguments (§6, fourth bullet: a structural block, not an engineering gap);
//   - the primary-store CONVENTION under a projector's no-`paramNames` fallback
//     resolves against the live request's own keys, so there is no
//     compile-time-fixed param set to check at all (§6, fifth bullet).
//
// Both of those are covered by a WIRE-TIME runtime check instead — see
// http-api-projector's `checkRouteSourceCoverage` (route.ts), which runs once
// when the route tree is built, the first point at which mount position and a
// codegen'd `paramNames` list both exist.
//
// These types are projector-BLIND: they key off the `{ sourceMap: SourceMap }`
// shape, whose vocabulary (`ParamSource`/`SourceMap`) this module already owns,
// and never off any particular projector's meta namespace — the walk looks for
// a `sourceMap` field under ANY namespace of the folded meta, unioning every
// namespace that declares one (a leaf shared across two protocols may carry
// independent overrides under each protocol's own namespace, e.g. both
// `meta.http.sourceMap` and `meta.cli.sourceMap`).
//
// There is no tuple to walk and no "last match wins" scan here (see
// docs/design/wire-profiles-and-staged-validation.md's "Prerequisite: meta
// unification" section for the fuller resolution-order picture), because
// `mergeMeta`/`FoldMeta` (node.ts) already resolve N composed
// `source()`-style contributions into ONE flat `sourceMap` value, last-wins
// per key, before this module ever sees it (node.ts's `MergeMetaValue`/
// `mergeRecords` doc comments cover the depth-capped "keyed, whole-value-
// replace" merge this relies on).
// ============================================================================

/**
 * A handler's declared input keys. `never` for a handler that takes no input
 * (and `string` for one typed against an open `Record<string, unknown>`), both
 * of which make the coverage check below vacuous rather than wrong.
 */
export type InputKeys<H> = H extends (input: infer I) => any ? keyof I : never;

/**
 * `T`'s own EXPLICIT keys only — drops an index signature's own contribution
 * to `keyof T` (which is exactly the primitive `string`/`number` itself,
 * never a literal), via a key-remapping `as` clause: for a real literal key
 * `K` (e.g. `"http"`), `string extends K` is false, so it survives; for the
 * index signature's own synthetic membership in `keyof T` (`K` = `string`
 * itself), `string extends K` is true, so it's excluded. Needed because
 * `Node["meta"]`'s own declared field type (and `op()`'s return type) is
 * `SharedMeta & { readonly [key: string]: unknown }` (node.ts's `Widen`) —
 * without this filter, `keyof` a Widened meta object collapses to bare
 * `string` (the literal keys are absorbed into the wider index signature),
 * which in turn collapses `T[keyof T]` to `unknown` — verified empirically
 * (scratch `tsc`) to silently break `SourceMapsOf` below for the exact shape
 * `typeof someNode.meta` produces, not just some contrived edge case.
 */
type OwnKeys<T> = { [K in keyof T as string extends K ? never : K]: T[K] };

/**
 * The `sourceMap` value(s) carried by any namespace of a folded meta object —
 * a union across every namespace that declares one (`OwnKeys<Meta>[keyof
 * OwnKeys<Meta>]` distributes over the namespace-key union, e.g. `http` and
 * `tags`; only a namespace actually shaped `{ sourceMap: ... }` contributes a
 * member, everything else resolves to `never` and drops out of the union).
 * Filtered through `OwnKeys` (above) so this works identically whether `Meta`
 * is the clean `FoldMeta<C>` `op()`'s own static check uses, or the Widened
 * `typeof node.meta` a caller might reasonably pass instead.
 */
type SourceMapsOf<Meta> = OwnKeys<Meta>[keyof OwnKeys<Meta>] extends infer NS
  ? NS extends { readonly sourceMap: infer M }
    ? M
    : never
  : never;

/**
 * Resolve which store param `P` reads from, given a folded `Meta` object —
 * reads each namespace's flat `sourceMap` directly (see module doc above for
 * why there's no tuple to walk or "last wins" scan anymore: `mergeMeta`
 * already resolved that before `op()`'s own contributions reach here).
 * `never` when no namespace's `sourceMap` names `P` at all (i.e. `P` falls
 * through to the path/convention steps, which are runtime-resolved).
 *
 * `NS extends unknown` re-distributes over `SourceMapsOf<Meta>`'s own union
 * (multiple namespaces, e.g. `http` and `cli`, each independently declaring
 * `P`) so a match under ANY namespace is found, not just the first.
 *
 * Skips any `sourceMap` that is type-ERASED (`string extends keyof M`) for
 * the same reason `DeclaredSourceParams` does: a producer typed as the open
 * DU (rather than the exact variant it constructs, see
 * docs/design/wire-profiles-and-staged-validation.md's "Exact-variant
 * hygiene") would otherwise phantom-contribute an index-signature map whose
 * `keyof` is `string`, resolving every param to a false match. An erased map
 * carries no per-key information to check against, so contributing nothing is
 * also the honest answer.
 */
export type FindStoreForParam<Meta, P extends string> =
  SourceMapsOf<Meta> extends infer NS
    ? NS extends unknown
      ? string extends keyof NS
        ? never
        : P extends keyof NS
          ? NS[P] extends { readonly store: infer S }
            ? S
            : never
          : never
      : never
    : never;

/**
 * Every param name any namespace's `sourceMap` in `Meta` declares an override
 * for — `never` for a `sourceMap` that is type-ERASED (an index-signature
 * `SourceMap`, i.e. `string extends keyof M`).
 *
 * That erased-map guard is load-bearing, not defensive: a producer typed as
 * the open DU rather than the exact variant it constructs would otherwise
 * phantom-contribute a `sourceMap` whose `keyof` is `string`, failing the
 * coverage check for every param. Exact-variant hygiene (verb bundles and
 * every other `http.*` producer typed as the precise shape they build, never
 * the open union) is what keeps this guard from ever firing in practice — see
 * `VerbBundle`'s doc comment (http-api-projector's verbs.ts).
 *
 * Distributes over `SourceMapsOf<Meta>`'s own union (naked `NS`), so N
 * namespaces (or, before folding, N `source()`-style contributions already
 * folded into one `sourceMap` per namespace) yield the UNION of their
 * declared params — not, as a non-distributed `keyof (M1 | M2)` would, their
 * intersection.
 */
export type DeclaredSourceParams<Meta> =
  SourceMapsOf<Meta> extends infer NS
    ? NS extends unknown
      ? string extends keyof NS
        ? never
        : keyof NS & string
      : never
    : never;

/**
 * The `source()`-declared param names a handler does NOT declare as an input —
 * `never` when coverage is clean. A non-`never` result is a real defect: the
 * override is assembled into a param the handler never reads, while the param
 * the author MEANT to override silently falls through to the convention.
 *
 * This is the one piece of §6's three-step resolution order that is statically
 * checkable at `op()`, and it is checked there (see `op()`'s `contributions`).
 *
 * Deliberately VACUOUS whenever the handler's input keys are not statically
 * known — `never` (a handler declaring no input, or one typed against
 * `unknown`) and `string` (an open `Record<string, unknown>`) both short-
 * circuit to "no complaint". Without those two guards the check fires on every
 * handler whose input type is erased, which is a false positive about the
 * HANDLER's typing rather than a finding about the source override; a check
 * that only speaks when it actually knows the key set is the one worth having.
 */
export type UncoveredSourceParams<H, Meta> = [InputKeys<H>] extends [never]
  ? never
  : string extends InputKeys<H>
    ? never
    : Exclude<DeclaredSourceParams<Meta>, InputKeys<H>>;

// ============================================================================
// Function-form `encodingMap` decoder typing — decision 3, docs/design/
// wire-profiles-and-staged-validation.md's implementation-trace addendum for
// this phase ("Decoder entries in op()'s contributions should type-check as
// `(w: WireOf<H[K], ResolvedStore>) => H[K]`... following the
// UncoveredSourceParams/CheckedContributions precedent").
//
// Scoped to exactly `http`/`cli` — the two namespaces `wire-derive.ts`'s own
// `deriveFieldProfiles` hardcodes as the per-field (composite) protocols;
// mcp/graphql/jsonrpc/identity resolve to one UNIFORM profile for the whole
// leaf (no per-field store derivation exists for them at all — see
// `apply-validation-build.ts`'s own header comment: "Applying `encodingMap`
// overrides to the UNIFORM protocols... is a further, deliberate scope
// cut"), so a function-form entry under any other namespace has nothing to
// check against here and is left alone (same silent-omission posture the
// STRING form already has for those protocols).
//
// Hardcoding these two namespace KEYS (not importing `HttpLeafMeta`/
// `CliLeafMeta`) keeps this file protocol-BLIND in the same sense
// `SourceMapsOf`/`FindStoreForParam` above already are: api-tree cannot
// depend on http-api-projector/cli-api-projector (the dependency runs the
// other way), so this only ever reads `Meta["http"]`/`Meta["cli"]`
// STRUCTURALLY, by literal key, never by importing either package's own
// meta-fragment interface.
//
// Exactness: a field with no explicit `sourceMap` entry could, at `op()`
// time, either be a path-slug match or fall through to the protocol's own
// default store, and which one it is is unknowable here regardless of
// `moveTo`. A leaf's path-slug binding is a pure function of its authored
// ancestry — the local, pre-`moveTo` path segments it's nested under
// (`http-api-projector`'s `Sources.authoredPathParams`) — not of where
// `moveTo` eventually relocates it (`fix(http-api-projector): moveTo no
// longer affects input binding`). `wire-derive.ts`'s codegen sees that
// authored ancestry because it statically walks the whole call-site tree, so
// its own derivation is exact (see that module's header comment). `op()`'s
// own type-level check has no equivalent visibility: it type-checks the leaf
// in isolation, before the leaf is composed into a tree — that composition
// (nesting under `path(...)`, which establishes the authored ancestry) only
// happens afterward, at the caller's composition site, which `op()`'s own
// `Meta` argument carries no trace of. The ambiguity is `op()`'s own
// ancestry-blindness at invocation time; `moveTo` itself is irrelevant to
// it. Whether that ambiguity forces a real type-level union depends on
// whether "path" and the default store map to the same wire profile:
//   - CLI: `cliStoreEncoding` is constant (every store maps to
//     `argvProfile`) — "path" and CLI's default store ("flag") always
//     agree, so this is never ambiguous. `ResolvedStoresForField` below
//     still returns a two-member union structurally, but
//     `EncodingMapWireOf`'s distribution collapses it to one type once
//     `WireOf` maps both through the same profile.
//   - HTTP: `httpStoreEncoding` maps `"body"` to `jsonProfile`, everything
//     else (including `"path"`) to `queryProfile`. The default store is
//     `primaryStoreForMethod(method)`: `query` for GET/HEAD/DELETE (or an
//     absent method literal — `wire-derive.ts`'s own `method ?? "GET"`
//     default), `body` otherwise. So:
//       - GET/HEAD/DELETE (or no method authored) — the default store is
//         `"query"`, matching `"path"`'s own profile: not ambiguous.
//       - any other method — the default store is `"body"` (`jsonProfile`),
//         which differs from `"path"`'s `queryProfile` for any coercing
//         kind (`number`/`boolean`/`Date` — confirmed empirically:
//         `WireOf<number,"query">` is `string`, `WireOf<number,"json">` is
//         `number`). For this one case, a field with no explicit override
//         cannot be resolved to a single store at `op()` time — the type is
//         the union `WireOf<T,"query"> | WireOf<T,"json">`, the doc's own
//         suggested fallback ("default to the union... when it can't
//         statically rule out a path-slug match").
//
// Net result: not fully exact in general. The gap is real but narrow — it
// only bites an HTTP field with (a) a non-GET/HEAD/DELETE method authored at
// `op()` time, (b) no explicit `sourceMap` entry for that field, and (c) a
// domain type whose query-vs-json wire shapes actually differ (a coercing
// leaf kind — plain `string` fields are unaffected, since `WireOf<string,
// P>` is `string` under every profile). Concretely, it misses a decoder
// typed narrower than the true union — e.g. one that only handles the
// numeric-string case and mishandles a genuine same-key JSON-body number
// this leaf might also receive if it turns out not to be authored under a
// same-named path slug after all — and it allows (does not force) a decoder
// to handle both shapes even when the leaf's authored ancestry would only
// ever deliver one. Both directions are the sound-but-imprecise side of
// `op()`'s inability to see its own authored ancestry at invocation time —
// the design doc's own decision 3 names this as an open question, not a bug
// in this implementation.
// ============================================================================

/** `Meta["http"]`/`Meta["cli"]`, structurally — `undefined` when that
 * namespace contributed nothing. Hardcoded to these two literal keys (see
 * this section's header comment for why that's not a protocol-blindness
 * violation). */
type HttpNamespaceOf<Meta> = Meta extends { readonly http?: infer NS } ? NS : undefined;
type CliNamespaceOf<Meta> = Meta extends { readonly cli?: infer NS } ? NS : undefined;

/** The HTTP method `op()`'s own contributions declared — `meta.http.method`
 * wins, else `meta.http.verb` (mirroring `extractWireApplyValidationTypeRefs`'s
 * own `readMetaStringLiteral(..., "method", ...) ?? readMetaStringLiteral(...,
 * "verb", ...)` read order), else `"GET"` — `wire-derive.ts`'s own
 * `primaryStoreForMethod(method ?? "GET")` default for an unauthored method. */
type HttpMethodOf<Meta> =
  HttpNamespaceOf<Meta> extends { readonly method: infer M extends string }
    ? M
    : HttpNamespaceOf<Meta> extends { readonly verb: infer V extends string }
      ? V
      : "GET";

/** `wire-derive.ts`'s `primaryStoreForMethod`, at the type level: GET/HEAD/
 * DELETE -> `"query"`, everything else -> `"body"`. */
type HttpDefaultStore<Meta> =
  HttpMethodOf<Meta> extends "GET" | "HEAD" | "DELETE" ? "query" : "body";

/** `wire-derive.ts`'s `httpStoreEncoding`/`cliStoreEncoding`, at the type
 * level — a store name to a `WireProfileName`. */
type StoreProfile<NS extends "http" | "cli", Store extends string> = NS extends "http"
  ? Store extends "body"
    ? "json"
    : "query"
  : "argv";

/** One namespace's `sourceMap` value, structurally (not via `SourceMapsOf`,
 * which unions EVERY namespace — this needs exactly one, scoped to `NS`). */
type NamespaceSourceMapOf<Meta, NS extends "http" | "cli"> = NS extends "http"
  ? HttpNamespaceOf<Meta> extends { readonly sourceMap?: infer M }
    ? M
    : never
  : CliNamespaceOf<Meta> extends { readonly sourceMap?: infer M }
    ? M
    : never;

/** The single, EXACT store an explicit `sourceMap` entry names for field `P`
 * under namespace `NS` — `never` when there is no explicit entry (the caller
 * falls through to `FallbackStoresForField` below), mirroring
 * `FindStoreForParam`'s own erased-map guard (`string extends keyof M`). */
type ExplicitStoreForField<Meta, NS extends "http" | "cli", P extends string> =
  NamespaceSourceMapOf<Meta, NS> extends infer M
    ? [M] extends [never]
      ? never
      : string extends keyof M
        ? never
        : P extends keyof M
          ? M[P] extends { readonly store: infer S }
            ? S
            : never
          : never
    : never;

/** The store(s) a field with NO explicit `sourceMap` entry might resolve to
 * — `"path"` (an authored local path-slug name match, unknowable from `op()`
 * alone) UNIONED with the protocol's own default store. See this section's
 * header comment for when this union is real vs. vacuous. */
type FallbackStoresForField<Meta, NS extends "http" | "cli"> = NS extends "http"
  ? "path" | HttpDefaultStore<Meta>
  : "path" | "flag";

/** Every store field `P` (under namespace `NS`) might resolve to, given
 * `Meta` — the explicit override when one exists, else the fallback union. */
type ResolvedStoresForField<Meta, NS extends "http" | "cli", P extends string> = [
  ExplicitStoreForField<Meta, NS, P>,
] extends [never]
  ? FallbackStoresForField<Meta, NS>
  : ExplicitStoreForField<Meta, NS, P>;

/**
 * The type a function-form `meta.<NS>.encodingMap[P]` decoder's PARAMETER
 * should accept, given the field's own domain type `T` — a real, computed
 * `WireOf` union over every store `P` might resolve to (distributes over
 * `ResolvedStoresForField`'s own union, naturally producing ONE type when
 * every candidate store maps to the same profile — see this section's
 * header comment's exactness finding).
 */
export type EncodingMapWireOf<Meta, NS extends "http" | "cli", P extends string, T> =
  ResolvedStoresForField<Meta, NS, P> extends infer S
    ? S extends string
      ? WireOf<T, StoreProfile<NS, S>>
      : never
    : never;

/** `Meta["http"].encodingMap` / `Meta["cli"].encodingMap`, structurally. */
type NamespaceEncodingMapOf<Meta, NS extends "http" | "cli"> = NS extends "http"
  ? HttpNamespaceOf<Meta> extends { readonly encodingMap?: infer M }
    ? M
    : never
  : CliNamespaceOf<Meta> extends { readonly encodingMap?: infer M }
    ? M
    : never;

/** `H`'s single declared input parameter's type — `never` for a handler with
 * no parameter. */
type HandlerInput<H> = H extends (input: infer I) => any ? I : never;

/**
 * Every field name, under namespace `NS`, whose `encodingMap` entry is a
 * FUNCTION whose param/return types do NOT match
 * `(w: EncodingMapWireOf<Meta, NS, P, HandlerInput<H>[P]>) => HandlerInput<H>[P]`
 * — `never` when every function-valued entry type-checks (or there are
 * none). A string-valued entry (base-profile-name override, the phase-B
 * form) is not a function and is correctly skipped — it has nothing for
 * this check to validate; codegen fuses it directly.
 *
 * Vacuous (never fires) when `HandlerInput<H>` isn't a plain object with
 * statically known keys (mirrors `UncoveredSourceParams`'s own "no
 * complaint when the handler's input keys are erased" posture) — a false
 * positive about the HANDLER's own typing is not this check's job.
 */
export type MismatchedEncodingMapDecoders<H, Meta, NS extends "http" | "cli"> =
  NamespaceEncodingMapOf<Meta, NS> extends infer M
    ? [M] extends [never]
      ? never
      : string extends keyof HandlerInput<H>
        ? never
        : {
            [P in Extract<keyof M, string>]: P extends keyof HandlerInput<H>
              ? M[P] extends (w: infer W) => infer R
                ? [(w: W) => R] extends [
                    (w: EncodingMapWireOf<Meta, NS, P, HandlerInput<H>[P]>) => HandlerInput<H>[P],
                  ]
                  ? never
                  : P
                : never
              : never;
          }[Extract<keyof M, string>]
    : never;

// ============================================================================
// Assembler
// ============================================================================

/**
 * Build the handler's input bag by reading named params from stores.
 *
 * Resolution order for each param:
 *   1. If the param name matches a path/positional param → read from "path".
 *   2. If the param has an explicit override in `sourceMap` → read from that.
 *   3. Otherwise → read from the primary store (projector-derived convention).
 *
 * `pathParamNames` is optional: HTTP uses it for slug params captured from
 * the URL path; projectors without that concept (e.g. MCP) can omit it.
 *
 * Callers that need to report where a param came from (e.g. a validator
 * formatting an error) can consult `sourceMap[param] ?? { store: primaryStore,
 * key: param }` directly — the sourceMap passed in here already is the
 * provenance record, so `assemble` doesn't need to hand back a second one.
 */
export function assemble(
  stores: ProjectorStores,
  paramNames: readonly string[],
  sourceMap: SourceMap,
  primaryStore: string,
  pathParamNames: readonly string[] = [],
): Record<string, unknown> {
  const resolve = (name: string): ParamSource | undefined => {
    if (pathParamNames.includes(name)) {
      return { store: "path", key: name };
    }
    if (name in sourceMap) {
      return sourceMap[name]!;
    }
    if (primaryStore) {
      return { store: primaryStore, key: name };
    }
    return undefined;
  };

  // Store names are resolved dynamically here (from sourceMap/pathParamNames,
  // both plain strings) — `Stores` is intentionally narrowed to the
  // declaration-merged StoreRegistry for call sites that access it by
  // literal key, so this internal lookup needs the wider index signature.
  const byName = stores as Readonly<Record<string, Store | undefined>>;

  const values: Record<string, unknown> = {};
  for (const name of paramNames) {
    const src = resolve(name);
    values[name] = src ? byName[src.store]?.[src.key ?? name] : undefined;
  }

  return values;
}
