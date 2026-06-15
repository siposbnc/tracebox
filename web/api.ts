import type {
  BrowseResult,
  ClustersResult,
  ContextResult,
  FacetResult,
  HistogramData,
  LineDetail,
  RecentFile,
  RowData,
  SessionStatus,
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

  openFile: (path: string) =>
    request<SessionStatus>('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
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
  ) =>
    request<{ rows: RowData[]; total: number; lineCount: number }>(
      `/api/sessions/${id}/rows?offset=${offset}&limit=${limit}&order=${order}${
        highlight ? '&highlight=1' : ''
      }${grouped ? '&grouped=1' : ''}`,
    ),
  search: (id: string, query: string, grouped = false, templateId: number | null = null) =>
    request<{ total: number; durationMs: number }>(`/api/sessions/${id}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, grouped, templateId }),
    }),
  detail: (id: string, lineNo: number) => request<LineDetail>(`/api/sessions/${id}/line/${lineNo}`),
  context: (id: string, line: number, before: number, after: number) =>
    request<ContextResult>(
      `/api/sessions/${id}/context?line=${line}&before=${before}&after=${after}`,
    ),
  histogram: (id: string) => request<HistogramData | null>(`/api/sessions/${id}/histogram`),
  nextMatch: (id: string, after: number, dir: 'next' | 'prev', grouped: boolean) =>
    request<{ lineNo: number; viewIndex: number } | null>(
      `/api/sessions/${id}/next-match?after=${after}&dir=${dir}${grouped ? '&grouped=1' : ''}`,
    ),
  facet: (id: string, field: string, limit = 25) =>
    request<FacetResult>(`/api/sessions/${id}/facet?field=${encodeURIComponent(field)}&limit=${limit}`),
  clusters: (id: string, limit = 50) =>
    request<ClustersResult>(`/api/sessions/${id}/clusters?limit=${limit}`),
  setTail: (id: string, on: boolean) =>
    request<{ tail: boolean }>(`/api/sessions/${id}/tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    }),
  refresh: (id: string) => request<SessionStatus>(`/api/sessions/${id}/refresh`, { method: 'POST' }),
  exportUrl: (id: string, format: 'csv' | 'json') => `/api/sessions/${id}/export?format=${format}`,
  copyText: (id: string, limit: number, order: 'asc' | 'desc', grouped: boolean) =>
    request<{ text: string; count: number; total: number }>(
      `/api/sessions/${id}/copy?limit=${limit}&order=${order}${grouped ? '&grouped=1' : ''}`,
    ),

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
