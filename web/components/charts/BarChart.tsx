import { useMemo, useState } from 'react';
import { formatTs } from '../../api';
import { useTz } from '../../settings';
import type { AggregateResult } from '../../types';
import { formatMetric, formatMetricFull, seriesColor, seriesLabel } from './util';
import Legend from './Legend';

/**
 * Vertical bar chart over an {@link AggregateResult}: one bar per group, stacked
 * by series. Groups are field values (or time buckets) along the x-axis.
 */
export default function BarChart({ data }: { data: AggregateResult }) {
  const tz = useTz();
  const [hover, setHover] = useState<number | null>(null);
  const { rows, series } = data;

  const maxTotal = useMemo(() => Math.max(1, ...rows.map((r) => r.total)), [rows]);

  if (rows.length === 0) return <div className="grid h-full place-items-center text-xs text-gray-500">No data</div>;

  const label = (key: string | number): string =>
    data.groupKind === 'time' ? formatTs(Number(key), tz) : String(key);

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1 items-end gap-[2px] px-1">
        <span className="pointer-events-none absolute left-1 top-0 font-mono text-[9px] text-gray-600">
          {formatMetric(maxTotal)}
        </span>
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex h-full flex-1 cursor-default flex-col justify-end"
            style={{ minWidth: 2, opacity: hover === null || hover === i ? 1 : 0.55 }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${label(r.key)} — ${formatMetricFull(r.total)}`}
          >
            <div className="flex flex-col-reverse" style={{ height: `${(r.total / maxTotal) * 100}%` }}>
              {series.map((s, si) => {
                const v = r.values[s] ?? 0;
                if (!v) return null;
                return (
                  <div
                    key={s}
                    style={{ height: `${(v / r.total) * 100}%`, background: seriesColor(s, si) }}
                  />
                );
              })}
            </div>
          </div>
        ))}
        {hover !== null && (
          <div className="pointer-events-none absolute left-1/2 top-1 z-10 -translate-x-1/2 rounded border border-edge bg-surface-2 px-2 py-1 text-[10px] text-gray-300 shadow-lg">
            <div className="max-w-[200px] truncate text-gray-300">{label(rows[hover].key)}</div>
            <div className="font-semibold">{formatMetricFull(rows[hover].total)}</div>
          </div>
        )}
      </div>
      <div className="flex gap-[2px] px-1 pt-0.5">
        {rows.map((r, i) => (
          <span
            key={i}
            className="flex-1 truncate text-center font-mono text-[8px] text-gray-600"
            style={{ minWidth: 2 }}
            title={label(r.key)}
          >
            {rows.length <= 16 ? label(r.key) : ''}
          </span>
        ))}
      </div>
      <Legend series={series} />
    </div>
  );
}
