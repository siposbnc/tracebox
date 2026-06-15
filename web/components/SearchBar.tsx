import { useEffect, useRef, useState } from 'react';
import { formatCount } from '../api';
import { useOrder, setOrder } from '../settings';
import type { SessionStatus } from '../types';

const SYNTAX_EXAMPLES: [string, string][] = [
  ['error timeout', 'lines containing both words (implicit AND)'],
  ['"connection failed"', 'exact phrase'],
  ['level:error', 'field equals (level, or any extracted field)'],
  ['status:>=500', 'numeric comparison: > >= < <='],
  ['timestamp:>2024-01-31', 'after a date/time (also <, ranges by precision)'],
  ['path:/api/*', 'wildcard match'],
  ['user:*', 'field exists'],
  ['(level:error OR level:warn) AND NOT db', 'boolean logic with grouping'],
  ['-debug', 'exclude a term'],
];

export default function SearchBar({
  query,
  onChange,
  onSubmit,
  searching,
  error,
  search,
  tail,
  onToggleTail,
  onRefresh,
  refreshing,
  onOpenFile,
  exportUrls,
  histogramOpen,
  onToggleHistogram,
  fieldNames,
}: {
  query: string;
  onChange: (q: string) => void;
  onSubmit: (q: string) => void;
  searching: boolean;
  error: string | null;
  search: SessionStatus['search'];
  tail: boolean;
  onToggleTail: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenFile: () => void;
  exportUrls: { csv: string; json: string };
  histogramOpen: boolean;
  onToggleHistogram: () => void;
  fieldNames: { key: string; count: number }[];
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const order = useOrder();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative border-b border-edge bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit(query);
              if (e.key === 'Escape' && query !== '') {
                onChange('');
                onSubmit('');
              }
            }}
            onFocus={() => setHelpOpen(false)}
            placeholder='Search…  e.g.  level:error AND "connection failed"  ·  status:>=500  ·  press Enter'
            spellCheck={false}
            className={`w-full rounded-lg border bg-surface-0 py-1.5 pl-9 pr-24 font-mono text-sm text-gray-100 outline-none placeholder:font-sans placeholder:text-gray-600 focus:border-sky-600 ${
              error ? 'border-red-700' : 'border-edge'
            }`}
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            {search && !searching && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-gray-400">
                {formatCount(search.total)} hits · {search.durationMs} ms
              </span>
            )}
            {searching && (
              <span className="animate-pulse-subtle rounded bg-surface-2 px-1.5 py-0.5 text-xs text-sky-300">
                searching…
              </span>
            )}
            {query !== '' && (
              <button
                onClick={() => {
                  onChange('');
                  onSubmit('');
                }}
                className="rounded px-1 text-gray-500 hover:text-gray-200"
                title="Clear search (Esc)"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <button
          onClick={() => setHelpOpen((v) => !v)}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            helpOpen ? 'bg-surface-3 text-gray-100' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Query syntax help"
        >
          ?
        </button>

        <button
          onClick={onToggleHistogram}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            histogramOpen ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Toggle histogram"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <rect x="3" y="12" width="4" height="9" rx="1" />
            <rect x="10" y="6" width="4" height="15" rx="1" />
            <rect x="17" y="9" width="4" height="12" rx="1" />
          </svg>
        </button>

        <button
          onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          title={
            order === 'asc'
              ? 'Oldest first — click to show newest first'
              : 'Newest first — click to show oldest first'
          }
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {order === 'asc' ? (
              <>
                <path d="M12 5v14" />
                <path d="m19 12-7 7-7-7" />
              </>
            ) : (
              <>
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </>
            )}
          </svg>
          {order === 'asc' ? 'Oldest' : 'Newest'}
        </button>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100 disabled:opacity-60"
          title="Reload the file to pick up new lines"
        >
          <svg
            className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>

        <button
          onClick={onToggleTail}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
            tail
              ? 'border-emerald-700 bg-emerald-950 text-emerald-300'
              : 'border-edge bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Follow file changes (tail -f)"
        >
          <span className={`h-2 w-2 rounded-full ${tail ? 'animate-pulse-subtle bg-emerald-400' : 'bg-gray-600'}`} />
          Tail
        </button>

        <div className="relative">
          <button
            onClick={() => setExportOpen((v) => !v)}
            onBlur={() => setTimeout(() => setExportOpen(false), 150)}
            className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          >
            Export ▾
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-edge bg-surface-2 shadow-xl">
              <a href={exportUrls.csv} className="block px-3 py-2 text-sm text-gray-300 hover:bg-surface-3" download>
                Filtered rows as CSV
              </a>
              <a href={exportUrls.json} className="block px-3 py-2 text-sm text-gray-300 hover:bg-surface-3" download>
                Filtered rows as JSON
              </a>
            </div>
          )}
        </div>

        <button
          onClick={onOpenFile}
          className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
        >
          Open file
        </button>
      </div>

      {error && <div className="mt-1.5 px-1 text-xs text-red-400">⚠ {error}</div>}

      {helpOpen && (
        <div className="absolute left-3 top-full z-30 mt-1 w-[640px] max-w-[90vw] rounded-lg border border-edge bg-surface-2 p-4 shadow-2xl">
          <div className="mb-2 text-sm font-semibold text-gray-200">Query syntax</div>
          <table className="w-full text-left text-xs">
            <tbody>
              {SYNTAX_EXAMPLES.map(([ex, desc]) => (
                <tr key={ex} className="border-t border-edge/60">
                  <td className="py-1.5 pr-4">
                    <button
                      className="rounded bg-surface-0 px-1.5 py-0.5 font-mono text-sky-300 hover:bg-surface-3"
                      onClick={() => {
                        onChange(ex);
                        setHelpOpen(false);
                        inputRef.current?.focus();
                      }}
                    >
                      {ex}
                    </button>
                  </td>
                  <td className="py-1.5 text-gray-400">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {fieldNames.length > 0 && (
            <div className="mt-3 border-t border-edge pt-2">
              <div className="mb-1.5 text-xs font-semibold text-gray-400">Fields detected in this file</div>
              <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                {fieldNames.slice(0, 40).map((f) => (
                  <button
                    key={f.key}
                    className="rounded bg-surface-0 px-1.5 py-0.5 font-mono text-[11px] text-gray-300 hover:bg-surface-3 hover:text-sky-300"
                    onClick={() => {
                      onChange(query.trim() === '' ? `${f.key}:` : `${query.trim()} ${f.key}:`);
                      inputRef.current?.focus();
                    }}
                    title={`${f.count.toLocaleString()} occurrences`}
                  >
                    {f.key}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
