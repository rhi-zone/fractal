// One tree whose underscore-joined tool name collides across two DIFFERENT
// tree positions — regression fixture for `assignUniqueName` (tree.ts). The
// leaf key "books_get" derives the exact same name as branch "books" ->
// leaf "get", because `join`'s "_" delimiter is unescaped. Before the fix,
// extractToolSchemas/extractToolTypeRefs silently let whichever leaf was
// visited second overwrite the first in the flat output map; now the same
// walk throws instead.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../node.ts";

export const tree = api({
  books_get: op(
    /** A leaf whose own key already contains the join delimiter. */
    (_input: { flat: boolean }) => ({ flat: true }),
  ),
  books: api({
    get: op(
      /** A nested leaf whose ancestor-joined name collides with the flat leaf above. */
      (_input: { nested: boolean }) => ({ nested: true }),
    ),
  }),
});
