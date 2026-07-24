// packages/type-ir/src/inference-eval.test.ts — tests for the JSON
// inference quality evaluation harness (inference-eval.ts).
import { describe, expect, test } from "bun:test"
import { t, types } from "./index.ts"
import { fromJsonCorpus } from "./from-json-corpus.ts"
import {
  generateCorpus,
  scoreInference,
  runEvaluation,
  defaultLabeledCases,
  type EvalCase,
} from "./inference-eval.ts"
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
