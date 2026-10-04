/**
 * Lighthouse-style scoring helpers, re-implemented so that a local run without Lighthouse can
 * still say "about where would this land". The curves and weights are those of Lighthouse
 * 10–12 for the MOBILE form factor (lighthouse-core/audits/metrics/*.js, scoring.js).
 *
 * This is an ESTIMATE: Speed Index is not measured locally (its 10 % weight is spread over the
 * other metrics), and the metrics come from applied (DevTools) throttling, not from Lighthouse's
 * Lantern simulation. The official score is produced only by Lighthouse CI (docs/CI.md §4).
 */

export interface Curve {
  p10: number;
  median: number;
}

/** Mobile scoring curves (Lighthouse 10+). Times in ms; CLS unitless. */
export const MOBILE_CURVES = {
  fcp: { p10: 1800, median: 3000 },
  si: { p10: 3387, median: 5800 },
  lcp: { p10: 2500, median: 4000 },
  tbt: { p10: 200, median: 600 },
  cls: { p10: 0.1, median: 0.25 },
} satisfies Record<string, Curve>;

/** Performance category weights (Lighthouse 10+). */
export const WEIGHTS = { fcp: 0.1, si: 0.1, lcp: 0.25, tbt: 0.3, cls: 0.25 } as const;

/** Abramowitz & Stegun 7.1.26 — the approximation Lighthouse itself uses. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return sign * (1 - y * Math.exp(-ax * ax));
}

/** Lighthouse `getLogNormalScore`: 0.9 at p10, 0.5 at the median. */
export function logNormalScore({ p10, median }: Curve, value: number): number {
  if (value <= 0) return 1;
  const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
  const xLogRatio = Math.log(Math.max(Number.MIN_VALUE, value / median));
  const p10LogRatio = -Math.log(Math.max(Number.MIN_VALUE, p10 / median));
  const standardizedX = (xLogRatio * INVERSE_ERFC_ONE_FIFTH) / p10LogRatio;
  const percentile = (1 - erf(standardizedX)) / 2;
  if (value <= p10) return Math.max(0.9, Math.min(1, percentile));
  if (value <= median) return Math.max(0.5, Math.min(0.8999999999999999, percentile));
  return Math.max(0, Math.min(0.49999999999999994, percentile));
}

export interface MetricValues {
  fcp: number;
  lcp: number;
  tbt: number;
  cls: number;
  /** Optional; without it the SI weight is redistributed. */
  si?: number;
}

/** Estimated performance score 0–100 (rounded like Lighthouse). */
export function estimatePerformance(m: MetricValues): {
  score: number;
  parts: Record<string, number>;
  speedIndexMeasured: boolean;
} {
  const parts: Record<string, number> = {
    fcp: logNormalScore(MOBILE_CURVES.fcp, m.fcp),
    lcp: logNormalScore(MOBILE_CURVES.lcp, m.lcp),
    tbt: logNormalScore(MOBILE_CURVES.tbt, m.tbt),
    cls: logNormalScore(MOBILE_CURVES.cls, m.cls),
  };
  let weighted = 0;
  let total = 0;
  for (const key of ['fcp', 'lcp', 'tbt', 'cls'] as const) {
    weighted += (parts[key] ?? 0) * WEIGHTS[key];
    total += WEIGHTS[key];
  }
  if (m.si !== undefined) {
    parts.si = logNormalScore(MOBILE_CURVES.si, m.si);
    weighted += parts.si * WEIGHTS.si;
    total += WEIGHTS.si;
  }
  return {
    score: Math.round((weighted / total) * 100),
    parts,
    speedIndexMeasured: m.si !== undefined,
  };
}

/** Lighthouse accessibility weights by axe impact (Lighthouse 11+). */
export const IMPACT_WEIGHT: Record<string, number> = {
  critical: 10,
  serious: 7,
  moderate: 3,
  minor: 1,
};

/** Median of a non-empty list. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
