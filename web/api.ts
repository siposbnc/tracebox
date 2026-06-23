import type {
  BrowseResult,
  CacheInfo,
  ConfigInfo,
  ClustersResult,
  ContextResult,
  Correlations,
  CustomParserSpec,
  ParserTestResult,
  FacetResult,
  HistogramData,
  TriageResult,
  LineDetail,
  MergedBuild,
  MergedRow,
  MergedUpdate,
  NumericFacet,
  RecentFile,
  RotationMember,
  RowData,
  SessionStatus,
  StatsResult,
  WatchEvent,
  WatchRule,
} from './types';
import { getTz, type Tz } from './settings';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const api = {
  roots: () => request<{ roots: string[]; home: string }>('/api/roots'),
  browse: (path: string) => request<BrowseResult>(`/api/browse?path=${encodeURIComponent(path)}`),
  recents: () => request<RecentFile[]>('/api/recents'),

  cache: () => request<CacheInfo>('/api/cache'),
  evictCache: (name: string) => request<{ ok: boolean }>(`/api/cache/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  clearCache: () => request<{ freed: number }>('/api/cache', { method: 'DELETE' }),
  config: () => request<ConfigInfo>('/api/config'),
  setConfig: (patch: { cacheDir?: string; cacheRetentionDays?: number; mcpEnabled?: boolean }) =>
    request<ConfigInfo>('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  parsers: () => request<{ parsers: CustomParserSpec[] }>('/api/parsers'),
  saveParser: (name: string, pattern: string) =>
    request<{ parsers: CustomParserSpec[] }>('/api/parsers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pattern }),
    }),
  removeParser: (name: string) =>
    request<{ ok: boolean; parsers: CustomParserSpec[] }>(`/api/parsers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testParser: (pattern: string, opts: { samples?: string[]; sessionId?: string; count?: number }) =>
    request<ParserTestResult>('/api/parsers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, ...opts }),
    }),

  openFile: (path: string, rotation = false) =>
    request<SessionStatus>('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, rotation }),
    }),
  rotation: (path: string) => request<{ members: RotationMember[] }>(`/api/rotation?path=${encodeURIComponent(path)}`),
  runCommand: (command: string, mergeStderr = true) =>
    request<SessionStatus>('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, mergeStderr }),
    }),
  stopSource: (id: string) => request<SessionStatus>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  sessions: () => request<SessionStatus[]>('/api/sessions'),
  session: (id: string) => request<SessionStatus>(`/api/sessions/${id}`),
  closeSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  rows: (
    id: string,
    offset: number,
    limit: number,
    order: 'asc' | 'desc' = 'asc',
    highlight = false,
    grouped = false,
    columns?: string[],
  ) =>
    request<{ rows: RowData[]; total: number; lineCount: number }>(
      `/api/sessions/${id}/rows?offset=${offset}&limit=${limit}&order=${order}${
        highlight ? '&highlight=1' : ''
      }${grouped ? '&grouped=1' : ''}${
        columns && columns.length > 0 ? `&cols=${columns.map(encodeURIComponent).join(',')}` : ''
      }`,
    ),
  search: (
    id: string,
    query: string,
    grouped = false,
    templateId: number | null = null,
    regex = false,
    captures?: { name: string; pattern: string }[],
  ) =>
    request<{ total: number; durationMs: number }>(`/api/sessions/${id}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, grouped, templateId, regex, captures }),
    }),
  count: (id: string, query: string, captures?: { name: string; pattern: string }[], grouped = false) =>
    request<{ count: number | null }>(`/api/sessions/${id}/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, captures, grouped }),
    }),
  detail: (id: string, lineNo: number) => request<LineDetail>(`/api/sessions/${id}/line/${lineNo}`),
  context: (id: string, line: number, before: number, after: number) =>
    request<ContextResult>(
      `/api/sessions/${id}/context?line=${line}&before=${before}&after=${after}`,
    ),
  histogram: (id: string, buckets?: number) =>
    request<HistogramData | null>(
      `/api/sessions/${id}/histogram${buckets ? `?buckets=${buckets}` : ''}`,
    ),
  nextMatch: (id: string, after: number, dir: 'next' | 'prev', grouped: boolean) =>
    request<{ lineNo: number; viewIndex: number } | null>(
      `/api/sessions/${id}/next-match?after=${after}&dir=${dir}${grouped ? '&grouped=1' : ''}`,
    ),
  facet: (id: string, field: string, limit = 25, pattern?: string) =>
    request<FacetResult>(
      `/api/sessions/${id}/facet?field=${encodeURIComponent(field)}&limit=${limit}${
        pattern ? `&pattern=${encodeURIComponent(pattern)}` : ''
      }`,
    ),
  numericFacet: (id: string, field: string, buckets = 24) =>
    request<NumericFacet | null>(
      `/api/sessions/${id}/numeric-facet?field=${encodeURIComponent(field)}&buckets=${buckets}`,
    ),
  clusters: (id: string, limit = 50) =>
    request<ClustersResult>(`/api/sessions/${id}/clusters?limit=${limit}`),
  triage: (id: string) => request<TriageResult>(`/api/sessions/${id}/triage`),
  correlate: (id: string, limit = 8) =>
    request<Correlations>(`/api/sessions/${id}/correlate?limit=${limit}`),
  stats: (id: string, grouped = false) =>
    request<StatsResult>(`/api/sessions/${id}/stats${grouped ? '?grouped=1' : ''}`),
  setTail: (id: string, on: boolean) =>
    request<{ tail: boolean }>(`/api/sessions/${id}/tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    }),
  refresh: (id: string) => request<SessionStatus>(`/api/sessions/${id}/refresh`, { method: 'POST' }),
  sessionParsers: (id: string) =>
    request<{ active: string; forced: boolean; available: string[] }>(`/api/sessions/${id}/parsers`),
  setParser: (id: string, parser: string | null) =>
    request<SessionStatus>(`/api/sessions/${id}/parser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parser }),
    }),
  setWatchRules: (id: string, rules: WatchRule[]) =>
    request<{ rules: WatchRule[] }>(`/api/sessions/${id}/watch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    }),
  exportUrl: (id: string, format: 'csv' | 'json', redactParams = '') =>
    `/api/sessions/${id}/export?format=${format}${redactParams}`,
  copyText: (id: string, limit: number, order: 'asc' | 'desc', grouped: boolean, redactParams = '') =>
    request<{ text: string; count: number; total: number }>(
      `/api/sessions/${id}/copy?limit=${limit}&order=${order}${grouped ? '&grouped=1' : ''}${redactParams}`,
    ),

  // merged timeline across open files
  buildMerged: (sessionIds?: string[]) =>
    request<MergedBuild>('/api/merged', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds }),
    }),
  mergedRows: (offset: number, limit: number, order: 'asc' | 'desc' = 'asc', highlight = false) =>
    request<{ rows: MergedRow[]; total: number }>(
      `/api/merged/rows?offset=${offset}&limit=${limit}&order=${order}${highlight ? '&highlight=1' : ''}`,
    ),
  mergedSearch: (query: string) =>
    request<{ total: number; durationMs: number }>('/api/merged/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }),
  mergedHistogram: (highlight = false) =>
    request<HistogramData | null>(`/api/merged/histogram${highlight ? '?highlight=1' : ''}`),
  mergedSeek: (ts: number, highlight = false) =>
    request<{ seq: number }>(`/api/merged/seek?ts=${ts}${highlight ? '&highlight=1' : ''}`),
  closeMerged: () => request<{ ok: boolean }>('/api/merged', { method: 'DELETE' }),

  /** Subscribe to live merged-timeline updates as it follows its sources; returns an unsubscribe. */
  mergedEvents(handlers: { update?: (p: MergedUpdate) => void }): () => void {
    const es = new EventSource('/api/merged/events');
    if (handlers.update) {
      es.addEventListener('update', (e) => handlers.update!(JSON.parse((e as MessageEvent).data) as MergedUpdate));
    }
    return () => es.close();
  },

  /** Subscribe to app-wide watch-rule alerts (from every open session); returns an unsubscribe. */
  watchEvents(onTrigger: (e: WatchEvent) => void): () => void {
    const es = new EventSource('/api/watch/events');
    es.addEventListener('trigger', (e) => onTrigger(JSON.parse((e as MessageEvent).data) as WatchEvent));
    return () => es.close();
  },

  /** Subscribe to session events; returns an unsubscribe function. */
  events(id: string, handlers: { [event: string]: (status: SessionStatus) => void }): () => void {
    const es = new EventSource(`/api/sessions/${id}/events`);
    for (const [event, fn] of Object.entries(handlers)) {
      es.addEventListener(event, (e) => fn(JSON.parse((e as MessageEvent).data) as SessionStatus));
    }
    return () => es.close();
  },
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Compact duration for the Δt column — the gap between two log rows. Negatives
 * (out-of-order timestamps) clamp to zero. e.g. `340ms`, `2.3s`, `45s`, `3m 5s`,
 * `2h 10m`, `1d 3h`.
 */
export function formatDelta(ms: number): string {
  if (ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = Math.round(s % 60);
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem ? `${d}d ${rem}h` : `${d}d`;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/**
 * Format an epoch-ms timestamp as `YYYY-MM-DD HH:mm:ss.SSS` in the chosen
 * timezone (UTC by default). The zone is never embedded here — pair the value
 * with {@link tzAbbr} wherever the zone could be ambiguous.
 */
export function formatTs(ts: number | null, tz: Tz = getTz()): string {
  if (ts === null) return '';
  const d = new Date(ts);
  if (tz === 'utc') {
    return d.toISOString().replace('T', ' ').replace('Z', '');
  }
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Short label for the active timezone — `UTC`, or the host's abbreviated local
 * zone (e.g. `GMT+2`, `PST`) computed for the given instant so it respects DST.
 */
export function tzAbbr(ts: number | null = Date.now(), tz: Tz = getTz()): string {
  if (tz === 'utc') return 'UTC';
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
      new Date(ts ?? Date.now()),
    );
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'Local';
  } catch {
    return 'Local';
  }
}
