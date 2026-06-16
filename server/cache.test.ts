import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listCache, evictCache, clearCache, pruneStaleCache } from './cache.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'tb-cache-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(name: string, ageDays = 0): string {
  const full = path.join(dir, name);
  writeFileSync(full, 'x'.repeat(1024)); // not a real sqlite file — readMeta tolerates it
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(full, t, t);
  }
  return full;
}

test('cache: list, evict, clear, and prune by age', () => {
  const fresh = makeDb('aaaa.db', 0);
  const stale = makeDb('bbbb.db', 30);
  makeDb('cccc.db', 0);
  makeDb('merged-123.db', 0); // transient — must be ignored
  const active = new Map<string, string>([[fresh, '/logs/app.log']]);

  // listing excludes merged-* and flags the in-use entry
  const info = listCache(dir, active);
  assert.deepEqual(info.entries.map((e) => e.name).sort(), ['aaaa.db', 'bbbb.db', 'cccc.db']);
  assert.equal(info.entries.find((e) => e.name === 'aaaa.db')?.inUse, true);
  assert.equal(info.entries.find((e) => e.name === 'aaaa.db')?.path, '/logs/app.log');
  assert.equal(info.totalSize, 3 * 1024);

  // can't evict the in-use one; can evict another
  assert.equal(evictCache(dir, 'aaaa.db', active), false);
  assert.ok(existsSync(fresh));
  assert.equal(evictCache(dir, 'cccc.db', active), true);
  assert.equal(existsSync(path.join(dir, 'cccc.db')), false);
  // path traversal / non-cache names refused
  assert.equal(evictCache(dir, '../escape.db', active), false);

  // prune removes the 30-day-old one (retention 7), keeps fresh, skips in-use
  const pr = pruneStaleCache(dir, 7, active);
  assert.equal(pr.removed, 1);
  assert.equal(existsSync(stale), false);
  assert.ok(existsSync(fresh));

  // clear removes everything not in use
  clearCache(dir, active);
  const after = listCache(dir, active);
  assert.equal(after.entries.length, 1); // only the in-use one remains
  assert.equal(after.entries[0].name, 'aaaa.db');
});
