// packages/http-api-projector/src/preset.ts — @rhi-zone/fractal-http-api-projector
//
// OOTB preset: composes the full HTTP stack into a ready-to-use fetch handler.
//
// Stages (in order, each independently droppable):
//   1. validators         — wrapValidators(node, opts.validators)
//                          (@rhi-zone/fractal-api-tree/build), applied to the
//                          `Node` tree BEFORE projection (opt-in). Same
//                          mechanism `createMcpServer`/`runCli` use — a leaf
//                          with a matching generated entry gets its handler
//                          wrapped to run the generated `parse()` first;
//                          leaves with no matching entry pass through
//                          untouched.
//   2. httpProjection     — Node => HttpRoute (naiveTransform + applyMethods +
//                          applyMoveTo + applyResponse, see dx.ts).
//                          `directives: false` drops the directive rewriters,
//                          leaving the naive-transform baseline (every
//                          handler POST at its own path-segment key).
//   3. rewriters          — user-supplied HttpRoute => HttpRoute passes,
//                          applied last, right before router compilation.
//   4. router             — HttpRoute => CompiledRouter. Defaults to
//                          `makeRouterFromRoute` (zero build cost). Swap in
//                          `radixRouter` / `compiledCharRouter` /
//                          `mapCharRouter` (compile.ts) — or any function of
//                          that shape — for faster dispatch at a build-time
//                          cost. Deliberately a function, not a string enum:
//                          the built-ins are just values of this same type.
//   5. als                — withALS (compile.ts), wraps the compiled router
//                          so every request runs inside its own
//                          AsyncLocalStorage context. Opt-in.
//   6. autoMethodLayer    — HEAD-from-GET, OPTIONS→204+Allow, 405+Allow.
//
// Optional (opt-in, off by default):
//   7. corsLayer          — CORS preflight + origin headers.
//
// To drop the auto-method layer and use core routing only:
//   return makeRouterFromRoute(httpProjection(node))
//
// To compose manually with CORS:
//   const routes  = httpProjection(node)
//   const router  = makeRouterFromRoute(routes)
//   const methods = autoMethodLayer(router, routes)
//   return corsLayer({ origin: "https://app.example.com" })(methods)

import type { Node } from "@rhi-zone/fractal-api-tree/node"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import { wrapValidators } from "@rhi-zone/fractal-api-tree/build"
import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context"
import type { DetectionOptions } from "@rhi-zone/fractal-api-tree"
import { makeRouterFromRoute } from "./route.ts"
import type { HttpErrorEncoder, HttpHandlerMiddleware, HttpRoute, ThrownErrorEncoder } from "./route.ts"
import { httpProjection } from "./dx.ts"
import type { HttpProjectionOptions } from "./dx.ts"
import { withALS } from "./compile.ts"
import type { CompiledRouter } from "./compile.ts"
import { autoMethodLayer, corsLayer } from "./layers.ts"
import type { CorsOptions, Fetch } from "./layers.ts"
import { toOpenApiFromRoute } from "./openapi.ts"
import type { OpenApiDoc, OpenApiOpts } from "./openapi.ts"

export type { CorsOptions, Fetch }
export type { HttpErrorEncoder, HttpErrorResponse, HttpHandlerMiddleware, ThrownErrorEncoder } from "./route.ts"
export { httpErrors } from "./route.ts"
export type { DetectionOptions } from "@rhi-zone/fractal-api-tree"

/** `PresetOptions.openapi` object form — `OpenApiOpts` plus the mount path. */
export type OpenApiPresetOptions = OpenApiOpts & {
  /** URL path to serve the generated document at. Defaults to `/openapi.json`. */
  readonly path?: string
}

export type PresetOptions<T = unknown> = {
  /**
   * Enable CORS. Pass `true` for permissive defaults (`origin: "*"`) or a
   * `CorsOptions` object to configure origin, credentials, and maxAge.
   * Defaults to off.
   */
  readonly cors?: CorsOptions | boolean
  /**
   * Override the `Node => HttpRoute` rewriter pipeline (see `httpProjection`
   * in dx.ts). Defaults to `[applyMethods, applyMoveTo, applyResponse]`.
   * Takes precedence over `directives` when `transforms` is set — this is
   * the escape hatch for a fully custom directive pipeline.
   */
  readonly projection?: HttpProjectionOptions
  /**
   * Apply the directive rewriters (`applyMethods`, `applyMoveTo`,
   * `applyResponse`) that read `meta.http.directives`. Default `true` —
   * without them, `naiveTransform`'s baseline stands (every handler POST at
   * its own path-segment key, no method/placement/response directives
   * honored). Ignored when `opts.projection.transforms` is set.
   */
  readonly directives?: boolean
  /**
   * Generated validators (from `buildValidatorModuleSource` /
   * `compileValidatorModule`, keyed by `"/"`-joined route path — see
   * `wrapValidators` in `@rhi-zone/fractal-api-tree/build`). When provided,
   * `node` is wrapped via `wrapValidators` BEFORE `httpProjection` runs: any
   * leaf with a matching entry has its handler run through the generated
   * `parse()` (coercion + validation in one pass) before the original
   * handler ever sees the input. Leaves with no matching entry (or when this
   * option is omitted entirely) keep their original handler untouched. Same
   * mechanism `createMcpServer`'s and `runCli`'s `opts.validators` use, so a
   * single generated module wires validation into HTTP, MCP, and CLI alike.
   */
  readonly validators?: Readonly<Record<string, GeneratedEntry>>
  /**
   * Additional `HttpRoute => HttpRoute` passes, applied in array order,
   * after projection and before router compilation.
   */
  readonly rewriters?: ReadonlyArray<(route: HttpRoute) => HttpRoute>
  /**
   * `HttpRoute => CompiledRouter` compiler. Default `makeRouterFromRoute`
   * (route.ts) — zero build cost, tree-walk dispatch. Swap in `radixRouter`,
   * `compiledCharRouter`, or `mapCharRouter` (compile.ts) for faster
   * dispatch at a build-time cost, or supply your own — this is a plain
   * function value, not a string enum, so any conforming compiler works.
   * Every built-in compiler accepts `opts.handlerMiddleware` as its second
   * argument, `opts.detection` as its third, `opts.errorEncoder` as its
   * fourth, and `opts.thrownErrorEncoder` as its fifth (see below) —
   * `createFetch` always forwards all four, so a custom compiler wanting to
   * support handler middleware, detection config, or error encoding should
   * accept them too.
   */
  readonly router?: (
    route: HttpRoute,
    handlerMiddleware?: readonly HttpHandlerMiddleware[],
    detection?: DetectionOptions,
    errorEncoder?: HttpErrorEncoder,
    thrownErrorEncoder?: ThrownErrorEncoder,
  ) => CompiledRouter
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
  readonly als?: AlsConfig<Request, T>
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
   */
  readonly middleware?: ReadonlyArray<(inner: Fetch) => Fetch>
  /**
   * Around-hooks wrapping the HANDLER call itself — a separate mechanism
   * from `opts.middleware` above (which wraps the whole `Fetch` request/
   * response cycle, before a route is even matched). `handlerMiddleware` is
   * `F => F` where `F = (input, stores) => result` (see
   * docs/design/middleware-and-caller-context.md). It sits INSIDE `runRoute`
   * (route.ts): after decode, before encode/Result-unwrapping, seeing both
   * the assembled input and the raw pre-assembly stores (`httpStores()`,
   * decode.ts) — the same handler-scoped hook CLI's `CliOpts.middleware` and
   * MCP's `CreateMcpServerOptions.middleware` already provide, now available
   * for HTTP too. The handler itself never receives `stores`. Composes like
   * an onion: the first entry is the OUTERMOST wrapper, matching every other
   * middleware convention in this codebase. Threaded through to whichever
   * router compiler `opts.router` resolves to (every built-in compiler in
   * compile.ts accepts it as a second argument). Empty/absent by default
   * (no-op, zero overhead).
   */
  readonly handlerMiddleware?: readonly HttpHandlerMiddleware[]
  /**
   * Opt-in configuration for `runRoute`'s (route.ts) structural sniffing of
   * a handler's return value — `result` gates `Result`-shape
   * (`{kind:"ok"|"err"}`) unwrapping, `streaming` gates `AsyncIterable`
   * detection (and, transitively, `StreamEffect` tag interpretation on its
   * yields). Both default to `true` — existing behavior — when `detection`
   * itself, or either field, is omitted. Disable one when a handler
   * legitimately returns/yields data shaped like one of these DUs and it
   * must NOT be reinterpreted as the transport protocol (see
   * `docs/design/middleware-and-caller-context.md`'s "Streaming and
   * Progress" section, and `DetectionOptions`'s own doc,
   * `@rhi-zone/fractal-api-tree`). `ResponseOverride` detection is never
   * gated — it's `Symbol`-tagged, structurally collision-proof. Threaded
   * through to whichever router compiler `opts.router` resolves to (every
   * built-in compiler in compile.ts accepts it as a third argument).
   */
  readonly detection?: DetectionOptions
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
  readonly errorEncoder?: HttpErrorEncoder
  /**
   * Maps a THROWN error (caught in `runRoute`'s catch block, route.ts) to an
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
  readonly thrownErrorEncoder?: ThrownErrorEncoder
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
  readonly openapi?: boolean | OpenApiPresetOptions
}

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
  if (opts === false) return handler

  const { path = "/openapi.json", ...openApiOpts }: OpenApiPresetOptions =
    opts === true || opts === undefined ? {} : opts

  let specPromise: Promise<OpenApiDoc> | undefined

  return async (req: Request) => {
    const url = new URL(req.url)
    if (req.method === "GET" && url.pathname === path) {
      specPromise ??= toOpenApiFromRoute(routes, openApiOpts)
      const spec = await specPromise
      return new Response(JSON.stringify(spec), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return handler(req)
  }
}

/**
 * Build an OOTB fetch handler from a Node tree.
 *
 * The returned handler is a WHATWG `fetch`-compatible function suitable
 * for `Bun.serve`, `Deno.serve`, a Cloudflare Worker, or any runtime that
 * accepts `(req: Request) => Promise<Response>` — the same shape as
 * `CompiledRouter` (compile.ts).
 */
export function createFetch<T = unknown>(
  node: Node,
  opts: PresetOptions<T> = {},
): CompiledRouter {
  // Wire generated validators onto the tree BEFORE any projection walk — see
  // `PresetOptions.validators`. Leaves with no matching entry keep their
  // original handler untouched (wrapValidators is a no-op there).
  const workingNode = opts.validators !== undefined ? wrapValidators(node, opts.validators) : node

  const projectionOpts: HttpProjectionOptions =
    opts.projection?.transforms !== undefined
      ? opts.projection
      : opts.directives === false
        ? { transforms: [] }
        : (opts.projection ?? {})

  let routes = httpProjection(workingNode, projectionOpts)

  for (const rewrite of opts.rewriters ?? []) routes = rewrite(routes)

  const compileRouter = opts.router ?? makeRouterFromRoute
  const router = compileRouter(routes, opts.handlerMiddleware, opts.detection, opts.errorEncoder, opts.thrownErrorEncoder)

  const withContext =
    opts.als !== undefined ? withALS(router, opts.als.storage, opts.als.init) : router

  // Consumer middleware wraps between the router (+ ALS context) and the
  // built-in protocol layers below — inside autoMethodLayer/corsLayer, so it
  // sees every request after protocol handling but before the raw router
  // dispatch. First entry in the array is the outermost wrapper.
  const withMiddleware = (opts.middleware ?? []).reduceRight<CompiledRouter>(
    (inner, mw) => mw(inner),
    withContext,
  )

  const withMethods = autoMethodLayer(withMiddleware, routes)

  const withOpenApiDoc = withOpenApi(withMethods, routes, opts.openapi)

  if (opts.cors !== undefined && opts.cors !== false) {
    const corsOpts: CorsOptions = typeof opts.cors === "boolean" ? {} : opts.cors
    return corsLayer(corsOpts)(withOpenApiDoc)
  }

  return withOpenApiDoc
}
