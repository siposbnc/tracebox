import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, formatTs } from '../api';
import { useOrder, setOrder, useTz, useWrap, setWrap, getPageJump, getPageJumpBig, type Tz } from '../settings';
import { getBookmarks, toggleBookmark, useBookmarkVersion } from '../bookmarks';
import { matchCommand } from '../keybindings';
import { extractHighlightTerms, highlightRegexFor } from '../highlightTerms';
import type { HistogramData, MergedRow } from '../types';
import Histogram from './Histogram';
import DetailPanel from './DetailPanel';
import ContextPeek from './ContextPeek';

const BLOCK = 256;
const ROW_HEIGHT = 24;

const LEVEL_STYLES: Record<string, string> = {
  TRACE: 'bg-slate-800 text-slate-400',
  DEBUG: 'bg-slate-800 text-slate-300',
  INFO: 'bg-sky-950 text-sky-300',
  WARN: 'bg-amber-950 text-amber-300',
  ERROR: 'bg-red-950 text-red-300',
  FATAL: 'bg-fuchsia-950 text-fuchsia-300',
};

const SOURCE_COLORS = ['#0ea5e9', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#22d3ee', '#fb7185', '#a3e635'];

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

export default function MergedView({
  files,
  onJump,
}: {
  files: { id: string; file: string }[];
  onJump: (sessionId: string, lineNo: number) => void;
}) {
  const order = useOrder();
  const tz = useTz();
  const wrap = useWrap();
  useBookmarkVersion(); // re-render when bookmarks change anywhere

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set(files.map((f) => f.id)));
  const [picker, setPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedKey = useMemo(() => [...selectedFiles].sort().join(','), [selectedFiles]);

  const [sources, setSources] = useState<{ id: string; file: string }[]>([]);
  // Tail mode of each source in the timeline, so the Tail button can reflect
  // and drive them together. Off (mixed) unless every source is tailing.
  const [tailState, setTailState] = useState<Map<string, boolean>>(() => new Map());
  const [total, setTotal] = useState(0); // whole-timeline row count
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [phase, setPhase] = useState<'building' | 'ready' | 'error' | 'none'>('building');
  const [error, setError] = useState<string | null>(null);

  // search / highlight
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{ total: number; durationMs: number } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlightMode, setHighlightMode] = useState(false);

  const [selected, setSelected] = useState<MergedRow | null>(null);
  const [context, setContext] = useState<{ sessionId: string; lineNo: number } | null>(null);

  const [epoch, setEpoch] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(new Map<number, MergedRow[]>());
  const loadingRef = useRef(new Set<number>());
  const [, forceRender] = useState(0);
  const orderRef = useRef(order);
  const epochRef = useRef(epoch);

  const hasSearch = search !== null;
  const highlightActive = highlightMode && hasSearch;
  const listTotal = highlightActive ? total : hasSearch ? search.total : total;
  const highlightActiveRef = useRef(highlightActive);
  highlightActiveRef.current = highlightActive;

  if (order !== orderRef.current) {
    orderRef.current = order;
    blocksRef.current.clear();
    loadingRef.current.clear();
  }
  if (epoch !== epochRef.current) {
    epochRef.current = epoch;
    blocksRef.current.clear();
    loadingRef.current.clear();
  }

  const refreshHistogram = useCallback(() => {
    void api.mergedHistogram(highlightActiveRef.current).then(setHistogram).catch(() => setHistogram(null));
  }, []);

  // live updates from the server arrive in bursts while sources tail; coalesce
  // the (relatively expensive) histogram refresh so it runs at most ~4×/s
  const histoTimerRef = useRef<number | null>(null);
  const scheduleHistogram = useCallback(() => {
    if (histoTimerRef.current !== null) return;
    histoTimerRef.current = window.setTimeout(() => {
      histoTimerRef.current = null;
      refreshHistogram();
    }, 250);
  }, [refreshHistogram]);

  // when an update grows the view, stick to the live edge only if the user was
  // already there (bottom in oldest-first, top in newest-first)
  const followEdgeRef = useRef(false);

  const build = useCallback(async () => {
    const ids = [...selectedFiles];
    blocksRef.current.clear();
    loadingRef.current.clear();
    if (ids.length === 0) {
      setPhase('none');
      setTotal(0);
      setSources([]);
      setHistogram(null);
      return;
    }
    setPhase('building');
    setError(null);
    try {
      const r = await api.buildMerged(ids);
      setSources(r.sources);
      setTotal(r.count);
      // re-apply any active search against the freshly built timeline
      if (query.trim() !== '') {
        const s = await api.mergedSearch(query);
        setSearch(s);
      } else {
        setSearch(null);
      }
      refreshHistogram();
      setPhase('ready');
      setEpoch((e) => e + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    void build();
  }, [build]);

  // Follow the sources live: as any participating session tails/captures new
  // lines, the server folds them into the timeline and pushes an update.
  useEffect(() => {
    if (phase !== 'ready') return;
    const off = api.mergedEvents({
      update: (p) => {
        // decide whether to keep pinned to the live edge before the list grows
        const el = parentRef.current;
        const slack = ROW_HEIGHT * 3;
        followEdgeRef.current = el
          ? orderRef.current === 'asc'
            ? el.scrollHeight - el.scrollTop - el.clientHeight <= slack
            : el.scrollTop <= slack
          : false;
        setTotal(p.total);
        setSearch((prev) => (prev ? { ...prev, total: p.filtered } : prev));
        blocksRef.current.clear();
        loadingRef.current.clear();
        setEpoch((e) => e + 1);
        scheduleHistogram();
      },
    });
    return off;
  }, [phase, scheduleHistogram]);

  useEffect(() => () => {
    if (histoTimerRef.current !== null) clearTimeout(histoTimerRef.current);
  }, []);

  // Seed the per-source tail state from current statuses whenever the set of
  // timeline sources changes (e.g. after a rebuild or a file-selection change).
  useEffect(() => {
    if (sources.length === 0) {
      setTailState(new Map());
      return;
    }
    let cancelled = false;
    void api
      .sessions()
      .then((list) => {
        if (cancelled) return;
        const byId = new Map(list.map((s) => [s.id, s.tail]));
        setTailState(new Map(sources.map((s) => [s.id, byId.get(s.id) ?? false])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sources]);

  const allTailing = sources.length > 0 && sources.every((s) => tailState.get(s.id));

  // Toggle tail for every file in the timeline at once: enabling turns them all
  // on; with mixed/off state the button reads "off", so a click enables all.
  const toggleTimelineTail = useCallback(async () => {
    const next = !allTailing;
    setTailState(new Map(sources.map((s) => [s.id, next])));
    await Promise.all(sources.map((s) => api.setTail(s.id, next)));
  }, [allTailing, sources]);

  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPicker(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [picker]);

  const toggleFile = (id: string): void =>
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runSearch = useCallback(
    async (q: string) => {
      setQuery(q);
      setSelected(null);
      setSearchError(null);
      try {
        if (q.trim() === '') {
          await api.mergedSearch('');
          setSearch(null);
        } else {
          setSearch(await api.mergedSearch(q));
        }
        setEpoch((e) => e + 1);
        refreshHistogram();
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : String(e));
      }
    },
    [refreshHistogram],
  );

  const toggleHighlight = useCallback(() => {
    setHighlightMode((v) => !v);
    setEpoch((e) => e + 1);
    setTimeout(refreshHistogram, 0);
  }, [refreshHistogram]);

  const virtualizer = useVirtualizer({
    count: listTotal,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });

  const fetchBlock = useCallback((blockIdx: number) => {
    if (blocksRef.current.has(blockIdx) || loadingRef.current.has(blockIdx)) return;
    loadingRef.current.add(blockIdx);
    const reqOrder = orderRef.current;
    const reqEpoch = epochRef.current;
    const reqHl = highlightActiveRef.current;
    void api
      .mergedRows(blockIdx * BLOCK, BLOCK, reqOrder, reqHl)
      .then((r) => {
        if (orderRef.current !== reqOrder || epochRef.current !== reqEpoch) return;
        blocksRef.current.set(blockIdx, r.rows);
        forceRender((n) => n + 1);
      })
      .finally(() => loadingRef.current.delete(blockIdx));
  }, []);

  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    if (phase !== 'ready' || items.length === 0) return;
    const first = Math.floor(items[0].index / BLOCK);
    const last = Math.floor(items[items.length - 1].index / BLOCK);
    for (let b = first; b <= last; b++) fetchBlock(b);
  }, [items, fetchBlock, phase, listTotal, epoch, order]);

  // after a live update, keep the live edge in view if we were following it
  useEffect(() => {
    if (!followEdgeRef.current) return;
    followEdgeRef.current = false;
    if (listTotal === 0) return;
    virtualizer.scrollToIndex(order === 'asc' ? listTotal - 1 : 0, { align: 'end' });
  }, [epoch, listTotal, order, virtualizer]);

  const rowAt = (index: number): MergedRow | null => {
    const block = blocksRef.current.get(Math.floor(index / BLOCK));
    return block?.[index % BLOCK] ?? null;
  };
  const viewIndexOf = (seq: number): number | null => {
    for (const [b, rows] of blocksRef.current) {
      const i = rows.findIndex((r) => r.seq === seq);
      if (i >= 0) return b * BLOCK + i;
    }
    return null;
  };

  // selection + nav -----------------------------------------------------------
  const pendingSelectRef = useRef<number | null>(null);
  const selectAtViewIndex = (target: number, align: 'auto' | 'center' | 'start' | 'end' = 'center'): void => {
    if (listTotal === 0) return;
    const t = Math.max(0, Math.min(listTotal - 1, target));
    virtualizer.scrollToIndex(t, { align });
    const row = rowAt(t);
    if (row) {
      setSelected(row);
      pendingSelectRef.current = null;
    } else {
      pendingSelectRef.current = t;
    }
  };
  useEffect(() => {
    if (pendingSelectRef.current === null) return;
    const row = rowAt(pendingSelectRef.current);
    if (row) {
      setSelected(row);
      pendingSelectRef.current = null;
    }
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const anchor = (): number => {
      if (selected) {
        const idx = viewIndexOf(selected.seq);
        if (idx !== null) return idx;
      }
      return virtualizer.getVirtualItems()[0]?.index ?? 0;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectAtViewIndex(anchor() + (e.key === 'ArrowDown' ? 1 : -1), 'auto');
        return;
      }
      switch (matchCommand(e)) {
        case 'pageDown':
          e.preventDefault();
          selectAtViewIndex(anchor() + getPageJump());
          break;
        case 'pageUp':
          e.preventDefault();
          selectAtViewIndex(anchor() - getPageJump());
          break;
        case 'pageDownBig':
          e.preventDefault();
          selectAtViewIndex(anchor() + getPageJumpBig());
          break;
        case 'pageUpBig':
          e.preventDefault();
          selectAtViewIndex(anchor() - getPageJumpBig());
          break;
        case 'gotoStart':
          e.preventDefault();
          selectAtViewIndex(0, 'start');
          break;
        case 'gotoEnd':
          e.preventDefault();
          selectAtViewIndex(listTotal - 1, 'end');
          break;
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, listTotal, virtualizer]);

  const onSeek = useCallback(
    (startTs: number) => {
      void api.mergedSeek(startTs, highlightActiveRef.current).then(({ seq }) => {
        const idx = orderRef.current === 'desc' ? listTotal - 1 - seq : seq;
        virtualizer.scrollToIndex(Math.max(0, Math.min(listTotal - 1, idx)), { align: 'center' });
      });
    },
    [listTotal, virtualizer],
  );

  const sourceColor = useMemo(() => {
    const m = new Map<number, string>();
    sources.forEach((_, i) => m.set(i, SOURCE_COLORS[i % SOURCE_COLORS.length]));
    return m;
  }, [sources]);

  const highlightTerms = useMemo(() => extractHighlightTerms(query), [query]);
  const highlightRegex = useMemo(() => highlightRegexFor(highlightTerms), [highlightTerms]);
  const gutterWidth = Math.max(5, String(total).length) + 1;

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface-1 px-3 py-2">
        <span className="text-sm font-semibold text-gray-200">Merged timeline</span>

        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => setPicker((v) => !v)}
            className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
              picker ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
            }`}
            title="Choose which files to merge"
          >
            Files {selectedFiles.size}/{files.length} ▾
          </button>
          {picker && (
            <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-edge bg-surface-2 shadow-2xl">
              <div className="flex items-center justify-between border-b border-edge px-2 py-1.5 text-[10px] uppercase tracking-wider text-gray-500">
                <span>Files in timeline</span>
                <span className="flex gap-2">
                  <button className="hover:text-gray-300" onClick={() => setSelectedFiles(new Set(files.map((f) => f.id)))}>
                    All
                  </button>
                  <button className="hover:text-gray-300" onClick={() => setSelectedFiles(new Set())}>
                    None
                  </button>
                </span>
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-1">
                {files.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-3">
                    <input type="checkbox" checked={selectedFiles.has(f.id)} onChange={() => toggleFile(f.id)} className="accent-sky-600" />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-200" title={f.file}>
                      {baseName(f.file)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* search */}
        <div className="relative min-w-48 flex-1">
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(queryInput);
              if (e.key === 'Escape' && queryInput !== '') {
                setQueryInput('');
                void runSearch('');
              }
            }}
            placeholder="Search the timeline…  e.g. level:error AND timeout"
            spellCheck={false}
            autoComplete="off"
            className={`w-full rounded-lg border bg-surface-0 px-3 py-1.5 font-mono text-sm text-gray-100 outline-none placeholder:font-sans placeholder:text-gray-600 focus:border-sky-600 ${
              searchError ? 'border-red-700' : 'border-edge'
            }`}
          />
          {search && (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-gray-400">
              {search.total.toLocaleString()} hits · {search.durationMs} ms
            </span>
          )}
        </div>

        <button
          onClick={toggleHighlight}
          disabled={!hasSearch}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm disabled:opacity-50 ${
            highlightActive ? 'bg-surface-3 text-amber-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Highlight matches in place instead of filtering"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m9 11-6 6v3h3l6-6" />
            <path d="m17 7 3-3 1 1-3 3" />
            <path d="m13 7 4 4" />
          </svg>
        </button>
        <button
          onClick={() => setWrap(!wrap)}
          className={`rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
            wrap ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title="Wrap long lines"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18" /><path d="M3 12h13a3 3 0 1 1 0 6h-4" /><path d="m13 16-2 2 2 2" /><path d="M3 18h4" />
          </svg>
        </button>
        <button
          onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          title="Toggle row order"
        >
          {order === 'asc' ? 'Oldest' : 'Newest'}
        </button>
        <button
          onClick={() => void toggleTimelineTail()}
          disabled={sources.length === 0}
          className={`flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-sm disabled:opacity-50 ${
            allTailing ? 'bg-surface-3 text-emerald-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
          }`}
          title={
            allTailing
              ? 'Stop tailing every file in the timeline'
              : 'Tail every file in the timeline (follow new lines live)'
          }
        >
          <span className={`h-2 w-2 rounded-full ${allTailing ? 'animate-pulse bg-emerald-400' : 'bg-gray-600'}`} />
          Tail all
        </button>
        <button
          onClick={() => void build()}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-gray-400 hover:text-gray-100"
          title="Rebuild from current file contents"
        >
          Refresh
        </button>
      </div>

      {/* source legend */}
      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-surface-1 px-3 py-1">
          {sources.map((s, i) => (
            <span key={s.id} className="flex items-center gap-1 text-xs text-gray-400" title={s.file}>
              <span className="h-2 w-2 rounded-sm" style={{ background: sourceColor.get(i) }} />
              {baseName(s.file)}
            </span>
          ))}
        </div>
      )}

      {histogram && histogram.buckets.length > 0 && (
        <Histogram data={histogram} onSelectRange={onSeek} hint="drag to jump to a time" />
      )}

      {phase === 'none' && <div className="flex flex-1 items-center justify-center text-sm text-gray-500">Select at least one file from the Files menu.</div>}
      {phase === 'building' && <div className="flex flex-1 items-center justify-center text-sm text-gray-500">Building timeline…</div>}
      {phase === 'error' && <div className="flex flex-1 items-center justify-center text-sm text-red-400">{error}</div>}
      {phase === 'ready' && listTotal === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
          {hasSearch ? 'No matching lines.' : 'No timestamped lines across the selected files.'}
        </div>
      )}

      {phase === 'ready' && listTotal > 0 && (
        <div className="flex min-h-0 flex-1">
          <div ref={parentRef} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-none outline-none">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((item) => {
                const row = rowAt(item.index);
                return (
                  <div
                    key={item.key}
                    ref={wrap ? virtualizer.measureElement : undefined}
                    data-index={item.index}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', ...(wrap ? { minHeight: ROW_HEIGHT } : { height: item.size }), transform: `translateY(${item.start}px)` }}
                  >
                    {row ? (
                      <Row
                        row={row}
                        selected={selected?.seq === row.seq}
                        bookmarked={getBookmarks(row.file).includes(row.lineNo)}
                        color={sourceColor.get(row.source) ?? '#64748b'}
                        wrap={wrap}
                        tz={tz}
                        highlightActive={highlightActive}
                        highlightRegex={highlightRegex}
                        onSelect={() => setSelected(row)}
                        onToggleBookmark={() => toggleBookmark(row.file, row.lineNo)}
                        onContext={() => setContext({ sessionId: sources[row.source].id, lineNo: row.lineNo })}
                        onOpen={() => onJump(sources[row.source].id, row.lineNo)}
                      />
                    ) : (
                      <div className="flex h-6 items-center px-3">
                        <div className="h-2.5 w-1/3 animate-pulse-subtle rounded bg-surface-2" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {selected && (
            <DetailPanel
              sessionId={sources[selected.source].id}
              file={sources[selected.source].file}
              lineNo={selected.lineNo}
              onClose={() => setSelected(null)}
              onAddFilter={(clause) => {
                const q = query.trim() === '' ? clause : `${query.trim()} ${clause}`;
                setQueryInput(q);
                void runSearch(q);
              }}
            />
          )}
        </div>
      )}

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-surface-1 px-3 text-[11px] text-gray-400">
        <span className="font-medium text-gray-300">
          {hasSearch && !highlightActive ? `${listTotal.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()} timestamped lines
        </span>
        <span className="text-gray-500">· {sources.length} files</span>
      </div>

      {context && (
        <ContextPeek
          sessionId={context.sessionId}
          lineNo={context.lineNo}
          highlightTerms={highlightTerms}
          onClose={() => setContext(null)}
          onJumpToLine={(lineNo) => {
            setContext(null);
            onJump(context.sessionId, lineNo);
          }}
        />
      )}
    </div>
  );
}

const Row = memo(function Row({
  row,
  selected,
  bookmarked,
  color,
  wrap,
  tz,
  highlightActive,
  highlightRegex,
  onSelect,
  onToggleBookmark,
  onContext,
  onOpen,
}: {
  row: MergedRow;
  selected: boolean;
  bookmarked: boolean;
  color: string;
  wrap: boolean;
  tz: Tz;
  highlightActive: boolean;
  highlightRegex: RegExp | null;
  onSelect: () => void;
  onToggleBookmark: () => void;
  onContext: () => void;
  onOpen: () => void;
}) {
  const isMatch = highlightActive && row.match === true;
  let content: React.ReactNode = row.text;
  if (highlightRegex && row.text) {
    const parts = row.text.split(highlightRegex);
    if (parts.length > 1) content = parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
  }
  return (
    <div
      onClick={onSelect}
      className={`group flex cursor-pointer gap-2 border-l-2 pr-3 font-mono text-[13px] leading-6 ${
        wrap ? 'min-h-6 items-start py-px' : 'h-full items-center'
      } ${selected ? 'bg-sky-950/60' : isMatch ? 'bg-amber-950/25 hover:bg-amber-950/40' : 'hover:bg-surface-1'}`}
      style={{ borderColor: selected ? '#38bdf8' : color }}
      title={`${baseName(row.file)} — click for detail`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark();
        }}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this line'}
        className={`w-4 shrink-0 select-none text-center text-[11px] ${
          bookmarked ? 'text-amber-400' : 'text-gray-700 opacity-0 hover:text-amber-300 group-hover:opacity-100'
        }`}
      >
        {bookmarked ? '⚑' : '⚐'}
      </button>
      <span className="w-16 shrink-0 truncate text-[10px] leading-6" style={{ color }} title={row.file}>
        {baseName(row.file)}
      </span>
      <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{formatTs(row.ts, tz)}</span>
      {row.level && (
        <span className={`w-12 shrink-0 rounded px-1 text-center text-[10px] font-semibold leading-4 ${LEVEL_STYLES[row.level] ?? 'bg-slate-800 text-slate-300'}`}>
          {row.level}
        </span>
      )}
      {row.span > 1 && (
        <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] leading-4 text-gray-400" title={`${row.span} lines — open for full record`}>
          +{row.span - 1}
        </span>
      )}
      <span className={`min-w-0 flex-1 text-gray-200 ${wrap ? 'whitespace-pre-wrap break-all' : 'truncate whitespace-pre'}`}>
        {content}
        {row.truncated && <span className="text-gray-500"> … (truncated)</span>}
      </span>
      <span className="ml-1 hidden shrink-0 items-center gap-1 group-hover:flex">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onContext();
          }}
          title="Show surrounding lines in the source file"
          className="rounded border border-edge bg-surface-2 px-1.5 text-[10px] leading-4 text-gray-400 hover:text-sky-300"
        >
          ± ctx
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title="Open this line in its file tab"
          className="rounded border border-edge bg-surface-2 px-1.5 text-[10px] leading-4 text-gray-400 hover:text-sky-300"
        >
          ↗
        </button>
      </span>
    </div>
  );
});
