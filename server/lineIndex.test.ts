import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineIndex, LineScanner, STRIDE, MAX_SCAN_LINE, type LineSpan } from './lineIndex.ts';

test('LineScanner emits lines across chunk boundaries', () => {
  const scanner = new LineScanner();
  const lines: LineSpan[] = [];
  const onLine = (s: LineSpan): void => {
    lines.push(s);
  };
  scanner.push(Buffer.from('hello wo'), onLine);
  scanner.push(Buffer.from('rld\nsecond li'), onLine);
  scanner.push(Buffer.from('ne\npartial'), onLine);
  scanner.flush(onLine);

  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { offset: 0, text: 'hello world' });
  assert.deepEqual(lines[1], { offset: 12, text: 'second line' });
  assert.deepEqual(lines[2], { offset: 24, text: 'partial' });
});

test('LineScanner strips \\r\\n and handles empty lines', () => {
  const scanner = new LineScanner();
  const lines: LineSpan[] = [];
  scanner.push(Buffer.from('a\r\n\r\nb\n'), (s) => lines.push(s));
  scanner.flush((s) => lines.push(s));
  assert.deepEqual(
    lines.map((l) => l.text),
    ['a', '', 'b'],
  );
  assert.deepEqual(
    lines.map((l) => l.offset),
    [0, 3, 5],
  );
});

test('LineScanner caps pathological lines but keeps offsets exact', () => {
  const scanner = new LineScanner();
  const lines: LineSpan[] = [];
  const big = Buffer.alloc(MAX_SCAN_LINE + 5000, 0x61); // 'a' * (1MiB + 5000)
  scanner.push(big, (s) => lines.push(s));
  scanner.push(Buffer.from('tail\nnext\n'), (s) => lines.push(s));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].offset, 0);
  assert.equal(lines[0].text.length, MAX_SCAN_LINE);
  assert.deepEqual(lines[1], { offset: big.length + 5, text: 'next' });
});

test('LineScanner with reused chunk buffer does not alias', () => {
  const scanner = new LineScanner();
  const lines: LineSpan[] = [];
  const buf = Buffer.alloc(16);
  buf.write('part1');
  scanner.push(buf.subarray(0, 5), (s) => lines.push(s));
  buf.fill(0x7a); // overwrite the buffer, as a reader loop would
  buf.write('-end\n');
  scanner.push(buf.subarray(0, 5), (s) => lines.push(s));
  assert.deepEqual(lines, [{ offset: 0, text: 'part1-end' }]);
});

test('LineIndex locate finds checkpoints', () => {
  const idx = new LineIndex();
  // synthetic: line i starts at byte i*10
  const n = STRIDE * 3 + 7;
  for (let i = 0; i < n; i++) idx.addLine(i * 10);
  idx.indexedBytes = n * 10;

  assert.equal(idx.lineCount, n);
  assert.deepEqual(idx.locate(0), { line: 0, offset: 0 });
  assert.deepEqual(idx.locate(STRIDE - 1), { line: 0, offset: 0 });
  assert.deepEqual(idx.locate(STRIDE), { line: STRIDE, offset: STRIDE * 10 });
  assert.deepEqual(idx.locate(STRIDE * 2 + 5), { line: STRIDE * 2, offset: STRIDE * 2 * 10 });
  assert.throws(() => idx.locate(n));
});

test('LineIndex snapshot/restore round-trip', () => {
  const idx = new LineIndex();
  const n = 100_000;
  for (let i = 0; i < n; i++) idx.addLine(i * 3);
  idx.indexedBytes = n * 3;

  const snap = idx.snapshot();
  // simulate persistence truncation of the last block
  const used = snap.checkpoints;
  const blocks = snap.blocks.map((b, i) => {
    const inBlock = Math.min(used - i * b.length, b.length);
    return b.slice(0, inBlock);
  });
  const restored = LineIndex.restore(blocks, n, n * 3);
  assert.equal(restored.lineCount, n);
  assert.deepEqual(restored.locate(99_999), idx.locate(99_999));

  // appending after restore keeps working
  restored.addLine(n * 3);
  assert.equal(restored.lineCount, n + 1);
  assert.equal(restored.locate(n).offset >= 0, true);
});

test('LineIndex removeLastLine', () => {
  const idx = new LineIndex();
  for (let i = 0; i <= STRIDE; i++) idx.addLine(i * 10); // lines 0..STRIDE (checkpoint at STRIDE)
  assert.equal(idx.lineCount, STRIDE + 1);
  idx.removeLastLine();
  assert.equal(idx.lineCount, STRIDE);
  // re-add with a different offset: the checkpoint must be overwritten
  idx.addLine(12345);
  assert.deepEqual(idx.locate(STRIDE), { line: STRIDE, offset: 12345 });
});
