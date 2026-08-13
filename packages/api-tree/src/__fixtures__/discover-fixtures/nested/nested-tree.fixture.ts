// A genuine `api()` tree export one directory level below the scanned root
// — proves `findEntryFiles`'s (discover.ts) directory scan is recursive, not
// just a single-level `readdir`.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../../../node.ts";

export const tree = api({
  deep: op((x: { value: number }) => x),
});
