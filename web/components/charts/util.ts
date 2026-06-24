import { ALL_SERIES } from '../../types';

/** Per-level colors, matching the histogram's stacked bars. */
export const LEVEL_COLORS: Record<string, string> = {
  TRACE: '#475569',
  DEBUG: '#64748b',
  INFO: '#0284c7',
  WARN: '#d97706',
  ERROR: '#dc2626',
  FATAL: '#c026d3',
  NONE: '#334155',
};

/** Categorical palette for arbitrary (non-level) series. */
const PALETTE = [
  '#0284c7',
  '#16a34a',
  '#d97706',
  '#dc2626',
  '#9333ea',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#65a30d',
  '#2563eb',
  '#c026d3',
  '#0d9488',
];

/** A stable color for a series key — level colors first, then the palette by index. */
export function seriesColor(key: string, index: number): string {
  return LEVEL_COLORS[key] ?? PALETTE[index % PALETTE.length];
}

/** Display label for a series key (the no-split sentinel reads as "value"). */
export function seriesLabel(key: string): string {
  return key === ALL_SERIES ? 'value' : key;
}

/** Compact metric formatting for axes/labels (1.2k, 3.4M, decimals for small values). */
export function formatMetric(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Full metric value for tooltips. */
export function formatMetricFull(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
}

/** A human label for a spec's metric (for default panel titles / axis labels). */
export function metricLabel(metric: { type: string; field?: string; fn?: string }): string {
  if (metric.type === 'count') return 'count';
  if (metric.type === 'unique') return `unique ${metric.field}`;
  return `${metric.fn}(${metric.field})`;
}
