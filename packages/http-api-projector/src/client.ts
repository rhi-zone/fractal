// packages/http-api-projector/src/client.ts — @rhi-zone/fractal-http-api-projector
//
// Runtime HTTP client — merged into http-api-projector (2026-07-18): the
// client builds HTTP requests and derives verbs/paths from `HttpRoute`, so
// it's inherently an HTTP concern rather than a separate projection package
// (same reasoning as the OpenAPI merge — see `openapi.ts`'s module doc).
// Built directly on this package's own `HttpRoute` tree instead of
// re-walking the raw `Node` tree.
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
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import type { TypedClient } from "@rhi-zone/fractal-api-tree"
import { httpProjection } from "./dx.ts"
import type { HttpRoute } from "./route.ts"
import { ClientError } from "./client-error.ts"
import { composeDecodeResponse, composeFetch } from "./extension.ts"
import type { ClientExtension } from "./extension.ts"

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
  /**
   * Per-request timeout in milliseconds, applied via `AbortSignal.timeout`.
   * Overridable per-call via `CallOptions.timeout`. Unset by default (no
   * timeout — existing behavior).
   */
  readonly timeout?: number
  /**
   * An `AbortSignal` that cancels every request made by this client (e.g. a
   * component-lifetime or navigation signal). Combined with `timeout` (if
   * both set) via `AbortSignal.any`. Overridable per-call via
   * `CallOptions.signal`.
   */
  readonly signal?: AbortSignal
  /**
   * Extensions composing around the fetch implementation — retry, request/
   * response interceptors, a fixed timeout, or a user-authored
   * `ClientExtension`. Applied outermost-first (see extension.ts's module
   * doc). Composed once at client construction, wrapping every call this
   * client makes. See `packages/http-api-projector/src/extensions/` for the
   * built-ins and `./extension.ts` for the API a custom extension implements.
   */
  readonly extensions?: readonly ClientExtension[]
}

/** Per-call overrides for `timeout`/`signal`, layered on top of the client-level `ClientOptions`. */
export type CallOptions = {
  /** Overrides the client-level `timeout` for this call only. */
  readonly timeout?: number
  /** Overrides the client-level `signal` for this call only. */
  readonly signal?: AbortSignal
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClient = Record<string, any>

type FetchImpl = (req: Request) => Promise<Response>

// ============================================================================
// Internal: timeout/signal resolution
//
// A fresh `AbortSignal.timeout(ms)` is created PER CALL (not once at client
// construction) — a timeout signal starts its clock the moment it's created,
// so a shared one would only ever fire on the client's first slow call.
// Per-call `CallOptions` fully override (not merge with) the client-level
// `timeout`/`signal` — this mirrors how a caller would expect "just this one
// request, no timeout" (`{ timeout: undefined }` can't distinguish "unset"
// from "clear the default", so an explicit override replaces, not merges).
// ============================================================================

function resolveSignal(
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  callOpts: CallOptions | undefined,
): AbortSignal | undefined {
  const timeout = callOpts?.timeout ?? baseTimeout
  const signal = callOpts?.signal ?? baseSignal
  const timeoutSignal = timeout !== undefined ? AbortSignal.timeout(timeout) : undefined
  if (timeoutSignal !== undefined && signal !== undefined) return AbortSignal.any([signal, timeoutSignal])
  return timeoutSignal ?? signal
}

/** Rethrow abort-driven fetch failures with a message that distinguishes timeout from user cancellation. */
function describeAbort(err: unknown, verb: string, path: string, timeout: number | undefined): Error {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new Error(`Request timed out after ${timeout}ms: ${verb} ${path}`)
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new Error(`Request aborted: ${verb} ${path}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

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
// Internal: handler → full codegen-name map, built from the raw Node tree
//
// A SEPARATE convention from `buildHandlerNames` above (own key only): this
// one accumulates the full underscore-joined path from the root, exactly
// matching `extractToolSchemas`'s own naming (see api-tree/src/tree.ts) and
// codegen.ts's `buildCodegenNameMap` — the key a `SchemaMap` is indexed by.
// Duplicated here rather than imported/shared, matching this package's
// existing convention of each projector deriving these facts via its own
// self-contained walk (openapi.ts's `buildNameMap`, codegen.ts's own
// `buildCodegenNameMap`; see openapi.ts's module doc: "Two projectors, two
// encodings of the same fact"). Threaded into `DecodeContext.codegenName` so
// an extension (e.g. `extensions/validation.ts`) can look up this operation's
// entry in a `SchemaMap` without re-deriving tree-position naming itself.
// ============================================================================

function collectCodegenNames(n: Node, prefix: string, out: Map<Handler, string>): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    const seg = prefix.length > 0 ? `${prefix}_${key}` : key
    if (isLeaf(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(child.handler!, seg)
    } else {
      collectCodegenNames(child, seg, out)
    }
  }
  if (n.fallback !== undefined) {
    const seg = prefix.length > 0 ? `${prefix}_${n.fallback.name}` : n.fallback.name
    collectCodegenNames(n.fallback.subtree, seg, out)
  }
}

/** Build the handler → full codegen-name map for a Node tree — see doc above. */
function buildCodegenNames(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>()
  collectCodegenNames(n, "", out)
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
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  extensions: readonly ClientExtension[] | undefined,
  meta: Meta,
  codegenName: string | undefined,
): (input?: unknown, callOpts?: CallOptions) => Promise<unknown> {
  return async (input?: unknown, callOpts?: CallOptions): Promise<unknown> => {
    const timeout = callOpts?.timeout ?? baseTimeout
    const signal = resolveSignal(baseTimeout, baseSignal, callOpts) ?? null

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
      req = new Request(url, { method: verb, signal })
    } else {
      // POST/PUT/PATCH: input as JSON body
      const url = `${baseUrl}${path}`
      req = new Request(url, {
        method: verb,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
        signal,
      })
    }

    let res: Response
    try {
      res = await fetchImpl(req)
    } catch (err) {
      throw describeAbort(err, verb, path, timeout)
    }

    const decoded = composeDecodeResponse(res, { request: req, refetch: fetchImpl, meta, codegenName }, extensions)
    if (decoded !== undefined) return decoded.value

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
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  extensions: readonly ClientExtension[] | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
): AnyClient | ((input?: unknown, callOpts?: CallOptions) => Promise<unknown>) {
  if (isSingleLeafMethod(route)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [verb] = Object.keys(route.methods!)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const entry = route.methods![verb!]!
    return makeCaller(
      verb!,
      path,
      slugValues,
      baseUrl,
      fetchImpl,
      baseTimeout,
      baseSignal,
      extensions,
      entry.meta,
      codegenNames?.get(entry.handler),
    )
  }

  const client: AnyClient = {}

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const name = handlerNames?.get(entry.handler) ?? verb.toLowerCase()
    client[name] = makeCaller(
      verb,
      path,
      slugValues,
      baseUrl,
      fetchImpl,
      baseTimeout,
      baseSignal,
      extensions,
      entry.meta,
      codegenNames?.get(entry.handler),
    )
  }

  for (const [seg, child] of Object.entries(route.children ?? {})) {
    client[seg] = buildClientNode(
      child,
      `${path}/${seg}`,
      slugValues,
      baseUrl,
      fetchImpl,
      handlerNames,
      baseTimeout,
      baseSignal,
      extensions,
      codegenNames,
    )
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
        baseTimeout,
        baseSignal,
        extensions,
        codegenNames,
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
  const fetchImpl = composeFetch(opts.fetch ?? globalThis.fetch.bind(globalThis), opts.extensions)
  return buildClientNode(
    route,
    "",
    new Set(),
    baseUrl,
    fetchImpl,
    undefined,
    opts.timeout,
    opts.signal,
    opts.extensions,
    undefined,
  ) as AnyClient
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
 * The return type is `TypedClient<N, CallOptions>` (see
 * @rhi-zone/fractal-api-tree's typed-client.ts): computed structurally from
 * `n`'s own type, so `client.books.bookId(id).read()` is typed all the way
 * down to the handler's real input/output — no `AnyClient`/`any` at the call
 * site. Only the return TYPE changed here; the runtime proxy (`buildClientNode`)
 * is unchanged and still built dynamically.
 *
 * @param n - The root node to project.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClient<N extends Node>(n: N, opts: ClientOptions = {}): TypedClient<N, CallOptions> {
  const route = httpProjection(n)
  const handlerNames = buildHandlerNames(n)
  const codegenNames = buildCodegenNames(n)
  const baseUrl = opts.baseUrl ?? ""
  const fetchImpl = composeFetch(opts.fetch ?? globalThis.fetch.bind(globalThis), opts.extensions)
  return buildClientNode(
    route,
    "",
    new Set(),
    baseUrl,
    fetchImpl,
    handlerNames,
    opts.timeout,
    opts.signal,
    opts.extensions,
    codegenNames,
  ) as TypedClient<N, CallOptions>
}
