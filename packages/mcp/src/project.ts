// packages/mcp/src/project.ts — @rhi-zone/fractal-mcp
//
// MCP tool projection: walks a Node tree and produces a flat McpTool[],
// one per leaf node (handler-carrying Node) in the tree. Annotation hints
// (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) are derived
// from the SAME meta.tags that drives the HTTP verb — one authoring, two surfaces.
//
// A leaf's tags are read directly from its OWN meta.tags — there is no
// ancestor inheritance (removed; see docs/design/router-model.md — "Tags").
// A `fallback` (wildcard-capture) contributes its `name` (e.g. "userId") as a
// tool-name segment, mirroring the HTTP projection's `{name}` path segment.
//
// Three-valued hint semantics (mirrors the tag lattice):
//   true  → emit hint: true
//   false → emit hint: false
//   undefined (unknown) → OMIT the hint entirely (unknown ≠ false)
//
// Per-projection overrides live in meta.mcp (open bag). Any key in meta.mcp
// is passed through; the standard keys are name / description / title /
// segment (node-level) / annotations (per-hint overrides).
//
// inputSchema and the JSDoc description fallback come from a derived-from-type
// SchemaMap (built by @rhi-zone/fractal-codegen). When no schema is supplied
// for a tool, inputSchema degrades to the MCP spec minimum `{ type: "object" }`.
//
// See:
//   docs/artifacts/fc-op-kinds/projection-mcp.md — MCP concept list + classification
//   packages/core/src/tags.ts                    — tag lattice (resolveTags)
//   packages/http/src/project.ts                 — sibling projection (structural mirror)
//   packages/codegen/src/tree.ts                 — extractToolSchemas (schema source)

import { isLeaf } from "@rhi-zone/fractal-core/node"
import { resolveTags } from "@rhi-zone/fractal-core/tags"
import type { Tags } from "@rhi-zone/fractal-core/tags"
import type { Meta, Node } from "@rhi-zone/fractal-core/node"

// ============================================================================
// Types
// ============================================================================

/**
 * MCP ToolAnnotations (MCP spec 2025-03-26).
 *
 * Standard hint keys are typed; any extra MCP-specific keys pass through
 * as-is (open bag — no closed enum).
 *
 * Three-valued hint semantics: a hint is only emitted when the underlying
 * tag has a definite value (true or false). Unknown (undefined) tags produce
 * NO hint key — the MCP model should not infer "not read-only" from absence.
 */
export type McpAnnotations = {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
  readonly title?: string
  readonly [key: string]: unknown
}

/**
 * MCP Tool descriptor — one per leaf node in the Node tree.
 *
 * inputSchema is a real JSON-Schema when a derived schema map is supplied to
 * `toTools` (see @rhi-zone/fractal-codegen's `extractToolSchemas`, which lowers
 * leaf handler input types via the TypeScript compiler API). Absent a match it
 * degrades to the MCP spec minimum `{ type: "object" }` — never a hand-authored
 * second source.
 */
export type McpTool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: McpAnnotations
}

/**
 * Derived-from-type facts for one tool, keyed by tool name. Produced at build
 * time by @rhi-zone/fractal-codegen; consumed here to fill inputSchema and the
 * JSDoc-derived description fallback. No hand-authored schema is involved.
 */
export type ToolSchema = {
  readonly inputSchema?: Record<string, unknown>
  readonly description?: string
}

/** Map of tool name → derived schema/description (from codegen). */
export type SchemaMap = Readonly<Record<string, ToolSchema>>

/** Options for `toTools`. */
export type ToToolsOptions = {
  /** Tool-name → derived input schema + JSDoc description (from codegen). */
  readonly schemas?: SchemaMap
}

// ============================================================================
// Annotation hints from the tag lattice
// ============================================================================

/**
 * Derive MCP annotation hints from a Tags bag (the leaf's OWN meta.tags).
 *
 * Only emits a hint key when the resolved tag value is explicitly true or
 * false. Omits the key entirely when the tag is undefined (unknown).
 * This preserves three-valued semantics: unknown ≠ false.
 */
function hintsFromTags(tags: Tags): Record<string, boolean> {
  const r = resolveTags(tags)
  const hints: Record<string, boolean> = {}
  if (r.readOnly !== undefined) hints.readOnlyHint = r.readOnly
  if (r.destructive !== undefined) hints.destructiveHint = r.destructive
  if (r.idempotent !== undefined) hints.idempotentHint = r.idempotent
  if (r.openWorld !== undefined) hints.openWorldHint = r.openWorld
  return hints
}

// ============================================================================
// MCP meta extraction
// ============================================================================

/** Safely extract the open meta.mcp bag from a Meta. */
function getMcpMeta(meta: Meta): Record<string, unknown> {
  const m = meta.mcp
  if (typeof m !== "object" || m === null) return {}
  return m as Record<string, unknown>
}

// ============================================================================
// Tree walk
// ============================================================================

/**
 * Walk a Node tree and produce a flat array of MCP tool descriptors.
 *
 * Name construction (tree-position namespacing, underscore-joined):
 *   root leaf "get"                    → "get"
 *   child "users" / leaf "list"        → "users_list"
 *   fallback name "userId" / leaf      → "users_userId_get"
 *   meta.mcp.name on leaf              → full override (no prefix applied)
 *   meta.mcp.segment on a child node   → that node's contribution to the prefix
 *
 * Tags: read directly from the leaf's own meta.tags — no ancestor inheritance.
 *
 * Per-projection overrides via meta.mcp (open bag):
 *   name        — override full tool name (prefix ignored when set)
 *   description — override description text
 *   title       — emits annotations.title
 *   annotations — merged over tag-derived hints (override wins per key)
 *
 * @param n     - The root node to walk.
 * @param opts  - Optional derived `schemas` map (from @rhi-zone/fractal-codegen).
 */
export function toTools(n: Node, opts: ToToolsOptions = {}): McpTool[] {
  const schemas = opts.schemas ?? {}

  const walk = (n: Node, prefix: string): McpTool[] => {
    const out: McpTool[] = []

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        // ── Leaf node: this is a callable → build an MCP tool ──────────────
        const mcp = getMcpMeta(child.meta)

        // Name: meta.mcp.name wins; else underscore-join prefix + leaf key
        const name =
          typeof mcp.name === "string"
            ? mcp.name
            : prefix.length > 0
              ? `${prefix}_${key}`
              : key

        const derived = schemas[name]

        // Description: meta.mcp.description > meta.description > JSDoc-derived
        // (from codegen) > leaf key.
        const description =
          typeof mcp.description === "string"
            ? mcp.description
            : typeof child.meta.description === "string"
              ? child.meta.description
              : typeof derived?.description === "string"
                ? derived.description
                : key

        // Hints derived from the tag lattice (three-valued), the leaf's own tags only
        const baseHints = hintsFromTags((child.meta.tags ?? {}) as Tags)

        // meta.mcp.annotations overrides individual hint keys
        const annotationOverride: Record<string, unknown> =
          typeof mcp.annotations === "object" && mcp.annotations !== null
            ? (mcp.annotations as Record<string, unknown>)
            : {}

        // meta.mcp.title → annotations.title
        const titleEntry: Record<string, string> =
          typeof mcp.title === "string" ? { title: mcp.title } : {}

        const annotationsMerged = { ...baseHints, ...annotationOverride, ...titleEntry }
        const annotations: McpAnnotations | undefined =
          Object.keys(annotationsMerged).length > 0 ? annotationsMerged : undefined

        out.push({
          name,
          description,
          // Derived-from-type schema when available; else the MCP spec minimum.
          inputSchema: derived?.inputSchema ?? { type: "object" },
          ...(annotations !== undefined ? { annotations } : {}),
        })
      } else {
        // ── Branch child ────────────────────────────────────────────────────
        // Static child: use meta.mcp.segment override or the tree key
        const childMcp = getMcpMeta(child.meta)
        const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key
        const seg = prefix.length > 0 ? `${prefix}_${rawSeg}` : rawSeg
        out.push(...walk(child, seg))
      }
    }

    if (n.fallback !== undefined) {
      // fallback: contribute its name (e.g. "userId") as the segment
      const seg = prefix.length > 0 ? `${prefix}_${n.fallback.name}` : n.fallback.name
      out.push(...walk(n.fallback.subtree, seg))
    }

    return out
  }

  return walk(n, "")
}
