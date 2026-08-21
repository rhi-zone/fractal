// Cross-`tsconfig.json`-region extraction: each entry file gets ITS OWN
// project's compiler options, not the first entry file's.
//
// `createExtractorProgram`'s multi-root form used to resolve options from
// `entryFiles[0]` alone and hand that one bag to every root. Nothing in the
// suite could catch it, because every prior multi-root test drew its entry
// files from one package's `__fixtures__` directory — one region, so
// "options from the first file" and "options from each file" were the same
// answer. The failure was structurally untestable without deliberately
// crossing a package boundary, which is what these tests do: they pair a real
// file from `api-tree` (whose `tsconfig.json` layers a `paths` remap over the
// shared base) with a real file from `type-ir` (whose `tsconfig.json` adds no
// `paths` at all), so applying either project's options to the other file is
// directly observable.
//
// Real source files rather than synthetic fixtures on purpose: the bug is
// about how `ts.findConfigFile` resolves against this repo's actual on-disk
// package layout, and a fixture tree built to have two tsconfigs would test
// the fixture's layout instead of the one that ships.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { findEntryFiles } from "./discover.ts";
import { createExtractorProgram, groupEntryFilesByConfig } from "./extract.ts";

const PACKAGES = path.resolve(import.meta.dir, "../..");

/** A real `api-tree` source file — region: `packages/api-tree/tsconfig.json`. */
const API_TREE_FILE = path.join(PACKAGES, "api-tree/src/tree.ts");
/** A real `type-ir` source file — region: `packages/type-ir/tsconfig.json`. */
const TYPE_IR_FILE = path.join(PACKAGES, "type-ir/src/from-typescript.ts");

const API_TREE_CONFIG = path.join(PACKAGES, "api-tree/tsconfig.json");
const TYPE_IR_CONFIG = path.join(PACKAGES, "type-ir/tsconfig.json");

describe("groupEntryFilesByConfig — partitioning a batch by nearest tsconfig", () => {
  it("splits two packages' files into their own regions, each with its own config", () => {
    const groups = groupEntryFilesByConfig([API_TREE_FILE, TYPE_IR_FILE]);
    expect(groups.map((g) => g.configPath)).toEqual([API_TREE_CONFIG, TYPE_IR_CONFIG]);
    expect(groups.map((g) => g.entryFiles)).toEqual([[API_TREE_FILE], [TYPE_IR_FILE]]);
  });

  it("resolves each region's options from its own project, not the batch's first file", () => {
    const [apiTree, typeIr] = groupEntryFilesByConfig([API_TREE_FILE, TYPE_IR_FILE]);

    // The load-bearing difference, and the one that actually changes module
    // resolution: api-tree's config carries a workspace `paths` remap rooted
    // at its own directory, type-ir's carries none. Under the old behavior
    // the second file in the batch inherited the first's, whichever way
    // round the batch was ordered.
    expect(Object.keys(apiTree!.compilerOptions.paths ?? {})).toContain(
      "@rhi-zone/fractal-type-ir/*",
    );
    expect(apiTree!.compilerOptions.pathsBasePath).toBe(path.dirname(API_TREE_CONFIG));
    expect(typeIr!.compilerOptions.paths).toBeUndefined();
  });

  it("is order-independent — reversing the batch swaps the groups, not the options", () => {
    const [typeIr, apiTree] = groupEntryFilesByConfig([TYPE_IR_FILE, API_TREE_FILE]);
    expect(typeIr!.configPath).toBe(TYPE_IR_CONFIG);
    expect(apiTree!.configPath).toBe(API_TREE_CONFIG);
    // The regression this guards: with options taken from the batch's first
    // file, `type-ir` here would have come back carrying api-tree's `paths`.
    expect(typeIr!.compilerOptions.paths).toBeUndefined();
    expect(apiTree!.compilerOptions.paths).toBeDefined();
  });

  it("keeps a single-region batch as one group, so Program sharing is unchanged", () => {
    const groups = groupEntryFilesByConfig([
      API_TREE_FILE,
      path.join(PACKAGES, "api-tree/src/discover.ts"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.configPath).toBe(API_TREE_CONFIG);
  });
});

describe("createExtractorProgram — one Program, one config region", () => {
  it("refuses a cross-region batch instead of silently applying one region's options", () => {
    expect(() => createExtractorProgram([API_TREE_FILE, TYPE_IR_FILE])).toThrow(
      /span 2 different tsconfig\.json regions/,
    );
  });

  it("names both offending regions in the error, so the caller can see the split", () => {
    let message = "";
    try {
      createExtractorProgram([API_TREE_FILE, TYPE_IR_FILE]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(API_TREE_CONFIG);
    expect(message).toContain(TYPE_IR_CONFIG);
    expect(message).toContain("groupEntryFilesByConfig");
  });

  it("builds each region's Program under that region's own options, end to end", () => {
    // The whole point, exercised the way a batch caller is meant to: group,
    // then one Program per group. Before this change a single Program over
    // both files carried one options bag, so one of the two files was always
    // being compiled under the other project's `paths`.
    const seen = groupEntryFilesByConfig([API_TREE_FILE, TYPE_IR_FILE]).map((group) => {
      const program = createExtractorProgram(group.entryFiles);
      return {
        pathsBasePath: program.getCompilerOptions().pathsBasePath,
        rootResolved: group.entryFiles.every((f) => program.getSourceFile(f) !== undefined),
      };
    });

    expect(seen).toEqual([
      { pathsBasePath: path.dirname(API_TREE_CONFIG), rootResolved: true },
      { pathsBasePath: undefined, rootResolved: true },
    ]);
  });

  it("still accepts a single file from either region", () => {
    // A one-file batch is trivially one region and always resolved its own
    // config correctly — guarded so the multi-root rejection above can never
    // be widened into the single-file path by accident.
    expect(createExtractorProgram(TYPE_IR_FILE).getCompilerOptions().paths).toBeUndefined();
    expect(createExtractorProgram(API_TREE_FILE).getCompilerOptions().pathsBasePath).toBe(
      path.dirname(API_TREE_CONFIG),
    );
  });
});

describe("findEntryFiles — scanning roots that cross a package boundary", () => {
  // Deliberately small roots: the point is that the scan spans two regions,
  // not that it covers a large tree. `type-ir`'s fixture directory holds one
  // dependency-free file with no tree export, so the second region costs
  // almost nothing to build a Program over.
  const API_TREE_FIXTURES = path.join(PACKAGES, "api-tree/src/__fixtures__/discover-fixtures");
  const TYPE_IR_FIXTURES = path.join(PACKAGES, "type-ir/src/__fixtures__");

  it("detects across both regions and returns only the real tree exports", () => {
    const result = findEntryFiles({ roots: [API_TREE_FIXTURES, TYPE_IR_FIXTURES] });
    expect(result).toEqual(
      [
        path.join(API_TREE_FIXTURES, "with-tree.fixture.ts"),
        path.join(API_TREE_FIXTURES, "excluded-tree.fixture.ts"),
        path.join(API_TREE_FIXTURES, "empty-tree.fixture.ts"),
        path.join(API_TREE_FIXTURES, "nested/nested-tree.fixture.ts"),
      ].sort(),
    );
  });

  it("rejects a caller-supplied Program when the scan spans regions", () => {
    // No single Program can be right for both regions, so accepting one here
    // would be accepting a guaranteed-wrong answer for one of them.
    const program = createExtractorProgram(path.join(API_TREE_FIXTURES, "with-tree.fixture.ts"));
    expect(() => findEntryFiles({ roots: [API_TREE_FIXTURES, TYPE_IR_FIXTURES], program })).toThrow(
      /span 2 different tsconfig\.json regions/,
    );
  });

  it("still accepts a caller-supplied Program for a single-region scan", () => {
    // `options.program` has to be rooted at every scanned CANDIDATE, not just
    // the ones that turn out to have tree exports — detection queries the
    // rejects too. Listed explicitly rather than re-deriving the scan here.
    const candidates = [
      "with-tree.fixture.ts",
      "no-tree.fixture.ts",
      "excluded-tree.fixture.ts",
      "empty-tree.fixture.ts",
      "nested/nested-tree.fixture.ts",
    ].map((f) => path.join(API_TREE_FIXTURES, f));
    const program = createExtractorProgram(candidates);
    expect(findEntryFiles({ roots: API_TREE_FIXTURES, program })).toEqual(
      findEntryFiles({ roots: API_TREE_FIXTURES }),
    );
  });
});
