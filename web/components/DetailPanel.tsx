import { useEffect, useMemo, useState } from 'react';
import { api, formatTs, tzAbbr } from '../api';
import { useTz, useDetailView, setDetailView } from '../settings';
import { useNote, setNote } from '../notes';
import type { LineDetail } from '../types';
import JsonTree, { tryParseJson } from './JsonTree';
import ValueViewer, { ViewButton } from './ValueViewer';
import { useEscapeKey } from '../escStack';

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
  file,
  lineNo,
  onClose,
  onAddFilter,
}: {
  sessionId: string;
  file: string;
  lineNo: number;
  onClose: () => void;
  onAddFilter: (clause: string) => void;
}) {
  const [detail, setDetail] = useState<LineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ label: string; value: string } | null>(null);
  const tz = useTz();
  const view = useDetailView();
  const note = useNote(file, lineNo);

  // the raw line as a JSON tree, when it is a JSON object/array
  const json = useMemo(() => (detail ? tryParseJson(detail.raw) : null), [detail]);
  // the JSON tree is only offered when the raw content actually is JSON
  const asJson = json !== null && view === 'json';

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setViewer(null);
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

  // a docked panel: the visualizer modal (and any other floating window) takes
  // Escape first; the panel closes only once nothing is layered above it
  useEscapeKey(onClose, 'panel');

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

            <section className="mb-3">
              <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Note
                {note && <span className="text-amber-400" title="This line has a note">●</span>}
              </h3>
              <textarea
                value={note}
                onChange={(e) => setNote(file, lineNo, e.target.value)}
                placeholder="Add a note for this line… (included in the exported report)"
                rows={note ? 3 : 2}
                spellCheck={false}
                className="w-full resize-y rounded-md border border-edge bg-surface-0 p-2 text-xs leading-5 text-gray-200 placeholder:text-gray-600 focus:border-amber-700/70 focus:outline-none"
              />
            </section>

            {(detail.fields.length > 0 || json) && (
              <section className="mb-3">
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Fields{!asJson && detail.fields.length > 0 ? ` (${detail.fields.length})` : ''}
                  </h3>
                  {/* the JSON tree is only offered when the raw content actually is JSON */}
                  {json && (
                    <div className="flex items-center gap-2">
                      {asJson && (
                        <button
                          className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-gray-100"
                          onClick={() => void navigator.clipboard.writeText(JSON.stringify(json, null, 2))}
                        >
                          Copy JSON
                        </button>
                      )}
                      <div className="flex overflow-hidden rounded border border-edge text-[11px]">
                        <button
                          className={`px-1.5 py-0.5 ${!asJson ? 'bg-surface-2 text-sky-300' : 'text-gray-500 hover:text-gray-300'}`}
                          onClick={() => setDetailView('flat')}
                          title="Show flattened fields"
                        >
                          Flat
                        </button>
                        <button
                          className={`px-1.5 py-0.5 ${asJson ? 'bg-surface-2 text-sky-300' : 'text-gray-500 hover:text-gray-300'}`}
                          onClick={() => setDetailView('json')}
                          title="Show the raw JSON tree"
                        >
                          JSON
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {asJson && json ? (
                  <div className="max-h-[50vh] overflow-auto rounded-md border border-edge bg-surface-0">
                    <JsonTree
                      value={json}
                      onFilter={(p, v) => onAddFilter(`${p}:${filterValue(v)}`)}
                      onView={(label, v) => setViewer({ label, value: v })}
                    />
                  </div>
                ) : detail.fields.length > 0 ? (
                  <table className="w-full text-xs">
                    <tbody>
                      {detail.fields.map((f, i) => (
                        <tr key={`${f.key}-${i}`} className="group border-t border-edge/50 align-top">
                          <td className="max-w-36 truncate py-1 pr-2 font-mono text-sky-400" title={f.key}>
                            {f.key}
                          </td>
                          <td className="break-all py-1 font-mono text-gray-300">{f.value}</td>
                          <td className="whitespace-nowrap py-0.5 pl-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {f.value.length > 0 && (
                                <ViewButton onClick={() => setViewer({ label: f.key, value: f.value })} />
                              )}
                              <button
                                className="rounded bg-surface-2 px-1 text-[10px] text-gray-500 opacity-0 transition-opacity hover:text-sky-300 group-hover:opacity-100"
                                title={`Filter: ${f.key}:${f.value}`}
                                onClick={() => onAddFilter(`${f.key}:${filterValue(f.value)}`)}
                              >
                                +filter
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-xs text-gray-500">No flattened fields — switch to JSON to view the content.</div>
                )}
              </section>
            )}

            <section>
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  {detail.record ? `Record (${detail.record.span} lines)` : 'Raw content'}
                </h3>
                <button
                  className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-gray-100"
                  onClick={() =>
                    void navigator.clipboard.writeText(detail.record ? detail.record.text : detail.raw)
                  }
                >
                  {detail.record ? 'Copy record' : 'Copy raw'}
                </button>
              </div>
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-edge bg-surface-0 p-2 font-mono text-xs leading-5 text-gray-300">
                {detail.record ? detail.record.text : detail.raw}
              </pre>
            </section>
          </>
        )}
      </div>

      {viewer && (
        <ValueViewer label={viewer.label} value={viewer.value} onClose={() => setViewer(null)} />
      )}
    </aside>
  );
}
