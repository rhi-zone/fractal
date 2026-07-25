// packages/type-ir/src/stats.ts — @rhi-zone/fractal-type-ir/stats
//
// Small statistics helpers for turning a set of independent trial
// measurements into a distribution summary: mean, stddev, a percentile
// bootstrap confidence interval, and a paired bootstrap significance test
// for comparing two configurations run on the same seeds. No external
// stats library — this package has zero runtime deps and stays that way.
//
// These are deliberately generic (`readonly number[]` in, summary out) so
// they apply to `overallF1` and any sub-axis F1 from inference-eval.ts
// without inference-eval.ts needing to know how a bootstrap works.

export type Rng = () => number

/**
 * mulberry32 — small, fast, seedable PRNG. Returns a `() => number in
 * [0,1)` generator. Shared by `inference-eval.ts` (corpus generation) and
 * this module's bootstrap resampling, so both draw from the same
 * well-tested generator rather than each rolling their own.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

/** Sample standard deviation (n-1 denominator). 0 for fewer than 2 values. */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function resample<T>(values: readonly T[], rng: Rng): T[] {
  const out: T[] = new Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[Math.floor(rng() * values.length)]!
  return out
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  const frac = pos - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

export interface ConfidenceInterval {
  readonly point: number
  readonly low: number
  readonly high: number
  /** The confidence level used, e.g. 0.95. */
  readonly level: number
}

/**
 * Percentile bootstrap confidence interval on `mean(values)`: resample
 * `values` with replacement `resamples` times, take the mean of each
 * resample, and report the `level`-confidence percentile interval of that
 * distribution of means. `point` is the mean of the original (unresampled)
 * data, not the mean of the bootstrap means.
 */
export function bootstrapCI(
  values: readonly number[],
  rng: Rng,
  options?: { readonly resamples?: number; readonly level?: number },
): ConfidenceInterval {
  const level = options?.level ?? 0.95
  const point = mean(values)
  if (values.length === 0) return { point, low: point, high: point, level }
  const resamples = options?.resamples ?? 2000
  const means: number[] = new Array(resamples)
  for (let i = 0; i < resamples; i++) means[i] = mean(resample(values, rng))
  means.sort((a, b) => a - b)
  const alpha = (1 - level) / 2
  return { point, low: quantile(means, alpha), high: quantile(means, 1 - alpha), level }
}

export interface PairedBootstrapResult {
  /** mean(a) - mean(b) on the original (unresampled) paired differences. */
  readonly meanDiff: number
  /** Two-sided bootstrap p-value: fraction of resampled mean-diffs at or across zero from `meanDiff`'s sign. */
  readonly pValue: number
  /** Bootstrap confidence interval on the paired difference, at `level` (default 0.95). */
  readonly ci: ConfidenceInterval
  /** `pValue < alpha` (default alpha 0.05). */
  readonly significant: boolean
}

/**
 * Paired bootstrap significance test: given two equal-length series of
 * trial results measured on the SAME underlying seeds (so index i in `a`
 * and index i in `b` share corpus-generation noise as a nuisance variable),
 * test whether `mean(a) - mean(b)` differs from 0.
 *
 * Resamples the per-index differences `a[i] - b[i]` with replacement
 * (paired resampling — never separates a from its matched b), and reports
 * the two-sided p-value as the fraction of resampled mean-differences that
 * are as or more extreme than 0 relative to the observed sign, doubled to
 * account for both tails, capped at 1.
 */
export function pairedBootstrapTest(
  a: readonly number[],
  b: readonly number[],
  rng: Rng,
  options?: { readonly resamples?: number; readonly level?: number; readonly alpha?: number },
): PairedBootstrapResult {
  if (a.length !== b.length) {
    throw new Error(`pairedBootstrapTest: paired series must have equal length (got ${a.length} and ${b.length})`)
  }
  const level = options?.level ?? 0.95
  const alpha = options?.alpha ?? 0.05
  const diffs = a.map((v, i) => v - b[i]!)
  const meanDiff = mean(diffs)

  if (diffs.length === 0) {
    return { meanDiff, pValue: 1, ci: { point: 0, low: 0, high: 0, level }, significant: false }
  }

  const resamples = options?.resamples ?? 2000
  const resampledMeans: number[] = new Array(resamples)
  for (let i = 0; i < resamples; i++) resampledMeans[i] = mean(resample(diffs, rng))
  resampledMeans.sort((a2, b2) => a2 - b2)

  // Two-sided p-value via the "shift to null" method: how much of the
  // resampled-difference distribution, recentered at 0, is as extreme as
  // the observed |meanDiff| in either direction.
  const centered = resampledMeans.map((m) => m - meanDiff)
  const countAsExtreme = centered.filter((m) => Math.abs(m) >= Math.abs(meanDiff)).length
  const pValue = Math.min(1, countAsExtreme / resamples)

  const ciAlpha = (1 - level) / 2
  const ci: ConfidenceInterval = {
    point: meanDiff,
    low: quantile(resampledMeans, ciAlpha),
    high: quantile(resampledMeans, 1 - ciAlpha),
    level,
  }

  return { meanDiff, pValue, ci, significant: pValue < alpha }
}
