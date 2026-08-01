// packages/api-tree/src/__fixtures__/discover-fixtures/excluded-tree.fixture.ts
//
// A genuine `api()` tree export, meant to be exercised via `findEntryFiles`'s
// (discover.ts) `exclude` option — autodetection alone WOULD pick this file
// up (same as with-tree.fixture.ts), so discover.test.ts's `exclude` tests
// prove the removal actually happens rather than the file just never having
// been a candidate.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../../node.ts"

export const tree = api({
  skip: op((x: { id: string }) => x),
})
