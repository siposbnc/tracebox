import { useEffect, useState } from 'react';
import { api, formatCount } from '../api';
import type { StatsResult } from '../types';

const LEVEL_COLORS: Record<string, string> = {
  TRACE: '#64748b',
  DEBUG: '#94a3b8',
  INFO: '#38bdf8',
  WARN: '#f59e0b',
  ERROR: '#ef4444',
  FATAL: '#e879f9',
  NONE: '#475569',
};

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-semibold text-gray-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

/** Summary metrics for the current view: span, rate, level breakdown, top fields. */
export default function StatsPanel({
  sessionId,
  epoch,
  grouped,
  hasSearch,
  onClose,
}: {
  sessionId: string;
  epoch: number;
  grouped: boolean;
  hasSearch: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .stats(sessionId, grouped)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, epoch, grouped]);

  const span = data && data.minTs !== null && data.maxTs !== null ? data.maxTs - data.minTs : 0;
  const avgPerMin = span > 0 && data ? Math.round((data.withTs / span) * 60_000) : 0;
  const maxLevel = data && data.levels.length > 0 ? Math.max(...data.levels.map((l) => l.count)) : 1;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="text-sm font-semibold text-gray-200">
          Summary <span className="text-xs font-normal text-gray-500">· {hasSearch ? 'in results' : 'whole file'}</span>
        </div>
        <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close summary">
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && !data && <div className="animate-pulse-subtle text-xs text-gray-500">Loading…</div>}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Lines" value={formatCount(data.total)} />
              <Stat label="Time span" value={fmtDuration(span)} />
              <Stat label="Avg / min" value={avgPerMin ? formatCount(avgPerMin) : '—'} />
              <Stat label="Peak / min" value={data.peakPerMin ? formatCount(data.peakPerMin) : '—'} />
            </div>
            {data.withTs < data.total && (
              <div className="mt-1 text-[10px] text-gray-600">{formatCount(data.total - data.withTs)} lines without a timestamp</div>
            )}

            <div className="mt-4">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Levels</div>
              {data.levels.map((l) => {
                const pct = data.total > 0 ? (l.count / data.total) * 100 : 0;
                return (
                  <div key={l.level} className="mb-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="flex items-center gap-1.5 text-gray-300">
                        <span className="h-2 w-2 rounded-sm" style={{ background: LEVEL_COLORS[l.level] ?? '#475569' }} />
                        {l.level}
                      </span>
                      <span className="text-gray-500">
                        {formatCount(l.count)} · {pct < 1 ? pct.toFixed(1) : Math.round(pct)}%
                      </span>
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full" style={{ width: `${(l.count / maxLevel) * 100}%`, background: LEVEL_COLORS[l.level] ?? '#475569' }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {data.fields.length > 0 && (
              <div className="mt-4">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Top fields</div>
                {data.fields.map((f) => (
                  <div key={f.key} className="mb-2.5">
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="truncate text-sky-400" title={f.key}>{f.key}</span>
                      <span className="shrink-0 text-gray-600">{formatCount(f.distinctCount)} distinct</span>
                    </div>
                    {f.values.map((v) => {
                      const pct = f.covered > 0 ? (v.count / f.covered) * 100 : 0;
                      return (
                        <div key={v.value} className="flex items-center justify-between gap-2 pl-2 text-[11px]">
                          <span className={`truncate ${v.value === '' ? 'italic text-gray-500' : 'text-gray-300'}`}>
                            {v.value === '' ? '(empty)' : v.value}
                          </span>
                          <span className="shrink-0 text-gray-500">{pct < 1 ? pct.toFixed(1) : Math.round(pct)}%</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
