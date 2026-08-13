// packages/api-tree/src/__fixtures__/wire-apply-validation-meta.fixture.ts
//
// This test suite's stand-in "deployment" for the WIRE-PROFILE call-site
// tests specifically — merges `meta.http`/`meta.cli` (in addition to
// `meta.mcp`, already merged by deployment-meta.fixture.ts) so a 3-arg
// `applyValidation(key, tree, protocol)` fixture can author
// `meta.http.sourceMap`/`.method`/`meta.cli.sourceMap` literally.

import "../node.ts";
import type { HttpLeafMeta } from "@rhi-zone/fractal-http-api-projector";
import type { CliLeafMeta } from "@rhi-zone/fractal-cli-api-projector";

declare module "../node.ts" {
  interface LeafMeta extends HttpLeafMeta, CliLeafMeta {}
}
