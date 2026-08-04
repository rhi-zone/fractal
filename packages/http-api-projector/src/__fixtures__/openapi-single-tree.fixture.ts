// packages/http-api-projector/src/__fixtures__/openapi-single-tree.fixture.ts
//
// One exported Node tree — regression fixture for `toOpenApi(n, { sourceFile
// })`'s auto-discovery path (openapi.ts, TODO.md's "toOpenApi auto-discovery
// key mismatch" entry). `extractRouteSchemas` keys this file's sole leaf
// `"widgetsTree/widgets"` (`${treeId}/${path}`); `toOpenApi` must infer
// `widgetsTree` as the `treeId` with no explicit `opts.treeId` since this
// file exports exactly one tree — see openapi.test.ts's "auto-discovery"
// suite. Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "../verbs.ts"

export const widgetsTree = api({
  widgets: op(
    /** Create a widget. */
    (input: { name: string; quantity: number }) => ({ id: "w1", ...input }),
    http.post,
  ),
})
