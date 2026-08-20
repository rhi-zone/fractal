// Generic name-derivation tree walk — the shared shape behind mcp-api-
// projector's `projectTools`/`projectPrompts` and json-rpc-api-projector's
// `projectMethods`: walk a Node tree, join tree-position segments with a
// delimiter (via `escapeJoin`, ./path.ts) with each branch's own
// `meta.<namespace>.segment` override folded into the join input before the
// join happens, and hand each resolved leaf off to a caller-supplied
// builder. That join/segment/fallback machinery is identical across all
// three walks; only the delimiter, the meta namespace key, and what a leaf
// becomes vary — those are exactly this function's three parameters.
//
// Everything protocol-specific that ISN'T one of those three axes — name-
// collision detection via `assertUniqueName` (mcp's two walks call it,
// json-rpc's doesn't), a leaf's own opt-in/opt-out surface filter (mcp's
// `meta.mcp.as`), the output shape itself — already lived entirely inside
// each protocol's own leaf-builder closure before this walker existed, never
// in the walk loop. So factoring the walk out changes nothing about that:
// a builder that wants collision detection or a skip filter keeps doing
// both exactly as it already did, inside the function it hands to
// `buildLeaf`; a builder that doesn't (json-rpc's) still doesn't.
//
// Two walks that are NOT this shape, deliberately left alone:
//   - GraphQL's own walk (graphql-api-projector's `project.ts`, `camelJoin`)
//     uses a fundamentally different escape scheme — see path.ts's module
//     doc, the paragraph on GraphQL, for why backslash-escaping (what this
//     walker's join relies on) can't apply there without changing what a
//     camelCase-joined field name is allowed to look like.
//   - api-tree/tree.ts's `walkNodeType` walks a `ts.Type` via the TypeScript
//     checker at BUILD time — no runtime `Node` value exists yet at that
//     point, and it reads meta through `getPropertyOfType`/
//     `getTypeOfSymbolAtLocation` rather than plain property access.
//     Sharing an implementation with a runtime walker would mean pretending
//     type-level and value-level traversal are the same operation; the
//     recursion SHAPE rhymes (and its own doc comment says so), but the
//     vocabulary at every step is different in kind, not just in degree.

import { isLeaf, readMetaBag, type Node } from "./node.ts";
import { escapeJoin } from "./path.ts";

/**
 * Builds one output item for a leaf whose name is already fully resolved
 * (tree-position segments already joined into `name`). Returns `undefined`
 * to drop the leaf entirely (e.g. a `meta.<namespace>.as`-style surface
 * filter) — `walkNamedTree` skips an `undefined` result rather than pushing
 * it.
 *
 * `segments` is the raw (unjoined) tree-position path to this leaf, passed
 * through for a builder that wants to report both sides of a name collision
 * concretely (see `assertUniqueName`, api-tree/tree.ts); a builder with no
 * collision detection of its own simply ignores this parameter.
 */
export type TreeWalkLeafBuilder<T> = (
  child: Node,
  name: string,
  descriptionFallback: string,
  segments: readonly string[],
) => T | undefined;

/** Options for `walkNamedTree` — the three axes that vary across its callers (see module doc). */
export type WalkNamedTreeOptions<T> = {
  /** Single-character delimiter `escapeJoin` joins name segments on (e.g. `"_"` for MCP tool/prompt names, `"."` for JSON-RPC method names). */
  readonly delimiter: string;
  /**
   * The `meta.<namespace>` bag a branch's own `segment` override is read
   * from (e.g. `"mcp"`, `"jsonrpc"`) — a plain runtime string, read
   * structurally via `readMetaBag` off `child.meta[namespace]` the same way
   * every other namespaced-meta read site in this codebase does, never a
   * protocol-name literal baked into this function (which is what keeps
   * this module itself core-blind — docs/design/meta-role-split-spec.md).
   */
  readonly namespace: string;
  /** Builds one output item per resolved leaf — see `TreeWalkLeafBuilder`. */
  readonly buildLeaf: TreeWalkLeafBuilder<T>;
};

/**
 * Walk a Node tree, deriving each leaf's name from tree position and handing
 * each resolved leaf to `opts.buildLeaf`. See this module's doc comment for
 * which existing walks this consolidates (mcp's `projectTools`/
 * `projectPrompts`, json-rpc's `projectMethods`) and which two it
 * deliberately does not (GraphQL's `camelJoin`, api-tree/tree.ts's
 * type-level `walkNodeType`).
 *
 * A `fallback.subtree` that is itself a bare leaf (an `op()`, not an
 * `api({...})` — the Node model allows either, api-tree/node.ts) is built
 * directly at the fallback's own name segment, with no further key beyond
 * it — recursing into it as though it were a branch would read `children`,
 * find none, and silently drop the leaf. Mirrors api-tree/tree.ts's
 * `walkNodeType` handling of the identical case at the type level.
 */
export function walkNamedTree<T>(n: Node, opts: WalkNamedTreeOptions<T>): T[] {
  const { delimiter, namespace, buildLeaf } = opts;

  const branchSegment = (child: Node, key: string): string => {
    const ns = readMetaBag<{ readonly segment?: string }>(child.meta[namespace]);
    return typeof ns.segment === "string" ? ns.segment : key;
  };

  const walk = (
    node: Node,
    nameSegments: readonly string[],
    segments: readonly string[],
  ): T[] => {
    const out: T[] = [];

    for (const [key, child] of Object.entries(node.children ?? {})) {
      if (isLeaf(child)) {
        const name = escapeJoin([...nameSegments, key], delimiter);
        const item = buildLeaf(child, name, key, [...segments, key]);
        if (item !== undefined) out.push(item);
      } else {
        const rawSeg = branchSegment(child, key);
        out.push(...walk(child, [...nameSegments, rawSeg], [...segments, key]));
      }
    }

    if (node.fallback !== undefined) {
      const fallbackNameSegments = [...nameSegments, node.fallback.name];
      const fallbackSegments = [...segments, `:${node.fallback.name}`];

      if (isLeaf(node.fallback.subtree)) {
        const seg = escapeJoin(fallbackNameSegments, delimiter);
        const item = buildLeaf(node.fallback.subtree, seg, node.fallback.name, fallbackSegments);
        if (item !== undefined) out.push(item);
      } else {
        out.push(...walk(node.fallback.subtree, fallbackNameSegments, fallbackSegments));
      }
    }

    return out;
  };

  return walk(n, [], []);
}
