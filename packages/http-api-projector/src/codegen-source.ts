// packages/http-api-projector/src/codegen-source.ts — static-analysis client
// codegen: `generateClientFromSource(entryFilePath, options)`.
//
// `generateClientFromNode` (codegen.ts) needs a live, already-imported `Node`
// value at codegen-script run time (`import { api } from "../src/tree.ts"`)
// purely to recover two facts a bare `HttpRoute` loses once `applyMoveTo` has
// run: a co-located member's AUTHORED local key (`.read()` instead of
// `.get()`) and its exact `extractToolSchemas` codegen name (for the
// `SchemaMap` lookup). Neither fact actually requires RUNNING the tree —
// both are already derivable statically, by the exact same TypeScript-
// compiler-API machinery `extractToolSchemas`/`extractRouteSchemas` use to
// derive input/output schemas without ever importing the tree either
// (api-tree's tree.ts: `walkNodeType`, `readMetaStringLiteral`,
// `forEachTreeCandidate`). This module reuses that machinery directly rather
// than re-deriving it, and reuses `route.ts`'s own rewriters
// (`applyMethods`/`applyMoveTo`/`applyResponse`) unchanged — the only new
// piece is the skeleton `HttpRoute` these rewriters run over, built from a
// resolved TYPE instead of a live `Node`.
//
// ── Skeleton construction ────────────────────────────────────────────────
// `naiveTransform` (route.ts) can't run here — it walks a live `Node`. This
// module's `buildSkeletonRoute` reproduces exactly what `naiveTransform`
// would produce for the tree's AUTHORED shape (before any rewriter runs):
// every leaf becomes a `methods.POST` entry, every branch becomes
// `children`, `fallback` threads through the same `{ name, subtree }` shape
// — but built by planting each leaf `walkNodeType` finds (keyed by its own
// `path` array, e.g. `["books", ":bookId", "read"]` — a fallback segment
// prefixed `:name`, matching `extractRouteSchemas`' own path convention)
// into an initially-empty tree, rather than recursing a live `Node`'s
// `children`/`fallback` directly. Each leaf's own `meta.http.method`/
// `meta.http.moveTo` — the only two `meta` keys `applyMethods`/`applyMoveTo`
// read that affect a route's STRUCTURE (path/verb), which is all this
// module's consumer (`codegen.ts`'s `render`) ever looks at — are read via
// `readMetaStringLiteral`, degrading to `undefined` exactly like every other
// static meta read in this codebase (`apply-validation-build.ts`'s wire-
// profile build depends on the identical degradation for a non-string-
// literal value; see that file's module doc). `meta.http.response`
// (`applyResponse`'s own directive) is deliberately NOT read here:
// `applyResponse` only WRAPS a leaf's handler function (never touches
// `meta`, route structure, or schema data), and `codegen.ts`'s renderer
// never calls a handler or inspects wrapping — so whether `applyResponse`
// wraps this module's placeholder handler is structurally inert for
// codegen's output. Branch-position `meta.http.moveTo` (an `api(children, {
// meta: { http: { moveTo: ... } } })` directive on a BRANCH rather than a
// leaf) is legal per `applyMoveTo`'s own `detach()` but not read here —
// grep across this repo found no authored tree actually using it (every
// `http.moveTo` call site is on a leaf, via `op(fn, http.verb,
// http.moveTo(...))`); this is a deliberate, narrower scope than a fully
// general static `Node` reconstruction would need, not an oversight.
//
// ── Naming ───────────────────────────────────────────────────────────────
// Each planted leaf's codegen name is `walkNodeType`'s own `name` (the exact
// string `extractToolSchemas` keys its `SchemaMap` by, `meta.mcp.name`
// overrides included) — reused verbatim, not re-derived. Its member name is
// the leaf's own last `path` segment (its authored local key — or, for a
// bare-leaf `fallback.subtree`, the fallback's own name, since `path`'s last
// segment is `:name` in that case and the leading `:` is stripped) — the
// same authored-local-key convention `codegen.ts`'s own
// `buildMemberNameMap` uses for a live `Node`. Both are attached to
// `codegenNames`/`memberNames` maps keyed by a SYNTHETIC per-leaf handler
// placeholder minted while planting that leaf (never invoked; `codegen.ts`'s
// renderer never calls a handler either) — the same `Map<Handler, string>`
// shape `codegen.ts`'s `buildTree`/`attachOperation` already consult for
// `generateClientFromNode`, so this module needs no changes to that shared
// walker at all. A real `Handler` reference works as `buildCodegenNameMap`'s
// map key today because it's the one thing that's both unique per leaf and
// preserved unchanged across `applyMoveTo` (a subtree move relocates whole
// method-entry objects, never rebuilding the handler reference inside); a
// freshly-minted placeholder closure, one per leaf, satisfies the exact same
// two properties without needing a live tree to source real handlers from.
//
// See:
//   packages/http-api-projector/src/codegen.ts   — generateClientWithNames (shared render tail), generateClientFromNode (live-Node sibling)
//   packages/http-api-projector/src/route.ts     — HttpRoute, httpRoute(), applyMethods/applyMoveTo/applyResponse, composeTransforms
//   packages/api-tree/src/tree.ts                — walkNodeType, readMetaStringLiteral, forEachTreeCandidate, extractToolSchemas
//   packages/api-tree/src/extract.ts             — createExtractorProgram

import ts from "typescript";
import { createExtractorProgram } from "@rhi-zone/fractal-api-tree/extract";
import {
  extractToolSchemas,
  forEachTreeCandidate,
  readMetaStringLiteral,
  walkNodeType,
} from "@rhi-zone/fractal-api-tree/tree";
import type { Handler } from "@rhi-zone/fractal-api-tree/node";
import {
  applyMethods,
  applyMoveTo,
  applyResponse,
  composeTransforms,
  httpRoute,
} from "./route.ts";
import type { HttpRoute, RouteLeafMeta, RouteMeta } from "./route.ts";
import { generateClientWithNames } from "./codegen.ts";
import type { CodegenOptions } from "./codegen.ts";

// ============================================================================
// Public API
// ============================================================================

export type SourceCodegenOptions = CodegenOptions & {
  /**
   * Which exported tree to generate a client for, when `entryFilePath`
   * exports more than one `api(children, opts?)` tree — the exporting
   * binding's own name (`forEachTreeCandidate`'s `treeId`: a `const`
   * identifier or factory function name). Required only in that multi-tree
   * case; a single-tree file resolves its sole tree automatically. Mirrors
   * `openapi.ts`'s `OpenApiOpts.treeId`/`resolveTreeId` — same ambiguity,
   * same "name it explicitly or get a loud error listing every candidate"
   * resolution, not a silent guess.
   */
  readonly treeId?: string;
};

/**
 * Generate a standalone typed TypeScript client directly from an entry
 * file's SOURCE — no runtime import of the tree at all. Reaches the same
 * full-fidelity naming `generateClientFromNode` gets from a live `Node`
 * (authored member names surviving `applyMoveTo` co-location, exact
 * `extractToolSchemas` codegen-name matches), because both facts are
 * already statically derivable: this module reconstructs an `HttpRoute`
 * skeleton from the entry file's exported tree's resolved TYPE (via
 * `walkNodeType`/`readMetaStringLiteral`, the same machinery
 * `extractToolSchemas` itself uses) and runs it through the real
 * `applyMethods`/`applyMoveTo`/`applyResponse` pipeline (route.ts) — see
 * this file's module doc for the full account, including the one narrower-
 * than-fully-general scope (leaf-only `http.moveTo`, no `http.response`
 * read) and why it doesn't affect codegen's output either way.
 *
 * `entryFilePath` is walked directly (no caller-supplied `SchemaMap`
 * parameter, unlike `generateClient`/`generateClientFromNode`) —
 * `extractToolSchemas(entryFilePath)` is called internally, over the SAME
 * `ts.Program` this function already builds to read the tree's structure,
 * so there is no second, redundant compiler run.
 */
export function generateClientFromSource(
  entryFilePath: string,
  options: SourceCodegenOptions = {},
): string {
  const program = createExtractorProgram(entryFilePath);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryFilePath);
  if (!source) {
    throw new Error(`generateClientFromSource: source file not found: ${entryFilePath}`);
  }

  const candidates: Array<{ readonly nodeType: ts.Type; readonly loc: ts.Node; readonly treeId: string }> =
    [];
  forEachTreeCandidate(source, checker, (nodeType, loc, treeId) => {
    candidates.push({ nodeType, loc, treeId });
  });

  if (candidates.length === 0) {
    throw new Error(`generateClientFromSource: no exported api() tree found in ${entryFilePath}`);
  }

  const chosen =
    options.treeId !== undefined
      ? candidates.find((c) => c.treeId === options.treeId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;

  if (chosen === undefined) {
    const ids = candidates.map((c) => c.treeId);
    if (options.treeId !== undefined) {
      throw new Error(
        `generateClientFromSource: no tree named "${options.treeId}" in ${entryFilePath} ` +
          `(found: ${ids.join(", ")})`,
      );
    }
    throw new Error(
      `generateClientFromSource: ${entryFilePath} exports ${ids.length} trees (${ids.join(", ")}) — ` +
        `schema/route correlation can't tell which one to generate a client for. Pass options.treeId to disambiguate.`,
    );
  }

  const { route, codegenNames, memberNames } = buildSkeletonRoute(
    chosen.nodeType,
    chosen.loc,
    checker,
  );
  const projected = composeTransforms(applyMethods, applyMoveTo, applyResponse)(route);
  // Scoped to the SAME candidate `chosen` above already resolved — an
  // unscoped call would walk every exported tree in `entryFilePath` again,
  // which throws on a multi-tree file whose candidates happen to derive the
  // same tool names (e.g. a raw tree and its `applyValidation`-wrapped
  // copy) even though `chosen` already disambiguated which one this client
  // is for.
  const schemas = extractToolSchemas(entryFilePath, { program, treeId: chosen.treeId });

  return generateClientWithNames(projected, codegenNames, memberNames, schemas, options);
}

// ============================================================================
// Internal: leaf facts + trie planting — turns `walkNodeType`'s flat,
// path-keyed leaf callbacks into a nested route skeleton `naiveTransform`
// would have produced from the same tree authored as a live `Node`.
// ============================================================================

type LeafFact = {
  readonly name: string; // walkNodeType's own underscore-joined codegen name
  readonly path: readonly string[]; // fallback segment prefixed ":name"
  readonly method: string | undefined; // meta.http.method (leaf-local)
  readonly moveTo: string | undefined; // meta.http.moveTo (leaf-local)
};

/** Mutable working tree `plant` inserts each `LeafFact` into, before conversion to real `HttpRoute` values. */
type Draft = {
  readonly children: Map<string, Draft>;
  fallbackName?: string;
  fallbackChild?: Draft;
  leaf?: LeafFact;
};

function freshDraft(): Draft {
  return { children: new Map() };
}

/**
 * Insert one leaf at its authored `path` into `node`, creating intermediate
 * branch/fallback drafts along the way (mkdir-p, same spirit as route.ts's
 * own `insertAt`, but planting a single leaf into a tree built from scratch
 * rather than relocating an already-built subtree during `applyMoveTo`). A
 * `:name`-prefixed segment becomes a `fallback` position; the segment right
 * before the end of `path` — static or `:name` alike — is the leaf's own
 * position (a `:name` segment ending `path` is the bare-leaf
 * `fallback.subtree` case `walkNodeType` itself produces the same way).
 */
function plant(node: Draft, path: readonly string[], leaf: LeafFact): void {
  const [seg, ...rest] = path;
  if (seg === undefined) return; // unreachable: every leaf's path has >=1 segment
  if (seg.startsWith(":")) {
    const name = seg.slice(1);
    if (node.fallbackChild === undefined) {
      node.fallbackName = name;
      node.fallbackChild = freshDraft();
    }
    if (rest.length === 0) node.fallbackChild.leaf = leaf;
    else plant(node.fallbackChild, rest, leaf);
    return;
  }
  let child = node.children.get(seg);
  if (child === undefined) {
    child = freshDraft();
    node.children.set(seg, child);
  }
  if (rest.length === 0) child.leaf = leaf;
  else plant(child, rest, leaf);
}

/** `{ http: { method?, moveTo? } }`, or `{}` when neither is present — same shape naiveTransform's `node.meta` carries through to a route position. */
function leafMetaOf(leaf: LeafFact): RouteLeafMeta {
  if (leaf.method === undefined && leaf.moveTo === undefined) return {};
  return {
    http: {
      ...(leaf.method !== undefined ? { method: leaf.method } : {}),
      ...(leaf.moveTo !== undefined ? { moveTo: leaf.moveTo } : {}),
    },
  } as RouteLeafMeta;
}

/**
 * Convert a `Draft` into a real `HttpRoute` (via `httpRoute()`, so it's
 * brand-registered like any other route value), minting one placeholder
 * `Handler` per leaf and recording its codegen/member names — see this
 * file's module doc, "Naming", for why a synthetic per-leaf handler
 * reference is a sound `Map` key here (unique per leaf, untouched by
 * `applyMoveTo`) without needing real handler identity from a live tree.
 * Never a leaf AND a branch/fallback at the same `Draft` (the `op()`/`api()`
 * split `walkNodeType` itself enforces makes that combination unreachable),
 * so the two are handled as a plain if/else, matching `naiveTransformNode`'s
 * own leaf-xor-branch shape.
 */
function draftToRoute(
  draft: Draft,
  codegenNames: Map<Handler, string>,
  memberNames: Map<Handler, string>,
): HttpRoute {
  const children =
    draft.children.size > 0
      ? Object.fromEntries(
          [...draft.children].map(([key, child]) => [
            key,
            draftToRoute(child, codegenNames, memberNames),
          ]),
        )
      : undefined;
  const fallback =
    draft.fallbackChild !== undefined
      ? {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          name: draft.fallbackName!,
          subtree: draftToRoute(draft.fallbackChild, codegenNames, memberNames),
        }
      : undefined;

  if (draft.leaf !== undefined) {
    const leaf = draft.leaf;
    const handler: Handler = () => undefined;
    codegenNames.set(handler, leaf.name);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const lastSeg = leaf.path[leaf.path.length - 1]!;
    memberNames.set(handler, lastSeg.startsWith(":") ? lastSeg.slice(1) : lastSeg);
    const meta = leafMetaOf(leaf);
    return httpRoute({ methods: { POST: { handler, meta } }, children, fallback, meta });
  }

  return httpRoute({ children, fallback, meta: {} as RouteMeta });
}

/**
 * Build the naive (pre-rewriter) `HttpRoute` skeleton for one exported
 * tree's resolved TYPE, plus the `codegenNames`/`memberNames` maps
 * `generateClientWithNames` (codegen.ts) needs — the static-analysis
 * counterpart to calling `naiveTransform(node)` + `buildCodegenNameMap(node)`
 * + `buildMemberNameMap(node)` on a live `Node`.
 */
function buildSkeletonRoute(
  nodeType: ts.Type,
  loc: ts.Node,
  checker: ts.TypeChecker,
): {
  readonly route: HttpRoute;
  readonly codegenNames: Map<Handler, string>;
  readonly memberNames: Map<Handler, string>;
} {
  const root = freshDraft();
  walkNodeType(nodeType, [], [], loc, checker, (name, path, _fn, _descriptionSource, _checker, leafNodeType) => {
    const method = readMetaStringLiteral(leafNodeType, "http", "method", loc, checker);
    const moveTo = readMetaStringLiteral(leafNodeType, "http", "moveTo", loc, checker);
    plant(root, path, { name, path, method, moveTo });
  });

  const codegenNames = new Map<Handler, string>();
  const memberNames = new Map<Handler, string>();
  const route = draftToRoute(root, codegenNames, memberNames);
  return { route, codegenNames, memberNames };
}
