// packages/type-ir/src/stats.test.ts — tests for the statistics helpers
// (stats.ts) that back inference-eval.ts's multi-trial comparisons: mean,
// stddev, percentile bootstrap CI, and paired bootstrap significance
// testing.
import { describe, expect, test } from "bun:test";
import { mean, stddev, bootstrapCI, pairedBootstrapTest, mulberry32 } from "./stats.ts";

describe("mean", () => {
  test("computes the arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([2, 2, 2])).toBe(2);
  });

  test("0 for an empty series", () => {
    expect(mean([])).toBe(0);
  });
});

describe("stddev", () => {
  test("0 for a constant series", () => {
    expect(stddev([5, 5, 5, 5])).toBe(0);
  });

  test("0 for fewer than 2 values", () => {
    expect(stddev([])).toBe(0);
    expect(stddev([5])).toBe(0);
  });

  test("matches the known sample stddev of a simple series", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9]: mean 5, sample variance 32/7, stddev ~2.138.
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stddev(values)).toBeCloseTo(2.1381, 3);
  });
});

describe("bootstrapCI", () => {
  test("collapses to a point interval for an empty series", () => {
    const rng = mulberry32(1);
    const ci = bootstrapCI([], rng);
    expect(ci.point).toBe(0);
    expect(ci.low).toBe(0);
    expect(ci.high).toBe(0);
  });

  test("collapses to a point interval for a constant series", () => {
    const rng = mulberry32(1);
    const ci = bootstrapCI([7, 7, 7, 7, 7], rng, { resamples: 200 });
    expect(ci.point).toBe(7);
    expect(ci.low).toBe(7);
    expect(ci.high).toBe(7);
  });

  test("point estimate matches mean(), and the interval brackets it", () => {
    const rng = mulberry32(42);
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ci = bootstrapCI(values, rng, { resamples: 1000 });
    expect(ci.point).toBe(mean(values));
    expect(ci.low).toBeLessThanOrEqual(ci.point);
    expect(ci.high).toBeGreaterThanOrEqual(ci.point);
  });

  test("a wider confidence level produces a wider (or equal) interval", () => {
    const values = [3, 5, 1, 9, 4, 7, 2, 8, 6, 5, 4, 3, 9, 1, 7];
    const ci90 = bootstrapCI(values, mulberry32(7), { resamples: 1000, level: 0.9 });
    const ci99 = bootstrapCI(values, mulberry32(7), { resamples: 1000, level: 0.99 });
    expect(ci99.high - ci99.low).toBeGreaterThanOrEqual(ci90.high - ci90.low);
  });

  // Coverage check: on a distribution with known mean, a 90% CI built from
  // many independent samples should contain the true mean roughly 90% of
  // the time. This is the actual statistical property `bootstrapCI` exists
  // to provide, not just "some interval comes out" — so verify it directly
  // rather than trusting the implementation by inspection. Uses a fairly
  // small resample count and rep count to keep the suite fast; the
  // tolerance band is wide enough to not be flaky given that budget while
  // still catching a badly broken bootstrap (e.g. inverted quantiles, no
  // variance at all).
  test("90% CI coverage roughly matches the nominal level over repeated sampling", () => {
    const drawRng = mulberry32(1234);
    const trueMean = 0.5; // uniform[0,1)
    const reps = 200;
    const sampleSize = 25;
    let covered = 0;
    for (let i = 0; i < reps; i++) {
      const sample = Array.from({ length: sampleSize }, () => drawRng());
      const ci = bootstrapCI(sample, mulberry32(1000 + i), { resamples: 400, level: 0.9 });
      if (trueMean >= ci.low && trueMean <= ci.high) covered++;
    }
    const coverageRate = covered / reps;
    // Nominal 90%; allow [78%, 100%] to absorb Monte Carlo noise at this
    // budget without masking a genuinely broken implementation (which
    // tends to land far outside this band, e.g. ~50% or ~0%).
    expect(coverageRate).toBeGreaterThanOrEqual(0.78);
    expect(coverageRate).toBeLessThanOrEqual(1);
  });
});

describe("pairedBootstrapTest", () => {
  test("throws on mismatched-length series", () => {
    expect(() => pairedBootstrapTest([1, 2, 3], [1, 2], mulberry32(1))).toThrow();
  });

  test("meanDiff and pValue are trivial for identical paired series", () => {
    const values = [0.5, 0.6, 0.7, 0.4, 0.55];
    const result = pairedBootstrapTest(values, values, mulberry32(1));
    expect(result.meanDiff).toBe(0);
    expect(result.significant).toBe(false);
  });

  test("detects a real, consistent paired difference as significant", () => {
    // `a` beats `b` by a fixed margin (with a little noise) on every one
    // of 40 paired trials — a real, non-zero effect a paired test should
    // reliably catch.
    const rng = mulberry32(99);
    const n = 40;
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < n; i++) {
      const base = rng(); // shared corpus-generation-style noise
      a.push(base + 0.2 + (rng() - 0.5) * 0.05);
      b.push(base + (rng() - 0.5) * 0.05);
    }
    const result = pairedBootstrapTest(a, b, mulberry32(7));
    expect(result.meanDiff).toBeGreaterThan(0.15);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.significant).toBe(true);
    expect(result.ci.low).toBeGreaterThan(0);
  });

  test("fails to reject when there is no real paired difference", () => {
    // `a` and `b` are independent draws from the same distribution, paired
    // only by index — no systematic effect, so the test should NOT claim
    // significance.
    const rng = mulberry32(555);
    const n = 40;
    const a = Array.from({ length: n }, () => rng());
    const b = Array.from({ length: n }, () => rng());
    const result = pairedBootstrapTest(a, b, mulberry32(11));
    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThanOrEqual(0.05);
  });
});
