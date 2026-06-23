import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, formatTs, formatDelta } from '../api';
import { useOrder, useTz, useRowHeight, useLevelBars, useDeltaColumn, getPageJump, getPageJumpBig, type Tz } from '../settings';
import { useRedactor } from '../redaction';
import { useBookmarks, toggleBookmark } from '../bookmarks';
import { matchCommand, getChord, formatChord } from '../keybindings';
import { isModalOpen } from '../escStack';
import type { RowData } from '../types';

const BLOCK = 256;

// columnar (grid) view fixed column widths, in px
const TIME_W = 168;
const LEVEL_W = 52;
const COL_W = 190;
const DELTA_W = 64;
/** Vertical divider between columnar cells (header + rows), so column edges read. */
const COL_DIVIDER = 'border-l border-edge';

/** Tint the Δt value by magnitude so stalls/latency jumps stand out. */
function deltaClass(ms: number): string {
  if (ms >= 60_000) return 'text-red-400';
  if (ms >= 5_000) return 'text-amber-400';
  if (ms >= 1_000) return 'text-amber-300';
  return 'text-gray-600';
}

const LEVEL_STYLES: Record<string, string> = {
  TRACE: 'bg-slate-800 text-slate-400',
  DEBUG: 'bg-slate-800 text-slate-300',
  INFO: 'bg-sky-950 text-sky-300',
  WARN: 'bg-amber-950 text-amber-300',
  ERROR: 'bg-red-950 text-red-300',
  FATAL: 'bg-fuchsia-950 text-fuchsia-300',
};

const LEVEL_BAR: Record<string, string> = {
  WARN: 'bg-amber-500',
  ERROR: 'bg-red-500',
  FATAL: 'bg-fuchsia-500',
};

interface Block {
  epoch: number;
  rows: RowData[];
}

export default function LogList({
  sessionId,
  file,
  epoch,
  appendEpoch,
  total,
  followTail,
  selected,
  onSelect,
  onActivate,
  onContext,
  selRange,
  onRange,
  showContext,
  indexing,
  hasSearch,
  highlight,
  grouped,
  wrap,
  columnar,
  columns,
  captureExtractors,
  columnWidths,
  onColumnResize,
  onReorderColumns,
  scrollTo,
  highlightTerms,
  regexPattern,
  onAddFilter,
  onUserScroll,
  onScrolledToEnd,
}: {
  sessionId: string;
  file: string;
  epoch: number;
  /** Bumped (alongside epoch) only on a live append, so the tail is kept. */
  appendEpoch: number;
  total: number;
  followTail: boolean;
  selected: number | null;
  /** Move the selection (keyboard nav); does not open the detail panel. */
  onSelect: (lineNo: number) => void;
  /** Activate a row (click): select it and open the detail panel. */
  onActivate: (lineNo: number) => void;
  onContext: (lineNo: number) => void;
  /** Inclusive display-index span of a multi-row selection (Shift+click / Shift+Arrow). */
  selRange: { from: number; to: number } | null;
  /** Report a new multi-row selection span, or null to clear it. */
  onRange: (range: { from: number; to: number } | null) => void;
  showContext: boolean;
  /** The file is still being indexed — an empty list means "loading", not "empty". */
  indexing: boolean;
  /** Whether a search is active, so the empty state can distinguish no-matches. */
  hasSearch: boolean;
  highlight: boolean;
  grouped: boolean;
  wrap: boolean;
  columnar: boolean;
  columns: string[];
  /** Ad-hoc capture columns: name → extractor over the row text (client-side). */
  captureExtractors?: Map<string, (text: string) => string | undefined>;
  /** Per-column pixel widths (file-persisted); columns without one use the default. */
  columnWidths: Record<string, number>;
  /** Persist a dragged column width. */
  onColumnResize: (col: string, width: number) => void;
  /** Persist a new column order (drag-to-reorder in the header). */
  onReorderColumns: (cols: string[]) => void;
  scrollTo: { lineNo: number; nonce: number } | null;
  highlightTerms: string[];
  regexPattern: string | null;
  /** Add a `field:value` clause to the query (columnar cell click). */
  onAddFilter: (clause: string) => void;
  onUserScroll: () => void;
  onScrolledToEnd: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(new Map<number, Block>());
  const loadingRef = useRef(new Set<number>());
  // multi-row selection anchors (display indices); the range itself lives in the parent
  const rangeAnchorRef = useRef<number | null>(null);
  const rangeFocusRef = useRef<number | null>(null);
  const onRangeRef = useRef(onRange);
  onRangeRef.current = onRange;
  const [, forceRender] = useState(0);
  const epochRef = useRef(epoch);
  const appendEpochRef = useRef(appendEpoch);
  const order = useOrder();
  const tz = useTz();
  const rowHeight = useRowHeight();
  const { redact } = useRedactor();
  const levelBars = useLevelBars();
  const deltaColumn = useDeltaColumn();
  const bookmarks = useBookmarks(file);
  const bookmarkSet = useMemo(() => new Set(bookmarks), [bookmarks]);
  const orderRef = useRef(order);

  // changing the global order remaps every display position — drop all blocks
  if (order !== orderRef.current) {
    orderRef.current = order;
    blocksRef.current.clear();
    loadingRef.current.clear();
  }

  // A full reset (new search, grouping change, refresh, finalize) replaces the
  // whole data set, so every loaded block is stale. A live append only grows the
  // tail, so we keep loaded blocks and drop just the previously-incomplete ones.
  const prevTotalRef = useRef(total);
  if (epoch !== epochRef.current) {
    const wasAppend = appendEpoch !== appendEpochRef.current;
    epochRef.current = epoch;
    appendEpochRef.current = appendEpoch;
    if (wasAppend) {
      if (order === 'desc') {
        // Newest-first: an append remaps every display position (display index d
        // shows line total-1-d), so every cached block is now stale — drop them
        // all and let the visible window refetch. Without this the top (newest)
        // rows freeze while the file keeps growing.
        blocksRef.current.clear();
        loadingRef.current.clear();
      } else {
        // Oldest-first: appended lines only extend the tail, so keep earlier
        // blocks and refetch just the last (now-grown) block and any partials.
        const lastBlock = Math.floor(Math.max(0, prevTotalRef.current - 1) / BLOCK);
        for (const [idx, block] of blocksRef.current) {
          if (idx >= lastBlock || block.rows.length < BLOCK) blocksRef.current.delete(idx);
        }
      }
    } else {
      blocksRef.current.clear();
      loadingRef.current.clear();
    }
  }
  prevTotalRef.current = total;

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 30,
  });

  // Re-measure when the font-size preset changes the row height.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // a reset (new search, grouping/order change, append) invalidates display
  // positions, so drop any multi-row selection
  useEffect(() => {
    rangeAnchorRef.current = null;
    rangeFocusRef.current = null;
    onRangeRef.current(null);
  }, [epoch, order]);

  // Click selection: plain click activates one row (and anchors); Shift+click
  // extends a span from the anchor to the clicked row for copy/export.
  const clickRow = useCallback(
    (viewIndex: number, lineNo: number, shift: boolean): void => {
      if (shift && rangeAnchorRef.current !== null) {
        const a = rangeAnchorRef.current;
        rangeFocusRef.current = viewIndex;
        onRangeRef.current({ from: Math.min(a, viewIndex), to: Math.max(a, viewIndex) });
        onSelect(lineNo);
      } else {
        rangeAnchorRef.current = viewIndex;
        rangeFocusRef.current = viewIndex;
        onRangeRef.current(null);
        onActivate(lineNo);
      }
    },
    [onSelect, onActivate],
  );

  const fetchBlock = useCallback(
    (blockIdx: number) => {
      if (blocksRef.current.has(blockIdx) || loadingRef.current.has(blockIdx)) return;
      loadingRef.current.add(blockIdx);
      const requestEpoch = epochRef.current;
      const requestOrder = orderRef.current;
      // capture columns are computed client-side from the row text — the backend
      // only projects real indexed fields, so don't ask it for capture names
      const backendCols = columnar
        ? columns.filter((c) => !captureExtractors?.has(c))
        : undefined;
      void api
        .rows(sessionId, blockIdx * BLOCK, BLOCK, requestOrder, highlight, grouped, backendCols)
        .then((r) => {
          if (epochRef.current !== requestEpoch || orderRef.current !== requestOrder) return; // stale
          if (columnar && captureExtractors && captureExtractors.size > 0) {
            for (const row of r.rows) {
              const cols = { ...(row.cols ?? {}) };
              for (const c of columns) {
                const ex = captureExtractors.get(c);
                if (ex) cols[c] = ex(row.text) ?? '';
              }
              row.cols = cols;
            }
          }
          blocksRef.current.set(blockIdx, { epoch: requestEpoch, rows: r.rows });
          forceRender((n) => n + 1);
        })
        .finally(() => loadingRef.current.delete(blockIdx));
    },
    [sessionId, highlight, grouped, columnar, columns, captureExtractors],
  );

  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (items.length === 0) return;
    const firstBlock = Math.floor(items[0].index / BLOCK);
    const lastBlock = Math.floor(items[items.length - 1].index / BLOCK);
    for (let b = firstBlock; b <= lastBlock; b++) fetchBlock(b);
  }, [items, fetchBlock, epoch, total, order]);

  // follow tail: keep pinned to the live edge as data arrives. Newest lines sit
  // at the bottom in ascending order, at the top in descending order.
  useEffect(() => {
    if (followTail && total > 0) {
      virtualizer.scrollToIndex(order === 'desc' ? 0 : total - 1, {
        align: order === 'desc' ? 'start' : 'end',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followTail, total, epoch, order]);

  // jump to a specific line (used by "open in full view"). The caller clears any
  // active filter first, so the view is unfiltered and the display position maps
  // directly from the line number (mirrored for newest-first order).
  const jumpNonceRef = useRef(0);
  useEffect(() => {
    if (!scrollTo || scrollTo.nonce === jumpNonceRef.current || total === 0) return;
    jumpNonceRef.current = scrollTo.nonce;
    const viewIndex = order === 'desc' ? Math.max(0, total - 1 - scrollTo.lineNo) : scrollTo.lineNo;
    virtualizer.scrollToIndex(Math.min(viewIndex, total - 1), { align: 'center' });
  }, [scrollTo, total, order, virtualizer]);

  const rowAt = (index: number): RowData | null => {
    const block = blocksRef.current.get(Math.floor(index / BLOCK));
    return block?.rows[index % BLOCK] ?? null;
  };

  const viewIndexOf = (lineNo: number): number | null => {
    for (const [blockIdx, block] of blocksRef.current) {
      const i = block.rows.findIndex((r) => r.lineNo === lineNo);
      if (i >= 0) return blockIdx * BLOCK + i;
    }
    return null;
  };

  // Scroll to a display position and select the row there. The row may not be
  // loaded yet, so remember the target and resolve it once its block arrives.
  const pendingSelectRef = useRef<number | null>(null);
  const selectAtViewIndex = (target: number, align: 'auto' | 'center' | 'start' | 'end' = 'center'): void => {
    if (total === 0) return;
    const t = Math.max(0, Math.min(total - 1, target));
    virtualizer.scrollToIndex(t, { align });
    const row = rowAt(t);
    if (row) {
      onSelect(row.lineNo);
      pendingSelectRef.current = null;
    } else {
      pendingSelectRef.current = t;
    }
  };

  // resolve a pending selection once the target row's block has loaded
  useEffect(() => {
    if (pendingSelectRef.current === null) return;
    const row = rowAt(pendingSelectRef.current);
    if (row) {
      onSelect(row.lineNo);
      pendingSelectRef.current = null;
    }
  });

  // keyboard navigation. Arrows are fixed; the rest resolve through the
  // rebindable keybinding store. Page/Home/End move by display position;
  // F3 / Shift+F3 jump between matches when highlight mode is on.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const anchor = (): number => {
      if (selected !== null) {
        const idx = viewIndexOf(selected);
        if (idx !== null) return idx;
      }
      return virtualizer.getVirtualItems()[0]?.index ?? 0;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (selected === null) return;
        const cur = viewIndexOf(selected);
        if (cur === null) return;
        e.preventDefault();
        const next = Math.max(0, Math.min(total - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        if (e.shiftKey) {
          // extend the multi-row selection from the anchor to the moving focus
          if (rangeAnchorRef.current === null) rangeAnchorRef.current = cur;
          const a = rangeAnchorRef.current;
          rangeFocusRef.current = next;
          onRangeRef.current({ from: Math.min(a, next), to: Math.max(a, next) });
        } else {
          rangeAnchorRef.current = next;
          rangeFocusRef.current = next;
          onRangeRef.current(null);
        }
        selectAtViewIndex(next, 'auto');
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
          selectAtViewIndex(total - 1, 'end');
          break;
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [selected, total, onSelect, virtualizer]);

  // Find next/previous match (highlight mode). Unlike the focus-scoped list
  // navigation above, this is a window listener so it also works while typing in
  // the search bar — but it yields to any open modal (e.g. the value viewer,
  // which has its own match navigation).
  useEffect(() => {
    if (!highlight) return;
    const onKey = (e: KeyboardEvent): void => {
      const cmd = matchCommand(e);
      if ((cmd !== 'nextMatch' && cmd !== 'prevMatch') || isModalOpen()) return;
      e.preventDefault();
      const dir = cmd === 'prevMatch' ? 'prev' : 'next';
      const after = selected ?? (dir === 'next' ? -1 : total);
      void api.nextMatch(sessionId, after, dir, grouped).then((m) => {
        if (!m) return;
        const display = orderRef.current === 'desc' ? total - 1 - m.viewIndex : m.viewIndex;
        virtualizer.scrollToIndex(Math.max(0, Math.min(total - 1, display)), { align: 'center' });
        onSelect(m.lineNo);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [highlight, selected, total, grouped, sessionId, onSelect, virtualizer]);

  const highlightRegex = useMemo(() => {
    // in regex mode, highlight the pattern itself; otherwise the literal terms
    if (regexPattern) {
      try {
        return new RegExp(`(${regexPattern})`, 'gi');
      } catch {
        return null;
      }
    }
    if (highlightTerms.length === 0) return null;
    const escaped = highlightTerms
      .filter((t) => t.length > 0)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escaped.length === 0) return null;
    try {
      return new RegExp(`(${escaped.join('|')})`, 'gi');
    } catch {
      return null;
    }
  }, [highlightTerms, regexPattern]);

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    // the "live edge" is the bottom in ascending order, the top in descending
    const atLiveEdge =
      order === 'desc'
        ? el.scrollTop <= rowHeight * 2
        : el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 2;
    if (atLiveEdge) onScrolledToEnd();
  }, [onScrolledToEnd, order, rowHeight]);

  const gutterWidth = Math.max(5, String(total).length) + 1;

  // Δt = gap to the chronologically-previous row in the view (the row above in
  // oldest-first, below in newest-first). Computed from adjacent loaded rows, so
  // it respects the active filter/grouping; null until the neighbour is loaded.
  const deltaFor = (index: number, row: RowData | null): number | null => {
    if (!deltaColumn || !row || row.ts == null) return null;
    const prev = order === 'asc' ? rowAt(index - 1) : rowAt(index + 1);
    return prev && prev.ts != null ? row.ts - prev.ts : null;
  };

  const widthOf = useCallback((c: string): number => columnWidths[c] ?? COL_W, [columnWidths]);
  const columnsPx = columns.reduce((sum, c) => sum + widthOf(c), 0);
  const gridMinWidth = `calc(${gutterWidth + 2}ch + ${16 + TIME_W + (deltaColumn ? DELTA_W : 0) + LEVEL_W + columnsPx}px)`;

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onScroll={onScroll}
      onWheel={onUserScroll}
      className={`h-full overscroll-none bg-surface-0 outline-none ${
        columnar ? 'overflow-auto' : 'overflow-y-auto'
      }`}
    >
      {total === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-500">
          {indexing ? (
            <>
              <svg className="h-5 w-5 animate-spin text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.22-8.56" />
              </svg>
              <span>Indexing the file — lines appear here as they're read…</span>
            </>
          ) : hasSearch ? (
            'No matching log lines'
          ) : (
            'No log lines'
          )}
        </div>
      ) : columnar ? (
        <div style={{ minWidth: gridMinWidth }}>
          <GridHeader
            columns={columns}
            widthOf={widthOf}
            gutterWidth={gutterWidth}
            showDelta={deltaColumn}
            onResize={onColumnResize}
            onReorder={onReorderColumns}
          />
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rowAt(item.index);
              return (
                <div
                  key={item.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {row ? (
                    <GridRow
                      row={row}
                      viewIndex={item.index}
                      selected={selected === row.lineNo}
                      inRange={selRange !== null && item.index >= selRange.from && item.index <= selRange.to}
                      bookmarked={bookmarkSet.has(row.lineNo)}
                      onClickRow={clickRow}
                      onAddFilter={onAddFilter}
                      onToggleBookmark={() => toggleBookmark(file, row.lineNo)}
                      columns={columns}
                      columnWidths={columnWidths}
                      gutterWidth={gutterWidth}
                      tz={tz}
                      redact={redact}
                      showDelta={deltaColumn}
                      delta={deltaFor(item.index, row)}
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
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const row = rowAt(item.index);
            // When wrapping, rows have variable height: let the virtualizer measure
            // each rendered row. Otherwise keep the fixed-height fast path.
            return (
              <div
                key={item.key}
                ref={wrap ? virtualizer.measureElement : undefined}
                data-index={item.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  ...(wrap ? { minHeight: rowHeight } : { height: item.size }),
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row ? (
                  <Row
                    row={row}
                    viewIndex={item.index}
                    selected={selected === row.lineNo}
                    inRange={selRange !== null && item.index >= selRange.from && item.index <= selRange.to}
                    bookmarked={bookmarkSet.has(row.lineNo)}
                    onClickRow={clickRow}
                    onContext={onContext}
                    onToggleBookmark={() => toggleBookmark(file, row.lineNo)}
                    showContext={showContext}
                    highlight={highlight}
                    highlightRegex={highlightRegex}
                    gutterWidth={gutterWidth}
                    tz={tz}
                    wrap={wrap}
                    redact={redact}
                    levelBars={levelBars}
                    showDelta={deltaColumn}
                    delta={deltaFor(item.index, row)}
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
      )}
    </div>
  );
}

const Row = memo(function Row({
  row,
  viewIndex,
  selected,
  inRange,
  bookmarked,
  onClickRow,
  onContext,
  onToggleBookmark,
  showContext,
  highlight,
  highlightRegex,
  gutterWidth,
  tz,
  wrap,
  redact,
  levelBars,
  showDelta,
  delta,
}: {
  row: RowData;
  viewIndex: number;
  selected: boolean;
  inRange: boolean;
  bookmarked: boolean;
  onClickRow: (viewIndex: number, lineNo: number, shift: boolean) => void;
  onContext: (lineNo: number) => void;
  onToggleBookmark: () => void;
  showContext: boolean;
  highlight: boolean;
  highlightRegex: RegExp | null;
  gutterWidth: number;
  tz: Tz;
  wrap: boolean;
  redact: (text: string) => string;
  levelBars: boolean;
  showDelta: boolean;
  delta: number | null;
}) {
  const levelClass = row.level ? (LEVEL_STYLES[row.level] ?? 'bg-slate-800 text-slate-300') : '';
  const bar = row.level ? LEVEL_BAR[row.level] : undefined;
  const isMatch = highlight && row.match === true;

  const text = redact(row.text);
  let content: React.ReactNode = text;
  if (highlightRegex && text) {
    const parts = text.split(highlightRegex);
    if (parts.length > 1) {
      content = parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
    }
  }

  return (
    <div
      onClick={(e) => onClickRow(viewIndex, row.lineNo, e.shiftKey)}
      // suppress the browser's shift+click text selection; normal drag-select still works
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      className={`group row-text tb-log-text relative flex cursor-pointer gap-2 border-l-2 pr-3 font-mono ${
        wrap ? 'items-start py-px' : 'h-full items-center'
      } ${
        selected
          ? 'border-sky-400 bg-sky-950/60'
          : inRange
            ? 'border-sky-400/50 bg-sky-950/35'
            : isMatch
              ? 'border-amber-500/70 bg-amber-950/25 hover:bg-amber-950/40'
              : 'border-transparent hover:bg-surface-1'
      }`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark();
        }}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this line'}
        className={`w-4 shrink-0 select-none text-center text-[11px] leading-6 ${
          bookmarked
            ? 'text-amber-400'
            : 'text-gray-700 opacity-0 hover:text-amber-300 group-hover:opacity-100'
        }`}
      >
        {bookmarked ? '⚑' : '⚐'}
      </button>
      <span
        className="shrink-0 select-none text-right text-[11px] text-gray-600"
        style={{ width: `${gutterWidth}ch` }}
      >
        {row.lineNo + 1}
      </span>
      {levelBars && bar && !selected && <span className={`h-3.5 w-0.5 shrink-0 rounded ${bar}`} />}
      <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{formatTs(row.ts, tz)}</span>
      {showDelta && (
        <span
          className={`shrink-0 select-none whitespace-nowrap text-right text-[11px] ${delta == null ? 'text-gray-700' : deltaClass(delta)}`}
          style={{ width: DELTA_W }}
          title={delta == null ? undefined : `${formatDelta(delta)} since the previous row`}
        >
          {delta == null ? '' : formatDelta(delta)}
        </span>
      )}
      {row.level && (
        <span
          className={`w-12 shrink-0 rounded px-1 text-center text-[10px] font-semibold leading-4 ${levelClass}`}
        >
          {row.level}
        </span>
      )}
      {row.span !== undefined && row.span > 1 && (
        <span
          className="shrink-0 rounded bg-surface-2 px-1 text-[10px] leading-4 text-gray-400"
          title={`${row.span} lines (stack trace / multi-line) — open to expand`}
        >
          +{row.span - 1}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 text-gray-200 ${
          wrap ? 'whitespace-pre-wrap break-all' : 'truncate whitespace-pre'
        }`}
      >
        {content}
        {row.truncated && <span className="text-gray-500"> … (truncated — open details)</span>}
      </span>
      {showContext && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onContext(row.lineNo);
          }}
          title={`Show surrounding lines (context)${getChord('openContext') ? ` — ${formatChord(getChord('openContext'))}` : ''}`}
          className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-edge bg-surface-2 px-1.5 text-[10px] leading-4 text-gray-400 shadow group-hover:block hover:text-sky-300"
        >
          ± context
        </button>
      )}
    </div>
  );
});

const GridRow = memo(function GridRow({
  row,
  viewIndex,
  selected,
  inRange,
  bookmarked,
  onClickRow,
  onAddFilter,
  onToggleBookmark,
  columns,
  columnWidths,
  gutterWidth,
  tz,
  redact,
  showDelta,
  delta,
}: {
  row: RowData;
  viewIndex: number;
  selected: boolean;
  inRange: boolean;
  bookmarked: boolean;
  onClickRow: (viewIndex: number, lineNo: number, shift: boolean) => void;
  onAddFilter: (clause: string) => void;
  onToggleBookmark: () => void;
  columns: string[];
  columnWidths: Record<string, number>;
  gutterWidth: number;
  tz: Tz;
  redact: (text: string) => string;
  showDelta: boolean;
  delta: number | null;
}) {
  const levelClass = row.level ? (LEVEL_STYLES[row.level] ?? 'bg-slate-800 text-slate-300') : '';
  return (
    <div
      onClick={(e) => onClickRow(viewIndex, row.lineNo, e.shiftKey)}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      className={`group tb-log-text flex h-full cursor-pointer items-stretch gap-2 border-l-2 pr-3 font-mono ${
        selected
          ? 'border-sky-400 bg-sky-950/60'
          : inRange
            ? 'border-sky-400/50 bg-sky-950/35'
            : 'border-transparent hover:bg-surface-1'
      }`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark();
        }}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this line'}
        className={`flex w-4 shrink-0 select-none items-center justify-center text-[11px] ${
          bookmarked ? 'text-amber-400' : 'text-gray-700 opacity-0 hover:text-amber-300 group-hover:opacity-100'
        }`}
      >
        {bookmarked ? '⚑' : '⚐'}
      </button>
      <span className="flex shrink-0 select-none items-center justify-end text-[11px] text-gray-600" style={{ width: `${gutterWidth}ch` }}>
        {row.lineNo + 1}
      </span>
      <span className={`flex shrink-0 items-center whitespace-nowrap pl-2 text-xs text-gray-500 ${COL_DIVIDER}`} style={{ width: TIME_W }}>
        {formatTs(row.ts, tz)}
      </span>
      {showDelta && (
        <span
          className={`flex shrink-0 items-center justify-end pl-2 text-[11px] ${COL_DIVIDER} ${delta == null ? 'text-gray-700' : deltaClass(delta)}`}
          style={{ width: DELTA_W }}
          title={delta == null ? undefined : `${formatDelta(delta)} since the previous row`}
        >
          {delta == null ? '' : formatDelta(delta)}
        </span>
      )}
      <span className={`flex shrink-0 items-center pl-2 ${COL_DIVIDER}`} style={{ width: LEVEL_W }}>
        {row.level && (
          <span className={`rounded px-1 text-[10px] font-semibold leading-4 ${levelClass}`}>{row.level}</span>
        )}
      </span>
      {columns.map((c) => {
        const value = row.cols?.[c];
        const shown = value ? redact(value) : value;
        return (
          <span
            key={c}
            className={`flex shrink-0 items-center overflow-hidden pl-2 pr-1 ${COL_DIVIDER}`}
            style={{ width: columnWidths[c] ?? COL_W }}
          >
            {value ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddFilter(`${c}:"${value.replace(/"/g, '\\"')}"`);
                }}
                className="min-w-0 max-w-full truncate text-left text-gray-300 hover:text-sky-300 hover:underline"
                title={`${shown}\n\nClick to filter ${c} to this value`}
              >
                {shown}
              </button>
            ) : (
              <span className="text-gray-700">—</span>
            )}
          </span>
        );
      })}
    </div>
  );
});

/** Columnar header: fixed #/time/level columns, then the data columns which can be
 *  dragged to reorder and resized by dragging their right edge (widths persist). */
function GridHeader({
  columns,
  widthOf,
  gutterWidth,
  showDelta,
  onResize,
  onReorder,
}: {
  columns: string[];
  widthOf: (c: string) => number;
  gutterWidth: number;
  showDelta: boolean;
  onResize: (col: string, width: number) => void;
  onReorder: (cols: string[]) => void;
}) {
  const dragCol = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const resizing = useRef(false);

  const startResize = (col: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const startX = e.clientX;
    const startW = widthOf(col);
    const onMove = (m: MouseEvent): void => onResize(col, startW + (m.clientX - startX));
    const onUp = (): void => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const drop = (target: string): void => {
    const from = dragCol.current;
    dragCol.current = null;
    setDragOver(null);
    if (!from || from === target) return;
    const next = columns.filter((c) => c !== from);
    next.splice(next.indexOf(target), 0, from);
    onReorder(next);
  };

  return (
    <div className="sticky top-0 z-10 flex select-none items-stretch gap-2 border-b border-edge bg-surface-1 pr-3 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
      <span className="w-4 shrink-0" />
      <span className="flex shrink-0 items-center justify-end py-1" style={{ width: `${gutterWidth}ch` }}>
        #
      </span>
      <span className={`flex shrink-0 items-center py-1 ${COL_DIVIDER}`} style={{ width: TIME_W }}>
        time
      </span>
      {showDelta && (
        <span className={`flex shrink-0 items-center justify-end py-1 ${COL_DIVIDER}`} style={{ width: DELTA_W }} title="Time since the previous row">
          Δt
        </span>
      )}
      <span className={`flex shrink-0 items-center py-1 ${COL_DIVIDER}`} style={{ width: LEVEL_W }}>
        level
      </span>
      {columns.map((c) => (
        <div
          key={c}
          className={`group/col relative flex shrink-0 items-stretch ${COL_DIVIDER} ${dragOver === c ? 'bg-sky-500/15' : ''}`}
          style={{ width: widthOf(c) }}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragCol.current && dragCol.current !== c && dragOver !== c) setDragOver(c);
          }}
          onDragLeave={() => setDragOver((d) => (d === c ? null : d))}
          onDrop={() => drop(c)}
        >
          {dragOver === c && <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-sky-400" />}
          <span
            draggable
            onDragStart={(e) => {
              dragCol.current = c;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              dragCol.current = null;
              setDragOver(null);
            }}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-1 py-1 pl-2 active:cursor-grabbing"
            title={`${c} — drag to reorder`}
          >
            <svg className="h-3 w-1.5 shrink-0 text-gray-600 group-hover/col:text-gray-400" viewBox="0 0 4 12" fill="currentColor" aria-hidden>
              <circle cx="1" cy="2" r="0.8" /><circle cx="3" cy="2" r="0.8" />
              <circle cx="1" cy="6" r="0.8" /><circle cx="3" cy="6" r="0.8" />
              <circle cx="1" cy="10" r="0.8" /><circle cx="3" cy="10" r="0.8" />
            </svg>
            <span className="truncate font-mono normal-case">{c}</span>
          </span>
          {/* resize handle: a wide hit zone straddling the right edge, with a line
              that brightens on hover so the grab point is easy to find */}
          <span
            onMouseDown={(e) => startResize(c, e)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to resize this column"
            className="group/rs absolute -right-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize items-center justify-center"
          >
            <span className="h-full w-0.5 bg-transparent transition-colors group-hover/rs:bg-sky-400" />
          </span>
        </div>
      ))}
    </div>
  );
}
