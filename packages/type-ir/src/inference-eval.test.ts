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
  type EvalCase,
} from "./inference-eval.ts"
import { pairedBootstrapTest, mulberry32 } from "./stats.ts"
import { ecommerceOrder, apiResponse, treeNode } from "./test-fixtures.ts"

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

    const withCfd = fromJsonCorpus(values)
    const withoutCfd = fromJsonCorpus(values, { detectCfdDiscriminants: false })

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

    const withCfd = fromJsonCorpus(values)
    const withoutCfd = fromJsonCorpus(values, { detectCfdDiscriminants: false })

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
