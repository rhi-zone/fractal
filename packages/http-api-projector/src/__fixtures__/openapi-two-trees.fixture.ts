// packages/http-api-projector/src/__fixtures__/openapi-two-trees.fixture.ts
//
// Two exported Node trees in ONE file, each with a top-level leaf named
// "widgets" but a DIFFERENT input shape — regression fixture for
// `toOpenApi(n, { sourceFile })`'s `treeId` disambiguation (openapi.ts's
// `resolveTreeId`, TODO.md's "toOpenApi auto-discovery key mismatch" entry).
// `extractRouteSchemas` keys these `"catalogTree/widgets"` and
// `"inventoryTree/widgets"` — `toOpenApi` can't tell which export a runtime
// `Node` value came from, so it throws unless `opts.treeId` disambiguates.
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "../verbs.ts"

export const catalogTree = api({
  widgets: op(
    /** Create a catalog widget. */
    (input: { catalogName: string }) => ({ id: "c1", ...input }),
    http.post,
  ),
})

export const inventoryTree = api({
  widgets: op(
    /** Create an inventory widget. */
    (input: { warehouseId: string; quantity: number }) => ({ id: "i1", ...input }),
    http.post,
  ),
})
