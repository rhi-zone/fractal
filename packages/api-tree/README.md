# @rhi-zone/fractal-api-tree

Function-core model: the base function category, a `Result` type, derived
combinators, and the `Node`/`Op`/`Meta` tree that every projection walks.

## What it does

Provides the protocol-neutral core that the rest of the fractal packages
build on: plain-function composition (`compose`/`pipe`), a `Result<T, E>`
fallible-value type with `map`/`bind`/`match`, Kleisli/applicative
combinators derived from those primitives, and the `Node`/`op`/`api` tree
model used to author an API once and project it to HTTP, MCP, CLI, OpenAPI,
and a typed client. A tag lattice (`./tags`) lets metadata declare
subtyping relationships (e.g. `idempotent` implies nothing destructive).

## Key exports

- `Fn<A, B>`, `compose`, `pipe` — the function category
- `Result<T, E>`, `ok`, `err`, `isOk`, `isErr`, `map`, `bind`, `match` — the fallible-value type
- `composeK`, `collect` — Kleisli composition and applicative record combinators
- `api`, `op` (re-exported from `./node`) — tree constructors
- `./node` — `Node`, `Handler`, `Meta`, `isLeaf`, `service`, `mergeMeta`
- `./tags` — tag lattice / `resolveTags`
- `./tree` — `extractToolSchemas`, `extractRouteTypeRefs`, `extractToolTypeRefs`, `hasTreeExport`, `SchemaMap`, `TypeRefMap` — whole-tree walkers over an authored `api()`/`op()` tree at the SOURCE level (via the TypeScript compiler), producing per-leaf input/output schemas; `hasTreeExport` answers just "does this file export a tree at all" (used by `./discover`'s `findEntryFiles`)
- `./extract` — `createExtractorProgram`, `typeRefFromType`, `typeRefFromFunctionNode`, `typeRefFromReturnType`, `schemaFromType`, `schemaFromFunctionNode`, `schemaFromReturnType`, `extractJsDoc` — the lower-level TS-source → `TypeRef`/`JsonSchema` extractor `./tree` is built on
- `fractal-api-tree` CLI (`./cli.ts`, `build`/`watch`/`check` subcommands) — orchestrates `./tree`'s extraction into a standalone validator module via `@rhi-zone/fractal-type-ir`'s `compileValidatorModule` (`./build.ts`)
- `./build` — `buildValidatorModuleSource`, `writeValidatorModule`, `wrapValidators`, `isValidatorWrapped`, `UnvalidatedLeafError`, `GeneratedEntry` — the build orchestrator backing the CLI above: wires `./extract`/`./tree`'s extraction to `@rhi-zone/fractal-type-ir`'s AOT validator compiler, and `wrapValidators` wires the resulting generated validators directly onto a `Node` tree's leaf handlers (the single mechanism shared by HTTP/MCP/CLI's `validators` options) — LOUD: every leaf must be covered by a generated entry or tagged `meta.tags.unvalidated`, else it throws `UnvalidatedLeafError`
- `./discover` — `findEntryFiles`, `PathMatcher`, `FindEntryFilesOptions` — autodetect a deployment's `api()`/`op()` tree entry files by directory scan + `hasTreeExport` (`./tree`), instead of hand-maintaining a per-consumer entry-file list
- `./context` — `createContext`, `AlsConfig`, `ContextBuilder`, `CliContextShape`, `McpContextShape`, `GraphQLContextShape` — one shared `AsyncLocalStorage<T>` plus per-projector `{ storage, init }` config objects that plug into each projector's `als` option, so a consumer authors one context type + one extractor per surface instead of wiring a separate `AsyncLocalStorage` per projector by hand
- `./otel` — `wrapTracing`, `parseTraceParent`, `formatTraceParent`, `runServerSpan`, `runClientSpan`, `getActiveSpan`, `TracingIntegration`, `OtelTracer`, `OtelSpan`, `OtelSpanContext`, `OtelSpanStatusCode`, `OtelSpanKind` — dependency-free, OpenTelemetry-*compatible* tracing: structural mirrors of the `@opentelemetry/api` interfaces the framework's tracing wiring calls (so a real `@opentelemetry/api` `Tracer` — or a hand-written stand-in — plugs in with no adapter), W3C `traceparent` parse/format, and `wrapTracing` to wire a span around every leaf handler's invocation (the same tree-wrap mechanism `./build`'s `wrapValidators` uses). HTTP-specific request/response instrumentation lives in `http-api-projector`, built on top of these exports.
- `./auth` — `AuthAdapter`, `authLayer`, `authMiddleware`, `AuthClientAdapter`, `authExtension` — the stable auth adapter contract a provider package (e.g. `@rhi-zone/fractal-auth-oidc`) implements and every projector consumes the same way: `AuthAdapter` (server-side `resolve`/`guard`, wired into ALS via `authLayer`/`authMiddleware`) and `AuthClientAdapter` (client-side token lifecycle, wired into the HTTP client via `authExtension`)

`./tree` and `./extract` pull in the TypeScript compiler and are separate
subpaths from the package root so runtime consumers of the base `Node`/
`Result` model don't pay for it.

## Usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { ok, bind, pipe } from "@rhi-zone/fractal-api-tree"

const tree = api({
  greet: op((input: { name: string }) => `Hello, ${input.name}`),
})

const double = (n: number) => n * 2
const inc = (n: number) => n + 1
pipe(3, double, inc) // 7
```

## Install

```bash
bun add @rhi-zone/fractal-api-tree
```

See the [root README](../../README.md) for the full picture across all projections.
