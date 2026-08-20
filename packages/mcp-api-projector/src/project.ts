// MCP projection. One Node tree in; MCP tools, resources, and prompts out —
// one descriptor per leaf, alongside the dispatch tables server.ts resolves
// incoming calls through. `meta.mcp.as` picks a leaf's surface: "tool" by
// default, "resource" and "prompt" opt in explicitly. Each surface has its own
// walk (`projectTools`, `projectResources`, `projectPrompts`) that skips
// leaves belonging to the other two.
//
// Tool annotation hints (readOnlyHint, destructiveHint, idempotentHint,
// openWorldHint) come from the same `meta.tags` that picks a leaf's HTTP verb:
// one authoring act, two surfaces. `meta.tags.deprecated` and
// `meta.tags.streaming` are read the same way and surface on every descriptor
// kind. Tags are read from the leaf's own meta only — a branch's tags never
// reach its children (docs/design/router-model.md, "Tags").
//
// Tags are three-valued, and the projection preserves that: `true` and `false`
// each emit their hint; an unset tag emits no key at all, so a model reading a
// tool descriptor cannot mistake "unknown" for "false".
//
// Names and URIs come from tree position. Tools and prompts join their
// ancestors' keys with "_", resources join them with "/" behind a URI scheme,
// and a `fallback` node contributes its `name` (say, "userId") as a literal
// segment for tools and prompts but as a `{userId}` template variable for
// resources, whose value is only known at read time. `meta.mcp` overrides any
// of it per leaf or per branch — see `McpLeafMetaProperties` and
// `McpBranchMetaProperties` for the standard keys and the surface each applies
// to; the bag is open, so unrecognized keys pass through untouched.
//
// A tool's `inputSchema`, a prompt's `arguments`, and the last-resort
// description text all come from a `SchemaMap` derived from handler types at
// build time by @rhi-zone/fractal-api-tree's `extractToolSchemas`. Nothing here
// is hand-authored: absent a derived entry, `inputSchema` degrades to the MCP
// spec minimum, `{ type: "object" }`.
//
// A handler returning a `stream` or `page` TypeRef kind needs one extra step.
// JSON Schema has no vocabulary for either, so type-ir's `toJsonSchema` lowers
// both to an array schema tagged with a vendor extension — `x-stream: true` or
// `x-page-style: "cursor" | "offset"` (type-ir/src/json-schema.ts). MCP's
// `outputSchema` field accepts object schemas only, so that array can never be
// assigned to it verbatim. `unwrapKindSchema` below reads the marker back off
// and splits it in two: the kind becomes `McpTool.streaming`/`.paginated`/
// `.pageStyle`, and the element schema becomes `outputSchema` when it is itself
// object-shaped. This is `http-api-projector/src/codegen.ts`'s
// `unwrapStreamSchema` widened to also understand `x-page-style`, which no
// other projector reads; `json-rpc-api-projector/src/project.ts` publishes the
// same streaming fact but takes it from `meta.tags` instead of from a schema.
//
// See:
//   packages/api-tree/src/tags.ts              — tag lattice (resolveTags)
//   packages/api-tree/src/tree.ts              — extractToolSchemas (schema source)
//   packages/http-api-projector/src/project.ts — sibling projection (structural mirror)
//   docs/archive/fc-op-kinds/projection-mcp.md — archived design note this projection
//                                                was derived from: MCP's concept list,
//                                                and which of those concepts recur
//                                                across projections

import { isLeaf, readMetaBag } from "@rhi-zone/fractal-api-tree/node";
import { escapeJoin } from "@rhi-zone/fractal-api-tree/path";
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags";
import { assertUniqueName } from "@rhi-zone/fractal-api-tree/tree";
import type { Tags } from "@rhi-zone/fractal-api-tree/tags";
import type { Handler, LeafMeta, Node } from "@rhi-zone/fractal-api-tree/node";
import type { SourceMap } from "@rhi-zone/fractal-api-tree";

// ============================================================================
// Types
// ============================================================================

/**
 * The `annotations` object on an MCP tool descriptor (MCP spec 2025-03-26).
 *
 * The four planning hints and `title` are typed; the index signature keeps the
 * type open, so a tree author can attach any other annotation the spec grows
 * without this package needing to learn about it first.
 *
 * A hint key appears only when the tag behind it resolved to `true` or
 * `false`. An unresolved tag emits nothing, because a model reading the
 * descriptor would otherwise read a missing `readOnlyHint` as an assertion
 * that the tool is not read-only.
 */
export type McpAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly title?: string;
  readonly [key: string]: unknown;
};

/**
 * One MCP tool descriptor, produced from one leaf of the Node tree.
 *
 * `inputSchema` is a real JSON Schema whenever the leaf has an entry in the
 * `SchemaMap` handed to `toTools` — @rhi-zone/fractal-api-tree's
 * `extractToolSchemas` builds those by reading handler input types through the
 * TypeScript compiler API. Without an entry it falls back to `{ type:
 * "object" }`, the least the MCP spec accepts. There is no hand-authored
 * schema anywhere in this path.
 */
export type McpTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * The derived output schema, from the same `SchemaMap` entry `inputSchema`
   * comes from, and present only if it is object-shaped — MCP's own
   * `ToolSchema` (`@modelcontextprotocol/sdk`) accepts nothing else here. A
   * `stream`- or `page`-kinded output lowers to an array schema, which would
   * fail that constraint, so its element schema is what lands here (again,
   * only if object-shaped) and the kind itself moves to `streaming` /
   * `paginated` / `pageStyle` below. Absent when the leaf has no derived
   * schema, or when what survives unwrapping is not an object schema.
   */
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: McpAnnotations;
  /**
   * The handler yields its output incrementally rather than returning it in
   * one piece — a `stream` TypeRef kind, `AsyncIterable<T>` at the type level
   * (`StreamEffect`, @rhi-zone/fractal-api-tree). A client can read this to
   * decide up front whether to expect `notifications/progress` and multiple
   * content blocks instead of a single result; server.ts's
   * `collectStreamedToolContent` is what produces them.
   *
   * Two sources, in priority order: an authored `meta.tags.streaming` wins
   * outright, whether it says `true` or `false`, and the derived schema's
   * `x-stream` marker is consulted only when no tag was authored. That is the
   * same authored-beats-inferred precedence `resolveTags` applies to its
   * `outputType` argument. With neither source the key is omitted rather than
   * set to `false`.
   */
  readonly streaming?: boolean;
  /**
   * The handler returns one page of a larger result set — a `page` TypeRef
   * kind, `CursorPage<T>` or `OffsetPage<T>` at the type level (`Page<T>`,
   * @rhi-zone/fractal-api-tree). Read from the derived schema's
   * `x-page-style` marker and nowhere else: pagination is a TypeRef-kind
   * convention (api-tree's page.ts), not something the tag lattice models, so
   * there is no authored tag that could take precedence. Omitted when the
   * derived schema carries no marker.
   */
  readonly paginated?: boolean;
  /** Which of `Page<T>`'s two conventions the pagination follows. Set only alongside `paginated: true`. */
  readonly pageStyle?: "cursor" | "offset";
  /**
   * The operation is slated for removal. Read from `meta.tags.deprecated`
   * (api-tree/src/tags.ts) — the same authored fact the CLI and HTTP/OpenAPI
   * projections surface in their own vocabularies. Omitted rather than set to
   * `false` when the tag says otherwise or says nothing, matching how every
   * other tag-derived field here behaves. No MCP spec revision defines a
   * standard `deprecated` field, so this rides along as an extra descriptor
   * key that a client may surface or ignore.
   */
  readonly deprecated?: boolean;
};

/**
 * Everything derived from one leaf's handler types, keyed by the name the leaf
 * projects to. @rhi-zone/fractal-api-tree's `extractToolSchemas` builds these
 * at build time; this projection reads them for `inputSchema`, for a prompt's
 * `arguments`, and for the description used when neither `meta.mcp.description`
 * nor `meta.description` supplies one.
 */
export type ToolSchema = {
  readonly inputSchema?: Record<string, unknown>;
  /**
   * The handler's output type, lowered to JSON Schema. Identical in shape to
   * what http-api-projector and json-rpc-api-projector read as their own
   * `outputSchema` / `resultSchema`. When it carries a `stream` or `page`
   * marker, `unwrapKindSchema` below splits it into `McpTool.streaming` /
   * `.paginated` / `.pageStyle` plus an element schema, rather than passing it
   * through to `McpTool.outputSchema`, which MCP requires to be object-shaped.
   */
  readonly outputSchema?: Record<string, unknown>;
  readonly description?: string;
};

/** Every leaf's derived facts, keyed by the name that leaf projects to. */
export type SchemaMap = Readonly<Record<string, ToolSchema>>;

/**
 * What a tool or prompt call needs at dispatch time, recorded during the same
 * walk that built the descriptor so the two can never disagree about which
 * handler a name belongs to.
 */
export type Dispatch = {
  readonly handler: Handler;
  /**
   * The leaf's `meta.mcp.sourceMap`, or empty when it declared none. server.ts
   * feeds this to the shared `assemble` pipeline
   * (packages/api-tree/src/input.ts) to decide which store each of the
   * handler's parameters is read from.
   */
  readonly sourceMap: SourceMap;
  /**
   * The leaf's own meta, so anything downstream of dispatch — middleware
   * context, the ALS init hook — can read it without walking the tree a second
   * time.
   */
  readonly meta: LeafMeta;
};

/** Options for `toTools`. */
export type ToToolsOptions = {
  /** Derived schemas and descriptions, keyed by projected tool name. */
  readonly schemas?: SchemaMap;
};

// ============================================================================
// Annotation hints from the tag lattice
// ============================================================================

/**
 * Turn one leaf's `meta.tags` into the annotation hints MCP understands.
 *
 * `resolveTags` applies the lattice's implications first (readOnly implies
 * idempotent, and so on). Each hint is then written only if its resolved value
 * is `true` or `false`; an unresolved tag leaves its key out entirely, which is
 * what keeps "unknown" distinguishable from "no" in the emitted descriptor.
 */
function hintsFromTags(tags: Tags): Record<string, boolean> {
  const r = resolveTags(tags);
  const hints: Record<string, boolean> = {};
  if (r.readOnly !== undefined) hints.readOnlyHint = r.readOnly;
  if (r.destructive !== undefined) hints.destructiveHint = r.destructive;
  if (r.idempotent !== undefined) hints.idempotentHint = r.idempotent;
  if (r.openWorld !== undefined) hints.openWorldHint = r.openWorld;
  return hints;
}

// ============================================================================
// stream/page kind recovery from a derived output schema
// ============================================================================

/** A derived schema as it looks once type-ir has lowered a `stream` or `page` kind onto it (type-ir/src/json-schema.ts). */
type KindTaggedSchema = Record<string, unknown> & {
  readonly ["x-stream"]?: boolean;
  readonly ["x-page-style"]?: "cursor" | "offset";
  readonly items?: Record<string, unknown> | false;
};

/** What `unwrapKindSchema` recovers: the kind facts, and the schema left over as a candidate for `McpTool.outputSchema`. */
type KindInfo = {
  readonly outputSchema?: Record<string, unknown>;
  readonly streaming: boolean;
  readonly paginated: boolean;
  readonly pageStyle?: "cursor" | "offset";
};

/**
 * Read a `stream` or `page` kind back off a derived output schema, separating
 * the kind from the element schema it wraps.
 *
 * type-ir emits at most one of `x-stream` and `x-page-style` on any schema, so
 * the two branches below are alternatives, never both. A schema carrying
 * neither marker is not an array wrapper at all and comes back untouched as the
 * candidate output schema. Either way the result is only a candidate: callers
 * still apply `isObjectSchema` before it can reach `McpTool.outputSchema`.
 *
 * http-api-projector's `unwrapStreamSchema` (codegen.ts) does the `x-stream`
 * half of this for the HTTP client generator.
 */
function unwrapKindSchema(schema: Record<string, unknown> | undefined): KindInfo {
  const tagged = schema as KindTaggedSchema | undefined;
  if (tagged?.["x-stream"] === true) {
    const item = tagged.items;
    return {
      ...(item !== undefined && item !== false ? { outputSchema: item } : {}),
      streaming: true,
      paginated: false,
    };
  }
  const pageStyle = tagged?.["x-page-style"];
  if (pageStyle !== undefined) {
    const item = tagged?.items;
    return {
      ...(item !== undefined && item !== false ? { outputSchema: item } : {}),
      streaming: false,
      paginated: true,
      pageStyle,
    };
  }
  return {
    ...(schema !== undefined ? { outputSchema: schema } : {}),
    streaming: false,
    paginated: false,
  };
}

/** MCP's `outputSchema` field takes object schemas and nothing else (`@modelcontextprotocol/sdk`'s `ToolSchema`). */
function isObjectSchema(
  schema: Record<string, unknown> | undefined,
): schema is Record<string, unknown> {
  return schema !== undefined && schema.type === "object";
}

// ============================================================================
// MCP meta extraction
// ============================================================================

// `meta.mcp` is where a tree author overrides what this projection would
// otherwise derive. It is split by the position it is authored at, per
// docs/design/meta-role-split-spec.md §2 and §4. There is no shared fragment
// between the two halves: every key below is meaningful at exactly one
// position.

/** What `meta.mcp` accepts on a leaf. Listed keys are typed; anything else is carried through untouched, as the open-bag design (docs/design/design-philosophy.md) intends. */
export type McpLeafMetaProperties = {
  /** Replaces the derived tool or prompt name outright — no tree-position prefix is applied. On a resource, replaces the descriptor's `name` (its URI comes from `uri`). */
  readonly name?: string;
  /** Replaces the description, outranking both `meta.description` and the description derived from the handler's JSDoc. */
  readonly description?: string;
  /** Emitted as `annotations.title`. Tools only. */
  readonly title?: string;
  /** Merged over the tag-derived hints, key by key, with these winning. Tools only. */
  readonly annotations?: McpAnnotations;
  /**
   * Which surface this leaf projects to. Omitting it means "tool", so an
   * ordinary `op()` needs no MCP-specific authoring at all; "resource" and
   * "prompt" are explicit opt-ins, and each of the three walks below ignores
   * leaves claimed by the other two.
   */
  readonly as?: "tool" | "resource" | "prompt";
  /** Replaces the URI derived from tree position. Resources only. */
  readonly uri?: string;
  /** Replaces the default `"application/json"`. Resources only. */
  readonly mimeType?: string;
  /**
   * Per-parameter overrides for input assembly (packages/api-tree/src/input.ts):
   * which store a parameter is read from, and under which key. Parameters left
   * out resolve the usual way — from the call's `arguments` for a tool or
   * prompt, from the captured URI variables for a resource template. Fixed
   * resources take no input, so this has no effect there.
   */
  readonly sourceMap?: SourceMap;
  readonly [key: string]: unknown;
};

/** `McpLeafMetaProperties` under the `mcp` key. A deployment's augmentation file extends `LeafMeta` with this. */
export type McpLeafMeta = {
  readonly mcp?: McpLeafMetaProperties;
};

/** What `meta.mcp` accepts on a branch. */
export type McpBranchMetaProperties = {
  /** Replaces the tree key this branch would otherwise contribute to its descendants' names and URIs. */
  readonly segment?: string;
  readonly [key: string]: unknown;
};

/** `McpBranchMetaProperties` under the `mcp` key. A deployment's augmentation file extends `BranchMeta` with this. */
export type McpBranchMeta = {
  readonly mcp?: McpBranchMetaProperties;
};

// Name/URI-collision guarding for the walks below (`projectTools`,
// `projectResources`, `projectPrompts`) uses `@rhi-zone/fractal-api-tree/tree`'s
// `assertUniqueName` rather than a copy defined here — names are built by
// calling `@rhi-zone/fractal-api-tree/path`'s `escapeJoin` exactly once at
// each leaf, over the full name-segment array (with "_" for tools/prompts, or
// "/" behind a URI scheme for resources — see `projectTools`'s doc comment),
// which makes two DIFFERENT tree positions' DERIVED names provably unable to
// collide (escapeJoin escapes the delimiter within each segment before
// joining; see path.test.ts's round-trip property). What escaping cannot
// cover — because it bypasses the join entirely — is an AUTHORED
// `meta.mcp.name`/`meta.mcp.uri` override supplying a final string outright:
// nothing stops one leaf's override from being authored to equal another
// leaf's derived (or also-overridden) name. `assertUniqueName` is kept for
// exactly that residual case. `tree.ts`'s type-level walk (`extractToolSchemas`/
// `extractToolTypeRefs`) guards the identical override-collision case for the
// identical reason — `extractToolSchemas`'s derived name and this file's
// runtime-projected name are supposed to be the same string for the same tree
// (this file's own doc comment, "meta.mcp.name ... replaces the derived tool
// name") — so one shared implementation lives there (mcp-api-projector
// already depends on api-tree, never the reverse) instead of two copies of
// the same collision-tracking logic diverging over time.

/**
 * Read the `mcp` bag off a node's meta, or an empty bag when there is none.
 *
 * The parameter type intersects both role wrappers because the walks below call
 * this at leaf positions (for `name`, `description`, and the rest) and at
 * branch positions (for `segment`) alike. The intersection loses nothing: the
 * two roles share no key, so no field can mean one thing at a leaf and another
 * at a branch.
 */
export function getMcpMeta(
  meta: McpLeafMeta & McpBranchMeta,
): McpLeafMetaProperties & McpBranchMetaProperties {
  return readMetaBag<McpLeafMetaProperties & McpBranchMetaProperties>(meta.mcp);
}

// ============================================================================
// Tree walk
// ============================================================================

/** The descriptors `tools/list` answers with, and the table `tools/call` dispatches through. */
export type ProjectToolsResult = {
  readonly tools: McpTool[];
  readonly handlers: ReadonlyMap<string, Dispatch>;
};

/**
 * Project every tool leaf in a Node tree, building the descriptors and the
 * dispatch table in a single pass so a tool's advertised name is by
 * construction the name its handler is registered under.
 *
 * Names come from tree position, joined with underscores:
 *
 *   root leaf "get"                  → "get"
 *   child "users", leaf "list"       → "users_list"
 *   fallback "userId", leaf "get"    → "users_userId_get"
 *
 * `meta.mcp.segment` replaces one branch's contribution to that prefix, and
 * `meta.mcp.name` on the leaf replaces the whole name, prefix included.
 *
 * @param n    - The root node to walk.
 * @param opts - Optionally, the schemas derived from handler types by
 *               @rhi-zone/fractal-api-tree's `extractToolSchemas`.
 */
export function projectTools(n: Node, opts: ToToolsOptions = {}): ProjectToolsResult {
  const schemas = opts.schemas ?? {};
  const handlers = new Map<string, Dispatch>();
  const usedNames = new Map<string, readonly string[]>();

  // Builds one descriptor and registers one dispatch entry for a leaf whose
  // name is already fully resolved. Two callers need exactly this: an ordinary
  // child leaf, named prefix + its tree key, and a `fallback.subtree` that is
  // itself a bare leaf, named prefix + the fallback's own name and nothing
  // further. `descriptionFallback` is whichever of those two the description
  // falls back to when no other source supplies one. `segments` is the raw
  // (unjoined) tree-position path to this leaf, used only to name both sides
  // of a name collision in `assertUniqueName`'s error.
  const buildTool = (
    child: Node,
    name: string,
    descriptionFallback: string,
    segments: readonly string[],
  ): McpTool | undefined => {
    const mcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);

    // Leaves claimed by another surface belong to projectResources or
    // projectPrompts; an absent `as` means "tool".
    if (mcp.as !== undefined && mcp.as !== "tool") return undefined;

    const resolvedName = typeof mcp.name === "string" ? mcp.name : name;
    assertUniqueName(
      usedNames,
      "tool name",
      resolvedName,
      segments,
      "Disambiguate one of them with an explicit meta.mcp.name (on the leaf) " +
        "or meta.mcp.segment (on an ancestor branch).",
    );

    // Keyed by the resolved name, so a `meta.mcp.name` override and its
    // derived schema stay together.
    const derived = schemas[resolvedName];

    // Four description sources, most specific first: the MCP override, the
    // protocol-agnostic `meta.description`, the handler's own JSDoc as
    // extracted at build time, and finally the leaf's key.
    const description =
      typeof mcp.description === "string"
        ? mcp.description
        : typeof child.meta.description === "string"
          ? child.meta.description
          : typeof derived?.description === "string"
            ? derived.description
            : descriptionFallback;

    const baseHints = hintsFromTags((child.meta.tags ?? {}) as Tags);

    const annotationOverride: Record<string, unknown> =
      typeof mcp.annotations === "object" && mcp.annotations !== null
        ? (mcp.annotations as Record<string, unknown>)
        : {};

    const titleEntry: Record<string, string> =
      typeof mcp.title === "string" ? { title: mcp.title } : {};

    // Tag-derived hints first, then per-key overrides, then the title. An
    // annotations object with nothing in it is dropped rather than emitted
    // empty.
    const annotationsMerged = { ...baseHints, ...annotationOverride, ...titleEntry };
    const annotations: McpAnnotations | undefined =
      Object.keys(annotationsMerged).length > 0 ? annotationsMerged : undefined;

    const resolved = resolveTags((child.meta.tags ?? {}) as Tags);
    const deprecated = resolved.deprecated === true;

    // An authored `meta.tags.streaming` settles the question either way; the
    // schema's `x-stream` marker is consulted only in its absence, and can
    // only ever turn streaming on. Pagination has no authored counterpart, so
    // it comes from the schema alone.
    const kind = unwrapKindSchema(derived?.outputSchema);
    const streaming = resolved.streaming ?? (kind.streaming ? true : undefined);
    const outputSchema = isObjectSchema(kind.outputSchema) ? kind.outputSchema : undefined;

    handlers.set(resolvedName, {
      handler: child.handler as Handler,
      sourceMap: mcp.sourceMap ?? {},
      meta: child.meta,
    });

    return {
      name: resolvedName,
      description,
      inputSchema: derived?.inputSchema ?? { type: "object" },
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
      ...(streaming !== undefined ? { streaming } : {}),
      ...(kind.paginated
        ? {
            paginated: true,
            ...(kind.pageStyle !== undefined ? { pageStyle: kind.pageStyle } : {}),
          }
        : {}),
      ...(deprecated ? { deprecated: true } : {}),
    };
  };

  // `nameSegments` (replaces a prior incrementally-rebuilt `prefix: string`)
  // is the name-scoped segment array — tree keys with `meta.mcp.segment`
  // overrides folded in — joined via `escapeJoin` exactly once, at each leaf,
  // instead of unescaped-joined one level at a time on the way down.
  const walk = (
    n: Node,
    nameSegments: readonly string[],
    segments: readonly string[],
  ): McpTool[] => {
    const out: McpTool[] = [];

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        const name = escapeJoin([...nameSegments, key], "_");
        const tool = buildTool(child, name, key, [...segments, key]);
        if (tool !== undefined) out.push(tool);
      } else {
        const childMcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);
        const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key;
        out.push(...walk(child, [...nameSegments, rawSeg], [...segments, key]));
      }
    }

    if (n.fallback !== undefined) {
      // A fallback contributes its own name as the next segment.
      const fallbackNameSegments = [...nameSegments, n.fallback.name];
      const fallbackSegments = [...segments, `:${n.fallback.name}`];

      // `fallback.subtree` may be a bare `op()` rather than an `api({...})` —
      // the Node model allows either (api-tree/node.ts). Recursing as though it
      // were a branch would read `children`, find none, and drop the leaf
      // without a trace, so a bare leaf is built directly at `seg`, with no
      // segment beyond the fallback's own name. Extraction resolves the same
      // case the same way, in api-tree/tree.ts's `walkNodeType` (aa28952).
      if (isLeaf(n.fallback.subtree)) {
        const seg = escapeJoin(fallbackNameSegments, "_");
        const tool = buildTool(n.fallback.subtree, seg, n.fallback.name, fallbackSegments);
        if (tool !== undefined) out.push(tool);
      } else {
        out.push(...walk(n.fallback.subtree, fallbackNameSegments, fallbackSegments));
      }
    }

    return out;
  };

  const tools = walk(n, [], []);
  return { tools, handlers };
}

/**
 * The tool descriptors alone, for callers with no dispatching to do — a
 * generator emitting a manifest, a test asserting on shape. `projectTools`
 * documents how names and descriptors are built and additionally hands back
 * the dispatch table.
 *
 * @param n    - The root node to walk.
 * @param opts - Optionally, the schemas derived from handler types by
 *               @rhi-zone/fractal-api-tree's `extractToolSchemas`.
 */
export function toTools(n: Node, opts: ToToolsOptions = {}): McpTool[] {
  return projectTools(n, opts).tools;
}

// ============================================================================
// Resource projection
// ============================================================================
//
// A leaf marked `meta.mcp.as: "resource"` becomes an addressable thing to read
// rather than an operation to call. It projects to a Resource when its URI is
// fixed, or to a ResourceTemplate when an ancestor fallback put a `{var}`
// placeholder in it — the fallback's value is only known once a read arrives,
// so it cannot be baked into a listed URI.
//
// URIs are built from tree position exactly as tool names are, with two
// differences: segments join with "/" behind a URI scheme, and a fallback
// contributes `{name}` rather than `name`.
//
// Resources carry neither annotations nor an input schema. MCP defines no
// annotations for them, and a read's only input is whatever its own URI
// captured.

/** A resource at one concrete URI, listable and readable as-is. */
export type McpResource = {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  /**
   * The read yields its content incrementally. Unlike `McpTool.streaming`,
   * this can only come from an authored `meta.tags.streaming`: a resource read
   * has no derived output schema to carry an `x-stream` marker.
   *
   * The flag changes what `resources/list` advertises, nothing more. A handler
   * returning an `AsyncIterable` is drained into multiple `contents` entries
   * either way, by server.ts's `collectStreamedResourceContents`.
   */
  readonly streaming?: boolean;
  /** As `McpTool.deprecated`: read from `meta.tags.deprecated`, present only when asserted. */
  readonly deprecated?: boolean;
};

/** A family of resources sharing one URI shape, with `{var}` placeholders bound per read. */
export type McpResourceTemplate = {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  /** As `McpResource.streaming`. */
  readonly streaming?: boolean;
  /** As `McpTool.deprecated`: read from `meta.tags.deprecated`, present only when asserted. */
  readonly deprecated?: boolean;
};

/** One template made executable: the compiled pattern that recognizes a read URI, and everything needed to serve it. */
export type ResourceTemplateHandler = {
  readonly uriTemplate: string;
  /** The template's variables in the order their capture groups appear in `pattern`. */
  readonly paramNames: readonly string[];
  readonly mimeType: string;
  readonly pattern: RegExp;
  readonly handler: Handler;
  /** As `Dispatch.sourceMap`. */
  readonly sourceMap: SourceMap;
  /** As `Dispatch.meta`. */
  readonly meta: LeafMeta;
};

/** What a fixed resource needs to be read. No `sourceMap`, because a fixed URI captures nothing to assemble from. */
export type ResourceDispatch = {
  readonly handler: Handler;
  readonly meta: LeafMeta;
};

/** Options for `projectResources`. */
export type ProjectResourcesOptions = {
  /** The scheme derived URIs are built behind. Defaults to `"resource://"`; a client must be told the same one (see `McpClientOptions.resourceScheme`). */
  readonly scheme?: string;
};

/** What `resources/list` and `resources/templates/list` answer with, and the two tables `resources/read` dispatches through. */
export type ProjectResourcesResult = {
  readonly resources: McpResource[];
  readonly resourceTemplates: McpResourceTemplate[];
  /** Fixed resources, found by exact URI. */
  readonly handlers: ReadonlyMap<string, ResourceDispatch>;
  /** Templates, tried in order against a read URI until one matches. */
  readonly templateHandlers: readonly ResourceTemplateHandler[];
};

/** Escape a string so a `RegExp` built from it matches the string literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn a URI template such as `resource://users/{userId}/profile` into a
 * pattern that recognizes concrete read URIs, plus the variable names its
 * capture groups correspond to, in order.
 *
 * Each placeholder becomes a capture group matching one path segment, so a
 * variable never swallows a "/" and templates stay unambiguous at read time.
 */
function compileUriTemplate(uriTemplate: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let patternSource = "";
  let lastIndex = 0;
  const varPattern = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = varPattern.exec(uriTemplate)) !== null) {
    patternSource += escapeRegExp(uriTemplate.slice(lastIndex, match.index));
    patternSource += "([^/]+)";
    paramNames.push(match[1]!);
    lastIndex = match.index + match[0].length;
  }
  patternSource += escapeRegExp(uriTemplate.slice(lastIndex));
  return { pattern: new RegExp(`^${patternSource}$`), paramNames };
}

/**
 * Project every resource leaf in a Node tree, building the descriptors and the
 * two dispatch tables in a single pass, so a listed URI is by construction the
 * URI a read resolves against.
 *
 * URIs come from tree position, joined with slashes behind the scheme:
 *
 *   root leaf "config"                       → "resource://config"
 *   child "users", leaf "list"               → "resource://users/list"
 *   fallback "userId", leaf "profile"        → "resource://users/{userId}/profile"
 *
 * The third is a template rather than a fixed resource, and everything under a
 * fallback becomes one. `meta.mcp.segment` replaces one branch's contribution;
 * `meta.mcp.uri` on the leaf replaces the URI outright, placeholders included.
 *
 * @param n    - The root node to walk.
 * @param opts - Optionally, the URI `scheme` to build behind.
 */
export function projectResources(
  n: Node,
  opts: ProjectResourcesOptions = {},
): ProjectResourcesResult {
  const scheme = opts.scheme ?? "resource://";
  const handlers = new Map<string, ResourceDispatch>();
  const templateHandlers: ResourceTemplateHandler[] = [];
  // Fixed resources and templates are matched through entirely different
  // mechanisms (exact `handlers` lookup vs. trying each `templateHandlers`
  // pattern in turn), so a fixed URI and a template's `uriTemplate` never
  // actually contend for the same dispatch slot — tracked as two separate
  // collision sets rather than one shared with `assertUniqueName`.
  const usedUris = new Map<string, readonly string[]>();
  const usedUriTemplates = new Map<string, readonly string[]>();

  // Builds one descriptor and registers one dispatch entry for a leaf whose
  // URI segments are already resolved, for the same two callers `buildTool`
  // serves: an ordinary child leaf, and a `fallback.subtree` that is itself a
  // bare leaf. `hasFallback` decides which of the two tables the leaf lands
  // in, and `defaultKey` is what its name and description fall back to.
  const buildResource = (
    child: Node,
    leafSegments: readonly string[],
    defaultKey: string,
    hasFallback: boolean,
  ): { resource?: McpResource; resourceTemplate?: McpResourceTemplate } | undefined => {
    const mcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);

    // Resources are opt-in; a leaf that did not ask for this surface belongs to
    // one of the other two.
    if (mcp.as !== "resource") return undefined;

    const derivedUri = `${scheme}${escapeJoin(leafSegments, "/")}`;
    const uri = typeof mcp.uri === "string" ? mcp.uri : derivedUri;

    const name = typeof mcp.name === "string" ? mcp.name : defaultKey;

    const description =
      typeof mcp.description === "string"
        ? mcp.description
        : typeof child.meta.description === "string"
          ? child.meta.description
          : defaultKey;

    const mimeType = typeof mcp.mimeType === "string" ? mcp.mimeType : "application/json";

    // Both come straight from the leaf's tags — a resource read has no derived
    // output schema for either to be inferred from.
    const resolved = resolveTags((child.meta.tags ?? {}) as Tags);
    const deprecated = resolved.deprecated === true;
    const streaming = resolved.streaming;

    if (hasFallback) {
      assertUniqueName(
        usedUriTemplates,
        "resource template URI",
        uri,
        leafSegments,
        "Disambiguate one of them with an explicit meta.mcp.uri (on the leaf) " +
          "or meta.mcp.segment (on an ancestor branch).",
      );
      const { pattern, paramNames } = compileUriTemplate(uri);
      templateHandlers.push({
        uriTemplate: uri,
        paramNames,
        pattern,
        mimeType,
        handler: child.handler as Handler,
        sourceMap: mcp.sourceMap ?? {},
        meta: child.meta,
      });
      return {
        resourceTemplate: {
          uriTemplate: uri,
          name,
          description,
          mimeType,
          ...(streaming !== undefined ? { streaming } : {}),
          ...(deprecated ? { deprecated: true } : {}),
        },
      };
    }

    assertUniqueName(
      usedUris,
      "resource URI",
      uri,
      leafSegments,
      "Disambiguate one of them with an explicit meta.mcp.uri (on the leaf) " +
        "or meta.mcp.segment (on an ancestor branch).",
    );
    handlers.set(uri, { handler: child.handler as Handler, meta: child.meta });
    return {
      resource: {
        uri,
        name,
        description,
        mimeType,
        ...(streaming !== undefined ? { streaming } : {}),
        ...(deprecated ? { deprecated: true } : {}),
      },
    };
  };

  const walk = (
    n: Node,
    segments: readonly string[],
    hasFallback: boolean,
  ): { resources: McpResource[]; resourceTemplates: McpResourceTemplate[] } => {
    const resources: McpResource[] = [];
    const resourceTemplates: McpResourceTemplate[] = [];

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        const built = buildResource(child, [...segments, key], key, hasFallback);
        if (built?.resource !== undefined) resources.push(built.resource);
        if (built?.resourceTemplate !== undefined) resourceTemplates.push(built.resourceTemplate);
      } else {
        const childMcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);
        const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key;
        const sub = walk(child, [...segments, rawSeg], hasFallback);
        resources.push(...sub.resources);
        resourceTemplates.push(...sub.resourceTemplates);
      }
    }

    if (n.fallback !== undefined) {
      // A fallback contributes a placeholder, not a literal segment, and
      // everything below it therefore lists as a template — `hasFallback` stays
      // true for the rest of the descent.
      const fallbackSegments = [...segments, `{${n.fallback.name}}`];

      // A bare-leaf `fallback.subtree` needs building directly, for the reason
      // spelled out in `projectTools`' matching branch.
      if (isLeaf(n.fallback.subtree)) {
        const built = buildResource(n.fallback.subtree, fallbackSegments, n.fallback.name, true);
        if (built?.resource !== undefined) resources.push(built.resource);
        if (built?.resourceTemplate !== undefined) resourceTemplates.push(built.resourceTemplate);
      } else {
        const sub = walk(n.fallback.subtree, fallbackSegments, true);
        resources.push(...sub.resources);
        resourceTemplates.push(...sub.resourceTemplates);
      }
    }

    return { resources, resourceTemplates };
  };

  const { resources, resourceTemplates } = walk(n, [], false);
  return { resources, resourceTemplates, handlers, templateHandlers };
}

// ============================================================================
// Prompt projection
// ============================================================================
//
// A leaf marked `meta.mcp.as: "prompt"` becomes a named, parameterized message
// template the client can ask for. Prompts are addressed by name, so their
// names are built exactly as tool names are, fallbacks and the `meta.mcp.name`
// override included.
//
// A prompt's declared `arguments` come from the same derived input schema a
// tool's `inputSchema` comes from: one argument per property, marked required
// where the schema says so. MCP defines no annotations for prompts, so none are
// derived.

/** One argument a prompt declares, as advertised by `prompts/list`. */
export type McpPromptArgument = {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
};

/** One prompt descriptor, produced from one leaf marked `meta.mcp.as: "prompt"`. */
export type McpPrompt = {
  readonly name: string;
  readonly description: string;
  readonly arguments?: McpPromptArgument[];
  /**
   * The handler produces its messages incrementally. Authored via
   * `meta.tags.streaming` and only that: a prompt's derived output schema
   * describes what the handler returns in domain terms, not the
   * `GetPromptResult.messages` shape server.ts's `collectStreamedMessages`
   * builds from it, so there is nothing there to infer from.
   */
  readonly streaming?: boolean;
  /** As `McpTool.deprecated`: read from `meta.tags.deprecated`, present only when asserted. */
  readonly deprecated?: boolean;
};

/** Options for `projectPrompts`. */
export type ProjectPromptsOptions = {
  /** Derived schemas and descriptions, keyed by projected prompt name. The same map `projectTools` reads. */
  readonly schemas?: SchemaMap;
};

/** What `prompts/list` answers with, and the table `prompts/get` dispatches through. */
export type ProjectPromptsResult = {
  readonly prompts: McpPrompt[];
  readonly handlers: ReadonlyMap<string, Dispatch>;
};

/**
 * Read a prompt's declared arguments off its derived input schema: one per
 * property, carrying that property's description, marked required where the
 * schema's `required` list says so.
 *
 * Returns nothing when there are no properties to read — no schema at all, or
 * the bare `{ type: "object" }` placeholder — so a prompt with nothing to
 * declare omits `arguments` rather than advertising an empty list.
 */
function argumentsFromSchema(
  schema: Record<string, unknown> | undefined,
): McpPromptArgument[] | undefined {
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties === undefined || typeof properties !== "object") return undefined;

  const required = Array.isArray(schema?.required) ? (schema.required as unknown[]) : [];

  const args = Object.entries(properties).map(([name, propSchema]) => {
    const description =
      typeof propSchema.description === "string" ? propSchema.description : undefined;
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(required.includes(name) ? { required: true } : {}),
    };
  });

  return args.length > 0 ? args : undefined;
}

/**
 * Project every prompt leaf in a Node tree, building the descriptors and the
 * dispatch table in a single pass. Names are built exactly as `projectTools`
 * builds them; that function documents the scheme.
 *
 * @param n    - The root node to walk.
 * @param opts - Optionally, the schemas derived from handler types by
 *               @rhi-zone/fractal-api-tree's `extractToolSchemas`.
 */
export function projectPrompts(n: Node, opts: ProjectPromptsOptions = {}): ProjectPromptsResult {
  const schemas = opts.schemas ?? {};
  const handlers = new Map<string, Dispatch>();
  const usedNames = new Map<string, readonly string[]>();

  // Builds one descriptor and registers one dispatch entry for a leaf whose
  // name is already resolved, serving the same two callers `buildTool` does.
  // `segments` is the raw (unjoined) tree-position path to this leaf, used
  // only to name both sides of a name collision in
  // `assertUniqueName`'s error.
  const buildPrompt = (
    child: Node,
    name: string,
    descriptionFallback: string,
    segments: readonly string[],
  ): McpPrompt | undefined => {
    const mcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);

    // Prompts are opt-in; a leaf that did not ask for this surface belongs to
    // one of the other two.
    if (mcp.as !== "prompt") return undefined;

    const resolvedName = typeof mcp.name === "string" ? mcp.name : name;
    assertUniqueName(
      usedNames,
      "prompt name",
      resolvedName,
      segments,
      "Disambiguate one of them with an explicit meta.mcp.name (on the leaf) " +
        "or meta.mcp.segment (on an ancestor branch).",
    );

    // Keyed by the resolved name, so a `meta.mcp.name` override and its
    // derived schema stay together.
    const derived = schemas[resolvedName];

    // Four description sources, most specific first: the MCP override, the
    // protocol-agnostic `meta.description`, the handler's own JSDoc as
    // extracted at build time, and finally the leaf's key.
    const description =
      typeof mcp.description === "string"
        ? mcp.description
        : typeof child.meta.description === "string"
          ? child.meta.description
          : typeof derived?.description === "string"
            ? derived.description
            : descriptionFallback;

    const args = argumentsFromSchema(derived?.inputSchema);

    // Both come straight from the leaf's tags, as they do for a resource.
    const resolved = resolveTags((child.meta.tags ?? {}) as Tags);
    const deprecated = resolved.deprecated === true;

    handlers.set(resolvedName, {
      handler: child.handler as Handler,
      sourceMap: mcp.sourceMap ?? {},
      meta: child.meta,
    });

    return {
      name: resolvedName,
      description,
      ...(args !== undefined ? { arguments: args } : {}),
      ...(resolved.streaming !== undefined ? { streaming: resolved.streaming } : {}),
      ...(deprecated ? { deprecated: true } : {}),
    };
  };

  // Same name-segment-array-carried-to-a-single-escapeJoin-call scheme as
  // `projectTools`' walk — see that function's matching comment.
  const walk = (
    n: Node,
    nameSegments: readonly string[],
    segments: readonly string[],
  ): McpPrompt[] => {
    const out: McpPrompt[] = [];

    for (const [key, child] of Object.entries(n.children ?? {})) {
      if (isLeaf(child)) {
        const name = escapeJoin([...nameSegments, key], "_");
        const prompt = buildPrompt(child, name, key, [...segments, key]);
        if (prompt !== undefined) out.push(prompt);
      } else {
        const childMcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);
        const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key;
        out.push(...walk(child, [...nameSegments, rawSeg], [...segments, key]));
      }
    }

    if (n.fallback !== undefined) {
      const fallbackNameSegments = [...nameSegments, n.fallback.name];
      const fallbackSegments = [...segments, `:${n.fallback.name}`];

      // A bare-leaf `fallback.subtree` needs building directly, for the reason
      // spelled out in `projectTools`' matching branch.
      if (isLeaf(n.fallback.subtree)) {
        const seg = escapeJoin(fallbackNameSegments, "_");
        const prompt = buildPrompt(n.fallback.subtree, seg, n.fallback.name, fallbackSegments);
        if (prompt !== undefined) out.push(prompt);
      } else {
        out.push(...walk(n.fallback.subtree, fallbackNameSegments, fallbackSegments));
      }
    }

    return out;
  };

  const prompts = walk(n, [], []);
  return { prompts, handlers };
}
