import { useEffect, useState } from 'react';
import { api, formatCount } from '../api';
import type { FacetResult } from '../types';

/** Quote a field value for the query language (empty value matches the empty string). */
function filterValue(value: string): string {
  if (value === '') return '""';
  return /[\s:"()]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
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
        if (!cancelled) setFacet(f);
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
                    {facet && !loading && (
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
                    )}
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
