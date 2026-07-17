// packages/client-api-projector/src/index.ts — @rhi-zone/fractal-client-api-projector
//
// Runtime HTTP client derived from the function-core tree.
//
// createClient(tree, opts?) walks the Node tree and returns a nested proxy
// object that mirrors the tree structure. Each leaf node (node with handler)
// becomes a callable that fires an HTTP request to the matching server route.
//
// The client is an ENUMERATING projection (like OpenAPI/CLI-help), not a
// dispatching one (see docs/design/router-model.md — "Projections"): it walks
// the WHOLE tree once at construction time to build the proxy, computing each
// leaf's verb + concrete path (with fallback slug values substituted directly
// as the proxy is navigated, rather than via a template filled later). It
// mirrors `verbFromTags`/segment-inference from packages/http-api-projector/src/project.ts
// (imported directly for verb derivation; segment/dispatch-marker resolution
// is duplicated locally — the same self-contained-walk pattern used by
// packages/openapi, to avoid coupling this package to http's dispatch
// internals) so the client's paths exactly match the server's tree-walk router.
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
//   packages/http-api-projector/src/project.ts — verbFromTags, meta.http DU (dispatch/directives)
//   packages/api-tree/src/node.ts    — Node, fallback, isLeaf

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import { verbFromTags } from "@rhi-zone/fractal-http-api-projector/project"
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

// ============================================================================
// Internal: meta.http interpreter (segment / dispatch-marker / legacyPath)
//
// verbFromTags is imported directly (public API of packages/http); segment and
// dispatch-marker resolution are duplicated locally, following the same
// self-contained-walk pattern packages/openapi uses, to avoid depending on
// http's private dispatch internals.
// ============================================================================

type DispatchKind = "method" | "attr"

type ResolvedHttpMeta = {
  readonly segment?: string
  readonly legacyPath?: string
  readonly dispatchKind?: DispatchKind
}

function getHttpMeta(meta: Meta): ResolvedHttpMeta {
  const h = meta.http
  if (typeof h !== "object" || h === null) return {}
  const r = h as { dispatch?: unknown; directives?: unknown }
  const out: { segment?: string; legacyPath?: string; dispatchKind?: DispatchKind } = {}

  if (typeof r.dispatch === "object" && r.dispatch !== null) {
    const d = r.dispatch as Record<string, unknown>
    out.dispatchKind = d.kind === "method" ? "method" : "attr"
  }

  if (Array.isArray(r.directives)) {
    for (const entry of r.directives as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue
      const d = entry as Record<string, unknown>
      if (d.kind === "segment" && typeof d.value === "string") out.segment = d.value
      else if (d.kind === "legacyPath" && typeof d.value === "string") out.legacyPath = d.value
    }
  }

  return out
}

function inferSegment(name: string): string {
  const stripped = name
    .replace(/^(get|list|find|read|create|send|award|delete|remove)/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/^-/, "")
    .toLowerCase()
  return stripped.length > 0 ? stripped : name.toLowerCase()
}

// ============================================================================
// Internal: leaf caller
// ============================================================================

function makeCaller(
  verb: string,
  path: string,
  slugValues: ReadonlySet<string>,
  baseUrl: string,
  fetchImpl: (req: Request) => Promise<Response>,
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
// Internal: recursive sub-client builder
// ============================================================================

function buildSubClient(
  n: Node,
  prefix: string,
  slugValues: ReadonlySet<string>,
  baseUrl: string,
  fetchImpl: (req: Request) => Promise<Response>,
): AnyClient {
  const client: AnyClient = {}
  const dispatchKind = getHttpMeta(n.meta).dispatchKind

  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      const http = getHttpMeta(child.meta)
      const path = http.legacyPath !== undefined
        ? http.legacyPath
        : dispatchKind !== undefined
          ? (prefix === "" ? "/" : prefix) // method/attribute dispatch: leaf shares the parent path
          : `${prefix}/${http.segment ?? inferSegment(key)}`
      client[key] = makeCaller(verbFromTags(child.meta), path, slugValues, baseUrl, fetchImpl)
    } else {
      // Branch child: method-dispatch (or default/no marker) branches still get
      // a segment; header/query/contentType-dispatch branches do NOT (mirrors
      // packages/http-api-projector/src/project.ts's collectCandidates).
      const branchGetsSegment = dispatchKind === undefined || dispatchKind === "method"
      const seg = branchGetsSegment ? (getHttpMeta(child.meta).segment ?? key) : undefined
      const newPrefix = seg !== undefined ? `${prefix}/${seg}` : prefix
      client[key] = buildSubClient(child, newPrefix, slugValues, baseUrl, fetchImpl)
    }
  }

  if (n.fallback !== undefined) {
    const { name, subtree } = n.fallback
    client[name] = (slugValue: string): AnyClient =>
      buildSubClient(subtree, `${prefix}/${slugValue}`, new Set([...slugValues, name]), baseUrl, fetchImpl)
  }

  return client
}

// ============================================================================
// createClient — public entry point
// ============================================================================

/**
 * Build a runtime HTTP client from a Node tree.
 *
 * The returned object mirrors the tree structure:
 *   - branch children → nested client objects
 *   - a `fallback` → a function `(slug: string) => sub-client` keyed by
 *     `fallback.name`
 *   - leaf children (nodes with handler) → async callables `(input?) => Promise<unknown>`
 *
 * Method and path for each leaf are derived the same way the server's
 * tree-walk router derives them, so client and server exactly agree.
 *
 * @param tree - The root Node to project into a client.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClient(tree: Node, opts: ClientOptions = {}): AnyClient {
  const baseUrl = opts.baseUrl ?? ""
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  return buildSubClient(tree, "", new Set(), baseUrl, fetchImpl)
}
