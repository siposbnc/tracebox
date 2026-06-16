import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rotationBase, detectRotationGroup } from './rotation.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'tracebox-rot-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('rotationBase reduces rotated names to a shared base', () => {
  assert.equal(rotationBase('app.log'), 'app.log');
  assert.equal(rotationBase('app.log.1'), 'app.log');
  assert.equal(rotationBase('app.log.12'), 'app.log');
  assert.equal(rotationBase('app.log.2.gz'), 'app.log');
  assert.equal(rotationBase('app.log-20240101'), 'app.log');
  assert.equal(rotationBase('app.log-2024-01-01.gz'), 'app.log');
  assert.equal(rotationBase('app-2024-01-01.log'), 'app.log');
  // unrelated / numbered service names must NOT collapse together
  assert.equal(rotationBase('access.log'), 'access.log');
  assert.equal(rotationBase('app1.log'), 'app1.log');
  assert.equal(rotationBase('app.log.bak'), 'app.log.bak');
});

test('detectRotationGroup orders members oldest→newest by mtime', () => {
  const mk = (name: string, ageSec: number, body = name + '\n'): string => {
    const p = path.join(dir, name);
    writeFileSync(p, body);
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(p, t, t);
    return p;
  };
  // current is newest; .1 older; .2.gz oldest
  const cur = mk('svc.log', 0);
  const one = mk('svc.log.1', 60);
  const two = path.join(dir, 'svc.log.2.gz');
  writeFileSync(two, gzipSync(Buffer.from('old\n')));
  const t = new Date(Date.now() - 120 * 1000);
  utimesSync(two, t, t);

  const group = detectRotationGroup(cur).map((m) => m.path);
  assert.deepEqual(group, [two, one, cur]);
});

test('detectRotationGroup returns just the file when it has no siblings', () => {
  const solo = path.join(dir, 'lonely.log');
  writeFileSync(solo, 'hi\n');
  const group = detectRotationGroup(solo);
  assert.equal(group.length, 1);
  assert.equal(group[0].path, solo);
});
