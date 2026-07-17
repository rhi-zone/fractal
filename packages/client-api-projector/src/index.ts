// packages/client-api-projector/src/index.ts — @rhi-zone/fractal-client-api-projector
//
// Runtime HTTP client — now built directly on the HTTP projector's own
// `HttpRoute` tree instead of re-walking the raw `Node` tree.
//
// Previously this module re-derived verb/segment/path from `meta.http`
// directives (via `verbFromTags`/a locally-duplicated `inferSegment`) with
// its own self-contained tree walk. That duplicated exactly what the
// HttpRoute pipeline (`naiveTransform` → `applyMethods`/`applyMoveTo`/
// `applyResponse`, see packages/http-api-projector/src/route.ts) already
// computes: after the rewriters run, the tree's structure IS the URL
// structure — children keys are path segments, `fallback` is the wildcard
// segment, and `methods` is already keyed by the resolved HTTP verb. Walking
// `HttpRoute` needs no segment inference, no verb derivation, no
// dispatch-marker interpretation.
//
// One wrinkle `applyMoveTo` introduces: co-located operations (e.g.
// read/replace/remove all placed onto the same fallback position, one of the
// motivating examples in docs/design/routing-and-transforms.md) collapse
// into one route position's `methods` map, keyed by GET/PUT/DELETE — the
// original Node child names ("read"/"replace"/"remove") are gone from the
// route tree. Unlike OpenAPI's operationId (cosmetic), the client's method
// names ARE its public API (`client.books.bookId(id).read()`), so this
// package uses the same handler-identity mapping trick as the OpenAPI
// migration (see toOpenApi's `buildNameMap`) to recover them: `createClient`
// walks the original `Node` tree once to build a `Handler -> own child key`
// map and threads it through the `HttpRoute` walk. `createClientFromRoute`
// (no `Node` available) degrades gracefully to the lowercased HTTP verb as
// the member name for a co-located entry — still correct, just less
// conventional (mirrors `toOpenApiFromRoute`'s `nameFromPath` degradation).
//
// Two entry points:
//   - `createClientFromRoute(route, opts)` — the core: walks an already-
//     projected `HttpRoute` tree. No `Node` needed for path/verb correctness;
//     only co-located method names degrade (see above).
//   - `createClient(node, opts)` — convenience: projects `node` via
//     `httpProjection` (the standard rewriter pipeline) and also walks the
//     raw `Node` tree once to build the handler → own-key name map, so
//     co-located members keep their authored names
//     (`.read()`/`.replace()`/`.remove()`), unchanged from before this
//     migration.
//
// The client is an ENUMERATING projection (like OpenAPI/CLI-help), not a
// dispatching one (see docs/design/router-model.md — "Projections"): it walks
// the WHOLE tree once at construction time to build the proxy, computing each
// leaf's verb + concrete path (with fallback slug values substituted directly
// as the proxy is navigated, rather than via a template filled later).
//
// A `fallback` (wildcard-capture) node becomes a function keyed by its
// `fallback.name`, taking the slug value and returning the sub-client for the
// bound subtree:
//   client.books.bookId("book-1").read()
//
// TODO(client): typed client via codegen from source — the current shape uses
// unknown/generics everywhere. A typed surface requires codegen'd input/output
// types per leaf, which is a future milestone.
//
// See:
//   packages/http-api-projector/src/route.ts    — HttpRoute, naiveTransform, rewriters
//   packages/http-api-projector/src/dx.ts       — httpProjection preset
//   packages/api-tree/src/node.ts               — Node, Handler, fallback, isLeaf

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node"
import { httpProjection } from "@rhi-zone/fractal-http-api-projector/dx"
import type { HttpRoute } from "@rhi-zone/fractal-http-api-projector/route"
import { ClientError } from "./client-error.ts"

export { ClientError } from "./client-error.ts"

// ============================================================================
// Public API types
// ============================================================================

export type ClientOptions = {
  /** Base URL prepended to every request path. Defaults to "" (relative). */
  readonly baseUrl?: string
  /**
   * Fetch implementation to use. Defaults to global `fetch`.
   * Inject `createFetch(tree)` from @rhi-zone/fractal-http-api-projector/preset for in-process
   * round-trip tests without a network.
   */
  readonly fetch?: (req: Request) => Promise<Response>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClient = Record<string, any>

type FetchImpl = (req: Request) => Promise<Response>

// ============================================================================
// Internal: handler → own-key name map, built from the raw Node tree
//
// Unlike OpenAPI's `buildNameMap` (which accumulates a dotted path from the
// root, since operationIds must be globally unique), the client only needs a
// handler's OWN authored child key — the map is keyed by handler IDENTITY,
// so unrelated handlers sharing the same key name elsewhere in the tree
// (e.g. two different resources each having a "list" op) never collide.
// This is what lets a co-located handler (moved by `applyMoveTo` onto its
// parent's fallback position) keep its authored name
// (read/replace/remove) as a client member instead of surfacing as the
// HTTP verb it was assigned.
// ============================================================================

function collectHandlerNames(n: Node, out: Map<Handler, string>): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(child.handler!, key)
    } else {
      collectHandlerNames(child, out)
    }
  }
  if (n.fallback !== undefined) {
    collectHandlerNames(n.fallback.subtree, out)
  }
}

/** Build the handler → own-child-key name map for a Node tree — see doc above. */
function buildHandlerNames(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>()
  collectHandlerNames(n, out)
  return out
}

// ============================================================================
// Internal: leaf caller
// ============================================================================

function makeCaller(
  verb: string,
  path: string,
  slugValues: ReadonlySet<string>,
  baseUrl: string,
  fetchImpl: FetchImpl,
): (input?: unknown) => Promise<unknown> {
  return async (input?: unknown): Promise<unknown> => {
    let req: Request
    if (verb === "GET" || verb === "HEAD" || verb === "DELETE") {
      // Input goes into query params for read-only/deletion ops; body is not
      // conventional for GET/HEAD/DELETE.
      const finalUrl = baseUrl.startsWith("http")
        ? new URL(path, baseUrl)
        : new URL(path, "http://localhost")
      if (input !== null && input !== undefined && typeof input === "object") {
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
          if (slugValues.has(k)) continue // already embedded in the path
          if (v !== undefined && v !== null) {
            finalUrl.searchParams.set(k, String(v))
          }
        }
      }
      const url = baseUrl.startsWith("http")
        ? finalUrl.toString()
        : finalUrl.pathname + (finalUrl.search !== "" ? finalUrl.search : "")
      req = new Request(url, { method: verb })
    } else {
      // POST/PUT/PATCH: input as JSON body
      const url = `${baseUrl}${path}`
      req = new Request(url, {
        method: verb,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
      })
    }

    const res = await fetchImpl(req)

    let body: unknown
    const ct = res.headers.get("Content-Type") ?? ""
    if (ct.includes("application/json")) {
      body = await res.json()
    } else {
      body = await res.text()
    }

    if (!res.ok) {
      throw new ClientError(res.status, body)
    }

    return body
  }
}

// ============================================================================
// Internal: recursive sub-client builder over HttpRoute
//
// A route position with exactly one method and no children/fallback is a
// true leaf (mirrors the old `isLeaf` check) — it becomes a callable
// directly. Any other position (multiple methods co-located via
// `applyMoveTo`, and/or children, and/or a fallback) becomes an object:
// each method entry contributes a named callable (name from `handlerNames`
// when available, else the lowercased verb), each child recurses under its
// path-segment key, and `fallback` becomes a `(slug) => sub-client` function.
// ============================================================================

function isSingleLeafMethod(route: HttpRoute): boolean {
  return (
    Object.keys(route.methods ?? {}).length === 1 &&
    Object.keys(route.children ?? {}).length === 0 &&
    route.fallback === undefined
  )
}

function buildClientNode(
  route: HttpRoute,
  path: string,
  slugValues: ReadonlySet<string>,
  baseUrl: string,
  fetchImpl: FetchImpl,
  handlerNames: ReadonlyMap<Handler, string> | undefined,
): AnyClient | ((input?: unknown) => Promise<unknown>) {
  if (isSingleLeafMethod(route)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [verb] = Object.keys(route.methods!)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return makeCaller(verb!, path, slugValues, baseUrl, fetchImpl)
  }

  const client: AnyClient = {}

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const name = handlerNames?.get(entry.handler) ?? verb.toLowerCase()
    client[name] = makeCaller(verb, path, slugValues, baseUrl, fetchImpl)
  }

  for (const [seg, child] of Object.entries(route.children ?? {})) {
    client[seg] = buildClientNode(child, `${path}/${seg}`, slugValues, baseUrl, fetchImpl, handlerNames)
  }

  if (route.fallback !== undefined) {
    const { name, subtree } = route.fallback
    client[name] = (slugValue: string): AnyClient =>
      buildClientNode(
        subtree,
        `${path}/${slugValue}`,
        new Set([...slugValues, name]),
        baseUrl,
        fetchImpl,
        handlerNames,
      ) as AnyClient
  }

  return client
}

// ============================================================================
// createClientFromRoute — public API (core)
// ============================================================================

/**
 * Build a runtime HTTP client from an already-projected `HttpRoute` tree.
 * Path and verb come directly from the route tree's own structure (children
 * keys, `fallback`, `methods` keys), exactly matching what
 * `makeRouterFromRoute` dispatches against.
 *
 * Co-located method entries (multiple HTTP methods placed at the same route
 * position via `applyMoveTo`) surface as members named by their lowercased
 * HTTP verb (`.get()`/`.put()`/`.delete()`), since a bare `HttpRoute` has no
 * memory of the authored Node child key a moved handler started at. Use
 * `createClient(node, opts)` when the original `Node` tree is available to
 * recover the authored names (e.g. `.read()`/`.replace()`/`.remove()`).
 *
 * @param route - The (already rewritten) HttpRoute tree to project.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClientFromRoute(route: HttpRoute, opts: ClientOptions = {}): AnyClient {
  const baseUrl = opts.baseUrl ?? ""
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  return buildClientNode(route, "", new Set(), baseUrl, fetchImpl, undefined) as AnyClient
}

// ============================================================================
// createClient — public API (Node convenience wrapper)
// ============================================================================

/**
 * Build a runtime HTTP client from a `Node` tree. Internally projects `n`
 * via `httpProjection` (the standard `naiveTransform` +
 * `applyMethods`/`applyMoveTo`/`applyResponse` pipeline — the same one
 * `createFetch`/`httpRoutes` use) and also walks the raw `Node` tree once to
 * build a handler → own-key name map, so co-located operations keep their
 * authored member names.
 *
 * The returned object mirrors the route tree structure:
 *   - branch children → nested client objects
 *   - a `fallback` → a function `(slug: string) => sub-client` keyed by
 *     `fallback.name`
 *   - a route position with a single method and no children/fallback → an
 *     async callable `(input?) => Promise<unknown>`
 *   - a route position with multiple co-located methods and/or children → an
 *     object whose method entries are named callables
 *
 * @param n - The root node to project.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClient(n: Node, opts: ClientOptions = {}): AnyClient {
  const route = httpProjection(n)
  const handlerNames = buildHandlerNames(n)
  const baseUrl = opts.baseUrl ?? ""
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  return buildClientNode(route, "", new Set(), baseUrl, fetchImpl, handlerNames) as AnyClient
}
