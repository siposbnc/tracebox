import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, sendJson, readJsonBody, serveStatic, SseConnection } from './http.ts';
import { LogSession, indexCacheDir } from './session.ts';
import { CaptureSource } from './capture.ts';
import { MergedTimeline } from './merged.ts';
import { listCache, evictCache, clearCache, pruneStaleCache, sweepCaptureFiles } from './cache.ts';
import { getConfig, setConfig, DEFAULT_CACHE_DIR } from './config.ts';
import { getClientState, patchClientState } from './clientState.ts';
import { mkdirSync } from 'node:fs';
import { listRoots, listDir, getRecents, addRecent } from './files.ts';
import { detectRotationGroup } from './rotation.ts';
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
  // Stable bus carrying every session's watch-rule triggers, so a single
  // app-wide SSE subscriber receives alerts from all open files (including
  // background tabs) rather than only the one the UI is currently looking at.
  const watchBus = new EventEmitter();
  watchBus.setMaxListeners(0);
  let merged: MergedTimeline | null = null;
  // Stable bus so a merged-events SSE subscriber survives the timeline being
  // rebuilt (each new MergedTimeline pipes its `update` here).
  const mergedBus = new EventEmitter();
  mergedBus.setMaxListeners(0);
  const router = new Router();

  /** Replace the current timeline, wiring its live `update` to the stable bus. */
  function setMerged(next: MergedTimeline | null): void {
    if (merged) merged.close();
    merged = next;
    if (next) {
      next.on('update', () => mergedBus.emit('update', mergedTotals(next)));
      next.on('error-event', (msg: string) => mergedBus.emit('update', { ...mergedTotals(next), error: msg }));
    }
  }

  function mergedTotals(m: MergedTimeline): { total: number; filtered: number } {
    return { total: m.count(true), filtered: m.count(false) };
  }

  function getSession(id: string): LogSession {
    const s = sessions.get(id);
    if (!s) throw new Error(`Unknown session ${id}`);
    return s;
  }

  /** Register a new session and forward its watch triggers onto the shared bus. */
  function track(session: LogSession): void {
    sessions.set(session.id, session);
    session.on('watch', (trigger) => watchBus.emit('trigger', { sessionId: session.id, trigger }));
  }

  /**
   * Spawn a command into a fresh capture file and open a session that indexes
   * and tail-follows it. The capture file carries a unique nonce so its index is
   * never reused or shared; it is deleted when the session closes.
   */
  async function openSource(opts: { command: string; mergeStderr?: boolean }): Promise<LogSession> {
    const captureFile = path.join(indexCacheDir(), `cap-${randomUUID()}.data`);
    const capture = new CaptureSource({
      command: opts.command,
      file: captureFile,
      mergeStderr: opts.mergeStderr,
    });
    const session = new LogSession(captureFile, { capture });
    track(session);
    await session.start();
    return session;
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
  // Index cache management

  const activeDbs = (): Map<string, string> =>
    new Map([...sessions.values()].map((s) => [s.dbPath, s.file]));

  router.add('GET', '/api/cache', (_req, res) => sendJson(res, 200, listCache(indexCacheDir(), activeDbs())));

  router.add('DELETE', '/api/cache', (_req, res) => sendJson(res, 200, clearCache(indexCacheDir(), activeDbs())));

  router.add('DELETE', '/api/cache/:name', (_req, res, params) => {
    sendJson(res, 200, { ok: evictCache(indexCacheDir(), params.name, activeDbs()) });
  });

  router.add('GET', '/api/config', (_req, res) => {
    sendJson(res, 200, { config: getConfig(), defaultCacheDir: DEFAULT_CACHE_DIR });
  });

  router.add('POST', '/api/config', async (req, res) => {
    const body = (await readJsonBody(req)) as { cacheDir?: string; cacheRetentionDays?: number };
    if (typeof body.cacheDir === 'string' && body.cacheDir.trim()) {
      // reject a location we can't create
      try {
        mkdirSync(path.resolve(body.cacheDir.trim()), { recursive: true });
      } catch {
        sendJson(res, 400, { error: `Cannot use that folder: ${body.cacheDir}` });
        return;
      }
    }
    sendJson(res, 200, { config: setConfig(body), defaultCacheDir: DEFAULT_CACHE_DIR });
  });

  // Client/UI state (workspaces, bookmarks, notes, settings). Stored on disk so it
  // persists across launches independent of the renderer origin/port.
  router.add('GET', '/api/state', (_req, res) => {
    sendJson(res, 200, { values: getClientState() });
  });

  router.add('POST', '/api/state', async (req, res) => {
    const body = (await readJsonBody(req)) as { patch?: Record<string, string | null> };
    if (!body.patch || typeof body.patch !== 'object') {
      sendJson(res, 400, { error: 'Missing "patch"' });
      return;
    }
    patchClientState(body.patch);
    sendJson(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // Sessions

  router.add('POST', '/api/sessions', async (req, res) => {
    const body = (await readJsonBody(req)) as { path?: string; rotation?: boolean };
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
    // opening a rotation group as one stream (the file plus its rotated siblings)
    const group = body.rotation ? detectRotationGroup(resolved).map((m) => m.path) : [resolved];
    // reuse an existing session for the same file/group
    for (const s of sessions.values()) {
      const sameGroup = s.sources.length === group.length && s.sources.every((p, i) => p.toLowerCase() === group[i].toLowerCase());
      if (sameGroup) {
        sendJson(res, 200, s.status());
        return;
      }
    }
    const session = new LogSession(resolved, { sources: group });
    track(session);
    addRecent(resolved);
    await session.start();
    sendJson(res, 201, session.status());
  });

  // Run a command (or any shell pipeline) and follow its output as a live source.
  router.add('POST', '/api/sources', async (req, res) => {
    const body = (await readJsonBody(req)) as { command?: string; mergeStderr?: boolean };
    const command = body.command?.trim();
    if (!command) {
      sendJson(res, 400, { error: 'Missing "command"' });
      return;
    }
    const session = await openSource({ command, mergeStderr: body.mergeStderr });
    sendJson(res, 201, session.status());
  });

  // Rotation group for a file (the file plus its rotated siblings), for the UI to
  // offer "open as one stream"; returns just the file itself when none are found.
  router.add('GET', '/api/rotation', (_req, res, _params, query) => {
    const p = query.get('path');
    if (!p) {
      sendJson(res, 400, { error: 'Missing "path"' });
      return;
    }
    try {
      const members = detectRotationGroup(path.resolve(p));
      sendJson(res, 200, { members });
    } catch {
      sendJson(res, 404, { error: 'File not found' });
    }
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
      // the merged timeline may reference this session; drop it
      if (merged) setMerged(null);
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
    const highlight = query.get('highlight') === '1';
    const grouped = query.get('grouped') === '1';
    const colsParam = query.get('cols');
    const columns = colsParam ? colsParam.split(',').filter(Boolean) : undefined;
    const rows = await s.getRows(offset, limit, order, highlight, grouped, columns);
    // In highlight mode the list spans the whole file (matches are flagged, not filtered).
    const total =
      highlight && s.hasSearch ? (grouped ? s.recordCount() : s.lineCount) : s.displayTotal(grouped);
    sendJson(res, 200, { rows, total, lineCount: s.lineCount });
  });

  router.add('POST', '/api/sessions/:id/search', async (req, res, params) => {
    const s = getSession(params.id);
    const body = (await readJsonBody(req)) as {
      query?: string;
      grouped?: boolean;
      templateId?: number | null;
      regex?: boolean;
    };
    try {
      const result = body.regex
        ? await s.setRegexSearch(body.query ?? '', Boolean(body.grouped))
        : s.setSearch(body.query ?? '', Boolean(body.grouped), body.templateId ?? null);
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

  router.add('GET', '/api/sessions/:id/facet', (_req, res, params, query) => {
    const field = query.get('field');
    if (!field) {
      sendJson(res, 400, { error: 'Missing "field"' });
      return;
    }
    const limit = Number(query.get('limit') ?? 25);
    sendJson(res, 200, getSession(params.id).facet(field, limit));
  });

  router.add('GET', '/api/sessions/:id/numeric-facet', (_req, res, params, query) => {
    const field = query.get('field');
    if (!field) {
      sendJson(res, 400, { error: 'Missing "field"' });
      return;
    }
    const buckets = Number(query.get('buckets') ?? 24);
    sendJson(res, 200, getSession(params.id).numericFacet(field, buckets));
  });

  router.add('GET', '/api/sessions/:id/correlate', (_req, res, params, query) => {
    const limit = Number(query.get('limit') ?? 8);
    sendJson(res, 200, getSession(params.id).correlate(limit));
  });

  router.add('GET', '/api/sessions/:id/clusters', (_req, res, params, query) => {
    const limit = Number(query.get('limit') ?? 50);
    sendJson(res, 200, getSession(params.id).clusters(limit));
  });

  router.add('GET', '/api/sessions/:id/stats', (_req, res, params, query) => {
    sendJson(res, 200, getSession(params.id).stats(query.get('grouped') === '1'));
  });

  // ---------------------------------------------------------------------------
  // Merged timeline (time-ordered view across several open files)

  router.add('POST', '/api/merged', async (req, res) => {
    const body = (await readJsonBody(req)) as { sessionIds?: string[] };
    const ids = body.sessionIds?.length ? body.sessionIds : [...sessions.keys()];
    const list = ids.map((id) => sessions.get(id)).filter((s): s is LogSession => s !== undefined);
    if (list.length === 0) {
      sendJson(res, 400, { error: 'No open files to merge' });
      return;
    }
    setMerged(new MergedTimeline(list));
    sendJson(res, 201, { count: merged!.count(), sources: merged!.sourceList() });
  });

  router.add('POST', '/api/merged/search', async (req, res) => {
    if (!merged) {
      sendJson(res, 404, { error: 'No merged timeline' });
      return;
    }
    const body = (await readJsonBody(req)) as { query?: string };
    try {
      sendJson(res, 200, merged.setSearch(body.query ?? ''));
    } catch (err) {
      if (err instanceof QuerySyntaxError) sendJson(res, 400, { error: err.message });
      else throw err;
    }
  });

  router.add('GET', '/api/merged/rows', async (_req, res, _params, query) => {
    if (!merged) {
      sendJson(res, 404, { error: 'No merged timeline' });
      return;
    }
    const offset = Math.max(0, Number(query.get('offset') ?? 0));
    const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 200)));
    const order = query.get('order') === 'desc' ? 'desc' : 'asc';
    const highlight = query.get('highlight') === '1';
    const rows = await merged.page(offset, limit, order, highlight);
    sendJson(res, 200, { rows, total: merged.count(highlight) });
  });

  router.add('GET', '/api/merged/histogram', (_req, res, _params, query) => {
    sendJson(res, 200, merged ? merged.histogram(query.get('highlight') === '1') : null);
  });

  router.add('GET', '/api/merged/seek', (_req, res, _params, query) => {
    const highlight = query.get('highlight') === '1';
    sendJson(res, 200, { seq: merged ? merged.seekTs(Number(query.get('ts') ?? 0), highlight) : 0 });
  });

  // Live updates as the merged timeline follows its (tailed/captured) sources.
  router.add('GET', '/api/merged/events', (_req, res) => {
    const sse = new SseConnection(res);
    const onUpdate = (payload: unknown): void => sse.send('update', payload);
    mergedBus.on('update', onUpdate);
    if (merged) sse.send('update', mergedTotals(merged));
    sse.onClose(() => mergedBus.off('update', onUpdate));
  });

  router.add('DELETE', '/api/merged', (_req, res) => {
    setMerged(null);
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/api/sessions/:id/copy', async (_req, res, params, query) => {
    const s = getSession(params.id);
    const limit = Number(query.get('limit') ?? 10000);
    const order = query.get('order') === 'desc' ? 'desc' : 'asc';
    const grouped = query.get('grouped') === '1';
    sendJson(res, 200, await s.copyText(limit, order, grouped));
  });

  router.add('GET', '/api/sessions/:id/next-match', (_req, res, params, query) => {
    const s = getSession(params.id);
    const after = Number(query.get('after') ?? 0);
    const dir = query.get('dir') === 'prev' ? -1 : 1;
    const grouped = query.get('grouped') === '1';
    sendJson(res, 200, s.nextMatch(after, dir, grouped));
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

  // Stop a command session's producer, freezing the captured data (it stays searchable).
  router.add('POST', '/api/sessions/:id/stop', (_req, res, params) => {
    const s = getSession(params.id);
    s.stopCapture();
    sendJson(res, 200, s.status());
  });

  router.add('POST', '/api/sessions/:id/tail', async (req, res, params) => {
    const s = getSession(params.id);
    const body = (await readJsonBody(req)) as { on?: boolean };
    s.setTail(Boolean(body.on));
    sendJson(res, 200, { tail: s.tail });
  });

  // Replace a session's watch rules (evaluated against appended lines while tailing).
  router.add('PUT', '/api/sessions/:id/watch', async (req, res, params) => {
    const s = getSession(params.id);
    const body = (await readJsonBody(req)) as { rules?: unknown };
    const rules = s.setWatchRules(body.rules);
    sendJson(res, 200, { rules });
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

  // App-wide watch-rule alerts. One subscriber receives triggers from every open
  // session; on connect it replays each session's recent triggers so a reload
  // (or a freshly opened panel) shows the alert history, not just future ones.
  router.add('GET', '/api/watch/events', (_req, res) => {
    const sse = new SseConnection(res);
    const onTrigger = (payload: unknown): void => sse.send('trigger', payload);
    watchBus.on('trigger', onTrigger);
    for (const s of sessions.values()) {
      for (const trigger of s.recentTriggers()) sse.send('trigger', { sessionId: s.id, trigger });
    }
    sse.onClose(() => watchBus.off('trigger', onTrigger));
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

  // Clear capture spool files orphaned by a previous run (crash/force-quit).
  // Safe here: no sessions exist yet, so every cap-*.data is stale.
  try {
    sweepCaptureFiles(indexCacheDir());
  } catch {
    // ignore
  }

  // Evict cache entries unused past the retention window: once at startup and
  // every 6 hours after (skipping any indexes currently in use).
  const prune = (): void => {
    try {
      pruneStaleCache(indexCacheDir(), getConfig().cacheRetentionDays, activeDbs());
    } catch {
      // ignore
    }
  };
  prune();
  const pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  return {
    server,
    sessions,
    async shutdown(): Promise<void> {
      clearInterval(pruneTimer);
      merged?.close();
      await Promise.allSettled([...sessions.values()].map((s) => s.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
