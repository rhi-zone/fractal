// packages/api-tree/src/__fixtures__/default-export.fixture.ts
//
// A bare `export default api(...)` — the tree expression exported directly
// as default, no function wrapper, no variable binding. Parses as a
// ts.ExportAssignment, a shape distinct from both the `export const` and
// `export function` branches forEachTreeCandidate (tree.ts) otherwise
// recognizes. Regression coverage for that case: unhandled, the loop
// silently skips this export — no error, no warning — leaving it absent
// from walkTree / extractRouteSchemas / extractRouteTypeRefs /
// extractToolSchemas / extractToolTypeRefs / hasTreeExport.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";

export default api({
  ping: op(
    /** Ping the default-exported tree. */
    (_input: { count: number }) => ({ pong: _input.count }),
  ),
});
