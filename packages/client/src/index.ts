// packages/client/src/index.ts — @rhi-zone/fractal-client
//
// Runtime HTTP client derived from the function-core tree.
//
// createClient(tree, opts?) walks the Node tree and returns a nested proxy
// object that mirrors the tree structure. Each op becomes a callable that
// fires an HTTP request to the matching server route. Method + path come from
// buildRoutes so they EXACTLY match what the server's makeRouter expects.
//
// ParamNode convention: a ParamNode becomes a function taking the slug value,
// returning the sub-client for that node. Example:
//   client.books.byId("book-1").details()
//
// TODO(client): typed client via codegen from source — the current shape uses
// unknown/generics everywhere. A typed surface requires codegen'd input/output
// types per op, which is a future milestone.
//
// See:
//   packages/http/src/project.ts — buildRoutes, Route, verbFromTags
//   packages/core/src/node.ts    — Node, ParamNode, isParamNode

import { isParamNode } from "@rhi-zone/fractal-core/node"
import type { Node } from "@rhi-zone/fractal-core/node"
import { buildRoutes } from "@rhi-zone/fractal-http/project"
import type { Route } from "@rhi-zone/fractal-http/project"
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
   * Inject `createFetch(tree)` from @rhi-zone/fractal-http/preset for in-process
   * round-trip tests without a network.
   */
  readonly fetch?: (req: Request) => Promise<Response>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClient = Record<string, any>

// ============================================================================
// Internal: fill path template with accumulated slug values
// ============================================================================

/**
 * Replace `{param}` segments in a route path with slug values collected
 * during tree traversal. Unrecognised placeholders are left as-is.
 */
function fillPath(path: string, slugs: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => slugs[name] ?? `{${name}}`)
}

// ============================================================================
// Internal: correlate op handler identity to Route
// ============================================================================

/**
 * Build a handler→Route map from the route table.
 * Handler function identity is the stable correlation key between the tree
 * walk and the route table (buildRoutes stores Op["fn"] directly as handler).
 */
function buildHandlerMap(routes: Route[]): Map<Route["handler"], Route> {
  const map = new Map<Route["handler"], Route>()
  for (const r of routes) {
    map.set(r.handler, r)
  }
  return map
}

// ============================================================================
// Internal: recursive sub-client builder
// ============================================================================

function buildSubClient(
  n: Node,
  handlerMap: Map<Route["handler"], Route>,
  slugs: Record<string, string>,
  baseUrl: string,
  fetchImpl: (req: Request) => Promise<Response>,
): AnyClient {
  const client: AnyClient = {}

  // Ops become callables
  for (const [name, o] of Object.entries(n.ops)) {
    const route = handlerMap.get(o.fn)
    if (route === undefined) {
      // Should not happen in a well-formed tree; surface as a noop that throws
      client[name] = async () => {
        throw new Error(`fractal-client: no route found for op "${name}" — tree/route table mismatch`)
      }
      continue
    }

    const verb = route.verb
    const pathTemplate = route.path

    client[name] = async (input?: unknown): Promise<unknown> => {
      const filledPath = fillPath(pathTemplate, slugs)
      const url = `${baseUrl}${filledPath}`

      let req: Request
      if (verb === "GET" || verb === "HEAD" || verb === "DELETE") {
        // Input goes into query params for read-only ops; body is not
        // conventional for GET/HEAD. DELETE carries no body.
        const u = new URL(url, "http://localhost")
        if (input !== null && input !== undefined && typeof input === "object") {
          for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
            // Skip slug keys that are already embedded in the path
            if (slugs[k] !== undefined) continue
            if (v !== undefined && v !== null) {
              u.searchParams.set(k, String(v))
            }
          }
        }
        // Reconstruct URL: preserve the original host from baseUrl if present,
        // otherwise use the full URL with the localhost-relative trick.
        const finalUrl = baseUrl.startsWith("http")
          ? (() => {
              const base = new URL(baseUrl)
              base.pathname = filledPath
              for (const [k, v] of u.searchParams) base.searchParams.set(k, v)
              return base.toString()
            })()
          : u.pathname + (u.search !== "" ? u.search : "")
        req = new Request(finalUrl, { method: verb })
      } else {
        // POST/PUT/PATCH: input as JSON body
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

  // Children: static → sub-client object; ParamNode → function(slug) → sub-client
  for (const [key, child] of Object.entries(n.children)) {
    if (isParamNode(child)) {
      // ParamNode: expose as a function receiving the slug value
      const paramName = child.name
      const subtree = child.subtree
      client[key] = (slugValue: string): AnyClient => {
        return buildSubClient(
          subtree,
          handlerMap,
          { ...slugs, [paramName]: slugValue },
          baseUrl,
          fetchImpl,
        )
      }
    } else {
      // Static child: eagerly build its sub-client (slugs are not needed yet)
      client[key] = buildSubClient(child, handlerMap, slugs, baseUrl, fetchImpl)
    }
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
 *   - static children → nested client objects
 *   - ParamNode children → functions `(slug: string) => sub-client`
 *   - ops → async callables `(input?) => Promise<unknown>`
 *
 * Method and path for each op are derived from buildRoutes, guaranteeing
 * exact parity with the server's makeRouter — the same verb/path logic runs
 * on both sides.
 *
 * @param tree - The root Node to project into a client.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClient(tree: Node, opts: ClientOptions = {}): AnyClient {
  const baseUrl = opts.baseUrl ?? ""
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const routes = buildRoutes(tree)
  const handlerMap = buildHandlerMap(routes)
  return buildSubClient(tree, handlerMap, {}, baseUrl, fetchImpl)
}
