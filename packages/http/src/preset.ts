// packages/http/src/preset.ts — @rhi-zone/fractal-http
//
// OOTB preset: composes the full HTTP stack into a ready-to-use fetch handler.
//
// Pipeline (in order, each independently droppable):
//   1. httpProjection   — Node => HttpRoute (naiveTransform + applyMethods +
//                          applyMoveTo + applyResponse, see dx.ts).
//                          `directives: false` drops the directive rewriters,
//                          leaving the naive-transform baseline (every
//                          handler POST at its own path-segment key).
//   2. validators        — createApplyValidation(opts.validators), applied
//                          once per outer key in the map (opt-in).
//   3. fusePipeline       — compose each transform array down to one entry
//                          (route.ts). Free perf, on by default.
//   4. skipEmptyInput     — no-op decode/validate for 0-param handlers
//                          (route.ts). Free perf, on by default.
//   5. rewriters          — user-supplied HttpRoute => HttpRoute passes,
//                          applied last, right before router compilation.
//   6. router             — HttpRoute => CompiledRouter. Defaults to
//                          `makeRouterFromRoute` (zero build cost). Swap in
//                          `radixRouter` / `compiledCharRouter` /
//                          `mapCharRouter` (compile.ts) — or any function of
//                          that shape — for faster dispatch at a build-time
//                          cost. Deliberately a function, not a string enum:
//                          the built-ins are just values of this same type.
//   7. als                — withALS (compile.ts), wraps the compiled router
//                          so every request runs inside its own
//                          AsyncLocalStorage context. Opt-in.
//   8. autoMethodLayer    — HEAD-from-GET, OPTIONS→204+Allow, 405+Allow.
//
// Optional (opt-in, off by default):
//   9. corsLayer          — CORS preflight + origin headers.
//
// To drop the auto-method layer and use core routing only:
//   return makeRouterFromRoute(httpProjection(node))
//
// To compose manually with CORS:
//   const routes  = httpProjection(node)
//   const router  = makeRouterFromRoute(routes)
//   const methods = autoMethodLayer(router, routes)
//   return corsLayer({ origin: "https://app.example.com" })(methods)

import type { AsyncLocalStorage } from "node:async_hooks"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import {
  createApplyValidation,
  fusePipeline as fusePipelineRewriter,
  makeRouterFromRoute,
  skipEmptyInput as skipEmptyInputRewriter,
} from "./route.ts"
import type { HttpRoute, ValidatorMap } from "./route.ts"
import { httpProjection } from "./dx.ts"
import type { HttpProjectionOptions } from "./dx.ts"
import { withALS } from "./compile.ts"
import type { CompiledRouter } from "./compile.ts"
import { autoMethodLayer, corsLayer } from "./layers.ts"
import type { CorsOptions } from "./layers.ts"

export type { CorsOptions }

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
   * Generated validators to wire into the route tree via
   * `createApplyValidation`. Each outer key of the map is applied once, in
   * `Object.keys` order — same semantics as calling
   * `createApplyValidation(validators)(key, route)` for every key by hand.
   * Absent by default (no-op).
   */
  readonly validators?: ValidatorMap
  /**
   * Compose each transform array (reqTransforms/inputTransforms/
   * outputTransforms/resTransforms/validate) down to at most one entry per
   * method (route.ts's `fusePipeline`). Free perf — behaviorally identical
   * to the unfused pipeline. Default `true`.
   */
  readonly fusePipeline?: boolean
  /**
   * Skip decode/validate for handlers that take zero parameters (route.ts's
   * `skipEmptyInput`). Free perf. Default `true`.
   */
  readonly skipEmptyInput?: boolean
  /**
   * Additional `HttpRoute => HttpRoute` passes, applied in array order,
   * after `validators`/`fusePipeline`/`skipEmptyInput` and before router
   * compilation.
   */
  readonly rewriters?: ReadonlyArray<(route: HttpRoute) => HttpRoute>
  /**
   * `HttpRoute => CompiledRouter` compiler. Default `makeRouterFromRoute`
   * (route.ts) — zero build cost, tree-walk dispatch. Swap in `radixRouter`,
   * `compiledCharRouter`, or `mapCharRouter` (compile.ts) for faster
   * dispatch at a build-time cost, or supply your own — this is a plain
   * function value, not a string enum, so any conforming compiler works.
   */
  readonly router?: (route: HttpRoute) => CompiledRouter
  /**
   * Wrap the compiled router so every request runs inside its own
   * `AsyncLocalStorage` context (compile.ts's `withALS`). `init` computes
   * the per-request context value from the incoming `Request`. Applied
   * before `autoMethodLayer`, so HEAD-as-GET and OPTIONS/405 short-circuits
   * that still call through to the router also run inside the context.
   * Absent by default (no ALS wrapping).
   */
  readonly als?: {
    readonly storage: AsyncLocalStorage<T>
    readonly init: (req: Request) => T
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
  const projectionOpts: HttpProjectionOptions =
    opts.projection?.transforms !== undefined
      ? opts.projection
      : opts.directives === false
        ? { transforms: [] }
        : (opts.projection ?? {})

  let routes = httpProjection(node, projectionOpts)

  if (opts.validators !== undefined) {
    const applyValidation = createApplyValidation(opts.validators)
    for (const key of Object.keys(opts.validators)) {
      routes = applyValidation(key, routes)
    }
  }

  if (opts.fusePipeline !== false) routes = fusePipelineRewriter(routes)
  if (opts.skipEmptyInput !== false) routes = skipEmptyInputRewriter(routes)

  for (const rewrite of opts.rewriters ?? []) routes = rewrite(routes)

  const compileRouter = opts.router ?? makeRouterFromRoute
  const router = compileRouter(routes)

  const withContext =
    opts.als !== undefined ? withALS(router, opts.als.storage, opts.als.init) : router

  const withMethods = autoMethodLayer(withContext, routes)

  if (opts.cors !== undefined && opts.cors !== false) {
    const corsOpts: CorsOptions = typeof opts.cors === "boolean" ? {} : opts.cors
    return corsLayer(corsOpts)(withMethods)
  }

  return withMethods
}
