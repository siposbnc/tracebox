import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getBookmarks, toggleBookmark } from '../bookmarks';
import { matchCommand, eventToChord, isEditableTarget } from '../keybindings';
import { extractHighlightTerms } from '../highlightTerms';
import type { HistogramData, SessionStatus, WatchTrigger } from '../types';
import SearchBar from './SearchBar';
import LogList from './LogList';
import DetailPanel from './DetailPanel';
import ReportDialog from './ReportDialog';
import FacetPanel from './FacetPanel';
import FilterBreadcrumb from './FilterBreadcrumb';
import TriagePanel from './TriagePanel';
import ClusterPanel from './ClusterPanel';
import StatsPanel from './StatsPanel';
import WatchPanel from './WatchPanel';
import ContextPeek from './ContextPeek';
import GoToLine from './GoToLine';
import ShortcutsHelp from './ShortcutsHelp';
import Histogram from './Histogram';
import DashboardView from './DashboardView';
import StatusBar from './StatusBar';
import { getHistogramDefault, getTriageOnOpen, useWrap, getWrap, setWrap, getOrder, useColumnar } from '../settings';
import { useColumns, defaultColumns, setColumns } from '../columns';
import { useCaptures, upsertCapture, removeCapture, compileExtractors, type Capture } from '../captures';
import { useRedactor, redactExportParams, getRedactOn, setRedactOn } from '../redaction';
import { useColumnWidths, setColumnWidth } from '../columnWidths';

/** A `level:` predicate (optionally negated, with a comparison/regex operator). */
const LEVEL_CLAUSE = String.raw`(?:NOT\s+)?\blevel:(?:>=|<=|>|<|~)?[^\s()]+`;

/**
 * Strip every top-level `level:` clause from a query, taking an adjacent boolean
 * connector with it so nothing dangles — `level:INFO AND message:*` becomes
 * `message:*`, not `AND message:*`. Used when a status-bar level click updates
 * the level filter in place instead of replacing the whole query.
 */
function stripLevelClauses(query: string): string {
  return query
    .replace(new RegExp(String.raw`\s+(?:AND|OR)\s+${LEVEL_CLAUSE}`, 'gi'), '') // ... AND level:X
    .replace(new RegExp(String.raw`${LEVEL_CLAUSE}\s+(?:AND|OR)\s+`, 'gi'), '') // level:X AND ...
    .replace(new RegExp(String.raw`\s*${LEVEL_CLAUSE}`, 'gi'), '') // bare level:X
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Remove any `timestamp:` range clauses from a query (the histogram drag filter). */
function stripTimestampClauses(query: string): string {
  return query
    .replace(/\s*\btimestamp:(?:>=|<=|>|<)[^\s)]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The `timestamp:>=… timestamp:<=…` range a query carries, for the histogram band; else null. */
function currentRange(query: string): { start: number; end: number } | null {
  const lo = /\btimestamp:>=([^\s)]+)/i.exec(query);
  const hi = /\btimestamp:<=([^\s)]+)/i.exec(query);
  if (!lo || !hi) return null;
  const start = Date.parse(lo[1]);
  const end = Date.parse(hi[1]);
  return Number.isNaN(start) || Number.isNaN(end) ? null : { start, end };
}

export default function LogView({
  initial,
  onOpenFile,
  onViewState,
  onTailChange,
  jumpTo,
  watchTriggers = [],
  watchUnseen = 0,
  onWatchSeen,
}: {
  initial: SessionStatus;
  onOpenFile: () => void;
  /** Reports the file's search state up to the app for workspace saving. */
  onViewState?: (id: string, vs: { query: string; regex: boolean; grouped: boolean }) => void;
  /** Reports tail (live-follow) state up so the tab can show a live indicator. */
  onTailChange?: (id: string, tail: boolean) => void;
  jumpTo?: { lineNo: number; nonce: number } | null;
  /** This file's recent watch-rule alerts, newest first. */
  watchTriggers?: WatchTrigger[];
  /** Count of alerts not yet seen in the watch panel (for the toolbar badge). */
  watchUnseen?: number;
  /** Called when the watch panel is shown, to clear the unseen count. */
  onWatchSeen?: () => void;
}) {
  const id = initial.id;
  const [status, setStatus] = useState<SessionStatus>(initial);
  const [query, setQuery] = useState(initial.search?.query ?? '');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /** Bumped whenever the visible data set changes (new search, appended lines). */
  const [epoch, setEpoch] = useState(0);
  /** Bumped alongside epoch only on a live append, so the row list keeps its
   * loaded blocks and refetches just the tail instead of clearing everything. */
  const [appendEpoch, setAppendEpoch] = useState(0);
  const [total, setTotal] = useState(initial.search?.total ?? initial.lineCount);
  const [selected, setSelected] = useState<number | null>(null);
  // a multi-row selection span (display indices) for copy/export — Shift+click or
  // Shift+Arrow; null when only a single row (or nothing) is selected
  const [selRange, setSelRange] = useState<{ from: number; to: number } | null>(null);
  // the detail panel is shown for the selected line; decoupled from selection so it
  // can be toggled (Right arrow) without losing the row highlight / arrow navigation
  const [detailOpen, setDetailOpen] = useState(false);
  const [contextLine, setContextLine] = useState<number | null>(null);
  const [pendingJump, setPendingJump] = useState<{ lineNo: number; nonce: number } | null>(null);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [histogramOpen, setHistogramOpen] = useState(getHistogramDefault);
  const [bucketCount, setBucketCount] = useState(100);
  const bucketCountRef = useRef(bucketCount);
  bucketCountRef.current = bucketCount;
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [clustersOpen, setClustersOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [triageOpen, setTriageOpen] = useState(false);
  const triageShownRef = useRef(false);
  const [watchOpen, setWatchOpen] = useState(false);
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
  const columnWidths = useColumnWidths(status.file);

  // ad-hoc capture fields: defined per file, sent with searches (so `dur:>500`
  // filters server-side) and compiled into client-side extractors for columns.
  const captures = useCaptures(status.file);
  const capturesRef = useRef(captures);
  capturesRef.current = captures;
  const captureExtractors = useMemo(() => compileExtractors(captures), [captures]);

  // redaction (display/export-only masking); a ref so copy/export callbacks see
  // the current masker without re-creating on every config change
  const redaction = useRedactor();
  const redactRef = useRef(redaction);
  redactRef.current = redaction;
  // a sample line so the capture editor can preview what a regex would extract
  const [sampleText, setSampleText] = useState<string | undefined>(undefined);

  const refreshHistogram = useCallback(() => {
    void api
      .histogram(id, bucketCountRef.current)
      .then(setHistogram)
      .catch(() => setHistogram(null));
  }, [id]);

  // re-fetch at the new resolution when the bucket count changes (the initial
  // load is driven by the index-ready effect, so skip the first run here)
  const bucketInit = useRef(true);
  useEffect(() => {
    if (bucketInit.current) {
      bucketInit.current = false;
      return;
    }
    refreshHistogram();
  }, [bucketCount, refreshHistogram]);

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
        setAppendEpoch((e) => e + 1);
        setEpoch((e) => e + 1);
        scheduleHistogram();
      },
      // the live rotation member rolled (logrotate); we keep following the new
      // file, so refresh the view the same way an append does
      rotated: (s) => {
        apply(s);
        setAppendEpoch((e) => e + 1);
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

  // Start following the live edge whenever tail turns on — whether toggled here
  // or enabled externally (e.g. the merged timeline's "Tail all"), which only
  // reaches us as a status change. Fires on the off→on edge so it never fights a
  // user who has scrolled away while tailing is already running.
  const prevTailRef = useRef(status.tail);
  useEffect(() => {
    if (status.tail && !prevTailRef.current) setFollowTail(true);
    prevTailRef.current = status.tail;
  }, [status.tail]);

  // load the histogram once the index is ready — keyed off the live status, so it
  // also fires when a session finishes indexing before the SSE 'done' event is
  // observed (e.g. a small rotation group whose index builds almost instantly)
  useEffect(() => {
    if (status.phase === 'ready') refreshHistogram();
  }, [status.phase, refreshHistogram]);

  // open the triage landing dashboard once, when the file finishes indexing
  useEffect(() => {
    if (status.phase === 'ready' && !triageShownRef.current) {
      triageShownRef.current = true;
      if (getTriageOnOpen()) setTriageOpen(true);
    }
  }, [status.phase]);

  // --- search ---------------------------------------------------------------
  const runSearch = useCallback(
    async (q: string) => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await api.search(id, q, groupingActiveRef.current, templateRef.current, regexRef.current, capturesRef.current);
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

  // transient "Copied N rows" note, shared by the Export menu and the shortcut
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copyNoteToken = useRef(0);

  // copy a display-index span [from, from+count) to the clipboard as multi-line
  // text, paging the rows (capped) so a huge selection stays bounded
  const COPY_CAP = 10000;
  const copyLinesInRange = useCallback(
    async (from: number, count: number): Promise<number> => {
      const order = getOrder();
      const grouped = groupingActiveRef.current;
      const wanted = Math.min(count, COPY_CAP);
      const texts: string[] = [];
      for (let off = from; texts.length < wanted; off += 2000) {
        const limit = Math.min(2000, from + wanted - off);
        if (limit <= 0) break;
        const page = await api.rows(id, off, limit, order, false, grouped);
        if (page.rows.length === 0) break;
        const mask = redactRef.current.redact;
        for (const row of page.rows) texts.push(mask(row.text));
      }
      await navigator.clipboard.writeText(texts.join('\n'));
      return texts.length;
    },
    [id],
  );

  // the toolbar "Copy": the selected span if one is active, else the whole view
  const copyRows = useCallback(async (): Promise<{ count: number; total: number }> => {
    if (selRange) {
      const total = selRange.to - selRange.from + 1;
      return { count: await copyLinesInRange(selRange.from, total), total };
    }
    const r = await api.copyText(id, COPY_CAP, getOrder(), groupingActiveRef.current, redactExportParams());
    await navigator.clipboard.writeText(r.text);
    return { count: r.count, total: r.total };
  }, [id, selRange, copyLinesInRange]);

  // copy the rows (selection or whole view) and surface a transient note — the one
  // action behind both the Export menu's "Copy rows" and the Ctrl/Cmd+C shortcut
  const runCopy = useCallback(async (): Promise<void> => {
    const token = ++copyNoteToken.current;
    setCopyNote('Copying…');
    try {
      const { count, total } = await copyRows();
      if (copyNoteToken.current === token) {
        setCopyNote(`Copied ${count.toLocaleString()}${total > count ? ` of ${total.toLocaleString()}` : ''} rows`);
      }
    } catch {
      if (copyNoteToken.current === token) setCopyNote('Copy failed');
    } finally {
      setTimeout(() => {
        if (copyNoteToken.current === token) setCopyNote(null);
      }, 2500);
    }
  }, [copyRows]);

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

  // re-run the active search when capture definitions change, so a query that
  // references a capture (e.g. `dur:>500`) re-filters with the new pattern
  const prevCapturesRef = useRef(captures);
  useEffect(() => {
    if (prevCapturesRef.current === captures) return;
    prevCapturesRef.current = captures;
    // a query that references a capture must re-filter; otherwise just invalidate
    // the rows so capture columns re-extract with the new patterns
    if (statusRef.current.search && !regexMode) void runSearch(statusRef.current.search.query);
    else setEpoch((e) => e + 1);
  }, [captures, runSearch, regexMode]);

  // fetch one line as a preview sample for the capture editor
  useEffect(() => {
    let live = true;
    void api.rows(id, 0, 1, 'asc', false, false).then((r) => {
      if (live) setSampleText(r.rows[0]?.text);
    });
    return () => {
      live = false;
    };
  }, [id]);

  // report search state up for workspace saving (cheap; runs on change)
  useEffect(() => {
    onViewState?.(id, { query, regex: regexMode, grouped });
  }, [id, query, regexMode, grouped, onViewState]);

  // report tail state up so the file's tab can show a live-tailing indicator
  useEffect(() => {
    onTailChange?.(id, status.tail);
  }, [id, status.tail, onTailChange]);

  // clear the unseen-alert badge while the watch panel is open (and as new
  // alerts arrive into the open panel)
  useEffect(() => {
    if (watchOpen) onWatchSeen?.();
  }, [watchOpen, watchTriggers, onWatchSeen]);

  const addFilter = useCallback(
    (clause: string) => {
      const q = query.trim() === '' ? clause : `${query.trim()} ${clause}`;
      submitQuery(q);
    },
    [query, submitQuery],
  );

  // Clicking a level in the status bar narrows the *current* query rather than
  // replacing it: any existing level clause is swapped for the clicked one (so
  // repeated clicks update in place instead of stacking), and the rest of the
  // query is left intact. In regex mode there's no query language to compose
  // with, so fall back to a plain replace.
  const filterLevel = useCallback(
    (level: string) => {
      if (regexMode) {
        submitQuery(`level:${level}`);
        return;
      }
      const base = stripLevelClauses(query);
      submitQuery(base ? `${base} level:${level}` : `level:${level}`);
    },
    [regexMode, query, submitQuery],
  );

  const onTimeRange = useCallback(
    (startTs: number, endTs: number) => {
      const fmt = (t: number): string => new Date(t).toISOString();
      // Replace any existing timestamp-range clauses (e.g. from a previous drag)
      // rather than appending, so repeatedly narrowing the selection updates the
      // filter in place instead of stacking timestamp terms.
      const base = stripTimestampClauses(query);
      const clause = `timestamp:>=${fmt(startTs)} timestamp:<=${fmt(endTs)}`;
      submitQuery(base ? `${base} ${clause}` : clause);
    },
    [query, submitQuery],
  );

  const clearRange = useCallback(() => {
    submitQuery(stripTimestampClauses(query));
  }, [query, submitQuery]);

  // Override the auto-detected parser (or null to return to auto-detect). The
  // server re-indexes in place; refresh the view and re-apply any active query.
  const selectParser = useCallback(
    async (name: string | null): Promise<void> => {
      try {
        const s = await api.setParser(id, name);
        setStatus(s);
        setSelected(null);
        setEpoch((e) => e + 1);
        setClusterEpoch((e) => e + 1);
        refreshHistogram();
        if (query.trim() !== '') void runSearch(query);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err));
      }
    },
    [id, query, runSearch, refreshHistogram],
  );

  const toggleTail = useCallback(async () => {
    const next = !statusRef.current.tail;
    await api.setTail(id, next);
    setStatus((s) => ({ ...s, tail: next }));
    setFollowTail(next);
  }, [id]);

  // Stop a command/stdin producer: freezes the captured data (stays searchable).
  const stopSource = useCallback(async () => {
    try {
      setStatus(await api.stopSource(id));
    } catch {
      // already stopped/closed — ignore
    }
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
        case 'openContext':
          if (selected === null) return; // nothing selected to peek around
          e.preventDefault();
          setContextLine(selected);
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
        case 'copySelection': {
          // defer to the browser when the user has a text selection or is in an
          // input, so Ctrl/Cmd+C still copies text there
          if (isEditableTarget(e.target)) return;
          const textSel = window.getSelection();
          if (textSel && !textSel.isCollapsed && textSel.toString().length > 0) return;
          e.preventDefault();
          void runCopy(); // same as the Export menu's "Copy rows", incl. the note
          break;
        }
        case 'toggleWrap':
          e.preventDefault();
          setWrap(!getWrap());
          break;
        case 'toggleRedact':
          e.preventDefault();
          setRedactOn(!getRedactOn());
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
  }, [selected, toggleHighlight, jumpBookmark, runCopy]);

  // highlight terms extracted from the active query
  // literal terms to highlight (skipped in regex mode — the row list highlights
  // the regex pattern directly instead)
  const highlightTerms = useMemo(
    () => (regexMode ? [] : extractHighlightTerms(status.search?.query ?? '')),
    [regexMode, status.search?.query],
  );
  // the active regex pattern, for the row list to highlight matches in place
  const regexPattern = regexMode && status.search ? (status.search.query ?? null) : null;

  // the active time-range filter, drawn as a band on the histogram (skipped in
  // regex mode, where the query isn't the query language)
  const activeRange = useMemo(
    () => (regexMode ? null : currentRange(status.search?.query ?? '')),
    [regexMode, status.search?.query],
  );

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
        exportUrls={{
          csv: api.exportUrl(id, 'csv', redactExportParams()),
          json: api.exportUrl(id, 'json', redactExportParams()),
        }}
        onCopyRows={runCopy}
        copyNote={copyNote}
        onShowTriage={() => setTriageOpen(true)}
        histogramOpen={histogramOpen}
        onToggleHistogram={() => setHistogramOpen((v) => !v)}
        facetsOpen={facetsOpen}
        onToggleFacets={() => setFacetsOpen((v) => !v)}
        clustersOpen={clustersOpen}
        onToggleClusters={() => setClustersOpen((v) => !v)}
        statsOpen={statsOpen}
        onToggleStats={() => setStatsOpen((v) => !v)}
        dashboardOpen={dashboardOpen}
        onToggleDashboard={() => setDashboardOpen((v) => !v)}
        watchOpen={watchOpen}
        onToggleWatch={() => setWatchOpen((v) => !v)}
        watchUnseen={watchUnseen}
        columns={columns}
        onColumnsChange={(cols) => setColumns(status.file, cols)}
        captures={captures}
        captureSample={sampleText}
        onUpsertCapture={(c) => upsertCapture(status.file, c)}
        onRemoveCapture={(name) => {
          removeCapture(status.file, name);
          if (columns.includes(name)) setColumns(status.file, columns.filter((c) => c !== name));
        }}
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
        fieldNames={status.fieldNames}
        levelCounts={status.levelCounts}
      />

      {!regexMode && (
        <FilterBreadcrumb
          sessionId={id}
          query={query}
          captures={captures}
          grouped={groupingActive}
          lineCount={status.lineCount}
          epoch={epoch}
          onChange={submitQuery}
        />
      )}

      {dashboardOpen ? (
        <DashboardView sessionId={id} fields={status.fieldNames.map((f) => f.key)} />
      ) : (
       <>
      {histogramOpen && histogram && histogram.buckets.length > 0 && (
        <Histogram
          data={histogram}
          onSelectRange={onTimeRange}
          activeRange={activeRange}
          onClearRange={clearRange}
          bucketCount={bucketCount}
          onBucketCountChange={setBucketCount}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {facetsOpen && (
          <FacetPanel
            sessionId={id}
            epoch={epoch}
            fieldNames={status.fieldNames}
            captures={captures}
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
        {watchOpen && (
          <WatchPanel
            file={status.file}
            tailing={status.tail}
            triggers={watchTriggers}
            onJumpToLine={(lineNo) => void jumpToLine(lineNo)}
            onClose={() => setWatchOpen(false)}
          />
        )}
        <div className="min-w-0 flex-1">
          <LogList
            key={`${columnar ? `c:${columns.join(',')}` : 'r'}:${wrap ? 'w' : 'n'}:${groupingActive ? 'g' : 'u'}:${highlightActive ? `hl:${status.search?.query ?? ''}` : 'flt'}`}
            sessionId={id}
            file={status.file}
            epoch={epoch}
            appendEpoch={appendEpoch}
            total={listTotal}
            followTail={status.tail && followTail}
            selected={selected}
            onSelect={setSelected}
            onActivate={(lineNo) => {
              setSelected(lineNo);
              setDetailOpen(true);
            }}
            onContext={setContextLine}
            selRange={selRange}
            onRange={setSelRange}
            showContext={status.search !== null}
            indexing={status.phase === 'indexing' || status.phase === 'finalizing'}
            hasSearch={status.search !== null}
            highlight={highlightActive}
            grouped={groupingActive}
            wrap={wrap}
            columnar={columnar}
            columns={columns}
            captureExtractors={captureExtractors}
            columnWidths={columnWidths}
            onColumnResize={(col, w) => setColumnWidth(status.file, col, w)}
            onReorderColumns={(cols) => setColumns(status.file, cols)}
            scrollTo={pendingJump}
            highlightTerms={highlightTerms}
            regexPattern={regexPattern}
            onAddFilter={addFilter}
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
       </>
      )}

      <StatusBar
        status={status}
        total={total}
        selectedCount={selRange ? selRange.to - selRange.from + 1 : 0}
        onLevelClick={filterLevel}
        onSelectParser={selectParser}
        onStop={() => void stopSource()}
      />

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

      {triageOpen && status.phase === 'ready' && (
        <TriagePanel
          sessionId={id}
          file={status.file}
          onClose={() => setTriageOpen(false)}
          onFilterLevel={filterLevel}
          onDrillCluster={drillCluster}
          onTimeRange={onTimeRange}
          onQuery={submitQuery}
        />
      )}
    </div>
  );
}
