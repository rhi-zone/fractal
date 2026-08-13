// packages/api-tree/src/discover.test.ts — findEntryFiles / hasTreeExport tests
//
// Covers discover.ts's autodetect-by-directory-scan design: a plain scan
// picks up every tree-exporting file under `roots` (and only those),
// `exclude`/`include` are the deliberate overrides, and `hasTreeExport`
// (tree.ts) itself detects by export SHAPE, not leaf count.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { findEntryFiles } from "./discover.ts";
import { hasTreeExport } from "./tree.ts";

const FIXTURE_DIR = `${import.meta.dir}/__fixtures__/discover-fixtures`;
const OUTSIDE_FIXTURE = path.resolve(
  `${import.meta.dir}/__fixtures__/discover-fixtures-outside/outside-no-tree.fixture.ts`,
);

const withTree = path.resolve(`${FIXTURE_DIR}/with-tree.fixture.ts`);
const noTree = path.resolve(`${FIXTURE_DIR}/no-tree.fixture.ts`);
const excludedTree = path.resolve(`${FIXTURE_DIR}/excluded-tree.fixture.ts`);
const emptyTree = path.resolve(`${FIXTURE_DIR}/empty-tree.fixture.ts`);
const nestedTree = path.resolve(`${FIXTURE_DIR}/nested/nested-tree.fixture.ts`);

describe("findEntryFiles — plain directory scan", () => {
  it("returns exactly the tree-exporting files under roots, not the plain one, recursively", () => {
    const result = findEntryFiles({ roots: FIXTURE_DIR });
    expect(result).toEqual([withTree, excludedTree, emptyTree, nestedTree].sort());
    expect(result).not.toContain(noTree);
  });
});

describe("findEntryFiles — exclude", () => {
  it("a literal string exclude removes a specific autodetected file", () => {
    const result = findEntryFiles({ roots: FIXTURE_DIR, exclude: [excludedTree] });
    expect(result).not.toContain(excludedTree);
    expect(result).toContain(withTree);
  });

  it("a RegExp exclude removes by pattern", () => {
    const result = findEntryFiles({ roots: FIXTURE_DIR, exclude: [/excluded-tree\.fixture\.ts$/] });
    expect(result).not.toContain(excludedTree);
    expect(result).toContain(withTree);
  });
});

describe("findEntryFiles — include", () => {
  it("a literal string include OUTSIDE roots force-adds a file even though it has no tree export", () => {
    const result = findEntryFiles({ roots: FIXTURE_DIR, include: [OUTSIDE_FIXTURE] });
    expect(result).toContain(OUTSIDE_FIXTURE);
  });

  it("a RegExp include re-adds a file also matched by exclude — include wins (applied after exclude)", () => {
    const result = findEntryFiles({
      roots: FIXTURE_DIR,
      exclude: [excludedTree],
      include: [/excluded-tree\.fixture\.ts$/],
    });
    expect(result).toContain(excludedTree);
  });

  it("a literal string include pointing at a nonexistent path throws", () => {
    const missing = path.resolve(`${FIXTURE_DIR}/does-not-exist.fixture.ts`);
    expect(() => findEntryFiles({ roots: FIXTURE_DIR, include: [missing] })).toThrow(
      /include path does not exist/,
    );
  });
});

describe("hasTreeExport", () => {
  it("true for a file exporting a genuine api() tree", () => {
    expect(hasTreeExport(withTree)).toBe(true);
  });

  it("false for a file with no tree export at all", () => {
    expect(hasTreeExport(noTree)).toBe(false);
  });

  it("true for a genuinely EMPTY tree (api({}), zero children) — detects by export shape, not leaf count", () => {
    expect(hasTreeExport(emptyTree)).toBe(true);
  });
});
