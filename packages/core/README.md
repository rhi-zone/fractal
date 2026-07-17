# @rhi-zone/fractal-core

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

## Usage

```ts
import { api, op } from "@rhi-zone/fractal-core"
import { ok, bind, pipe } from "@rhi-zone/fractal-core"

const tree = api({
  greet: op((input: { name: string }) => `Hello, ${input.name}`),
})

const double = (n: number) => n * 2
const inc = (n: number) => n + 1
pipe(3, double, inc) // 7
```
