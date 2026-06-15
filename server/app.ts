import { createServer, type Server } from 'node:http';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Router, sendJson, readJsonBody, serveStatic, SseConnection } from './http.ts';
import { LogSession } from './session.ts';
import { listRoots, listDir, getRecents, addRecent } from './files.ts';
import { QuerySyntaxError } from './queryParser.ts';

export interface TraceBoxApp {
  server: Server;
  sessions: Map<string, LogSession>;
  /** Close all open sessions and the HTTP server. */
  shutdown(): Promise<void>;
}

/**
 * Builds the TraceBox HTTP application (API + static UI). The caller decides
 * where to listen — the CLI binds a fixed port, the desktop shell an
 * ephemeral one.
 */
export function createApp(distDir: string): TraceBoxApp {
  const sessions = new Map<string, LogSession>();
  const router = new Router();

  function getSession(id: string): LogSession {
    const s = sessions.get(id);
    if (!s) throw new Error(`Unknown session ${id}`);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Filesystem browsing

  router.add('GET', '/api/health', (_req, res) => sendJson(res, 200, { ok: true, version: '1.2.0' }));

  router.add('GET', '/api/roots', (_req, res) => {
    sendJson(res, 200, { roots: listRoots(), home: homedir() });
  });

  router.add('GET', '/api/browse', async (_req, res, _params, query) => {
    const dir = query.get('path') ?? homedir();
    try {
      sendJson(res, 200, await listDir(dir));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.add('GET', '/api/recents', (_req, res) => sendJson(res, 200, getRecents()));

  // ---------------------------------------------------------------------------
  // Sessions

  router.add('POST', '/api/sessions', async (req, res) => {
    const body = (await readJsonBody(req)) as { path?: string };
    if (!body.path) {
      sendJson(res, 400, { error: 'Missing "path"' });
      return;
    }
    const resolved = path.resolve(body.path);
    let st;
    try {
      st = statSync(resolved);
    } catch {
      sendJson(res, 404, { error: `File not found: ${resolved}` });
      return;
    }
    if (!st.isFile()) {
      sendJson(res, 400, { error: 'Not a file' });
      return;
    }
    // reuse an existing session for the same file
    for (const s of sessions.values()) {
      if (s.file.toLowerCase() === resolved.toLowerCase()) {
        sendJson(res, 200, s.status());
        return;
      }
    }
    const session = new LogSession(resolved);
    sessions.set(session.id, session);
    addRecent(resolved);
    await session.start();
    sendJson(res, 201, session.status());
  });

  router.add('GET', '/api/sessions', (_req, res) => {
    sendJson(res, 200, [...sessions.values()].map((s) => s.status()));
  });

  router.add('GET', '/api/sessions/:id', (_req, res, params) => {
    sendJson(res, 200, getSession(params.id).status());
  });

  router.add('DELETE', '/api/sessions/:id', async (_req, res, params) => {
    const s = sessions.get(params.id);
    if (s) {
      sessions.delete(params.id);
      await s.close();
    }
    sendJson(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // Rows, search, details

  router.add('GET', '/api/sessions/:id/rows', async (_req, res, params, query) => {
    const s = getSession(params.id);
    const offset = Math.max(0, Number(query.get('offset') ?? 0));
    const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 200)));
    const order = query.get('order') === 'desc' ? 'desc' : 'asc';
    const rows = await s.getRows(offset, limit, order);
    sendJson(res, 200, { rows, total: s.viewTotal, lineCount: s.lineCount });
  });

  router.add('POST', '/api/sessions/:id/search', async (req, res, params) => {
    const s = getSession(params.id);
    const body = (await readJsonBody(req)) as { query?: string };
    try {
      const result = s.setSearch(body.query ?? '');
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof QuerySyntaxError) {
        sendJson(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  });

  router.add('GET', '/api/sessions/:id/line/:no', async (_req, res, params) => {
    const s = getSession(params.id);
    const detail = await s.getDetail(Number(params.no));
    if (!detail) {
      sendJson(res, 404, { error: 'Line out of range' });
      return;
    }
    sendJson(res, 200, detail);
  });

  router.add('GET', '/api/sessions/:id/histogram', (_req, res, params) => {
    sendJson(res, 200, getSession(params.id).histogram());
  });

  router.add('GET', '/api/sessions/:id/context', async (_req, res, params, query) => {
    const s = getSession(params.id);
    const line = Math.max(0, Number(query.get('line') ?? 0));
    const before = Number(query.get('before') ?? 3);
    const after = Number(query.get('after') ?? 3);
    sendJson(res, 200, await s.getContext(line, before, after));
  });

  router.add('POST', '/api/sessions/:id/refresh', async (_req, res, params) => {
    const s = getSession(params.id);
    await s.refresh();
    sendJson(res, 200, s.status());
  });

  router.add('POST', '/api/sessions/:id/tail', async (req, res, params) => {
    const s = getSession(params.id);
    const body = (await readJsonBody(req)) as { on?: boolean };
    s.setTail(Boolean(body.on));
    sendJson(res, 200, { tail: s.tail });
  });

  // ---------------------------------------------------------------------------
  // Events (SSE)

  router.add('GET', '/api/sessions/:id/events', (_req, res, params) => {
    const s = getSession(params.id);
    const sse = new SseConnection(res);
    const onProgress = (): void => sse.send('progress', s.status());
    const onDone = (): void => sse.send('done', s.status());
    const onAppend = (): void => sse.send('append', s.status());
    const onTruncated = (): void => sse.send('truncated', s.status());
    const onError = (msg: string): void => sse.send('error', { ...s.status(), error: msg });
    s.on('progress', onProgress);
    s.on('done', onDone);
    s.on('append', onAppend);
    s.on('truncated', onTruncated);
    s.on('error-event', onError);
    sse.send('status', s.status());
    sse.onClose(() => {
      s.off('progress', onProgress);
      s.off('done', onDone);
      s.off('append', onAppend);
      s.off('truncated', onTruncated);
      s.off('error-event', onError);
    });
  });

  // ---------------------------------------------------------------------------
  // Export

  function csvEscape(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }

  router.add('GET', '/api/sessions/:id/export', async (_req, res, params, query) => {
    const s = getSession(params.id);
    const format = query.get('format') === 'json' ? 'json' : 'csv';
    const base = path.basename(s.file).replace(/[^\w.-]/g, '_');
    res.writeHead(200, {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${base}.filtered.${format}"`,
    });

    const write = (text: string): Promise<void> =>
      new Promise((resolve) => {
        if (res.write(text)) resolve();
        else res.once('drain', resolve);
      });

    if (format === 'csv') await write('line,timestamp,level,content\r\n');
    else await write('[\n');

    let first = true;
    const emitBatch = async (lineNos: number[]): Promise<void> => {
      const rows = await s.readRowsForExport(lineNos);
      let out = '';
      for (const row of rows) {
        const iso = row.ts !== null ? new Date(row.ts).toISOString() : '';
        if (format === 'csv') {
          out += `${row.lineNo + 1},${iso},${row.level ?? ''},${csvEscape(row.text)}\r\n`;
        } else {
          out += `${first ? '' : ',\n'}  ${JSON.stringify({
            line: row.lineNo + 1,
            timestamp: iso || null,
            level: row.level,
            content: row.text,
          })}`;
          first = false;
        }
      }
      await write(out);
    };

    if (s.hasSearch) {
      for (const batch of s.iterateResultRows()) {
        if (res.destroyed) return;
        await emitBatch(batch);
      }
    } else {
      const BATCH = 10_000;
      for (let start = 0; start < s.lineCount; start += BATCH) {
        if (res.destroyed) return;
        const count = Math.min(BATCH, s.lineCount - start);
        await emitBatch(Array.from({ length: count }, (_, i) => start + i));
      }
    }
    if (format === 'json') await write('\n]\n');
    res.end();
  });

  // ---------------------------------------------------------------------------

  const server = createServer((req, res) => {
    void (async () => {
      if (await router.dispatch(req, res)) return;
      if ((req.url ?? '').startsWith('/api/')) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      serveStatic(distDir, req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  return {
    server,
    sessions,
    async shutdown(): Promise<void> {
      await Promise.allSettled([...sessions.values()].map((s) => s.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
