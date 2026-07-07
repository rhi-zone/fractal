// packages/mcp/src/project.ts — @rhi-zone/fractal-mcp
//
// MCP tool projection: walks a Node tree and produces a flat McpTool[],
// one per op. Annotation hints (readOnlyHint, destructiveHint, idempotentHint,
// openWorldHint) are derived from the SAME meta.tags that drives the HTTP verb —
// one authoring, two surfaces.
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
// inputSchema is a best-effort placeholder (`{ type: "object" }`) until
// types-codegen lands. See TODO below.
//
// See:
//   docs/artifacts/fc-op-kinds/projection-mcp.md — MCP concept list + classification
//   packages/core/src/tags.ts                    — tag lattice + effectiveTags
//   packages/http/src/project.ts                 — sibling projection (structural mirror)

import { isParamNode } from "@rhi-zone/fractal-core/node"
import { effectiveTags, resolveTags } from "@rhi-zone/fractal-core/tags"
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
 * MCP Tool descriptor — one per op in the Node tree.
 *
 * inputSchema is a best-effort placeholder. Real JSON-Schema derivation from
 * op input types is deferred to the types-codegen increment.
 *
 * TODO(codegen): replace `inputSchema: { type: "object" }` with a real
 * JSON-Schema (`{ type: "object", properties: {...}, required: [...] }`)
 * inferred from the op's TypeScript input type via the codegen pipeline.
 * The MCP spec requires `inputSchema` to be a valid JSON-Schema object; the
 * minimum (`{ type: "object" }`) is used here as a safe placeholder.
 */
export type McpTool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: McpAnnotations
}

// ============================================================================
// Annotation hints from the tag lattice
// ============================================================================

/**
 * Derive MCP annotation hints from an effective Tags bag.
 *
 * Only emits a hint key when the resolved tag value is explicitly true or
 * false. Omits the key entirely when the tag is undefined (unknown).
 * This preserves three-valued semantics: unknown ≠ false.
 */
function hintsFromTags(effective: Tags): Record<string, boolean> {
  const r = resolveTags(effective)
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
 *   root op "get"                      → "get"
 *   child "users" / op "list"          → "users_list"
 *   param child name "userId" / op     → "users_userId_get"
 *   meta.mcp.name on op                → full override (no prefix applied)
 *   meta.mcp.segment on a child node   → that node's contribution to the prefix
 *
 * Tag inheritance (closest-wins via effectiveTags):
 *   A node tagged `meta.tags: { readOnly: true }` makes all descendant ops
 *   emit `readOnlyHint: true` unless a closer ancestor or the op itself
 *   overrides via its own `meta.tags`.
 *
 * Per-projection overrides via meta.mcp (open bag):
 *   name        — override full tool name (prefix ignored when set)
 *   description — override description text
 *   title       — emits annotations.title
 *   annotations — merged over tag-derived hints (override wins per key)
 *
 * @param n        - The node to walk.
 * @param prefix   - Accumulated name prefix from ancestor nodes ("" at root).
 * @param tagPath  - Accumulated nodes/ops array for effectiveTags inheritance.
 */
export function toTools(
  n: Node,
  prefix = "",
  tagPath: Array<{ meta?: { tags?: Tags } }> = [],
): McpTool[] {
  const out: McpTool[] = []
  const nodePath = [...tagPath, n]

  // ── Leaf ops on this node ─────────────────────────────────────────────────

  for (const [key, o] of Object.entries(n.ops)) {
    const opPath = [...nodePath, o]
    const effective = effectiveTags(opPath)
    const mcp = getMcpMeta(o.meta)

    // Name: meta.mcp.name wins; else underscore-join prefix + op key
    const name =
      typeof mcp.name === "string"
        ? mcp.name
        : prefix.length > 0
          ? `${prefix}_${key}`
          : key

    // Description: meta.mcp.description > meta.description > op key.
    // NOTE: JSDoc extraction is a codegen concern — not yet built.
    // TODO(codegen): when JSDoc extraction lands, fall through to doc-comment
    // text before defaulting to the op key.
    const description =
      typeof mcp.description === "string"
        ? mcp.description
        : typeof o.meta.description === "string"
          ? o.meta.description
          : key

    // Hints derived from the tag lattice (three-valued)
    const baseHints = hintsFromTags(effective)

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
      // TODO(codegen): real JSON-Schema from op input types not yet built;
      // `{ type: "object" }` satisfies the MCP spec minimum until codegen lands.
      inputSchema: { type: "object" },
      ...(annotations !== undefined ? { annotations } : {}),
    })
  }

  // ── Child nodes ───────────────────────────────────────────────────────────

  for (const [key, child] of Object.entries(n.children)) {
    if (isParamNode(child)) {
      // ParamNode: contribute the param name (e.g. "userId") as the segment
      const seg = prefix.length > 0 ? `${prefix}_${child.name}` : child.name
      out.push(...toTools(child.subtree, seg, nodePath))
    } else {
      // Static child: use meta.mcp.segment override or the tree key
      const childMcp = getMcpMeta(child.meta)
      const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key
      const seg = prefix.length > 0 ? `${prefix}_${rawSeg}` : rawSeg
      out.push(...toTools(child, seg, nodePath))
    }
  }

  return out
}
