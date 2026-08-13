// packages/fractal/src/graphql.ts — @rhi-zone/fractal/graphql
//
// Re-exports `@rhi-zone/fractal-graphql-api-projector`'s root surface.
//
// That package is an optional peer dependency of `@rhi-zone/fractal`: it
// carries `graphql` (graphql-js) as its own runtime dependency, kept out of
// the dependency tree for consumers projecting only to HTTP/CLI/JSON-RPC.
// Importing this subpath without having installed the peer fails at module
// resolution, naming the missing package — see this package's README for the
// install line and `docs/design/decisions.md` § "Umbrella package" for the
// dependency policy.

export * from "@rhi-zone/fractal-graphql-api-projector";
