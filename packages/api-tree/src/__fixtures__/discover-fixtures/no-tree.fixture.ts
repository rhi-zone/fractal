// A plain exported function/const with no tree export at all — one of
// `findEntryFiles`'s (discover.ts) negative fixtures: `hasTreeExport`
// (tree.ts) must return `false` for it, and a plain
// `findEntryFiles({ roots: <discover-fixtures dir> })` call must not include
// it in the result.
//
// Not a test file (no `.test.ts`), so bun test skips it.

export function double(n: number): number {
  return n * 2;
}

export const greeting = "hello";
