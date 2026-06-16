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

export interface SessionStatus {
  id: string;
  file: string;
  /** Number of source files (1 normally; >1 when a rotation group was opened as one stream). */
  sourceCount: number;
  fileSize: number;
  phase: 'indexing' | 'finalizing' | 'ready' | 'error';
  bytesIndexed: number;
  lineCount: number;
  format: string;
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

export interface ServerConfig {
  cacheDir: string;
  cacheRetentionDays: number;
}

export interface ConfigInfo {
  config: ServerConfig;
  defaultCacheDir: string;
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

export interface PatchNoteSection {
  title: string;
  items: string[];
}

export interface PatchNote {
  version: string;
  date: string | null;
  sections: PatchNoteSection[];
}
