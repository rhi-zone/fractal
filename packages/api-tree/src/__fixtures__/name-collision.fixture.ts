// One tree with a leaf key that itself contains the "_" join delimiter
// ("books_get") alongside a nested leaf ("books" -> "get") whose
// ancestor-joined name would, under the OLD unescaped join, produce the
// identical string — regression fixture for `escapeJoin` (./path.ts).
// Before escapeJoin, extractToolSchemas/extractToolTypeRefs either silently
// let whichever leaf was visited second overwrite the first, or (after the
// `assertUniqueName` symptom-patch) threw. Now the join is injective: the
// two positions derive two genuinely different names ("books\_get" and
// "books_get") and both survive in the output map — see extract.test.ts's
// "a segment containing the join delimiter no longer collides" coverage.
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
