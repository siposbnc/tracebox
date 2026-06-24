import { useMemo, useRef, useState } from 'react';
import { formatTs } from '../../api';
import { useTz } from '../../settings';
import type { AggregateResult } from '../../types';
import { formatMetric, formatMetricFull, seriesColor, seriesLabel } from './util';
import Legend from './Legend';

/**
 * Time-series line / area chart over an {@link AggregateResult} grouped by time.
 * With `area` and multiple series it stacks; otherwise it overlays lines.
 */
export default function LineChart({ data, area = false }: { data: AggregateResult; area?: boolean }) {
  const tz = useTz();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const { rows, series } = data;
  const stacked = area && series.length > 1;

  const { minX, spanX, maxY, paths, points } = useMemo(() => {
    const xs = rows.map((r) => Number(r.key));
    const minX = data.minTs ?? xs[0] ?? 0;
    const maxX = data.maxTs ?? xs[xs.length - 1] ?? 1;
    const spanX = Math.max(1, maxX - minX);
    let maxY = 0;
    for (const r of rows) {
      if (stacked) maxY = Math.max(maxY, series.reduce((s, k) => s + (r.values[k] ?? 0), 0));
      else for (const k of series) maxY = Math.max(maxY, r.values[k] ?? 0);
    }
    maxY = maxY || 1;
    const xFor = (ts: number): number => ((ts - minX) / spanX) * 100;
    const yFor = (v: number): number => 100 - (v / maxY) * 100;

    // cumulative baseline per row for stacked area
    const baseline = rows.map(() => 0);
    const paths = series.map((k, si) => {
      const pts = rows.map((r, ri) => {
        const v = r.values[k] ?? 0;
        const top = stacked ? baseline[ri] + v : v;
        if (stacked) baseline[ri] = top;
        return { x: xFor(Number(r.key)), y: yFor(top), base: stacked ? yFor(top - v) : 100 };
      });
      const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const fill = area
        ? `${line} ` +
          pts
            .slice()
            .reverse()
            .map((p) => `L${p.x.toFixed(2)},${p.base.toFixed(2)}`)
            .join(' ') +
          ' Z'
        : '';
      return { key: k, color: seriesColor(k, si), line, fill };
    });
    const points = rows.map((r) => ({ x: xFor(Number(r.key)) }));
    return { minX, spanX, maxY, paths, points };
  }, [rows, series, data.minTs, data.maxTs, stacked, area]);

  if (rows.length === 0) return <div className="grid h-full place-items-center text-xs text-gray-500">No data</div>;

  const hoveredRow = hover !== null ? rows[hover] : null;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={ref}
        className="relative min-h-0 flex-1"
        onMouseMove={(e) => {
          const rect = ref.current!.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const ts = minX + frac * spanX;
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < rows.length; i++) {
            const d = Math.abs(Number(rows[i].key) - ts);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {paths.map((p) =>
            p.fill ? <path key={`f-${p.key}`} d={p.fill} fill={p.color} opacity={stacked ? 0.85 : 0.18} /> : null,
          )}
          {paths.map((p) => (
            <path
              key={`l-${p.key}`}
              d={p.line}
              fill="none"
              stroke={p.color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover !== null && (
            <line
              x1={points[hover].x}
              x2={points[hover].x}
              y1={0}
              y2={100}
              stroke="#94a3b8"
              strokeWidth={0.5}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <span className="pointer-events-none absolute left-1 top-0 font-mono text-[9px] text-gray-600">
          {formatMetric(maxY)}
        </span>
        {hoveredRow && (
          <div className="pointer-events-none absolute left-1/2 top-1 z-10 -translate-x-1/2 rounded border border-edge bg-surface-2 px-2 py-1 text-[10px] text-gray-300 shadow-lg">
            <div className="text-gray-500">{formatTs(Number(hoveredRow.key), tz)}</div>
            {series.map((s, i) => (
              <div key={s} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: seriesColor(s, i) }} />
                <span>{seriesLabel(s)}</span>
                <span className="ml-auto font-semibold">{formatMetricFull(hoveredRow.values[s] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-between px-1 font-mono text-[9px] text-gray-600">
        <span>{formatTs(minX, tz)}</span>
        <span>{formatTs(minX + spanX, tz)}</span>
      </div>
      <Legend series={series} />
    </div>
  );
}
