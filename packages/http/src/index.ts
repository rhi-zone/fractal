// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// Package root entry point. Re-exports the DX authoring surface: `http.*`
// method bundles, `HttpMethods`/`Method`, `crud()`, and `httpProjection()`.
// Lower-level pieces (the direct tree-walk projector, the HttpRoute rewriter
// pipeline, layers, the OOTB preset) stay reachable via their own subpath
// exports (`./project`, `./route`, `./layers`, `./preset`, `./verbs`,
// `./adapter`) — this root re-exports only the DX sugar described in
// docs/design/routing-and-transforms.md § DX — constructor sugar.

export { http } from "./verbs.ts"
export type { HttpMethods, Method, VerbBundle } from "./verbs.ts"
export { crud, httpProjection } from "./dx.ts"
export type { CrudHandlers, HttpProjectionOptions } from "./dx.ts"
export { createApplyValidation } from "./route.ts"
export type { Validator, ValidatorMap } from "./route.ts"
export {
  chainMatchers,
  compiledCharMatcher,
  compiledCharRouter,
  mapCharRouter,
  mapMatcher,
  radixMatcher,
  radixRouter,
  toRouter,
} from "./compile.ts"
export type { CompiledRouter, Matcher, RouteMatch } from "./compile.ts"
