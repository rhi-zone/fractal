// packages/api-tree/src/__fixtures__/deployment-meta.fixture.ts
//
// api-tree has no real deployment of its own (it's the core package), but
// several of its own tests/fixtures author `meta.mcp`/`meta.http`/etc.
// contributions to exercise the role-split machinery (op()/api()'s
// HasRequiredKeys-driven arity, tree.ts's mcpMetaOverride walk, …) against
// something closer to what a real deployment's tree looks like. Per
// docs/design/meta-role-split-spec.md §2/§3: projectors never augment
// core's SharedMeta/LeafMeta/BranchMeta themselves — only a DEPLOYMENT's
// own file does, exactly once. This file is that one file for api-tree's
// own test suite — the test-suite's stand-in "deployment."
//
// No requiredness is declared here (nothing needs `HasRequiredKeys` to
// flip any arity for these tests) — see the spec's §3 worked example for
// the shape this mirrors; this fixture only needs the `extends` clauses,
// not a required field.

import "../node.ts"
import type { McpBranchMeta, McpLeafMeta } from "@rhi-zone/fractal-mcp-api-projector"

declare module "../node.ts" {
  interface LeafMeta extends McpLeafMeta {}
  interface BranchMeta extends McpBranchMeta {}
}
