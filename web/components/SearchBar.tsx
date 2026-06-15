import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCount, tzAbbr } from '../api';
import { useOrder, setOrder, useTz, setTz, useWrap, setWrap } from '../settings';
import {
  recordHistory,
  clearHistory,
  saveSearch,
  removeSaved,
  isSaved,
  useHistory,
  useSaved,
} from '../searches';
import { computeSuggestions, tokenBounds, type Suggestion } from '../querySuggest';
import { matchCommand, formatChord, useBindings } from '../keybindings';
import BookmarksMenu from './BookmarksMenu';
import type { SessionStatus } from '../types';

const SYNTAX_EXAMPLES: [string, string][] = [
  ['error timeout', 'lines containing both words (implicit AND)'],
  ['"connection failed"', 'exact phrase'],
  ['level:error', 'field equals (level, or any extracted field)'],
  ['status:>=500', 'numeric comparison: > >= < <='],
  ['timestamp:>2024-01-31', 'after a date/time (also <, ranges by precision)'],
  ['path:/api/*', 'wildcard match (case-insensitive)'],
  ['msg:"*user logged in*"', 'wildcard value with spaces — quote it'],
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
  onCopyRows,
  histogramOpen,
  onToggleHistogram,
  facetsOpen,
  onToggleFacets,
  clustersOpen,
  onToggleClusters,
  highlightMode,
  onToggleHighlight,
  grouped,
  onToggleGrouped,
  file,
  onJumpToLine,
  onGoToLine,
  onShowShortcuts,
  onOpenSettings,
  fieldNames,
  levelCounts,
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
  onCopyRows: () => Promise<{ count: number; total: number }>;
  histogramOpen: boolean;
  onToggleHistogram: () => void;
  facetsOpen: boolean;
  onToggleFacets: () => void;
  clustersOpen: boolean;
  onToggleClusters: () => void;
  highlightMode: boolean;
  onToggleHighlight: () => void;
  grouped: boolean;
  onToggleGrouped: () => void;
  file: string;
  onJumpToLine: (lineNo: number) => void;
  onGoToLine: () => void;
  onShowShortcuts: () => void;
  onOpenSettings: () => void;
  fieldNames: { key: string; count: number }[];
  levelCounts: Record<string, number>;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const order = useOrder();
  const tz = useTz();
  const wrap = useWrap();
  const bindings = useBindings();
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // --- inline autocomplete --------------------------------------------------
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [navigated, setNavigated] = useState(false);

  const history = useHistory();
  const saved = useSaved();
  const fieldKeys = useMemo(() => fieldNames.map((f) => f.key), [fieldNames]);
  const levelKeys = useMemo(() => Object.keys(levelCounts), [levelCounts]);

  const refreshSuggestions = (value: string, cursor: number): void => {
    const { token } = tokenBounds(value, cursor);
    const next = computeSuggestions(token, fieldKeys, levelKeys);
    setSuggestions(next);
    setSuggestOpen(next.length > 0);
    setActiveIdx(0);
    setNavigated(false);
  };

  const acceptSuggestion = (s: Suggestion): void => {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? query.length;
    const { start } = tokenBounds(query, cursor);
    const insert = s.insert + (s.trailingSpace ? ' ' : '');
    const next = query.slice(0, start) + insert + query.slice(cursor);
    const newCursor = start + insert.length;
    onChange(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(newCursor, newCursor);
      refreshSuggestions(next, newCursor); // e.g. `level:` then offers values
    });
  };

  const submit = (q: string): void => {
    setSuggestOpen(false);
    recordHistory(q);
    onSubmit(q);
  };

  const applySearch = (q: string): void => {
    onChange(q);
    setHistoryOpen(false);
    submit(q);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (matchCommand(e) === 'focusSearch') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [historyOpen]);

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
            onChange={(e) => {
              onChange(e.target.value);
              setHelpOpen(false);
              setHistoryOpen(false);
              refreshSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={(e) => {
              if (suggestOpen && suggestions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIdx((i) => (i + 1) % suggestions.length);
                  setNavigated(true);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
                  setNavigated(true);
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  acceptSuggestion(suggestions[activeIdx]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSuggestOpen(false);
                  return;
                }
                // Enter accepts only when the user has navigated the list; otherwise it runs the search
                if (e.key === 'Enter' && navigated) {
                  e.preventDefault();
                  acceptSuggestion(suggestions[activeIdx]);
                  return;
                }
              }
              if (e.key === 'Enter') submit(query);
              if (e.key === 'Escape' && query !== '') {
                onChange('');
                onSubmit('');
              }
            }}
            onKeyUp={(e) => {
              // recompute on cursor moves (arrows/home/end) that aren't list navigation
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                const t = e.target as HTMLInputElement;
                refreshSuggestions(t.value, t.selectionStart ?? t.value.length);
              }
            }}
            onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
            onFocus={() => setHelpOpen(false)}
            placeholder='Search…  e.g.  level:error AND "connection failed"  ·  status:>=500  ·  press Enter'
            spellCheck={false}
            autoComplete="off"
            className={`w-full rounded-lg border bg-surface-0 py-1.5 pl-9 pr-24 font-mono text-sm text-gray-100 outline-none placeholder:font-sans placeholder:text-gray-600 focus:border-sky-600 ${
              error ? 'border-red-700' : 'border-edge'
            }`}
          />

          {suggestOpen && suggestions.length > 0 && (
            <div className="absolute left-0 top-full z-40 mt-1 w-80 overflow-hidden rounded-lg border border-edge bg-surface-2 py-1 shadow-2xl">
              {suggestions.map((s, i) => (
                <button
                  key={s.insert}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => acceptSuggestion(s)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-1 text-left font-mono text-sm ${
                    i === activeIdx ? 'bg-sky-900/60 text-gray-100' : 'text-gray-300 hover:bg-surface-3'
                  }`}
                >
                  <span className="truncate">{s.label}</span>
                  <span className="shrink-0 font-sans text-[10px] uppercase tracking-wide text-gray-500">
                    {s.hint}
                  </span>
                </button>
              ))}
              <div className="border-t border-edge/60 px-3 pt-1 text-[10px] text-gray-600">
                Tab to complete · ↑↓ to choose · Enter to run
              </div>
            </div>
          )}
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

        <div className="relative" ref={historyRef}>
          <button
            onClick={() => {
              setHistoryOpen((v) => !v);
              setSaveName('');
            }}
            className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
              historyOpen ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
            }`}
            title="Search history & saved searches"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
          {historyOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-[420px] max-w-[90vw] rounded-lg border border-edge bg-surface-2 shadow-2xl">
              {query.trim() !== '' && !isSaved(query) && (
                <div className="flex items-center gap-2 border-b border-edge p-2">
                  <input
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        saveSearch(query, saveName);
                        setSaveName('');
                      }
                    }}
                    placeholder="Name this search…"
                    className="min-w-0 flex-1 rounded border border-edge bg-surface-0 px-2 py-1 text-xs text-gray-100 outline-none focus:border-sky-600"
                  />
                  <button
                    onClick={() => {
                      saveSearch(query, saveName);
                      setSaveName('');
                    }}
                    className="shrink-0 rounded bg-sky-700 px-2 py-1 text-xs font-medium text-white hover:bg-sky-600"
                  >
                    ★ Save
                  </button>
                </div>
              )}

              <div className="max-h-[60vh] overflow-y-auto p-2">
                {saved.length > 0 && (
                  <div className="mb-2">
                    <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      Saved
                    </div>
                    {saved.map((s) => (
                      <div
                        key={s.query}
                        className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-3"
                      >
                        <button
                          onClick={() => applySearch(s.query)}
                          className="flex min-w-0 flex-1 flex-col items-start text-left"
                          title={s.query}
                        >
                          <span className="truncate text-xs text-amber-300">★ {s.name}</span>
                          <span className="w-full truncate font-mono text-[11px] text-gray-500">{s.query}</span>
                        </button>
                        <button
                          onClick={() => removeSaved(s.query)}
                          className="shrink-0 rounded px-1 text-gray-600 opacity-0 hover:text-red-300 group-hover:opacity-100"
                          title="Remove saved search"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mb-1 flex items-center justify-between px-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Recent</span>
                  {history.length > 0 && (
                    <button onClick={clearHistory} className="text-[10px] text-gray-500 hover:text-gray-300">
                      Clear
                    </button>
                  )}
                </div>
                {history.length === 0 ? (
                  <div className="px-1 py-2 text-xs text-gray-600">No recent searches yet.</div>
                ) : (
                  history.map((q) => (
                    <button
                      key={q}
                      onClick={() => applySearch(q)}
                      className="block w-full truncate rounded px-1 py-1 text-left font-mono text-[11px] text-gray-400 hover:bg-surface-3 hover:text-gray-100"
                      title={q}
                    >
                      {q}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
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
          onClick={onShowShortcuts}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          title={`Keyboard shortcuts${bindings.showShortcuts ? ` (${formatChord(bindings.showShortcuts)})` : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
          </svg>
        </button>

        <button
          onClick={onOpenSettings}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          title="Settings"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
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
          onClick={onToggleFacets}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            facetsOpen ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Toggle field breakdown"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18" />
            <path d="M3 12h12" />
            <path d="M3 18h6" />
          </svg>
        </button>

        <button
          onClick={onToggleClusters}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            clustersOpen ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Toggle log patterns (clustering)"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="7" r="2.5" />
            <circle cx="17" cy="7" r="2.5" />
            <circle cx="9" cy="17" r="2.5" />
            <path d="M8 8.5 15 8.5M7.5 9 9 14.5M15.5 9 10 15" />
          </svg>
        </button>

        <button
          onClick={onToggleHighlight}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            highlightMode ? 'bg-surface-3 text-amber-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title={`Highlight matches in place instead of filtering${
            bindings.toggleHighlight ? ` (${formatChord(bindings.toggleHighlight)})` : ''
          }`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m9 11-6 6v3h3l6-6" />
            <path d="m17 7 3-3 1 1-3 3" />
            <path d="m13 7 4 4" />
            <path d="M14 6l4 4" />
          </svg>
        </button>

        <button
          onClick={onToggleGrouped}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            grouped ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Group multi-line records (fold stack traces into one row)"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6v12" />
            <path d="M3 6h2M3 18h2" />
          </svg>
        </button>

        <button
          onClick={() => setWrap(!wrap)}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            wrap ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title={wrap ? 'Wrapping long lines — click to truncate' : 'Truncating long lines — click to wrap'}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18" />
            <path d="M3 12h13a3 3 0 1 1 0 6h-4" />
            <path d="m13 16-2 2 2 2" />
            <path d="M3 18h4" />
          </svg>
        </button>

        <BookmarksMenu file={file} onJump={onJumpToLine} onGoToLine={onGoToLine} bindings={bindings} />

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
          onClick={() => setTz(tz === 'utc' ? 'local' : 'utc')}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          title={
            tz === 'utc'
              ? 'Timestamps in UTC — click for local time'
              : 'Timestamps in local time — click for UTC'
          }
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {tzAbbr(Date.now(), tz)}
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
            <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-edge bg-surface-2 shadow-xl">
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setCopyNote('Copying…');
                  void onCopyRows()
                    .then(({ count, total }) =>
                      setCopyNote(`Copied ${count.toLocaleString()}${total > count ? ` of ${total.toLocaleString()}` : ''} rows`),
                    )
                    .catch(() => setCopyNote('Copy failed'))
                    .finally(() => setTimeout(() => setCopyNote(null), 2500));
                }}
                className="block w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-surface-3"
              >
                Copy rows to clipboard
              </button>
              <a href={exportUrls.csv} className="block px-3 py-2 text-sm text-gray-300 hover:bg-surface-3" download>
                Filtered rows as CSV
              </a>
              <a href={exportUrls.json} className="block px-3 py-2 text-sm text-gray-300 hover:bg-surface-3" download>
                Filtered rows as JSON
              </a>
            </div>
          )}
          {copyNote && (
            <div className="absolute right-0 top-full z-30 mt-1 rounded-md border border-edge bg-surface-3 px-2.5 py-1 text-xs text-gray-200 shadow-lg">
              {copyNote}
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
