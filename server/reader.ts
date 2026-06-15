import { open, type FileHandle } from 'node:fs/promises';
import { LineIndex, STRIDE } from './lineIndex.ts';

/** Lines longer than this are truncated when read back for display. */
export const MAX_LINE_BYTES = 1 << 20; // 1 MiB

const READ_CHUNK = 256 * 1024;

/**
 * Random-access line reader over a log file, backed by the sparse LineIndex.
 * Reading a window of lines costs one seek to the nearest checkpoint plus a
 * short sequential scan (at most STRIDE-1 lines of overshoot).
 */
export class LineReader {
  private fd: FileHandle | null = null;
  readonly filePath: string;
  private readonly index: LineIndex;

  constructor(filePath: string, index: LineIndex) {
    this.filePath = filePath;
    this.index = index;
  }

  async openFile(): Promise<void> {
    this.fd = await open(this.filePath, 'r');
  }

  async close(): Promise<void> {
    await this.fd?.close();
    this.fd = null;
  }

  /**
   * Read `count` consecutive lines starting at `startLine`.
   * Returns raw line texts (without newline), each truncated to MAX_LINE_BYTES.
   */
  async readLines(startLine: number, count: number): Promise<string[]> {
    if (count <= 0 || this.index.lineCount === 0) return [];
    if (startLine < 0) startLine = 0;
    if (startLine >= this.index.lineCount) return [];
    count = Math.min(count, this.index.lineCount - startLine);

    const { line: cpLine, offset } = this.index.locate(startLine);
    const skip = startLine - cpLine;
    const endByte = this.index.endOffset;

    const out: string[] = [];
    let skipped = 0;
    let pos = offset;
    let pending: Buffer | null = null;
    let pendingTruncated = false;

    const fd = this.fd;
    if (!fd) throw new Error('reader not open');

    const buf = Buffer.allocUnsafe(READ_CHUNK);
    outer: while (pos < endByte && out.length < count) {
      const want = Math.min(READ_CHUNK, endByte - pos);
      const { bytesRead } = await fd.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);

      let lineStart = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, lineStart);
        const isLast = nl === -1 && pos >= endByte; // unterminated final line
        if (nl === -1 && !isLast) break;
        const sliceEnd = nl === -1 ? chunk.length : nl;

        if (skipped < skip) {
          skipped++;
          pending = null;
          pendingTruncated = false;
        } else {
          let lineBuf: Buffer = chunk.subarray(lineStart, sliceEnd);
          if (pending !== null) {
            if (!pendingTruncated) lineBuf = Buffer.concat([pending, lineBuf]);
            else lineBuf = pending;
            pending = null;
            pendingTruncated = false;
          }
          if (lineBuf.length > MAX_LINE_BYTES) lineBuf = lineBuf.subarray(0, MAX_LINE_BYTES);
          let end = lineBuf.length;
          if (end > 0 && lineBuf[end - 1] === 0x0d) end--;
          out.push(lineBuf.toString('utf8', 0, end));
          if (out.length >= count) break outer;
        }
        if (nl === -1) break;
        lineStart = nl + 1;
        if (lineStart >= chunk.length) break;
      }

      // carry partial line into next chunk
      if (lineStart < chunk.length) {
        const tail = chunk.subarray(lineStart);
        if (skipped < skip) {
          // still skipping: no need to keep bytes, just remember nothing
          pending = null;
        } else if (pending !== null) {
          if (!pendingTruncated) {
            const merged = Buffer.concat([pending, tail]);
            if (merged.length > MAX_LINE_BYTES) {
              pending = merged.subarray(0, MAX_LINE_BYTES);
              pendingTruncated = true;
            } else {
              pending = merged;
            }
          }
        } else {
          pending = Buffer.from(tail); // copy: buf is reused next iteration
        }
      }
    }

    return out;
  }

  /** Read one full line (still capped at MAX_LINE_BYTES). */
  async readLine(lineNo: number): Promise<string> {
    const [line] = await this.readLines(lineNo, 1);
    return line ?? '';
  }
}
