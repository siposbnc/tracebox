import { useEffect, useState } from 'react';
import { api, formatCount } from '../api';
import type { ClustersResult } from '../types';

/**
 * Pattern (cluster) sidebar: shows the distinct shapes of log lines in the
 * current view, ranked by count. Click a pattern to drill the view down to just
 * that cluster; click it again (or the active one) to clear.
 */
export default function ClusterPanel({
  sessionId,
  epoch,
  activeTemplate,
  hasSearch,
  onDrill,
  onClose,
}: {
  sessionId: string;
  epoch: number;
  activeTemplate: number | null;
  hasSearch: boolean;
  onDrill: (id: number | null) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ClustersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .clusters(sessionId, 100)
      .then((d) => {
        if (!cancelled) setData(d);
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
  }, [sessionId, epoch]);

  const maxCount = data && data.patterns.length > 0 ? data.patterns[0].count : 1;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="text-sm font-semibold text-gray-200">
          Patterns
          {data && (
            <span className="ml-1 text-xs font-normal text-gray-500">
              · {formatCount(data.distinctCount)} {hasSearch ? 'in results' : 'in file'}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200"
          title="Close patterns"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading && !data && <div className="animate-pulse-subtle px-2 py-2 text-xs text-gray-500">Loading…</div>}
        {error && <div className="px-2 py-2 text-xs text-red-400">{error}</div>}
        {data && data.patterns.length === 0 && !loading && (
          <div className="px-2 py-2 text-xs text-gray-600">No patterns in the current view.</div>
        )}
        {data?.patterns.map((p) => {
          const active = p.id === activeTemplate;
          const pct = data.covered > 0 ? (p.count / data.covered) * 100 : 0;
          return (
            <button
              key={p.id}
              onClick={() => onDrill(active ? null : p.id)}
              title={active ? 'Clear cluster filter' : `Filter to: ${p.pattern}`}
              className={`relative mb-0.5 block w-full overflow-hidden rounded px-2 py-1 text-left ${
                active ? 'bg-sky-900/50 ring-1 ring-sky-700' : 'hover:bg-surface-2'
              }`}
            >
              <span
                className="absolute inset-y-0 left-0 bg-sky-900/30"
                style={{ width: `${(p.count / maxCount) * 100}%` }}
              />
              <span className="relative flex items-center justify-between gap-2">
                <span className="shrink-0 font-mono text-[10px] text-gray-400">
                  {formatCount(p.count)} · {pct < 1 ? pct.toFixed(1) : Math.round(pct)}%
                </span>
              </span>
              <span className="relative mt-0.5 block truncate font-mono text-[11px] text-gray-200" title={p.pattern}>
                {p.pattern}
              </span>
            </button>
          );
        })}
      </div>

      {activeTemplate !== null && (
        <button
          onClick={() => onDrill(null)}
          className="border-t border-edge px-3 py-1.5 text-left text-xs text-sky-300 hover:bg-surface-2"
        >
          ← Clear cluster filter
        </button>
      )}
    </aside>
  );
}
