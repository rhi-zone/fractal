// packages/fractal/src/mcp.ts — @rhi-zone/fractal/mcp
//
// Re-exports `@rhi-zone/fractal-mcp-api-projector`'s root surface.
//
// Optional peer dependency, same policy as `./graphql`: this projector
// carries `@modelcontextprotocol/sdk` as its own runtime dependency, which is
// the single largest install a consumer can avoid by not asking for MCP.

export * from "@rhi-zone/fractal-mcp-api-projector"
