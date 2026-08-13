// packages/api-tree/src/__fixtures__/discover-fixtures/with-tree.fixture.ts
//
// A minimal genuine `api()` tree export — one of `findEntryFiles`'s
// (discover.ts) positive fixtures: this file must be picked up by a plain
// `findEntryFiles({ roots: <discover-fixtures dir> })` call, and
// `hasTreeExport` (tree.ts) must return `true` for it.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api, op } from "../../node.ts";

export const tree = api({
  ping: op((x: { count: number }) => x),
});
