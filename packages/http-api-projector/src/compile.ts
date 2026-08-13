// packages/http-api-projector/src/compile.ts — @rhi-zone/fractal-http-api-projector
//
// Composable, independent route compilers — each takes an `HttpRoute` and
// produces the same `(req: Request) => Promise<Response>` dispatch contract
// as `makeRouterFromRoute` (route.ts), but compiles the match step
// differently. Ported from the architectures benchmarked in
// `route.bench.ts` (architectures 5, 7, 8 — the ones that beat the baseline
// segment trie without regressing on any pathological case).
//
// The decomposition is two layers:
//   - `Matcher`  — `(pathname, method) => RouteMatch | undefined`, pure path
//     matching, no dispatch. `radixMatcher`, `compiledCharMatcher`,
//     `mapMatcher` each build one; `chainMatchers` composes several in order.
//   - `toRouter` — wraps a `Matcher` with the same dispatch (`runRoute`,
//     imported from route.ts) that `makeRouterFromRoute` runs, plus the 404
//     fallback.
//
// `radixRouter`/`compiledCharRouter`/`mapCharRouter` are `toRouter(matcher)`
// convenience wrappers for the three benchmarked shapes.

import type { AsyncLocalStorage } from "node:async_hooks";
import type { Handler } from "@rhi-zone/fractal-api-tree/node";
import type { DetectionOptions, ServiceStores } from "@rhi-zone/fractal-api-tree";
import { encodeThrownError, runRoute, splitPath } from "./route.ts";
import type {
  HttpErrorEncoder,
  HttpHandlerMiddleware,
  HttpRoute,
  RouteLeafMeta,
  Sources,
  ThrownErrorEncoder,
} from "./route.ts";
import { getHttpMeta } from "./project.ts";
// Type-only — `layers.ts` doesn't import this file, so this edge is plain
// and acyclic (unlike project.ts/verbs.ts's own type-only import of `Fetch`
// from layers.ts, which breaks a real value-import cycle — see their module
// docs).
import type { Fetch } from "./layers.ts";

// ============================================================================
// Shared types
// ============================================================================

export type RouteMatch = {
  readonly handler: Handler;
  readonly meta: RouteLeafMeta;
  readonly sources?: Sources;
  readonly slugs: Record<string, string>;
  /**
   * This route's fully ancestor-composed `middleware` chain (root-to-leaf,
   * root's entries outermost) — see `collectRoutes` below and
   * docs/design/subtree-layers-spec.md §5. Absent/empty when neither this
   * leaf nor any ancestor declared `http.middleware(...)`.
   */
  readonly middleware?: readonly ((inner: Fetch) => Fetch)[];
  /** This route's fully ancestor-composed `handlerMiddleware` chain — same composition as `middleware` above. */
  readonly handlerMiddleware?: readonly HttpHandlerMiddleware[];
};

export type Matcher = (pathname: string, method: string) => RouteMatch | undefined;

export type CompiledRouter = (req: Request) => Promise<Response>;

/**
 * Wraps a `Matcher` with request dispatch + 404 fallback — same contract as
 * `makeRouterFromRoute`. `serviceStores` (default `{}`, see `httpStores`'s own
 * doc in decode.ts for why the empty default is sound) is the deployment's
 * registered `ServiceStores` value, threaded straight through to `runRoute`.
 *
 * `handlerMiddleware` here is the global `PresetOptions.handlerMiddleware`
 * array, applying to every route regardless of subtree. A matched route's
 * own `match.handlerMiddleware` (the ancestor-composed subtree chain
 * `collectRoutes` builds, see its own doc below) is concatenated after it,
 * so the global array stays outermost — it applies first and wraps widest,
 * consistent with sitting on a virtual root above the whole tree — while
 * the subtree chain wraps progressively tighter beneath it, matching §5's
 * root-to-leaf ordering.
 *
 * `match.middleware` (dispatch-around, subtree-scoped only — there is no
 * global counterpart threaded through this compiler; `PresetOptions
 * .middleware` wraps the whole compiled router externally, in preset.ts's
 * `createFetch`, entirely orthogonal to per-route matching) is composed
 * around the per-route `runRoute` dispatch itself, via `reduceRight` with
 * the first entry outermost — the same composition `createFetch` uses for
 * the global array (preset.ts). It wraps after matching has already
 * happened (subtree scope, no per-request path-prefix check) but before
 * `runRoute`'s own decode/validate (dispatch-around, the same wire point
 * the global `middleware` option runs at).
 *
 * A throw out of `wrapped(req)` — necessarily from a `match.middleware`
 * entry itself, since `dispatch` (`runRoute`) already catches and encodes
 * everything on its own path — is caught here and run through
 * `encodeThrownError` (route.ts), the same fallback-to-500 path
 * `runRoute`'s catch block uses for a `handlerMiddleware` throw. Every
 * thrown error this package can observe, pre-decode or handler-around, ends
 * up as an encoded `Response` rather than an uncaught exception out of the
 * returned `CompiledRouter` — see `createFetch` (preset.ts) for the
 * identical treatment of the global `PresetOptions.middleware` array, which
 * wraps outside this function entirely.
 */
export function toRouter(
  matcher: Matcher,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
  serviceStores: ServiceStores = {} as ServiceStores,
): CompiledRouter {
  return async (req) => {
    const pathname = new URL(req.url).pathname;
    const match = matcher(pathname, req.method);
    if (match === undefined) return new Response("Not Found", { status: 404 });
    const combinedHandlerMiddleware = [
      ...(handlerMiddleware ?? []),
      ...(match.handlerMiddleware ?? []),
    ];
    const dispatch: Fetch = (r) =>
      runRoute(
        r,
        match.handler,
        match.meta,
        match.sources,
        match.slugs,
        combinedHandlerMiddleware,
        detection,
        errorEncoder,
        thrownErrorEncoder,
        serviceStores,
      );
    const wrapped = (match.middleware ?? []).reduceRight<Fetch>((inner, mw) => mw(inner), dispatch);
    try {
      return await wrapped(req);
    } catch (error) {
      return encodeThrownError(error, thrownErrorEncoder);
    }
  };
}

/** Try each matcher in order; the first non-`undefined` result wins. */
export function chainMatchers(...matchers: readonly Matcher[]): Matcher {
  return (pathname, method) => {
    for (const matcher of matchers) {
      const result = matcher(pathname, method);
      if (result !== undefined) return result;
    }
    return undefined;
  };
}

// ============================================================================
// HttpRoute => flat route list — shared by every compiler below. Walks the
// tree once, producing one entry per (path, method), with dynamic segments
// rendered as `:name` (route.ts's own tree-walk convention).
// ============================================================================

type CollectedRoute = {
  readonly path: string;
  readonly method: string;
  readonly handler: Handler;
  readonly meta: RouteLeafMeta;
  readonly sources?: Sources;
  /** This route's fully ancestor-composed `middleware` chain — see `collectRoutes`'s own doc below. */
  readonly middleware: readonly ((inner: Fetch) => Fetch)[];
  /** This route's fully ancestor-composed `handlerMiddleware` chain — see `collectRoutes`'s own doc below. */
  readonly handlerMiddleware: readonly HttpHandlerMiddleware[];
};

/**
 * Walks `route`, flattening it into one `CollectedRoute` per (path, method),
 * including each entry's ancestor-composed `middleware`/`handlerMiddleware`
 * wrap chain (docs/design/subtree-layers-spec.md §5).
 * `ancestorMiddleware`/`ancestorHandlerMiddleware` carry every ancestor
 * node's own resolved directive array, accumulated root-to-leaf as the walk
 * descends — a plain recursion parameter, not a runtime ancestor lookup a
 * leaf could see (§10.2's regression guard: this is ancestor-chain
 * composition at compile time, not position-inheritance at read time).
 *
 * This node's own resolved `middleware`/`handlerMiddleware` (`getHttpMeta
 * (route.meta)`) is appended to the accumulated ancestor arrays — `mw`/`hmw`
 * below — which becomes both what's passed to children (so a descendant's
 * chain includes this node's contribution) and the base every method entry
 * composes against. A method entry's own further leaf-position directives
 * (`getHttpMeta(entry.meta)`) are folded on top of `mw`/`hmw`, minus any
 * function value already present in `mw`/`hmw` (`dedupeAppend` below)
 * rather than a plain concatenation.
 *
 * The dedup is load-bearing: `naiveTransform` (route.ts) sets a plain leaf
 * `op()`'s HttpRoute-position `meta` (`route.meta`) and its sole method
 * entry's `meta` (`route.methods.POST.meta`) to the same `node.meta` object
 * — a bare `op()` has no separate "branch identity" apart from its one
 * method entry — so without dedup, that leaf's own `http.middleware(...)`
 * would be folded twice: once via `route.meta` into `mw`, once via
 * `entry.meta` into the entry's own chain. Reference-equality on the meta
 * object isn't a reliable enough signal to gate on directly, though:
 * `applyMethods` (route.ts) rewrites a method entry's meta into a new
 * object (via `withoutDirective`, stripping only the matched
 * `{kind:"method"}` directive) whenever a `method` directive is present —
 * which every `http.get`/`http.post`/etc. bundle always carries — so after
 * the standard `httpProjection` pipeline runs, `entry.meta !== route.meta`
 * even for a plain single-op leaf, even though neither `applyMethods` nor
 * `applyMoveTo`/`applyResponse` ever touches a `middleware`/
 * `handlerMiddleware` directive (only `method`/`moveTo`/`response` kinds
 * are ever stripped). The middleware/handlerMiddleware function values on
 * `entry.meta` after any such rewrite are therefore the exact same
 * references as on `route.meta`, independent of the surrounding meta
 * object's identity. Deduping by the resolved function value itself (not
 * the meta object) is the signal that survives every built-in rewriter:
 * identical for the "same leaf, meta object rebuilt" case (skips the
 * re-add), distinct for a genuinely separate declaration (a real branch's
 * own middleware vs. its child leaves' own, or two independently authored
 * middleware functions) — both compose correctly either way.
 *
 * Root's entries end up first (index 0) in every leaf's final array —
 * outermost, per §5's "outer wraps inner" ordering, composed via
 * `reduceRight` at the point of use (`toRouter` above; the codegen'd
 * char-matcher and radix/map matchers below apply the same arrays, just
 * carried through their own match structures).
 *
 * This is a compile-time cost, not a per-request one: the tree is walked
 * once, and no router built from the result re-derives ancestry or checks a
 * path prefix per request — it just carries the already-composed array
 * through to wherever it dispatches (see `toRouter`, `radixDispatch`, the
 * generated char-matcher's per-route object literal, `buildMapMatcher`).
 */
function dedupeAppend<T>(base: readonly T[], extra: readonly T[] | undefined): readonly T[] {
  if (extra === undefined || extra.length === 0) return base;
  const seen = new Set(base);
  const toAppend = extra.filter((v) => !seen.has(v));
  return toAppend.length === 0 ? base : [...base, ...toAppend];
}

function collectRoutes(
  route: HttpRoute,
  segs: readonly string[],
  ancestorMiddleware: readonly ((inner: Fetch) => Fetch)[] = [],
  ancestorHandlerMiddleware: readonly HttpHandlerMiddleware[] = [],
): CollectedRoute[] {
  const out: CollectedRoute[] = [];
  const { middleware = [], handlerMiddleware = [] } = getHttpMeta(route.meta);
  const mw = [...ancestorMiddleware, ...middleware];
  const hmw = [...ancestorHandlerMiddleware, ...handlerMiddleware];
  for (const [method, entry] of Object.entries(route.methods ?? {})) {
    const leaf = getHttpMeta(entry.meta);
    out.push({
      path: segs.length > 0 ? `/${segs.join("/")}` : "/",
      method,
      handler: entry.handler,
      meta: entry.meta,
      middleware: dedupeAppend(mw, leaf.middleware),
      handlerMiddleware: dedupeAppend(hmw, leaf.handlerMiddleware),
      ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
    });
  }
  if (route.children !== undefined) {
    for (const [key, child] of Object.entries(route.children)) {
      out.push(...collectRoutes(child, [...segs, key], mw, hmw));
    }
  }
  if (route.fallback !== undefined) {
    out.push(
      ...collectRoutes(route.fallback.subtree, [...segs, `:${route.fallback.name}`], mw, hmw),
    );
  }
  return out;
}

function isDynamicPath(path: string): boolean {
  return splitPath(path).some((seg) => seg.startsWith(":"));
}

// ============================================================================
// radixMatcher — character-level radix trie (route.bench.ts architecture 5).
// Walks raw pathname chars against a compressed prefix tree: no splitPath,
// no per-segment allocation. Static edges store a literal substring; one
// dynamic ("param") edge per node consumes chars up to the next "/" or EOS.
// ============================================================================

type RadixNode = {
  prefix: string;
  children: RadixNode[];
  param?: { readonly name: string; readonly node: RadixNode };
  methods?: Record<string, CollectedRoute>;
};

function newRadixNode(prefix: string): RadixNode {
  return { prefix, children: [] };
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Split `child` at `len` chars into a new intermediate node, preserving its subtree below the split. */
function splitRadixNode(child: RadixNode, len: number): void {
  const tail: RadixNode = {
    prefix: child.prefix.slice(len),
    children: child.children,
    ...(child.param !== undefined ? { param: child.param } : {}),
    ...(child.methods !== undefined ? { methods: child.methods } : {}),
  };
  child.prefix = child.prefix.slice(0, len);
  child.children = [tail];
  delete child.param;
  delete child.methods;
}

function insertRadix(node: RadixNode, path: string, method: string, route: CollectedRoute): void {
  if (path.length === 0) {
    node.methods = node.methods ?? {};
    node.methods[method] = route;
    return;
  }
  if (path[0] === ":") {
    const slashIdx = path.indexOf("/");
    const name = slashIdx === -1 ? path.slice(1) : path.slice(1, slashIdx);
    const rest = slashIdx === -1 ? "" : path.slice(slashIdx);
    if (node.param === undefined) node.param = { name, node: newRadixNode("") };
    insertRadix(node.param.node, rest, method, route);
    return;
  }
  const paramIdx = path.indexOf(":");
  const literal = paramIdx === -1 ? path : path.slice(0, paramIdx);
  const restAfterLiteral = paramIdx === -1 ? "" : path.slice(paramIdx);

  for (const child of node.children) {
    const cp = commonPrefixLen(child.prefix, literal);
    if (cp === 0) continue;
    if (cp < child.prefix.length) splitRadixNode(child, cp);
    insertRadix(child, literal.slice(cp) + restAfterLiteral, method, route);
    return;
  }
  const newChild = newRadixNode(literal);
  node.children.push(newChild);
  insertRadix(newChild, restAfterLiteral, method, route);
}

function buildRadixTrie(routes: readonly CollectedRoute[]): RadixNode {
  const root = newRadixNode("");
  for (const route of routes) insertRadix(root, route.path, route.method, route);
  return root;
}

function radixDispatch(root: RadixNode, pathname: string, method: string): RouteMatch | undefined {
  const slugs: Record<string, string> = {};
  let node = root;
  let i = 0;
  const len = pathname.length;
  for (;;) {
    const prefix = node.prefix;
    const plen = prefix.length;
    if (plen > 0) {
      if (i + plen > len) return undefined;
      for (let k = 0; k < plen; k++) {
        if (pathname.charCodeAt(i + k) !== prefix.charCodeAt(k)) return undefined;
      }
      i += plen;
    }
    if (i === len) {
      const entry = node.methods?.[method];
      return entry !== undefined
        ? {
            handler: entry.handler,
            meta: entry.meta,
            ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
            middleware: entry.middleware,
            handlerMiddleware: entry.handlerMiddleware,
            slugs,
          }
        : undefined;
    }
    const c = pathname.charCodeAt(i);
    let next: RadixNode | undefined;
    for (const child of node.children) {
      if (child.prefix.charCodeAt(0) === c) {
        next = child;
        break;
      }
    }
    if (next !== undefined) {
      node = next;
      continue;
    }
    if (node.param !== undefined) {
      let end = i;
      while (end < len && pathname.charCodeAt(end) !== 47 /* "/" */) end++;
      slugs[node.param.name] = pathname.slice(i, end);
      i = end;
      node = node.param.node;
      continue;
    }
    return undefined;
  }
}

function buildRadixMatcher(routes: readonly CollectedRoute[]): Matcher {
  const root = buildRadixTrie(routes);
  return (pathname, method) => radixDispatch(root, pathname, method);
}

export function radixMatcher(route: HttpRoute): Matcher {
  return buildRadixMatcher(collectRoutes(route, []));
}

export function radixRouter(
  route: HttpRoute,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
  serviceStores: ServiceStores = {} as ServiceStores,
): CompiledRouter {
  return toRouter(
    radixMatcher(route),
    handlerMiddleware,
    detection,
    errorEncoder,
    thrownErrorEncoder,
    serviceStores,
  );
}

// ============================================================================
// compiledCharMatcher — codegen a JS function via `new Function()` with the
// routing logic inlined as nested if/else on `s.charCodeAt(i)`
// (route.bench.ts architecture 7). Unbranching literal runs are compressed
// into a single `startsWith(chunk, i)` call — the key optimization the
// benchmark found — instead of one nested `if` per character.
// ============================================================================

type CharFnTrieNode = {
  readonly literalChildren: Map<number, CharFnTrieNode>;
  paramChild?: { readonly name: string; readonly node: CharFnTrieNode };
  readonly methods: Map<string, number>;
};

function newCharFnNode(): CharFnTrieNode {
  return { literalChildren: new Map(), methods: new Map() };
}

function insertCharFn(root: CharFnTrieNode, path: string, method: string, routeIdx: number): void {
  let node = root;
  let i = 0;
  while (i < path.length) {
    if (path[i] === ":") {
      let j = i + 1;
      while (j < path.length && path[j] !== "/") j++;
      const name = path.slice(i + 1, j);
      if (node.paramChild === undefined) node.paramChild = { name, node: newCharFnNode() };
      node = node.paramChild.node;
      i = j;
    } else {
      const code = path.charCodeAt(i);
      let child = node.literalChildren.get(code);
      if (child === undefined) {
        child = newCharFnNode();
        node.literalChildren.set(code, child);
      }
      node = child;
      i++;
    }
  }
  node.methods.set(method, routeIdx);
}

/** Follow a run of unbranching single-literal-child nodes and fold it into one string —
 *  see route.bench.ts's `chaseChunk` for the full rationale (compiles a long unbranching
 *  literal run to one `startsWith` check instead of one nested `if` per character). */
function chaseChunk(node: CharFnTrieNode): { chunk: string; target: CharFnTrieNode } {
  let chunk = "";
  let cur = node;
  for (;;) {
    if (cur.methods.size > 0) break;
    if (cur.paramChild !== undefined) break;
    if (cur.literalChildren.size !== 1) break;
    const [code, child] = [...cur.literalChildren][0]!;
    chunk += String.fromCharCode(code);
    cur = child;
  }
  return { chunk, target: cur };
}

function buildCompiledCharMatcher(routes: readonly CollectedRoute[]): Matcher {
  const root = newCharFnNode();
  for (let i = 0; i < routes.length; i++) {
    insertCharFn(root, routes[i]!.path, routes[i]!.method, i);
  }

  let paramCounter = 0;

  function gen(node: CharFnTrieNode, slugAssigns: readonly string[]): string {
    let code = "";
    if (node.methods.size > 0) {
      code += `if (i === len) {\n`;
      for (const [method, idx] of node.methods) {
        const slugsObj = slugAssigns.length > 0 ? `{ ${slugAssigns.join(", ")} }` : "{}";
        code += `if (method === ${JSON.stringify(method)}) return { handler: entries[${idx}].handler, meta: entries[${idx}].meta, sources: entries[${idx}].sources, middleware: entries[${idx}].middleware, handlerMiddleware: entries[${idx}].handlerMiddleware, slugs: ${slugsObj} }\n`;
      }
      code += `}\n`;
    }

    const branches: string[] = [];
    if (node.literalChildren.size > 0) {
      for (const [charCode, firstChild] of node.literalChildren) {
        const { chunk, target } = chaseChunk(firstChild);
        const fullChunk = String.fromCharCode(charCode) + chunk;
        branches.push(
          `if (s.startsWith(${JSON.stringify(fullChunk)}, i)) {\ni += ${fullChunk.length}\n${gen(target, slugAssigns)}\n}`,
        );
      }
    }
    if (node.paramChild !== undefined) {
      const pvar = `p${paramCounter++}`;
      const nextSlugAssigns = [...slugAssigns, `${JSON.stringify(node.paramChild.name)}: ${pvar}`];
      branches.push(
        `{\nconst start${pvar} = i\nwhile (i < len && s.charCodeAt(i) !== 47) i++\nconst ${pvar} = s.slice(start${pvar}, i)\n${gen(node.paramChild.node, nextSlugAssigns)}\n}`,
      );
    }
    if (branches.length > 0) {
      code += `if (i < len) {\n`;
      code += branches.join(" else ");
      code += `\n}\n`;
    }
    return code;
  }

  const body = `let i = 0\nconst len = s.length\n${gen(root, [])}\nreturn undefined\n`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- deliberate: this is the "compiled char-level function" architecture
  const fn = new Function("s", "method", "entries", body) as (
    s: string,
    method: string,
    entries: readonly CollectedRoute[],
  ) => RouteMatch | undefined;

  return (pathname, method) => fn(pathname, method, routes);
}

export function compiledCharMatcher(route: HttpRoute): Matcher {
  return buildCompiledCharMatcher(collectRoutes(route, []));
}

export function compiledCharRouter(
  route: HttpRoute,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
  serviceStores: ServiceStores = {} as ServiceStores,
): CompiledRouter {
  return toRouter(
    compiledCharMatcher(route),
    handlerMiddleware,
    detection,
    errorEncoder,
    thrownErrorEncoder,
    serviceStores,
  );
}

// ============================================================================
// mapMatcher — static-only `Map<pathname, Record<method, entry>>` (the
// static half of route.bench.ts architecture 8). Only serves routes whose
// path has no dynamic segment; a route with a `:param` anywhere is silently
// excluded (composed with a dynamic matcher via `chainMatchers`/`mapCharRouter`).
// ============================================================================

function buildMapMatcher(routes: readonly CollectedRoute[]): Matcher {
  const map = new Map<string, Record<string, CollectedRoute>>();
  for (const route of routes) {
    let methods = map.get(route.path);
    if (methods === undefined) {
      methods = {};
      map.set(route.path, methods);
    }
    methods[route.method] = route;
  }
  return (pathname, method) => {
    const entry = map.get(pathname)?.[method];
    return entry !== undefined
      ? {
          handler: entry.handler,
          meta: entry.meta,
          ...(entry.sources !== undefined ? { sources: entry.sources } : {}),
          middleware: entry.middleware,
          handlerMiddleware: entry.handlerMiddleware,
          slugs: {},
        }
      : undefined;
  };
}

export function mapMatcher(route: HttpRoute): Matcher {
  return buildMapMatcher(collectRoutes(route, []).filter((r) => !isDynamicPath(r.path)));
}

// ============================================================================
// mapCharRouter — the specialized hybrid (route.bench.ts architecture 8):
// static routes go into a `Map` (one hash lookup, no traversal); dynamic
// routes only feed a compiled char fn, producing a smaller generated
// function than compiling the whole tree would. `Map.get` first, fall
// through to the compiled char fn on a miss.
// ============================================================================

export function mapCharRouter(
  route: HttpRoute,
  handlerMiddleware?: readonly HttpHandlerMiddleware[],
  detection?: DetectionOptions,
  errorEncoder?: HttpErrorEncoder,
  thrownErrorEncoder?: ThrownErrorEncoder,
  serviceStores: ServiceStores = {} as ServiceStores,
): CompiledRouter {
  const routes = collectRoutes(route, []);
  const staticMatcher = buildMapMatcher(routes.filter((r) => !isDynamicPath(r.path)));
  const dynamicMatcher = buildCompiledCharMatcher(routes.filter((r) => isDynamicPath(r.path)));
  return toRouter(
    chainMatchers(staticMatcher, dynamicMatcher),
    handlerMiddleware,
    detection,
    errorEncoder,
    thrownErrorEncoder,
    serviceStores,
  );
}

// ============================================================================
// withALS — per-request AsyncLocalStorage context, composable over any
// `CompiledRouter`. `runRoute` (route.ts) is a clean linear `await` chain
// with no concurrent branches in flight, so a context entered once per
// request via `storage.run` stays correctly scoped to that request's whole
// dispatch — no leakage across concurrent requests, no manual propagation
// needed at each stage.
// ============================================================================

/**
 * Wrap `router` so every request runs inside its own `AsyncLocalStorage`
 * context. `init` computes the per-request context value from the incoming
 * `Request`; `router` (and everything it calls, transitively) can then read
 * it via `storage.getStore()`. Composable: since the return type is itself a
 * `CompiledRouter`, `withALS` can wrap the output of `radixRouter`,
 * `toRouter`, `makeRouterFromRoute`, or another `withALS` layer.
 *
 * `init` may return `T` synchronously (e.g. reading a header) or a
 * `Promise<T>` (e.g. a session-cookie DB lookup) — a promise is awaited
 * before entering the ALS scope; a sync return runs with no added overhead.
 */
export function withALS<T>(
  router: CompiledRouter,
  storage: AsyncLocalStorage<T>,
  init: (req: Request) => T | Promise<T>,
): CompiledRouter {
  return (req) => {
    const store = init(req);
    return store instanceof Promise
      ? store.then((resolved) => storage.run(resolved, () => router(req)))
      : storage.run(store, () => router(req));
  };
}
