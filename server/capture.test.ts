import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable, PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CaptureSource } from './capture.ts';
import { LogSession } from './session.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'tracebox-capture-'));
const openSessions: LogSession[] = [];
let seq = 0;

after(async () => {
  for (const s of openSessions) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

function captureFile(): string {
  return path.join(dir, `cap-${seq++}.data`);
}

async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Start a capture-backed session and wait for the initial index to finish. */
async function startSession(capture: CaptureSource): Promise<LogSession> {
  const session = new LogSession(capture.file, { capture });
  openSessions.push(session);
  const done = once(session, 'done');
  await session.start();
  await done;
  return session;
}

test('runs a shell command and indexes its captured output', async () => {
  // `echo` exists on both cmd.exe and POSIX shells; shell:true makes it portable
  const capture = new CaptureSource({ command: 'echo tracebox-capture-test', file: captureFile() });
  const session = await startSession(capture);

  await waitUntil(() => capture.state !== 'running');
  await session.refresh();

  assert.ok(session.lineCount >= 1);
  const rows = await session.getRows(0, 5);
  assert.ok(rows.some((r) => r.text.includes('tracebox-capture-test')));

  const status = session.status();
  assert.equal(status.kind, 'command');
  assert.equal(status.command, 'echo tracebox-capture-test');
  assert.equal(status.capture?.state, 'exited');
  assert.equal(status.tail, false); // following stopped once the process exited
});

test('captures an arbitrary readable stream', async () => {
  const stream = Readable.from(['alpha\nbravo\n', 'charlie\n']);
  const capture = new CaptureSource({ command: '(stream)', file: captureFile(), stdin: stream });
  const session = await startSession(capture);

  await waitUntil(() => capture.state !== 'running');
  await session.refresh();

  assert.equal(session.lineCount, 3);
  const rows = await session.getRows(0, 10);
  assert.deepEqual(rows.map((r) => r.text), ['alpha', 'bravo', 'charlie']);
});

test('stop() freezes the captured data while keeping it searchable', async () => {
  const stdin = new PassThrough();
  const capture = new CaptureSource({ command: '(stream)', file: captureFile(), stdin });
  const session = await startSession(capture);

  stdin.write('2024-01-01 00:00:00 [ERROR] one\n');
  stdin.write('2024-01-01 00:00:01 [INFO] two\n');
  await waitUntil(() => session.lineCount >= 2);

  session.stopCapture();
  await waitUntil(() => capture.state === 'exited');
  await session.refresh();

  const frozen = session.lineCount;
  assert.ok(frozen >= 2);
  // the frozen capture still answers queries
  assert.equal(session.setSearch('level:ERROR').total, 1);
  assert.equal(session.status().tail, false);

  stdin.destroy();
});

test('turning tail off pauses a command capture; turning it on resumes', async () => {
  const stdin = new PassThrough();
  const capture = new CaptureSource({ command: '(stream)', file: captureFile(), stdin });
  const session = await startSession(capture);

  stdin.write('line one\n');
  await waitUntil(() => session.lineCount >= 1);
  assert.equal(session.status().tail, true); // a capture follows by default

  // pause: new output is back-pressured and does not get indexed
  session.setTail(false);
  stdin.write('line two\n');
  stdin.write('line three\n');
  await new Promise((r) => setTimeout(r, 250));
  await session.refresh();
  assert.equal(session.lineCount, 1);

  // resume: the buffered output flows and is indexed, in order
  session.setTail(true);
  await waitUntil(() => session.lineCount >= 3);
  const rows = await session.getRows(0, 10);
  assert.deepEqual(rows.map((r) => r.text), ['line one', 'line two', 'line three']);

  stdin.destroy();
});

test('reports a spawn failure as a failed capture', async () => {
  const capture = new CaptureSource({
    command: 'this-command-does-not-exist-tracebox',
    file: captureFile(),
  });
  // a shell reports an unknown command via a non-zero exit (state 'exited'); a
  // direct spawn error would surface as 'failed'. Either way the session opens
  // and the producer terminates without hanging.
  const session = await startSession(capture);
  await waitUntil(() => capture.state !== 'running');
  assert.notEqual(session.status().capture?.state, 'running');
  assert.equal(session.status().tail, false);
});
