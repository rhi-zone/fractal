// packages/api-tree/src/__fixtures__/discover-fixtures-outside/outside-no-tree.fixture.ts
//
// Lives OUTSIDE discover-fixtures/ (the directory discover.test.ts scans as
// `roots`) and has no tree export — used to prove a literal-string `include`
// matcher in `findEntryFiles` (discover.ts) can force-add a file the
// directory scan never even saw AND bypass `hasTreeExport` detection
// entirely (this file would fail that check even if it had been scanned).
//
// Not a test file (no `.test.ts`), so bun test skips it.

export const notATree = { plain: true }
