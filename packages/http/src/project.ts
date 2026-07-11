// packages/http/src/project.ts — @rhi-zone/fractal-http
//
// Direct tree-walk dispatch: the projector walks the Node tree AT REQUEST TIME
// against the incoming request's path segments — O(depth), keyed child lookup
// at each node. There is no flattening step / compiled route table; the tree
// structure IS the dispatch structure. Path comes purely from tree structure
// (no path strings in meta, except the legacyPath [DEBT] escape hatch below).
// Verb is derived from the tag lattice (readOnly/idempotent/destructive) with
// a meta.http verb-directive override.
//
// meta.http is a DU interpreted by this projector (interpreter pattern), not a
// fixed record of named keys:
//   meta.http.dispatch    — a DispatchMarker DU tagged by `kind`
//                           ({kind:"method"} | {kind:"header",name} |
//                            {kind:"query",name} | {kind:"contentType"})
//   meta.http.directives  — an array of HttpDirective DU values, each tagged
//                           by `kind` ("verb" | "segment" | "when" | "legacyPath")
//
// See:
//   docs/design/router-model.md              — Node Shape, Dispatch, HTTP metadata
//   docs/design/dispatch-extensibility.md     — DU + interpreter pattern

import { isLeaf } from "@rhi-zone/fractal-core/node"
import { resolveTags } from "@rhi-zone/fractal-core/tags"
import type { Tags } from "@rhi-zone/fractal-core/tags"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-core/node"

// ============================================================================
// meta.http DU types
// ============================================================================

/**
 * The dispatch marker DU — which attribute of the request a node's children
 * are distinguished by.
 *
 * - `{ kind: "method" }` — children distinguished by HTTP verb (derived from
 *   tags). The verb IS the match key; child agnostic names are ignored by HTTP.
 * - `{ kind: "header", name }` — children distinguished by the value of
 *   request header `name`. A child keyed `v1` matches when the header value
 *   is `"v1"`. Override per-child via a `when` directive.
 * - `{ kind: "query", name }` — children distinguished by the value of query
 *   parameter `name`. Same key=value default; `when` overrides.
 * - `{ kind: "contentType" }` — children distinguished by the request
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
  | { readonly kind: "method" }
  | { readonly kind: "header"; readonly name: string }
  | { readonly kind: "query"; readonly name: string }
  | { readonly kind: "contentType" }

/**
 * A single HTTP directive — a tagged variant interpreted by this projector.
 * Retires the former named keys (`verb`, `segment`, `when`, `legacyPath`) in
 * favor of an interpreter-pattern DU: each variant is a self-describing value,
 * not a fixed record field.
 *
 * - `{ kind: "verb", value }`       — explicit verb override; wins over tags.
 * - `{ kind: "segment", value }`    — explicit path-segment rename.
 * - `{ kind: "when", value }`       — per-child match-value override for
 *   non-method attribute dispatch (key ≠ match value).
 * - `{ kind: "legacyPath", value }` — [DEBT] full-path override, bypasses the
 *   tree-walk address entirely. Escape hatch for external-contract / legacy
 *   URL pinning — reaching for this is a smell.
 */
export type HttpDirective =
  | { readonly kind: "verb"; readonly value: string }
  | { readonly kind: "segment"; readonly value: string }
  | { readonly kind: "when"; readonly value: string }
  | { readonly kind: "legacyPath"; readonly value: string }

// ============================================================================
// Verb derivation from three-valued tag lattice
//
// Dispatch rules (from tag-set.md §"HTTP verb selection"):
//   readOnly = true                   → GET
//   idempotent = true, destructive = true  → DELETE
//   idempotent = true, destructive ≠ true  → PUT   (unknown ≠ true)
//   else (idempotent unknown or false) → POST (conservative)
//
// A meta.http verb directive always wins — checked before tags.
// Tags are three-valued: true / false / undefined (unknown ≠ false).
//
// Tags are read directly from the node's own meta — there is no ancestor
// inheritance (removed; see docs/design/router-model.md — "Tags").
// ============================================================================

export function verbFromTags(meta: Meta): string {
  const httpVerb = getHttpMeta(meta).verb
  if (httpVerb !== undefined) return httpVerb.toUpperCase()

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

/** Parse URL path segments (split on "/", empties dropped). */
export function pathSegs(url: string): readonly string[] {
  return new URL(url).pathname.split("/").filter((s) => s.length > 0)
}

/** Build a sorted Allow header string from a set of HTTP method strings. */
export function allowHeader(verbs: Iterable<string>): string {
  return [...new Set(verbs)].sort().join(", ")
}

// ============================================================================
// Match conditions — evaluated at dispatch time against the live request
// (verb is always checked separately via candidate.verb === req.method)
// ============================================================================

export type MatchCondition =
  | { readonly kind: "header"; readonly name: string; readonly value: string }
  | { readonly kind: "query"; readonly name: string; readonly value: string }
  | { readonly kind: "contentType"; readonly value: string }

/** One reachable leaf at a specific request path — resolved by tree walk. */
export type Candidate = {
  readonly verb: string
  readonly conditions: readonly MatchCondition[]
  readonly handler: Handler
  readonly meta: Meta
  readonly slugs: Readonly<Record<string, string>>
}

function conditionFor(marker: DispatchMarker, value: string): MatchCondition {
  if (marker.kind === "header") return { kind: "header", name: marker.name, value }
  if (marker.kind === "query") return { kind: "query", name: marker.name, value }
  return { kind: "contentType", value }
}

/**
 * Evaluate all match conditions for a candidate against a request.
 * Returns true if all conditions are satisfied.
 */
function matchConditions(conditions: readonly MatchCondition[], req: Request): boolean {
  for (const cond of conditions) {
    if (cond.kind === "header") {
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

// ============================================================================
// Direct tree-walk dispatch
//
// `collectCandidates` walks the tree GUIDED by the request's actual path
// segments — O(depth) — producing the leaves reachable at that exact path,
// threading fallback slug values as it goes.
// ============================================================================

function collectCandidates(
  node: Node,
  segs: readonly string[],
  idx: number,
  slugs: Readonly<Record<string, string>>,
  inheritedConditions: readonly MatchCondition[],
): Candidate[] {
  const out: Candidate[] = []
  const marker = getHttpMeta(node.meta).dispatch

  if (marker !== undefined && marker.kind === "method") {
    // METHOD DISPATCH: leaf children share this node's own path; verb
    // distinguishes them. Non-leaf children are still segment-dispatched.
    if (idx === segs.length) {
      for (const child of Object.values(node.children ?? {})) {
        if (!isLeaf(child)) continue
        out.push({
          verb: verbFromTags(child.meta),
          conditions: inheritedConditions,
          handler: child.handler!,
          meta: child.meta,
          slugs,
        })
      }
    }
    if (idx < segs.length) {
      const seg = segs[idx]!
      let matched = false
      for (const [name, child] of Object.entries(node.children ?? {})) {
        if (isLeaf(child)) continue
        const branchSeg = getHttpMeta(child.meta).segment ?? name
        if (branchSeg === seg) {
          matched = true
          out.push(...collectCandidates(child, segs, idx + 1, slugs, inheritedConditions))
        }
      }
      if (!matched && node.fallback !== undefined) {
        out.push(
          ...collectCandidates(
            node.fallback.subtree,
            segs,
            idx + 1,
            { ...slugs, [node.fallback.name]: seg },
            inheritedConditions,
          ),
        )
      }
    }
    return out
  }

  if (marker !== undefined) {
    // NON-METHOD ATTRIBUTE DISPATCH (header / query / contentType): leaf AND
    // branch children are matched by attribute value at the SAME path — no
    // segment is consumed for either.
    for (const [name, child] of Object.entries(node.children ?? {})) {
      const matchValue = getHttpMeta(child.meta).when ?? name
      const condition = conditionFor(marker, matchValue)
      if (isLeaf(child)) {
        if (idx === segs.length) {
          out.push({
            verb: verbFromTags(child.meta),
            conditions: [...inheritedConditions, condition],
            handler: child.handler!,
            meta: child.meta,
            slugs,
          })
        }
      } else {
        out.push(...collectCandidates(child, segs, idx, slugs, [...inheritedConditions, condition]))
      }
    }
    return out
  }

  // DEFAULT: SEGMENT DISPATCH (no dispatch marker)
  if (idx < segs.length) {
    const seg = segs[idx]!
    let matched = false
    for (const [name, child] of Object.entries(node.children ?? {})) {
      if (isLeaf(child)) {
        const http = getHttpMeta(child.meta)
        if (http.legacyPath !== undefined) continue // resolved via the legacy-path scan instead
        const leafSeg = http.segment ?? inferSegment(name)
        if (leafSeg === seg && idx + 1 === segs.length) {
          matched = true
          out.push({
            verb: verbFromTags(child.meta),
            conditions: inheritedConditions,
            handler: child.handler!,
            meta: child.meta,
            slugs,
          })
        }
      } else {
        const branchSeg = getHttpMeta(child.meta).segment ?? name
        if (branchSeg === seg) {
          matched = true
          out.push(...collectCandidates(child, segs, idx + 1, slugs, inheritedConditions))
        }
      }
    }
    if (!matched && node.fallback !== undefined) {
      out.push(
        ...collectCandidates(
          node.fallback.subtree,
          segs,
          idx + 1,
          { ...slugs, [node.fallback.name]: seg },
          inheritedConditions,
        ),
      )
    }
  }

  return out
}

/**
 * [DEBT] Scan the whole tree for a leaf whose `legacyPath` directive equals
 * the exact request pathname. legacyPath decouples address from tree
 * position, so it cannot be found by the guided, segment-driven walk above —
 * this is a deliberately rare fallback for the escape hatch only, not the
 * general dispatch mechanism.
 */
function findLegacyPath(node: Node, path: string): Candidate | undefined {
  for (const child of Object.values(node.children ?? {})) {
    if (isLeaf(child)) {
      const http = getHttpMeta(child.meta)
      if (http.legacyPath === path) {
        return {
          verb: verbFromTags(child.meta),
          conditions: [],
          handler: child.handler!,
          meta: child.meta,
          slugs: {},
        }
      }
    }
    const found = findLegacyPath(child, path)
    if (found !== undefined) return found
  }
  if (node.fallback !== undefined) {
    return findLegacyPath(node.fallback.subtree, path)
  }
  return undefined
}

/**
 * All candidate leaves reachable at the exact path of `url` — used by
 * `makeRouter` (pick the one matching verb + conditions) and by
 * `autoMethodLayer` (collect the set of available verbs for 405/OPTIONS).
 */
export function candidatesForUrl(root: Node, url: string): Candidate[] {
  const segs = pathSegs(url)
  const direct = collectCandidates(root, segs, 0, {}, [])
  if (direct.length > 0) return direct
  const legacy = findLegacyPath(root, new URL(url).pathname)
  return legacy !== undefined ? [legacy] : []
}

// ============================================================================
// Core router — exact verb+path dispatch
//
// No HEAD-from-GET, no OPTIONS auto-response, no 405+Allow.
// Those HTTP-correctness behaviors live in the auto-method layer (layers.ts)
// and are droppable: the router functions correctly as a pure dispatcher
// without them, returning 404 for any request with no exact match.
// ============================================================================

export function makeRouter(root: Node): (req: Request) => Promise<Response> {
  return async (req) => {
    const candidates = candidatesForUrl(root, req.url)
    const matched = candidates.find(
      (c) => c.verb === req.method && matchConditions(c.conditions, req),
    )
    if (matched === undefined) return new Response("Not Found", { status: 404 })

    // Assemble input: fallback slugs (provenance-blind) + query params + JSON body.
    const input: Record<string, unknown> = { ...matched.slugs }

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
// Internal helpers — meta.http interpreter
// ============================================================================

type ResolvedHttpMeta = {
  verb?: string
  segment?: string
  when?: string
  legacyPath?: string
  dispatch?: DispatchMarker
}

/** Safely extract typed HTTP projection metadata from an open Meta bag. */
function getHttpMeta(meta: Meta): ResolvedHttpMeta {
  const h = meta.http
  if (typeof h !== "object" || h === null) return {}
  const r = h as { dispatch?: unknown; directives?: unknown }
  const out: ResolvedHttpMeta = {}

  if (typeof r.dispatch === "object" && r.dispatch !== null) {
    const d = r.dispatch as Record<string, unknown>
    if (d.kind === "method") out.dispatch = { kind: "method" }
    else if (d.kind === "header" && typeof d.name === "string") out.dispatch = { kind: "header", name: d.name }
    else if (d.kind === "query" && typeof d.name === "string") out.dispatch = { kind: "query", name: d.name }
    else if (d.kind === "contentType") out.dispatch = { kind: "contentType" }
  }

  if (Array.isArray(r.directives)) {
    for (const entry of r.directives as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue
      const d = entry as Record<string, unknown>
      if (d.kind === "verb" && typeof d.value === "string") out.verb = d.value
      else if (d.kind === "segment" && typeof d.value === "string") out.segment = d.value
      else if (d.kind === "when" && typeof d.value === "string") out.when = d.value
      else if (d.kind === "legacyPath" && typeof d.value === "string") out.legacyPath = d.value
    }
  }

  return out
}
