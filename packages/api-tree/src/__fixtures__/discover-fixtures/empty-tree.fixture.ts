// packages/api-tree/src/__fixtures__/discover-fixtures/empty-tree.fixture.ts
//
// A genuinely EMPTY tree — `api({})`, zero children/leaves — locking in
// `hasTreeExport`'s (tree.ts) "detects by export shape, not leaf count"
// semantics: this file must still count as a tree-exporting entry file even
// though there is nothing inside it to validate.
//
// Not a test file (no `.test.ts`), so bun test skips it.

import { api } from "../../node.ts";

export const tree = api({});
