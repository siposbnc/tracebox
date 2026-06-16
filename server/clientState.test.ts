import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

// clientState resolves its file under os.homedir(); point HOME/USERPROFILE at a
// temp dir so the test never touches the real ~/.tracebox.
const dir = mkdtempSync(path.join(tmpdir(), 'tracebox-state-'));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = dir;
process.env.USERPROFILE = dir;

let getClientState: typeof import('./clientState.ts').getClientState;
let patchClientState: typeof import('./clientState.ts').patchClientState;

before(async () => {
  assert.equal(homedir(), dir, 'home should resolve to the temp dir');
  ({ getClientState, patchClientState } = await import('./clientState.ts'));
});

after(() => {
  process.env.HOME = prev.HOME;
  process.env.USERPROFILE = prev.USERPROFILE;
  rmSync(dir, { recursive: true, force: true });
});

test('client state starts empty, then sets, deletes, and persists', () => {
  assert.deepEqual(getClientState(), {});

  patchClientState({ 'tracebox.wrap': 'true', 'tracebox.workspaces': '[{"name":"w1"}]' });
  assert.deepEqual(getClientState(), {
    'tracebox.wrap': 'true',
    'tracebox.workspaces': '[{"name":"w1"}]',
  });

  // null deletes; a non-string value is ignored
  patchClientState({ 'tracebox.wrap': null });
  assert.deepEqual(getClientState(), { 'tracebox.workspaces': '[{"name":"w1"}]' });

  // persisted to disk
  const onDisk = JSON.parse(readFileSync(path.join(dir, '.tracebox', 'state.json'), 'utf8'));
  assert.deepEqual(onDisk, { 'tracebox.workspaces': '[{"name":"w1"}]' });
  assert.ok(existsSync(path.join(dir, '.tracebox', 'state.json')));
});
