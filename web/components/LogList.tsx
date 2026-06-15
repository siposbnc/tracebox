import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, formatTs } from '../api';
import { useOrder, useTz, getPageJump, getPageJumpBig, type Tz } from '../settings';
import { useBookmarks, toggleBookmark } from '../bookmarks';
import { matchCommand } from '../keybindings';
import type { RowData } from '../types';

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
  total,
  followTail,
  selected,
  onSelect,
  onContext,
  showContext,
  highlight,
  grouped,
  wrap,
  scrollTo,
  highlightTerms,
  onUserScroll,
  onScrolledToEnd,
}: {
  sessionId: string;
  file: string;
  epoch: number;
  total: number;
  followTail: boolean;
  selected: number | null;
  onSelect: (lineNo: number) => void;
  onContext: (lineNo: number) => void;
  showContext: boolean;
  highlight: boolean;
  grouped: boolean;
  wrap: boolean;
  scrollTo: { lineNo: number; nonce: number } | null;
  highlightTerms: string[];
  onUserScroll: () => void;
  onScrolledToEnd: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(new Map<number, Block>());
  const loadingRef = useRef(new Set<number>());
  const [, forceRender] = useState(0);
  const epochRef = useRef(epoch);
  const order = useOrder();
  const tz = useTz();
  const bookmarks = useBookmarks(file);
  const bookmarkSet = useMemo(() => new Set(bookmarks), [bookmarks]);
  const orderRef = useRef(order);

  // changing the global order remaps every display position — drop all blocks
  if (order !== orderRef.current) {
    orderRef.current = order;
    blocksRef.current.clear();
    loadingRef.current.clear();
  }

  // a new search invalidates everything; appended data only the incomplete tail blocks
  const prevTotalRef = useRef(total);
  const searchEpochRef = useRef(0);
  if (epoch !== epochRef.current) {
    epochRef.current = epoch;
    const lastBlock = Math.floor(Math.max(0, prevTotalRef.current - 1) / BLOCK);
    for (const [idx, block] of blocksRef.current) {
      if (idx >= lastBlock || block.rows.length < BLOCK) blocksRef.current.delete(idx);
    }
  }
  prevTotalRef.current = total;

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });

  const fetchBlock = useCallback(
    (blockIdx: number) => {
      if (blocksRef.current.has(blockIdx) || loadingRef.current.has(blockIdx)) return;
      loadingRef.current.add(blockIdx);
      const requestEpoch = epochRef.current;
      const requestOrder = orderRef.current;
      void api
        .rows(sessionId, blockIdx * BLOCK, BLOCK, requestOrder, highlight, grouped)
        .then((r) => {
          if (epochRef.current !== requestEpoch || orderRef.current !== requestOrder) return; // stale
          blocksRef.current.set(blockIdx, { epoch: requestEpoch, rows: r.rows });
          forceRender((n) => n + 1);
        })
        .finally(() => loadingRef.current.delete(blockIdx));
    },
    [sessionId, highlight, grouped],
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
        selectAtViewIndex(cur + (e.key === 'ArrowDown' ? 1 : -1), 'auto');
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
        case 'nextMatch':
        case 'prevMatch': {
          if (!highlight) return;
          e.preventDefault();
          const dir = matchCommand(e) === 'prevMatch' ? 'prev' : 'next';
          const after = selected ?? (dir === 'next' ? -1 : total);
          void api.nextMatch(sessionId, after, dir, grouped).then((m) => {
            if (!m) return;
            const display = orderRef.current === 'desc' ? total - 1 - m.viewIndex : m.viewIndex;
            virtualizer.scrollToIndex(Math.max(0, Math.min(total - 1, display)), { align: 'center' });
            onSelect(m.lineNo);
          });
          break;
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [selected, total, onSelect, virtualizer, highlight, grouped, sessionId]);

  const highlightRegex = useMemo(() => {
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
  }, [highlightTerms]);

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    // the "live edge" is the bottom in ascending order, the top in descending
    const atLiveEdge =
      order === 'desc'
        ? el.scrollTop <= ROW_HEIGHT * 2
        : el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 2;
    if (atLiveEdge) onScrolledToEnd();
  }, [onScrolledToEnd, order]);

  const gutterWidth = Math.max(5, String(total).length) + 1;

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onScroll={onScroll}
      onWheel={onUserScroll}
      className="h-full overflow-y-auto overscroll-none bg-surface-0 outline-none"
    >
      {total === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-gray-500">
          No matching log lines
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
                  ...(wrap ? { minHeight: ROW_HEIGHT } : { height: item.size }),
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row ? (
                  <Row
                    row={row}
                    selected={selected === row.lineNo}
                    bookmarked={bookmarkSet.has(row.lineNo)}
                    onSelect={onSelect}
                    onContext={onContext}
                    onToggleBookmark={() => toggleBookmark(file, row.lineNo)}
                    showContext={showContext}
                    highlight={highlight}
                    highlightRegex={highlightRegex}
                    gutterWidth={gutterWidth}
                    tz={tz}
                    wrap={wrap}
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
  selected,
  bookmarked,
  onSelect,
  onContext,
  onToggleBookmark,
  showContext,
  highlight,
  highlightRegex,
  gutterWidth,
  tz,
  wrap,
}: {
  row: RowData;
  selected: boolean;
  bookmarked: boolean;
  onSelect: (lineNo: number) => void;
  onContext: (lineNo: number) => void;
  onToggleBookmark: () => void;
  showContext: boolean;
  highlight: boolean;
  highlightRegex: RegExp | null;
  gutterWidth: number;
  tz: Tz;
  wrap: boolean;
}) {
  const levelClass = row.level ? (LEVEL_STYLES[row.level] ?? 'bg-slate-800 text-slate-300') : '';
  const bar = row.level ? LEVEL_BAR[row.level] : undefined;
  const isMatch = highlight && row.match === true;

  let content: React.ReactNode = row.text;
  if (highlightRegex && row.text) {
    const parts = row.text.split(highlightRegex);
    if (parts.length > 1) {
      content = parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
    }
  }

  return (
    <div
      onClick={() => onSelect(row.lineNo)}
      className={`group row-text relative flex cursor-pointer gap-2 border-l-2 pr-3 font-mono text-[13px] leading-6 ${
        wrap ? 'min-h-6 items-start py-px' : 'h-full items-center'
      } ${
        selected
          ? 'border-sky-400 bg-sky-950/60'
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
      {bar && !selected && <span className={`h-3.5 w-0.5 shrink-0 rounded ${bar}`} />}
      <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{formatTs(row.ts, tz)}</span>
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
          title="Show surrounding lines (context)"
          className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-edge bg-surface-2 px-1.5 text-[10px] leading-4 text-gray-400 shadow group-hover:block hover:text-sky-300"
        >
          ± context
        </button>
      )}
    </div>
  );
});
