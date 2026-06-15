import { useEffect, useState } from 'react';
import { api, formatTs, tzAbbr } from '../api';
import { useTz } from '../settings';
import type { LineDetail } from '../types';

const LEVEL_COLORS: Record<string, string> = {
  TRACE: 'text-slate-400',
  DEBUG: 'text-slate-300',
  INFO: 'text-sky-300',
  WARN: 'text-amber-300',
  ERROR: 'text-red-300',
  FATAL: 'text-fuchsia-300',
};

export default function DetailPanel({
  sessionId,
  lineNo,
  onClose,
  onAddFilter,
}: {
  sessionId: string;
  lineNo: number;
  onClose: () => void;
  onAddFilter: (clause: string) => void;
}) {
  const [detail, setDetail] = useState<LineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tz = useTz();

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api
      .detail(sessionId, lineNo)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, lineNo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filterValue = (value: string): string => (/[\s:"()]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);

  return (
    <aside className="flex w-[420px] max-w-[45vw] shrink-0 flex-col border-l border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="text-sm font-semibold text-gray-200">
          Line {lineNo + 1}
          {detail?.level && (
            <span className={`ml-2 text-xs font-bold ${LEVEL_COLORS[detail.level] ?? 'text-gray-400'}`}>
              {detail.level}
            </span>
          )}
        </div>
        <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <div className="text-sm text-red-400">{error}</div>}
        {!detail && !error && <div className="animate-pulse-subtle text-sm text-gray-500">Loading…</div>}
        {detail && (
          <>
            {detail.ts !== null && (
              <section className="mb-3">
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Timestamp</h3>
                <div className="font-mono text-sm text-gray-200">
                  {formatTs(detail.ts, tz)} <span className="text-gray-500">{tzAbbr(detail.ts, tz)}</span>
                </div>
              </section>
            )}

            {detail.fields.length > 0 && (
              <section className="mb-3">
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  Fields ({detail.fields.length})
                </h3>
                <table className="w-full text-xs">
                  <tbody>
                    {detail.fields.map((f, i) => (
                      <tr key={`${f.key}-${i}`} className="group border-t border-edge/50 align-top">
                        <td className="max-w-36 truncate py-1 pr-2 font-mono text-sky-400" title={f.key}>
                          {f.key}
                        </td>
                        <td className="break-all py-1 font-mono text-gray-300">{f.value}</td>
                        <td className="w-10 py-0.5 text-right">
                          <button
                            className="rounded bg-surface-2 px-1 text-[10px] text-gray-500 opacity-0 transition-opacity hover:text-sky-300 group-hover:opacity-100"
                            title={`Filter: ${f.key}:${f.value}`}
                            onClick={() => onAddFilter(`${f.key}:${filterValue(f.value)}`)}
                          >
                            +filter
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {detail.record ? `Record (${detail.record.span} lines)` : 'Raw content'}
              </h3>
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-edge bg-surface-0 p-2 font-mono text-xs leading-5 text-gray-300">
                {detail.record ? detail.record.text : detail.raw}
              </pre>
              <button
                className="mt-2 rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-400 hover:text-gray-100"
                onClick={() => void navigator.clipboard.writeText(detail.record ? detail.record.text : detail.raw)}
              >
                {detail.record ? 'Copy record' : 'Copy raw line'}
              </button>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
