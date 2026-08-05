// packages/api-tree/src/input.ts — @rhi-zone/fractal-api-tree
//
// Shared input-source resolution mechanism: a request/invocation is exposed
// as named stores — uniform key-value interfaces over all input sources
// (path, query, header, body for HTTP; flag, positional for CLI; argument
// for MCP; ...). An assembler reads params from stores based on conventions
// + optional per-param overrides.
//
// Extracted from packages/http-api-projector/src/decode.ts, which had the
// first well-factored version of this pipeline. That projector's Stores/
// SourceMap/assemble live on, re-exported from here (see follow-up wiring
// task) so CLI and MCP projectors — which had parallel-but-separate or
// entirely absent resolution logic — can share one mechanism.
//
// The convention: each projector defines its own "primary store" — the
// default source for params not explicitly overridden — and, optionally,
// a set of path/positional param names that always take precedence. HTTP's
// convention: GET/HEAD/DELETE → "query", POST/PUT/PATCH → "body", with
// route-slug params always from "path".

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
export type Store = Record<string, unknown>

/**
 * The `caller` store's shape — auth/identity context, populated by every
 * projector (see `CoreStores.caller`). Deliberately `Store` (a plain bag of
 * unknown-typed fields) at the CORE declaration: no single concrete shape
 * unifies HTTP's raw header pass-through, CLI's environment, and MCP's
 * `authInfo`/`sessionId` + optional `createMessage`/`sendLog`. A deployment
 * wanting a richer `caller` composes it in its own augmentation, the same way
 * it composes any other store member (docs/design/typed-store-spec.md §2).
 */
export type CallerStoreShape = Store

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
  caller: CallerStoreShape
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
 * All input stores available for a given request/invocation — an IDENTITY
 * projection over `StoreRegistry`, deliberately NOT a `Partial<>`-style
 * blanket-`?` mapped type. Each member's own optionality, declared by whoever
 * added that member, survives unchanged to every read site: an optional
 * projector store needs a guard (`stores.query?.q`), a required service store
 * does not (`stores.tabularSource.read(...)`). Blanket-optionaling every member
 * here would make a required service store silently `| undefined` again — the
 * exact hole docs/design/typed-store-spec.md §9(2) rules out.
 *
 * `stores.someUndeclaredName` remains a compile-time error, unchanged — that
 * property is what this type has always existed to enforce.
 */
export type Stores = Readonly<{ [K in keyof StoreRegistry]: StoreRegistry[K] }>

/**
 * The keys of `StoreRegistry` whose members are REQUIRED (no `?`) — the
 * service-store kind, per `StoreRegistry`'s doc above. `-?` strips optionality
 * before the `{} extends Pick<...>` probe so an already-optional member is the
 * one that resolves to `never`.
 */
export type RequiredStoreKeys = {
  [K in keyof StoreRegistry]-?: {} extends Pick<StoreRegistry, K> ? never : K
}[keyof StoreRegistry]

/**
 * The required members a DEPLOYMENT must supply — `RequiredStoreKeys` minus the
 * ones core declares itself (`caller`, which every projector builds per-request
 * rather than the deployment registering once).
 */
export type RequiredServiceStoreKeys = Exclude<RequiredStoreKeys, keyof CoreStores>

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
 * Deliberately one object, checked once — a required store supplied ad hoc at
 * several call sites (each building its own partial `Stores`-shaped value)
 * loses exactly the completeness property this type exists to provide
 * (§9(6)). Projector data stores are NOT registered here; they stay
 * per-request-built by the dispatching projector, which is precisely what their
 * optionality buys.
 *
 * Resolves to `{}` in a compilation whose merged registry declares no service
 * stores at all — a deployment with none simply never needs the registration
 * site.
 */
export type ServiceStores = Readonly<Pick<StoreRegistry, RequiredServiceStoreKeys>>

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
export type ProjectorStores = Omit<Stores, RequiredServiceStoreKeys>

// ============================================================================
// Per-param source override
// ============================================================================

/**
 * Declares where a specific parameter should be read from, overriding the
 * default convention. Used for cases like pulling a param from a header or
 * from a query param on a POST request.
 */
export interface ParamSource {
  readonly store: string
  readonly key?: string // defaults to param name when omitted
}

/**
 * Map of param names to their source overrides. Only params listed here
 * diverge from the convention; all others follow the primary-store rule.
 */
export type SourceMap = Readonly<Record<string, ParamSource>>

// ============================================================================
// source() authoring helper — shared machinery for every protocol's
// `<proto>.source(map)`
//
// The literal-key-preserving mapped type and the shorthand-expansion runtime
// logic used to be http-api-projector-only (`verbs.ts`'s `SourceMapInput`/
// `ResolvedSourceMap`/`source()`, pre-dating this generalization). Extracted
// here so cli/mcp/graphql/json-rpc can each grow their own thin
// `<proto>.source()` helper without re-deriving the same mapped type per
// package — see docs/design/wire-profiles-and-staged-validation.md's
// "Prerequisite: meta unification" §"UncoveredSourceParams generalizes".
//
// Why a helper is needed at all, not just a raw object literal passed to
// `op()`: raw literals DO stay literal-keyed today (TS's `const C` inference
// on `op()`'s own `contributions` parameter), but nothing enforces that
// property against `sourceMap`'s declared type on each protocol's
// `LeafMetaProperties` — a value passed through any intermediately-typed
// variable or helper widens `sourceMap` back to the index-signature
// `SourceMap`, silently defeating `UncoveredSourceParams`/`FindStoreForParam`
// for that param the same way an un-exact-typed HTTP verb bundle would (see
// `VerbBundle`'s doc comment, http-api-projector's verbs.ts, for the
// original hazard this same shape guards against for verb bundles). A
// `source()` helper makes literal-preservation the DEFAULT authoring path
// instead of an accidental property of writing the object literal inline.
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
>

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
    : M[K] & ParamSource
}

/**
 * Expands a `SourceMapInput`'s string shorthand to full `ParamSource` entries
 * — the runtime half of `ResolvedSourceMap`. Shared by every protocol's
 * `source()` helper so the expansion logic (and the literal-preserving
 * `const M` inference on the caller's map argument) lives in exactly one
 * place, not once per protocol.
 */
export function resolveSourceMap<const M extends SourceMapInput>(map: M): ResolvedSourceMap<M> {
  const sourceMap: Record<string, ParamSource> = {}
  for (const [key, value] of Object.entries(map)) {
    sourceMap[key] = typeof value === "string" ? { store: value, key } : value
  }
  return sourceMap as ResolvedSourceMap<M>
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
// Simpler than the directive-array-era version this replaces (pre the http-
// directive-dissolution migration, docs/design/wire-profiles-and-staged-
// validation.md's "Prerequisite: meta unification" section): there is no
// tuple to walk and no "last match wins" scan, because `mergeMeta`/`FoldMeta`
// (node.ts) already resolve N composed `source()`-style contributions into
// ONE flat `sourceMap` value, last-wins per key, before this module ever sees
// it (node.ts's `MergeMetaValue`/`mergeRecords` doc comments cover the depth-
// capped "keyed, whole-value-replace" merge this relies on).
// ============================================================================

/**
 * A handler's declared input keys. `never` for a handler that takes no input
 * (and `string` for one typed against an open `Record<string, unknown>`), both
 * of which make the coverage check below vacuous rather than wrong.
 */
export type InputKeys<H> = H extends (input: infer I) => any ? keyof I : never

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
type OwnKeys<T> = { [K in keyof T as string extends K ? never : K]: T[K] }

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
  ? NS extends { readonly sourceMap: infer M } ? M : never
  : never

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
export type FindStoreForParam<Meta, P extends string> = SourceMapsOf<Meta> extends infer NS
  ? NS extends unknown
    ? string extends keyof NS
      ? never
      : P extends keyof NS
        ? NS[P] extends { readonly store: infer S } ? S : never
        : never
    : never
  : never

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
export type DeclaredSourceParams<Meta> = SourceMapsOf<Meta> extends infer NS
  ? NS extends unknown
    ? string extends keyof NS ? never : keyof NS & string
    : never
  : never

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
    : Exclude<DeclaredSourceParams<Meta>, InputKeys<H>>

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
      return { store: "path", key: name }
    }
    if (name in sourceMap) {
      return sourceMap[name]!
    }
    if (primaryStore) {
      return { store: primaryStore, key: name }
    }
    return undefined
  }

  // Store names are resolved dynamically here (from sourceMap/pathParamNames,
  // both plain strings) — `Stores` is intentionally narrowed to the
  // declaration-merged StoreRegistry for call sites that access it by
  // literal key, so this internal lookup needs the wider index signature.
  const byName = stores as Readonly<Record<string, Store | undefined>>

  const values: Record<string, unknown> = {}
  for (const name of paramNames) {
    const src = resolve(name)
    values[name] = src ? byName[src.store]?.[src.key ?? name] : undefined
  }

  return values
}
