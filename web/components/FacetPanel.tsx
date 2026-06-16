import { useEffect, useRef, useState } from 'react';
import { api, formatCount } from '../api';
import type { FacetResult, NumericFacet } from '../types';

/** Quote a field value for the query language (empty value matches the empty string). */
function filterValue(value: string): string {
  if (value === '') return '""';
  return /[\s:"()]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** Compact number formatting for the range view (trims noisy decimals). */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '–';
  if (Number.isInteger(n)) return n.toLocaleString();
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/**
 * Field breakdown sidebar: pick a field to see its top values with counts for
 * the current view (the active search result set, or the whole file). Clicking a
 * value pivots the search to it; the − button excludes it.
 */
export default function FacetPanel({
  sessionId,
  epoch,
  fieldNames,
  hasSearch,
  onAddFilter,
  onClose,
}: {
  sessionId: string;
  epoch: number;
  fieldNames: { key: string; count: number }[];
  hasSearch: boolean;
  onAddFilter: (clause: string) => void;
  onClose: () => void;
}) {
  const [field, setField] = useState<string | null>(null);
  const [facet, setFacet] = useState<FacetResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'values' = distinct-value list; 'range' = numeric distribution
  const [mode, setMode] = useState<'values' | 'range'>('values');
  const [numeric, setNumeric] = useState<NumericFacet | null>(null);
  const [numLoading, setNumLoading] = useState(false);
  // the field we last picked an automatic default view for (so result-set
  // refreshes don't override a manual Values/Range choice)
  const autoField = useRef<string | null>(null);

  // (re)load the expanded field whenever it changes or the result set does
  useEffect(() => {
    if (field === null) {
      setFacet(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .facet(sessionId, field, 50)
      .then((f) => {
        if (cancelled) return;
        setFacet(f);
        // default to the range view for high-cardinality numeric fields, where a
        // value list is useless; otherwise keep the value list
        if (autoField.current !== field) {
          autoField.current = field;
          const numericish = f.numericCount >= f.covered * 0.9 && f.distinctCount > f.values.length;
          setMode(numericish ? 'range' : 'values');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, field, epoch]);

  // load the numeric distribution lazily, only while the range view is showing
  useEffect(() => {
    if (field === null || mode !== 'range') {
      setNumeric(null);
      return;
    }
    let cancelled = false;
    setNumLoading(true);
    void api
      .numericFacet(sessionId, field, 24)
      .then((n) => {
        if (!cancelled) setNumeric(n);
      })
      .catch(() => {
        if (!cancelled) setNumeric(null);
      })
      .finally(() => {
        if (!cancelled) setNumLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, field, mode, epoch]);

  const maxCount = facet && facet.values.length > 0 ? facet.values[0].count : 1;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="text-sm font-semibold text-gray-200">
          Fields {field && <span className="text-xs font-normal text-gray-500">· {hasSearch ? 'in results' : 'whole file'}</span>}
        </div>
        <button
          onClick={onClose}
          className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200"
          title="Close field breakdown"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {fieldNames.length === 0 ? (
          <div className="p-3 text-xs text-gray-600">No structured fields detected in this file.</div>
        ) : (
          fieldNames.map((f) => {
            const open = f.key === field;
            return (
              <div key={f.key} className="border-b border-edge/40">
                <button
                  onClick={() => setField(open ? null : f.key)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs ${
                    open ? 'bg-surface-2 text-sky-300' : 'text-gray-300 hover:bg-surface-2'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`text-gray-600 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
                    <span className="truncate font-mono">{f.key}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-gray-500">{formatCount(f.count)}</span>
                </button>

                {open && (
                  <div className="px-2 pb-2">
                    {loading && <div className="animate-pulse-subtle px-1 py-1 text-[11px] text-gray-500">Loading…</div>}
                    {error && <div className="px-1 py-1 text-[11px] text-red-400">{error}</div>}
                    {facet && !loading && facet.numericCount > 0 && (
                      <div className="mb-1.5 flex overflow-hidden rounded border border-edge text-[10px]">
                        <button
                          className={`flex-1 py-0.5 ${mode === 'values' ? 'bg-surface-2 text-sky-300' : 'text-gray-500 hover:text-gray-300'}`}
                          onClick={() => setMode('values')}
                        >
                          Values
                        </button>
                        <button
                          className={`flex-1 py-0.5 ${mode === 'range' ? 'bg-surface-2 text-sky-300' : 'text-gray-500 hover:text-gray-300'}`}
                          onClick={() => setMode('range')}
                        >
                          Range
                        </button>
                      </div>
                    )}
                    {facet && !loading && mode === 'range' && facet.numericCount > 0 ? (
                      <NumericView
                        data={numeric}
                        loading={numLoading}
                        onRange={(lo, hi, last) =>
                          onAddFilter(`${f.key}:>=${lo} ${f.key}:${last ? '<=' : '<'}${hi}`)
                        }
                      />
                    ) : facet && !loading ? (
                      <>
                        {facet.values.length === 0 ? (
                          <div className="px-1 py-1 text-[11px] text-gray-600">No values in the current view.</div>
                        ) : (
                          facet.values.map((v) => {
                            const pct = facet.covered > 0 ? (v.count / facet.covered) * 100 : 0;
                            return (
                              <div key={v.value} className="group relative flex items-center gap-1">
                                <button
                                  onClick={() => onAddFilter(`${f.key}:${filterValue(v.value)}`)}
                                  title={`Filter to ${f.key}:${v.value || '(empty)'}`}
                                  className="relative min-w-0 flex-1 overflow-hidden rounded px-1.5 py-1 text-left hover:bg-surface-3"
                                >
                                  <span
                                    className="absolute inset-y-0 left-0 rounded bg-sky-900/40"
                                    style={{ width: `${(v.count / maxCount) * 100}%` }}
                                  />
                                  <span className="relative flex items-center justify-between gap-2">
                                    <span className={`truncate font-mono text-[11px] ${v.value === '' ? 'italic text-gray-500' : 'text-gray-200'}`}>
                                      {v.value === '' ? '(empty)' : v.value}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-gray-400">
                                      {formatCount(v.count)} · {pct < 1 ? pct.toFixed(1) : Math.round(pct)}%
                                    </span>
                                  </span>
                                </button>
                                <button
                                  onClick={() => onAddFilter(`NOT ${f.key}:${filterValue(v.value)}`)}
                                  title={`Exclude ${f.key}:${v.value || '(empty)'}`}
                                  className="shrink-0 rounded px-1 text-xs text-gray-600 opacity-0 hover:text-red-300 group-hover:opacity-100"
                                >
                                  −
                                </button>
                              </div>
                            );
                          })
                        )}
                        <div className="mt-1 px-1.5 text-[10px] text-gray-600">
                          {formatCount(facet.distinctCount)} distinct
                          {facet.distinctCount > facet.values.length && ` · top ${facet.values.length}`}
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

/** Numeric distribution: summary stats plus a clickable bar histogram that filters
 * the search to the clicked range. */
function NumericView({
  data,
  loading,
  onRange,
}: {
  data: NumericFacet | null;
  loading: boolean;
  onRange: (lo: string, hi: string, last: boolean) => void;
}) {
  if (loading && !data) return <div className="animate-pulse-subtle px-1 py-1 text-[11px] text-gray-500">Loading…</div>;
  if (!data) return <div className="px-1 py-1 text-[11px] text-gray-600">No numeric values in the current view.</div>;

  const maxCount = Math.max(1, ...data.buckets.map((b) => b.count));
  const lastIdx = data.buckets.length - 1;
  const stat = (label: string, value: number) => (
    <div className="flex flex-col items-center">
      <span className="text-[9px] uppercase tracking-wider text-gray-600">{label}</span>
      <span className="font-mono text-[11px] text-gray-200">{fmtNum(value)}</span>
    </div>
  );

  return (
    <div>
      <div className="mb-2 flex justify-between gap-1 rounded bg-surface-0 px-2 py-1.5">
        {stat('min', data.min)}
        {stat('p50', data.p50)}
        {stat('avg', data.avg)}
        {stat('p95', data.p95)}
        {stat('max', data.max)}
      </div>
      <div className="flex h-16 items-end gap-px">
        {data.buckets.map((b, i) => (
          <button
            key={i}
            onClick={() => onRange(String(b.lo), String(b.hi), i === lastIdx)}
            title={`${fmtNum(b.lo)} – ${fmtNum(b.hi)} · ${formatCount(b.count)}`}
            className="group flex flex-1 items-end self-stretch"
          >
            <span
              className="w-full rounded-t bg-sky-800/60 transition-colors group-hover:bg-sky-500"
              style={{ height: `${Math.max(b.count > 0 ? 4 : 0, (b.count / maxCount) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 px-0.5 text-[10px] text-gray-600">
        {formatCount(data.count)} numeric value{data.count === 1 ? '' : 's'} · click a bar to filter
      </div>
    </div>
  );
}
