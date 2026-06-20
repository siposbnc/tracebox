import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogSession } from './session.ts';
import { MergedTimeline } from './merged.ts';
import type { WatchTrigger } from './watch.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'tracebox-test-'));
const openSessions: LogSession[] = [];

after(async () => {
  for (const s of openSessions) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeLogFile(name: string, lines: string[], trailingNewline = true): string {
  const file = path.join(dir, name);
  writeFileSync(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return file;
}

async function openAndIndex(file: string): Promise<LogSession> {
  const session = new LogSession(file);
  openSessions.push(session);
  const done = new Promise<void>((resolve, reject) => {
    session.on('done', resolve);
    session.on('error-event', (msg: string) => reject(new Error(msg)));
  });
  await session.start();
  if (session.phase !== 'ready') await done;
  return session;
}

function appLogLines(n: number): string[] {
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'];
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const level = levels[i % levels.length];
    return `${ts} [${level}] worker-${i % 7} request ${i} took ${i % 900}ms`;
  });
}

test('indexes a plain app log and answers queries', async () => {
  const file = makeLogFile('app.log', appLogLines(5000));
  const s = await openAndIndex(file);

  assert.equal(s.lineCount, 5000);
  assert.equal(s.status().format, 'timestamped');

  // full-text search
  let r = s.setSearch('request');
  assert.equal(r.total, 5000);

  // level filter: every 6th line starting at index 4
  r = s.setSearch('level:ERROR');
  assert.equal(r.total, Math.floor(5000 / 6) + (5000 % 6 > 4 ? 1 : 0));

  // boolean combination
  r = s.setSearch('level:ERROR OR level:WARN');
  const warns = Math.ceil((5000 - 3) / 6);
  const errors = Math.ceil((5000 - 4) / 6);
  assert.equal(r.total, warns + errors);

  // NOT
  r = s.setSearch('NOT level:ERROR');
  assert.equal(r.total, 5000 - errors);

  // timestamp range: first 60 seconds
  r = s.setSearch('timestamp:<2024-01-01T00:01');
  assert.equal(r.total, 60);

  // rows come back in order with metadata
  s.setSearch('level:ERROR');
  const rows = await s.getRows(0, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].lineNo, 4);
  assert.equal(rows[0].level, 'ERROR');
  assert.match(rows[0].text, /request 4 /);

  // clearing the search shows all lines
  const cleared = s.setSearch('');
  assert.equal(cleared.total, 5000);
  const first = await s.getRows(0, 2);
  assert.equal(first[0].lineNo, 0);
});

test('JSON logs: nested fields, comparisons, wildcards, exists', async () => {
  const lines = Array.from({ length: 1000 }, (_, i) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2024, 5, 1) + i * 60_000).toISOString(),
      level: i % 10 === 0 ? 'error' : 'info',
      message: `request handled in ${i} ms`,
      http: { status: i % 20 === 0 ? 503 : 200, path: i % 2 ? '/api/users' : '/health' },
      user: i % 3 === 0 ? `user-${i}` : undefined,
    }),
  );
  const file = makeLogFile('app.jsonl', lines);
  const s = await openAndIndex(file);

  assert.equal(s.status().format, 'json');
  assert.equal(s.lineCount, 1000);

  assert.equal(s.setSearch('http.status:503').total, 50);
  assert.equal(s.setSearch('http.status:>=500').total, 50);
  assert.equal(s.setSearch('http.status:<500').total, 950);
  assert.equal(s.setSearch('http.path:/api/*').total, 500);
  assert.equal(s.setSearch('user:*').total, 334);
  // every 503 line is also an error line (i%20==0 implies i%10==0)
  assert.equal(s.setSearch('level:error AND http.status:503').total, 50);
  // (i%10==0) minus those with a user field (i%30==0): 100 - 34
  assert.equal(s.setSearch('(level:error OR http.status:503) AND NOT user:*').total, 66);

  // detail view exposes flattened fields
  const detail = await s.getDetail(0);
  assert.ok(detail);
  assert.equal(detail.fields.find((f) => f.key === 'http.status')?.value, '503');

  // histogram over filtered results
  s.setSearch('level:error');
  const h = s.histogram();
  assert.ok(h);
  assert.equal(h.buckets.reduce((acc, b) => acc + b.total, 0), 100);
});

test('facet: value breakdown over the whole file and the current result set', async () => {
  const file = makeLogFile('facet.jsonl', appLogLines(5000).map((_, i) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(),
      level: ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'][i % 6],
      host: `web-${i % 4}`,
    }),
  ));
  const s = await openAndIndex(file);

  // whole file: four hosts, evenly distributed (1250 each), sorted by count
  const all = s.facet('host');
  assert.equal(all.field, 'host');
  assert.equal(all.distinctCount, 4);
  assert.equal(all.covered, 5000);
  assert.deepEqual(all.values.map((v) => v.value).sort(), ['web-0', 'web-1', 'web-2', 'web-3']);
  assert.ok(all.values.every((v) => v.count === 1250));

  // limit caps the number of values returned (but not the distinct/covered totals)
  const capped = s.facet('host', 2);
  assert.equal(capped.values.length, 2);
  assert.equal(capped.distinctCount, 4);
  assert.equal(capped.covered, 5000);

  // restricted to the active result set: only ERROR lines (every 6th from index 4)
  s.setSearch('level:ERROR');
  const errors = s.facet('host');
  const errorTotal = errors.values.reduce((acc, v) => acc + v.count, 0);
  assert.equal(errorTotal, s.viewTotal);
  assert.equal(errors.covered, s.viewTotal);

  // a field that does not exist yields an empty breakdown
  const none = s.facet('nope');
  assert.deepEqual(none.values, []);
  assert.equal(none.distinctCount, 0);
  assert.equal(none.covered, 0);
});

test('getRows returns selected field values for the columnar view', async () => {
  const lines = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(),
      level: i % 2 ? 'info' : 'error',
      http: { status: i % 2 ? 200 : 500, path: `/p/${i}` },
    }),
  );
  const file = makeLogFile('cols.jsonl', lines);
  const s = await openAndIndex(file);

  const rows = await s.getRows(0, 3, 'asc', false, false, ['http.status', 'http.path']);
  assert.equal(rows[0].cols?.['http.status'], '500');
  assert.equal(rows[0].cols?.['http.path'], '/p/0');
  assert.equal(rows[1].cols?.['http.status'], '200');

  // without columns requested, no cols attached
  const plain = await s.getRows(0, 1);
  assert.equal(plain[0].cols, undefined);
});

test('search is case-insensitive and quoted field values support wildcards with spaces', async () => {
  const file = makeLogFile('wild.jsonl', [
    JSON.stringify({ level: 'INFO', message: 'Incoming request started now', host: 'Web-01' }),
    JSON.stringify({ level: 'ERROR', message: 'incoming REQUEST stopped later', host: 'web-01' }),
    JSON.stringify({ level: 'INFO', message: 'unrelated entry', host: 'db-02' }),
  ]);
  const s = await openAndIndex(file);

  // full-text and field matching ignore case
  assert.equal(s.setSearch('REQUEST').total, 2);
  assert.equal(s.setSearch('request').total, 2);
  assert.equal(s.setSearch('message:*REQUEST*').total, 2);
  assert.equal(s.setSearch('host:WEB-01').total, 2);

  // a wildcard value containing a space must be quoted; the wildcards still apply
  assert.equal(s.setSearch('message:"*request st*"').total, 2); // matches "request started" and "request stopped"
  assert.equal(s.setSearch('message:"*request sto*"').total, 1); // only "request stopped"
  assert.equal(s.setSearch('message:"*REQUEST STO*"').total, 1); // and stays case-insensitive
  assert.equal(s.setSearch('message:"incoming request started now"').total, 1); // exact (no wildcard)
});

test('phrase search and field phrase', async () => {
  const file = makeLogFile('phrase.log', [
    '2024-01-01 00:00:00 [ERROR] connection failed to db-1',
    '2024-01-01 00:00:01 [INFO] connection established',
    '2024-01-01 00:00:02 [ERROR] failed connection cleanup',
  ]);
  const s = await openAndIndex(file);
  assert.equal(s.setSearch('"connection failed"').total, 1);
  assert.equal(s.setSearch('connection').total, 3);
  assert.equal(s.setSearch('connection AND failed').total, 2);
});

test('file without trailing newline indexes the last line', async () => {
  const file = makeLogFile('nonewline.log', ['line one', 'line two'], false);
  const s = await openAndIndex(file);
  assert.equal(s.lineCount, 2);
  const rows = await s.getRows(0, 10);
  assert.equal(rows[1].text, 'line two');
});

test('descending order returns rows newest-first (whole file and within a search)', async () => {
  const file = makeLogFile('order.log', appLogLines(50));
  const s = await openAndIndex(file);

  // whole file, newest first
  assert.deepEqual((await s.getRows(0, 5, 'desc')).map((r) => r.lineNo), [49, 48, 47, 46, 45]);
  // the final (partial) descending page maps to the oldest lines
  assert.deepEqual((await s.getRows(48, 5, 'desc')).map((r) => r.lineNo), [1, 0]);
  // ascending is unchanged
  assert.deepEqual((await s.getRows(0, 3, 'asc')).map((r) => r.lineNo), [0, 1, 2]);

  // within an active search, order applies to the materialized result set
  s.setSearch('level:ERROR'); // matches line_no 4, 10, 16, 22, 28, 34, 40, 46
  assert.deepEqual((await s.getRows(0, 3, 'asc')).map((r) => r.lineNo), [4, 10, 16]);
  assert.deepEqual((await s.getRows(0, 3, 'desc')).map((r) => r.lineNo), [46, 40, 34]);
});

test('highlight mode returns the whole file with search hits flagged', async () => {
  const file = makeLogFile('highlight.log', appLogLines(50));
  const s = await openAndIndex(file);
  s.setSearch('level:ERROR'); // hits at line_no 4, 10, 16, 22, 28, 34, 40, 46

  // filtered (default) shows only the matching lines
  const filtered = await s.getRows(0, 5);
  assert.deepEqual(filtered.map((r) => r.lineNo), [4, 10, 16, 22, 28]);
  assert.ok(filtered.every((r) => r.match === undefined));

  // highlight shows the whole file in order, flagging which lines match
  const hl = await s.getRows(0, 6, 'asc', true);
  assert.deepEqual(hl.map((r) => r.lineNo), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(hl.map((r) => r.match), [false, false, false, false, true, false]);

  // newest-first highlight mirrors the range and still flags correctly
  const desc = await s.getRows(0, 4, 'desc', true);
  assert.deepEqual(desc.map((r) => r.lineNo), [49, 48, 47, 46]);
  assert.deepEqual(desc.map((r) => r.match), [false, false, false, true]);

  // the match count is unchanged; the route, not getRows, decides the displayed total
  assert.equal(s.viewTotal, 8);
});

test('multi-line grouping folds stack traces into one record', async () => {
  const file = makeLogFile('trace.log', [
    '2024-01-01 00:00:00 [INFO] starting up',
    '2024-01-01 00:00:01 [ERROR] request failed: java.lang.NullPointerException',
    '\tat com.app.Service.handle(Service.java:42)',
    '\tat com.app.Worker.run(Worker.java:88)',
    'Caused by: java.lang.IllegalStateException: bad state',
    '\t... 12 more',
    '2024-01-01 00:00:02 [INFO] recovered',
  ]);
  const s = await openAndIndex(file);
  assert.equal(s.lineCount, 7);

  // 3 logical records: the INFO, the ERROR + its 4 trace lines, the final INFO
  assert.equal(s.recordCount(), 3);

  const recs = await s.getRows(0, 10, 'asc', false, true);
  assert.deepEqual(recs.map((r) => r.lineNo), [0, 1, 6]);
  assert.deepEqual(recs.map((r) => r.span), [1, 5, 1]);
  assert.match(recs[1].text, /request failed/);

  // grouped search: matching text inside the trace surfaces the parent record once
  assert.equal(s.setSearch('IllegalStateException', true).total, 1);
  const hit = await s.getRows(0, 10, 'asc', false, true);
  assert.deepEqual(hit.map((r) => r.lineNo), [1]);
  assert.equal(hit[0].span, 5);

  // the same query ungrouped matches only the physical continuation line
  assert.equal(s.setSearch('IllegalStateException', false).total, 1);
  const phys = await s.getRows(0, 10, 'asc', false, false);
  assert.deepEqual(phys.map((r) => r.lineNo), [4]);

  // a level filter on the head surfaces the whole record in grouped mode
  assert.equal(s.setSearch('level:ERROR', true).total, 1);

  // detail of the record head exposes the full multi-line text
  const detail = await s.getDetail(1);
  assert.ok(detail?.record);
  assert.equal(detail.record.span, 5);
  assert.match(detail.record.text, /Caused by/);
});

test('clustering groups lines into templates and drills into one', async () => {
  // 30 access-style GETs (one template), 10 connection failures (another),
  // 5 OOM lines (a third) — interleaved
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push(`2024-01-01 00:00:${String(i % 60).padStart(2, '0')} [INFO] GET /api/users/${i} 200 in ${i}ms`);
  for (let i = 0; i < 10; i++) lines.push(`2024-01-01 01:00:${String(i % 60).padStart(2, '0')} [ERROR] connection failed to db-${i}`);
  for (let i = 0; i < 5; i++) lines.push(`2024-01-01 02:00:0${i} [FATAL] OOM killed worker ${1000 + i}`);
  const file = makeLogFile('cluster.log', lines);
  const s = await openAndIndex(file);

  const c = s.clusters();
  assert.equal(c.distinctCount, 3);
  assert.equal(c.covered, 45);
  assert.deepEqual(c.patterns.map((p) => p.count), [30, 10, 5]); // sorted by count desc
  assert.match(c.patterns[0].pattern, /GET/);
  assert.match(c.patterns[0].pattern, /<\*>/);

  // drilling into a template filters the view to exactly that cluster
  const topId = c.patterns[0].id;
  assert.equal(s.setSearch('', false, topId).total, 30);
  // and combines with a text query (AND)
  assert.equal(s.setSearch('users', false, topId).total, 30);
  assert.equal(s.setSearch('nomatch', false, topId).total, 0);

  // clusters over a filtered view reflect only the matches
  s.setSearch('level:ERROR');
  const ce = s.clusters();
  assert.equal(ce.distinctCount, 1);
  assert.equal(ce.covered, 10);
});

test('stats summarize the current view', async () => {
  const lines = Array.from({ length: 600 }, (_, i) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(),
      level: i % 5 === 0 ? 'error' : 'info',
      host: `web-${i % 3}`,
    }),
  );
  const s = await openAndIndex(makeLogFile('stats.jsonl', lines));

  const all = s.stats();
  assert.equal(all.total, 600);
  assert.equal(all.withTs, 600);
  assert.equal(all.minTs, Date.UTC(2024, 0, 1));
  assert.equal(all.maxTs, Date.UTC(2024, 0, 1) + 599 * 1000);
  // 120 errors (every 5th), 480 info
  assert.equal(all.levels.find((l) => l.level === 'ERROR')?.count, 120);
  assert.equal(all.levels.find((l) => l.level === 'INFO')?.count, 480);
  // top field "host" with 3 even values
  const host = all.fields.find((f) => f.key === 'host');
  assert.ok(host);
  assert.equal(host.distinctCount, 3);
  assert.ok(host.values.every((v) => v.count === 200));

  // stats follow the active search
  s.setSearch('level:error');
  const e = s.stats();
  assert.equal(e.total, 120);
  assert.equal(e.levels.length, 1);
  assert.equal(e.levels[0].level, 'ERROR');
});

test('regex search post-filters lines and groups by record', async () => {
  const file = makeLogFile('regex.log', [
    '2024-01-01 00:00:00 [INFO] user_42 logged in',
    '2024-01-01 00:00:01 [INFO] user_9001 logged in',
    '2024-01-01 00:00:02 [INFO] anonymous visit',
    '2024-01-01 00:00:03 [ERROR] boom: java.lang.NullPointerException',
    '\tat com.app.Svc.run(Svc.java:7)',
    '2024-01-01 00:00:04 [INFO] user_7 logged in',
  ]);
  const s = await openAndIndex(file);

  // \d{4,} matches only the 9001 line
  assert.equal((await s.setRegexSearch('user_\\d{4,}', false)).total, 1);
  assert.deepEqual((await s.getRows(0, 10)).map((r) => r.lineNo), [1]);

  // case-insensitive by default; matches three user_ lines
  assert.equal((await s.setRegexSearch('USER_\\d+', false)).total, 3);

  // regex matching a stack-trace continuation surfaces its record head when grouped
  assert.equal((await s.setRegexSearch('Svc\\.java', true)).total, 1);
  assert.deepEqual((await s.getRows(0, 10, 'asc', false, true)).map((r) => r.lineNo), [3]);

  // invalid regex is reported
  await assert.rejects(() => s.setRegexSearch('user_(', false), /Invalid regular expression/);

  // clearing restores the full view
  assert.equal((await s.setRegexSearch('', false)).total, 6);
});

test('nextMatch walks occurrences with wrap-around', async () => {
  const file = makeLogFile('nextmatch.log', appLogLines(50));
  const s = await openAndIndex(file);
  s.setSearch('level:ERROR'); // hits at line_no 4, 10, 16, 22, 28, 34, 40, 46

  // forward from the top lands on the first hit, then the next
  assert.equal(s.nextMatch(-1, 1, false)?.lineNo, 4);
  assert.equal(s.nextMatch(4, 1, false)?.lineNo, 10);
  // ungrouped view index equals the physical line number
  assert.equal(s.nextMatch(4, 1, false)?.viewIndex, 10);
  // forward past the last hit wraps to the first
  assert.equal(s.nextMatch(46, 1, false)?.lineNo, 4);
  // backward from the end and with wrap
  assert.equal(s.nextMatch(50, -1, false)?.lineNo, 46);
  assert.equal(s.nextMatch(10, -1, false)?.lineNo, 4);
  assert.equal(s.nextMatch(4, -1, false)?.lineNo, 46);

  // no active search → null
  s.setSearch('');
  assert.equal(s.nextMatch(0, 1, false), null);
});

test('context returns surrounding lines and marks the hits in the window', async () => {
  const file = makeLogFile('context.log', appLogLines(50));
  const s = await openAndIndex(file);

  // no search active: window around a line, clamped at the file start
  s.setSearch('');
  const win = await s.getContext(2, 3, 3);
  assert.equal(win.center, 2);
  assert.deepEqual(win.rows.map((r) => r.lineNo), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(win.matchLines, []);

  // window clamps at the file end too
  const tailWin = await s.getContext(49, 3, 3);
  assert.deepEqual(tailWin.rows.map((r) => r.lineNo), [46, 47, 48, 49]);

  // with a search active, the matching lines within the window are marked
  s.setSearch('level:ERROR'); // hits at line_no 4, 10, 16, 22, ...
  const hitWin = await s.getContext(10, 2, 2);
  assert.deepEqual(hitWin.rows.map((r) => r.lineNo), [8, 9, 10, 11, 12]);
  assert.deepEqual([...hitWin.matchLines].sort((a, b) => a - b), [10]);

  // out-of-range line yields an empty window
  const empty = await s.getContext(999, 3, 3);
  assert.deepEqual(empty.rows, []);
});

test('manual refresh picks up appended lines without tail mode', async () => {
  const file = makeLogFile('refresh.log', appLogLines(20));
  const s = await openAndIndex(file);
  assert.equal(s.lineCount, 20);

  appendFileSync(file, '2024-01-01 02:00:00 [ERROR] late arrival\n');
  await s.refresh();

  assert.equal(s.lineCount, 21);
  const rows = await s.getRows(0, 1, 'desc');
  assert.match(rows[0].text, /late arrival/);
});

test('tail mode picks up appended lines and extends active search', async () => {
  const file = makeLogFile('tail.log', appLogLines(100));
  const s = await openAndIndex(file);
  s.setSearch('level:ERROR');
  const before = s.viewTotal;

  s.setTail(true);
  const appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, '2024-01-01 01:00:00 [ERROR] appended failure\n2024-01-01 01:00:01 [INFO] appended ok\n');
  await appended;

  assert.equal(s.lineCount, 102);
  assert.equal(s.viewTotal, before + 1);
  const rows = await s.getRows(s.viewTotal - 1, 1);
  assert.match(rows[0].text, /appended failure/);
  s.setTail(false);
});

test('tail mode re-indexes a growing unterminated line', async () => {
  const file = makeLogFile('partial.log', ['complete line'], true);
  appendFileSync(file, '2024-01-01 00:00:00 [ERR'); // partial write mid-line
  const s = await openAndIndex(file);
  assert.equal(s.lineCount, 2);

  const appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, 'OR] now the line is complete\n');
  s.setTail(true); // the initial tail check picks the appended bytes up immediately
  await appended;

  assert.equal(s.lineCount, 2);
  const rows = await s.getRows(0, 5);
  assert.equal(rows[1].text, '2024-01-01 00:00:00 [ERROR] now the line is complete');
  assert.equal(s.setSearch('level:ERROR').total, 1);
  s.setTail(false);
});

// Let an append's watch evaluation (which reads the sample line asynchronously)
// settle after the 'append' event has fired.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

test('watch match rule fires on appended lines that match its query', async () => {
  const file = makeLogFile('watch-match.log', appLogLines(10));
  const s = await openAndIndex(file);
  s.setWatchRules([{ id: 'r1', name: 'errors', kind: 'match', query: 'level:ERROR', enabled: true }]);

  const triggers: WatchTrigger[] = [];
  s.on('watch', (t: WatchTrigger) => triggers.push(t));
  s.setTail(true);

  const fired = new Promise<WatchTrigger>((resolve) => s.once('watch', (t: WatchTrigger) => resolve(t)));
  appendFileSync(file, '2024-01-01 01:00:00 [ERROR] boom\n2024-01-01 01:00:01 [INFO] fine\n');
  const t = await fired;

  assert.equal(t.ruleId, 'r1');
  assert.equal(t.kind, 'match');
  assert.equal(t.count, 1); // only the ERROR line, not the INFO one
  assert.match(t.sample?.text ?? '', /boom/);
  assert.equal(t.sample?.level, 'ERROR');

  // a later append with no match produces no further trigger
  const appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, '2024-01-01 01:00:02 [INFO] quiet\n');
  await appended;
  await settle();
  assert.equal(triggers.length, 1);
  s.setTail(false);
});

test('watch rate rule fires once when matches cross the threshold, then re-arms', async () => {
  const file = makeLogFile('watch-rate.log', appLogLines(5));
  const s = await openAndIndex(file);
  s.setWatchRules([
    { id: 'rate1', name: 'error storm', kind: 'rate', query: 'level:ERROR', threshold: 3, windowSec: 3600, enabled: true },
  ]);

  const triggers: WatchTrigger[] = [];
  s.on('watch', (t: WatchTrigger) => triggers.push(t));
  s.setTail(true);

  // two ERRORs — still below the threshold of 3
  let appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, '2024-01-01 01:00:00 [ERROR] e1\n2024-01-01 01:00:01 [ERROR] e2\n');
  await appended;
  await settle();
  assert.equal(triggers.length, 0);

  // a third ERROR crosses the threshold — fires exactly once with the windowed count
  appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, '2024-01-01 01:00:02 [ERROR] e3\n');
  await appended;
  await settle();
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].kind, 'rate');
  assert.equal(triggers[0].count, 3);
  assert.equal(triggers[0].threshold, 3);

  // still above the threshold, so a further ERROR does not re-fire (edge-triggered)
  appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, '2024-01-01 01:00:03 [ERROR] e4\n');
  await appended;
  await settle();
  assert.equal(triggers.length, 1);
  s.setTail(false);
});

test('disabled and unparseable watch rules are ignored', async () => {
  const file = makeLogFile('watch-off.log', appLogLines(5));
  const s = await openAndIndex(file);
  s.setWatchRules([
    { id: 'off', kind: 'match', query: 'level:ERROR', enabled: false },
    { id: 'bad', kind: 'match', query: 'level:(', enabled: true }, // syntax error → skipped
  ]);

  const triggers: WatchTrigger[] = [];
  s.on('watch', (t: WatchTrigger) => triggers.push(t));
  s.setTail(true);

  const appended = new Promise<void>((resolve) => s.once('append', () => resolve()));
  appendFileSync(file, '2024-01-01 01:00:00 [ERROR] boom\n');
  await appended;
  await settle();
  assert.equal(triggers.length, 0);
  s.setTail(false);
});

test('opens a gzipped log transparently', async () => {
  const file = path.join(dir, 'app.log.gz');
  writeFileSync(file, gzipSync(Buffer.from(appLogLines(300).join('\n') + '\n')));
  const s = await openAndIndex(file);

  assert.equal(s.compressed, true);
  assert.equal(s.lineCount, 300);
  assert.equal(s.status().format, 'timestamped');
  const rows = await s.getRows(0, 1);
  assert.match(rows[0].text, /request 0 /);
  assert.equal(s.setSearch('level:ERROR').total, Math.floor(300 / 6) + (300 % 6 > 4 ? 1 : 0));
});

test('opens a rotation group as one time-ordered stream', async () => {
  const all = appLogLines(200);
  // older rotated member, intentionally without a trailing newline to exercise
  // the separator inserted between concatenated files
  const older = makeLogFile('svc.log.1', all.slice(0, 100), false);
  const newer = makeLogFile('svc.log', all.slice(100));

  const s = new LogSession(newer, { sources: [older, newer] }); // oldest→newest
  openSessions.push(s);
  const done = new Promise<void>((resolve, reject) => {
    s.on('done', resolve);
    s.on('error-event', (msg: string) => reject(new Error(msg)));
  });
  await s.start();
  if (s.phase !== 'ready') await done;

  assert.equal(s.sources.length, 2);
  assert.equal(s.status().sourceCount, 2);
  // 200 lines, not 199 — the boundary between the two files stayed split
  assert.equal(s.lineCount, 200);
  const boundary = await s.getRows(99, 2);
  assert.match(boundary[0].text, /request 99 /); // last line of the older file
  assert.match(boundary[1].text, /request 100 /); // first line of the newer file
  assert.equal(s.setSearch('level:ERROR').total, Math.floor(200 / 6) + (200 % 6 > 4 ? 1 : 0));
});

test('numericFacet summarizes a numeric field and facet reports numeric coverage', async () => {
  const lines = Array.from(
    { length: 100 },
    (_, i) => `level=INFO duration=${i} status=${i % 2 === 0 ? 200 : 500} msg=req${i}`,
  );
  const s = await openAndIndex(makeLogFile('logfmt.log', lines));

  const nf = s.numericFacet('duration', 10);
  assert.ok(nf);
  assert.equal(nf.count, 100);
  assert.equal(nf.min, 0);
  assert.equal(nf.max, 99);
  assert.equal(nf.buckets.length, 10);
  assert.equal(
    nf.buckets.reduce((a, b) => a + b.count, 0),
    100,
  );
  assert.ok(nf.p50 >= 49 && nf.p50 <= 51);
  // the highest value lands in the last bucket, whose hi equals max
  assert.equal(nf.buckets[nf.buckets.length - 1].hi, 99);

  // a non-numeric field has no numeric distribution
  assert.equal(s.numericFacet('msg'), null);
  assert.equal(s.facet('duration').numericCount, 100);
  assert.equal(s.facet('msg').numericCount, 0);

  // restricted to a result set
  s.setSearch('status:500');
  const nf2 = s.numericFacet('duration', 10);
  assert.ok(nf2);
  assert.equal(nf2.count, 50); // odd i → status 500
});

test('correlate surfaces fields the result set concentrates in', async () => {
  // 300 lines; errors (every 5th) nearly all come from host=web-03
  const lines = Array.from({ length: 300 }, (_, i) => {
    const err = i % 5 === 0;
    const host = err ? (i % 25 === 0 ? 'web-01' : 'web-03') : `web-0${i % 7}`;
    return `level=${err ? 'ERROR' : 'INFO'} host=${host} status=${err ? 503 : 200} msg=req${i}`;
  });
  const s = await openAndIndex(makeLogFile('corr.log', lines));

  // no search → nothing to explain
  assert.deepEqual(s.correlate().items, []);

  s.setSearch('level:ERROR');
  const c = s.correlate();
  assert.equal(c.resultsTotal, 60);
  // host concentrates on web-03, status on 503
  const host = c.items.find((it) => it.field === 'host');
  assert.ok(host);
  assert.equal(host.value, 'web-03');
  assert.ok(host.share >= 0.7 && host.share <= 0.9); // ~80%
  assert.ok(host.lift > 1.5); // over-represented vs the whole file
  assert.ok(c.items.some((it) => it.field === 'status' && it.value === '503'));
  // high-cardinality msg never dominates, so it isn't surfaced
  assert.ok(!c.items.some((it) => it.field === 'msg'));
});

test('index is reused on reopen of an unchanged file', async () => {
  const file = makeLogFile('reuse.log', appLogLines(2000));
  const s1 = await openAndIndex(file);
  assert.equal(s1.reusedIndex, false);
  await s1.close();
  openSessions.splice(openSessions.indexOf(s1), 1);

  const s2 = await openAndIndex(file);
  assert.equal(s2.reusedIndex, true);
  assert.equal(s2.lineCount, 2000);
  assert.equal(s2.status().format, 'timestamped');
  assert.equal(s2.setSearch('level:ERROR').total, Math.ceil((2000 - 4) / 6));
  const rows = await s2.getRows(0, 1);
  assert.match(rows[0].text, /request 4 /);
});

test('reopening a changed file rebuilds the index in place without error', async () => {
  // The index db is keyed by file path, so a changed file reuses the same db
  // file and rebuilds its schema over the old one — every table must be dropped
  // first (regression: `templates` was left behind, failing the rebuild).
  const file = makeLogFile('rebuild.log', appLogLines(50));
  const s1 = await openAndIndex(file);
  assert.equal(s1.reusedIndex, false);
  await s1.close();
  openSessions.splice(openSessions.indexOf(s1), 1);

  // change the contents so the fingerprint no longer matches the cached index
  writeFileSync(file, appLogLines(80).join('\n') + '\n');
  const s2 = await openAndIndex(file); // would throw "table templates already exists"
  assert.equal(s2.reusedIndex, false);
  assert.equal(s2.lineCount, 80);
});

test('copyText returns the current view as multi-line text, capped and ordered', async () => {
  const file = makeLogFile('copy.log', appLogLines(100));
  const s = await openAndIndex(file);

  // whole file, capped
  const a = await s.copyText(5, 'asc');
  assert.equal(a.count, 5);
  assert.equal(a.total, 100);
  assert.equal(a.text.split('\n').length, 5);
  assert.match(a.text.split('\n')[0], /request 0 /);

  // newest-first order
  const d = await s.copyText(3, 'desc');
  assert.match(d.text.split('\n')[0], /request 99 /);

  // restricted to a search
  s.setSearch('level:ERROR');
  const e = await s.copyText(1000, 'asc');
  assert.equal(e.count, e.total);
  assert.ok(e.text.split('\n').every((l) => /\[ERROR\]/.test(l)));
});

test('merged timeline interleaves files by timestamp', async () => {
  const fileA = makeLogFile('merge-a.log', [0, 2, 4].map((s) => `2024-01-01 00:00:0${s} [INFO] A event ${s}`));
  const fileB = makeLogFile('merge-b.log', [1, 3, 5].map((s) => `2024-01-01 00:00:0${s} [ERROR] B event ${s}`));
  const sa = await openAndIndex(fileA);
  const sb = await openAndIndex(fileB);
  const m = new MergedTimeline([sa, sb]);
  try {
    assert.equal(m.count(), 6);

    const rows = await m.page(0, 10, 'asc');
    assert.deepEqual(rows.map((r) => r.ts), [0, 1, 2, 3, 4, 5].map((s) => Date.UTC(2024, 0, 1, 0, 0, s)));
    assert.deepEqual(rows.map((r) => r.source), [0, 1, 0, 1, 0, 1]); // A, B, A, B, …
    assert.match(rows[0].text, /A event 0/);
    assert.match(rows[1].text, /B event 1/);

    // newest-first
    const desc = await m.page(0, 2, 'desc');
    assert.deepEqual(desc.map((r) => r.ts), [Date.UTC(2024, 0, 1, 0, 0, 5), Date.UTC(2024, 0, 1, 0, 0, 4)]);

    // seek: 3 rows precede ts = 3s (0s, 1s, 2s)
    assert.equal(m.seekTs(Date.UTC(2024, 0, 1, 0, 0, 3)), 3);

    const h = m.histogram();
    assert.ok(h);
    assert.equal(h.buckets.reduce((acc, b) => acc + b.total, 0), 6);

    // cross-file search: level filter narrows to one source
    assert.equal(m.setSearch('level:ERROR').total, 3); // only file B
    const filtered = await m.page(0, 10, 'asc');
    assert.deepEqual(filtered.map((r) => r.source), [1, 1, 1]);

    // text search across files (matches A's lines)
    assert.equal(m.setSearch('"A event"').total, 3);

    // highlight mode keeps all rows but flags matches
    const hl = await m.page(0, 10, 'asc', true);
    assert.equal(hl.length, 6);
    assert.deepEqual(hl.map((r) => r.match), [true, false, true, false, true, false]);

    // clearing the search restores the full timeline
    assert.equal(m.setSearch('').total, 6);
  } finally {
    m.close();
  }
});

test('merged timeline follows lines appended to its sources', async () => {
  const fileA = makeLogFile('live-a.log', [0, 2].map((s) => `2024-01-01 00:00:0${s} [INFO] A event ${s}`));
  const fileB = makeLogFile('live-b.log', [1, 3].map((s) => `2024-01-01 00:00:0${s} [ERROR] B event ${s}`));
  const sa = await openAndIndex(fileA);
  const sb = await openAndIndex(fileB);
  const m = new MergedTimeline([sa, sb]);
  try {
    assert.equal(m.count(), 4);
    // an active search that should grow as matching lines arrive (B's two errors so far)
    assert.equal(m.setSearch('level:ERROR').total, 2);

    sa.setTail(true);
    sb.setTail(true);

    // append a matching line to A and a non-matching line to B
    const aDone = new Promise<void>((r) => sa.once('append', () => r()));
    appendFileSync(fileA, '2024-01-01 00:00:04 [ERROR] A event 4\n');
    await aDone;
    const bDone = new Promise<void>((r) => sb.once('append', () => r()));
    appendFileSync(fileB, '2024-01-01 00:00:05 [INFO] B event 5\n');
    await bDone;

    // the whole timeline grew by both lines; the search picked up only A's new error
    assert.equal(m.count(true), 6);
    assert.equal(m.count(false), 3);

    // the whole timeline (highlight mode keeps every row) stays in strict
    // timestamp order with the appended lines slotted in, newest last
    const rows = await m.page(0, 10, 'asc', true);
    assert.deepEqual(
      rows.map((r) => r.ts),
      [0, 1, 2, 3, 4, 5].map((s) => Date.UTC(2024, 0, 1, 0, 0, s)),
    );
    assert.match(rows.at(-1)!.text, /B event 5/);
    assert.deepEqual(
      rows.map((r) => r.match),
      [false, true, false, true, true, false], // the three ERROR lines flagged
    );

    // the filtered view is the three errors, in time order
    const filtered = await m.page(0, 10, 'asc');
    assert.deepEqual(
      filtered.map((r) => r.text.match(/[AB] event \d/)?.[0]),
      ['B event 1', 'B event 3', 'A event 4'],
    );
  } finally {
    sa.setTail(false);
    sb.setTail(false);
    m.close();
  }
});

test('export iteration covers all results in order', async () => {
  const file = makeLogFile('export.log', appLogLines(500));
  const s = await openAndIndex(file);
  s.setSearch('level:WARN');
  const all: number[] = [];
  for (const batch of s.iterateResultRows()) all.push(...batch);
  assert.equal(all.length, s.viewTotal);
  for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1]);
});
