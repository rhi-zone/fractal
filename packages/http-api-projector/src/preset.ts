// packages/http-api-projector/src/preset.ts — @rhi-zone/fractal-http-api-projector
//
// OOTB preset: composes the full HTTP stack into a ready-to-use fetch handler.
//
// Stages (in order, each independently droppable):
//   1. httpProjection     — Node => HttpRoute (naiveTransform + applyMethods +
//                          applyMoveTo + applyResponse, see dx.ts).
//                          `directives: false` drops the directive rewriters,
//                          leaving the naive-transform baseline (every
//                          handler POST at its own path-segment key).
//   2. rewriters          — user-supplied HttpRoute => HttpRoute passes,
//                          applied last, right before router compilation.
//                          This is also where generated validation wires in
//                          (see below) — no dedicated preset option for it.
//   3. router             — HttpRoute => CompiledRouter. Defaults to
//                          `mapCharRouter` (compile.ts) — static routes in a
//                          prebuilt Map, dynamic routes through a compiled
//                          char-matcher function; best build cost among the
//                          compiled routers with near-best dispatch (see
//                          bench-results/). Swap in `makeRouterFromRoute`
//                          (route.ts, zero build cost, tree-walk dispatch),
//                          `radixRouter`, `compiledCharRouter` — or any
//                          function of that shape. Deliberately a function,
//                          not a string enum: the built-ins are just values
//                          of this same type.
//   4. als                — withALS (compile.ts), wraps the compiled router
//                          so every request runs inside its own
//                          AsyncLocalStorage context. Opt-in.
//   5. autoMethodLayer    — HEAD-from-GET, OPTIONS→204+Allow, 405+Allow.
//
// Optional (opt-in, off by default):
//   6. corsLayer          — CORS preflight + origin headers.
//
// Validation — `applyValidation(key, projectedTree, protocol?)`
// (@rhi-zone/fractal-api-tree/apply-validation) is not a dedicated preset
// option: `applyValidation`'s call site must live in the consumer's own
// entry file for codegen to anchor on it (see that module's doc comment) —
// `createFetch` itself can never own the call, since it would then be the
// one calling `applyValidation`, not the user's file. Wire it in via
// `rewriters`, applied to the already-projected `HttpRoute`. The
// recommended form is the 3-arg, wire-profile-driven one (docs/design/
// wire-profiles-and-staged-validation.md):
//
//   import { applyValidation } from "./generated/apply-validation.ts"
//   const fetch = createFetch(node, {
//     rewriters: [(routes) => applyValidation("books", routes, "http")],
//   })
//
// The `"http"` protocol argument buys per-field, wire-shaped decode ahead of
// constraint checking: a query/path/header field coerces from its raw
// string per HTTP's `queryProfile` rules (numeric-string, strict
// `"true"`/`"false"`-string, ISO-date-string), a JSON-body field coerces
// only its `Date` fields from ISO strings, and everything else in the body
// arrives already typed with no coercion. Without it — the 2-arg
// `applyValidation("books", routes)` form — validation still runs (codegen
// treats an omitted protocol as sugar for `"identity"`, phase D's decision
// A), but strictly: `identityProfile` is "already the right shape, no
// coercion" (the same posture `check`/`errors`/`parse` assume for an
// in-process, already-typed value), so a query numeric string like `"3"`
// against an HTTP tree wired with the 2-arg form is an encoding error, not a
// silent coercion. This is deliberately different from a protocol-blind
// universal coercion, which would coerce any numeric-looking string
// regardless of whether it plausibly came off a wire — an HTTP tree that
// needs wire-shaped coercion must use the 3-arg form instead.
//
// A rejected leaf's generated `parse()`/wire decoder returns `Result.err(...)`,
// which `runRoute` (route.ts) already encodes as a 400 with the structured
// errors — the same Result-unwrap path a plain handler's own `Result.err`
// return takes, not a special case. This is the sole validation integration
// point — `createFetch` has no dedicated `validators` option — see
// docs/design/routing-and-transforms.md's "Dispatch is not an interceptable
// multi-stage pipeline" section for why validation isn't wired as a
// pre-projection interceptor.
//
// To drop the auto-method layer and use core routing only:
//   return mapCharRouter(httpProjection(node))
//
// To compose manually with CORS:
//   const routes  = httpProjection(node)
//   const router  = mapCharRouter(routes)
//   const methods = autoMethodLayer(router, routes)
//   return corsLayer({ origin: "https://app.example.com" })(methods)

import type { Node } from "@rhi-zone/fractal-api-tree/node";
import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context";
import type { DetectionOptions, ServiceStores } from "@rhi-zone/fractal-api-tree";
import { encodeThrownError } from "./route.ts";
import type {
  HttpErrorEncoder,
  HttpHandlerMiddleware,
  HttpRoute,
  ThrownErrorEncoder,
} from "./route.ts";
import { httpProjection } from "./dx.ts";
import type { HttpProjectionOptions } from "./dx.ts";
import { mapCharRouter, withALS } from "./compile.ts";
import type { CompiledRouter } from "./compile.ts";
import { autoMethodLayer, corsLayer } from "./layers.ts";
import type { CorsOptions, Fetch } from "./layers.ts";
import { toOpenApiFromRoute } from "./openapi.ts";
import type { OpenApiDoc, OpenApiOpts } from "./openapi.ts";

export type { CorsOptions, Fetch };
export type {
  HttpErrorEncoder,
  HttpErrorResponse,
  HttpHandlerMiddleware,
  ThrownErrorEncoder,
} from "./route.ts";
export { httpErrors } from "./route.ts";
export type { DetectionOptions } from "@rhi-zone/fractal-api-tree";

/** `PresetOptions.openapi` object form — `OpenApiOpts` plus the mount path. */
export type OpenApiPresetOptions = OpenApiOpts & {
  /** URL path to serve the generated document at. Defaults to `/openapi.json`. */
  readonly path?: string;
};

export type PresetOptions<T = unknown> = {
  /**
   * Enable CORS. Pass `true` for permissive defaults (`origin: "*"`) or a
   * `CorsOptions` object to configure origin, credentials, and maxAge.
   * Defaults to off.
   */
  readonly cors?: CorsOptions | boolean;
  /**
   * Override the `Node => HttpRoute` rewriter pipeline (see `httpProjection`
   * in dx.ts). Defaults to `[applyMethods, applyMoveTo, applyResponse]`.
   * Takes precedence over `directives` when `transforms` is set — this is
   * the escape hatch for a fully custom directive pipeline.
   */
  readonly projection?: HttpProjectionOptions;
  /**
   * Apply the directive rewriters (`applyMethods`, `applyMoveTo`,
   * `applyResponse`) that read `meta.http.directives`. Default `true` —
   * without them, `naiveTransform`'s baseline stands (every handler POST at
   * its own path-segment key, no method/placement/response directives
   * honored). Ignored when `opts.projection.transforms` is set.
   */
  readonly directives?: boolean;
  /**
   * Additional `HttpRoute => HttpRoute` passes, applied in array order,
   * after projection and before router compilation.
   */
  readonly rewriters?: ReadonlyArray<(route: HttpRoute) => HttpRoute>;
  /**
   * `HttpRoute => CompiledRouter` compiler. Default `mapCharRouter`
   * (compile.ts) — static routes in a prebuilt `Map`, dynamic routes through
   * a compiled char-matcher function; best build cost among the compiled
   * routers with near-best dispatch (see bench-results/). Swap in
   * `makeRouterFromRoute` (route.ts, zero build cost, tree-walk dispatch),
   * `radixRouter`, `compiledCharRouter`, or supply your own — this is a
   * plain function value, not a string enum, so any conforming compiler
   * works.
   * Every built-in compiler accepts `opts.handlerMiddleware` as its second
   * argument, `opts.detection` as its third, `opts.errorEncoder` as its
   * fourth, `opts.thrownErrorEncoder` as its fifth, and the resolved
   * `serviceStores` value (`opts.serviceStores ?? {}`, see below) as its
   * sixth — `createFetch` always forwards all six, so a custom compiler
   * wanting to support handler middleware, detection config, error encoding,
   * or registered service stores should accept them too.
   */
  readonly router?: (
    route: HttpRoute,
    handlerMiddleware?: readonly HttpHandlerMiddleware[],
    detection?: DetectionOptions,
    errorEncoder?: HttpErrorEncoder,
    thrownErrorEncoder?: ThrownErrorEncoder,
    serviceStores?: ServiceStores,
  ) => CompiledRouter;
  /**
   * Wrap the compiled router so every request runs inside its own
   * `AsyncLocalStorage` context (compile.ts's `withALS`). `init` computes
   * the per-request context value from the incoming `Request` — synchronously
   * or by returning a `Promise` (e.g. a session-cookie DB lookup), which is
   * awaited before the ALS scope is entered. Applied before
   * `autoMethodLayer`, so HEAD-as-GET and OPTIONS/405 short-circuits that
   * still call through to the router also run inside the context. Absent by
   * default (no ALS wrapping).
   */
  readonly als?: AlsConfig<Request, T>;
  /**
   * Consumer-supplied `Fetch => Fetch` layers, applied in array order —
   * the first entry is the outermost wrapper. Composed around the compiled
   * router (and `als` context, when set) but inside `autoMethodLayer` and
   * `corsLayer`: a middleware sees the request after ALS context is
   * established, and its response passes back through `autoMethodLayer`'s
   * HEAD-stripping and `corsLayer`'s header injection. Use this for
   * cross-cutting concerns like audit logging or request-scoped state that
   * want to wrap every dispatched request without reimplementing
   * `createFetch`'s composition chain. Empty/absent by default (no-op).
   *
   * A throw from any entry here is caught by `createFetch` and run through
   * `opts.thrownErrorEncoder` (falling back to the existing 500 default,
   * same as a `handlerMiddleware` throw) — even though this array wraps
   * outside the compiled router entirely, before a route is even matched, so
   * there is no route-level `meta`/path context available to the encoder in
   * that case (only the raw error itself, same as every other
   * `thrownErrorEncoder` call). See `route.ts`'s `encodeThrownError`.
   */
  readonly middleware?: ReadonlyArray<(inner: Fetch) => Fetch>;
  /**
   * Around-hooks wrapping the handler call itself — a separate mechanism
   * from `opts.middleware` above (which wraps the whole `Fetch` request/
   * response cycle, before a route is even matched). `handlerMiddleware` is
   * `F => F` where `F = (input, stores) => result` (see
   * docs/design/middleware-and-caller-context.md). It sits inside `runRoute`
   * (route.ts): after decode, before encode/Result-unwrapping, seeing both
   * the assembled input and the raw pre-assembly stores (`httpStores()`,
   * decode.ts) — the same handler-scoped hook CLI's `CliOpts.middleware` and
   * MCP's `CreateMcpServerOptions.middleware` already provide, now available
   * for HTTP too. The handler itself never receives `stores`. Composes like
   * an onion: the first entry is the outermost wrapper, matching every other
   * middleware convention in this codebase. Threaded through to whichever
   * router compiler `opts.router` resolves to (every built-in compiler in
   * compile.ts accepts it as a second argument). Empty/absent by default
   * (no-op, zero overhead).
   */
  readonly handlerMiddleware?: readonly HttpHandlerMiddleware[];
  /**
   * Opt-in configuration for `runRoute`'s (route.ts) structural sniffing of
   * a handler's return value — `result` gates `Result`-shape
   * (`{kind:"ok"|"err"}`) unwrapping, `streaming` gates `AsyncIterable`
   * detection (and, transitively, `StreamEffect` tag interpretation on its
   * yields). Both default to `true` — existing behavior — when `detection`
   * itself, or either field, is omitted. Disable one when a handler
   * legitimately returns/yields data shaped like one of these DUs and it
   * must not be reinterpreted as the transport protocol (see
   * `docs/design/middleware-and-caller-context.md`'s "Streaming and
   * Progress" section, and `DetectionOptions`'s own doc,
   * `@rhi-zone/fractal-api-tree`). `ResponseOverride` detection is never
   * gated — it's `Symbol`-tagged, structurally collision-proof. Threaded
   * through to whichever router compiler `opts.router` resolves to (every
   * built-in compiler in compile.ts accepts it as a third argument).
   */
  readonly detection?: DetectionOptions;
  /**
   * Maps a handler's `Result.err(E)` error value to an `HttpErrorResponse`
   * (status + optional body/headers) — see `HttpErrorEncoder`/`httpErrors`
   * (route.ts). Called from `runRoute` when `detection.result` is on
   * (default `true`) and a handler returns `{kind:"err", error}`. Returning
   * `undefined` (including when `errorEncoder` itself is omitted) falls back
   * to the existing default: a 400 JSON response wrapping `{ error }`.
   * Compose several encoders with `composeErrorEncoders`
   * (`@rhi-zone/fractal-api-tree`) — first match wins. Threaded through to
   * whichever router compiler `opts.router` resolves to (every built-in
   * compiler in compile.ts accepts it as a fourth argument).
   */
  readonly errorEncoder?: HttpErrorEncoder;
  /**
   * Maps a thrown error (caught in `runRoute`'s catch block, route.ts) to an
   * `HttpErrorResponse` — the parallel hook to `errorEncoder` above, but for
   * consumers who throw for expected errors instead of returning
   * `Result.err`. Same `(error: unknown) => HttpErrorResponse | undefined`
   * shape as `HttpErrorEncoder` (see `ThrownErrorEncoder`, route.ts).
   * Returning `undefined` (including when `thrownErrorEncoder` itself is
   * omitted) falls back to the existing default: a 500 JSON response
   * wrapping `{ error: "internal server error" }`. Threaded through to
   * whichever router compiler `opts.router` resolves to (every built-in
   * compiler in compile.ts accepts it as a fifth argument).
   */
  readonly thrownErrorEncoder?: ThrownErrorEncoder;
  /**
   * Auto-serve a generated OpenAPI 3.1 document — OpenAPI only ever
   * describes HTTP APIs, so `createFetch` mounts it with zero extra setup.
   * `true` (the default) mounts a `GET /openapi.json` handler that derives
   * the spec from the same (fully-rewritten) `HttpRoute` tree the router
   * dispatches against, via `toOpenApiFromRoute`. Pass an
   * `OpenApiPresetOptions` object (`OpenApiOpts` plus `path`) to set
   * `title`/`version`/`schemas`/`sourceFile` or change the mount path, or
   * `false` to disable entirely. The document is built lazily — on the
   * first request to the mount path — and cached for the life of the
   * handler.
   */
  readonly openapi?: boolean | OpenApiPresetOptions;
  /**
   * The deployment's registered service-store values (docs/design/
   * typed-store-spec.md §4) — a deployment-provided, long-lived capability
   * (a tabular-read adapter, a domain read-model, …) declared as a required
   * member on the merged `StoreRegistry` (api-tree's input.ts). `createFetch`
   * threads whatever is supplied here (default `{}`) through to whichever
   * router compiler `opts.router` resolves to (every built-in compiler
   * accepts it as a sixth argument, see `router`'s own doc above), which
   * merges it into the per-request `stores` bag each dispatched request
   * builds (`httpStores`, decode.ts) — fulfilling the threading that
   * docs/design/typed-store-spec.md §8 left deferred (tracked in TODO.md).
   *
   * Deliberately always optional here, not conditionally required via the
   * `HasRequiredKeys` technique `op()`/`api()` use for meta contributions
   * (node.ts): `StoreRegistry` declaration-merging is global to a
   * compilation, so a conditionally-required field on `PresetOptions` would
   * force every `createFetch` call across a deployment's entire tree of
   * mounted sub-apps to supply it, not just the ones whose handlers actually
   * read it — declaration merging applies process-wide, not per call site or
   * per file. §4's "one registration object... checked once" is instead
   * satisfied by the deployment's own single
   * `const serviceStores: ServiceStores = {...}` assignment at its
   * composition root (the spec's own §4 worked example) — that assignment is
   * what's exhaustively checked against every required member; this field
   * just consumes the already-verified result, and a deployment with several
   * mounted trees passes the same verified value only into the ones that
   * actually need it.
   */
  readonly serviceStores?: ServiceStores;
};

/**
 * Wrap `handler` with a `GET <path>` short-circuit that serves a lazily-
 * built, cached OpenAPI 3.1 document derived from `routes` — see
 * `PresetOptions.openapi`.
 */
function withOpenApi(
  handler: CompiledRouter,
  routes: HttpRoute,
  opts: boolean | OpenApiPresetOptions | undefined,
): CompiledRouter {
  if (opts === false) return handler;

  const { path = "/openapi.json", ...openApiOpts }: OpenApiPresetOptions =
    opts === true || opts === undefined ? {} : opts;

  let specPromise: Promise<OpenApiDoc> | undefined;

  return async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === path) {
      specPromise ??= toOpenApiFromRoute(routes, openApiOpts);
      const spec = await specPromise;
      return new Response(JSON.stringify(spec), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handler(req);
  };
}

/**
 * Build an OOTB fetch handler from a Node tree.
 *
 * The returned handler is a WHATWG `fetch`-compatible function suitable
 * for `Bun.serve`, `Deno.serve`, a Cloudflare Worker, or any runtime that
 * accepts `(req: Request) => Promise<Response>` — the same shape as
 * `CompiledRouter` (compile.ts).
 */
export function createFetch<T = unknown>(node: Node, opts: PresetOptions<T> = {}): CompiledRouter {
  const projectionOpts: HttpProjectionOptions =
    opts.projection?.transforms !== undefined
      ? opts.projection
      : opts.directives === false
        ? { transforms: [] }
        : (opts.projection ?? {});

  let routes = httpProjection(node, projectionOpts);

  for (const rewrite of opts.rewriters ?? []) routes = rewrite(routes);

  const compileRouter = opts.router ?? mapCharRouter;
  const router = compileRouter(
    routes,
    opts.handlerMiddleware,
    opts.detection,
    opts.errorEncoder,
    opts.thrownErrorEncoder,
    opts.serviceStores ?? ({} as ServiceStores),
  );

  const withContext =
    opts.als !== undefined ? withALS(router, opts.als.storage, opts.als.init) : router;

  // Consumer middleware wraps between the router (+ ALS context) and the
  // built-in protocol layers below — inside autoMethodLayer/corsLayer, so it
  // sees every request after protocol handling but before the raw router
  // dispatch. First entry in the array is the outermost wrapper.
  //
  // This wraps outside `withContext` (the compiled router), which is itself
  // outside `runRoute`'s own try/catch (route.ts) — so a throw from one of
  // these entries is the one remaining pre-decode throw source this package
  // can observe (`toRouter`, compile.ts, already catches a subtree
  // `http.middleware()` throw the same way). Caught here and encoded via
  // `encodeThrownError`, for maximal consistency with every other error
  // path — a middleware throw now produces the same encoded-response shape
  // as a handler/handlerMiddleware throw, instead of propagating as an
  // uncaught exception out of the returned `Fetch`.
  const rawMiddleware = (opts.middleware ?? []).reduceRight<CompiledRouter>(
    (inner, mw) => mw(inner),
    withContext,
  );
  const withMiddleware: CompiledRouter = async (req) => {
    try {
      return await rawMiddleware(req);
    } catch (error) {
      return encodeThrownError(error, opts.thrownErrorEncoder);
    }
  };

  const withMethods = autoMethodLayer(withMiddleware, routes);

  const withOpenApiDoc = withOpenApi(withMethods, routes, opts.openapi);

  if (opts.cors !== undefined && opts.cors !== false) {
    const corsOpts: CorsOptions = typeof opts.cors === "boolean" ? {} : opts.cors;
    return corsLayer(corsOpts)(withOpenApiDoc);
  }

  return withOpenApiDoc;
}

/**
 * The exact global-`fetch` call signature — `(input: RequestInfo | URL,
 * init?: RequestInit) => Promise<Response>` — as opposed to `CompiledRouter`
 * (compile.ts) / `Fetch` (layers.ts), which are `(req: Request) =>
 * Promise<Response>`: the narrower shape every internal layer in this
 * package (`corsLayer`, `autoMethodLayer`, `withALS`, consumer
 * `middleware`, ...) composes over. `createFetch`'s return is a
 * `CompiledRouter`, not this — it's a `fetch`-compatible *handler* (same
 * shape as `Bun.serve`/`Deno.serve`/a Cloudflare Worker's `fetch` export),
 * not a drop-in for code that calls `fetch(url, init)` the way a browser or
 * `RequestInit`-typed client does. `toDropInFetch` below bridges the two.
 */
export type DropInFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Adapt a `CompiledRouter` (e.g. `createFetch`'s return) to `DropInFetch` —
 * the literal global-`fetch` signature — so it's usable anywhere code is
 * typed against `typeof fetch` and calls it with a URL string/`URL` plus an
 * optional `RequestInit`, rather than constructing a `Request` itself (a
 * Postman-like playground, a doc-embedded live demo, a test harness that
 * swaps in a mocked `fetch` global). Still runs the real handler tree
 * in-process, same as `createFetch` itself — no socket, no fabricated data.
 *
 * Deliberately a separate function rather than widening `createFetch`'s own
 * return type: `CompiledRouter` is the composition contract every layer in
 * this file and compile.ts is built on (see `DropInFetch`'s doc above), and
 * every existing caller in this package's own tests/README already calls
 * `createFetch`'s result with a single `Request` — widening it would ripple
 * through that whole internal stack for a need only the drop-in boundary
 * actually has.
 *
 * `input` given as a relative string/URL (no scheme/host — the common case
 * for a playground calling e.g. `fetch("/users/list")`) is resolved against
 * `baseUrl` before being handed to `router`, since `Request` (unlike
 * browser `fetch`) has no ambient document origin to resolve against and
 * throws on a bare relative string. Default `baseUrl` is `http://localhost`
 * — these requests never hit a real socket, so any placeholder origin
 * works; override it if a caller's routes or handlers inspect the request
 * URL's origin.
 */
export function toDropInFetch(router: CompiledRouter, baseUrl = "http://localhost"): DropInFetch {
  return async (input, init) => {
    const resolved =
      input instanceof Request
        ? input
        : new URL(input instanceof URL ? input.href : input, baseUrl);
    return router(new Request(resolved, init));
  };
}
