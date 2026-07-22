// packages/http-api-projector/src/index.ts — @rhi-zone/fractal-http-api-projector
//
// Package root entry point. Re-exports the DX authoring surface: `http.*`
// method bundles, `HttpMethods`/`Method`, `crud()`, and `httpProjection()`.
// Also re-exports the OpenAPI projection (`toOpenApi`/`toOpenApiFromRoute`)
// and the runtime HTTP client (`createClient`/`createClientFromRoute`,
// `ClientError`) — both are inherently HTTP concerns (see `openapi.ts` and
// `client.ts` module docs) merged into this package rather than kept as
// separate projection packages. Lower-level pieces (the direct tree-walk
// projector, the HttpRoute rewriter pipeline, layers, the OOTB preset) stay
// reachable via their own subpath exports (`./project`, `./route`,
// `./layers`, `./preset`, `./verbs`, `./adapter`, `./openapi`, `./client`) —
// this root re-exports the DX sugar described in
// docs/design/routing-and-transforms.md § DX — constructor sugar, plus the
// two HTTP-derived projections.

export { http, httpVerbBundle } from "./verbs.ts"
export type { HttpMethods, Method, VerbBundle } from "./verbs.ts"
export { crud, httpProjection } from "./dx.ts"
export type { CrudHandlers, HttpProjectionOptions } from "./dx.ts"
export { getHttpMeta } from "./project.ts"
export type { HttpDirective, HttpMeta } from "./project.ts"
export type { HttpManifest } from "./http-manifest.ts"
export { mapRoute } from "./route.ts"
export {
  chainMatchers,
  compiledCharMatcher,
  compiledCharRouter,
  mapCharRouter,
  mapMatcher,
  radixMatcher,
  radixRouter,
  toRouter,
  withALS,
} from "./compile.ts"
export type { CompiledRouter, Matcher, RouteMatch } from "./compile.ts"
export { toOpenApi, toOpenApiFromRoute } from "./openapi.ts"
export type {
  OpenApiDoc,
  OpenApiMeta,
  OpenApiOperation,
  OpenApiOpts,
  OpenApiParameter,
  OpenApiSchema,
} from "./openapi.ts"
export { createClient, createClientFromRoute } from "./client.ts"
export type { AnyClient, ClientOptions } from "./client.ts"
export { ClientError } from "./client-error.ts"
export { composeCodegenFetch, composeDecodeResponse, composeFetch, findStreamingCall } from "./extension.ts"
export type {
  ClientExtension,
  ClientExtensionCodegen,
  DecodeContext,
  DecodedResponse,
  FetchImpl,
  StreamingCallArgs,
} from "./extension.ts"
export { retry } from "./extensions/retry.ts"
export type { RetryOptions } from "./extensions/retry.ts"
export { timeout } from "./extensions/timeout.ts"
export type { TimeoutOptions } from "./extensions/timeout.ts"
export { interceptors } from "./extensions/interceptors.ts"
export type { InterceptorsOptions } from "./extensions/interceptors.ts"
export { DEFAULT_SENSITIVE_HEADERS, logging } from "./extensions/logging.ts"
export type { LogEntry, LoggingOptions, LogLevel } from "./extensions/logging.ts"
export {
  errors,
  BadRequestError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  RateLimitError,
  InternalServerError,
} from "./extensions/errors.ts"
export { pagination } from "./extensions/pagination.ts"
export type { PageIterator, PaginationOptions } from "./extensions/pagination.ts"
export { streaming } from "./extensions/streaming.ts"
export { createFetch, httpErrors } from "./preset.ts"
export type {
  CorsOptions,
  Fetch,
  HttpErrorEncoder,
  HttpErrorResponse,
  HttpHandlerMiddleware,
  PresetOptions,
  ThrownErrorEncoder,
} from "./preset.ts"
