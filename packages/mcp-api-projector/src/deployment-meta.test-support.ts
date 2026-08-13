// packages/mcp-api-projector/src/deployment-meta.test-support.ts
//
// mcp-api-projector has no real deployment of its own (it's a projector
// package), but its own tests author `meta.mcp` contributions — including
// at BRANCH position (`meta.mcp.segment`) — to exercise its projection
// walk against something closer to what a real deployment's tree looks
// like. Per docs/design/meta-role-split-spec.md §2/§3: projectors never
// augment core's SharedMeta/LeafMeta/BranchMeta themselves — only a
// DEPLOYMENT's own file does, exactly once. This file is that one file for
// this package's own test suite — the test-suite's stand-in "deployment."
// Not a `.test.ts` file itself, so bun test skips it; imported for its
// side effect (the `declare module` augmentation) by tests that need it.

import "@rhi-zone/fractal-api-tree/node";
import type { McpBranchMeta, McpLeafMeta } from "./project.ts";

declare module "@rhi-zone/fractal-api-tree/node" {
  interface LeafMeta extends McpLeafMeta {}
  interface BranchMeta extends McpBranchMeta {}
}
