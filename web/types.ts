export interface RowData {
  lineNo: number;
  text: string;
  ts: number | null;
  level: string | null;
  truncated: boolean;
  /** In highlight mode, whether this (unfiltered) line matches the active query. */
  match?: boolean;
  /** In grouped mode, physical lines in this record (1 = no continuation lines). */
  span?: number;
  /** Selected field values for the columnar view (only the requested columns). */
  cols?: Record<string, string>;
}

export interface CaptureStatus {
  command: string;
  state: 'running' | 'exited' | 'failed';
  pid: number | null;
  exitCode: number | null;
  bytes: number;
  error: string | null;
}

export interface SessionStatus {
  id: string;
  file: string;
  /** A plain file (or rotation group), or a live command/stdin capture. */
  kind: 'file' | 'command';
  /** For command sessions: the command line (or `(stdin)`); null for files. */
  command: string | null;
  /** Process state of a command session; null for files. */
  capture: CaptureStatus | null;
  /** Number of source files (1 normally; >1 when a rotation group was opened as one stream). */
  sourceCount: number;
  fileSize: number;
  phase: 'indexing' | 'finalizing' | 'ready' | 'error';
  bytesIndexed: number;
  lineCount: number;
  format: string;
  /** True when `format` was forced via the parser picker rather than auto-detected. */
  parserForced: boolean;
  reusedIndex: boolean;
  error: string | null;
  tail: boolean;
  recordCount: number;
  levelCounts: Record<string, number>;
  fieldNames: { key: string; count: number }[];
  search: { query: string; total: number; durationMs: number } | null;
}

export interface RotationMember {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface HistogramData {
  minTs: number;
  maxTs: number;
  bucketMs: number;
  buckets: { start: number; counts: Record<string, number>; total: number }[];
  withoutTs: number;
}

// ---------------------------------------------------------------------------
// Dashboards — user-configured charts backed by the general aggregation engine

/** A numeric aggregation function over a field's values. */
export type MetricFn = 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p95';

/** A general aggregation request: group + optional series split + a metric per cell. */
export interface AggregateSpec {
  groupBy:
    | { type: 'time'; buckets?: number }
    | { type: 'field'; field: string; limit?: number }
    | { type: 'none' };
  splitBy?: { type: 'level' } | { type: 'field'; field: string; limit?: number };
  metric:
    | { type: 'count' }
    | { type: 'unique'; field: string }
    | { type: 'numeric'; field: string; fn: MetricFn };
}

/** Tabular result of an {@link AggregateSpec}; one row per group, columns per series. */
export interface AggregateResult {
  groupKind: 'time' | 'field' | 'none';
  minTs?: number;
  maxTs?: number;
  bucketMs?: number;
  /** Series (split) keys, most significant first; `['__all__']` when not split. */
  series: string[];
  rows: { key: string | number; values: Record<string, number>; total: number }[];
  truncated: boolean;
}

/** The series key used when an aggregation isn't split. */
export const ALL_SERIES = '__all__';

/** How a panel renders its aggregation. */
export type ChartType = 'line' | 'area' | 'bar' | 'pie' | 'table' | 'stat';

/** One configured chart on a dashboard. */
export interface Panel {
  id: string;
  title: string;
  chart: ChartType;
  /** Scoping query for this panel ('' = whole file). */
  query: string;
  spec: AggregateSpec;
  /** Grid span: 1 = half width, 2 = full width. */
  w?: 1 | 2;
}

/** A named, reusable set of panels, runnable against any open file. */
export interface Dashboard {
  id: string;
  name: string;
  savedAt: number;
  panels: Panel[];
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface ContextResult {
  center: number;
  rows: RowData[];
  matchLines: number[];
}

export interface FacetResult {
  field: string;
  values: { value: string; count: number }[];
  distinctCount: number;
  covered: number;
  /** Of `covered`, how many values parse as a number (enables the range view). */
  numericCount: number;
  /** Ad-hoc capture facets only: true when the view was larger than the scan cap. */
  approx?: boolean;
  /** Ad-hoc capture facets only: how many lines were scanned. */
  scanned?: number;
}

export interface TriageResult {
  total: number;
  span: { start: number | null; end: number | null };
  levels: { level: string; count: number }[];
  errorTotal: number;
  errorClusters: { id: number; pattern: string; count: number }[];
  slowest: { field: string; count: number; p50: number; p95: number; max: number } | null;
}

export interface NumericFacet {
  field: string;
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  buckets: { lo: number; hi: number; count: number }[];
}

export interface Correlations {
  resultsTotal: number;
  items: { field: string; value: string; count: number; share: number; lift: number }[];
}

export interface ClustersResult {
  patterns: { id: number; pattern: string; count: number }[];
  distinctCount: number;
  covered: number;
}

export interface StatsResult {
  total: number;
  withTs: number;
  minTs: number | null;
  maxTs: number | null;
  peakPerMin: number;
  levels: { level: string; count: number }[];
  fields: { key: string; distinctCount: number; covered: number; values: { value: string; count: number }[] }[];
}

export interface LineDetail {
  lineNo: number;
  raw: string;
  ts: number | null;
  level: string | null;
  fields: { key: string; value: string }[];
  /** Present when this line heads a multi-line record: the full record text. */
  record?: { span: number; text: string };
}

export interface RecentFile {
  path: string;
  openedAt: number;
}

export interface CacheEntry {
  name: string;
  path: string;
  size: number;
  lineCount: number;
  mtimeMs: number;
  inUse: boolean;
}

export interface CacheInfo {
  entries: CacheEntry[];
  totalSize: number;
}

export interface CustomParserSpec {
  name: string;
  pattern: string;
}

export interface ServerConfig {
  cacheDir: string;
  cacheRetentionDays: number;
  parsers: CustomParserSpec[];
  mcpEnabled: boolean;
}

export interface ConfigInfo {
  config: ServerConfig;
  defaultCacheDir: string;
}

/** One line's result from a parser dry-run. */
export interface ParserTestRow {
  line: string;
  matched: boolean;
  ts: string | null;
  level: string | null;
  fields: Record<string, string>;
}

export interface ParserTestResult {
  matched: number;
  total: number;
  results: ParserTestRow[];
}

export interface MergedRow {
  seq: number;
  source: number;
  file: string;
  lineNo: number;
  ts: number;
  level: string | null;
  text: string;
  truncated: boolean;
  span: number;
  match?: boolean;
}

export interface MergedBuild {
  count: number;
  sources: { id: string; file: string }[];
}

/** Pushed over SSE as the merged timeline follows its sources. */
export interface MergedUpdate {
  /** Whole-timeline row count. */
  total: number;
  /** Rows in the active search (equals `total` when no search). */
  filtered: number;
  error?: string;
}

export type WatchRuleKind = 'match' | 'rate';

/** A watch rule: fires an alert when tailed lines match (or cross a rate). */
export interface WatchRule {
  id: string;
  name: string;
  kind: WatchRuleKind;
  /** Query-language condition selecting matching lines. */
  query: string;
  /** Rate rules: fire when the windowed match count reaches this. */
  threshold: number;
  /** Rate rules: sliding window length, in seconds. */
  windowSec: number;
  enabled: boolean;
  /** Also raise a desktop (OS) notification, not just an in-app toast. */
  desktop: boolean;
}

/** An alert pushed over SSE when a watch rule fires. */
export interface WatchTrigger {
  ruleId: string;
  ruleName: string;
  kind: WatchRuleKind;
  at: number;
  count: number;
  threshold: number | null;
  windowSec: number | null;
  desktop: boolean;
  sample: { lineNo: number; ts: number | null; level: string | null; text: string } | null;
}

/** A trigger tagged with the session it came from (the watch SSE payload). */
export interface WatchEvent {
  sessionId: string;
  trigger: WatchTrigger;
}

export interface PatchNoteSection {
  title: string;
  items: string[];
}

export interface PatchNote {
  version: string;
  date: string | null;
  sections: PatchNoteSection[];
}
