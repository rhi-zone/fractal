// packages/http/src/project.ts — @rhi-zone/fractal-http
//
// Route-table builder: walks a Node tree and produces a flat Route[].
// Path comes purely from tree structure — no path strings in meta (except
// the legacyPath [DEBT] escape hatch). Verb is derived from the tag lattice
// (readOnly/idempotent/destructive) with a meta.http.verb override.
//
// In the new node model, leaf nodes (nodes with `handler`) are stored in
// `children` alongside branch nodes. A leaf keyed `k` behaves exactly as an
// op keyed `k` did: its key is the path segment, its meta drives the verb.
// Distinction: `isParamNode(child)` for param children, `child.handler` for
// leaf children, otherwise branch children.
//
// See:
//   docs/artifacts/fc-op-kinds/concrete-api-v2.md — tree-walk spec
//   docs/artifacts/fc-op-kinds/tag-set.md         — verb-dispatch lattice

import { isParamNode, isLeaf } from "@rhi-zone/fractal-core/node"
import { resolveTags, effectiveTags } from "@rhi-zone/fractal-core/tags"
import type { Tags } from "@rhi-zone/fractal-core/tags"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-core/node"

// ============================================================================
// Types
// ============================================================================

export type PatternPart =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string }

/**
 * A single match condition applied after path matching.
 *
 * - `method`      — HTTP method must equal `value` (e.g. "GET"). Used for
 *                   method-dispatched nodes; the route's `verb` field mirrors
 *                   this value for autoMethodLayer compatibility.
 * - `header`      — request header `name` must equal `value` (case-insensitive
 *                   header name, case-sensitive value).
 * - `query`       — query parameter `name` must equal `value`.
 * - `contentType` — request Content-Type must include `value` (substring match,
 *                   e.g. "application/json" matches "application/json; charset=utf-8").
 */
export type MatchCondition =
  | { readonly kind: "method"; readonly value: string }
  | { readonly kind: "header"; readonly name: string; readonly value: string }
  | { readonly kind: "query"; readonly name: string; readonly value: string }
  | { readonly kind: "contentType"; readonly value: string }

export type Route = {
  readonly verb: string
  readonly path: string
  readonly pattern: readonly PatternPart[]
  /**
   * Extra match conditions beyond verb+path. Empty for plain routes.
   * Method conditions are captured here AND mirrored in `verb` for
   * autoMethodLayer compatibility.
   * Header/query/contentType conditions are evaluated after path match.
   */
  readonly conditions: readonly MatchCondition[]
  readonly handler: Handler
  readonly meta: Meta
}

// ============================================================================
// Verb derivation from three-valued tag lattice
//
// Dispatch rules (from tag-set.md §"HTTP verb selection"):
//   readOnly = true                   → GET
//   idempotent = true, destructive = true  → DELETE
//   idempotent = true, destructive ≠ true  → PUT   (unknown ≠ true)
//   else (idempotent unknown or false) → POST  (conservative)
//
// meta.http.verb override always wins — checked before tags.
// Tags are three-valued: true / false / undefined (unknown ≠ false).
// ============================================================================

export function verbFromTags(meta: Meta): string {
  // Projection namespace override wins over all tag inference
  const rawHttp = meta.http
  if (typeof rawHttp === "object" && rawHttp !== null) {
    const httpVerb = (rawHttp as Record<string, unknown>).verb
    if (typeof httpVerb === "string") return httpVerb.toUpperCase()
  }

  const tags = resolveTags((meta.tags ?? {}) as Tags)
  // readOnly = true → GET (lattice: safe ⇒ idempotent; safe ⇒ ¬destructive)
  if (tags.readOnly === true) return "GET"
  // idempotent = true, destructive = true → DELETE
  if (tags.idempotent === true && tags.destructive === true) return "DELETE"
  // idempotent = true, destructive ≠ true → PUT (unknown destructive treated as ¬destructive)
  if (tags.idempotent === true) return "PUT"
  // Conservative default: unknown or false idempotent → POST
  return "POST"
}

// ============================================================================
// Segment inference
//
// Strip a leading verb word, kebab-case the rest, lowercase.
// Falls back to the lowercased name when stripping leaves nothing.
// ============================================================================

function inferSegment(name: string): string {
  const stripped = name
    .replace(/^(get|list|find|read|create|send|award|delete|remove)/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/^-/, "")
    .toLowerCase()
  return stripped.length > 0 ? stripped : name.toLowerCase()
}

// ============================================================================
// Path helpers
// ============================================================================

/** Parse a path string into a typed pattern (literal / param segments). */
export function parsePath(path: string): readonly PatternPart[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((seg): PatternPart =>
      seg.startsWith("{") && seg.endsWith("}")
        ? { kind: "param", name: seg.slice(1, -1) }
        : { kind: "literal", value: seg },
    )
}

/** Parse URL path segments (split on "/", empties dropped). */
export function pathSegs(url: string): readonly string[] {
  return new URL(url).pathname.split("/").filter((s) => s.length > 0)
}

/**
 * Match a route pattern against URL path segments.
 * Returns extracted param values (keyed by param name) or null on mismatch.
 */
export function matchRoute(
  pattern: readonly PatternPart[],
  segs: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]
    const s = segs[i]
    if (p === undefined || s === undefined) return null
    if (p.kind === "literal") {
      if (p.value !== s) return null
    } else {
      params[p.name] = s
    }
  }
  return params
}

/** Build a sorted Allow header string from a set of HTTP method strings. */
export function allowHeader(verbs: Iterable<string>): string {
  return [...new Set(verbs)].sort().join(", ")
}

// ============================================================================
// Route-table builder
// ============================================================================

/**
 * Walk a Node tree and produce a flat route table.
 *
 * Path construction (purely from tree structure):
 *   leaf child key       → /{key}  (or /{meta.http.segment} rename)
 *   ParamNode            → /{name} (the param name, wrapped in braces)
 *   branch child key     → /{key}  (or /{meta.http.segment} rename)
 *
 * Tag inheritance: a node tagged `meta.tags: {readOnly: true}` makes all its
 * leaf descendants project to GET unless a closer node overrides via `meta.tags`.
 * Closest-wins: leaf > parent > grandparent (undefined defers upward).
 *
 * [DEBT] meta.http.legacyPath: full-path override, bypasses all tree-walk
 * logic. Use ONLY for external-contract / legacy-URL pinning. Reaching for
 * this is a smell — it divorces address from tree position.
 */
export function buildRoutes(
  n: Node,
  prefix = "",
  tagPath: Array<{ meta?: { tags?: Tags } }> = [],
  inheritedConditions: readonly MatchCondition[] = [],
): Route[] {
  const out: Route[] = []
  const nodePath = [...tagPath, n]

  // Check the dispatch marker on this node
  const thisHttp = getHttpMeta(n.meta)
  const dispatch = thisHttp.dispatch

  if (dispatch === "method") {
    // METHOD DISPATCH: leaf children share the node's own path; verb distinguishes them.
    // Non-leaf children are still segment-dispatched (contribute a path segment).
    const seenVerbs = new Map<string, string>() // verb → child name (for collision error)
    for (const [name, child] of Object.entries(n.children ?? {})) {
      if (isParamNode(child)) {
        // ParamNode under a method-dispatch node: still contributes {name} segment
        out.push(...buildRoutes(child.subtree, `${prefix}/{${child.name}}`, nodePath, inheritedConditions))
      } else if (isLeaf(child)) {
        // Leaf child: resolves to the parent's own path — no per-child segment
        const leafPath = [...nodePath, child]
        const effective = effectiveTags(leafPath)
        const verbMeta: Meta = { ...child.meta, tags: effective }
        const verb = verbFromTags(verbMeta)

        // Collision check: two leaf children must not resolve to the same verb
        const existing = seenVerbs.get(verb)
        if (existing !== undefined) {
          throw new Error(
            `attribute-dispatch collision at "${prefix}": children "${existing}" and "${name}" both resolve to ${verb}`,
          )
        }
        seenVerbs.set(verb, name)

        const path = prefix === "" ? "/" : prefix
        const conditions: readonly MatchCondition[] = [
          ...inheritedConditions,
          { kind: "method", value: verb },
        ]
        out.push({ verb, path, pattern: parsePath(path), conditions, handler: child.handler!, meta: child.meta })
      } else {
        // Branch child under method-dispatch node: still segment-dispatched
        const seg = getHttpMeta(child.meta).segment ?? name
        out.push(...buildRoutes(child, `${prefix}/${seg}`, nodePath, inheritedConditions))
      }
    }
    return out
  }

  if (dispatch !== undefined) {
    // NON-METHOD ATTRIBUTE DISPATCH: leaf children share the node's own path;
    // a condition on the request attribute distinguishes them.
    // Non-leaf children are still segment-dispatched.
    const seenValues = new Map<string, string>() // matchValue → child name (for collision error)

    for (const [name, child] of Object.entries(n.children ?? {})) {
      if (isParamNode(child)) {
        out.push(...buildRoutes(child.subtree, `${prefix}/{${child.name}}`, nodePath, inheritedConditions))
      } else if (isLeaf(child)) {
        // The match value is the child key by default; per-child `when` overrides.
        const childHttp = getHttpMeta(child.meta)
        const matchValue = childHttp.when ?? name

        // Collision check: two children resolving to the same match value
        const existing = seenValues.get(matchValue)
        if (existing !== undefined) {
          throw new Error(
            `attribute-dispatch collision at "${prefix}": children "${existing}" and "${name}" both match value "${matchValue}" for dispatch ${JSON.stringify(dispatch)}`,
          )
        }
        seenValues.set(matchValue, name)

        // Build the condition for this child
        const condition: MatchCondition =
          dispatch.by === "header"
            ? { kind: "header", name: dispatch.name, value: matchValue }
            : dispatch.by === "query"
              ? { kind: "query", name: dispatch.name, value: matchValue }
              : { kind: "contentType", value: matchValue }

        const leafPath = [...nodePath, child]
        const effective = effectiveTags(leafPath)
        const verbMeta: Meta = { ...child.meta, tags: effective }
        const verb = verbFromTags(verbMeta)

        const path = prefix === "" ? "/" : prefix
        const conditions: readonly MatchCondition[] = [...inheritedConditions, condition]
        out.push({ verb, path, pattern: parsePath(path), conditions, handler: child.handler!, meta: child.meta })
      } else {
        // Branch child under a non-method dispatch node.
        // The parent dispatch attribute applies to this branch too: its key (or `when`)
        // is the match value at this dispatch level, and the condition is inherited by
        // all descendant leaves. The branch still contributes NO segment (same-path
        // dispatch), but carries the parent condition down.
        //
        // This enables multi-attribute nesting: a header-dispatch node whose branch
        // children are method-dispatch nodes → leaves carry both conditions.
        const childHttp = getHttpMeta(child.meta)
        const matchValue = childHttp.when ?? name

        // Collision check for branch children with the same match value
        const existingBranch = seenValues.get(matchValue)
        if (existingBranch !== undefined) {
          throw new Error(
            `attribute-dispatch collision at "${prefix}": children "${existingBranch}" and "${name}" both match value "${matchValue}" for dispatch ${JSON.stringify(dispatch)}`,
          )
        }
        seenValues.set(matchValue, name)

        // Build the condition for this branch child (same as for leaf children)
        const branchCondition: MatchCondition =
          dispatch.by === "header"
            ? { kind: "header", name: dispatch.name, value: matchValue }
            : dispatch.by === "query"
              ? { kind: "query", name: dispatch.name, value: matchValue }
              : { kind: "contentType", value: matchValue }

        // Recurse into the branch at the SAME path prefix (no segment added),
        // but with the parent's condition propagated.
        out.push(...buildRoutes(child, prefix, nodePath, [...inheritedConditions, branchCondition]))
      }
    }
    return out
  }

  // DEFAULT: SEGMENT DISPATCH (no dispatch marker)
  for (const [name, child] of Object.entries(n.children ?? {})) {
    if (isParamNode(child)) {
      // ParamNode: contributes {name} segment; recurse into subtree
      out.push(...buildRoutes(child.subtree, `${prefix}/{${child.name}}`, nodePath, inheritedConditions))
    } else if (isLeaf(child)) {
      // Leaf child: this is a callable — build a route for it
      const leafPath = [...nodePath, child]
      const effective = effectiveTags(leafPath)
      // Build a synthetic meta with the effective tags so verbFromTags can do
      // both http.verb override (from leaf's own meta) and tag-derived verb.
      const verbMeta: Meta = { ...child.meta, tags: effective }
      const verb = verbFromTags(verbMeta)
      const http = getHttpMeta(child.meta)

      if (http.legacyPath !== undefined) {
        // [DEBT] escape hatch: full-path override skips all tree-walk logic
        const path = http.legacyPath
        out.push({ verb, path, pattern: parsePath(path), conditions: [...inheritedConditions], handler: child.handler!, meta: child.meta })
      } else {
        const seg = http.segment ?? inferSegment(name)
        const path = `${prefix}/${seg}`
        out.push({ verb, path, pattern: parsePath(path), conditions: [...inheritedConditions], handler: child.handler!, meta: child.meta })
      }
    } else {
      // Branch child: static child — key is the default segment, overrideable via meta.http.segment
      const seg = getHttpMeta(child.meta).segment ?? name
      out.push(...buildRoutes(child, `${prefix}/${seg}`, nodePath, inheritedConditions))
    }
  }

  return out
}

// ============================================================================
// Core router — exact verb+path dispatch
//
// No HEAD-from-GET, no OPTIONS auto-response, no 405+Allow.
// Those HTTP-correctness behaviors live in the auto-method layer (layers.ts)
// and are droppable: the router functions correctly as a pure dispatcher
// without them, returning 404 for any request with no exact match.
// ============================================================================

/**
 * Evaluate all match conditions for a route against a request.
 * Returns true if all conditions are satisfied.
 */
function matchConditions(conditions: readonly MatchCondition[], req: Request): boolean {
  for (const cond of conditions) {
    if (cond.kind === "method") {
      if (req.method !== cond.value) return false
    } else if (cond.kind === "header") {
      if (req.headers.get(cond.name) !== cond.value) return false
    } else if (cond.kind === "query") {
      const url = new URL(req.url)
      if (url.searchParams.get(cond.name) !== cond.value) return false
    } else if (cond.kind === "contentType") {
      const ct = req.headers.get("Content-Type") ?? ""
      if (!ct.includes(cond.value)) return false
    }
  }
  return true
}

export function makeRouter(
  routes: Route[],
): (req: Request) => Promise<Response> {
  return async (req) => {
    const segs = pathSegs(req.url)

    // Find a match: verb + path + all conditions
    // For routes with no method condition in conditions[], the verb field
    // is still used for matching (backward compat + non-method-dispatch routes).
    let matched: Route | undefined
    for (const r of routes) {
      // Determine if this route has an explicit method condition
      const hasMethodCond = r.conditions.some((c) => c.kind === "method")
      // Method check: if route has a method condition, it's enforced there;
      // otherwise fall back to comparing verb directly (plain routes).
      const verbOk = hasMethodCond ? true : r.verb === req.method
      if (!verbOk) continue
      if (matchRoute(r.pattern, segs) === null) continue
      if (!matchConditions(r.conditions, req)) continue
      matched = r
      break
    }
    if (matched === undefined) return new Response("Not Found", { status: 404 })

    const params = matchRoute(matched.pattern, segs)
    if (params === null) return new Response("Not Found", { status: 404 })

    // Assemble input: path params (provenance-blind) + query params + JSON body
    const input: Record<string, unknown> = { ...params }

    const url = new URL(req.url)
    for (const [k, v] of url.searchParams) {
      input[k] = v
    }

    const ct = req.headers.get("Content-Type") ?? ""
    if (ct.includes("application/json")) {
      try {
        const body: unknown = await req.json()
        if (typeof body === "object" && body !== null) {
          Object.assign(input, body)
        }
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, { status: 400 })
      }
    }

    try {
      const result: unknown = await (matched.handler(input) as Promise<unknown>)
      return jsonResponse(result)
    } catch (e: unknown) {
      return jsonResponse({ error: String(e) }, { status: 500 })
    }
  }
}

// ============================================================================
// Response helpers
// ============================================================================

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  return new Response(JSON.stringify(value), { ...init, headers })
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * The `dispatch` marker shape in `meta.http`.
 *
 * - `"method"` — children distinguished by HTTP verb (derived from tags).
 *   The verb IS the match key; child agnostic names are ignored by HTTP.
 *
 * - `{ by: "header", name: "X-Api-Version" }` — children distinguished by
 *   the value of request header `name`. A child keyed `v1` matches when the
 *   header value is `"v1"`. Override per-child via `meta.http.when`.
 *
 * - `{ by: "query", name: "mode" }` — children distinguished by the value
 *   of query parameter `name`. Same key=value default; `when` overrides.
 *
 * - `{ by: "contentType" }` — children distinguished by the request
 *   Content-Type value. Child key = match value; `when` overrides.
 *
 * In all non-method dispatch cases, non-leaf children are still
 * segment-dispatched (they contribute a path segment). CLI/MCP projections
 * ignore the dispatch marker and key children by their agnostic name.
 *
 * No-match behavior:
 * - Method dispatch: 405 + Allow (via autoMethodLayer).
 * - Header/query/contentType dispatch: 404 (no special status — the
 *   attribute is not part of the HTTP-visible address).
 */
export type DispatchMarker =
  | "method"
  | { readonly by: "header"; readonly name: string }
  | { readonly by: "query"; readonly name: string }
  | { readonly by: "contentType" }

type HttpMeta = {
  readonly verb?: string
  readonly segment?: string
  readonly legacyPath?: string
  readonly dispatch?: DispatchMarker
  /**
   * `when`: per-child match-value override for non-method attribute dispatch.
   * When set on a leaf child's `meta.http`, it overrides the default (child
   * key = match value). Use for aliasing or matching multiple values:
   *   `when: "application/json"` on a child keyed `json` to match that
   *   content-type regardless of the key name.
   */
  readonly when?: string
}

/** Safely extract typed HTTP projection metadata from an open Meta bag. */
function getHttpMeta(meta: Meta): HttpMeta {
  const h = meta.http
  if (typeof h !== "object" || h === null) return {}
  const r = h as Record<string, unknown>
  const out: {
    verb?: string
    segment?: string
    legacyPath?: string
    dispatch?: DispatchMarker
    when?: string
  } = {}
  if (typeof r.verb === "string") out.verb = r.verb
  if (typeof r.segment === "string") out.segment = r.segment
  if (typeof r.legacyPath === "string") out.legacyPath = r.legacyPath
  if (typeof r.when === "string") out.when = r.when
  // Parse dispatch marker
  if (r.dispatch === "method") {
    out.dispatch = "method"
  } else if (typeof r.dispatch === "object" && r.dispatch !== null) {
    const d = r.dispatch as Record<string, unknown>
    if (d.by === "header" && typeof d.name === "string") {
      out.dispatch = { by: "header", name: d.name }
    } else if (d.by === "query" && typeof d.name === "string") {
      out.dispatch = { by: "query", name: d.name }
    } else if (d.by === "contentType") {
      out.dispatch = { by: "contentType" }
    }
  }
  return out
}
