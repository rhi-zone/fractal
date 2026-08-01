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
