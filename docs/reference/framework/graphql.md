# GraphQL

`@rhi-zone/fractal-graphql-api-projector` projects a `Node` tree into a GraphQL surface — SDL, resolver dispatch, subscriptions, and a typed client — deriving query/mutation naming and argument shapes from the tree's own structure and tags.

## What it does

`projectGraphQL` walks the tree once: `readOnly`-tagged leaves (and read-like naming) become `Query` fields, everything else becomes `Mutation` fields; nested branches become namespace object types (camelCase-joined field names); a `fallback` becomes an argument on every field beneath it. Field-level type SDL is delegated to type-ir's `toGraphQL`/`toGraphQLType` (see [Type-IR: wire formats](../type-ir/wire-formats.md)) rather than re-implemented here. `toSDL`/`toSchema` render the assembled result to SDL text or an executable `graphql-js` schema.

## Basic usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { toSDL, createHttpGraphQLServer } from "@rhi-zone/fractal-graphql-api-projector"

const tree = api({
  books: api({
    get: op((input: { id: string }) => ({ id: input.id, title: "Dune" }), { tags: { readOnly: true } }),
    add: op((input: { title: string }) => ({ id: "2", title: input.title })),
  }),
})

console.log(toSDL(tree))
// type Query { books: BooksQuery }
// type BooksQuery { get(id: String!): Book }
// type Mutation { booksAdd(title: String!): Book }

const handler = createHttpGraphQLServer(tree, { path: "/graphql" })
// (req: Request) => Promise<Response> — POST {query, variables?} or GET ?query=...
```

## Resolver map (bring your own server)

```ts
import { createResolver } from "@rhi-zone/fractal-graphql-api-projector"

const resolvers = createResolver(tree) // dispatches onto the tree's own handlers
```

## Typed client

```ts
import { createGraphQLClient } from "@rhi-zone/fractal-graphql-api-projector"

const client = createGraphQLClient(tree, { transport })
await client.books.get({ id: "1" })
```

Builds the query document (`buildDocument`) and selection set from the same field/type projection the server uses, so client and server never drift.

## Subscriptions & codegen

```ts
import { createWsHandler, handleBunWebSocket } from "@rhi-zone/fractal-graphql-api-projector/ws" // stream leaves as GraphQL subscriptions
import { generateGraphQLClient } from "@rhi-zone/fractal-graphql-api-projector"                    // emit a standalone typed client module
```

## Key exports

| Export | Description |
|---|---|
| `projectGraphQL(node, opts?)` | Core walk — `Node` → `ProjectGraphQLResult` (fields, dispatch, named types) |
| `toSDL(node, opts?)` / `toSchema(projection)` | SDL text / executable `graphql-js` schema |
| `createResolver(tree, opts?)` | Resolver map dispatching onto tree handlers |
| `createGraphQLServer(tree, opts?)` / `createHttpGraphQLServer(tree, opts?)` | Server object / fetch-compatible HTTP handler |
| `createWsHandler`/`handleBunWebSocket` | Subscription transport wiring |
| `createGraphQLClient(tree, opts?)` | Typed client over a supplied `GraphQLTransport` |
| `generateGraphQLClient(tree, opts?)` | Codegen a standalone client module |
| `graphqlErrors(mapping)` | Error-to-GraphQL-error mapping |
