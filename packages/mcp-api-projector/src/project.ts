// packages/mcp-api-projector/src/project.ts — @rhi-zone/fractal-mcp-api-projector
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
// SchemaMap (built by @rhi-zone/fractal-api-tree's tree.ts). When no schema is
// supplied for a tool, inputSchema degrades to the MCP spec minimum
// `{ type: "object" }`.
//
// See:
//   docs/artifacts/fc-op-kinds/projection-mcp.md — MCP concept list + classification
//   packages/api-tree/src/tags.ts                    — tag lattice (resolveTags)
//   packages/http-api-projector/src/project.ts                 — sibling projection (structural mirror)
//   packages/api-tree/src/tree.ts                 — extractToolSchemas (schema source)

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"

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
 * `toTools` (see @rhi-zone/fractal-api-tree's `extractToolSchemas`, which lowers
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
 * time by @rhi-zone/fractal-api-tree's tree.ts; consumed here to fill
 * inputSchema and the JSDoc-derived description fallback. No hand-authored
 * schema is involved.
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

/**
 * `meta.mcp` open bag — per-projection overrides for MCP tool generation.
 * Standard keys are typed; any other key passes through untouched (open bag,
 * not a fixed schema — see the DU + interpreter design philosophy).
 */
export type McpMeta = {
  /** Full tool-name override (prefix ignored when set), or resource name override. */
  readonly name?: string
  /** Description text override. */
  readonly description?: string
  /** Emits `annotations.title`. */
  readonly title?: string
  /** This node's contribution to the tool-name/resource-URI prefix (branch nodes only). */
  readonly segment?: string
  /** Merged over tag-derived hints (override wins per key). Tools only. */
  readonly annotations?: McpAnnotations
  /**
   * Leaf discriminator: "tool" (default, omitted = "tool") | "resource" | "prompt".
   * See project.ts's three walks (`projectTools`, `projectResources`,
   * `projectPrompts`), each skipping leaves not tagged for its own surface.
   */
  readonly as?: "tool" | "resource" | "prompt"
  /** Full resource URI override (derived-from-tree-position URI ignored when set). */
  readonly uri?: string
  /** Resource MIME type override; defaults to "application/json". Resources only. */
  readonly mimeType?: string
  readonly [key: string]: unknown
}

/** Safely extract the open meta.mcp bag from a Meta. */
export function getMcpMeta(meta: Meta): McpMeta {
  const m = meta.mcp
  if (typeof m !== "object" || m === null) return {}
  return m as McpMeta
}

// ============================================================================
// Tree walk
// ============================================================================

/** `toTools`'s full result: the flat descriptor array plus a name→handler
 * map for dispatch (server.ts's `createMcpServer` resolves tool calls
 * through this map instead of re-walking the tree per call). */
export type ProjectToolsResult = {
  readonly tools: McpTool[]
  readonly handlers: ReadonlyMap<string, Handler>
}

/**
 * Walk a Node tree and produce a flat array of MCP tool descriptors, plus
 * the name→handler map used to dispatch tool calls (server.ts). Single
 * walk, single source of truth for name construction — `toTools` is a thin
 * projection of this onto just the `tools` array.
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
 * @param opts  - Optional derived `schemas` map (from @rhi-zone/fractal-type-ir).
 */
export function projectTools(n: Node, opts: ToToolsOptions = {}): ProjectToolsResult {
  const schemas = opts.schemas ?? {}
  const handlers = new Map<string, Handler>()

  const walk = (n: Node, prefix: string): McpTool[] => {
    const out: McpTool[] = []

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        // ── Leaf node: this is a callable → build an MCP tool ──────────────
        const mcp = getMcpMeta(child.meta)

        // meta.mcp.as discriminates the leaf's target surface. Omitted or
        // "tool" → project as a tool (this walk); "resource" / "prompt" →
        // skip here (projected by projectResources / a future prompt walk).
        if (mcp.as !== undefined && mcp.as !== "tool") continue

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
        handlers.set(name, child.handler as Handler)
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

  const tools = walk(n, "")
  return { tools, handlers }
}

/**
 * Walk a Node tree and produce a flat array of MCP tool descriptors. See
 * `projectTools` for the full walk (name construction, tag/annotation
 * derivation) — `toTools` is a thin projection onto just the `tools` array.
 *
 * @param n     - The root node to walk.
 * @param opts  - Optional derived `schemas` map (from @rhi-zone/fractal-type-ir).
 */
export function toTools(n: Node, opts: ToToolsOptions = {}): McpTool[] {
  return projectTools(n, opts).tools
}

// ============================================================================
// Resource projection
// ============================================================================
//
// A leaf tagged `meta.mcp.as: "resource"` is projected as an MCP Resource
// (fixed URI) or ResourceTemplate (URI carries `{var}` placeholders) instead
// of a tool. URI derivation mirrors `projectTools`' name derivation, but
// joins tree-position segments with "/" (not "_") and prefixes a URI scheme
// — a fallback node's `name` (e.g. "userId") becomes a `{userId}` template
// variable rather than a literal segment, since its value is only known at
// read time.
//
// No annotation-hint derivation here (see module doc — MCP resources carry
// no ToolAnnotations-equivalent), and no inputSchema — a resource read takes
// no arguments beyond the URI's own template variables.

/** A fixed MCP resource — one concrete, addressable URI. */
export type McpResource = {
  readonly uri: string
  readonly name: string
  readonly description: string
  readonly mimeType: string
}

/** An MCP resource template — a URI carrying `{var}` placeholders bound at read time. */
export type McpResourceTemplate = {
  readonly uriTemplate: string
  readonly name: string
  readonly description: string
  readonly mimeType: string
}

/** A compiled URI template: matches a concrete read URI and binds its captured segments. */
export type ResourceTemplateHandler = {
  readonly uriTemplate: string
  readonly paramNames: readonly string[]
  readonly pattern: RegExp
  readonly mimeType: string
  readonly handler: Handler
}

/** Options for `projectResources`. */
export type ProjectResourcesOptions = {
  /** URI scheme prefix for derived URIs. Defaults to `"resource://"`. */
  readonly scheme?: string
}

/** `projectResources`'s full result: descriptor arrays plus dispatch tables. */
export type ProjectResourcesResult = {
  readonly resources: McpResource[]
  readonly resourceTemplates: McpResourceTemplate[]
  /** Fixed-resource dispatch: URI → handler (no template variables to bind). */
  readonly handlers: ReadonlyMap<string, Handler>
  /** Template-resource dispatch: tried in order against a concrete read URI. */
  readonly templateHandlers: readonly ResourceTemplateHandler[]
}

/** Escape a string for literal inclusion inside a `RegExp` pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Compile a `{var}`-templated URI (e.g. `resource://users/{userId}/profile`)
 * into a matching `RegExp` (one capture group per variable, in order) plus
 * the ordered list of variable names — used at read time to bind a concrete
 * URI's captured segments back to named handler input fields.
 */
function compileUriTemplate(uriTemplate: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  let patternSource = ""
  let lastIndex = 0
  const varPattern = /\{([^}]+)\}/g
  let match: RegExpExecArray | null
  while ((match = varPattern.exec(uriTemplate)) !== null) {
    patternSource += escapeRegExp(uriTemplate.slice(lastIndex, match.index))
    patternSource += "([^/]+)"
    paramNames.push(match[1]!)
    lastIndex = match.index + match[0].length
  }
  patternSource += escapeRegExp(uriTemplate.slice(lastIndex))
  return { pattern: new RegExp(`^${patternSource}$`), paramNames }
}

/**
 * Walk a Node tree and produce a flat array of MCP resource/resource-template
 * descriptors, plus the dispatch tables `server.ts`'s `resources/read`
 * handler resolves reads through (mirrors `projectTools`' handler map — a
 * single walk, no drift between the listed descriptors and dispatch).
 *
 * URI construction (tree-position namespacing, slash-joined, scheme-prefixed):
 *   root leaf "config"                        → "resource://config"
 *   child "users" / leaf "list"                → "resource://users/list"
 *   fallback name "userId" / leaf "profile"    → "resource://users/{userId}/profile" (template)
 *   meta.mcp.uri on leaf                       → full override
 *   meta.mcp.segment on a child node           → that node's URI-segment contribution
 *
 * Per-projection overrides via meta.mcp (open bag):
 *   name        — override the resource/template `name` (else the leaf key)
 *   description — override description text (else meta.description, else leaf key)
 *   mimeType    — override MIME type (else `"application/json"`)
 *   uri         — override the derived URI/URI-template entirely
 *
 * @param n     - The root node to walk.
 * @param opts  - Optional URI `scheme` (defaults to `"resource://"`).
 */
export function projectResources(n: Node, opts: ProjectResourcesOptions = {}): ProjectResourcesResult {
  const scheme = opts.scheme ?? "resource://"
  const handlers = new Map<string, Handler>()
  const templateHandlers: ResourceTemplateHandler[] = []

  const walk = (
    n: Node,
    segments: readonly string[],
    hasFallback: boolean,
  ): { resources: McpResource[]; resourceTemplates: McpResourceTemplate[] } => {
    const resources: McpResource[] = []
    const resourceTemplates: McpResourceTemplate[] = []

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        const mcp = getMcpMeta(child.meta)

        // Only leaves explicitly tagged for the resource surface are projected here.
        if (mcp.as !== "resource") continue

        const leafSegments = [...segments, key]
        const derivedUri = `${scheme}${leafSegments.join("/")}`
        const uri = typeof mcp.uri === "string" ? mcp.uri : derivedUri

        const name = typeof mcp.name === "string" ? mcp.name : key

        const description =
          typeof mcp.description === "string"
            ? mcp.description
            : typeof child.meta.description === "string"
              ? child.meta.description
              : key

        const mimeType = typeof mcp.mimeType === "string" ? mcp.mimeType : "application/json"

        if (hasFallback) {
          const { pattern, paramNames } = compileUriTemplate(uri)
          resourceTemplates.push({ uriTemplate: uri, name, description, mimeType })
          templateHandlers.push({ uriTemplate: uri, paramNames, pattern, mimeType, handler: child.handler as Handler })
        } else {
          resources.push({ uri, name, description, mimeType })
          handlers.set(uri, child.handler as Handler)
        }
      } else {
        // ── Branch child ────────────────────────────────────────────────────
        const childMcp = getMcpMeta(child.meta)
        const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key
        const sub = walk(child, [...segments, rawSeg], hasFallback)
        resources.push(...sub.resources)
        resourceTemplates.push(...sub.resourceTemplates)
      }
    }

    if (n.fallback !== undefined) {
      // fallback: contribute its name as a `{var}` template segment
      const sub = walk(n.fallback.subtree, [...segments, `{${n.fallback.name}}`], true)
      resources.push(...sub.resources)
      resourceTemplates.push(...sub.resourceTemplates)
    }

    return { resources, resourceTemplates }
  }

  const { resources, resourceTemplates } = walk(n, [], false)
  return { resources, resourceTemplates, handlers, templateHandlers }
}

// ============================================================================
// Prompt projection
// ============================================================================
//
// A leaf tagged `meta.mcp.as: "prompt"` is projected as an MCP Prompt instead
// of a tool or resource. Name construction mirrors `projectTools` exactly
// (underscore-joined tree position, `meta.mcp.name` override) — prompts are
// identified by name, not URI, same as tools. `arguments` is derived from the
// SAME `SchemaMap` `projectTools` consumes: each JSON-Schema `properties`
// entry becomes one `PromptArgument`, `required` mirroring the schema's own
// `required` array. No hint/annotation derivation here — MCP prompts carry no
// ToolAnnotations-equivalent.

/** One argument an MCP prompt accepts. */
export type McpPromptArgument = {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

/** An MCP prompt descriptor — one per leaf tagged `meta.mcp.as: "prompt"`. */
export type McpPrompt = {
  readonly name: string
  readonly description: string
  readonly arguments?: McpPromptArgument[]
}

/** Options for `projectPrompts`. */
export type ProjectPromptsOptions = {
  /** Prompt-name → derived input schema + JSDoc description (from codegen). Same shape `projectTools` consumes. */
  readonly schemas?: SchemaMap
}

/** `projectPrompts`'s full result: the flat descriptor array plus a name→handler map for dispatch. */
export type ProjectPromptsResult = {
  readonly prompts: McpPrompt[]
  readonly handlers: ReadonlyMap<string, Handler>
}

/**
 * Derive MCP `PromptArgument[]` from a JSON-Schema `inputSchema`'s
 * `properties`/`required` — one argument per property, `required` mirroring
 * the schema's own `required` array. Returns `undefined` when the schema has
 * no `properties` (e.g. the `{ type: "object" }` placeholder, or no schema
 * supplied at all).
 */
function argumentsFromSchema(schema: Record<string, unknown> | undefined): McpPromptArgument[] | undefined {
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined
  if (properties === undefined || typeof properties !== "object") return undefined

  const required = Array.isArray(schema?.required) ? (schema.required as unknown[]) : []

  const args = Object.entries(properties).map(([name, propSchema]) => {
    const description = typeof propSchema.description === "string" ? propSchema.description : undefined
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(required.includes(name) ? { required: true } : {}),
    }
  })

  return args.length > 0 ? args : undefined
}

/**
 * Walk a Node tree and produce a flat array of MCP prompt descriptors, plus
 * the name→handler map used to dispatch `prompts/get` calls (server.ts).
 * Name construction (tree-position namespacing, underscore-joined) mirrors
 * `projectTools` exactly — see that function's doc for the full scheme.
 *
 * Per-projection overrides via meta.mcp (open bag):
 *   name        — override full prompt name (prefix ignored when set)
 *   description — override description text
 *
 * @param n     - The root node to walk.
 * @param opts  - Optional derived `schemas` map (same shape `projectTools` consumes).
 */
export function projectPrompts(n: Node, opts: ProjectPromptsOptions = {}): ProjectPromptsResult {
  const schemas = opts.schemas ?? {}
  const handlers = new Map<string, Handler>()

  const walk = (n: Node, prefix: string): McpPrompt[] => {
    const out: McpPrompt[] = []

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        const mcp = getMcpMeta(child.meta)

        // Only leaves explicitly tagged for the prompt surface are projected here.
        if (mcp.as !== "prompt") continue

        // Name: meta.mcp.name wins; else underscore-join prefix + leaf key (same as projectTools).
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

        const args = argumentsFromSchema(derived?.inputSchema)

        out.push({
          name,
          description,
          ...(args !== undefined ? { arguments: args } : {}),
        })
        handlers.set(name, child.handler as Handler)
      } else {
        // ── Branch child ────────────────────────────────────────────────────
        const childMcp = getMcpMeta(child.meta)
        const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key
        const seg = prefix.length > 0 ? `${prefix}_${rawSeg}` : rawSeg
        out.push(...walk(child, seg))
      }
    }

    if (n.fallback !== undefined) {
      const seg = prefix.length > 0 ? `${prefix}_${n.fallback.name}` : n.fallback.name
      out.push(...walk(n.fallback.subtree, seg))
    }

    return out
  }

  const prompts = walk(n, "")
  return { prompts, handlers }
}
