import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { HistogramData, SessionStatus } from '../types';
import SearchBar from './SearchBar';
import LogList from './LogList';
import DetailPanel from './DetailPanel';
import Histogram from './Histogram';
import StatusBar from './StatusBar';

export default function LogView({
  initial,
  onOpenFile,
}: {
  initial: SessionStatus;
  onOpenFile: () => void;
}) {
  const id = initial.id;
  const [status, setStatus] = useState<SessionStatus>(initial);
  const [query, setQuery] = useState(initial.search?.query ?? '');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /** Bumped whenever the visible data set changes (new search, appended lines). */
  const [epoch, setEpoch] = useState(0);
  const [total, setTotal] = useState(initial.search?.total ?? initial.lineCount);
  const [selected, setSelected] = useState<number | null>(null);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [histogramOpen, setHistogramOpen] = useState(true);
  const [followTail, setFollowTail] = useState(initial.tail);
  const statusRef = useRef(status);
  statusRef.current = status;

  const refreshHistogram = useCallback(() => {
    void api.histogram(id).then(setHistogram).catch(() => setHistogram(null));
  }, [id]);

  // --- SSE wiring -----------------------------------------------------------
  useEffect(() => {
    let histogramTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleHistogram = (): void => {
      if (histogramTimer) return;
      histogramTimer = setTimeout(() => {
        histogramTimer = null;
        refreshHistogram();
      }, 1200);
    };
    const apply = (s: SessionStatus): void => {
      setStatus(s);
      setTotal(s.search ? s.search.total : s.lineCount);
    };
    const off = api.events(id, {
      status: apply,
      progress: apply,
      done: (s) => {
        apply(s);
        setEpoch((e) => e + 1);
        refreshHistogram();
      },
      append: (s) => {
        apply(s);
        setEpoch((e) => e + 1);
        scheduleHistogram();
      },
      truncated: (s) => {
        apply(s);
      },
      error: apply,
    });
    return () => {
      off();
      if (histogramTimer) clearTimeout(histogramTimer);
    };
  }, [id, refreshHistogram]);

  // initial histogram once the index is ready
  useEffect(() => {
    if (initial.phase === 'ready') refreshHistogram();
  }, [initial.phase, refreshHistogram]);

  // --- search ---------------------------------------------------------------
  const runSearch = useCallback(
    async (q: string) => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await api.search(id, q);
        setTotal(r.total);
        setSelected(null);
        setEpoch((e) => e + 1);
        const s = await api.session(id);
        setStatus(s);
        refreshHistogram();
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err));
      } finally {
        setSearching(false);
      }
    },
    [id, refreshHistogram],
  );

  const submitQuery = useCallback(
    (q: string) => {
      setQuery(q);
      void runSearch(q);
    },
    [runSearch],
  );

  const addFilter = useCallback(
    (clause: string) => {
      const q = query.trim() === '' ? clause : `${query.trim()} ${clause}`;
      submitQuery(q);
    },
    [query, submitQuery],
  );

  const onTimeRange = useCallback(
    (startTs: number, endTs: number) => {
      const fmt = (t: number): string => new Date(t).toISOString();
      addFilter(`timestamp:>=${fmt(startTs)} timestamp:<=${fmt(endTs)}`);
    },
    [addFilter],
  );

  const toggleTail = useCallback(async () => {
    const next = !statusRef.current.tail;
    await api.setTail(id, next);
    setStatus((s) => ({ ...s, tail: next }));
    setFollowTail(next);
  }, [id]);

  // highlight terms extracted from the active query
  const highlightTerms = useMemo(() => {
    const active = status.search?.query ?? '';
    const terms: string[] = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(active)) !== null) {
      if (m[1] !== undefined) {
        const phrase = m[1];
        // field:"phrase" — the previous token ended with a colon; skip values of field filters
        terms.push(phrase);
      } else {
        const word = m[2];
        if (/^(AND|OR|NOT)$/i.test(word)) continue;
        if (word.includes(':')) continue;
        const clean = word.replace(/^[-(]+|[)]+$/g, '');
        if (clean.length >= 2) terms.push(clean.replaceAll('*', ''));
      }
    }
    return terms.filter((t) => t.length >= 2);
  }, [status.search?.query]);

  return (
    <div className="flex h-full flex-col">
      <SearchBar
        query={query}
        onChange={setQuery}
        onSubmit={submitQuery}
        searching={searching}
        error={searchError}
        search={status.search}
        tail={status.tail}
        onToggleTail={() => void toggleTail()}
        onOpenFile={onOpenFile}
        exportUrls={{ csv: api.exportUrl(id, 'csv'), json: api.exportUrl(id, 'json') }}
        histogramOpen={histogramOpen}
        onToggleHistogram={() => setHistogramOpen((v) => !v)}
        fieldNames={status.fieldNames}
      />

      {histogramOpen && histogram && histogram.buckets.length > 0 && (
        <Histogram data={histogram} onSelectRange={onTimeRange} />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <LogList
            sessionId={id}
            epoch={epoch}
            total={total}
            followTail={status.tail && followTail}
            selected={selected}
            onSelect={setSelected}
            highlightTerms={highlightTerms}
            onUserScroll={() => setFollowTail(false)}
            onScrolledToEnd={() => status.tail && setFollowTail(true)}
          />
        </div>
        {selected !== null && (
          <DetailPanel
            sessionId={id}
            lineNo={selected}
            onClose={() => setSelected(null)}
            onAddFilter={addFilter}
          />
        )}
      </div>

      <StatusBar status={status} total={total} onLevelClick={(level) => submitQuery(`level:${level}`)} />
    </div>
  );
}
