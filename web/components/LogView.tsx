import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getBookmarks, toggleBookmark } from '../bookmarks';
import { matchCommand, eventToChord, isEditableTarget } from '../keybindings';
import type { HistogramData, SessionStatus } from '../types';
import SearchBar from './SearchBar';
import LogList from './LogList';
import DetailPanel from './DetailPanel';
import FacetPanel from './FacetPanel';
import ContextPeek from './ContextPeek';
import GoToLine from './GoToLine';
import ShortcutsHelp from './ShortcutsHelp';
import SettingsPanel from './SettingsPanel';
import Histogram from './Histogram';
import StatusBar from './StatusBar';
import { getHistogramDefault } from '../settings';

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
  const [contextLine, setContextLine] = useState<number | null>(null);
  const [pendingJump, setPendingJump] = useState<{ lineNo: number; nonce: number } | null>(null);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [histogramOpen, setHistogramOpen] = useState(getHistogramDefault);
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [highlightMode, setHighlightMode] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const s = await api.refresh(id);
      setStatus(s);
      setTotal(s.search ? s.search.total : s.lineCount);
      setEpoch((e) => e + 1);
      refreshHistogram();
    } catch {
      // transient (e.g. file briefly missing during rotation) — ignore
    } finally {
      setRefreshing(false);
    }
  }, [id, refreshHistogram]);

  // jump to an absolute line (context peek, bookmarks, go-to-line): select it and
  // scroll the list to it. When a filter is active the list is the result set, so
  // we clear it first — except in highlight mode, where the list already spans the
  // whole file and the line is reachable directly.
  const jumpToLine = useCallback(
    async (lineNo: number) => {
      setContextLine(null);
      if (statusRef.current.search && !highlightMode) {
        setQuery('');
        await runSearch('');
      }
      setSelected(lineNo);
      setPendingJump({ lineNo, nonce: Date.now() });
    },
    [runSearch, highlightMode],
  );

  const toggleHighlight = useCallback(() => {
    setHighlightMode((v) => !v);
    setEpoch((e) => e + 1);
  }, []);

  // jump to the next/previous bookmarked line relative to the current selection
  // (wrapping around the ends), so F2 / Shift+F2 cycle through them.
  const jumpBookmark = useCallback(
    (dir: 1 | -1) => {
      const marks = getBookmarks(statusRef.current.file);
      if (marks.length === 0) return;
      const cur = selected;
      let target: number;
      if (dir === 1) {
        target = marks.find((m) => cur === null || m > cur) ?? marks[0];
      } else {
        const before = marks.filter((m) => cur === null || m < cur);
        target = before.length > 0 ? before[before.length - 1] : marks[marks.length - 1];
      }
      void jumpToLine(target);
    },
    [selected, jumpToLine],
  );

  // navigation hotkeys, resolved through the rebindable keybinding store
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmd = matchCommand(e);
      if (!cmd) return;
      // don't steal plain (modifier-less, non-function) keys while typing in an input
      if (isEditableTarget(e.target) && !/Mod|Alt|F\d/.test(eventToChord(e))) return;
      switch (cmd) {
        case 'goToLine':
          e.preventDefault();
          setGotoOpen(true);
          break;
        case 'toggleBookmark':
          if (selected === null) return;
          e.preventDefault();
          toggleBookmark(statusRef.current.file, selected);
          break;
        case 'toggleHighlight':
          e.preventDefault();
          toggleHighlight();
          break;
        case 'nextBookmark':
          e.preventDefault();
          jumpBookmark(1);
          break;
        case 'prevBookmark':
          e.preventDefault();
          jumpBookmark(-1);
          break;
        case 'showShortcuts':
          e.preventDefault();
          setShortcutsOpen(true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, toggleHighlight, jumpBookmark]);

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

  // Highlight mode only takes effect when there is an active search to mark.
  const highlightActive = highlightMode && status.search !== null;
  const listTotal = highlightActive ? status.lineCount : total;

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
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        onOpenFile={onOpenFile}
        exportUrls={{ csv: api.exportUrl(id, 'csv'), json: api.exportUrl(id, 'json') }}
        histogramOpen={histogramOpen}
        onToggleHistogram={() => setHistogramOpen((v) => !v)}
        facetsOpen={facetsOpen}
        onToggleFacets={() => setFacetsOpen((v) => !v)}
        highlightMode={highlightMode}
        onToggleHighlight={toggleHighlight}
        file={status.file}
        onJumpToLine={(lineNo) => void jumpToLine(lineNo)}
        onGoToLine={() => setGotoOpen(true)}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        fieldNames={status.fieldNames}
        levelCounts={status.levelCounts}
      />

      {histogramOpen && histogram && histogram.buckets.length > 0 && (
        <Histogram data={histogram} onSelectRange={onTimeRange} />
      )}

      <div className="flex min-h-0 flex-1">
        {facetsOpen && (
          <FacetPanel
            sessionId={id}
            epoch={epoch}
            fieldNames={status.fieldNames}
            hasSearch={status.search !== null}
            onAddFilter={addFilter}
            onClose={() => setFacetsOpen(false)}
          />
        )}
        <div className="min-w-0 flex-1">
          <LogList
            key={highlightActive ? `hl:${status.search?.query ?? ''}` : 'flt'}
            sessionId={id}
            file={status.file}
            epoch={epoch}
            total={listTotal}
            followTail={status.tail && followTail}
            selected={selected}
            onSelect={setSelected}
            onContext={setContextLine}
            showContext={status.search !== null}
            highlight={highlightActive}
            scrollTo={pendingJump}
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

      {contextLine !== null && (
        <ContextPeek
          sessionId={id}
          lineNo={contextLine}
          highlightTerms={highlightTerms}
          onClose={() => setContextLine(null)}
          onJumpToLine={(lineNo) => void jumpToLine(lineNo)}
        />
      )}

      {gotoOpen && (
        <GoToLine
          lineCount={status.lineCount}
          onGo={(lineNo) => void jumpToLine(lineNo)}
          onClose={() => setGotoOpen(false)}
        />
      )}

      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onShowShortcuts={() => {
            setSettingsOpen(false);
            setShortcutsOpen(true);
          }}
        />
      )}
    </div>
  );
}
