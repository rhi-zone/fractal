// Two exported trees in one file, each with a top-level "list" leaf —
// regression fixture for the treeId-prefixed key fix (tree.ts). Without that
// fix, extractRouteTypeRefs/extractRouteSchemas key both leaves as bare
// "list" (path resets to [] per tree, but both trees write into the same
// flat output map walkTree accumulates across every tree in a file), so the
// second tree's entry silently overwrites the first's — a leaf ends up wired
// to a different tree's validator/schema at `wrapValidators` consumption
// time, not a missing-entry error `collectUnvalidatedLeaves` could catch.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";

export const catalogTree = api({
  list: op(
    /** List items in the catalog. */
    (_input: { limit: number }) => ({ items: [] as string[] }),
  ),
});

export const inventoryTree = api({
  list: op(
    /** List warehouse inventory rows. */
    (_input: { warehouseId: string }) => ({ rows: [] as string[] }),
  ),
});
