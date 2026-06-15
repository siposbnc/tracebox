import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogSession } from './session.ts';

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

test('export iteration covers all results in order', async () => {
  const file = makeLogFile('export.log', appLogLines(500));
  const s = await openAndIndex(file);
  s.setSearch('level:WARN');
  const all: number[] = [];
  for (const batch of s.iterateResultRows()) all.push(...batch);
  assert.equal(all.length, s.viewTotal);
  for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1]);
});
