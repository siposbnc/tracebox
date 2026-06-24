import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogSession } from './session.ts';
import type { AggregateSpec } from './indexer.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'tracebox-agg-'));
const cfgDir = mkdtempSync(path.join(tmpdir(), 'tracebox-agg-cfg-'));
process.env.TRACEBOX_CONFIG_DIR = cfgDir;
const openSessions: LogSession[] = [];

after(async () => {
  for (const s of openSessions) await s.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

/**
 * 60 JSON lines, one per minute. service cycles api/web/db (20 each);
 * status is 500 every 10th line (6 total) else 200; level mirrors status;
 * duration_ms = line index (0..59).
 */
function makeJsonLog(): string {
  const services = ['api', 'web', 'db'];
  const lines = Array.from({ length: 60 }, (_, i) => {
    const ts = new Date(Date.UTC(2024, 0, 1, 0, i, 0)).toISOString();
    const status = i % 10 === 0 ? 500 : 200;
    return JSON.stringify({
      timestamp: ts,
      level: status >= 500 ? 'error' : 'info',
      service: services[i % 3],
      status,
      duration_ms: i,
      msg: `request ${i}`,
    });
  });
  const file = path.join(dir, 'app.json');
  writeFileSync(file, lines.join('\n') + '\n');
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

test('aggregate: single-stat count over whole file and scoped by query', async () => {
  const s = await openAndIndex(makeJsonLog());
  const spec: AggregateSpec = { groupBy: { type: 'none' }, metric: { type: 'count' } };

  const all = s.aggregate('', spec);
  assert.equal(all.groupKind, 'none');
  assert.equal(all.series.length, 1);
  assert.equal(all.rows.length, 1);
  assert.equal(all.rows[0].total, 60);

  const errs = s.aggregate('status:500', spec);
  assert.equal(errs.rows[0].total, 6);
});

test('aggregate: count grouped by a field value', async () => {
  const s = await openAndIndex(makeJsonLog());
  const r = s.aggregate('', { groupBy: { type: 'field', field: 'service' }, metric: { type: 'count' } });
  assert.equal(r.groupKind, 'field');
  assert.equal(r.rows.length, 3);
  for (const row of r.rows) assert.equal(row.total, 20);

  const byStatus = s.aggregate('', { groupBy: { type: 'field', field: 'status' }, metric: { type: 'count' } });
  const map = Object.fromEntries(byStatus.rows.map((row) => [row.key, row.total]));
  assert.equal(map['200'], 54);
  assert.equal(map['500'], 6);
});

test('aggregate: numeric metrics (avg/min/max/sum/p50/p95) on a field', async () => {
  const s = await openAndIndex(makeJsonLog());
  const stat = (fn: 'avg' | 'min' | 'max' | 'sum' | 'p50' | 'p95'): number =>
    s.aggregate('', { groupBy: { type: 'none' }, metric: { type: 'numeric', field: 'duration_ms', fn } }).rows[0].total;

  assert.equal(stat('min'), 0);
  assert.equal(stat('max'), 59);
  assert.equal(stat('sum'), (59 * 60) / 2); // 1770
  assert.equal(stat('avg'), 29.5);
  assert.equal(stat('p50'), 30); // median offset of 0..59
  assert.equal(stat('p95'), 56); // round(0.95 * 59) = 56
});

test('aggregate: split into series by level', async () => {
  const s = await openAndIndex(makeJsonLog());
  const r = s.aggregate('', {
    groupBy: { type: 'field', field: 'service' },
    splitBy: { type: 'level' },
    metric: { type: 'count' },
  });
  assert.ok(r.series.includes('INFO'));
  assert.ok(r.series.includes('ERROR'));
  for (const row of r.rows) {
    assert.equal(row.total, 20);
    assert.equal(row.values['ERROR'], 2);
    assert.equal(row.values['INFO'], 18);
  }
});

test('aggregate: unique counts distinct values', async () => {
  const s = await openAndIndex(makeJsonLog());
  const r = s.aggregate('', { groupBy: { type: 'none' }, metric: { type: 'unique', field: 'service' } });
  assert.equal(r.rows[0].total, 3);
});

test('aggregate: time grouping yields ordered buckets covering all lines', async () => {
  const s = await openAndIndex(makeJsonLog());
  const r = s.aggregate('', { groupBy: { type: 'time', buckets: 10 }, metric: { type: 'count' } });
  assert.equal(r.groupKind, 'time');
  assert.ok(r.bucketMs && r.bucketMs > 0);
  // keys are strictly increasing bucket-start timestamps
  for (let i = 1; i < r.rows.length; i++) assert.ok(Number(r.rows[i].key) > Number(r.rows[i - 1].key));
  const sum = r.rows.reduce((acc, row) => acc + row.total, 0);
  assert.equal(sum, 60);
});

test('aggregate: top-N group limit marks truncated', async () => {
  const s = await openAndIndex(makeJsonLog());
  const r = s.aggregate('', { groupBy: { type: 'field', field: 'service', limit: 2 }, metric: { type: 'count' } });
  assert.equal(r.rows.length, 2);
  assert.equal(r.truncated, true);
});

test('aggregate: rejects regex/capture scoping queries', async () => {
  const s = await openAndIndex(makeJsonLog());
  assert.throws(() => s.aggregate('/request/', { groupBy: { type: 'none' }, metric: { type: 'count' } }));
});
