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
- `./tree` — `extractToolSchemas`, `extractRouteTypeRefs`, `extractToolTypeRefs`, `SchemaMap`, `TypeRefMap` — whole-tree walkers over an authored `api()`/`op()` tree at the SOURCE level (via the TypeScript compiler), producing per-leaf input/output schemas
- `./extract` — `createExtractorProgram`, `typeRefFromType`, `typeRefFromFunctionNode`, `typeRefFromReturnType`, `schemaFromType`, `schemaFromFunctionNode`, `schemaFromReturnType`, `extractJsDoc` — the lower-level TS-source → `TypeRef`/`JsonSchema` extractor `./tree` is built on
- `fractal-api-tree` CLI (`./cli.ts`, `build`/`watch`/`stub`/`check` subcommands) — orchestrates `./tree`'s extraction into a standalone validator module via `@rhi-zone/fractal-type-ir`'s `compileValidatorModule` (`./build.ts`)

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
