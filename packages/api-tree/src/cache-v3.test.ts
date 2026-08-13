// packages/api-tree/src/cache-v3.test.ts — IR-keyed build cache (v3) tests
//
// Covers docs/design/ir-keyed-cache-spec.md's Task 3 required scenarios:
//   1. Precision win: a comment/implementation-only edit inside one leaf's
//      handler body, in an entry with N>=2 leaves, triggers a Tier-1 miss but
//      Tier 2 finds every leaf's fingerprint unchanged — nothing re-derives.
//   2. Transitive type change: an edit reached only through an import changes
//      exactly the reaching leaf's fingerprint/code; an unrelated leaf in the
//      same entry is untouched.
//   3. Bundle rollup: one member leaf changing in a bundle re-emits that
//      bundle's output; a sibling bundle (a different entry, sharing no leaf)
//      stays byte-identical.
//   4. v2 -> v3 migration: a v2-format cache file is treated as an
//      unconditional miss, and a rebuild writes a fresh v3 file.
//   5. Determinism regression: leaf-fingerprint serialization is byte-stable
//      across two independent `ts.Program` builds, covering the defs/sharing
//      + declarationFile paths (not just an inline-object leaf) — and the
//      declarationFile canonicalization is checkout-path-independent.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildWireApplyValidationModuleSourceIncremental,
  writeWireApplyValidationModuleCached,
  type WireApplyValidationCarryForwardState,
} from "./apply-validation-build.ts";
import { checkCache, computeLeafFingerprint, readCarryForwardState } from "./cache.ts";
import { createExtractorProgram, defaultShouldShare } from "./extract.ts";
import { extractRouteTypeRefs } from "./tree.ts";

const TMP_DIR = `${import.meta.dir}/__fixtures__/.cache-v3-test-tmp`;
const NODE_TS = path.resolve(`${import.meta.dir}/node.ts`);
const APPLY_VALIDATION_TS = path.resolve(`${import.meta.dir}/apply-validation.ts`);

function importSpecifier(fromDir: string, targetAbs: string): string {
  const rel = path.relative(fromDir, targetAbs).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function writeSource(rel: string, content: string): string {
  const full = path.join(TMP_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function thingTypeSource(extraField?: string): string {
  return [
    "export interface Thing {",
    "  id: string",
    "  label: string",
    ...(extraField ? [`  ${extraField}`] : []),
    "}",
    "",
  ].join("\n");
}

function entryASource(
  nodeImport: string,
  typesImport: string,
  avImport: string,
  marker: string,
): string {
  return `import { api, op } from "${nodeImport}"
import type { Thing } from "${typesImport}"
import { createApplyValidation } from "${avImport}"

// leafOne: input is the named, imported Thing type.
const leafOne = op((input: Thing) => {
  return { id: input.id }
})

// leafTwo: unrelated inline input — this comment is the perturbation target.
const leafTwo = op((input: { q?: string }) => {
  // marker: ${marker}
  return { ok: true }
})

const tree = api({ leafOne, leafTwo })
const applyValidation = createApplyValidation({})
export const validated = applyValidation("bundle", tree)
`;
}

function entryBSource(nodeImport: string, avImport: string): string {
  return `import { api, op } from "${nodeImport}"
import { createApplyValidation } from "${avImport}"

const leafThree = op((input: { n: number }) => {
  return { doubled: input.n * 2 }
})

const tree = api({ leafThree })
const applyValidation = createApplyValidation({})
export const validated = applyValidation("bundle", tree)
`;
}

async function readCarryForward(
  entryFile: string,
  outFile: string,
): Promise<WireApplyValidationCarryForwardState> {
  const prior = readCarryForwardState(entryFile, outFile);
  if (prior === undefined) throw new Error("expected carry-forward state to be readable");
  return prior;
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("IR-keyed build cache (v3) — Tier 2 leaf-level carry-forward", () => {
  it("1. precision win: a comment/implementation-only edit inside one leaf's body triggers Tier-1 miss but changes ZERO leaves' fingerprints", async () => {
    const typesFile = writeSource("types.ts", thingTypeSource());
    const entryFile = writeSource(
      "entry-a.ts",
      entryASource(
        importSpecifier(TMP_DIR, NODE_TS),
        importSpecifier(TMP_DIR, typesFile),
        importSpecifier(TMP_DIR, APPLY_VALIDATION_TS),
        "v1",
      ),
    );
    const outFile = path.join(TMP_DIR, "entry-a.validators.ts");

    const first = await writeWireApplyValidationModuleCached(entryFile, outFile);
    expect(first.status).toBe("built");
    const sourceBefore = fs.readFileSync(outFile, "utf8");

    // Comment/implementation-only edit inside leafTwo's handler body — no
    // change to any leaf's resolved input/output TYPE.
    writeSource(
      "entry-a.ts",
      entryASource(
        importSpecifier(TMP_DIR, NODE_TS),
        importSpecifier(TMP_DIR, typesFile),
        importSpecifier(TMP_DIR, APPLY_VALIDATION_TS),
        "v2, a much longer comment describing nothing type-relevant",
      ),
    );

    // (a) Tier 1 misses — the entry file's own content changed.
    const check = checkCache(entryFile, outFile);
    expect(check.hit).toBe(false);

    // (b) Tier 2 determines zero leaves' fingerprints changed.
    const prior = await readCarryForward(entryFile, outFile);
    const program = createExtractorProgram(entryFile);
    const incremental = buildWireApplyValidationModuleSourceIncremental(entryFile, {
      outFile,
      program,
      prior,
    });
    expect(incremental.changedLeaves).toEqual([]);
    // Every leaf's generated code is byte-identical to before — carried
    // forward verbatim, not re-templated.
    expect(incremental.source).toEqual(sourceBefore);

    // The disk-facing cached API agrees: still reports "built" (a Program
    // WAS constructed, since Tier 1 missed) but the bytes it writes are the
    // same bytes already on disk.
    const rebuilt = await writeWireApplyValidationModuleCached(entryFile, outFile);
    expect(rebuilt.status).toBe("built");
    expect(fs.readFileSync(outFile, "utf8")).toEqual(sourceBefore);
  });

  it("2. transitive type change: an edit reached only through an import changes exactly the reaching leaf; the unrelated leaf is untouched", async () => {
    const typesFile = writeSource("types.ts", thingTypeSource());
    const entryFile = writeSource(
      "entry-a.ts",
      entryASource(
        importSpecifier(TMP_DIR, NODE_TS),
        importSpecifier(TMP_DIR, typesFile),
        importSpecifier(TMP_DIR, APPLY_VALIDATION_TS),
        "v1",
      ),
    );
    const outFile = path.join(TMP_DIR, "entry-a.validators.ts");

    await writeWireApplyValidationModuleCached(entryFile, outFile);
    const priorBaseline = await readCarryForward(entryFile, outFile);
    // Leaf-artifact keys fold the (now-implied) protocol in via
    // `wireValidatorKey` -- a 2-arg call site's protocol defaults to
    // "identity" (phase D, decision A), so the key is `${flatName} identity`.
    const leafTwoFragmentBefore = priorBaseline.leafArtifacts["bundle\u0000leafTwo identity"];

    // Change reached ONLY through the import — Thing gains a field. The
    // entry file's own text is untouched.
    writeSource("types.ts", thingTypeSource("newField: boolean"));

    expect(checkCache(entryFile, outFile).hit).toBe(false);

    const prior = await readCarryForward(entryFile, outFile);
    const program = createExtractorProgram(entryFile);
    const incremental = buildWireApplyValidationModuleSourceIncremental(entryFile, {
      outFile,
      program,
      prior,
    });

    expect(incremental.changedLeaves).toEqual(["bundle\u0000leafOne identity"]);
    expect(incremental.leafArtifacts["bundle\u0000leafOne identity"]).not.toEqual(
      prior.leafArtifacts["bundle\u0000leafOne identity"],
    );
    // leafTwo's fragment is byte-identical to the pre-edit baseline — carried
    // forward from the (JSON-round-tripped) cache record, never recompiled.
    expect(incremental.leafArtifacts["bundle\u0000leafTwo identity"]).toEqual(
      leafTwoFragmentBefore as never,
    );
  });

  it("3. bundle rollup: one member leaf changing re-emits its bundle; a sibling bundle (different entry, no shared leaf) is byte-identical to before", async () => {
    const typesFile = writeSource("types.ts", thingTypeSource());
    const entryA = writeSource(
      "entry-a.ts",
      entryASource(
        importSpecifier(TMP_DIR, NODE_TS),
        importSpecifier(TMP_DIR, typesFile),
        importSpecifier(TMP_DIR, APPLY_VALIDATION_TS),
        "v1",
      ),
    );
    const entryB = writeSource(
      "entry-b.ts",
      entryBSource(
        importSpecifier(TMP_DIR, NODE_TS),
        importSpecifier(TMP_DIR, APPLY_VALIDATION_TS),
      ),
    );
    const outA = path.join(TMP_DIR, "entry-a.validators.ts");
    const outB = path.join(TMP_DIR, "entry-b.validators.ts");

    await writeWireApplyValidationModuleCached(entryA, outA);
    await writeWireApplyValidationModuleCached(entryB, outB);
    const outBBefore = fs.readFileSync(outB, "utf8");
    const cacheBBefore = fs.readFileSync(`${outB}.cache.json`, "utf8");

    // Real type change reached through entry-a's import only.
    writeSource("types.ts", thingTypeSource("newField: boolean"));

    const rebuiltA = await writeWireApplyValidationModuleCached(entryA, outA);
    expect(rebuiltA.status).toBe("built");
    const outAAfter = fs.readFileSync(outA, "utf8");
    expect(outAAfter).toContain("newField");

    // Sibling bundle (entry-b) shares no leaf with entry-a and never reaches
    // types.ts at all — its cache stays a hit, its output untouched on disk.
    expect(checkCache(entryB, outB).hit).toBe(true);
    const rebuiltB = await writeWireApplyValidationModuleCached(entryB, outB);
    expect(rebuiltB.status).toBe("hit");
    expect(fs.readFileSync(outB, "utf8")).toEqual(outBBefore);
    expect(fs.readFileSync(`${outB}.cache.json`, "utf8")).toEqual(cacheBBefore);
  });

  it("4. v2 -> v3 migration: a v2-format cache file is an unconditional miss; a rebuild writes a fresh v3 file", async () => {
    const entryFile = writeSource(
      "entry-b.ts",
      entryBSource(
        importSpecifier(TMP_DIR, NODE_TS),
        importSpecifier(TMP_DIR, APPLY_VALIDATION_TS),
      ),
    );
    const outFile = path.join(TMP_DIR, "entry-b.validators.ts");

    await writeWireApplyValidationModuleCached(entryFile, outFile);
    const v3Meta = JSON.parse(fs.readFileSync(`${outFile}.cache.json`, "utf8")) as {
      version: number;
    };
    expect(v3Meta.version).toBe(3);

    // Hand-craft a v2-shaped cache file (the old shape — no
    // leafFingerprints/bundleFingerprint/defNamesFingerprint/leafArtifacts)
    // in place of the real one, simulating an existing checkout that last
    // built under v2.
    const v2Meta = {
      version: 2,
      tsVersion: (v3Meta as unknown as { tsVersion: string }).tsVersion,
      typeIrVersion: (v3Meta as unknown as { typeIrVersion: string }).typeIrVersion,
      entryFile: (v3Meta as unknown as { entryFile: string }).entryFile,
      files: (v3Meta as unknown as { files: unknown }).files,
      outputHash: (v3Meta as unknown as { outputHash: string }).outputHash,
    };
    fs.writeFileSync(`${outFile}.cache.json`, JSON.stringify(v2Meta));

    const check = checkCache(entryFile, outFile);
    expect(check.hit).toBe(false);
    if (!check.hit) expect(check.reason).toContain("version");

    // No carry-forward data is trusted from a v2-shaped file either.
    expect(readCarryForwardState(entryFile, outFile)).toBeUndefined();

    const rebuilt = await writeWireApplyValidationModuleCached(entryFile, outFile);
    expect(rebuilt.status).toBe("built");
    const freshMeta = JSON.parse(fs.readFileSync(`${outFile}.cache.json`, "utf8")) as {
      version: number;
    };
    expect(freshMeta.version).toBe(3);
  });

  describe("5. determinism regression — defs/sharing + declarationFile paths, not just an inline-object leaf", () => {
    it("leaf fingerprints are byte-stable across two independent Program builds over a fixture that exercises shouldShare/defs", () => {
      const FIXTURE = `${import.meta.dir}/__fixtures__/sharing-input.fixture.ts`;

      const programA = createExtractorProgram(FIXTURE);
      const { types: typesA } = extractRouteTypeRefs(FIXTURE, {
        shouldShare: defaultShouldShare,
        program: programA,
      });
      const programB = createExtractorProgram(FIXTURE);
      const { types: typesB } = extractRouteTypeRefs(FIXTURE, {
        shouldShare: defaultShouldShare,
        program: programB,
      });

      expect(Object.keys(typesA).sort()).toEqual(Object.keys(typesB).sort());
      for (const key of Object.keys(typesA)) {
        const fpA = computeLeafFingerprint(FIXTURE, {
          input: typesA[key]!.input,
          output: typesA[key]!.output,
        });
        const fpB = computeLeafFingerprint(FIXTURE, {
          input: typesB[key]!.input,
          output: typesB[key]!.output,
        });
        expect(fpB).toBe(fpA);
      }
    });

    it("declarationFile absolute paths are canonicalized away — two different checkout roots with the same relative layout fingerprint identically", () => {
      // Two synthetic "checkouts" of the same relative layout at different
      // absolute roots — exactly the scenario the spec's §6 caveat names.
      const entryFileA = "/tmp/checkout-1/pkg/src/entry.ts";
      const declA = "/tmp/checkout-1/pkg/src/types.ts";
      const entryFileB = "/tmp/checkout-2-elsewhere/pkg/src/entry.ts";
      const declB = "/tmp/checkout-2-elsewhere/pkg/src/types.ts";

      const leafA = {
        input: {
          shape: { kind: "ref", target: "Widget" },
          meta: { typeName: "Widget", declarationFile: declA },
        },
      };
      const leafB = {
        input: {
          shape: { kind: "ref", target: "Widget" },
          meta: { typeName: "Widget", declarationFile: declB },
        },
      };

      expect(computeLeafFingerprint(entryFileA, leafA)).toBe(
        computeLeafFingerprint(entryFileB, leafB),
      );

      // Sanity: a genuinely different relative layout (declarationFile one
      // directory further away) fingerprints DIFFERENTLY — canonicalization
      // preserves the real relative-path signal, it doesn't collapse
      // everything to the same value.
      const declC = "/tmp/checkout-3/pkg/other/types.ts";
      const leafC = {
        input: {
          shape: { kind: "ref", target: "Widget" },
          meta: { typeName: "Widget", declarationFile: declC },
        },
      };
      expect(computeLeafFingerprint("/tmp/checkout-3/pkg/src/entry.ts", leafC)).not.toBe(
        computeLeafFingerprint(entryFileA, leafA),
      );
    });
  });
});
