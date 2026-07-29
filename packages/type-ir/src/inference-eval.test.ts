// packages/type-ir/src/inference-eval.test.ts — tests for the JSON
// inference quality evaluation harness (inference-eval.ts).
import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { fromJsonCorpus } from "./from-json-corpus.ts"
import {
  generateCorpus,
  scoreInference,
  runEvaluation,
  runEvaluationTrials,
  axisValues,
  defaultLabeledCases,
  ablationRunner,
  clusteringMethodSweep,
  clusteringSensitiveCases,
  type EvalCase,
  type GeneratorProfile,
  type AblationDelta,
} from "./inference-eval.ts"
import { pairedBootstrapTest, mulberry32 } from "./stats.ts"
import { ecommerceOrder, apiResponse, treeNode } from "./test-fixtures.ts"
import { uint8 } from "./kinds/common.ts"

// ---------------------------------------------------------------------------
// generateCorpus
// ---------------------------------------------------------------------------

describe("generateCorpus", () => {
  const simpleSchema = t(
    types.object({
      id: t(types.integer),
      name: t(types.string),
      active: t(types.boolean),
      tag: t(types.enum(["a", "b", "c"])),
      note: { shape: types.string, meta: { optional: true } },
    }),
  )

  test("produces exactly n values", () => {
    expect(generateCorpus(simpleSchema, 10, { seed: "x" })).toHaveLength(10)
    expect(generateCorpus(simpleSchema, 0, { seed: "x" })).toHaveLength(0)
  })

  test("deterministic given the same seed", () => {
    const a = generateCorpus(simpleSchema, 20, { seed: "reproducible" })
    const b = generateCorpus(simpleSchema, 20, { seed: "reproducible" })
    expect(a).toEqual(b)
  })

  test("different seeds produce different corpora", () => {
    const a = generateCorpus(simpleSchema, 20, { seed: "seed-a" })
    const b = generateCorpus(simpleSchema, 20, { seed: "seed-b" })
    expect(a).not.toEqual(b)
  })

  test("generated values conform to the schema's required fields/types", () => {
    const values = generateCorpus(simpleSchema, 30, { seed: "conform" }) as Record<string, unknown>[]
    for (const v of values) {
      expect(typeof v.id).toBe("number")
      expect(typeof v.name).toBe("string")
      expect(typeof v.active).toBe("boolean")
      expect(["a", "b", "c"]).toContain(v.tag as string)
      if ("note" in v) expect(typeof v.note).toBe("string")
    }
    // Optional field must be omitted at least once across 30 samples at the
    // default 0.75 presence rate.
    expect(values.some((v) => !("note" in v))).toBe(true)
  })

  test("nested objects, arrays, and unions generate structurally valid JSON", () => {
    const values = generateCorpus(ecommerceOrder, 15, { seed: "order" }) as Record<string, unknown>[]
    for (const v of values) {
      expect(typeof v.id).toBe("number")
      expect(["pending", "shipped", "delivered", "cancelled"]).toContain(v.status as string)
      expect(Array.isArray(v.items)).toBe(true)
      expect(typeof v.customer).toBe("object")
    }
  })

  test("union root generates one of the declared variants", () => {
    const values = generateCorpus(apiResponse, 20, { seed: "resp" }) as Record<string, unknown>[]
    for (const v of values) {
      expect(["success", "error", "paginated"]).toContain(v.type as string)
    }
  })

  test("recursive ref schema terminates via depth-forced empty arrays", () => {
    const values = generateCorpus(treeNode, 10, {
      seed: "tree",
      defs: { TreeNode: treeNode },
      maxDepth: 3,
    }) as Record<string, unknown>[]
    expect(values).toHaveLength(10)
    for (const v of values) {
      expect(typeof v.value).toBe("string")
      expect(Array.isArray(v.children)).toBe(true)
    }
  })

  test("ref with no matching def degrades to null rather than throwing", () => {
    const schema = t(types.object({ next: t(types.ref("Missing")) }))
    expect(() => generateCorpus(schema, 5, { seed: "noref" })).not.toThrow()
    const values = generateCorpus(schema, 5, { seed: "noref" }) as Record<string, unknown>[]
    for (const v of values) expect(v.next).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// scoreInference
// ---------------------------------------------------------------------------

describe("scoreInference", () => {
  test("a schema scored against itself is a perfect match", () => {
    const score = scoreInference(ecommerceOrder, ecommerceOrder)
    expect(score.fieldCoverage.f1).toBe(1)
    expect(score.typeAccuracy.exactRate).toBe(1)
    expect(score.overallF1).toBe(1)
  })

  test("missing fields lower field coverage recall but not precision", () => {
    const original = t(types.object({ a: t(types.string), b: t(types.integer), c: t(types.boolean) }))
    const inferred = t(types.object({ a: t(types.string) }))
    const score = scoreInference(original, inferred)
    expect(score.fieldCoverage.precision).toBe(1)
    expect(score.fieldCoverage.recall).toBeCloseTo(1 / 3, 5)
    expect(score.fieldCoverage.f1).toBeLessThan(1)
  })

  test("extra fields lower field coverage precision but not recall", () => {
    const original = t(types.object({ a: t(types.string) }))
    const inferred = t(types.object({ a: t(types.string), b: t(types.integer) }))
    const score = scoreInference(original, inferred)
    expect(score.fieldCoverage.recall).toBe(1)
    expect(score.fieldCoverage.precision).toBe(0.5)
  })

  test("type mismatch at a shared path is neither exact nor family", () => {
    const original = t(types.object({ x: t(types.string) }))
    const inferred = t(types.object({ x: t(types.boolean) }))
    const score = scoreInference(original, inferred)
    const field = score.fields.find((f) => f.path === "x")!
    expect(field.status).toBe("mismatch")
    expect(score.typeAccuracy.exactRate).toBe(0)
    expect(score.typeAccuracy.familyRate).toBe(0)
  })

  test("width-refined kinds (e.g. uint8 vs plain integer) count as a family match, not exact", () => {
    const original = t(types.object({ n: t(types.integer) }))
    const inferred = fromJsonCorpus([{ n: 5 }, { n: 6 }, { n: 7 }]) // narrows to uint8
    const score = scoreInference(original, inferred)
    const field = score.fields.find((f) => f.path === "n")!
    expect(field.status).toBe("family")
    expect(score.typeAccuracy.exactRate).toBe(0)
    expect(score.typeAccuracy.familyRate).toBe(1)
  })

  test("enum axis is excluded from the rollup when the original has no enums", () => {
    const original = t(types.object({ a: t(types.string) }))
    const inferred = t(types.object({ a: t(types.string) }))
    const score = scoreInference(original, inferred)
    // No enums in either -> enumDetection reports the vacuous perfect score,
    // but overallF1 should just be the perfect field/type score (1), not
    // penalized or artificially inflated by axes with nothing to find.
    expect(score.overallF1).toBe(1)
  })

  test("discriminated union recovered as a plain merged object scores low union fidelity", () => {
    const original = t(
      types.union([
        t(types.object({ kind: t(types.literal("a")), x: t(types.integer) })),
        t(types.object({ kind: t(types.literal("b")), y: t(types.string) })),
      ]),
    )
    // What inference produces if DU detection is OFF and everything just
    // merges into one optional-field object.
    const inferred = t(
      types.object({
        kind: t(types.enum(["a", "b"])),
        x: { shape: types.integer, meta: { optional: true } },
        y: { shape: types.string, meta: { optional: true } },
      }),
    )
    const score = scoreInference(original, inferred)
    expect(score.unionFidelity.recall).toBe(0) // original union path never matched
  })

  describe("enumMemberFidelity", () => {
    test("a schema with 5 enum members but only 3 observed scores member-set recall ~0.6, not full credit", () => {
      const original = t(
        types.object({ status: t(types.enum(["a", "b", "c", "d", "e"])) }),
      )
      // What inference would produce from a small/skewed corpus that only
      // ever saw 3 of the 5 true members: shape is correctly detected as
      // enum (the gap this axis exists to catch is invisible to shape-only
      // scoring), but the member set is short two rare members.
      const inferred = t(
        types.object({ status: t(types.enum(["a", "b", "c"])) }),
      )
      const score = scoreInference(original, inferred)
      // Shape detection alone still reports a perfect match.
      expect(score.enumDetection.f1).toBe(1)
      // Member-set fidelity catches what shape detection can't: recall is
      // matched/actual = 3/5, not 1.
      expect(score.enumMemberFidelity.recall).toBeCloseTo(3 / 5, 5)
      expect(score.enumMemberFidelity.precision).toBe(1) // every inferred member is real
      expect(score.enumMemberFidelity.comparedPositions).toBe(1)
    })

    test("an inferred member set with a spurious member (not in the original) lowers precision, not recall", () => {
      const original = t(types.object({ status: t(types.enum(["a", "b", "c"])) }))
      const inferred = t(types.object({ status: t(types.enum(["a", "b", "c", "z"])) }))
      const score = scoreInference(original, inferred)
      expect(score.enumMemberFidelity.recall).toBe(1)
      expect(score.enumMemberFidelity.precision).toBeCloseTo(3 / 4, 5)
    })

    test("positions where shape detection failed (not enum in inferred) are excluded, not scored as zero", () => {
      const original = t(types.object({ status: t(types.enum(["a", "b", "c"])) }))
      const inferred = t(types.object({ status: t(types.string) })) // shape not recovered at all
      const score = scoreInference(original, inferred)
      expect(score.enumDetection.recall).toBe(0) // shape axis catches this
      expect(score.enumMemberFidelity.comparedPositions).toBe(0) // nothing to compare — not double-penalized
      expect(score.enumMemberFidelity.f1).toBe(1) // vacuous perfect score, same convention as typeAccuracy's `compared === 0`
    })

    test("multiple enum positions are micro-averaged (aggregate member counts, not per-position mean)", () => {
      const original = t(
        types.object({
          a: t(types.enum(["1", "2", "3", "4"])), // 2/4 found
          b: t(types.enum(["x", "y"])), // 2/2 found
        }),
      )
      const inferred = t(
        types.object({
          a: t(types.enum(["1", "2"])),
          b: t(types.enum(["x", "y"])),
        }),
      )
      const score = scoreInference(original, inferred)
      // Micro-average: (2 + 2) matched / (4 + 2) actual = 4/6, not the
      // per-position mean of 0.5 and 1.0 (= 0.75).
      expect(score.enumMemberFidelity.recall).toBeCloseTo(4 / 6, 5)
      expect(score.enumMemberFidelity.comparedPositions).toBe(2)
    })

    test("a perfect member-set match scores 1 and is included in overallF1's rollup", () => {
      const original = t(types.object({ status: t(types.enum(["a", "b"])) }))
      const inferred = t(types.object({ status: t(types.enum(["a", "b"])) }))
      const score = scoreInference(original, inferred)
      expect(score.enumMemberFidelity.f1).toBe(1)
      expect(score.overallF1).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// runEvaluation — end-to-end generate -> infer -> score, and does quality
// improve with more data for the heuristics from-json-corpus.ts documents.
// ---------------------------------------------------------------------------

describe("runEvaluation", () => {
  test("produces one result per case x size", () => {
    const cases: EvalCase[] = [
      { name: "simple", schema: t(types.object({ a: t(types.string) })) },
    ]
    const summary = runEvaluation(cases, [5, 20])
    expect(summary.results).toHaveLength(2)
    expect(summary.bySize).toHaveLength(2)
    expect(summary.bySize.map((s) => s.n)).toEqual([5, 20])
  })

  test("every score in the summary is a finite number in [0, 1]", () => {
    const summary = runEvaluation(defaultLabeledCases, [5, 50])
    for (const r of summary.results) {
      expect(Number.isFinite(r.score.overallF1)).toBe(true)
      expect(r.score.overallF1).toBeGreaterThanOrEqual(0)
      expect(r.score.overallF1).toBeLessThanOrEqual(1)
    }
  })

  test("enum detection recall is nonzero once enough samples saturate K/N (Status Enum case)", () => {
    const enumCase = defaultLabeledCases.find((c) => c.name === "Status Enum")!
    const summary = runEvaluation([enumCase], [50])
    expect(summary.results[0]!.score.enumDetection.recall).toBeGreaterThan(0)
  })

  test("dict detection recall is nonzero once key-set growth is observable (Growing Dict case)", () => {
    const dictCase = defaultLabeledCases.find((c) => c.name === "Growing Dict")!
    const summary = runEvaluation([dictCase], [50])
    expect(summary.results[0]!.score.dictDetection.recall).toBeGreaterThan(0)
  })

  test("discriminated union recall is nonzero at a corpus large enough for DU detection to fire (Shape Discriminated Union case)", () => {
    const duCase = defaultLabeledCases.find((c) => c.name === "Shape Discriminated Union")!
    const summary = runEvaluation([duCase], [50])
    expect(summary.results[0]!.score.unionFidelity.recall).toBeGreaterThan(0)
  })

  test("the full default labeled corpus runs across the standard size sweep without throwing", () => {
    expect(() => runEvaluation(defaultLabeledCases)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// CFD-style discriminant search — measures whether `detectCfdDiscriminants`
// (from-json-corpus.ts's `tryDetectCfdDiscriminant`) improves union-fidelity
// on corpora whose discriminant field either (a) never gets typed
// `enum`/literal-union in the first place (so `tryDetectDU` never has a
// candidate to try), or (b) does get typed correctly but general structural
// splitting's single-linkage clustering (`trySplitDissimilarObjects`) chains
// its groups together via a shared-field intermediary. Hand-built corpora
// (not `generateCorpus`) so the exact K/N ratio and per-group sample counts
// that the gates in `scoreCfdCandidate` check are controlled directly,
// rather than left to a schema-driven PRNG.
// ---------------------------------------------------------------------------

describe("CFD-style discriminant search — union-fidelity comparison", () => {
  // PRECONDITION (see from-json-corpus.test.ts's CFD block for the full note):
  // the CFD pass only runs on discriminants the enum generalization declines
  // to type. The coverage rule now types this corpus's `tag` as an enum, so
  // `tryDetectDU` recovers the union first — a better outcome, but not the one
  // these tests are measuring. Set the precondition explicitly.
  const cfdOnly = { enumCoverageBar: 1.1 } as const
  test("recovers full union fidelity via chaining-immune exact-value grouping, where single-linkage's chaining failure leaves general splitting at zero", () => {
    // `stage` "p"/"q"/"r" groups chain under single-linkage: p={stage,shared1},
    // q={stage,shared1,shared2}, r={stage,shared2} — q is close enough to
    // both p and r that single-linkage's growing-cluster-union comparison
    // pulls all three into one merged cluster (see "clustering method
    // comparison" above for the same failure mode on plain structural
    // splitting). The CFD search groups by `stage`'s literal VALUE instead
    // of by incrementally-clustered field-set distance, so it never chains.
    const values = [
      { stage: "p", shared1: "x1" },
      { stage: "p", shared1: "x2" },
      { stage: "p", shared1: "x3" },
      { stage: "q", shared1: "y1", shared2: "z1" },
      { stage: "q", shared1: "y2", shared2: "z2" },
      { stage: "q", shared1: "y3", shared2: "z3" },
      { stage: "r", shared2: "w1" },
      { stage: "r", shared2: "w2" },
    ]
    const original = t(
      types.union([
        t(types.object({ stage: t(types.literal("p")), shared1: t(types.string) })),
        t(types.object({ stage: t(types.literal("q")), shared1: t(types.string), shared2: t(types.string) })),
        t(types.object({ stage: t(types.literal("r")), shared2: t(types.string) })),
      ]),
    )

    const withCfd = fromJsonCorpus(values, cfdOnly)
    const withoutCfd = fromJsonCorpus(values, { ...cfdOnly, detectCfdDiscriminants: false })

    const withScore = scoreInference(original, withCfd)
    const withoutScore = scoreInference(original, withoutCfd)

    expect(withCfd.meta.discriminator).toBe("stage")
    expect(withoutCfd.shape.kind).toBe("object") // chained into one merged record
    expect(withScore.unionFidelity.f1).toBe(1)
    expect(withoutScore.unionFidelity.f1).toBe(0)
    expect(withScore.overallF1).toBeGreaterThan(withoutScore.overallF1)
  })

  test("improves type accuracy (exact literal tag, not plain string) on a non-enum-typed discriminant that general splitting can still structurally separate", () => {
    // `tag` has K=4/N=10 (ratio 0.4), in `looksLikeEnum`'s ambiguous
    // 1/3-1/2 band for a string field — never typed `enum`, so
    // `tryDetectDU` has no candidate. General structural splitting still
    // recovers the union shape here (the four groups are fully disjoint, no
    // chaining risk), so `unionFidelity` alone doesn't distinguish the two
    // configs — but only the CFD path pins `tag` to a `literal` per
    // variant; general splitting leaves it as plain `string` in every
    // variant, which shows up as a lower `overallF1` via `typeAccuracy`.
    const values = [
      { tag: "a", x: 1, y: 2 },
      { tag: "a", x: 3, y: 4 },
      { tag: "a", x: 5, y: 6 },
      { tag: "b", p: 7, q: 8 },
      { tag: "b", p: 9, q: 10 },
      { tag: "b", p: 11, q: 12 },
      { tag: "c", m: 13, n: 14 },
      { tag: "c", m: 15, n: 16 },
      { tag: "d", r: 17, s: 18 },
      { tag: "d", r: 19, s: 20 },
    ]
    const original = t(
      types.union([
        t(types.object({ tag: t(types.literal("a")), x: t(types.integer), y: t(types.integer) })),
        t(types.object({ tag: t(types.literal("b")), p: t(types.integer), q: t(types.integer) })),
        t(types.object({ tag: t(types.literal("c")), m: t(types.integer), n: t(types.integer) })),
        t(types.object({ tag: t(types.literal("d")), r: t(types.integer), s: t(types.integer) })),
      ]),
    )

    const withCfd = fromJsonCorpus(values, cfdOnly)
    const withoutCfd = fromJsonCorpus(values, { ...cfdOnly, detectCfdDiscriminants: false })

    const withScore = scoreInference(original, withCfd)
    const withoutScore = scoreInference(original, withoutCfd)

    // Both recover the union shape (unionFidelity ties)...
    expect(withScore.unionFidelity.f1).toBe(1)
    expect(withoutScore.unionFidelity.f1).toBe(1)
    // ...but only the CFD path gets the discriminant field's exact type
    // right, which overallF1 (folding in typeAccuracy) picks up.
    expect(withScore.overallF1).toBe(1)
    expect(withoutScore.overallF1).toBeLessThan(withScore.overallF1)
  })
})

// ---------------------------------------------------------------------------
// Clustering method comparison — measures the three `clusteringMethod`
// options (`from-json-corpus.ts`'s `trySplitDissimilarObjects`) against each
// other on schemas chosen to isolate the specific failure mode each
// alternative was built to fix. None of these use a discriminant field, so
// `tryDetectDU` never fires — recovery depends entirely on general
// structural splitting.
// ---------------------------------------------------------------------------

describe("clustering method comparison", () => {
  // Two fully disjoint object shapes, no shared fields at all. The easy
  // case: every method should split this correctly regardless of threshold.
  const disjointPolymorphic = t(
    types.union([
      t(types.object({ userId: t(types.integer), userName: t(types.string), userEmail: t(types.string) })),
      t(types.object({ orderId: t(types.integer), total: t(types.number), items: t(types.integer) })),
    ]),
  )

  // Three shapes in a chain: A-B and B-C each overlap on one field, but A-C
  // share nothing (Jaccard distance 1.0). single-linkage compares each new
  // sample against the growing cluster union rather than its individual
  // members, so B's presence pulls A and C into the same cluster even
  // though they're maximally dissimilar on their own — the "chaining"
  // failure mode complete-linkage exists to avoid.
  const chainingRisk = t(
    types.union([
      t(types.object({ p: t(types.integer), shared1: t(types.string) })),
      t(types.object({ shared1: t(types.string), shared2: t(types.string) })),
      t(types.object({ shared2: t(types.string), q: t(types.integer) })),
    ]),
  )

  // Two exact, recurring shapes differing by one field (Jaccard distance
  // 1/3, under the default 0.5 threshold) — the "polymorphic API response"
  // pattern key-signature clustering targets. Modeled as a real union (both
  // fields required per variant, not optional) so `generateCorpus` always
  // emits the exact signature for whichever variant it picked, with no
  // partial-field noise.
  const apiResponseVariants = t(
    types.union([
      t(types.object({ id: t(types.integer), name: t(types.string) })),
      t(types.object({ id: t(types.integer), name: t(types.string), extra: t(types.boolean) })),
    ]),
  )

  function runWith(method: "single-linkage" | "complete-linkage" | "key-signature", threshold?: number) {
    const cases: EvalCase[] = [
      { name: "disjoint", schema: disjointPolymorphic, config: { clusteringMethod: method } },
      {
        name: "chaining-risk",
        schema: chainingRisk,
        config: { clusteringMethod: method, objectSplitThreshold: threshold ?? 0.5 },
      },
      { name: "api-variants", schema: apiResponseVariants, config: { clusteringMethod: method } },
    ]
    const summary = runEvaluation(cases, [50])
    const byName = new Map(summary.results.map((r) => [r.name, r.score]))
    return {
      disjoint: byName.get("disjoint")!,
      chainingRisk: byName.get("chaining-risk")!,
      apiVariants: byName.get("api-variants")!,
    }
  }

  test("all three methods correctly split fully disjoint shapes", () => {
    for (const method of ["single-linkage", "complete-linkage", "key-signature"] as const) {
      const { disjoint } = runWith(method)
      expect(disjoint.unionFidelity.f1).toBe(1)
      expect(disjoint.overallF1).toBe(1)
    }
  })

  test("single-linkage chains the A-B-C shapes into one merged object, losing the union entirely", () => {
    const { chainingRisk: score } = runWith("single-linkage", 0.8)
    expect(score.unionFidelity.f1).toBe(0)
  })

  test("complete-linkage avoids the chaining failure single-linkage falls into on the same corpus/threshold", () => {
    const { chainingRisk: score } = runWith("complete-linkage", 0.8)
    expect(score.unionFidelity.f1).toBe(1)
    // Recovers the union shape (unlike single-linkage, which loses it
    // entirely), but still only as 2 clusters (A+B merged, C separate) —
    // complete-linkage's conservatism stops the chained A-C merge but
    // doesn't fully separate A from B either, since A-B's own distance is
    // within threshold on its own merits.
    expect(score.unionFidelity.avgVariantCountDiff).toBe(1)
  })

  test("key-signature also avoids chaining, since it never compares field-set distance at all", () => {
    const { chainingRisk: score } = runWith("key-signature", 0.8)
    expect(score.unionFidelity.f1).toBe(1)
  })

  test("single-linkage and complete-linkage both merge near-identical API-variant shapes under default threshold", () => {
    for (const method of ["single-linkage", "complete-linkage"] as const) {
      const { apiVariants } = runWith(method)
      expect(apiVariants.unionFidelity.f1).toBe(0)
    }
  })

  test("key-signature recovers the polymorphic-API-response pattern that distance-threshold methods miss", () => {
    const { apiVariants } = runWith("key-signature")
    expect(apiVariants.unionFidelity.f1).toBe(1)
    expect(apiVariants.overallF1).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Clustering method comparison — statistically backed re-run of the block
// above. Every claim there ran at exactly one seed (`runEvaluation`'s
// `${name}:${n}` derivation), so "single-linkage got unionFidelity.f1 === 0"
// is an N=1 sample of a random variable (corpus generation is randomized),
// not a demonstrated property of the method. This block re-runs the same
// scenarios through `runEvaluationTrials` at many independent seeds and
// tests the distributional claim instead: "single-linkage's F1 is
// significantly lower than complete-linkage's, p < 0.05 via paired
// bootstrap" — using `pairedBootstrapTest` on same-index trial pairs, which
// share a generated corpus (differing only in `clusteringMethod`), so
// corpus-generation noise cancels out of the comparison.
//
// TRIAL_COUNT: the design suggests 20-50 trials for production-quality
// runs; this suite uses the low end (25) to keep `bun test` fast — the
// scenarios here have large, consistent effect sizes (a real algorithmic
// difference, not a marginal threshold tweak), so 25 trials is already
// more than enough to clear p < 0.05 without flakiness. A tuning
// investigation with a smaller expected effect size should use more.
// ---------------------------------------------------------------------------

describe("clustering method comparison (multi-trial, statistically backed)", () => {
  const TRIAL_COUNT = 25

  const disjointPolymorphic = t(
    types.union([
      t(types.object({ userId: t(types.integer), userName: t(types.string), userEmail: t(types.string) })),
      t(types.object({ orderId: t(types.integer), total: t(types.number), items: t(types.integer) })),
    ]),
  )

  const chainingRisk = t(
    types.union([
      t(types.object({ p: t(types.integer), shared1: t(types.string) })),
      t(types.object({ shared1: t(types.string), shared2: t(types.string) })),
      t(types.object({ shared2: t(types.string), q: t(types.integer) })),
    ]),
  )

  const apiResponseVariants = t(
    types.union([
      t(types.object({ id: t(types.integer), name: t(types.string) })),
      t(types.object({ id: t(types.integer), name: t(types.string), extra: t(types.boolean) })),
    ]),
  )

  function trialsWith(
    name: string,
    schema: EvalCase["schema"],
    method: "single-linkage" | "complete-linkage" | "key-signature",
    threshold?: number,
  ) {
    const cases: EvalCase[] = [
      {
        name,
        schema,
        config: threshold === undefined
          ? { clusteringMethod: method }
          : { clusteringMethod: method, objectSplitThreshold: threshold },
      },
    ]
    return runEvaluationTrials(cases, [50], TRIAL_COUNT).results[0]!
  }

  test("all three methods correctly split fully disjoint shapes across every trial (mean overallF1 == 1)", () => {
    for (const method of ["single-linkage", "complete-linkage", "key-signature"] as const) {
      const result = trialsWith("disjoint", disjointPolymorphic, method)
      expect(result.stats.overallF1.mean).toBe(1)
      expect(result.stats.overallF1.stddev).toBe(0)
    }
  })

  test("single-linkage's unionFidelity F1 is significantly lower than complete-linkage's on the chaining scenario", () => {
    const single = trialsWith("chaining-risk", chainingRisk, "single-linkage", 0.8)
    const complete = trialsWith("chaining-risk", chainingRisk, "complete-linkage", 0.8)

    // Sanity check the paired precondition: same case name/n/trialCount on
    // both sides means each trial index drew from the same generated
    // corpus, so the two series are legitimately paired.
    expect(single.trials.length).toBe(TRIAL_COUNT)
    expect(complete.trials.length).toBe(TRIAL_COUNT)

    const result = pairedBootstrapTest(
      axisValues(complete, "unionFidelityF1"),
      axisValues(single, "unionFidelityF1"),
      mulberry32(0xbeef),
    )
    expect(result.meanDiff).toBeGreaterThan(0)
    expect(result.significant).toBe(true)
    expect(result.pValue).toBeLessThan(0.05)
    // complete-linkage recovers the union on every trial; single-linkage
    // sometimes chains and sometimes doesn't depending on which corpus
    // values happened to land close together under its greedy-union
    // distance — exactly the single-seed-anecdote problem this multi-trial
    // block exists to replace ("always 0" doesn't hold across seeds, but
    // "significantly lower than complete-linkage" does).
    expect(complete.stats.unionFidelityF1.mean).toBe(1)
    expect(single.stats.unionFidelityF1.mean).toBeLessThan(complete.stats.unionFidelityF1.mean)
  })

  test("key-signature also avoids chaining across every trial, since it never compares field-set distance at all", () => {
    const result = trialsWith("chaining-risk", chainingRisk, "key-signature", 0.8)
    expect(result.stats.unionFidelityF1.mean).toBe(1)
    expect(result.stats.unionFidelityF1.stddev).toBe(0)
  })

  test("key-signature's unionFidelity F1 is significantly higher than single-linkage's and complete-linkage's on near-identical API-variant shapes", () => {
    const keySig = trialsWith("api-variants", apiResponseVariants, "key-signature")
    for (const method of ["single-linkage", "complete-linkage"] as const) {
      const other = trialsWith("api-variants", apiResponseVariants, method)
      const result = pairedBootstrapTest(
        axisValues(keySig, "unionFidelityF1"),
        axisValues(other, "unionFidelityF1"),
        mulberry32(0xf00d),
      )
      expect(result.meanDiff).toBeGreaterThan(0)
      expect(result.significant).toBe(true)
      expect(result.pValue).toBeLessThan(0.05)
      expect(other.stats.unionFidelityF1.mean).toBe(0)
    }
    expect(keySig.stats.unionFidelityF1.mean).toBe(1)
    expect(keySig.stats.overallF1.mean).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Generator profiles (Phase 2 of the JSON-inference evaluation rigor plan)
// — every eval result up to this point was implicitly generated under one
// unstated policy: uniform random picks, flat presence/null rates. These
// tests verify each new `GeneratorProfile` actually produces the
// distributional shape it claims, then use that shape to probe
// from-json-corpus.ts's thresholds for behavior uniform sampling can't
// exercise: skewed real-world field/enum distributions, exact threshold
// boundaries, and enum false positives on high-cardinality fields.
// ---------------------------------------------------------------------------

describe("generator profiles — distributional shape", () => {
  const presenceSchema = t(
    types.object({
      required: t(types.string),
      f1: { shape: types.string, meta: { optional: true } },
      f2: { shape: types.string, meta: { optional: true } },
      f3: { shape: types.string, meta: { optional: true } },
      f4: { shape: types.string, meta: { optional: true } },
    }),
  )

  function presenceRates(profile: GeneratorProfile | undefined, n = 3000): Record<string, number> {
    const corpus = generateCorpus(presenceSchema, n, profile === undefined ? { seed: "presence" } : { seed: "presence", profile }) as Record<string, unknown>[]
    const rates: Record<string, number> = {}
    for (const f of ["f1", "f2", "f3", "f4"]) rates[f] = corpus.filter((v) => f in v).length / n
    return rates
  }

  test("uniform keeps optional-field presence flat across fields", () => {
    const rates = presenceRates(undefined)
    for (const f of ["f1", "f2", "f3", "f4"]) expect(rates[f]!).toBeCloseTo(0.75, 1)
  })

  test("zipfian-presence skews field presence by declaration rank: near-always-present head, long rare tail", () => {
    const rates = presenceRates({ kind: "zipfian-presence" })
    // rank 1 -> weight 1/1^1.2 = 1.0 exactly -> always present.
    expect(rates.f1!).toBeGreaterThan(0.95)
    // Strictly decreasing by rank, and a wide spread vs. uniform's ~flat rates.
    expect(rates.f1!).toBeGreaterThan(rates.f2!)
    expect(rates.f2!).toBeGreaterThan(rates.f3!)
    expect(rates.f3!).toBeGreaterThan(rates.f4!)
    expect(rates.f1! - rates.f4!).toBeGreaterThan(0.5)
  })

  const enumSchema = t(types.object({ status: t(types.enum(["active", "pending", "done", "archived"])) }))

  function enumFrequencies(profile: GeneratorProfile | undefined, n = 4000): Record<string, number> {
    const corpus = generateCorpus(enumSchema, n, profile === undefined ? { seed: "enum-freq" } : { seed: "enum-freq", profile }) as Record<string, unknown>[]
    const counts: Record<string, number> = {}
    for (const v of corpus) counts[v.status as string] = (counts[v.status as string] ?? 0) + 1
    return Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, c / n]))
  }

  test("uniform keeps enum-member frequency roughly flat", () => {
    const freq = enumFrequencies(undefined)
    for (const member of ["active", "pending", "done", "archived"]) expect(freq[member]!).toBeCloseTo(0.25, 1)
  })

  test("zipfian-presence skews enum-member frequency by declaration order: first member dominates", () => {
    const freq = enumFrequencies({ kind: "zipfian-presence" })
    // Declared order is active, pending, done, archived -> weights 1, 0.435, 0.268, 0.189 (normalized).
    expect(freq.active!).toBeGreaterThan(0.4) // rank-1 weight normalizes to ~0.53
    expect(freq.archived!).toBeLessThan(0.2) // rank-4 weight normalizes to ~0.10
    expect(freq.active!).toBeGreaterThan(freq.pending!)
    expect(freq.pending!).toBeGreaterThan(freq.done!)
    expect(freq.done!).toBeGreaterThan(freq.archived!)
  })

  test("adversarial-boundary lands enum K/N exactly at 1/3 (looksLikeEnum's stronglyRepetitive cutover)", () => {
    // 60 declared members (comfortably more than any target K) so the
    // achieved K isn't clamped by the schema's own member count.
    const manyMembersSchema = t(types.object({ tag: t(types.enum(Array.from({ length: 60 }, (_, i) => `v${i}`))) }))
    const n = 90 // 90 / 3 = 30 exactly, so K/N lands on the cutover with no rounding.
    const corpus = generateCorpus(manyMembersSchema, n, { seed: "adv-enum", profile: { kind: "adversarial-boundary" } }) as Record<string, unknown>[]
    const K = new Set(corpus.map((v) => v.tag)).size
    expect(K).toBe(30)
    expect(K / n).toBeCloseTo(1 / 3, 5)
  })

  test("adversarial-boundary's epsilon shifts the targeted K/N away from the exact cutover", () => {
    const manyMembersSchema = t(types.object({ tag: t(types.enum(Array.from({ length: 60 }, (_, i) => `v${i}`))) }))
    const n = 90
    const corpus = generateCorpus(manyMembersSchema, n, { seed: "adv-enum-eps", profile: { kind: "adversarial-boundary", epsilon: 0.1 } }) as Record<string, unknown>[]
    const K = new Set(corpus.map((v) => v.tag)).size
    expect(K).toBe(Math.round(n * (1 / 3 + 0.1))) // 39
    expect(K / n).toBeGreaterThan(1 / 3)
  })

  test("adversarial-boundary lands field-set Jaccard distance exactly at 0.1 (tryDetectDU's group-distinctness cutover)", () => {
    // 1 required + 9 optional fields: omitCount = round(0.1 * 10) = 1, so
    // exactly one optional field differs between the two sample-index
    // clusters, and every other field is forced always-present — giving a
    // clean symmetric difference of 1 over a union of 10.
    const jaccardSchema = t(
      types.object({
        req: t(types.string),
        o1: { shape: types.string, meta: { optional: true } },
        o2: { shape: types.string, meta: { optional: true } },
        o3: { shape: types.string, meta: { optional: true } },
        o4: { shape: types.string, meta: { optional: true } },
        o5: { shape: types.string, meta: { optional: true } },
        o6: { shape: types.string, meta: { optional: true } },
        o7: { shape: types.string, meta: { optional: true } },
        o8: { shape: types.string, meta: { optional: true } },
        o9: { shape: types.string, meta: { optional: true } },
      }),
    )
    const n = 100
    const corpus = generateCorpus(jaccardSchema, n, { seed: "adv-jaccard", profile: { kind: "adversarial-boundary" } }) as Record<string, unknown>[]
    const keysA = new Set(Object.keys(corpus[0]!)) // cluster A: sampleIndex < n/2
    const keysB = new Set(Object.keys(corpus[n - 1]!)) // cluster B: sampleIndex >= n/2
    const union = new Set([...keysA, ...keysB])
    let symDiff = 0
    for (const k of union) if (keysA.has(k) !== keysB.has(k)) symDiff++
    expect(symDiff / union.size).toBeCloseTo(0.1, 5)
  })

  test("adversarial-boundary lands dict key-growth ratio near 0.5 (walkAndDetectDicts's growthRatio cutover) when map size is pinned to 1 entry/sample", () => {
    // growthRatio = (distinct keys added) / (sample count), unnormalized by
    // per-sample map size — pinning mapSizeRange to [1, 1] is what makes the
    // per-entry "fresh with probability 0.5+epsilon" targeting land on the
    // actual metric from-json-corpus.ts computes (see AdversarialBoundaryProfile doc).
    const dictSchema = t(types.object({ scores: t(types.map(t(types.string), t(types.integer))) }))
    const n = 200
    const corpus = generateCorpus(dictSchema, n, {
      seed: "adv-dict", mapSizeRange: [1, 1], profile: { kind: "adversarial-boundary" },
    }) as Record<string, unknown>[]
    const allKeys = new Set<string>()
    const growthPoints: number[] = []
    for (const v of corpus) {
      for (const k of Object.keys(v.scores as object)) allKeys.add(k)
      growthPoints.push(allKeys.size)
    }
    const growthRatio = (growthPoints[growthPoints.length - 1]! - growthPoints[0]!) / corpus.length
    expect(growthRatio).toBeGreaterThan(0.35)
    expect(growthRatio).toBeLessThan(0.65)
  })

  const hcSchema = t(
    types.object({
      id: t(types.string),
      count: t(types.integer),
      status: t(types.enum(["active", "archived"])),
    }),
  )

  test("high-cardinality-id makes plain string/integer leaves near-unique per sample", () => {
    const n = 300
    const corpus = generateCorpus(hcSchema, n, { seed: "hc-shape", profile: { kind: "high-cardinality-id" } }) as Record<string, unknown>[]
    const idDistinct = new Set(corpus.map((v) => v.id)).size
    const countDistinct = new Set(corpus.map((v) => v.count)).size
    expect(idDistinct / n).toBeGreaterThan(0.9)
    expect(countDistinct / n).toBeGreaterThan(0.9)
    // The real enum field is untouched by this profile — only string/integer leaves are affected.
    for (const v of corpus) expect(["active", "archived"]).toContain(v.status as string)
  })

  const dirtyOutlierProfileSchema = t(
    types.object({ v: t(types.union([t(types.integer), t(types.string)])) }),
  )

  function unionVariantRates(profile: GeneratorProfile, n = 3000): { integer: number; string: number } {
    const corpus = generateCorpus(dirtyOutlierProfileSchema, n, { seed: "dirty-outlier-shape", profile }) as Record<string, unknown>[]
    let integer = 0
    let string = 0
    for (const v of corpus) {
      if (typeof v.v === "number") integer++
      else if (typeof v.v === "string") string++
    }
    return { integer: integer / n, string: string / n }
  }

  test("uniform union-variant sampling stays flat -- pickUnionVariant is only overridden by dirty-outlier", () => {
    const rates = unionVariantRates({ kind: "uniform" })
    expect(rates.integer).toBeCloseTo(0.5, 1)
    expect(rates.string).toBeCloseTo(0.5, 1)
  })

  test("dirty-outlier skews a 2-variant union's sampling toward the first-declared variant at the default ratio (0.95, past walkAndDetectDirty's 0.9 cutover)", () => {
    const rates = unionVariantRates({ kind: "dirty-outlier" })
    expect(rates.integer).toBeGreaterThan(0.9)
    expect(rates.string).toBeLessThan(0.1)
  })

  test("dirty-outlier's dominantRatio controls the skew directly, including below the cutover (negative-control boundary)", () => {
    const skewed = unionVariantRates({ kind: "dirty-outlier", dominantRatio: 0.7 })
    expect(skewed.integer).toBeCloseTo(0.7, 1)
    expect(skewed.string).toBeCloseTo(0.3, 1)

    const belowCutover = unionVariantRates({ kind: "dirty-outlier", dominantRatio: 0.85 })
    expect(belowCutover.integer).toBeCloseTo(0.85, 1)
    expect(belowCutover.integer).toBeLessThan(0.9)
  })

  test("dirty-outlier falls through to uniform picking for unions of arity other than 2", () => {
    const threeWaySchema = t(
      types.object({ v: t(types.union([t(types.integer), t(types.string), t(types.boolean)])) }),
    )
    const n = 3000
    const corpus = generateCorpus(threeWaySchema, n, {
      seed: "dirty-outlier-3way", profile: { kind: "dirty-outlier" },
    }) as Record<string, unknown>[]
    const counts = { number: 0, string: 0, boolean: 0 }
    for (const v of corpus) counts[typeof v.v as "number" | "string" | "boolean"]++
    for (const c of Object.values(counts)) expect(c / n).toBeCloseTo(1 / 3, 1)
  })
})

// ---------------------------------------------------------------------------
// dirty-outlier profile — threshold behavior against the REAL
// `walkAndDetectDirty` heuristic (from-json-corpus.ts), not just the
// generator's own claimed distribution. Mirrors the adversarial-boundary
// threshold-behavior tests above: land a corpus just past the 0.9 cutover
// (positive control — collapsing should fire) and just below it (negative
// control — collapsing must NOT fire).
// ---------------------------------------------------------------------------

describe("dirty-outlier profile — walkAndDetectDirty threshold behavior", () => {
  // The dominant variant is `uint8` (fixed [0,255] range), not the generic
  // `types.integer` -- a wide-range integer variant spans multiple narrow
  // integer widths, and `walkAndDetectDirty` re-infers each raw value's
  // type from scratch (config-less `fromJson`) and strictly `shapeEqual`s
  // it against the corpus-MERGED (possibly wider) variant type, so most
  // individual values silently fail to match and collapsing never fires
  // even at extreme skew. See `dirtyOutlierSchema`'s doc in inference-eval.ts.
  const dirtySchema = t(
    types.object({ v: t(types.union([uint8(), t(types.string)])) }),
  )

  test("above the 0.9 cutover (dominantRatio 0.95): detectDirtyData collapses the minority variant and reports a warning", () => {
    const corpus = generateCorpus(dirtySchema, 300, {
      seed: "dirty-above", profile: { kind: "dirty-outlier", dominantRatio: 0.95 },
    })
    const inferred = fromJsonCorpus(corpus, { detectDirtyData: true })
    const fields = (inferred.shape as { fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }> }).fields
    expect(fields.v!.shape.kind).not.toBe("union")
    expect(typeof fields.v!.meta.dirtyDataWarning).toBe("string")
  })

  test("below the 0.9 cutover (dominantRatio 0.85): detectDirtyData must NOT collapse -- both variants stay, negative control", () => {
    const corpus = generateCorpus(dirtySchema, 300, {
      seed: "dirty-below", profile: { kind: "dirty-outlier", dominantRatio: 0.85 },
    })
    const inferred = fromJsonCorpus(corpus, { detectDirtyData: true })
    const fields = (inferred.shape as { fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }> }).fields
    expect(fields.v!.shape.kind).toBe("union")
    expect(fields.v!.meta.dirtyDataWarning).toBeUndefined()
  })

  test("with detectDirtyData off, the skewed corpus still infers as a union regardless of skew", () => {
    const corpus = generateCorpus(dirtySchema, 300, {
      seed: "dirty-off", profile: { kind: "dirty-outlier", dominantRatio: 0.95 },
    })
    const inferred = fromJsonCorpus(corpus, { detectDirtyData: false })
    const fields = (inferred.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.v!.shape.kind).toBe("union")
  })
})

// ---------------------------------------------------------------------------
// Generator profiles — threshold-behavior findings. Each test runs the
// labeled cases through the full generate -> infer -> score pipeline under
// a profile and reports/asserts what actually changes vs. the uniform
// baseline, per the Phase 2 plan ("treat any genuinely revealed threshold
// weakness as a finding to report, not something to silently patch").
// ---------------------------------------------------------------------------

describe("generator profiles — threshold-behavior findings", () => {
  const TRIAL_COUNT = 40

  test("SUPERSEDED FINDING: zipfian skew no longer buys a shape-detection advantage", () => {
    // ORIGINAL FINDING (K/N-only rule): zipfian-presence significantly
    // IMPROVED enum-detection F1 at small N, because skew concentrates
    // samples on 1-2 members so observed K stays low and the ratio test
    // saturates sooner. The very next test recorded that this "gain" was an
    // illusion — the same sampling pattern silently drops the rare members.
    //
    // The coverage rule closes that gap directly rather than by a separate
    // guard: rare members are the ones seen exactly once, and singletons are
    // what the Good-Turing term measures. Skew now REDUCES estimated coverage
    // instead of flattering the ratio, so the spurious advantage is gone.
    // Measured at N=10, 40 trials: meanDiff -0.075, p=0.47, not significant.
    const statusEnumCase = defaultLabeledCases.find((c) => c.name === "Status Enum")!
    const n = 10
    const uniform = runEvaluationTrials([statusEnumCase], [n], TRIAL_COUNT).results[0]!
    const zipfianCase: EvalCase = {
      ...statusEnumCase,
      generateOptions: { ...statusEnumCase.generateOptions, profile: { kind: "zipfian-presence" } },
    }
    const zipfian = runEvaluationTrials([zipfianCase], [n], TRIAL_COUNT).results[0]!

    const result = pairedBootstrapTest(
      axisValues(zipfian, "enumDetectionF1"),
      axisValues(uniform, "enumDetectionF1"),
      mulberry32(0xa11e),
    )
    // no longer a significant advantage in either direction
    expect(result.significant).toBe(false)
    expect(result.meanDiff).toBeLessThanOrEqual(0)
  })

  test("FINDING (member-set fidelity): skew still costs real members, and the shape metric no longer disagrees", () => {
    // The corrected metric's warning stands: at N=10 a zipfian corpus still
    // fails to show the tail members, so member-set fidelity is significantly
    // worse (meanDiff -0.052, p=0.001). What CHANGED is that the shape metric
    // no longer reports the opposite. Under the old rule the two axes pointed
    // in opposite directions, which is what made the shape reading an
    // illusion; under the coverage rule they agree in sign, so shape
    // detection is no longer blind to the tail it is dropping.
    const statusEnumCase = defaultLabeledCases.find((c) => c.name === "Status Enum")!
    const n = 10
    const uniform = runEvaluationTrials([statusEnumCase], [n], TRIAL_COUNT).results[0]!
    const zipfianCase: EvalCase = {
      ...statusEnumCase,
      generateOptions: { ...statusEnumCase.generateOptions, profile: { kind: "zipfian-presence" } },
    }
    const zipfian = runEvaluationTrials([zipfianCase], [n], TRIAL_COUNT).results[0]!

    const memberResult = pairedBootstrapTest(
      axisValues(zipfian, "enumMemberFidelityF1"),
      axisValues(uniform, "enumMemberFidelityF1"),
      mulberry32(0xa11e),
    )
    expect(memberResult.meanDiff).toBeLessThan(0)
    expect(memberResult.significant).toBe(true)
    expect(memberResult.pValue).toBeLessThan(0.05)

    // the two axes now agree in sign — no shape-vs-members divergence
    const shapeResult = pairedBootstrapTest(
      axisValues(zipfian, "enumDetectionF1"),
      axisValues(uniform, "enumDetectionF1"),
      mulberry32(0xa11e),
    )
    expect(shapeResult.meanDiff).toBeLessThanOrEqual(0)
  })

  test("FINDING: high-cardinality-id fields are NOT flagged as false-positive enums under current thresholds -- enum-detection precision stays 1 across sizes", () => {
    // Negative control: `id` (string) and `count` (integer) are near-unique
    // per sample; ground truth is "must not be detected as enum". This
    // exercises the PRECISION axis of enumDetection, which none of
    // defaultLabeledCases specifically probes (they all test recall).
    const hcCase: EvalCase = {
      name: "HC probe",
      schema: t(
        types.object({
          id: t(types.string),
          count: t(types.integer),
          status: t(types.enum(["active", "archived"])),
        }),
      ),
      generateOptions: { profile: { kind: "high-cardinality-id" } },
    }
    for (const n of [10, 20, 50, 100]) {
      const summary = runEvaluation([hcCase], [n])
      expect(summary.results[0]!.score.enumDetection.precision).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Ablation runner (Phase 3) — leave-one-out over ResolveStrategy's boolean
// detection toggles, reported on two axes (discriminative power / overfit
// rate) per the JSONoid-derived design. TRIAL_COUNT is kept low (15) for the
// same reason Phase 1/2 picked their own low ends (25/40): `ablationRunner`
// runs O(signals) x 4 (on/off x positive/negative) `runEvaluationTrials`
// calls per invocation, so trial count multiplies total runtime directly.
// The signals measured here have large, consistent effects (detectEnums,
// detectDicts) or a genuine tie (the three union-recovery mechanisms, which
// back each other up under leave-one-out — see the FINDING test below), so
// 15 trials is enough to be stable without materially slowing `bun test`.
// ---------------------------------------------------------------------------

describe("ablationRunner", () => {
  const TRIAL_COUNT = 15

  test("every ResolveStrategy boolean toggle gets a report, with automatic positive/negative case classification", () => {
    const reports = ablationRunner(defaultLabeledCases, [50], TRIAL_COUNT)
    const bySignal = new Map(reports.map((r) => [r.signal, r]))
    expect(bySignal.size).toBe(6)
    for (const signal of [
      "detectEnums", "detectDiscriminatedUnions", "detectDicts",
      "detectCfdDiscriminants", "splitDissimilarObjects", "detectDirtyData",
    ] as const) {
      expect(bySignal.has(signal)).toBe(true)
    }

    // Positive-control classification: a case only counts as positive for a
    // signal if its OWN schema actually contains that shape.
    const enums = bySignal.get("detectEnums")!
    expect(enums.positiveCaseNames).toContain("Status Enum")
    expect(enums.positiveCaseNames).toContain("E-commerce Order") // has a `status` enum field
    expect(enums.negativeCaseNames).toContain("Recursive Tree") // no enum anywhere in the schema
    expect(enums.negativeCaseNames).not.toContain("Status Enum")

    const dicts = bySignal.get("detectDicts")!
    expect(dicts.positiveCaseNames).toContain("Growing Dict")
    expect(dicts.negativeCaseNames).toContain("Status Enum") // no map in this schema
  })

  test("FINDING: detectEnums has strong, significant discriminative power and zero measured overfit under current thresholds", () => {
    const report = ablationRunner(defaultLabeledCases, [50], TRIAL_COUNT).find((r) => r.signal === "detectEnums")!
    const power = report.discriminativePower as AblationDelta
    expect(power.onMean).toBe(1) // enum shape always recovered when the signal is on
    expect(power.offMean).toBe(0) // never recovered when off -- there is no other mechanism that produces `enum`
    expect(power.significant).toBe(true)
    expect(power.pValue).toBeLessThan(0.05)

    const overfit = report.overfitRate as AblationDelta
    expect(overfit.onMean).toBe(1) // precision on the negative-control cases stays perfect...
    expect(overfit.meanDiff).toBe(0) // ...identically whether the signal is on or off
    expect(overfit.significant).toBe(false)
  })

  test("FINDING: detectDicts has strong, significant discriminative power and zero measured overfit under current thresholds", () => {
    const report = ablationRunner(defaultLabeledCases, [50], TRIAL_COUNT).find((r) => r.signal === "detectDicts")!
    const power = report.discriminativePower as AblationDelta
    expect(power.onMean).toBe(1)
    expect(power.offMean).toBe(0)
    expect(power.significant).toBe(true)

    const overfit = report.overfitRate as AblationDelta
    expect(overfit.meanDiff).toBe(0)
    expect(overfit.significant).toBe(false)
  })

  test("FINDING: the three union-recovery signals (detectDiscriminatedUnions, splitDissimilarObjects, detectCfdDiscriminants) show ZERO leave-one-out discriminative power on this case set, because each backs up the others", () => {
    // This is a real leave-one-out property, not a bug in the ablation: on
    // `defaultLabeledCases`, every union-shaped case that ONE of these three
    // mechanisms would miss is still recovered by at least one of the other
    // two (e.g. `trySplitDissimilarObjects`'s general structural splitting
    // covers ground a discriminant-based `tryDetectDU` would also cover).
    // Leave-one-out ablation can only show a signal's OWN discriminative
    // power net of redundancy with its siblings -- it is not, and does not
    // claim to be, evidence that any of the three is individually useless;
    // the full power set (JSONoid-style, `O(2^signals)`) would be needed to
    // decompose the redundancy, which is exactly why this runner is
    // documented as leave-one-out, not power-set.
    //
    // onMean/offMean are no longer a clean exact 1 now that "Dirty Outlier
    // Field" (added for the `detectDirtyData` ablation -- see the
    // dedicated FINDING test below) is in the positive-control set: its
    // 0.95-dominant-ratio corpus has a small (~0.95^50 ≈ 8%) per-trial
    // chance of never sampling the minority variant at all, which drops
    // that one case's recall regardless of any of these three toggles.
    // That's sampling luck shared identically by both the ON and OFF runs
    // (same seeds), not a real effect of the signals -- meanDiff staying
    // exactly 0 is the property this test actually cares about.
    const reports = ablationRunner(defaultLabeledCases, [50], TRIAL_COUNT)
    for (const signal of ["detectDiscriminatedUnions", "splitDissimilarObjects", "detectCfdDiscriminants"] as const) {
      const power = reports.find((r) => r.signal === signal)!.discriminativePower as AblationDelta
      expect(power.onMean).toBeGreaterThan(0.95)
      expect(power.onMean).toBe(power.offMean)
      expect(power.meanDiff).toBe(0)
      expect(power.significant).toBe(false)
    }
  })

  test("FINDING: detectDirtyData is now measurable (via the dirty-outlier profile), and it HURTS union recall on this case set -- collapsing a skewed-but-genuine minority variant costs more than it's shown to gain", () => {
    // Before the `dirty-outlier` `GeneratorProfile` existed, `generateValue`'s
    // union branch always picked a variant uniformly, so `generateCorpus`
    // essentially never produced the >90%-skewed 2-variant union
    // `walkAndDetectDirty` (from-json-corpus.ts) looks for -- the ablation
    // could only report a tied null result, not a real measurement. The
    // "Dirty Outlier Field" case in `defaultLabeledCases` closes that gap:
    // its `count` field is declared as a genuine 2-variant union
    // (`uint8 | string`) whose ground truth says BOTH variants are real,
    // generated under `dirty-outlier`'s default 0.95 dominant ratio so the
    // corpus lands past `walkAndDetectDirty`'s 0.9 cutover.
    //
    // The measured result: `detectDirtyData` ON collapses that union and
    // discards the (real, if rare) minority variant, which is a genuine
    // RECALL cost against this ground truth -- not a wash, not noise.
    // `walkAndDetectDirty` has no way to distinguish "a rare but legitimate
    // variant" from "sampling contamination that isn't really part of the
    // schema" -- it only looks at the raw skew, so it always pays this cost
    // whenever a real schema happens to be skewed. This ablation set has no
    // case where a corpus is contaminated with values that are genuinely
    // NOT part of the schema (as opposed to a rare real variant), so it
    // cannot show the heuristic's intended upside (recovering a clean type
    // from a corpus polluted with real garbage) -- only its downside on the
    // cases available. That upside scenario is exercised directly, at the
    // `from-json-corpus.ts` level, by the "walkAndDetectDirty threshold
    // behavior" tests above/below.
    const report = ablationRunner(defaultLabeledCases, [50], TRIAL_COUNT).find((r) => r.signal === "detectDirtyData")!

    const power = report.discriminativePower as AblationDelta
    expect(power.onMean).toBeLessThan(power.offMean)
    expect(power.meanDiff).toBeLessThan(-0.1)
    expect(power.significant).toBe(true)
    expect(power.pValue).toBeLessThan(0.05)

    // No case in this set has ground truth WITHOUT a union that also gets
    // contaminated with non-schema noise, so `detectDirtyData` never even
    // gets a chance to fire on the negative-control cases -- overfit rate
    // is unaffected (measured, not just assumed).
    const overfit = report.overfitRate as AblationDelta
    expect(overfit.meanDiff).toBe(0)
  })

  test("reports AblationNotMeasurable rather than a fabricated number when a case set has no positive (or negative) control for a signal", () => {
    const onlyEnumCases: EvalCase[] = [defaultLabeledCases.find((c) => c.name === "Status Enum")!]
    const reports = ablationRunner(onlyEnumCases, [50], TRIAL_COUNT)
    const dicts = reports.find((r) => r.signal === "detectDicts")!
    // "Status Enum" has no map anywhere -- there's no positive control for detectDicts in this set.
    expect(dicts.discriminativePower).toMatchObject({ measurable: false })
    expect((dicts.discriminativePower as { reason: string }).reason).toContain("positive-control")
    // But it IS a negative control (no map at all), so overfit rate is measurable.
    expect(dicts.overfitRate).not.toMatchObject({ measurable: false })
  })
})

// ---------------------------------------------------------------------------
// Clustering-method sweep (Phase 3) — the JSONoid-derived comparison: does
// one `ClusteringMethod`'s confidence interval sit strictly above the other
// two's across EVERY generator profile (crown a default), or do the
// intervals overlap somewhere in the sweep (no universal default, expose as
// configuration)? `clusteringSensitiveCases`'s default set includes both
// key-signature's known strength (near-identical polymorphic-API-response
// shapes) and its documented weakness (a single population with several
// sparsely-present optional fields, which it over-splits since it groups by
// exact key-set signature with no distance tolerance) -- a sweep that only
// included the former would crown key-signature by construction, not by
// evidence.
// ---------------------------------------------------------------------------

describe("clustering method sweep", () => {
  const TRIAL_COUNT = 15
  const profiles: readonly GeneratorProfile[] = [
    { kind: "uniform" }, { kind: "zipfian-presence" }, { kind: "adversarial-boundary" },
  ]

  test("FINDING: across the full case set (including key-signature's documented over-splitting weakness), no clustering method's CI sits strictly above the others on every profile -- 'no universal default, expose as configuration' is the conclusion the data supports", () => {
    const sweep = clusteringMethodSweep(profiles, [50], TRIAL_COUNT)
    expect(sweep.results).toHaveLength(profiles.length * 3) // 3 methods x 3 profiles
    expect(sweep.conclusion).toContain("no universal default")
    expect(sweep.crownedDefault).toBeUndefined()

    // The mechanism behind the finding: key-signature is undefeated on
    // "uniform"/"zipfian-presence" (its home-turf cases dominate) but ties
    // complete-linkage on "adversarial-boundary", where the sparse-optional
    // negative control's over-split cost catches up with it.
    const adversarial = sweep.results.filter((r) => r.profile === "adversarial-boundary")
    const keySig = adversarial.find((r) => r.method === "key-signature")!
    const complete = adversarial.find((r) => r.method === "complete-linkage")!
    expect(keySig.ci.low).toBeLessThanOrEqual(complete.ci.high)
    expect(complete.ci.low).toBeLessThanOrEqual(keySig.ci.high)
  })

  test("the same sweep DOES crown key-signature as default when the sparse-optional negative control is excluded from the case set -- confirms the 'no universal default' finding above is driven by that specific case, not an artifact of the sweep mechanics", () => {
    const withoutSparseControl = clusteringSensitiveCases.filter((c) => c.name !== "sparse-single-type")
    const sweep = clusteringMethodSweep(profiles, [50], TRIAL_COUNT, withoutSparseControl)
    expect(sweep.crownedDefault).toBe("key-signature")
    expect(sweep.conclusion).toContain("crowned default: key-signature")
  })
})
