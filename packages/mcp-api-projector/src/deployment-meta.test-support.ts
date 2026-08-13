// The one augmentation this package's tests need, standing in for the one a
// real deployment would own.
//
// Projectors never augment core's meta types themselves; a deployment does it,
// once, in a file of its own (docs/design/meta-role-split-spec.md §2 and §3).
// This projector has no deployment — but its tests author `meta.mcp` anyway,
// including `meta.mcp.segment` at branch position, to exercise the walks
// against trees shaped like real ones. This file is where they get to.
//
// Imported for the augmentation alone, and named so `bun test` does not mistake
// it for a test file.

import "@rhi-zone/fractal-api-tree/node";
import type { McpBranchMeta, McpLeafMeta } from "./project.ts";

declare module "@rhi-zone/fractal-api-tree/node" {
  interface LeafMeta extends McpLeafMeta {}
  interface BranchMeta extends McpBranchMeta {}
}
