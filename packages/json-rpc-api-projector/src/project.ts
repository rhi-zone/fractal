// packages/json-rpc-api-projector/src/project.ts — @rhi-zone/fractal-json-rpc-api-projector
//
// JSON-RPC 2.0 method projection: walks a Node tree and produces a flat
// JsonRpcMethod[] — one per leaf node (handler-carrying Node) — plus the
// name -> handler dispatch table `server.ts`'s transports resolve calls
// through. Structural mirror of `mcp-api-projector/src/project.ts`'s
// `projectTools`/`toTools` (same single-walk-produces-descriptors-and-
// dispatch shape), adapted to JSON-RPC's own naming and metadata
// conventions:
//
//   - Naming: dot-separated method names from tree position (settled
//     design decision), not MCP's underscore-joined names — e.g.
//     `users.list`, `books.get`. A `fallback` (wildcard-capture) node
//     contributes its own name (e.g. "bookId") as a literal dot-segment,
//     exactly like MCP's fallback handling for tools: the segment names the
//     tree position, not a captured runtime value (there is no URL to
//     capture a value from at list-time) — the actual argument travels
//     through `params` like any other field, resolved at call time via the
//     ordinary `assemble` pipeline against the single `"params"` store (see
//     `getJsonRpcMeta`'s `sourceMap` and server.ts's dispatch).
//
//   - Tags -> method metadata: `readOnly`/`destructive`/`idempotent` are
//     surfaced directly as top-level three-valued fields on `JsonRpcMethod`
//     (omitted when unknown, same three-valued convention MCP's
//     `hintsFromTags` uses for its nested `annotations`) rather than nested
//     under an MCP-style `annotations` bag — JSON-RPC has no existing
//     ToolAnnotations-shaped convention to mirror, so these sit flat on the
//     descriptor. `deprecated` likewise reads `meta.tags.deprecated`, same
//     source every other projector reads.
//
// A leaf's tags are read directly from its own meta.tags — no ancestor
// inheritance (see docs/design/router-model.md — "Tags").
//
// Per-projection overrides live in `meta.jsonrpc` (open bag, mirrors
// `meta.mcp`). `paramsSchema`/`resultSchema` come from a derived-from-type
// `SchemaMap` (the same shape `@rhi-zone/fractal-api-tree`'s
// `extractToolSchemas` produces for MCP — `inputSchema`/`outputSchema`),
// keyed by the method's dot-joined name. Absent an entry, `paramsSchema`
// degrades to `{ type: "object" }` (JSON Schema's "any object" — the same
// spec-minimum MCP falls back to) and `resultSchema` is omitted entirely
// (unlike MCP, JSON-RPC has no spec-mandated minimum result shape).
// `errorSchema` is the fixed JSON-RPC 2.0 error envelope from
// `@rhi-zone/fractal-type-ir/json-rpc`'s `jsonRpcErrorSchema`, optionally
// narrowed by `meta.jsonrpc.errorDataSchema`.
//
// See:
//   packages/mcp-api-projector/src/project.ts        — sibling projection (structural mirror)
//   packages/type-ir/src/json-rpc.ts                 — JsonRpcMethod's type-level sibling (TypeRef -> schema)
//   packages/api-tree/src/tags.ts                     — tag lattice (resolveTags)
//   docs/design/router-model.md                       — Node Shape, Dispatch, fallback

import { jsonRpcErrorSchema } from "@rhi-zone/fractal-type-ir/json-rpc";
import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import { escapeJoin } from "@rhi-zone/fractal-api-tree/path";
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags";
import type { Tags } from "@rhi-zone/fractal-api-tree/tags";
import type { Handler, LeafMeta, Node } from "@rhi-zone/fractal-api-tree/node";
import type { SourceMap } from "@rhi-zone/fractal-api-tree";

// ============================================================================
// Types
// ============================================================================

/** JSON Schema, kept as an open bag — same convention as every other projector's schema types. */
export type JsonSchema = Record<string, unknown>;

/**
 * One method's full JSON-RPC descriptor — one per leaf node in the Node
 * tree. See module doc for `paramsSchema`/`resultSchema`/`errorSchema`
 * derivation and the tag -> metadata mapping.
 */
export type JsonRpcMethod = {
  readonly name: string;
  readonly description: string;
  readonly paramsSchema: JsonSchema;
  readonly resultSchema?: JsonSchema;
  readonly errorSchema: JsonSchema;
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  /** True when the method's handler returns an `AsyncIterable` — its
   * result is delivered as JSON-RPC Notifications over the WebSocket
   * transport (server.ts), not a single `result` response. Derived from
   * `meta.tags.streaming` (three-valued; see `resolveTags`) — an explicit
   * tag always wins over the schema's own `x-stream` marker, matching how
   * `resolveTags` itself prioritizes an authored tag over a derived one. */
  readonly streaming?: boolean;
  /** Lifecycle flag — see `McpTool.deprecated`'s doc (mcp-api-projector/src/project.ts) for the shared three-valued-tag reasoning. */
  readonly deprecated?: boolean;
};

/** Derived-from-type facts for one method, keyed by its dot-joined name. Same shape MCP's `ToolSchema` carries, plus `outputSchema` (which api-tree's `extractToolSchemas` already produces but MCP doesn't consume). */
export type MethodSchema = {
  readonly paramsSchema?: JsonSchema;
  readonly resultSchema?: JsonSchema;
  readonly description?: string;
};

/** Map of method name -> derived schema/description (from codegen). */
export type SchemaMap = Readonly<Record<string, MethodSchema>>;

/** A dispatch entry: the leaf's handler plus its `meta.jsonrpc.sourceMap` (empty when the leaf declares no overrides) and its own `LeafMeta`. */
export type Dispatch = {
  readonly handler: Handler;
  readonly sourceMap: SourceMap;
  readonly meta: LeafMeta;
};

/** Options for `projectMethods`/`toMethods`. */
export type ProjectMethodsOptions = {
  /** Method-name -> derived params/result schema + description (from codegen). */
  readonly schemas?: SchemaMap;
};

/** `projectMethods`'s full result: the flat descriptor array plus the name -> handler dispatch table (server.ts resolves calls through this, not a second tree walk). */
export type ProjectMethodsResult = {
  readonly methods: JsonRpcMethod[];
  readonly handlers: ReadonlyMap<string, Dispatch>;
};

// ============================================================================
// meta.jsonrpc open bag
// ============================================================================

/**
 * `meta.jsonrpc` open bag — per-projection overrides for JSON-RPC method
 * generation, split by role (docs/design/meta-role-split-spec.md §2/§4),
 * mirroring `McpLeafMeta`/`McpBranchMeta` (mcp-api-projector/src/project.ts)
 * — no `JsonRpcSharedMeta`, every key here is either leaf-only or
 * branch-only, never both.
 */

/** `meta.jsonrpc` fields valid at LEAF position only. */
export type JsonRpcLeafMetaProperties = {
  /** Full method-name override (dot-prefix ignored when set). */
  readonly name?: string;
  /** Description text override. */
  readonly description?: string;
  /** Narrows the JSON-RPC error envelope's `data` field for this method (see `jsonRpcErrorSchema`). */
  readonly errorDataSchema?: JsonSchema;
  /** Per-param source overrides for this leaf's input assembly (see `packages/api-tree/src/input.ts`). Params not listed here resolve from the `"params"` store by their own name. */
  readonly sourceMap?: SourceMap;
  readonly [key: string]: unknown;
};

/** Wraps `JsonRpcLeafMetaProperties` under the `jsonrpc` key — extend `LeafMeta` with this in a deployment's augmentation file. */
export type JsonRpcLeafMeta = {
  readonly jsonrpc?: JsonRpcLeafMetaProperties;
};

/** `meta.jsonrpc` fields valid at BRANCH position only. */
export type JsonRpcBranchMetaProperties = {
  /** This node's own contribution to the dot-joined method-name prefix. */
  readonly segment?: string;
  readonly [key: string]: unknown;
};

/** Wraps `JsonRpcBranchMetaProperties` under the `jsonrpc` key — extend `BranchMeta` with this in a deployment's augmentation file. */
export type JsonRpcBranchMeta = {
  readonly jsonrpc?: JsonRpcBranchMetaProperties;
};

/**
 * Safely extract the open `meta.jsonrpc` bag. Accepts the intersection of
 * both role wrappers — this function is called on both leaf meta (reading
 * `.name`/`.description`/`.errorDataSchema`/`.sourceMap`) and branch meta
 * (reading `.segment`) at different call sites below; the intersection is
 * safe because the two roles' field sets don't overlap.
 */
export function getJsonRpcMeta(
  meta: JsonRpcLeafMeta & JsonRpcBranchMeta,
): JsonRpcLeafMetaProperties & JsonRpcBranchMetaProperties {
  const j = meta.jsonrpc;
  if (typeof j !== "object" || j === null) return {};
  return j;
}

// ============================================================================
// Tag -> metadata
// ============================================================================

/** Derive the three-valued readOnly/destructive/idempotent fields from a Tags bag (the leaf's own meta.tags) — omits a key entirely when its resolved value is unknown (undefined), same convention as MCP's `hintsFromTags`. */
function tagFields(
  tags: Tags,
): Pick<JsonRpcMethod, "readOnly" | "destructive" | "idempotent" | "streaming" | "deprecated"> {
  const r = resolveTags(tags);
  const out: Record<string, boolean> = {};
  if (r.readOnly !== undefined) out.readOnly = r.readOnly;
  if (r.destructive !== undefined) out.destructive = r.destructive;
  if (r.idempotent !== undefined) out.idempotent = r.idempotent;
  if (r.streaming !== undefined) out.streaming = r.streaming;
  if (r.deprecated !== undefined) out.deprecated = r.deprecated;
  return out;
}

// ============================================================================
// Tree walk
// ============================================================================

/**
 * Walk a Node tree and produce a flat array of JSON-RPC method descriptors,
 * plus the name -> handler dispatch table `server.ts`'s transports use.
 * Single walk, single source of truth for name construction.
 *
 * Name construction (tree-position namespacing, dot-joined):
 *   root leaf "ping"                    -> "ping"
 *   child "users" / leaf "list"          -> "users.list"
 *   fallback name "bookId" / leaf "get"  -> "books.bookId.get"
 *   meta.jsonrpc.name on leaf            -> full override (dot-prefix ignored)
 *   meta.jsonrpc.segment on a child node -> that node's contribution to the prefix
 *
 * @param n     - The root node to walk.
 * @param opts  - Optional derived `schemas` map (from codegen).
 */
export function projectMethods(n: Node, opts: ProjectMethodsOptions = {}): ProjectMethodsResult {
  const schemas = opts.schemas ?? {};
  const handlers = new Map<string, Dispatch>();

  // Build one JsonRpcMethod (+ register its dispatch handler) for a leaf
  // node at a fully-resolved `name` — factored out so the same construction
  // applies to an ordinary child leaf (name = prefix + its own tree key) and
  // to a `fallback.subtree` that is itself a bare leaf (name = prefix + the
  // fallback's own name, no further key — see the `n.fallback` branch below,
  // mirroring mcp-api-projector/project.ts's `buildTool` and api-tree/tree.ts's
  // `walkNodeType` fix, aa28952). `descriptionFallback` is the last-resort
  // description text (the tree key for an ordinary leaf; the fallback's own
  // `name` when there is no key).
  const buildMethod = (child: Node, name: string, descriptionFallback: string): JsonRpcMethod => {
    const jr = getJsonRpcMeta(child.meta as JsonRpcLeafMeta & JsonRpcBranchMeta);
    const resolvedName = typeof jr.name === "string" ? jr.name : name;

    const derived = schemas[resolvedName];

    const description =
      typeof jr.description === "string"
        ? jr.description
        : typeof child.meta.description === "string"
          ? child.meta.description
          : typeof derived?.description === "string"
            ? derived.description
            : descriptionFallback;

    const errorSchema = jsonRpcErrorSchema(jr.errorDataSchema);

    handlers.set(resolvedName, {
      handler: child.handler as Handler,
      sourceMap: jr.sourceMap ?? {},
      meta: child.meta,
    });

    return {
      name: resolvedName,
      description,
      paramsSchema: derived?.paramsSchema ?? { type: "object" },
      ...(derived?.resultSchema !== undefined ? { resultSchema: derived.resultSchema } : {}),
      errorSchema,
      ...tagFields((child.meta.tags ?? {}) as Tags),
    };
  };

  // `nameSegments` (replaces a prior incrementally-rebuilt `prefix: string`)
  // is the name-scoped segment array — tree keys with `meta.jsonrpc.segment`
  // overrides folded in — joined via `escapeJoin` (@rhi-zone/fractal-api-tree/
  // path) exactly once, at each leaf, instead of unescaped-joining one level
  // at a time on the way down. Without this, a leaf key/segment/override that
  // itself contains "." (the delimiter) could derive the identical method
  // name as a genuinely different, deeper tree position — see api-tree's
  // path.ts and this fix's sibling in mcp-api-projector/project.ts.
  const walk = (n: Node, nameSegments: readonly string[]): JsonRpcMethod[] => {
    const out: JsonRpcMethod[] = [];

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        const name = escapeJoin([...nameSegments, key], ".");
        out.push(buildMethod(child, name, key));
      } else {
        const childJr = getJsonRpcMeta(child.meta as JsonRpcLeafMeta & JsonRpcBranchMeta);
        const rawSeg = typeof childJr.segment === "string" ? childJr.segment : key;
        out.push(...walk(child, [...nameSegments, rawSeg]));
      }
    }

    if (n.fallback !== undefined) {
      // The Node model allows `fallback.subtree` to be a bare leaf (`op()`),
      // not just a branch (`api({...})`) — walking it as a branch here
      // (`Object.entries(subtree.children ?? {})`) would silently see no
      // children and omit it entirely. Mirror extraction: when the subtree
      // itself is a leaf, build its method directly at `seg` (no extra
      // segment beyond the fallback's own name).
      const fallbackNameSegments = [...nameSegments, n.fallback.name];
      if (isLeaf(n.fallback.subtree)) {
        const seg = escapeJoin(fallbackNameSegments, ".");
        out.push(buildMethod(n.fallback.subtree, seg, n.fallback.name));
      } else {
        out.push(...walk(n.fallback.subtree, fallbackNameSegments));
      }
    }

    return out;
  };

  const methods = walk(n, []);
  return { methods, handlers };
}

/** Walk a Node tree and produce a flat array of JSON-RPC method descriptors. See `projectMethods` for the full walk. */
export function toMethods(n: Node, opts: ProjectMethodsOptions = {}): JsonRpcMethod[] {
  return projectMethods(n, opts).methods;
}
