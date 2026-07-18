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

/** All input stores available for a given request/invocation. */
export type Stores = Readonly<Record<string, Store>>

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
// Provenance — where a param was (or would be) resolved from
// ============================================================================

/** Identifies the store + key a param was resolved from. */
export interface Provenance {
  readonly store: string
  readonly key: string
}

/**
 * The result of assembling an input bag: the resolved values, plus a lazy
 * thunk that re-derives provenance for any param name on demand. The thunk
 * re-runs the resolution rules (sourceMap → pathParamNames → primary store)
 * without touching the stores — it costs nothing until called, and answers
 * "where would param X resolve from?" even for params that resolved to
 * `undefined` (missing from their store).
 */
export interface AssemblyResult {
  readonly values: Record<string, unknown>
  readonly provenance: (paramName: string) => Provenance | undefined
}

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
 * Build the handler's input bag by reading named params from stores, and
 * return an `AssemblyResult` pairing the resolved values with a lazy
 * provenance thunk.
 *
 * Resolution order for each param:
 *   1. If the param name matches a path/positional param → read from "path".
 *   2. If the param has an explicit override in `sourceMap` → read from that.
 *   3. Otherwise → read from the primary store (projector-derived convention).
 *
 * `pathParamNames` is optional: HTTP uses it for slug params captured from
 * the URL path; projectors without that concept (e.g. MCP) can omit it.
 */
export function assemble(
  stores: Stores,
  paramNames: readonly string[],
  sourceMap: SourceMap,
  primaryStore: string,
  pathParamNames: readonly string[] = [],
): AssemblyResult {
  const resolve = (name: string): Provenance | undefined => {
    if (pathParamNames.includes(name)) {
      return { store: "path", key: name }
    }
    if (name in sourceMap) {
      const src = sourceMap[name]!
      return { store: src.store, key: src.key ?? name }
    }
    if (primaryStore) {
      return { store: primaryStore, key: name }
    }
    return undefined
  }

  const values: Record<string, unknown> = {}
  for (const name of paramNames) {
    const prov = resolve(name)
    values[name] = prov ? stores[prov.store]?.get(prov.key) : undefined
  }

  return {
    values,
    provenance: (paramName: string) => resolve(paramName),
  }
}
