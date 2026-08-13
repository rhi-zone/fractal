// The HTTP route tree — a SEPARATE type from the API tree (`Node`). The API
// tree is organized by domain (children are operations); the route tree is
// organized by protocol (path segments, HTTP methods). A transform pipeline
// produces the route tree from the API tree:
//
//   Node --naiveTransform--> HttpRoute --rewriters--> HttpRoute --makeRouter--> Fetch
//
// See docs/design/routing-and-transforms.md for the full design.
//
// Three pieces live here:
//   1. `HttpRoute` — the route tree type + `httpRoute()` constructor.
//   2. `naiveTransform` — the mechanical `Node => HttpRoute` baseline: every
//      child becomes a path-segment child, every handler becomes a single
//      POST entry. No inference, no convention.
//   3. Rewriters — `HttpRoute => HttpRoute` functions, each reading one flat
//      `meta.http.*` scalar key and reshaping the tree: `applyMethods`,
//      `applyMoveTo`, `applyResponse`. `composeTransforms` chains them into
//      a single `HttpRoute => HttpRoute`.
//   4. `makeRouterFromRoute` — the simple exact-path/method dispatcher over
//      an `HttpRoute` tree (no attribute dispatch, no match conditions —
//      those remain the direct tree-walk dispatcher's domain; see project.ts).
//
// Dispatch (decode → handler → encode) is a fixed, linear pipeline, not an
// interceptable multi-stage one. AOT-compiled validation runs via
// `@rhi-zone/fractal-api-tree/apply-validation`'s `applyValidation(key,
// projectedTree, "http")` — the recommended, wire-profile-driven 3-arg form
// (see preset.ts's module doc for what it buys over the still-supported
// 2-arg `applyValidation(key, projectedTree)` form) — wired onto the
// already-projected `HttpRoute`, typically as a `preset.ts` `rewriters`
// entry. The same `applyValidation` call also applies at the `Node` level,
// before this file's transforms run, for a tree shared with MCP/CLI.
//
// What remains here is `runRoute` (below): decode the request via `sources`
// (per-route — each route has its own parameter names and source
// overrides), optionally run a Standard Schema validator declared via
// `http.validate()` (verbs.ts) against the decoded input, call the handler,
// encode the response — a fixed, single check against `sources.validate`,
// not a loop over stages.

import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import type { Handler, LeafMeta, Node, SharedMeta } from "@rhi-zone/fractal-api-tree/node";
import {
  composeErrorEncoders,
  isCursorPage,
  isOffsetPage,
  isPageShape,
  isResultShape,
  isStreamChunk,
  isStreamProgress,
  matchKind,
} from "@rhi-zone/fractal-api-tree";
import type {
  DetectionOptions,
  ErrorEncoder,
  Page,
  ServiceStores,
} from "@rhi-zone/fractal-api-tree";
import type { HttpLeafMeta, HttpSharedMeta } from "./project.ts";
import {
  BUILTIN_HTTP_STORE_NAMES,
  httpStores,
  primaryStoreForMethod,
  assemble,
  parseRequestBody,
  runStandardSchema,
} from "./decode.ts";
import type { HttpStoreBag, SourceMap, StandardSchemaV1 } from "./decode.ts";

// `HttpLeafMeta`/`HttpSharedMeta` are type-only imports from
// project.ts, which VALUE-imports from this file (`naiveTransform`,
// `makeRouterFromRoute`, …) — a type-only import here can't create a runtime
// cycle (TS erases it at emit), so this stays safe despite the value-import
// direction the other way. `RouteMeta`/`RouteLeafMeta` below mirror
// `Node["meta"]`'s own `SharedMeta`/`LeafMeta` split (node.ts) — the branch-
// position `HttpRoute["meta"]` and the leaf-position
// `HttpRoute["methods"][x]["meta"]`, respectively — intersected with this
// package's own `http` namespace fragment for the position. Every field on
// every one of these interfaces is optional (within this package's own
// UNAUGMENTED view of `SharedMeta`/`LeafMeta` — only a deployment's own
// augmentation file ever adds a required field, see
// docs/design/meta-role-split-spec.md §2/§3), so `RouteMeta`/`RouteLeafMeta`
// are freely mutually assignable to each other and to their own
// constituents — no casts needed to pass a `SharedMeta`/`LeafMeta` value
// into either, only to read a field off an expression whose OWN declared
// type doesn't carry it.
export type RouteMeta = SharedMeta & HttpSharedMeta;
export type RouteLeafMeta = LeafMeta & HttpLeafMeta;

// ============================================================================
// Sources — declarative per-route decode configuration. Real, protocol-
// specific work (which store a param comes from), not part of any removed
// interceptable-pipeline machinery.
// ============================================================================

export type Sources = {
  /** per-param overrides — e.g. `{ apiKey: { store: "header", key: "x-api-key" } }` */
  readonly sourceMap?: SourceMap;
  /** explicit list of param names to extract (when absent, bulk-collects all available values) */
  readonly paramNames?: readonly string[];
  /**
   * The leaf's own pre-`moveTo` ancestor fallback-name chain, stamped by
   * `naiveTransform` at the earliest point in the pipeline, before any
   * rewriter (including `applyMoveTo` and any user-supplied transform) can
   * relocate the leaf. Empty/absent means the leaf was never nested under a
   * wildcard in its authored tree position.
   *
   * A leaf's field↔store binding must be a pure function of its authored
   * declarations (local path-slug ancestry + explicit `sourceMap` entries),
   * not of where `moveTo` happens to relocate it. `defaultDecode` (below)
   * intersects this list against whatever the final match actually produces,
   * instead of trusting the final match's raw slug set wholesale — see that
   * function's own doc comment for the full reasoning, and
   * `findRouteSourceCoverageProblems` for the wire-time check that turns a
   * `moveTo` relocating a leaf away from its authored slug into a loud error
   * instead of a silently-empty field.
   *
   * `undefined` (as opposed to `[]`) means this `Sources` value did not come
   * from `naiveTransform` — a hand-built `HttpRoute` (several low-level
   * tests in this package construct `httpRoute()` literals directly,
   * bypassing `naiveTransform`) has no authored-position history to consult,
   * so `defaultDecode` falls back to its bulk-slug behavior for those. A
   * leaf that did go through `naiveTransform` but was never nested under a
   * wildcard gets `[]`, not `undefined` — an empty authored set, correctly
   * excluding it from any implicit path binding.
   */
  readonly authoredPathParams?: readonly string[];
  /** optional reshape after assembly, before the handler sees the input */
  readonly transform?: (bag: Record<string, unknown>) => Record<string, unknown>;
  /**
   * A Standard Schema (https://standardschema.dev/) validator attached via
   * `http.validate()` (verbs.ts) — run by `runRoute` against the assembled
   * input, after decode/transform and before the handler. See
   * `http.validate()`'s own doc comment for the full contract.
   */
  readonly validate?: StandardSchemaV1;
};

// ============================================================================
// HttpRoute type + constructor
// ============================================================================

/**
 * Generic in `H` (a method entry's own handler type), defaulting to the
 * erased `Handler` — same convention as `Node<H>` (see node.ts). Plain
 * `HttpRoute` (no type argument) keeps working everywhere it's used as an
 * erased type (dispatch, `Record<string, HttpRoute>`, etc.); only the
 * type-preserving rewriters below (`naiveTransform`, `applyMethods`,
 * `applyResponse`) lean on the generic via their own recursively-computed
 * return types — nothing else has to opt in.
 */
export type HttpRoute<H extends Handler = Handler> = {
  readonly methods?: Readonly<
    Record<
      string,
      { readonly handler: H; readonly meta: RouteLeafMeta; readonly sources?: Sources }
    >
  >;
  readonly children?: Readonly<Record<string, HttpRoute>>;
  readonly fallback?: { readonly name: string; readonly subtree: HttpRoute };
  readonly meta: RouteMeta;
};

/**
 * Runtime brand for `HttpRoute` values — lets `makeRouter` distinguish an
 * `HttpRoute` from a `Node` at its overload boundary (both shapes carry
 * `children`/`meta`; the brand is the only reliable discriminator). Every
 * route produced by `httpRoute()` (and therefore by `naiveTransform` and the
 * rewriters, which all go through it) carries the brand.
 */
const routeBrand = new WeakSet<object>();

/** Construct an `HttpRoute` value. Registers the value for `isHttpRoute`. */
export function httpRoute(def: {
  methods?:
    | Record<string, { handler: Handler; meta: RouteLeafMeta; sources?: Sources }>
    | undefined;
  children?: Record<string, HttpRoute> | undefined;
  fallback?: { name: string; subtree: HttpRoute } | undefined;
  meta?: RouteMeta | undefined;
}): HttpRoute {
  const route: HttpRoute = {
    ...(def.methods !== undefined ? { methods: def.methods } : {}),
    ...(def.children !== undefined ? { children: def.children } : {}),
    ...(def.fallback !== undefined ? { fallback: def.fallback } : {}),
    meta: def.meta ?? {},
  };
  routeBrand.add(route);
  return route;
}

/** True when `v` is an `HttpRoute` produced by `httpRoute()`. */
export function isHttpRoute(v: unknown): v is HttpRoute {
  return typeof v === "object" && v !== null && routeBrand.has(v);
}

// ============================================================================
// Flat-key readers — shared by the rewriters below. These are route.ts's own
// copies of these reads, not calls to `getHttpMeta` (project.ts): project.ts
// imports from this file, so a reverse import would cycle. The flat design's
// fold already resolves each key (last-wins scalars, key-merged sourceMap)
// at `op()`/`mergeMeta` time (api-tree's node.ts), so these are plain field
// reads, not a directive-array walk — see project.ts's own module doc for
// the fuller design history.
// ============================================================================

function sourceMapOf(meta: RouteLeafMeta): SourceMap | undefined {
  return meta.http?.sourceMap;
}

function validateOf(meta: RouteLeafMeta): StandardSchemaV1 | undefined {
  return meta.http?.validate;
}

/**
 * Assembles a leaf's `sources` object for `naiveTransformNode` — factored out
 * so the `sourceMap`/`validate` reads happen exactly once each (inlining this
 * as a conditional spread loses the narrowing from the presence check to the
 * value itself across two separate calls to `sourceMapOf`/`validateOf`, since
 * TypeScript can't know two calls return the same result).
 */
function buildSources(meta: RouteLeafMeta, authoredPathParams: readonly string[]): Sources {
  const sourceMap = sourceMapOf(meta);
  const validate = validateOf(meta);
  return {
    ...(sourceMap !== undefined ? { sourceMap } : {}),
    ...(validate !== undefined ? { validate } : {}),
    authoredPathParams,
  };
}

function paginatedDirectiveOf(meta: RouteLeafMeta):
  | {
      readonly style?: "cursor" | "offset";
      readonly inputCursorParam?: string;
      readonly inputOffsetParam?: string;
      readonly inputLimitParam?: string;
    }
  | undefined {
  return meta.http?.paginated;
}

// ============================================================================
// 1. Naive transform: Node => HttpRoute
//
// Every child becomes a path-segment child. Every handler becomes a single
// POST entry in `methods`. meta is copied through unchanged. Recursive.
// ============================================================================

/**
 * The precise `HttpRoute` shape `naiveTransform` produces for a given input
 * tree type `N` — computed recursively from `N`'s own children/fallback,
 * mirroring the actual leaf-into-`methods.POST`, branch-into-`children`
 * mechanics below at the type level. This is what lets `getBook`'s real
 * `(input: {id:string}) => Book` signature survive `naiveTransform` as
 * `route.children.getBook.methods.POST.handler`, instead of widening to the
 * erased `Handler`.
 *
 * Each branch below is a plain conditional (not `infer ... : never`) so a
 * node that is neither/both leaf-and-branch contributes exactly the fields it
 * has — `Node`'s own optional fields never leak in as "present but any",
 * because `op()`'s return type marks `handler` as present (not optional)
 * when it truly is a leaf; a pure branch's type has no `handler` key at all
 * to match against.
 *
 * `fallback.subtree`'s precision is only as good as what `api()` was handed —
 * `api()`'s own return type doesn't thread a generic through `opts.fallback`
 * (see node.ts), so a fallback subtree is typically already the erased `Node`
 * by the time it reaches here; this type still recurses correctly in that
 * case, just inherits that upstream limitation rather than papering over it.
 *
 * `sources` is always OPTIONAL here, regardless of whether the input leaf's
 * meta actually carries `http.source()` directives — whether it does is a
 * runtime fact read out of the open `meta` bag (`sourceMapOf`, below), not
 * something knowable from `N`'s static shape, so the type can't narrow it to
 * "present" the way `handler`/`meta` are.
 */
export type NaiveRoute<N extends Node> = (N extends { readonly handler: infer H extends Handler }
  ? {
      readonly methods: {
        readonly POST: {
          readonly handler: H;
          readonly meta: RouteLeafMeta;
          readonly sources?: Sources;
        };
      };
    }
  : {}) &
  (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
    ? { readonly children: { readonly [K in keyof C]: NaiveRoute<C[K]> } }
    : {}) &
  (N extends {
    readonly fallback: {
      readonly name: infer Nm extends string;
      readonly subtree: infer S extends Node;
    };
  }
    ? { readonly fallback: { readonly name: Nm; readonly subtree: NaiveRoute<S> } }
    : {}) & { readonly meta: RouteMeta };

/**
 * Recursive worker behind `naiveTransform` — threads `authoredAncestors`, the
 * list of fallback names seen on the path from the tree root down to `node`
 * (in the AUTHORED tree, before any rewriter runs), so every leaf gets its
 * own `sources.authoredPathParams` stamped at construction time — the
 * earliest point in the pipeline, before `applyMoveTo` (or any user-supplied
 * transform, `dx.ts`'s `opts?.transforms`) can relocate anything. Not part of
 * `naiveTransform`'s public signature — `NaiveRoute<N>`'s shape is unaffected
 * (an extra field on the already-optional `sources` object), so the public
 * entry point below just calls this with `[]`.
 */
function naiveTransformNode<N extends Node>(
  node: N,
  authoredAncestors: readonly string[],
): NaiveRoute<N> {
  const methods = isLeaf(node)
    ? {
        POST: {
          handler: node.handler!,
          meta: node.meta,
          sources: buildSources(node.meta, authoredAncestors),
        },
      }
    : undefined;
  const children =
    node.children !== undefined
      ? Object.fromEntries(
          Object.entries(node.children).map(([key, child]) => [
            key,
            naiveTransformNode(child, authoredAncestors),
          ]),
        )
      : undefined;
  const fallback =
    node.fallback !== undefined
      ? {
          name: node.fallback.name,
          subtree: naiveTransformNode(node.fallback.subtree, [
            ...authoredAncestors,
            node.fallback.name,
          ]),
        }
      : undefined;
  return httpRoute({ methods, children, fallback, meta: node.meta }) as NaiveRoute<N>;
}

export function naiveTransform<N extends Node>(node: N): NaiveRoute<N> {
  return naiveTransformNode(node, []);
}

// ============================================================================
// Shared visitor — walks children/fallback so individual rewriters only need
// to express their own per-node transform.
// ============================================================================

/**
 * Pre-order tree visitor shared by the rewriters below that don't need extra
 * context (path accumulation, etc.) beyond the current node. `fn` transforms
 * a single node — its own `methods`/`meta` — and returns it; `mapRoute` is
 * responsible for the recursion into `children`/`fallback`, applying `fn` to
 * `route` FIRST, then recursing into the fields of the result. Pre-order
 * (rather than post-order) is the right choice here because none of
 * `applyMethods`/`applyResponse` read a node's children to decide how to
 * transform that node — each only inspects the node's own `methods`/`meta`
 * — so the two orders are behaviorally identical for them; pre-order is
 * picked because it lets `fn` return an entirely different node before its
 * children are visited, matching how each rewriter already reads (transform
 * self, then thread through children/fallback).
 *
 * Not generic over `HttpRoute<H>`'s handler-type parameter — like
 * `applyMoveTo`, a caller-supplied `fn: HttpRoute => HttpRoute` can't
 * preserve a specific `H` through the type system without re-deriving a
 * mapped type per call site (see `ApplyMethodsRoute`/`ApplyResponseRoute`
 * above), which is exactly why `applyMethods`/`applyResponse` keep their own
 * hand-written recursion instead of delegating to `mapRoute` — they need the
 * type-preserving variant. `mapRoute` is the erased-type building block for
 * rewriters that don't need that precision, and for any user-authored
 * rewriter reaching for it via the package export.
 */
export function mapRoute(route: HttpRoute, fn: (node: HttpRoute) => HttpRoute): HttpRoute {
  const mapped = fn(route);
  const children =
    mapped.children !== undefined
      ? Object.fromEntries(Object.entries(mapped.children).map(([k, c]) => [k, mapRoute(c, fn)]))
      : undefined;
  const fallback =
    mapped.fallback !== undefined
      ? { name: mapped.fallback.name, subtree: mapRoute(mapped.fallback.subtree, fn) }
      : undefined;
  return httpRoute({ methods: mapped.methods, children, fallback, meta: mapped.meta });
}

// ============================================================================
// 2a. applyMethods — reads the flat `meta.http.method` scalar key off a
// method entry's own meta and renames the method key accordingly (POST, the
// naiveTransform default, becomes GET/PUT/DELETE/…).
// ============================================================================

/**
 * The `HttpRoute` shape after `applyMethods` rewrites a tree of type `R`.
 * The rename target (`meta.http.method`) comes out of the open `meta` bag as
 * a plain runtime `string` — never a literal type (see `HttpLeafMetaProperties`
 * in project.ts and `SharedMeta`/`LeafMeta` in node.ts) — so the resulting method KEY can't be
 * tracked statically; only the entry's VALUE (its handler type) survives.
 * `methods` is therefore widened to `Record<string, ...>` over the union of
 * the input methods' entry types — for the common case of a single method
 * entry (e.g. straight out of `naiveTransform`) that union has exactly one
 * member, so the handler type comes through with full precision even though
 * the key is no longer tracked.
 */
export type ApplyMethodsRoute<R extends HttpRoute> = (R extends {
  readonly methods: infer M extends Readonly<
    Record<string, { readonly handler: Handler; readonly meta: RouteLeafMeta }>
  >;
}
  ? { readonly methods: Readonly<Record<string, M[keyof M]>> }
  : {}) &
  (R extends { readonly children: infer C extends Readonly<Record<string, HttpRoute>> }
    ? { readonly children: { readonly [K in keyof C]: ApplyMethodsRoute<C[K]> } }
    : {}) &
  (R extends {
    readonly fallback: {
      readonly name: infer Nm extends string;
      readonly subtree: infer S extends HttpRoute;
    };
  }
    ? { readonly fallback: { readonly name: Nm; readonly subtree: ApplyMethodsRoute<S> } }
    : {}) & { readonly meta: RouteMeta };

export function applyMethods<R extends HttpRoute>(route: R): ApplyMethodsRoute<R> {
  return mapRoute(route, (node) => {
    let methods = node.methods;
    if (methods !== undefined) {
      const rebuilt: Record<string, { handler: Handler; meta: RouteLeafMeta; sources?: Sources }> =
        {};
      let changed = false;
      for (const [key, entry] of Object.entries(methods)) {
        const method = entry.meta.http?.method;
        const newKey = method !== undefined ? method.toUpperCase() : key;
        if (newKey !== key) changed = true;
        // `meta.http.method` stays on the entry's meta after the rename —
        // the flat design's "resolved shape = authored shape" (project.ts's
        // module doc) treats it as informational, not a directive to
        // consume. A bare `op()` leaf's route-position `meta` and its sole
        // method entry's `meta` stay the same object reference through this
        // rewriter; `compile.ts`'s `collectRoutes` dedupes by function
        // value, not by meta object identity, so this doesn't affect its
        // correctness (see that function's own doc comment).
        rebuilt[newKey] = entry;
      }
      methods = changed ? rebuilt : methods;
    }
    return httpRoute({
      methods,
      children: node.children,
      fallback: node.fallback,
      meta: node.meta,
    });
  }) as ApplyMethodsRoute<R>;
}

// ============================================================================
// 2b. applyMoveTo — reads the flat `meta.http.moveTo` scalar key and moves
// whole route subtrees within the tree, per the relative-path algebra in
// docs/design/routing-and-transforms.md:
//
//   "." (exactly)  — identity, node stays at its current position.
//   Any other path is resolved relative to the node's OWN position
//   (standard filesystem-style semantics):
//     ".."         — go up to parent
//     "../newname" — rename (sibling with a different name)
//     "*"          — push a wildcard (fallback) segment below self
//     "."          (as a path component) — no-op, stays at self
//     any other token — push that literal segment below self
//
// Two-phase: (1) walk the tree, detaching every subtree that carries a
// `moveTo` directive on its own top-level meta and recording its resolved
// absolute target path; (2) re-insert each detached subtree at its target,
// creating intermediate branch/fallback nodes as needed and merging methods
// when multiple subtrees converge on the same target (the REST-resource
// motivating example: get/update/delete all move to the same `*` position).
//
// [convention] When moveTo creates a new wildcard segment (no existing
// `fallback` at that position), the fallback parameter name defaults to
// `"param"`. An already-present `fallback.name` at the target position is
// preferred over that default when one exists.
// ============================================================================

type PendingMove = { readonly targetPath: readonly string[]; readonly subtree: HttpRoute };

function resolveMoveTo(itemPath: readonly string[], path: string): string[] {
  if (path === ".") return [...itemPath];
  const out = [...itemPath];
  for (const tok of path.split("/").filter((t) => t.length > 0)) {
    if (tok === ".") continue;
    else if (tok === "..") out.pop();
    else out.push(tok);
  }
  return out;
}

function detach(route: HttpRoute, path: readonly string[], moves: PendingMove[]): HttpRoute {
  let children = route.children;
  if (children !== undefined) {
    const rebuilt: Record<string, HttpRoute> = {};
    for (const [key, child] of Object.entries(children)) {
      const childPath = [...path, key];
      const moveTo = child.meta.http?.moveTo;
      if (moveTo !== undefined) {
        const target = resolveMoveTo(childPath, moveTo);
        // No stripping: `meta.http.moveTo` stays on the moved subtree's own
        // meta after the move — informational, not a directive to consume
        // (see project.ts's module doc / applyMethods's own doc comment for
        // the same "resolved shape = authored shape" reasoning).
        moves.push({ targetPath: target, subtree: detach(child, childPath, moves) });
        continue;
      }
      rebuilt[key] = detach(child, childPath, moves);
    }
    children = rebuilt;
  }

  let fallback = route.fallback;
  if (fallback !== undefined) {
    const childPath = [...path, "*"];
    const moveTo = fallback.subtree.meta.http?.moveTo;
    if (moveTo !== undefined) {
      const target = resolveMoveTo(childPath, moveTo);
      moves.push({ targetPath: target, subtree: detach(fallback.subtree, childPath, moves) });
      fallback = undefined;
    } else {
      fallback = { name: fallback.name, subtree: detach(fallback.subtree, childPath, moves) };
    }
  }

  return httpRoute({ methods: route.methods, children, fallback, meta: route.meta });
}

/**
 * Merge an incoming subtree into the route already occupying a target
 * position — this is what makes converging placements (the REST-resource
 * motivating example: get/update/delete all landing on the same `*`
 * position) group naturally. Throws when `incoming` and `target` both define
 * the same HTTP method: two operations placed at the same path+method is a
 * genuine authoring conflict (which handler would serve the request?), not
 * something a merge can silently resolve.
 */
function mergeRoutes(target: HttpRoute, incoming: HttpRoute, path: readonly string[]): HttpRoute {
  const targetMethods = target.methods ?? {};
  const incomingMethods = incoming.methods ?? {};
  for (const method of Object.keys(incomingMethods)) {
    if (method in targetMethods) {
      const displayPath = path.length === 0 ? "/" : `/${path.join("/")}`;
      throw new Error(
        `applyMoveTo: conflicting route — ${method} ${displayPath} is defined by more than one node`,
      );
    }
  }
  return httpRoute({
    methods: { ...targetMethods, ...incomingMethods },
    children: { ...target.children, ...incoming.children },
    fallback: incoming.fallback ?? target.fallback,
    meta: target.meta,
  });
}

/**
 * Insert `subtree` at `targetPath` within `root`, creating intermediate
 * branch/fallback nodes along the way when they don't already exist
 * (mkdir-p: `targetPath` may name several segments deep — e.g. resolved from
 * a `moveTo: "../api/v2/users"` directive — and every intermediate segment that
 * isn't already present in the tree is created as a plain, empty `HttpRoute`
 * node so the walk can continue).
 */
function insertAt(
  root: HttpRoute,
  targetPath: readonly string[],
  subtree: HttpRoute,
  fullPath: readonly string[],
): HttpRoute {
  if (targetPath.length === 0) return mergeRoutes(root, subtree, fullPath);
  const [head, ...rest] = targetPath as [string, ...string[]];

  if (head === "*") {
    const name = root.fallback?.name ?? "param";
    const base = root.fallback?.subtree ?? httpRoute({ meta: {} });
    return httpRoute({
      methods: root.methods,
      children: root.children,
      fallback: { name, subtree: insertAt(base, rest, subtree, fullPath) },
      meta: root.meta,
    });
  }

  // mkdir-p: create the intermediate node when it doesn't already exist.
  const base = root.children?.[head] ?? httpRoute({ meta: {} });
  return httpRoute({
    methods: root.methods,
    children: { ...root.children, [head]: insertAt(base, rest, subtree, fullPath) },
    fallback: root.fallback,
    meta: root.meta,
  });
}

/**
 * Applies every `moveTo` directive detached from the tree by `detach`.
 * Reinserted sequentially via `insertAt`, so conflicts between two different
 * placed subtrees converging on the same path+method are caught exactly like
 * a conflict between a placed subtree and a node already sitting at the
 * target — both funnel through `mergeRoutes`'s check.
 *
 * Unlike `naiveTransform`/`applyMethods`/`applyResponse`, this is not generic
 * over the input's handler type(s): `meta.http.moveTo` is a plain runtime
 * `string` read out of the open `meta` bag, so TypeScript has no way to know,
 * for a given input tree type, where a subtree ends up without parsing that
 * string as a type-level template literal and re-deriving the whole tree
 * shape from it. That would need `HttpLeafMetaProperties`/`LeafMeta` to carry
 * a typed, literal directive language instead of today's open
 * `{ [key: string]: unknown }` bag — a separate, larger design question, not
 * a fix scoped to this rewriter. `applyMoveTo` returns the erased
 * `HttpRoute` because moved subtrees' positions are genuinely unknowable
 * statically.
 */
export function applyMoveTo(route: HttpRoute): HttpRoute {
  const moves: PendingMove[] = [];
  const stripped = detach(route, [], moves);
  return moves.reduce((acc, m) => insertAt(acc, m.targetPath, m.subtree, m.targetPath), stripped);
}

// ============================================================================
// 2c. applyResponse — reads the flat `meta.http.response` scalar key and
// wraps the handler (function composition, NOT metadata on the route) so it
// produces a value carrying the response override. The override is
// materialized into the handler's return value via a branded wrapper that
// `makeRouterFromRoute` (and any other HttpRoute consumer) recognizes;
// everything else about the handler is untouched.
// ============================================================================

const RESPONSE_OVERRIDE = Symbol("httpResponseOverride");

export type ResponseOverride = {
  readonly [RESPONSE_OVERRIDE]: true;
  readonly body: unknown;
  readonly init: ResponseInit;
};

export function isResponseOverride(v: unknown): v is ResponseOverride {
  return typeof v === "object" && v !== null && RESPONSE_OVERRIDE in v;
}

function wrapResponse(
  handler: Handler,
  status: number | undefined,
  headers: Record<string, string> | undefined,
): Handler {
  return async (input: unknown) => {
    const body: unknown = await handler(input);
    const init: ResponseInit = {};
    if (status !== undefined) init.status = status;
    if (headers !== undefined) init.headers = headers;
    const override: ResponseOverride = { [RESPONSE_OVERRIDE]: true, body, init };
    return override;
  };
}

/**
 * The `HttpRoute` shape after `applyResponse` rewrites a tree of type `R`.
 * Whether a given method entry's handler gets wrapped depends on whether a
 * `response` directive is present in its `meta` — a runtime fact, unknowable
 * statically (see `ApplyMethodsRoute` above and `applyMoveTo`'s doc comment)
 * — so each entry's resulting handler type is honestly a union of
 * "unwrapped, original type" and "wrapped, `ResponseOverride`-producing
 * type" rather than one or the other. Unlike `applyMethods`, this rewriter
 * never renames a method key, so — different from `ApplyMethodsRoute` —
 * `methods` keeps the exact key set of `M` instead of widening to
 * `Record<string, ...>`.
 */
type ResponseWrappedHandler = (input: unknown) => Promise<ResponseOverride>;

export type ApplyResponseRoute<R extends HttpRoute> = (R extends {
  readonly methods: infer M extends Readonly<
    Record<string, { readonly handler: Handler; readonly meta: RouteLeafMeta }>
  >;
}
  ? {
      readonly methods: {
        readonly [K in keyof M]: {
          readonly handler: M[K]["handler"] | ResponseWrappedHandler;
          readonly meta: RouteLeafMeta;
        };
      };
    }
  : {}) &
  (R extends { readonly children: infer C extends Readonly<Record<string, HttpRoute>> }
    ? { readonly children: { readonly [K in keyof C]: ApplyResponseRoute<C[K]> } }
    : {}) &
  (R extends {
    readonly fallback: {
      readonly name: infer Nm extends string;
      readonly subtree: infer S extends HttpRoute;
    };
  }
    ? { readonly fallback: { readonly name: Nm; readonly subtree: ApplyResponseRoute<S> } }
    : {}) & { readonly meta: RouteMeta };

export function applyResponse<R extends HttpRoute>(route: R): ApplyResponseRoute<R> {
  return mapRoute(route, (node) => {
    let methods = node.methods;
    if (methods !== undefined) {
      const rebuilt: Record<string, { handler: Handler; meta: RouteLeafMeta; sources?: Sources }> =
        {};
      let changed = false;
      for (const [key, entry] of Object.entries(methods)) {
        const response = entry.meta.http?.response;
        if (response === undefined) {
          rebuilt[key] = entry;
          continue;
        }
        changed = true;
        rebuilt[key] = {
          handler: wrapResponse(entry.handler, response.status, response.headers),
          // No stripping: `meta.http.response` stays on the entry's meta
          // after wrapping — informational, not a directive to consume (see
          // `applyMethods`'s own doc comment for the same reasoning).
          meta: entry.meta,
          ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
        };
      }
      methods = changed ? rebuilt : methods;
    }
    return httpRoute({
      methods,
      children: node.children,
      fallback: node.fallback,
      meta: node.meta,
    });
  }) as ApplyResponseRoute<R>;
}

// ============================================================================
// 3. composeTransforms — chain rewriters into a single Tree => Tree
// ============================================================================

export function composeTransforms(
  ...transforms: Array<(r: HttpRoute) => HttpRoute>
): (r: HttpRoute) => HttpRoute {
  return (r) => transforms.reduce((acc, t) => t(acc), r);
}

// ============================================================================
// 4. makeRouterFromRoute — simple exact-path/method dispatcher over an
// HttpRoute tree. No attribute dispatch, no match conditions, no legacyPath
// — those remain the direct tree-walk (`Node`) dispatcher's domain. This is
// the dispatcher for the new, simpler HttpRoute model: path comes purely
// from tree structure (children keys + fallback), method from the `methods`
// key.
// ============================================================================

type RouteCandidate = {
  readonly method: string;
  readonly handler: Handler;
  readonly meta: RouteLeafMeta;
  readonly slugs: Readonly<Record<string, string>>;
};

/**
 * Split a URL pathname into non-empty segments without the split+filter
 * double allocation (`"/".split()` then `.filter(s => s.length > 0)` builds
 * two arrays; this builds one).
 */
export function splitPath(pathname: string): string[] {
  const segs: string[] = [];
  let start = 0;
  for (let i = 0; i <= pathname.length; i++) {
    if (i === pathname.length || pathname.charCodeAt(i) === 47 /* "/" */) {
      if (i > start) segs.push(pathname.slice(start, i));
      start = i + 1;
    }
  }
  return segs;
}

/**
 * `segs`/`idx`/`slugs` walk a single path through the tree — static children
 * always win over `fallback` (see module doc), so there is never more than
 * one branch in flight at a time. That makes `slugs` safe to mutate in place
 * across the whole descent instead of spreading a fresh object per dynamic
 * segment: no sibling call ever observes a stale or partially-built copy,
 * because there is no sibling call.
 */
function collectRouteCandidates(
  route: HttpRoute,
  segs: readonly string[],
  idx: number,
  slugs: Record<string, string>,
): RouteCandidate[] {
  if (idx === segs.length) {
    return Object.entries(route.methods ?? {}).map(([method, entry]) => ({
      method,
      handler: entry.handler,
      meta: entry.meta,
      slugs,
    }));
  }
  const seg = segs[idx]!;
  const child = route.children?.[seg];
  if (child !== undefined) {
    return collectRouteCandidates(child, segs, idx + 1, slugs);
  }
  if (route.fallback !== undefined) {
    slugs[route.fallback.name] = seg;
    return collectRouteCandidates(route.fallback.subtree, segs, idx + 1, slugs);
  }
  return [];
}

/** All candidate methods reachable at the exact path of `url`. */
export function routeCandidatesForUrl(root: HttpRoute, url: string): RouteCandidate[] {
  const segs = splitPath(new URL(url).pathname);
  return collectRouteCandidates(root, segs, 0, {});
}

/**
 * Single-method match for the exact path of `segs`, looked up directly from
 * the leaf's `methods` map instead of building the full candidate array and
 * filtering by method afterward — the hot path `makeRouterFromRoute` runs on
 * every request. Same single-path-descent argument as
 * `collectRouteCandidates` justifies mutating `slugs` in place.
 */
function matchRoute(
  route: HttpRoute,
  segs: readonly string[],
  idx: number,
  method: string,
  slugs: Record<string, string>,
):
  | {
      entry: { handler: Handler; meta: RouteLeafMeta; sources?: Sources };
      slugs: Record<string, string>;
    }
  | undefined {
  if (idx === segs.length) {
    const entry = route.methods?.[method];
    if (entry === undefined) return undefined;
    return { entry, slugs };
  }
  const seg = segs[idx]!;
  const child = route.children?.[seg];
  if (child !== undefined) {
    return matchRoute(child, segs, idx + 1, method, slugs);
  }
  if (route.fallback !== undefined) {
    slugs[route.fallback.name] = seg;
    return matchRoute(route.fallback.subtree, segs, idx + 1, method, slugs);
  }
  return undefined;
}

/**
 * True when `v` is an async iterable — a handler that returns one is
 * streamed (see `streamAsSse` below) instead of buffered through
 * `defaultEncode`. Structural (`Symbol.asyncIterator` presence), matching
 * how `isResultShape`/`isResponseOverride` recognize their shapes: a runtime
 * check on the returned value, not a static handler-type annotation.
 */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

const encoder = new TextEncoder();

/** Format one SSE frame: `event: <name>\ndata: <json>\n\n` (event line
 *  omitted for the unnamed/default event, matching the SSE spec). */
function sseFrame(data: unknown, event?: string): Uint8Array {
  const lines: string[] = [];
  if (event !== undefined) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push("", "");
  return encoder.encode(lines.join("\n"));
}

/**
 * Encode an async iterable handler result as a Server-Sent Events response.
 * Each yielded value is inspected: `StreamProgress`/`StreamChunk` (see
 * `@rhi-zone/fractal-api-tree`) become `event: progress`/plain `data:`
 * frames respectively (a chunk's own `data` field is unwrapped so the SSE
 * payload is the inner value, not the `{ kind: "chunk", data }` wrapper);
 * any other yielded value falls back to a plain `data:` frame, untagged.
 * The generator's return value (its completion payload, distinct from what
 * it yields) is sent as a final `event: done` frame before the stream
 * closes — this is why the loop below uses a manual `.next()` call instead
 * of `for await`, which discards a generator's return value.
 */
function streamAsSse(iterable: AsyncIterable<unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) {
            controller.enqueue(sseFrame(step.value, "done"));
            break;
          }
          const value: unknown = step.value;
          if (isStreamProgress(value)) {
            const { kind: _kind, ...progress } = value;
            controller.enqueue(sseFrame(progress, "progress"));
          } else if (isStreamChunk(value)) {
            controller.enqueue(sseFrame(value.data));
          } else {
            controller.enqueue(sseFrame(value));
          }
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonRouteResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

/**
 * Encode a `ResponseOverride` into a `Response` — the counterpart to
 * `jsonRouteResponse` for the override path. The body's shape decides how it's
 * encoded, so binary responses, streams, and handler-serialized bodies each
 * get their own correct treatment instead of a blanket `JSON.stringify`:
 *
 *   - `body instanceof Response` — the handler built the whole response
 *     itself (its own headers/status/body); return it directly, `init` is
 *     ignored (there is nothing left to merge it into).
 *   - `ReadableStream` / `ArrayBuffer` / `Uint8Array` / `Blob` / `null` /
 *     `undefined` — already a valid `BodyInit` (or an intentionally empty
 *     body); passed straight to `new Response()` with `init` untouched, so
 *     whatever Content-Type the handler set on `init.headers` survives
 *     unmangled.
 *   - `string` — ambiguous: could be a plain-text/HTML body the handler
 *     already serialized, or a `Node` handler's raw JSON-shaped output that
 *     happens to be typed as `string`. Disambiguated via `init.headers`: an
 *     explicit non-JSON Content-Type means the handler already serialized
 *     the body itself, so it passes through as-is; otherwise it's JSON-encoded,
 *     same as any other body value.
 *   - anything else (objects, numbers, arrays, …) — JSON-encoded via
 *     `jsonRouteResponse`.
 */
function encodeOverride(override: ResponseOverride): Response {
  const { body, init } = override;

  if (body instanceof Response) return body;

  if (
    body instanceof ReadableStream ||
    body instanceof ArrayBuffer ||
    body instanceof Uint8Array ||
    body instanceof Blob ||
    body === null ||
    body === undefined
  ) {
    return new Response(body as BodyInit | null | undefined, init);
  }

  if (typeof body === "string") {
    const headers = new Headers(init?.headers);
    const contentType = headers.get("Content-Type");
    const isExplicitlyNonJson = contentType !== null && !contentType.includes("application/json");
    if (isExplicitlyNonJson) return new Response(body, { ...init, headers });
  }

  return jsonRouteResponse(body, init);
}

/**
 * Stores-based decode: exposes the request as named stores (path, query,
 * header, body), then assembles the handler's input bag using conventions
 * (method → primary store) + optional per-param overrides declared via
 * `sources` on the matched method entry.
 *
 * When `sources.paramNames` is provided, the assembler reads exactly those
 * params from the appropriate stores. When absent (no codegen-derived param
 * list wired in for this route), `paramNames` is computed the same way
 * cli-api-projector's `buildInput` and mcp-api-projector's `assembleInput`
 * do: the union of every key any store could actually produce (path slugs,
 * query keys, body keys) plus any name declared purely via `sourceMap` —
 * then run through the same `assemble` call as the declarative path. No
 * separate bulk-merge codepath.
 *
 * The body is parsed once here, via `parseRequestBody` (decode.ts) — which
 * one is JSON, multipart, url-encoded, text, or binary based on
 * Content-Type. Methods that conventionally carry no body (GET/HEAD/DELETE)
 * skip body parsing entirely.
 *
 * Returns the `stores` alongside the assembled `input` bag — `stores` is
 * threaded into `HttpHandlerMiddleware` (see below), which sees both the
 * assembled input AND the raw pre-assembly stores; the handler itself only
 * ever sees `input`.
 *
 * `serviceStores` (default `{}`, sound per `httpStores`' own doc) is threaded
 * straight through to `httpStores` — this function does no merging of its
 * own, it only decides WHEN to parse a body.
 */
async function defaultDecode(
  req: Request,
  slugs: Readonly<Record<string, string>>,
  sources?: Sources,
  serviceStores: ServiceStores = {} as ServiceStores,
): Promise<{ readonly input: unknown; readonly stores: HttpStoreBag }> {
  const url = new URL(req.url);
  const primary = primaryStoreForMethod(req.method);

  // Parse body for methods that conventionally carry one — Content-Type
  // drives which WHATWG parser handles it (see `parseRequestBody`).
  let parsedBody: unknown = undefined;
  if (primary === "body") {
    parsedBody = await parseRequestBody(req);
  }

  const stores = httpStores(req, slugs, parsedBody, serviceStores);
  // `moveTo` is purely an address transform — it must not affect input
  // binding. `slugs` here are the final, post-moveTo matched-tree's
  // ancestor-fallback captures; treating every one of them as implicitly
  // path-bound would let a leaf relocated under a same-named (or
  // coincidentally-named) wildcard pick up a slug value it never authored
  // under. `authoredPathParams` (see `Sources`, above) is the leaf's own
  // pre-moveTo ancestor fallback-name chain — intersecting against it
  // restricts implicit path-binding to slugs the leaf actually authored
  // itself under.
  //
  // For the dominant naiveTransform-derived case, an unmoved leaf's final
  // ancestor slugs and its authored slugs are identical, so this filter is a
  // no-op — moveTo is the only thing that can make the two sets diverge.
  // `authored === undefined` (a hand-built `HttpRoute` that bypassed
  // `naiveTransform`) falls back to the pre-existing bulk-slug behavior,
  // since there's no authored-position history to consult.
  const liveSlugNames = Object.keys(slugs);
  const authored = sources?.authoredPathParams;
  const pathParamNames =
    authored !== undefined ? liveSlugNames.filter((n) => authored.includes(n)) : liveSlugNames;
  const sourceMap = sources?.sourceMap ?? {};

  const paramNames =
    sources?.paramNames !== undefined && sources.paramNames.length > 0
      ? sources.paramNames
      : [
          ...new Set([
            ...pathParamNames,
            ...url.searchParams.keys(),
            ...(typeof parsedBody === "object" && parsedBody !== null
              ? Object.keys(parsedBody as Record<string, unknown>)
              : []),
            ...Object.keys(sourceMap),
          ]),
        ];

  let bag = assemble(stores, paramNames, sourceMap, primary, pathParamNames);

  // Optional transform after assembly
  if (sources?.transform !== undefined) {
    bag = sources.transform(bag);
  }

  return { input: bag, stores };
}

/**
 * Build the `Link: <url>; rel="next"` header for a page-shaped response
 * (`CursorPage<T>`/`OffsetPage<T>`, see `@rhi-zone/fractal-api-tree/page`) —
 * the server-side counterpart to `extensions/pagination.ts`'s client-side
 * `nextRequestFor`: same URL algebra (clone the request URL, overwrite just
 * the cursor/offset query param, preserve every other one — `limit`,
 * filters, etc.), just emitted as a response header instead of consumed to
 * build the next `Request`. RFC 8288 (`Link` header, §3) is the honest wire
 * signal for "there is a next page and here's its URL" — a client that
 * doesn't use this package's own `pagination()` extension (a bare `fetch`
 * caller, curl, a different SDK) can still discover it.
 *
 * Only meaningful for GET/HEAD/DELETE-style (query-param) requests — the
 * conventional shape for a read/list endpoint (`http.get`, verbs.ts) and the
 * only shape whose input the client encodes into the URL rather than a JSON
 * body, so a next-page URL can be derived without knowing the body schema.
 * Any other method (or `hasMore: false`) contributes no `Link` header —
 * silently, not an error: the pagination data itself is still in the JSON
 * body regardless, this header is a convenience on top, not the only way to
 * discover the next page.
 */
function pageLinkHeader(
  req: Request,
  output: Page<unknown>,
  meta: RouteLeafMeta,
): string | undefined {
  if (!output.hasMore) return undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") return undefined;

  const directive = paginatedDirectiveOf(meta);
  const cursorParam = directive?.inputCursorParam ?? "cursor";
  const offsetParam = directive?.inputOffsetParam ?? "offset";

  const url = new URL(req.url);
  if (isOffsetPage(output)) {
    url.searchParams.set(offsetParam, String(output.offset + output.items.length));
  } else if (isCursorPage(output) && output.cursor !== undefined) {
    url.searchParams.set(cursorParam, output.cursor);
  } else {
    return undefined;
  }
  return `<${url.toString()}>; rel="next"`;
}

/** Default `encode`: a 200 JSON response, with a `Link: ...; rel="next"` header attached when `output` is page-shaped and has a next page (see `pageLinkHeader`). */
function defaultEncode(output: unknown, req?: Request, meta?: RouteLeafMeta): Response {
  if (req !== undefined && meta !== undefined && isPageShape(output)) {
    const link = pageLinkHeader(req, output, meta);
    if (link !== undefined)
      return jsonRouteResponse(output, { status: 200, headers: { Link: link } });
  }
  return jsonRouteResponse(output, { status: 200 });
}

/** Default error encode: a 400 JSON response wrapping the error value. */
function defaultEncodeError(error: unknown): Response {
  return jsonRouteResponse({ error }, { status: 400 });
}

// ============================================================================
// Structured error types — composable error-to-transport mapping
//
// A handler's `Result.err(E)` value is transport-agnostic (e.g.
// `{ kind: "notFound", message: "Book not found" }`). `errorEncoder` (see
// `PresetOptions.errorEncoder`/`runRoute`'s parameter below) maps `E` to an
// `HttpErrorResponse`; `undefined` means "not recognized," which falls back
// to `defaultEncodeError`'s 400. `thrownErrorEncoder` is the parallel hook
// for a THROWN error (a handler that throws instead of returning
// `Result.err`) — same `(error: unknown) => HttpErrorResponse | undefined`
// shape, called from `runRoute`'s catch block; `undefined` (including when
// `thrownErrorEncoder` itself is omitted) falls back to the existing 500
// "internal server error" response. See
// docs/design/middleware-and-caller-context.md.
// ============================================================================

/** An error encoder's HTTP-specific target shape — status + optional body/headers. */
export type HttpErrorResponse = {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
};

/** `ErrorEncoder<E, HttpErrorResponse>` — maps a handler's error value to an HTTP response. */
export type HttpErrorEncoder<E = unknown> = ErrorEncoder<E, HttpErrorResponse>;

/**
 * Same shape as `HttpErrorEncoder` — maps a THROWN error (caught in
 * `runRoute`'s catch block) to an `HttpErrorResponse`, instead of a
 * `Result.err(E)` value. A distinct alias (not just reuse-in-place) because
 * the two hooks answer different questions even though the signature is
 * identical: `errorEncoder` sees an expected, handler-signaled `E`;
 * `thrownErrorEncoder` sees whatever `catch` caught, which may not even be an
 * `Error` instance. `undefined` (including when `thrownErrorEncoder` itself
 * is omitted) falls back to the existing 500 "internal server error".
 */
export type ThrownErrorEncoder = HttpErrorEncoder;

/**
 * Pre-built `HttpErrorEncoder`: maps error `kind` values to HTTP status
 * codes, e.g. `httpErrors({ notFound: 404, conflict: 409, forbidden: 403 })`.
 * Internally a `composeErrorEncoders` over one `matchKind` per mapping entry
 * — first match wins (object key order). The response body is the raw error
 * value itself, not wrapped in `defaultEncodeError`'s `{ error }` shape —
 * the status is already known here, so there's nothing left for that
 * wrapper to signal.
 */
export function httpErrors<E = unknown>(mapping: Record<string, number>): HttpErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, status]) =>
    matchKind<HttpErrorResponse>(kind, { status }),
  );
  const composed = composeErrorEncoders(...encoders);
  return (error) => {
    const matched = composed(error);
    if (matched === undefined) return undefined;
    return { status: matched.status, body: error };
  };
}

/** Encode an `HttpErrorResponse` into a `Response`. */
function encodeHttpError(response: HttpErrorResponse): Response {
  const init: ResponseInit = { status: response.status };
  if (response.headers !== undefined) init.headers = response.headers;
  return jsonRouteResponse(response.body, init);
}

/**
 * Encode a THROWN error (from anywhere in the pre-decode or handler-around
 * path — a `handlerMiddleware`, a `middleware`, or any other unexpected
 * failure) via `thrownErrorEncoder`, falling back to the existing default
 * (500, `{ error: "internal server error" }`) when the encoder is absent or
 * itself returns `undefined` — the exact fallback `runRoute`'s own catch
 * block (below) has always used. Exported so every OTHER place a thrown
 * error needs the identical encode-or-fall-back behavior — `toRouter`
 * (compile.ts, wrapping a subtree's `http.middleware()` throw) and
 * `createFetch` (preset.ts, wrapping a global `PresetOptions.middleware`
 * throw) — calls this one function instead of re-deriving the same two-line
 * fallback three times. No route context (meta/path) is available to any of
 * these callers when a PRE-decode middleware throws before a route is even
 * matched (the global `PresetOptions.middleware` case) — `ThrownErrorEncoder`
 * only ever took the raw error, never route context, so there is nothing to
 * fabricate here; every caller passes exactly what it has.
 */
export function encodeThrownError(
  error: unknown,
  thrownErrorEncoder?: ThrownErrorEncoder,
): Response {
  const encoded = thrownErrorEncoder?.(error);
  return encoded !== undefined
    ? encodeHttpError(encoded)
    : jsonRouteResponse({ error: "internal server error" }, { status: 500 });
}

// ============================================================================
// Handler-level middleware — around-hooks wrapping the handler call itself,
// distinct from the protocol-level `Fetch => Fetch` middleware in layers.ts/
// preset.ts (`PresetOptions.middleware`). Mirrors CliMiddleware
// (cli-api-projector/src/cli.ts) and McpMiddleware
// (mcp-api-projector/src/server.ts): all three projectors share the same
// shape — `F => F` where `F = (input, stores) => result` (see
// docs/design/middleware-and-caller-context.md). Sits INSIDE `runRoute` —
// after decode, before encode — so it sees (and can transform) the assembled
// input bag and the raw pre-assembly stores (`httpStores()`, decode.ts), with
// the handler's raw return value returned back out. The handler itself is
// `(input) => result` — it never receives `stores`; that's structural (see
// the `(input, _stores) => handler(input)` base in `runRoute`), not a
// convention to remember.
// ============================================================================

/**
 * An HTTP handler middleware wraps the handler-invoking function `next`
 * (itself `F => F`, see module doc above). Middleware compose like an onion:
 * the first entry in `handlerMiddleware` (runRoute's parameter, threaded from
 * `PresetOptions.handlerMiddleware`) is the OUTERMOST wrapper — same
 * convention as `CliMiddleware`/`McpMiddleware`.
 */
export type HttpHandlerMiddleware = (
  next: (input: Record<string, unknown>, stores: HttpStoreBag) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: HttpStoreBag) => unknown | Promise<unknown>;

/**
 * Compose `middleware` around `base`, first entry outermost. An empty array
 * returns `base` unchanged (identity — no wrapping overhead).
 */
function composeHandlerMiddleware(
  middleware: readonly HttpHandlerMiddleware[],
  base: (input: Record<string, unknown>, stores: HttpStoreBag) => unknown | Promise<unknown>,
): (input: Record<string, unknown>, stores: HttpStoreBag) => unknown | Promise<unknown> {
  let wrapped = base;
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped);
  }
  return wrapped;
}

/**
 * Runs a single matched `(handler, meta, sources, slugs)`: decode the
 * request, call the handler, encode the response. No interceptable
 * PROTOCOL-level stages — see the module doc above for why. Shared by
 * `makeRouterFromRoute` (below) and `toRouter` (compile.ts's compiled
 * matchers), so every dispatcher in this package encodes requests/responses
 * identically. `handlerMiddleware` (see `HttpHandlerMiddleware` above) is the
 * one interceptable HANDLER-level hook — applied around the handler call
 * itself, after decode and before encode/Result-unwrapping. `detection`
 * (see `DetectionOptions`, `@rhi-zone/fractal-api-tree`) gates the two
 * structural sniffs of the handler's return value — `result` for
 * `isResultShape`, `streaming` for the `isAsyncIterable` check below (and,
 * transitively, `streamAsSse`'s `StreamEffect` tag interpretation, since
 * disabling `streaming` skips entering `streamAsSse` at all). Both default
 * to `true` when `detection` is omitted. `ResponseOverride` detection is
 * never gated — see its own doc comment above for why. `errorEncoder` maps a
 * `Result.err(E)` value to an `HttpErrorResponse`; `thrownErrorEncoder` is
 * its parallel for whatever the catch block below actually caught (a thrown
 * error, not a `Result`) — both fall back to their own default (400 / 500
 * respectively) when the encoder is absent or returns `undefined`.
 * `serviceStores` (default `{}`) is the deployment's registered `ServiceStores`
 * value (`PresetOptions.serviceStores`, preset.ts) — threaded straight through
 * to `defaultDecode`/`httpStores` so the per-request `stores` bag a handler
 * middleware sees has every registered service store already merged in.
 */
export async function runRoute(
  req: Request,
  handler: Handler,
  meta: RouteLeafMeta,
  sources: Sources | undefined,
  slugs: Readonly<Record<string, string>>,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
  serviceStores: ServiceStores = {} as ServiceStores,
): Promise<Response> {
  const detectStreaming = detection?.streaming ?? true;
  const detectResult = detection?.result ?? true;
  let input: unknown;
  let stores: HttpStoreBag;
  try {
    const decoded = await defaultDecode(req, slugs, sources, serviceStores);
    input = decoded.input;
    stores = decoded.stores;
  } catch {
    return jsonRouteResponse({ error: "invalid request body" }, { status: 400 });
  }

  try {
    // Standard Schema validation (`http.validate()`, verbs.ts) — runs on the
    // freshly-assembled input, after decode/transform and before the
    // handler ever sees it. A rejection short-circuits with a 422 carrying
    // the validator's own `issues`; the handler never runs (mirrors how an
    // `applyValidation`-wrapped handler's `err(...)` Result short-circuits
    // below, but resolved here — before the handler is even called — since
    // a Standard Schema validator isn't wired onto the handler itself, only
    // declared on this route's `sources`). A genuine throw out of
    // `~standard.validate` (a broken validator, not an expected rejection)
    // falls through to this same try's catch block below, same as any other
    // unexpected handler-path failure.
    if (sources?.validate !== undefined) {
      const result = await runStandardSchema(sources.validate, input);
      if (!result.ok) {
        return jsonRouteResponse(
          { error: "validation failed", issues: result.issues },
          { status: 422 },
        );
      }
      input = result.value;
    }

    // Bridge the plain handler `(input) => result` into `F => F`'s base case
    // `(input, stores) => handler(input)` — the handler never sees `stores`,
    // structurally (see HttpHandlerMiddleware's module doc above).
    const base = (input: Record<string, unknown>, _stores: HttpStoreBag) =>
      (handler as (input: Record<string, unknown>) => unknown | Promise<unknown>)(input);
    const middleware = handlerMiddleware ?? [];
    const callHandler = middleware.length === 0 ? base : composeHandlerMiddleware(middleware, base);
    let output: unknown = await (callHandler(
      input as Record<string, unknown>,
      stores,
    ) as Promise<unknown>);

    // Streaming: an async-iterable result (e.g. an async generator handler)
    // is streamed as Server-Sent Events instead of buffered — checked before
    // Result-unwrapping since neither a Result nor a ResponseOverride is an
    // async iterable, so there's no ambiguity between the three shapes.
    if (detectStreaming && isAsyncIterable(output)) return streamAsSse(output);

    // Result unwrapping: if the handler returned a Result<T, E>, separate
    // the success and error paths before encoding — a 400, not the catch
    // block's 500, since an err Result is an expected outcome the handler
    // chose to signal, not an unexpected failure. This is also how an
    // `applyValidation`-wrapped handler (@rhi-zone/fractal-api-tree/apply-validation)
    // signals a validation rejection: it returns `err(validationErrors)`
    // rather than throwing, so it lands here as a discriminated-union check
    // on the return value, not a catch. The check is exact — typeof + kind —
    // to avoid false-positives on user data that happens to have a `kind`
    // field with an unrelated value.
    if (detectResult && isResultShape(output)) {
      if (output.kind === "err") {
        const encoded = errorEncoder?.(output.error);
        return encoded !== undefined ? encodeHttpError(encoded) : defaultEncodeError(output.error);
      }
      output = output.value;
    }

    return isResponseOverride(output) ? encodeOverride(output) : defaultEncode(output, req, meta);
  } catch (error) {
    return encodeThrownError(error, thrownErrorEncoder);
  }
}

// ============================================================================
// Wire-time source coverage — the RUNTIME half of the §6 check
// ============================================================================
//
// `op()` statically checks the one resolution-order step visible at its own
// call site (a `source()` override naming a param the handler doesn't declare —
// see `UncoveredSourceParams`, api-tree's input.ts). The other two steps are
// not visible there, for reasons docs/design/typed-store-spec.md §6 establishes
// as structural rather than as engineering gaps: a path-param match depends on
// where the leaf is MOUNTED (a property of the tree passed to `api()`, not of
// the leaf's own `op()` arguments), and the no-`paramNames` convention fallback
// resolves against the live request's own keys.
//
// Both of those DO exist by the time the route tree is built — which is where
// this check runs: once, at wire time, walking every leaf method. It reports
// EVERY problem it finds in one pass rather than failing on the first, so one
// boot surfaces the whole list.
//
// Leaves without `sources.paramNames` are skipped: without a codegen-derived
// param list there is no fixed set to check coverage against at all (§6's last
// bullet), independent of store typing.

/** One thing wrong with a leaf method's declared param sources. */
export type SourceCoverageProblem = {
  /** The route's mount path, with slug segments as `{name}` — e.g. `/books/{id}`. */
  readonly path: string;
  readonly method: string;
  readonly param: string;
  readonly kind: "unknown-store" | "unused-override" | "unfillable-path";
  /** Human-readable statement of what's wrong with this param. */
  readonly detail: string;
};

/** Thrown by `checkRouteSourceCoverage` when a route tree has any coverage problem. Carries every problem found, not just the first. */
export class SourceCoverageError extends Error {
  readonly problems: readonly SourceCoverageProblem[];
  constructor(problems: readonly SourceCoverageProblem[]) {
    super(
      `HTTP route source coverage: ${problems.length} problem(s)\n` +
        problems.map((p) => `  ${p.method} ${p.path} — param "${p.param}": ${p.detail}`).join("\n"),
    );
    this.name = "SourceCoverageError";
    this.problems = problems;
  }
}

/** Options for `findRouteSourceCoverageProblems`/`checkRouteSourceCoverage`. */
export type SourceCoverageOptions = {
  /**
   * Store names to accept beyond `BUILTIN_HTTP_STORE_NAMES` (decode.ts) — for a
   * deployment that declaration-merged extra members into `HttpStoreRegistry`
   * and builds them itself. No runtime value can enumerate an open interface's
   * merged members, so they are named here.
   */
  readonly knownStores?: Iterable<string>;
};

/**
 * Walk `root` and collect every leaf method whose declared param sources don't
 * hold up — the non-throwing form, for a caller that wants to report the
 * problems itself. `checkRouteSourceCoverage` is the throwing form.
 *
 * For each param in a leaf's `sources.paramNames`, resolves how it will
 * actually be bound at request time and checks that resolution holds up —
 * the runtime counterpart of the static check `op()` already runs (see the
 * module doc above), reaching the cases the static check can't (the handler's
 * own input type erased, or the binding depending on where the leaf is
 * MOUNTED — a property of the tree, not of the leaf's own `op()` call).
 *
 * moveTo is purely an address transform — it must NOT affect input binding
 * (see `defaultDecode`'s own doc comment). So each param is resolved by
 * mirroring `assemble`'s OWN resolution order exactly (path match → override →
 * primary-store convention), using the same EFFECTIVE (authored-restricted)
 * path-param set `defaultDecode` computes, then flagging whichever step it
 * actually lands on when that step doesn't hold up:
 *
 *   1. `param` resolves via "path" when it's a LIVE final `pathParams` name
 *      AND (this leaf came from `naiveTransform`, i.e.
 *      `sources.authoredPathParams` is defined) it's also in the leaf's
 *      AUTHORED set — or, when `authoredPathParams` is `undefined` (a
 *      hand-built `HttpRoute` that bypassed `naiveTransform` — see that
 *      field's own doc comment), simply being a live final `pathParams` name
 *      is enough, mirroring `defaultDecode`'s bulk-slug fallback for that
 *      case. Always fine when it applies — "path" is always a known store,
 *      and any `sourceMap` override for this param is genuinely dead code at
 *      that point, so it isn't checked.
 *   2. Otherwise, an explicit `sourceMap[param]` override, if present. When
 *      its store is `"path"`, its resolved key (`override.key ?? param`) must
 *      actually be present in this leaf's final `pathParams` — otherwise
 *      `"unfillable-path"`: the field is declared path-sourced but nothing at
 *      the leaf's projected position supplies it. Any other store must be one
 *      `known` builds, or `"unknown-store"`.
 *   3. Otherwise, if `param` is in the leaf's AUTHORED path-param set but
 *      didn't resolve via path in step 1 (only possible when
 *      `authoredPathParams` is defined but the live `pathParams` set doesn't
 *      contain `param`) — `"unfillable-path"`: the leaf authored this as a
 *      local slug, but moveTo relocated it away from a matching ancestor.
 *   4. Otherwise — not authored, not explicit-path-sourced (even if `param`
 *      happens to coincide with a live final `pathParams` name post-move) —
 *      falls through to the normal primary-store (query/body) convention,
 *      checked against `known` same as any other non-path field. A name
 *      collision with a live `pathParams` entry does not bind this field
 *      implicitly; it is an ordinary query/body field.
 *
 * Also flags a `sourceMap` entry for a param that is NOT in `paramNames`:
 * `assemble` only ever reads `paramNames`, so such an override is dead.
 */
export function findRouteSourceCoverageProblems(
  root: HttpRoute,
  opts?: SourceCoverageOptions,
): readonly SourceCoverageProblem[] {
  const known = new Set<string>([...BUILTIN_HTTP_STORE_NAMES, ...(opts?.knownStores ?? [])]);
  const problems: SourceCoverageProblem[] = [];

  const visit = (
    route: HttpRoute,
    segments: readonly string[],
    pathParams: readonly string[],
  ): void => {
    const path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
    for (const [method, entry] of Object.entries(route.methods ?? {})) {
      const sources = entry.sources;
      const paramNames = sources?.paramNames;
      const sourceMap = sources?.sourceMap ?? {};
      const authored = sources?.authoredPathParams;
      if (paramNames !== undefined) {
        const primary = primaryStoreForMethod(method);
        for (const param of paramNames) {
          const authoredWantsIt = authored !== undefined && authored.includes(param);
          const resolvesViaPath =
            authored !== undefined
              ? authoredWantsIt && pathParams.includes(param)
              : pathParams.includes(param);
          if (resolvesViaPath) continue;

          const override = sourceMap[param];
          if (override !== undefined) {
            if (override.store === "path") {
              const key = override.key ?? param;
              if (!pathParams.includes(key)) {
                problems.push({
                  path,
                  method,
                  param,
                  kind: "unfillable-path",
                  detail:
                    `declared as path-sourced (key "${key}") via an explicit source override,` +
                    ` but nothing at this leaf's projected position (${path}) supplies it`,
                });
              }
              continue;
            }
            if (!known.has(override.store)) {
              problems.push({
                path,
                method,
                param,
                kind: "unknown-store",
                detail:
                  `reads from store "${override.store}", which no projector builds` +
                  ` (known: ${[...known].sort().join(", ")})`,
              });
            }
            continue;
          }

          if (authoredWantsIt) {
            // Authored as a local slug, but `resolvesViaPath` was false —
            // only reachable here when the live `pathParams` at this leaf's
            // FINAL position doesn't contain `param`: moveTo relocated the
            // leaf away from a matching ancestor.
            problems.push({
              path,
              method,
              param,
              kind: "unfillable-path",
              detail:
                `authored as a local path slug, but moveTo relocated this leaf away from` +
                ` a matching ancestor — its projected position (${path}) has no "${param}" segment`,
            });
            continue;
          }

          // Not authored, not explicit-path-sourced — falls through to the
          // primary-store convention like any other non-path field, even if
          // it happens to coincide with a live final pathParams name.
          if (!known.has(primary)) {
            problems.push({
              path,
              method,
              param,
              kind: "unknown-store",
              detail:
                `reads from store "${primary}", which no projector builds` +
                ` (known: ${[...known].sort().join(", ")})`,
            });
          }
        }
        for (const param of Object.keys(sourceMap)) {
          if (!paramNames.includes(param)) {
            problems.push({
              path,
              method,
              param,
              kind: "unused-override",
              detail:
                `has a source override but is not one of this route's params` +
                ` (${paramNames.join(", ") || "none"}) — the override is never applied`,
            });
          }
        }
      }
    }
    for (const [name, child] of Object.entries(route.children ?? {})) {
      visit(child, [...segments, name], pathParams);
    }
    if (route.fallback !== undefined) {
      // A fallback segment IS a path param: `matchRoute` binds the raw segment
      // to `fallback.name` as a slug, so every leaf below here can source that
      // name from "path".
      visit(
        route.fallback.subtree,
        [...segments, `{${route.fallback.name}}`],
        [...pathParams, route.fallback.name],
      );
    }
  };

  visit(root, [], []);
  return problems;
}

/**
 * `findRouteSourceCoverageProblems`, but THROWS a `SourceCoverageError` listing
 * every problem when there is at least one. Run once at wire time — see
 * `makeRouterFromRoute`, which calls it while building the dispatcher.
 */
export function checkRouteSourceCoverage(root: HttpRoute, opts?: SourceCoverageOptions): void {
  const problems = findRouteSourceCoverageProblems(root, opts);
  if (problems.length > 0) throw new SourceCoverageError(problems);
}

/**
 * `serviceStores` (default `{}`) — the deployment's registered `ServiceStores`
 * value (`PresetOptions.serviceStores`, preset.ts) — is threaded straight
 * through to every `runRoute` call the returned dispatcher makes, exactly
 * like `toRouter` (compile.ts) does for the other router compilers.
 */
export function makeRouterFromRoute(
  root: HttpRoute,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
  serviceStores: ServiceStores = {} as ServiceStores,
): (req: Request) => Promise<Response> {
  // Once, at wire time — not per request. This is the point at which mount
  // position and the codegen'd `paramNames` list both exist, which is exactly
  // why §6 puts the check here instead of at `op()`.
  checkRouteSourceCoverage(root);

  return async (req) => {
    const segs = splitPath(new URL(req.url).pathname);
    const matched = matchRoute(root, segs, 0, req.method, {});
    if (matched === undefined) return new Response("Not Found", { status: 404 });

    return runRoute(
      req,
      matched.entry.handler,
      matched.entry.meta,
      matched.entry.sources,
      matched.slugs,
      handlerMiddleware,
      detection,
      errorEncoder,
      thrownErrorEncoder,
      serviceStores,
    );
  };
}
