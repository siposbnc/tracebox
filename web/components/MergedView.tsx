import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, formatTs } from '../api';
import { useOrder, setOrder, useTz } from '../settings';
import type { HistogramData, MergedRow } from '../types';
import Histogram from './Histogram';

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

// distinct colors per source file (badge + left bar)
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
  const [selected, setSelected] = useState<Set<string>>(() => new Set(files.map((f) => f.id)));
  const [picker, setPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [sources, setSources] = useState<{ id: string; file: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [phase, setPhase] = useState<'building' | 'ready' | 'error' | 'none'>('building');
  const [error, setError] = useState<string | null>(null);
  const selectedKey = useMemo(() => [...selected].sort().join(','), [selected]);

  const parentRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(new Map<number, MergedRow[]>());
  const loadingRef = useRef(new Set<number>());
  const [, forceRender] = useState(0);
  const orderRef = useRef(order);

  if (order !== orderRef.current) {
    orderRef.current = order;
    blocksRef.current.clear();
    loadingRef.current.clear();
  }

  const build = useCallback(async () => {
    const ids = [...selected];
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
      setHistogram(await api.mergedHistogram());
      setPhase('ready');
      forceRender((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // rebuild whenever the selection changes
  useEffect(() => {
    void build();
  }, [build]);

  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPicker(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [picker]);

  const toggleFile = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });

  const fetchBlock = useCallback((blockIdx: number) => {
    if (blocksRef.current.has(blockIdx) || loadingRef.current.has(blockIdx)) return;
    loadingRef.current.add(blockIdx);
    const requestOrder = orderRef.current;
    void api
      .mergedRows(blockIdx * BLOCK, BLOCK, requestOrder)
      .then((r) => {
        if (orderRef.current !== requestOrder) return;
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
  }, [items, fetchBlock, phase, total, order]);

  const rowAt = (index: number): MergedRow | null => {
    const block = blocksRef.current.get(Math.floor(index / BLOCK));
    return block?.[index % BLOCK] ?? null;
  };

  // histogram drag → scroll the list to that moment
  const onSeek = useCallback(
    (startTs: number) => {
      void api.mergedSeek(startTs).then(({ seq }) => {
        const idx = orderRef.current === 'desc' ? total - 1 - seq : seq;
        virtualizer.scrollToIndex(Math.max(0, Math.min(total - 1, idx)), { align: 'center' });
      });
    },
    [total, virtualizer],
  );

  const sourceColor = useMemo(() => {
    const m = new Map<number, string>();
    sources.forEach((_, i) => m.set(i, SOURCE_COLORS[i % SOURCE_COLORS.length]));
    return m;
  }, [sources]);

  const gutterWidth = Math.max(5, String(total).length) + 1;

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex items-center gap-3 border-b border-edge bg-surface-1 px-3 py-2">
        <span className="text-sm font-semibold text-gray-200">Merged timeline</span>

        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => setPicker((v) => !v)}
            className={`rounded-lg border border-edge px-2.5 py-1 text-sm ${
              picker ? 'bg-surface-3 text-sky-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
            }`}
            title="Choose which files to merge"
          >
            Files {selected.size}/{files.length} ▾
          </button>
          {picker && (
            <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-edge bg-surface-2 shadow-2xl">
              <div className="flex items-center justify-between border-b border-edge px-2 py-1.5 text-[10px] uppercase tracking-wider text-gray-500">
                <span>Files in timeline</span>
                <span className="flex gap-2">
                  <button className="hover:text-gray-300" onClick={() => setSelected(new Set(files.map((f) => f.id)))}>
                    All
                  </button>
                  <button className="hover:text-gray-300" onClick={() => setSelected(new Set())}>
                    None
                  </button>
                </span>
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-1">
                {files.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-3">
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggleFile(f.id)}
                      className="accent-sky-600"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-200" title={f.file}>
                      {baseName(f.file)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {sources.map((s, i) => (
            <span key={s.id} className="flex items-center gap-1 text-xs text-gray-400" title={s.file}>
              <span className="h-2 w-2 rounded-sm" style={{ background: sourceColor.get(i) }} />
              {baseName(s.file)}
            </span>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1 text-sm text-gray-400 hover:text-gray-100"
          title="Toggle row order"
        >
          {order === 'asc' ? 'Oldest' : 'Newest'}
        </button>
        <button
          onClick={() => void build()}
          className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1 text-sm text-gray-400 hover:text-gray-100"
          title="Rebuild from the current file contents"
        >
          Refresh
        </button>
      </div>

      {histogram && histogram.buckets.length > 0 && (
        <Histogram data={histogram} onSelectRange={onSeek} hint="drag to jump to a time" />
      )}

      {phase === 'none' && (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
          Select at least one file from the Files menu.
        </div>
      )}
      {phase === 'building' && (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-500">Building timeline…</div>
      )}
      {phase === 'error' && (
        <div className="flex flex-1 items-center justify-center text-sm text-red-400">{error}</div>
      )}
      {phase === 'ready' && total === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
          No timestamped lines across the open files.
        </div>
      )}

      {phase === 'ready' && total > 0 && (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-none outline-none">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rowAt(item.index);
              return (
                <div
                  key={item.key}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row ? (
                    <div
                      onClick={() => onJump(sources[row.source]?.id ?? '', row.lineNo)}
                      className="flex h-full cursor-pointer items-center gap-2 border-l-2 pr-3 font-mono text-[13px] leading-6 hover:bg-surface-1"
                      style={{ borderColor: sourceColor.get(row.source) }}
                      title={`${baseName(row.file)} — click to open in its tab`}
                    >
                      <span
                        className="w-16 shrink-0 truncate rounded px-1 text-[10px] leading-4"
                        style={{ color: sourceColor.get(row.source) }}
                        title={row.file}
                      >
                        {baseName(row.file)}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">{formatTs(row.ts, tz)}</span>
                      {row.level && (
                        <span
                          className={`w-12 shrink-0 rounded px-1 text-center text-[10px] font-semibold leading-4 ${
                            LEVEL_STYLES[row.level] ?? 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {row.level}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate whitespace-pre text-gray-200">
                        {row.text}
                        {row.truncated && <span className="text-gray-500"> … (truncated)</span>}
                      </span>
                    </div>
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
      )}

      <div className="flex h-7 items-center gap-3 border-t border-edge bg-surface-1 px-3 text-[11px] text-gray-400">
        <span className="font-medium text-gray-300">{total.toLocaleString()} timestamped lines</span>
        <span className="text-gray-500">· {sources.length} files</span>
      </div>
    </div>
  );
}
