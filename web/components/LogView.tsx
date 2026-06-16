import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getBookmarks, toggleBookmark } from '../bookmarks';
import { matchCommand, eventToChord, isEditableTarget } from '../keybindings';
import { extractHighlightTerms } from '../highlightTerms';
import type { HistogramData, SessionStatus } from '../types';
import SearchBar from './SearchBar';
import LogList from './LogList';
import DetailPanel from './DetailPanel';
import ReportDialog from './ReportDialog';
import FacetPanel from './FacetPanel';
import ClusterPanel from './ClusterPanel';
import StatsPanel from './StatsPanel';
import ContextPeek from './ContextPeek';
import GoToLine from './GoToLine';
import ShortcutsHelp from './ShortcutsHelp';
import SettingsPanel from './SettingsPanel';
import CachePanel from './CachePanel';
import Histogram from './Histogram';
import StatusBar from './StatusBar';
import { getHistogramDefault, useWrap, getWrap, setWrap, getOrder, useColumnar } from '../settings';
import { useColumns, defaultColumns, setColumns } from '../columns';

export default function LogView({
  initial,
  onOpenFile,
  onViewState,
  jumpTo,
}: {
  initial: SessionStatus;
  onOpenFile: () => void;
  /** Reports the file's search state up to the app for workspace saving. */
  onViewState?: (id: string, vs: { query: string; regex: boolean; grouped: boolean }) => void;
  jumpTo?: { lineNo: number; nonce: number } | null;
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
  // the detail panel is shown for the selected line; decoupled from selection so it
  // can be toggled (Right arrow) without losing the row highlight / arrow navigation
  const [detailOpen, setDetailOpen] = useState(false);
  const [contextLine, setContextLine] = useState<number | null>(null);
  const [pendingJump, setPendingJump] = useState<{ lineNo: number; nonce: number } | null>(null);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [histogramOpen, setHistogramOpen] = useState(getHistogramDefault);
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [clustersOpen, setClustersOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);
  const templateRef = useRef<number | null>(null);
  // bumped only when the cluster set changes (new text search / index ready), not
  // on cluster drill-down — so the patterns panel stays stable while drilling
  const [clusterEpoch, setClusterEpoch] = useState(0);
  const [highlightMode, setHighlightMode] = useState(false);
  const [regexMode, setRegexMode] = useState(false);
  const regexRef = useRef(regexMode);
  regexRef.current = regexMode;
  const [grouped, setGrouped] = useState(true);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [followTail, setFollowTail] = useState(initial.tail);
  const statusRef = useRef(status);
  statusRef.current = status;

  // Grouping folds stack-trace continuation lines into one record. It only takes
  // effect once indexing has finished (the records table is built at finalize).
  const groupingActive = grouped && status.phase === 'ready';
  const groupingActiveRef = useRef(groupingActive);
  groupingActiveRef.current = groupingActive;
  const wrap = useWrap();
  const columnar = useColumnar();
  const storedColumns = useColumns(status.file);
  const columns = useMemo(
    () => (storedColumns.length > 0 ? storedColumns : defaultColumns(status.fieldNames)),
    [storedColumns, status.fieldNames],
  );

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
        apply(s); // flips status.phase to 'ready', which triggers the histogram load
        setEpoch((e) => e + 1);
        setClusterEpoch((e) => e + 1);
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

  // load the histogram once the index is ready — keyed off the live status, so it
  // also fires when a session finishes indexing before the SSE 'done' event is
  // observed (e.g. a small rotation group whose index builds almost instantly)
  useEffect(() => {
    if (status.phase === 'ready') refreshHistogram();
  }, [status.phase, refreshHistogram]);

  // --- search ---------------------------------------------------------------
  const runSearch = useCallback(
    async (q: string) => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await api.search(id, q, groupingActiveRef.current, templateRef.current, regexRef.current);
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
      // a new text search resets any cluster drill and refreshes the patterns
      setActiveTemplate(null);
      templateRef.current = null;
      setClusterEpoch((e) => e + 1);
      void runSearch(q);
    },
    [runSearch],
  );

  // copy the current view's rows (capped) to the clipboard as multi-line text
  const COPY_CAP = 10000;
  const copyRows = useCallback(async (): Promise<{ count: number; total: number }> => {
    const r = await api.copyText(id, COPY_CAP, getOrder(), groupingActiveRef.current);
    await navigator.clipboard.writeText(r.text);
    return { count: r.count, total: r.total };
  }, [id]);

  // drill the view down to a single cluster (or clear it); keeps the current text
  // query and does not refresh the patterns panel
  const drillCluster = useCallback(
    (templateId: number | null) => {
      setActiveTemplate(templateId);
      templateRef.current = templateId;
      void runSearch(query);
    },
    [query, runSearch],
  );

  // when grouping turns on/off (toggle, or indexing finishing), re-materialize an
  // active search in the new mode; for plain browsing just invalidate the rows
  const prevGroupingRef = useRef(groupingActive);
  useEffect(() => {
    if (prevGroupingRef.current === groupingActive) return;
    prevGroupingRef.current = groupingActive;
    if (statusRef.current.search) void runSearch(statusRef.current.search.query);
    else setEpoch((e) => e + 1);
  }, [groupingActive, runSearch]);

  // re-materialize when switching between regex and query-language mode
  const prevRegexRef = useRef(regexMode);
  useEffect(() => {
    if (prevRegexRef.current === regexMode) return;
    prevRegexRef.current = regexMode;
    void runSearch(query);
  }, [regexMode, runSearch, query]);

  // report search state up for workspace saving (cheap; runs on change)
  useEffect(() => {
    onViewState?.(id, { query, regex: regexMode, grouped });
  }, [id, query, regexMode, grouped, onViewState]);

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

  // jump requested from outside (e.g. opening a line from the merged timeline)
  const lastJumpRef = useRef(0);
  useEffect(() => {
    if (jumpTo && jumpTo.nonce !== lastJumpRef.current) {
      lastJumpRef.current = jumpTo.nonce;
      void jumpToLine(jumpTo.lineNo);
    }
  }, [jumpTo, jumpToLine]);

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
        case 'toggleDetail':
          if (selected === null) return; // nothing selected to show detail for
          e.preventDefault();
          setDetailOpen((v) => !v);
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
        case 'toggleWrap':
          e.preventDefault();
          setWrap(!getWrap());
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
  // literal terms to highlight (skipped in regex mode — the row list highlights
  // the regex pattern directly instead)
  const highlightTerms = useMemo(
    () => (regexMode ? [] : extractHighlightTerms(status.search?.query ?? '')),
    [regexMode, status.search?.query],
  );
  // the active regex pattern, for the row list to highlight matches in place
  const regexPattern = regexMode && status.search ? (status.search.query ?? null) : null;

  // Highlight mode only takes effect when there is an active search to mark.
  const highlightActive = highlightMode && status.search !== null;
  // browsing total depends on grouping (records vs physical lines); an active
  // search already reports the grouped count via the search response (`total`).
  const browseTotal = groupingActive ? status.recordCount : status.lineCount;
  const listTotal = highlightActive ? browseTotal : status.search ? total : browseTotal;

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
        onCopyRows={copyRows}
        histogramOpen={histogramOpen}
        onToggleHistogram={() => setHistogramOpen((v) => !v)}
        facetsOpen={facetsOpen}
        onToggleFacets={() => setFacetsOpen((v) => !v)}
        clustersOpen={clustersOpen}
        onToggleClusters={() => setClustersOpen((v) => !v)}
        statsOpen={statsOpen}
        onToggleStats={() => setStatsOpen((v) => !v)}
        columns={columns}
        onColumnsChange={(cols) => setColumns(status.file, cols)}
        highlightMode={highlightMode}
        onToggleHighlight={toggleHighlight}
        regexMode={regexMode}
        onToggleRegex={() => setRegexMode((v) => !v)}
        grouped={grouped}
        onToggleGrouped={() => setGrouped((v) => !v)}
        file={status.file}
        onJumpToLine={(lineNo) => void jumpToLine(lineNo)}
        onGoToLine={() => setGotoOpen(true)}
        onExportReport={() => setReportOpen(true)}
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
        {clustersOpen && (
          <ClusterPanel
            sessionId={id}
            epoch={clusterEpoch}
            activeTemplate={activeTemplate}
            hasSearch={query.trim() !== ''}
            onDrill={drillCluster}
            onClose={() => setClustersOpen(false)}
          />
        )}
        {statsOpen && (
          <StatsPanel
            sessionId={id}
            epoch={epoch}
            grouped={groupingActive}
            hasSearch={status.search !== null}
            onAddFilter={addFilter}
            onClose={() => setStatsOpen(false)}
          />
        )}
        <div className="min-w-0 flex-1">
          <LogList
            key={`${columnar ? `c:${columns.join(',')}` : 'r'}:${wrap ? 'w' : 'n'}:${groupingActive ? 'g' : 'u'}:${highlightActive ? `hl:${status.search?.query ?? ''}` : 'flt'}`}
            sessionId={id}
            file={status.file}
            epoch={epoch}
            total={listTotal}
            followTail={status.tail && followTail}
            selected={selected}
            onSelect={setSelected}
            onActivate={(lineNo) => {
              setSelected(lineNo);
              setDetailOpen(true);
            }}
            onContext={setContextLine}
            showContext={status.search !== null}
            highlight={highlightActive}
            grouped={groupingActive}
            wrap={wrap}
            columnar={columnar}
            columns={columns}
            scrollTo={pendingJump}
            highlightTerms={highlightTerms}
            regexPattern={regexPattern}
            onUserScroll={() => setFollowTail(false)}
            onScrolledToEnd={() => status.tail && setFollowTail(true)}
          />
        </div>
        {selected !== null && detailOpen && (
          <DetailPanel
            sessionId={id}
            file={status.file}
            lineNo={selected}
            onClose={() => setDetailOpen(false)}
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

      {reportOpen && (
        <ReportDialog
          sessionId={id}
          file={status.file}
          query={status.search?.query ?? null}
          lineCount={status.lineCount}
          onClose={() => setReportOpen(false)}
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
          onManageCache={() => {
            setSettingsOpen(false);
            setCacheOpen(true);
          }}
        />
      )}

      {cacheOpen && <CachePanel onClose={() => setCacheOpen(false)} />}
    </div>
  );
}
