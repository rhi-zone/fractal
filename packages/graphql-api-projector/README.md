# @rhi-zone/fractal-graphql-api-projector

GraphQL projection for the function-core tree.

## What it does

Walks an `api()`/`op()` tree and assembles a GraphQL schema: a nested `Query`
type mirroring the tree's shape, plus flat `Mutation`/`Subscription` types
(GraphQL has no nested-mutation convention, so mutation/subscription leaves
are joined by underscore instead). Field types come from
`@rhi-zone/fractal-type-ir`'s `./graphql` projection over each leaf's input/
output `TypeRef`s. `createResolver` builds a `graphql-js`-compatible resolver
map dispatching back onto the tree's handlers; `createGraphQLServer`/
`createHttpGraphQLServer` wire that onto a runnable server, `./ws` adds
subscription support over a WebSocket transport, and `createGraphQLClient`/
`generateGraphQLClient` give a typed client and codegen for one.

## Key exports

- `projectGraphQL(tree, opts?)` — walk a `Node` tree into a `ProjectGraphQLResult` (query/mutation/subscription field maps)
- `toSDL(tree, opts?)`, `toSchema(projection)` — SDL string / `GraphQLSchema` object
- `createResolver(tree, opts?)` (`./resolve`) — resolver map dispatching onto the tree's handlers
- `createGraphQLServer`, `createHttpGraphQLServer` (`./server`, `./presets`) — runnable server wiring
- `createWsHandler`, `handleBunWebSocket` (`./ws`) — subscription transport over WebSocket
- `createGraphQLClient`, `GraphQLClientError` (`./client`) — typed runtime client
- `generateGraphQLClient` (`./codegen`) — generate a typed client module

## Usage

```ts
import { toSDL } from "@rhi-zone/fractal-graphql-api-projector"
import { createHttpGraphQLServer } from "@rhi-zone/fractal-graphql-api-projector/presets"
import { api } from "./tree.ts"

const sdl = toSDL(api)
const server = createHttpGraphQLServer(api)
```

## Install

```bash
bun add @rhi-zone/fractal-graphql-api-projector
```

See the [root README](../../README.md) for the full picture across all projections.
