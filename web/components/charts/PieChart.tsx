import { useMemo, useState } from 'react';
import { formatTs } from '../../api';
import { useTz } from '../../settings';
import type { AggregateResult } from '../../types';
import { formatMetricFull, seriesColor } from './util';

/**
 * Donut chart over an {@link AggregateResult}: one slice per group, sized by its
 * total. Best with a field group-by and a count/sum metric (proportions).
 */
export default function PieChart({ data }: { data: AggregateResult }) {
  const tz = useTz();
  const [hover, setHover] = useState<number | null>(null);
  const { rows } = data;

  const slices = useMemo(() => {
    const total = rows.reduce((s, r) => s + Math.max(0, r.total), 0) || 1;
    let angle = -Math.PI / 2;
    return rows.map((r, i) => {
      const frac = Math.max(0, r.total) / total;
      const a0 = angle;
      const a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const r0 = 28;
      const r1 = 47;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad: number, radius: number): string =>
        `${(50 + radius * Math.cos(rad)).toFixed(2)},${(50 + radius * Math.sin(rad)).toFixed(2)}`;
      const d = `M${p(a0, r0)} L${p(a0, r1)} A${r1},${r1} 0 ${big} 1 ${p(a1, r1)} L${p(a1, r0)} A${r0},${r0} 0 ${big} 0 ${p(a0, r0)} Z`;
      return { key: r.key, total: r.total, frac, color: seriesColor(String(r.key), i), d };
    });
  }, [rows]);

  if (rows.length === 0) return <div className="grid h-full place-items-center text-xs text-gray-500">No data</div>;

  const label = (key: string | number): string =>
    data.groupKind === 'time' ? formatTs(Number(key), tz) : String(key);

  return (
    <div className="flex h-full items-center gap-2">
      <div className="relative h-full min-h-0 flex-1">
        <svg className="h-full w-full" viewBox="0 0 100 100">
          {slices.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill={s.color}
              opacity={hover === null || hover === i ? 1 : 0.4}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[10px] text-gray-300">
            <div className="max-w-[120px] truncate font-semibold">{label(slices[hover].key)}</div>
            <div>{(slices[hover].frac * 100).toFixed(1)}%</div>
          </div>
        )}
      </div>
      <div className="flex max-h-full flex-col gap-0.5 overflow-auto pr-1 text-[10px] text-gray-400">
        {slices.map((s, i) => (
          <span
            key={i}
            className="flex items-center gap-1"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${label(s.key)} — ${formatMetricFull(s.total)}`}
          >
            <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="max-w-[100px] truncate">{label(s.key)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
