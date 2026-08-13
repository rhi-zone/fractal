// packages/api-tree/src/__fixtures__/default-export.fixture.ts
//
// A bare `export default api(...)` — the tree expression exported directly
// as default, no function wrapper, no variable binding. Parses as a
// ts.ExportAssignment, a shape forEachTreeCandidate (tree.ts) didn't
// recognize until this fixture's regression fix: previously matched neither
// the `export const` nor the `export function` branch, so the loop silently
// skipped it — no error, no warning, leaves just absent from walkTree /
// extractRouteSchemas / extractRouteTypeRefs / extractToolSchemas /
// extractToolTypeRefs / hasTreeExport.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";

export default api({
  ping: op(
    /** Ping the default-exported tree. */
    (_input: { count: number }) => ({ pong: _input.count }),
  ),
});
