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

/** A named key-value interface over a single input source. */
export interface Store {
  get(key: string): unknown
}

/**
 * Registry of store names, populated via declaration merging. The base
 * interface is empty; each projector augments it with the store names it
 * defines (e.g. HTTP adds `path`/`query`/`header`/`body`), so that
 * `stores.someStore` is a compile-time error unless some projector actually
 * declares `someStore`. See http-api-projector/src/decode.ts,
 * cli-api-projector/src/cli.ts, mcp-api-projector/src/server.ts for the
 * `declare module` augmentations.
 *
 * `caller` is declared HERE, in api-tree, rather than per-projector — unlike
 * `path`/`query`/`header`/etc. (which are genuinely projector-specific), every
 * projector populates a `caller` store (auth/identity context; see
 * docs/design/middleware-and-caller-context.md), so it belongs on the shared
 * registry instead of being redundantly declared three times. HTTP populates
 * it from auth headers/cookies, CLI from environment, MCP from the SDK's
 * `authInfo`/`sessionId` — see each projector's stores factory
 * (`httpStores`, `buildInput`, `assembleInput`).
 */
export interface StoreRegistry {
  caller: true
}

/**
 * All input stores available for a given request/invocation. Values are
 * optional: `StoreRegistry` is declaration-merged globally across every
 * projector that's part of a given compilation (e.g. `tsc` type-checking
 * the whole monorepo pulls in HTTP's, CLI's, and MCP's augmentations at
 * once), but any single projector only ever builds the subset of stores it
 * actually defines. Optional values keep construction sound per-projector
 * while still making `stores.someUndeclaredName` a compile-time error —
 * that's the property this type exists to enforce, not "every registered
 * store is always present."
 */
export type Stores = Readonly<{ [K in keyof StoreRegistry]?: Store }>

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
// Store helper
// ============================================================================

/** Wrap a plain object as a Store — property access as `get`. */
export function createStore(obj: Record<string, unknown>): Store {
  return { get: (key) => obj[key] }
}

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
  stores: Stores,
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
    values[name] = src ? byName[src.store]?.get(src.key ?? name) : undefined
  }

  return values
}
