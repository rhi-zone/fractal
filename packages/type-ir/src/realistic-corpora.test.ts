// packages/type-ir/src/realistic-corpora.test.ts — runs `fromJsonCorpus`
// against realistic-corpora.ts's hand-typed sample arrays and scores the
// result against each corpus's hand-authored ground truth via
// `scoreInference`. See realistic-corpora.ts's module doc for why this is a
// different validation angle than inference-eval.test.ts's
// generate-then-infer suite (there, both the "ground truth" and the
// "samples" come from the same generator; here, a human wrote both,
// independently, to look like real API traffic).
//
// These tests report the ACTUAL F1 achieved rather than asserting a
// threshold tuned to make them pass — per the phase's design, the point of
// this corpus is to find out what score realistic-but-not-generator-shaped
// data gets, not to lock in a number. Assertions below are limited to
// structural sanity (finite scores in [0, 1]) plus a `console.log` of the
// full report so the actual numbers are visible in test output.
import { describe, expect, test } from "bun:test";
import { fromJsonCorpus } from "./from-json-corpus.ts";
import { scoreInference } from "./inference-eval.ts";
import { realisticCorpora } from "./realistic-corpora.ts";

function assertValidReport(score: ReturnType<typeof scoreInference>): void {
  expect(Number.isFinite(score.overallF1)).toBe(true);
  expect(score.overallF1).toBeGreaterThanOrEqual(0);
  expect(score.overallF1).toBeLessThanOrEqual(1);
}

describe("realistic corpora — hand-typed samples scored against hand-authored ground truth", () => {
  for (const corpus of realisticCorpora) {
    test(`${corpus.name}: fromJsonCorpus output scores against ground truth`, () => {
      const inferred = fromJsonCorpus(corpus.samples);
      const score = scoreInference(corpus.schema, inferred);
      assertValidReport(score);

      console.log(
        `[realistic-corpora] ${corpus.name} (n=${corpus.samples.length}): ` +
          `overallF1=${score.overallF1.toFixed(3)} ` +
          `fieldCoverage(P/R/F1)=${score.fieldCoverage.precision.toFixed(2)}/${score.fieldCoverage.recall.toFixed(2)}/${score.fieldCoverage.f1.toFixed(2)} ` +
          `typeAccuracy(exact/family)=${score.typeAccuracy.exactRate.toFixed(2)}/${score.typeAccuracy.familyRate.toFixed(2)} ` +
          `enumDetection.f1=${score.enumDetection.f1.toFixed(2)} ` +
          `enumMemberFidelity.f1=${score.enumMemberFidelity.f1.toFixed(2)} ` +
          `dictDetection.f1=${score.dictDetection.f1.toFixed(2)} ` +
          `unionFidelity.f1=${score.unionFidelity.f1.toFixed(2)}`,
      );
    });
  }

  test("all three corpora run without throwing and produce a well-formed report", () => {
    for (const corpus of realisticCorpora) {
      const inferred = fromJsonCorpus(corpus.samples);
      const score = scoreInference(corpus.schema, inferred);
      assertValidReport(score);
      expect(score.fields.length).toBeGreaterThan(0);
    }
  });
});
