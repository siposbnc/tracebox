import { useMemo, useRef, useState } from 'react';
import { formatCount, formatTs } from '../api';
import { useTz } from '../settings';
import type { HistogramData } from '../types';

const LEVEL_COLORS: Record<string, string> = {
  TRACE: '#475569',
  DEBUG: '#64748b',
  INFO: '#0284c7',
  WARN: '#d97706',
  ERROR: '#dc2626',
  FATAL: '#c026d3',
  NONE: '#334155',
};

const STACK_ORDER = ['NONE', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const HEIGHT = 90;

export default function Histogram({
  data,
  onSelectRange,
}: {
  data: HistogramData;
  onSelectRange: (startTs: number, endTs: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const tz = useTz();

  const maxTotal = useMemo(() => Math.max(...data.buckets.map((b) => b.total), 1), [data]);
  const span = Math.max(1, data.maxTs - data.minTs + data.bucketMs);

  const xFor = (ts: number): number => ((ts - data.minTs) / span) * 100;
  const widthPct = (data.bucketMs / span) * 100;

  const tsAtClientX = (clientX: number): number => {
    const rect = containerRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return data.minTs + frac * span;
  };

  const finishDrag = (): void => {
    if (drag && Math.abs(drag.to - drag.from) > data.bucketMs / 2) {
      const lo = Math.min(drag.from, drag.to);
      const hi = Math.max(drag.from, drag.to);
      onSelectRange(lo, hi);
    }
    setDrag(null);
  };

  const hovered = hover !== null ? data.buckets[hover] : null;

  return (
    <div className="relative select-none border-b border-edge bg-surface-1 px-3 pb-1 pt-2">
      <div
        ref={containerRef}
        className="relative cursor-crosshair"
        style={{ height: HEIGHT }}
        onMouseDown={(e) => {
          const ts = tsAtClientX(e.clientX);
          setDrag({ from: ts, to: ts });
        }}
        onMouseMove={(e) => {
          if (drag) setDrag({ ...drag, to: tsAtClientX(e.clientX) });
          const rect = containerRef.current!.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const ts = data.minTs + frac * span;
          const idx = data.buckets.findIndex(
            (b) => ts >= b.start && ts < b.start + data.bucketMs,
          );
          setHover(idx >= 0 ? idx : null);
        }}
        onMouseUp={finishDrag}
        onMouseLeave={() => {
          setHover(null);
          finishDrag();
        }}
      >
        {data.buckets.map((bucket, i) => {
          let y = 0;
          const totalH = (bucket.total / maxTotal) * (HEIGHT - 8);
          return (
            <div
              key={i}
              className="absolute bottom-0"
              style={{
                left: `${xFor(bucket.start)}%`,
                width: `calc(${widthPct}% - 1px)`,
                minWidth: 2,
                height: Math.max(2, totalH),
                opacity: hover === null || hover === i ? 1 : 0.55,
              }}
            >
              {STACK_ORDER.filter((lv) => bucket.counts[lv]).map((lv) => {
                const h = (bucket.counts[lv] / bucket.total) * 100;
                const el = (
                  <div
                    key={lv}
                    className="absolute w-full"
                    style={{ bottom: `${y}%`, height: `${h}%`, background: LEVEL_COLORS[lv] ?? '#334155' }}
                  />
                );
                y += h;
                return el;
              })}
            </div>
          );
        })}

        {drag && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 border-x border-sky-400 bg-sky-400/15"
            style={{
              left: `${xFor(Math.min(drag.from, drag.to))}%`,
              width: `${((Math.abs(drag.to - drag.from)) / span) * 100}%`,
            }}
          />
        )}

        {hovered && !drag && (
          <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 rounded border border-edge bg-surface-2 px-2 py-1 text-[11px] text-gray-300 shadow-lg">
            <span className="text-gray-500">{formatTs(hovered.start, tz)}</span>
            {' · '}
            <span className="font-semibold">{formatCount(hovered.total)} lines</span>
            {Object.entries(hovered.counts)
              .filter(([lv]) => lv !== 'NONE')
              .map(([lv, n]) => (
                <span key={lv} className="ml-2" style={{ color: LEVEL_COLORS[lv] }}>
                  {lv} {formatCount(n)}
                </span>
              ))}
          </div>
        )}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-gray-600">
        <span>{formatTs(data.minTs, tz)}</span>
        <span className="text-gray-500">drag to filter a time range</span>
        <span>{formatTs(data.maxTs, tz)}</span>
      </div>
    </div>
  );
}
