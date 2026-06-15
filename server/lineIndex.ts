/**
 * Sparse line-offset index for huge files.
 *
 * Instead of storing the byte offset of every line (8 bytes x possibly
 * hundreds of millions of lines), we store a checkpoint every STRIDE lines.
 * To read line N we seek to the nearest checkpoint at or before N and scan
 * forward at most STRIDE-1 newlines — a few KB of sequential I/O.
 *
 * Memory cost: a 100M-line file costs ~12.5 MB (100M / 64 * 8 bytes).
 */

export const STRIDE = 64;

const CHUNK = 65536; // checkpoints per allocation block

export class LineIndex {
  private blocks: Float64Array[] = [];
  private checkpoints = 0;
  lineCount = 0;
  /** Total bytes of the file covered by this index. */
  indexedBytes = 0;

  /** Record the byte offset where line `lineCount` starts. Call once per line, in order. */
  addLine(byteOffset: number): void {
    if (this.lineCount % STRIDE === 0) {
      const block = this.checkpoints >>> 16;
      if (block >= this.blocks.length) this.blocks.push(new Float64Array(CHUNK));
      this.blocks[block][this.checkpoints & 0xffff] = byteOffset;
      this.checkpoints++;
    }
    this.lineCount++;
  }

  /**
   * Returns the nearest indexed position at or before `lineNo`:
   * the line number of the checkpoint and its byte offset.
   */
  locate(lineNo: number): { line: number; offset: number } {
    if (lineNo < 0 || lineNo >= this.lineCount) {
      throw new RangeError(`line ${lineNo} out of range (0..${this.lineCount - 1})`);
    }
    const cp = Math.floor(lineNo / STRIDE);
    return { line: cp * STRIDE, offset: this.blocks[cp >>> 16][cp & 0xffff] };
  }

  /** Byte offset of the end of the indexed region (start of any future appended data). */
  get endOffset(): number {
    return this.indexedBytes;
  }

  /**
   * Remove the most recently added line (used in tail mode when an
   * unterminated trailing line gets extended by an append and must be
   * re-indexed; the caller tracks where that line started).
   */
  removeLastLine(): void {
    if (this.lineCount === 0) throw new RangeError('index is empty');
    this.lineCount--;
    if (this.lineCount % STRIDE === 0) this.checkpoints--;
  }

  /** Snapshot of the checkpoint storage, for persisting the index. */
  snapshot(): { blocks: Float64Array[]; checkpoints: number } {
    return { blocks: this.blocks, checkpoints: this.checkpoints };
  }

  /** Restore a persisted index. */
  static restore(blocks: Float64Array[], lineCount: number, indexedBytes: number): LineIndex {
    const idx = new LineIndex();
    // persisted blocks may be truncated to their used size; re-expand the last
    // one to full capacity so that tail appends can keep writing into it
    idx.blocks = blocks.map((b, i) => {
      if (i < blocks.length - 1 || b.length === CHUNK) return b;
      const full = new Float64Array(CHUNK);
      full.set(b);
      return full;
    });
    idx.lineCount = lineCount;
    idx.indexedBytes = indexedBytes;
    idx.checkpoints = lineCount === 0 ? 0 : Math.floor((lineCount - 1) / STRIDE) + 1;
    return idx;
  }
}

export interface LineSpan {
  /** Absolute byte offset of the first byte of the line. */
  offset: number;
  /** Line content without trailing \r or \n, truncated to MAX_SCAN_LINE bytes. */
  text: string;
}

/** Longest line text the scanner keeps in memory / emits; the rest is dropped. */
export const MAX_SCAN_LINE = 1 << 20; // 1 MiB

/**
 * Incremental newline scanner. Feed it sequential chunks of the file; it
 * emits complete lines and buffers partial trailing data between chunks.
 * Memory is bounded: a pathological line longer than MAX_SCAN_LINE is
 * emitted truncated, while byte offsets stay exact.
 *
 * Callers may reuse the chunk buffer between push() calls — any partial
 * line data is copied out.
 */
export class LineScanner {
  /** Buffered head of the current partial line (capped at MAX_SCAN_LINE). */
  private head: Buffer | null = null;
  private headStored = 0;
  /** Total bytes seen in the current partial line (may exceed headStored). */
  private headLen = 0;
  private headOffset = 0;
  /** Absolute offset of the next byte to be fed. */
  consumed = 0;

  constructor(startOffset = 0) {
    this.consumed = startOffset;
  }

  private appendHead(seg: Buffer): void {
    if (this.headStored < MAX_SCAN_LINE && seg.length > 0) {
      if (this.head === null) this.head = Buffer.allocUnsafe(Math.min(MAX_SCAN_LINE, 65536));
      const want = Math.min(seg.length, MAX_SCAN_LINE - this.headStored);
      if (this.headStored + want > this.head.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_SCAN_LINE, Math.max(this.head.length * 2, this.headStored + want)));
        this.head.copy(grown, 0, 0, this.headStored);
        this.head = grown;
      }
      seg.copy(this.head, this.headStored, 0, want);
      this.headStored += want;
    }
    this.headLen += seg.length;
  }

  private emitHead(onLine: (span: LineSpan) => void): void {
    let end = this.headStored;
    // strip trailing \r only when nothing was truncated away after it
    if (this.headLen === this.headStored && end > 0 && this.head![end - 1] === 0x0d) end--;
    onLine({ offset: this.headOffset, text: this.head!.toString('utf8', 0, end) });
    this.headLen = 0;
    this.headStored = 0;
  }

  /** Feed the next sequential chunk; invokes onLine for each complete line found. */
  push(chunk: Buffer, onLine: (span: LineSpan) => void): void {
    const base = this.consumed;
    this.consumed += chunk.length;
    let from = 0;
    while (from < chunk.length) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl === -1) {
        const seg = chunk.subarray(from);
        if (this.headLen === 0) this.headOffset = base + from;
        this.appendHead(seg);
        return;
      }
      if (this.headLen > 0) {
        this.appendHead(chunk.subarray(from, nl));
        this.emitHead(onLine);
      } else {
        let end = nl;
        if (end > from && chunk[end - 1] === 0x0d) end--;
        let text: string;
        if (end - from > MAX_SCAN_LINE) text = chunk.toString('utf8', from, from + MAX_SCAN_LINE);
        else text = chunk.toString('utf8', from, end);
        onLine({ offset: base + from, text });
      }
      from = nl + 1;
    }
  }

  /** Flush a trailing line that has no final newline (call at EOF). */
  flush(onLine: (span: LineSpan) => void): void {
    if (this.headLen > 0) this.emitHead(onLine);
  }

  /** True if there is buffered partial-line data awaiting a newline. */
  get hasPartial(): boolean {
    return this.headLen > 0;
  }
}
