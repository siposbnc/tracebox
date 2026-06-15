import type {
  BrowseResult,
  HistogramData,
  LineDetail,
  RecentFile,
  RowData,
  SessionStatus,
} from './types';

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

  rows: (id: string, offset: number, limit: number) =>
    request<{ rows: RowData[]; total: number; lineCount: number }>(
      `/api/sessions/${id}/rows?offset=${offset}&limit=${limit}`,
    ),
  search: (id: string, query: string) =>
    request<{ total: number; durationMs: number }>(`/api/sessions/${id}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }),
  detail: (id: string, lineNo: number) => request<LineDetail>(`/api/sessions/${id}/line/${lineNo}`),
  histogram: (id: string) => request<HistogramData | null>(`/api/sessions/${id}/histogram`),
  setTail: (id: string, on: boolean) =>
    request<{ tail: boolean }>(`/api/sessions/${id}/tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    }),
  exportUrl: (id: string, format: 'csv' | 'json') => `/api/sessions/${id}/export?format=${format}`,

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

export function formatTs(ts: number | null): string {
  if (ts === null) return '';
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}
