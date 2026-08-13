// Tests for per-entry module-graph reachability over a shared `ts.Program`
// (reachability.ts).
//
// Covers `computeEntryClosures`/`affectedEntries` against real fixture files
// (not a synthetic in-memory graph) sharing one multi-root `ts.Program` —
// the exact shape the sibling codebase's `codegen-fractal-validators.ts` uses — so
// "an entry's closure excludes a file only some other entry reaches" is
// proven against genuine multi-file, multi-entry extraction, not a mocked
// graph.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createExtractorProgram } from "./extract.ts";
import { computeEntryClosures, affectedEntries } from "./reachability.ts";

const FIXTURES = `${import.meta.dir}/__fixtures__`;
const TREE_ENTRY = `${FIXTURES}/tree.fixture.ts`;
const SHARING_ENTRY = `${FIXTURES}/sharing.fixture.ts`;
const RESULT_REEXPORT = `${FIXTURES}/result-reexport.fixture.ts`;
const DEPLOYMENT_META = `${FIXTURES}/deployment-meta.fixture.ts`;
const NODE_TS = `${import.meta.dir}/node.ts`;

describe("reachability.ts — per-entry module-graph closures over a shared Program", () => {
  it("each entry's closure includes its own transitive dependencies", () => {
    const program = createExtractorProgram([TREE_ENTRY, SHARING_ENTRY]);
    const closures = computeEntryClosures([TREE_ENTRY, SHARING_ENTRY], program);

    const treeClosure = closures.get(path.resolve(TREE_ENTRY));
    expect(treeClosure).toBeDefined();
    expect(treeClosure?.has(path.resolve(TREE_ENTRY))).toBe(true);
    expect(treeClosure?.has(path.resolve(RESULT_REEXPORT))).toBe(true);
    expect(treeClosure?.has(path.resolve(DEPLOYMENT_META))).toBe(true);
  });

  it("a file reachable from only one entry is absent from the other entry's closure — proving per-entry precision, not the whole batch's union", () => {
    const program = createExtractorProgram([TREE_ENTRY, SHARING_ENTRY]);
    const closures = computeEntryClosures([TREE_ENTRY, SHARING_ENTRY], program);

    const sharingClosure = closures.get(path.resolve(SHARING_ENTRY));
    expect(sharingClosure).toBeDefined();
    // sharing.fixture.ts never imports result-reexport.fixture.ts or
    // deployment-meta.fixture.ts — if the coarse (pre-fix) behavior were
    // still in effect, this closure would be the whole shared Program's
    // union and both would incorrectly be present.
    expect(sharingClosure?.has(path.resolve(RESULT_REEXPORT))).toBe(false);
    expect(sharingClosure?.has(path.resolve(DEPLOYMENT_META))).toBe(false);
  });

  it("a file reachable from both entries (a shared dependency) appears in both closures", () => {
    const program = createExtractorProgram([TREE_ENTRY, SHARING_ENTRY]);
    const closures = computeEntryClosures([TREE_ENTRY, SHARING_ENTRY], program);

    const treeClosure = closures.get(path.resolve(TREE_ENTRY));
    const sharingClosure = closures.get(path.resolve(SHARING_ENTRY));
    // Both fixtures import `api`/`op` from ../node.ts.
    expect(treeClosure?.has(path.resolve(NODE_TS))).toBe(true);
    expect(sharingClosure?.has(path.resolve(NODE_TS))).toBe(true);
  });

  it("type-only imports (`import type { ... } from ...`) are included in the closure", () => {
    const TYPEREF_ENTRY = `${FIXTURES}/typeref.fixture.ts`;
    const PAGE_TS = `${import.meta.dir}/page.ts`;
    const program = createExtractorProgram([TYPEREF_ENTRY]);
    const closures = computeEntryClosures([TYPEREF_ENTRY], program);
    const closure = closures.get(path.resolve(TYPEREF_ENTRY));
    // typeref.fixture.ts: `import type { CursorPage, OffsetPage, Page } from "../page.ts"`
    expect(closure?.has(path.resolve(PAGE_TS))).toBe(true);
  });

  it("TypeScript's own bundled lib.*.d.ts files are excluded from every closure", () => {
    const program = createExtractorProgram([TREE_ENTRY]);
    const closures = computeEntryClosures([TREE_ENTRY], program);
    const closure = closures.get(path.resolve(TREE_ENTRY));
    expect(closure).toBeDefined();
    for (const file of closure ?? []) {
      expect(/[\\/]typescript[\\/]lib[\\/]lib\.[a-z0-9.]+\.d\.ts$/i.test(file)).toBe(false);
    }
  });

  describe("affectedEntries — touched-file -> affected-entry mapping", () => {
    it("a file reachable only from tree.fixture.ts maps to exactly that entry", () => {
      const program = createExtractorProgram([TREE_ENTRY, SHARING_ENTRY]);
      const closures = computeEntryClosures([TREE_ENTRY, SHARING_ENTRY], program);

      const affected = affectedEntries(closures, RESULT_REEXPORT);
      expect(affected.size).toBe(1);
      expect(affected.has(path.resolve(TREE_ENTRY))).toBe(true);
      expect(affected.has(path.resolve(SHARING_ENTRY))).toBe(false);
    });

    it("a shared dependency maps to every entry that reaches it", () => {
      const program = createExtractorProgram([TREE_ENTRY, SHARING_ENTRY]);
      const closures = computeEntryClosures([TREE_ENTRY, SHARING_ENTRY], program);

      const affected = affectedEntries(closures, NODE_TS);
      expect(affected.size).toBe(2);
      expect(affected.has(path.resolve(TREE_ENTRY))).toBe(true);
      expect(affected.has(path.resolve(SHARING_ENTRY))).toBe(true);
    });

    it("a file reachable from no entry maps to the empty set", () => {
      const program = createExtractorProgram([TREE_ENTRY, SHARING_ENTRY]);
      const closures = computeEntryClosures([TREE_ENTRY, SHARING_ENTRY], program);

      // typeref.fixture.ts is not an entry and nothing in this batch imports it.
      const affected = affectedEntries(closures, `${FIXTURES}/typeref.fixture.ts`);
      expect(affected.size).toBe(0);
    });
  });
});
