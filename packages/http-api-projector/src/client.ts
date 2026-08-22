// packages/http-api-projector/src/client.ts — @rhi-zone/fractal-http-api-projector
//
// Runtime HTTP client. Builds HTTP requests and derives verbs/paths directly
// from an `HttpRoute` tree (route.ts) rather than re-deriving them from raw
// `meta.http` directives: once the rewriter pipeline (`naiveTransform` →
// `applyMethods`/`applyMoveTo`/`applyResponse`) has run, the tree's structure
// already IS the URL structure — children keys are path segments, `fallback`
// is the wildcard segment, and `methods` is keyed by the resolved HTTP verb.
//
// `applyMoveTo` co-locates operations (e.g. read/replace/remove) onto a
// single route position's `methods` map, keyed by verb — the original Node
// child names are gone from the route tree. Since those names are part of
// the client's public API (`client.books.bookId(id).read()`), `createClient`
// recovers them by walking the original `Node` tree once to build a
// `Handler -> own child key` map, threaded through the `HttpRoute` walk
// (same handler-identity trick as OpenAPI's `buildNameMap`).
// `createClientFromRoute`, which has no `Node` to walk, degrades a
// co-located entry to its lowercased HTTP verb as the member name instead.
//
// Two entry points:
//   - `createClientFromRoute(route, opts)` — core: walks an already-projected
//     `HttpRoute` tree. No `Node` needed for path/verb correctness; only
//     co-located method names degrade (see above).
//   - `createClient(node, opts)` — convenience: projects `node` via
//     `httpProjection` and also walks the raw `Node` tree to recover authored
//     co-located names (`.read()`/`.replace()`/`.remove()`).
//
// The client is an ENUMERATING projection (like OpenAPI/CLI-help), not a
// dispatching one (see docs/design/router-model.md — "Projections"): it walks
// the whole tree once at construction time to build the proxy, computing each
// leaf's verb and concrete path as the proxy is navigated (fallback slug
// values are substituted directly, not filled into a template later).
//
// A `fallback` (wildcard-capture) node becomes a function keyed by its
// `fallback.name`, taking the slug value and returning the sub-client for the
// bound subtree:
//   client.books.bookId("book-1").read()
//
// TODO(client): typed client via codegen from source — the current shape uses
// unknown/generics everywhere. A typed surface requires codegen'd input/output
// types per leaf, a future milestone.
//
// See:
//   packages/http-api-projector/src/route.ts    — HttpRoute, naiveTransform, rewriters
//   packages/http-api-projector/src/dx.ts       — httpProjection preset
//   packages/api-tree/src/node.ts               — Node, Handler, fallback, isLeaf

import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node";
import type { TypedClient } from "@rhi-zone/fractal-api-tree";
import { httpProjection } from "./dx.ts";
import type { HttpRoute, RouteLeafMeta } from "./route.ts";
import { ClientError } from "./client-error.ts";
import { composeDecodeResponse, composeFetch } from "./extension.ts";
import type { ClientExtension } from "./extension.ts";

export { ClientError } from "./client-error.ts";

// ============================================================================
// Public API types
// ============================================================================

export type ClientOptions = {
  /** Base URL prepended to every request path. Defaults to "" (relative). */
  readonly baseUrl?: string;
  /**
   * Fetch implementation to use. Defaults to global `fetch`.
   * Inject `createFetch(tree)` from @rhi-zone/fractal-http-api-projector/presets for in-process
   * round-trip tests without a network.
   */
  readonly fetch?: (req: Request) => Promise<Response>;
  /**
   * Per-request timeout in milliseconds, applied via `AbortSignal.timeout`.
   * Overridable per-call via `CallOptions.timeout`. No timeout by default.
   */
  readonly timeout?: number;
  /**
   * An `AbortSignal` that cancels every request made by this client (e.g. a
   * component-lifetime or navigation signal). Combined with `timeout` (if
   * both set) via `AbortSignal.any`. Overridable per-call via
   * `CallOptions.signal`.
   */
  readonly signal?: AbortSignal;
  /**
   * Extensions composing around the fetch implementation — retry, request/
   * response interceptors, a fixed timeout, or a user-authored
   * `ClientExtension`. Applied outermost-first (see extension.ts's module
   * doc). Composed once at client construction, wrapping every call this
   * client makes. See `packages/http-api-projector/src/extensions/` for the
   * built-ins and `./extension.ts` for the API a custom extension implements.
   */
  readonly extensions?: readonly ClientExtension[];
};

/** Per-call overrides for `timeout`/`signal`, layered on top of the client-level `ClientOptions`. */
export type CallOptions = {
  /** Overrides the client-level `timeout` for this call only. */
  readonly timeout?: number;
  /** Overrides the client-level `signal` for this call only. */
  readonly signal?: AbortSignal;
};

// ============================================================================
// AnyClient / RouteClient — the erased-input client shape, computed WITHOUT
// `any`.
//
// `createClientFromRoute` has no `Node` to lean on, so it can't reuse
// `TypedClient<N, CallOptions>` (api-tree/typed-client.ts) the way
// `createClient` does. But `HttpRoute<H>` (route.ts) is itself generic, and
// `naiveTransform` preserves that genericity through its recursively-computed
// return type (`NaiveRoute<N>`, route.ts): a route tree that has gone through
// `naiveTransform` alone still carries real per-position literal shape
// (every method key is the fixed literal `"POST"`).
//
// That precision does not survive `applyMethods`, independently of whether
// `applyMoveTo` also runs. `applyMethods` renames a method key by reading a
// plain runtime `string` out of the open `meta` bag, so its type-level return
// (`ApplyMethodsRoute<R>`, route.ts) widens `methods` to `Record<string,
// ...>` — the key is gone, only the entry's value (handler type) survives.
// Since real HTTP APIs need GET/PUT/DELETE (not everything staying at
// `naiveTransform`'s POST default), `applyMethods` runs in essentially every
// realistic pipeline — so `RouteClient` below bails out to `AnyClient`
// (sound, but not per-route-named) as soon as it sees a key-erased `methods`
// map. `applyMoveTo` is a separate, independent eraser on top (see its own
// doc comment, route.ts): a `moveTo` target is also a plain runtime string,
// so a `moveTo`-using pipeline erases even the tree shape (children/fallback
// positions), not just method-key names.
//
// `RouteClient<R, CallOpts>` is therefore generic in the same sense
// `TypedClient<N, CallOpts>` is: it computes real precision when `R`'s own
// type carries it (the narrow case: `naiveTransform` alone, no method-verb
// resolution, no co-location), and degrades gracefully — never to `any` —
// when it doesn't (the realistic case: any pipeline that resolves real HTTP
// verbs, `httpProjection`'s default included). `createClientFromRoute` below
// is generic over `R extends HttpRoute` for exactly this reason, even though
// the common case still lands on `AnyClient`.
// ============================================================================

/** A leaf callable — what a route position with a resolved method becomes. */
type ClientLeafFn<CallOpts> = (input?: unknown, callOpts?: CallOpts) => Promise<unknown>;

/**
 * The erased-but-sound client shape: every property is itself an
 * `AnyClient` — recursively — and `AnyClient` carries both call signatures a
 * route position can resolve to at runtime: a leaf callable
 * (`(input?, opts?) => Promise<unknown>`, what `.list()`/`.add(data)`
 * become) and a fallback callable (`(slugValue: string) => AnyClient`, what
 * `.bookId(id)` becomes) — exactly the shapes `buildClientNode` can ever
 * produce (see its own doc comment below), plus direct callability at the
 * root, since a route tree whose root position is a single-leaf-method
 * (`isSingleLeafMethod`) collapses to a bare callable rather than an object.
 *
 * Uniform per-property typing (rather than a union of "nested client OR leaf
 * fn OR fallback fn") is deliberate: which shape a given key resolves to is
 * a runtime fact this erased type doesn't have, so a union would force every
 * chained access (`client.books.add(...)`, `client.books.bookId(id).read()`)
 * to narrow first. `AnyClient` instead stays a single self-referential type
 * whose two call signatures are picked by TypeScript's normal overload
 * resolution based on the call site's argument shape: a one-`string`-
 * argument call (`bookId("id")`) resolves via the fallback signature
 * (return type `AnyClient`, so `.read` chains); a zero/non-string-argument
 * call (`list()`, `add({...})`) falls through to the leaf signature (return
 * type `Promise<unknown>`). This is a heuristic, not a proof — a leaf whose
 * real input happens to be a bare string would mis-resolve to the fallback
 * signature and need an explicit cast — but it stays strictly sound (checked
 * call arity/argument types, no arbitrary property or operation silently
 * accepted) versus `any`'s "everything goes."
 */
export interface AnyClient<CallOpts = CallOptions> {
  readonly [key: string]: AnyClient<CallOpts>;
  (slugValue: string): AnyClient<CallOpts>;
  (input?: unknown, opts?: CallOpts): Promise<unknown>;
}

/** A method entry's callable type — precise when the handler's own type is known, erased-but-sound otherwise. */
type RouteMethodFn<E, CallOpts> = E extends { readonly handler: (input: infer I) => infer Res }
  ? (input: I, opts?: CallOpts) => Promise<Awaited<Res>>
  : ClientLeafFn<CallOpts>;

/**
 * True iff `T`'s keys are a single literal (not a union, not `string`) —
 * the type-level mirror of `isSingleLeafMethod`'s `Object.keys(...).length
 * === 1`. Distributes `keyof T` over itself (the standard "is this a union"
 * idiom): for a genuine single key, the one branch evaluates to `true`; for
 * two or more keys, every branch still sees at least one other key after
 * `Exclude`, so every branch is `false` and the distributed union collapses
 * to plain `false` rather than a `true | false` mix.
 */
type IsSingleKey<T> = [keyof T] extends [never]
  ? false
  : (
        keyof T extends infer K
          ? K extends keyof T
            ? [Exclude<keyof T, K>] extends [never]
              ? true
              : false
            : never
          : never
      ) extends true
    ? true
    : false;

/**
 * Precise per-key methods object — one named callable per method entry,
 * name = lowercased HTTP verb (a bare `HttpRoute` has no memory of a
 * co-located handler's authored Node key, only its resolved verb; see
 * `createClientFromRoute`'s doc). Only invoked once `keyof M` is confirmed a
 * literal, not `string` — see `RouteClient`.
 */
type RouteMethodsObject<M, CallOpts> = {
  readonly [K in keyof M as K extends string ? Lowercase<K> : never]: RouteMethodFn<M[K], CallOpts>;
};

/**
 * The precise client shape `buildClientNode` computes for a route tree of
 * type `R` — see the module doc above for when `R` carries enough literal
 * shape to make this precise versus when it degrades to `AnyClient`. Mirrors
 * `buildClientNode`'s own branching exactly: a route position with one
 * resolved method and no children/fallback (`isSingleLeafMethod`) collapses
 * to a bare callable; any other position becomes an object whose method
 * entries are named callables (name = lowercased verb — see
 * `RouteMethodsObject`), each child recurses under its path-segment key, and
 * a `fallback` becomes a `(slug) => sub-client` function.
 *
 * Every presence check below uses the same structural
 * `R extends { readonly field: infer X } ? ... : ...` idiom `NaiveRoute`/
 * `ApplyMethodsRoute`/`ApplyResponseRoute` (route.ts) use internally, not
 * indexed access (`R["field"]`): `R` is typically an intersection of several
 * conditionally-contributed pieces (each of those three rewriter types is
 * built as `(...) & (...) & (...) & { meta }`), and indexed access into an
 * intersection for a field absent from every constituent does not reliably
 * collapse to `undefined` the way it does for a plain object type — it
 * instead widens back to the field's type on the `HttpRoute` constraint
 * itself, silently reintroducing the erased shape even for a position that
 * provably has no fallback/children. The structural-conditional form is
 * immune to this, since it's exactly the form the intersection was built
 * with in the first place.
 */
export type RouteClient<R extends HttpRoute, CallOpts = CallOptions> = R extends {
  readonly methods?: infer M extends
    | Readonly<Record<string, { readonly handler: Handler }>>
    | undefined;
}
  ? [M] extends [undefined]
    ? RouteChildrenPartOf<R, CallOpts> & RouteFallbackPart<R, CallOpts> // no methods at this position — pure branch
    : string extends keyof NonNullable<M>
      ? AnyClient<CallOpts> // methods present but key-erased (e.g. `applyMethods` widens to `Record<string, V>` — see route.ts's `ApplyMethodsRoute` doc — independently of `applyMoveTo`)
      : IsBareLeaf<R> extends true
        ? IsSingleKey<NonNullable<M>> extends true
          ? RouteMethodFn<NonNullable<M>[keyof NonNullable<M>], CallOpts> // bare leaf callable — isSingleLeafMethod's true branch
          : RouteMethodsObject<NonNullable<M>, CallOpts>
        : RouteMethodsObject<NonNullable<M>, CallOpts> &
            RouteChildrenPartOf<R, CallOpts> &
            RouteFallbackPart<R, CallOpts>
  : RouteChildrenPartOf<R, CallOpts> & RouteFallbackPart<R, CallOpts>;

/**
 * True iff `R` has no children and no fallback — the other two thirds of
 * `isSingleLeafMethod`'s condition (the `methods` count is checked
 * separately, via `IsSingleKey`, by `RouteClient` itself).
 */
type IsBareLeaf<R extends HttpRoute> = R extends {
  readonly children?: infer C extends Readonly<Record<string, HttpRoute>> | undefined;
}
  ? [C] extends [undefined]
    ? R extends {
        readonly fallback?: infer F extends
          | { readonly name: string; readonly subtree: HttpRoute }
          | undefined;
      }
      ? [F] extends [undefined]
        ? true
        : false
      : true
    : false
  : true;

/**
 * Children part, re-derived from `R` directly (rather than taking an
 * already-extracted `C`) so every call site shares one structural `infer` —
 * matching `RouteClient`'s doc comment on avoiding indexed access. Degrades
 * to `unknown` (a no-op in an intersection) when `R` has no children.
 */
type RouteChildrenPartOf<R extends HttpRoute, CallOpts> = R extends {
  readonly children?: infer C extends Readonly<Record<string, HttpRoute>> | undefined;
}
  ? [C] extends [undefined]
    ? unknown
    : string extends keyof NonNullable<C>
      ? { readonly [key: string]: RouteClient<HttpRoute, CallOpts> }
      : {
          readonly [K in keyof NonNullable<C>]: NonNullable<C>[K] extends HttpRoute
            ? RouteClient<NonNullable<C>[K], CallOpts>
            : never;
        }
  : unknown;

/**
 * Fallback part — `{ [fallback.name]: (slug) => RouteClient<subtree, CallOpts> }`,
 * or an index signature when the fallback's own name is erased to plain
 * `string`. Degrades to `unknown` (a no-op in an intersection) when `R` has
 * no fallback.
 */
type RouteFallbackPart<R extends HttpRoute, CallOpts> = R extends {
  readonly fallback?:
    | { readonly name: infer Nm extends string; readonly subtree: infer S extends HttpRoute }
    | undefined;
}
  ? string extends Nm
    ? { readonly [key: string]: (slugValue: string) => RouteClient<HttpRoute, CallOpts> }
    : { readonly [K in Nm]: (slugValue: string) => RouteClient<S, CallOpts> }
  : unknown;

type FetchImpl = (req: Request) => Promise<Response>;

// ============================================================================
// Internal: timeout/signal resolution
//
// A fresh `AbortSignal.timeout(ms)` is created PER CALL (not once at client
// construction) — a timeout signal starts its clock the moment it's created,
// so a shared one would only ever fire on the client's first slow call.
// Per-call `CallOptions` fully override (not merge with) the client-level
// `timeout`/`signal` — this mirrors how a caller would expect "just this one
// request, no timeout" (`{ timeout: undefined }` can't distinguish "unset"
// from "clear the default", so an explicit override replaces, not merges).
// ============================================================================

function resolveSignal(
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  callOpts: CallOptions | undefined,
): AbortSignal | undefined {
  const timeout = callOpts?.timeout ?? baseTimeout;
  const signal = callOpts?.signal ?? baseSignal;
  const timeoutSignal = timeout !== undefined ? AbortSignal.timeout(timeout) : undefined;
  if (timeoutSignal !== undefined && signal !== undefined)
    return AbortSignal.any([signal, timeoutSignal]);
  return timeoutSignal ?? signal;
}

/** Rethrow abort-driven fetch failures with a message that distinguishes timeout from user cancellation. */
function describeAbort(
  err: unknown,
  verb: string,
  path: string,
  timeout: number | undefined,
): Error {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new Error(`Request timed out after ${timeout}ms: ${verb} ${path}`);
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new Error(`Request aborted: ${verb} ${path}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ============================================================================
// Internal: handler → own-key name map, built from the raw Node tree
//
// Unlike OpenAPI's `buildNameMap` (which accumulates a dotted path from the
// root, since operationIds must be globally unique), the client only needs a
// handler's OWN authored child key — the map is keyed by handler IDENTITY,
// so unrelated handlers sharing the same key name elsewhere in the tree
// (e.g. two different resources each having a "list" op) never collide.
// This is what lets a co-located handler (moved by `applyMoveTo` onto its
// parent's fallback position) keep its authored name
// (read/replace/remove) as a client member instead of surfacing as the
// HTTP verb it was assigned.
// ============================================================================

function collectHandlerNames(n: Node, out: Map<Handler, string>): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(child.handler!, key);
    } else {
      collectHandlerNames(child, out);
    }
  }
  if (n.fallback !== undefined) {
    // `fallback.subtree` can be a bare leaf (`op()`), not just a branch
    // (`api({...})`) — recursing unconditionally would silently find no
    // children and never record this handler's name. Mirror the
    // ordinary-leaf branch above: when the subtree itself is a leaf, key it
    // by the fallback's own name directly (same convention as
    // api-tree/tree.ts's `walkNodeType`, aa28952, and the other projectors'
    // identical fix).
    if (isLeaf(n.fallback.subtree)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(n.fallback.subtree.handler!, n.fallback.name);
    } else {
      collectHandlerNames(n.fallback.subtree, out);
    }
  }
}

/** Build the handler → own-child-key name map for a Node tree — see doc above. */
function buildHandlerNames(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>();
  collectHandlerNames(n, out);
  return out;
}

// ============================================================================
// Internal: handler → full codegen-name map, built from the raw Node tree
//
// A SEPARATE convention from `buildHandlerNames` above (own key only): this
// one accumulates the full underscore-joined path from the root, exactly
// matching `extractToolSchemas`'s own naming (see api-tree/src/tree.ts) and
// codegen.ts's `buildCodegenNameMap` — the key a `SchemaMap` is indexed by.
// Duplicated here rather than imported/shared, matching this package's
// existing convention of each projector deriving these facts via its own
// self-contained walk (openapi.ts's `buildNameMap`, codegen.ts's own
// `buildCodegenNameMap`; see openapi.ts's module doc: "Two projectors, two
// encodings of the same fact"). Threaded into `DecodeContext.codegenName` so
// an extension (e.g. `extensions/validation.ts`) can look up this operation's
// entry in a `SchemaMap` without re-deriving tree-position naming itself.
// ============================================================================

function collectCodegenNames(n: Node, prefix: string, out: Map<Handler, string>): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    const seg = prefix.length > 0 ? `${prefix}_${key}` : key;
    if (isLeaf(child)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(child.handler!, seg);
    } else {
      collectCodegenNames(child, seg, out);
    }
  }
  if (n.fallback !== undefined) {
    const seg = prefix.length > 0 ? `${prefix}_${n.fallback.name}` : n.fallback.name;

    // Same bare-leaf `fallback.subtree` case as `collectHandlerNames` above
    // — key it directly at `seg` (no extra segment beyond the fallback's
    // own name) instead of recursing into a leaf's nonexistent `children`.
    if (isLeaf(n.fallback.subtree)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out.set(n.fallback.subtree.handler!, seg);
    } else {
      collectCodegenNames(n.fallback.subtree, seg, out);
    }
  }
}

/** Build the handler → full codegen-name map for a Node tree — see doc above. */
function buildCodegenNames(n: Node): Map<Handler, string> {
  const out = new Map<Handler, string>();
  collectCodegenNames(n, "", out);
  return out;
}

// ============================================================================
// Internal: leaf caller
// ============================================================================

function makeCaller(
  verb: string,
  path: string,
  slugValues: ReadonlySet<string>,
  baseUrl: string,
  fetchImpl: FetchImpl,
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  extensions: readonly ClientExtension[] | undefined,
  meta: RouteLeafMeta,
  codegenName: string | undefined,
): (input?: unknown, callOpts?: CallOptions) => Promise<unknown> {
  return async (input?: unknown, callOpts?: CallOptions): Promise<unknown> => {
    const timeout = callOpts?.timeout ?? baseTimeout;
    const signal = resolveSignal(baseTimeout, baseSignal, callOpts) ?? null;

    let req: Request;
    if (verb === "GET" || verb === "HEAD" || verb === "DELETE") {
      // Input goes into query params for read-only/deletion ops; body is not
      // conventional for GET/HEAD/DELETE.
      const finalUrl = baseUrl.startsWith("http")
        ? new URL(path, baseUrl)
        : new URL(path, "http://localhost");
      if (input !== null && input !== undefined && typeof input === "object") {
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
          if (slugValues.has(k)) continue; // already embedded in the path
          if (v !== undefined && v !== null) {
            finalUrl.searchParams.set(k, String(v));
          }
        }
      }
      const url = baseUrl.startsWith("http")
        ? finalUrl.toString()
        : finalUrl.pathname + (finalUrl.search !== "" ? finalUrl.search : "");
      req = new Request(url, { method: verb, signal });
    } else {
      // POST/PUT/PATCH: input as JSON body
      const url = `${baseUrl}${path}`;
      req = new Request(url, {
        method: verb,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
        signal,
      });
    }

    let res: Response;
    try {
      res = await fetchImpl(req);
    } catch (err) {
      throw describeAbort(err, verb, path, timeout);
    }

    const decoded = composeDecodeResponse(
      res,
      { request: req, refetch: fetchImpl, meta, codegenName },
      extensions,
    );
    if (decoded !== undefined) return decoded.value;

    let body: unknown;
    const ct = res.headers.get("Content-Type") ?? "";
    if (ct.includes("application/json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (!res.ok) {
      throw new ClientError(res.status, body);
    }

    return body;
  };
}

// ============================================================================
// Internal: recursive sub-client builder over HttpRoute
//
// A route position with exactly one method and no children/fallback is a
// true leaf (mirrors the old `isLeaf` check) — it becomes a callable
// directly. Any other position (multiple methods co-located via
// `applyMoveTo`, and/or children, and/or a fallback) becomes an object:
// each method entry contributes a named callable (name from `handlerNames`
// when available, else the lowercased verb), each child recurses under its
// path-segment key, and `fallback` becomes a `(slug) => sub-client` function.
// ============================================================================

function isSingleLeafMethod(route: HttpRoute): boolean {
  return (
    Object.keys(route.methods ?? {}).length === 1 &&
    Object.keys(route.children ?? {}).length === 0 &&
    route.fallback === undefined
  );
}

/**
 * The type `buildClientNode` itself constructs with — deliberately looser
 * than the public `AnyClient`/`RouteClient<R>` (which carry a call
 * signature, so a plain object literal like `{}` can't satisfy them). Same
 * convention as `createClient` below: the builder constructs dynamically,
 * untyped internally, and the PUBLIC entry point casts the finished value to
 * the precise static type at the boundary — this function's own return type
 * is never itself exposed.
 */
type ClientNodeBuildResult = Record<string, unknown> | ClientLeafFn<CallOptions>;

function buildClientNode(
  route: HttpRoute,
  path: string,
  slugValues: ReadonlySet<string>,
  baseUrl: string,
  fetchImpl: FetchImpl,
  handlerNames: ReadonlyMap<Handler, string> | undefined,
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  extensions: readonly ClientExtension[] | undefined,
  codegenNames: ReadonlyMap<Handler, string> | undefined,
): ClientNodeBuildResult {
  if (isSingleLeafMethod(route)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [verb] = Object.keys(route.methods!);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const entry = route.methods![verb!]!;
    return makeCaller(
      verb!,
      path,
      slugValues,
      baseUrl,
      fetchImpl,
      baseTimeout,
      baseSignal,
      extensions,
      entry.meta,
      codegenNames?.get(entry.handler),
    );
  }

  const client: Record<string, unknown> = {};

  for (const [verb, entry] of Object.entries(route.methods ?? {})) {
    const name = handlerNames?.get(entry.handler) ?? verb.toLowerCase();
    client[name] = makeCaller(
      verb,
      path,
      slugValues,
      baseUrl,
      fetchImpl,
      baseTimeout,
      baseSignal,
      extensions,
      entry.meta,
      codegenNames?.get(entry.handler),
    );
  }

  for (const [seg, child] of Object.entries(route.children ?? {})) {
    client[seg] = buildClientNode(
      child,
      `${path}/${seg}`,
      slugValues,
      baseUrl,
      fetchImpl,
      handlerNames,
      baseTimeout,
      baseSignal,
      extensions,
      codegenNames,
    );
  }

  if (route.fallback !== undefined) {
    const { name, subtree } = route.fallback;
    client[name] = (slugValue: string): ClientNodeBuildResult =>
      buildClientNode(
        subtree,
        `${path}/${slugValue}`,
        new Set([...slugValues, name]),
        baseUrl,
        fetchImpl,
        handlerNames,
        baseTimeout,
        baseSignal,
        extensions,
        codegenNames,
      );
  }

  return client;
}

// ============================================================================
// createClientFromRoute — public API (core)
// ============================================================================

/**
 * Build a runtime HTTP client from an already-projected `HttpRoute` tree.
 * Path and verb come directly from the route tree's own structure (children
 * keys, `fallback`, `methods` keys), exactly matching what
 * `makeRouterFromRoute` dispatches against.
 *
 * Co-located method entries (multiple HTTP methods placed at the same route
 * position via `applyMoveTo`) surface as members named by their lowercased
 * HTTP verb (`.get()`/`.put()`/`.delete()`), since a bare `HttpRoute` has no
 * memory of the authored Node child key a moved handler started at. Use
 * `createClient(node, opts)` when the original `Node` tree is available to
 * recover the authored names (e.g. `.read()`/`.replace()`/`.remove()`).
 *
 * The return type is `RouteClient<R, CallOptions>` (see the module doc above
 * `AnyClient`/`RouteClient`): computed structurally from `route`'s own type
 * when it carries enough literal shape — in practice, only when `route` is
 * exactly `naiveTransform(tree)` with no further rewriters (every method key
 * is still the fixed `"POST"` literal). Otherwise it falls back to
 * `AnyClient` — sound, but not per-route-named — which in practice covers
 * any route that has gone through `applyMethods` (real GET/PUT/DELETE
 * resolution, not just the POST default), independently of whether
 * `applyMoveTo` also ran; see the doc above for why `applyMethods` alone
 * already erases method-key precision. Only the return type is generic
 * here; the runtime proxy (`buildClientNode`) is built dynamically
 * regardless of what `R` resolves to.
 *
 * @param route - The (already rewritten) HttpRoute tree to project.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClientFromRoute<R extends HttpRoute>(
  route: R,
  opts: ClientOptions = {},
): RouteClient<R, CallOptions> {
  const baseUrl = opts.baseUrl ?? "";
  const fetchImpl = composeFetch(opts.fetch ?? globalThis.fetch.bind(globalThis), opts.extensions);
  return buildClientNode(
    route,
    "",
    new Set(),
    baseUrl,
    fetchImpl,
    undefined,
    opts.timeout,
    opts.signal,
    opts.extensions,
    undefined,
  ) as RouteClient<R, CallOptions>;
}

// ============================================================================
// createClient — public API (Node convenience wrapper)
// ============================================================================

/**
 * Build a runtime HTTP client from a `Node` tree. Internally projects `n`
 * via `httpProjection` (the standard `naiveTransform` +
 * `applyMethods`/`applyMoveTo`/`applyResponse` pipeline — the same one
 * `createFetch`/`httpRoutes` use) and also walks the raw `Node` tree once to
 * build a handler → own-key name map, so co-located operations keep their
 * authored member names.
 *
 * The returned object mirrors the route tree structure:
 *   - branch children → nested client objects
 *   - a `fallback` → a function `(slug: string) => sub-client` keyed by
 *     `fallback.name`
 *   - a route position with a single method and no children/fallback → an
 *     async callable `(input?) => Promise<unknown>`
 *   - a route position with multiple co-located methods and/or children → an
 *     object whose method entries are named callables
 *
 * The return type is `TypedClient<N, CallOptions>` (see
 * @rhi-zone/fractal-api-tree's typed-client.ts): computed structurally from
 * `n`'s own type, so `client.books.bookId(id).read()` is typed all the way
 * down to the handler's real input/output — no `AnyClient`/`any` at the call
 * site. Only the return type carries this precision; the runtime proxy
 * (`buildClientNode`) is built dynamically and does not depend on it.
 *
 * @param n - The root node to project.
 * @param opts - Optional: baseUrl (default ""), fetch (default global fetch).
 */
export function createClient<N extends Node>(
  n: N,
  opts: ClientOptions = {},
): TypedClient<N, CallOptions> {
  const route = httpProjection(n);
  const handlerNames = buildHandlerNames(n);
  const codegenNames = buildCodegenNames(n);
  const baseUrl = opts.baseUrl ?? "";
  const fetchImpl = composeFetch(opts.fetch ?? globalThis.fetch.bind(globalThis), opts.extensions);
  return buildClientNode(
    route,
    "",
    new Set(),
    baseUrl,
    fetchImpl,
    handlerNames,
    opts.timeout,
    opts.signal,
    opts.extensions,
    codegenNames,
  ) as TypedClient<N, CallOptions>;
}
