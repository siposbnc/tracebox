import type { HistogramData } from './types';

/**
 * Gap & spike detection over the time histogram. Spikes are buckets whose volume
 * stands out from the bulk (robust median + MAD bound, with a noise gate); gaps
 * are notable silences — runs of empty buckets between active ones. Pure: the
 * histogram already carries all the data we need.
 */

export interface Spike {
  index: number;
  start: number;
  total: number;
  /** Volume relative to the median bucket. */
  ratio: number;
}

export interface Gap {
  start: number;
  end: number;
  durationMs: number;
  /** Number of empty buckets spanned. */
  missing: number;
}

export interface Anomalies {
  spikes: Spike[];
  gaps: Gap[];
}

const EMPTY: Anomalies = { spikes: [], gaps: [] };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function detectAnomalies(data: HistogramData): Anomalies {
  const buckets = data.buckets;
  // need enough buckets for the statistics to mean anything
  if (buckets.length < 8) return EMPTY;

  const totals = buckets.map((b) => b.total);
  const sorted = [...totals].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const q90 = quantile(sorted, 0.9);
  const mad = quantile(
    [...totals.map((t) => Math.abs(t - median))].sort((a, b) => a - b),
    0.5,
  );
  const sigma = mad * 1.4826; // MAD → robust std-dev estimate

  // a spike must clear a robust statistical bound and sit above the bulk
  const threshold = Math.max(median + 4 * sigma, q90 * 1.8);
  const candidates: Spike[] = [];
  buckets.forEach((b, i) => {
    if (b.total >= 3 && b.total > q90 && b.total >= threshold) {
      candidates.push({ index: i, start: b.start, total: b.total, ratio: median > 0 ? b.total / median : Infinity });
    }
  });
  // if a quarter of buckets "spike", the series is just noisy/uniform — not spikes
  const spikes = candidates.length > buckets.length * 0.25 ? [] : candidates.sort((a, b) => b.total - a.total).slice(0, 15);

  // gaps only read as anomalies when the series is otherwise dense
  const rangeBuckets = Math.round((data.maxTs - data.minTs) / data.bucketMs) + 1;
  const coverage = rangeBuckets > 0 ? buckets.length / rangeBuckets : 1;
  const gaps: Gap[] = [];
  if (coverage >= 0.4) {
    for (let i = 1; i < buckets.length; i++) {
      const prevEnd = buckets[i - 1].start + data.bucketMs;
      const gapMs = buckets[i].start - prevEnd;
      const missing = Math.round(gapMs / data.bucketMs);
      if (missing >= 2) gaps.push({ start: prevEnd, end: buckets[i].start, durationMs: gapMs, missing });
    }
  }
  gaps.sort((a, b) => b.durationMs - a.durationMs);

  return { spikes, gaps: gaps.slice(0, 12) };
}
