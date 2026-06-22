import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatTs } from '../api';
import { useTz, getContextLines } from '../settings';
import { useEscapeKey } from '../escStack';
import type { ContextResult } from '../types';

const LEVEL_STYLES: Record<string, string> = {
  TRACE: 'bg-slate-800 text-slate-400',
  DEBUG: 'bg-slate-800 text-slate-300',
  INFO: 'bg-sky-950 text-sky-300',
  WARN: 'bg-amber-950 text-amber-300',
  ERROR: 'bg-red-950 text-red-300',
  FATAL: 'bg-fuchsia-950 text-fuchsia-300',
};

const STEP = 25;

/**
 * "grep -C" peek: shows the unfiltered lines surrounding a single line, with the
 * center line and any other search hits in the window marked. Lets the user grow
 * the window and jump into the full (unfiltered) view at any line.
 */
export default function ContextPeek({
  sessionId,
  lineNo,
  highlightTerms,
  onClose,
  onJumpToLine,
}: {
  sessionId: string;
  lineNo: number;
  highlightTerms: string[];
  onClose: () => void;
  onJumpToLine: (lineNo: number) => void;
}) {
  const [before, setBefore] = useState(getContextLines);
  const [after, setAfter] = useState(getContextLines);
  const [data, setData] = useState<ContextResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const tz = useTz();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api
      .context(sessionId, lineNo, before, after)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, lineNo, before, after]);

  useEscapeKey(onClose, 'modal');

  // keep the center line in view as the window grows
  useEffect(() => {
    centerRef.current?.scrollIntoView({ block: 'center' });
  }, [data]);

  const matchSet = useMemo(() => new Set(data?.matchLines ?? []), [data]);

  const highlightRegex = useMemo(() => {
    const escaped = highlightTerms
      .filter((t) => t.length > 0)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escaped.length === 0) return null;
    try {
      return new RegExp(`(${escaped.join('|')})`, 'gi');
    } catch {
      return null;
    }
  }, [highlightTerms]);

  const render = useCallback(
    (text: string): React.ReactNode => {
      if (!highlightRegex || !text) return text;
      const parts = text.split(highlightRegex);
      if (parts.length <= 1) return text;
      return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
    },
    [highlightRegex],
  );

  const atFileStart = data !== null && data.rows.length > 0 && data.rows[0].lineNo === 0;
  const gutter = data && data.rows.length > 0 ? String(data.rows[data.rows.length - 1].lineNo + 1).length : 5;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[900px] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <div className="text-sm font-semibold text-gray-200">
            Context around line {lineNo + 1}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBefore((n) => n + STEP)}
              className="rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-400 hover:text-gray-100"
              title="Show more lines before"
            >
              + before
            </button>
            <button
              onClick={() => setAfter((n) => n + STEP)}
              className="rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-400 hover:text-gray-100"
              title="Show more lines after"
            >
              + after
            </button>
            <button
              onClick={onClose}
              className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-surface-0 py-1">
          {error && <div className="p-4 text-sm text-red-400">{error}</div>}
          {!data && !error && (
            <div className="animate-pulse-subtle p-4 text-sm text-gray-500">Loading…</div>
          )}
          {data && !atFileStart && (
            <div className="px-3 py-1 text-center text-[11px] text-gray-600">⋯ earlier lines</div>
          )}
          {data?.rows.map((row) => {
            const isCenter = row.lineNo === data.center;
            const isMatch = matchSet.has(row.lineNo);
            const levelClass = row.level ? (LEVEL_STYLES[row.level] ?? 'bg-slate-800 text-slate-300') : '';
            return (
              <div
                key={row.lineNo}
                ref={isCenter ? centerRef : undefined}
                onClick={() => onJumpToLine(row.lineNo)}
                title="Open in full view at this line"
                className={`flex cursor-pointer items-center gap-2 border-l-2 px-2 font-mono text-[13px] leading-6 ${
                  isCenter
                    ? 'border-sky-400 bg-sky-950/60'
                    : isMatch
                      ? 'border-amber-500/60 bg-amber-950/20 hover:bg-surface-1'
                      : 'border-transparent text-gray-400 hover:bg-surface-1'
                }`}
              >
                <span
                  className="shrink-0 select-none text-right text-[11px] text-gray-600"
                  style={{ width: `${gutter + 1}ch` }}
                >
                  {row.lineNo + 1}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{formatTs(row.ts, tz)}</span>
                {row.level && (
                  <span
                    className={`w-12 shrink-0 rounded px-1 text-center text-[10px] font-semibold leading-4 ${levelClass}`}
                  >
                    {row.level}
                  </span>
                )}
                <span className={`min-w-0 flex-1 truncate whitespace-pre ${isCenter ? 'text-gray-100' : ''}`}>
                  {render(row.text)}
                  {row.truncated && <span className="text-gray-500"> … (truncated)</span>}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-4 py-2 text-xs text-gray-500">
          <span>Click any line to open it in the full, unfiltered view.</span>
          <button
            onClick={() => onJumpToLine(lineNo)}
            className="rounded border border-edge bg-surface-2 px-2.5 py-1 text-gray-300 hover:text-gray-100"
          >
            Open in full view →
          </button>
        </div>
      </div>
    </div>
  );
}
