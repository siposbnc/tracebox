import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, watchFile, unwatchFile, type StatWatcher } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LineIndex, LineScanner, type LineSpan } from './lineIndex.ts';
import { LineReader } from './reader.ts';
import { detectFormat, RawParser, type LogParser } from './parsers.ts';
import { IndexStore } from './indexer.ts';
import { parseQuery, type QueryNode } from './queryParser.ts';

const READ_CHUNK = 4 * 1024 * 1024;
const BATCH_LINES = 20_000;
const DISPLAY_TEXT_CAP = 4096;

export interface RowData {
  lineNo: number;
  text: string;
  ts: number | null;
  level: string | null;
  truncated: boolean;
}

export interface SessionStatus {
  id: string;
  file: string;
  fileSize: number;
  phase: 'indexing' | 'finalizing' | 'ready' | 'error';
  bytesIndexed: number;
  lineCount: number;
  format: string;
  reusedIndex: boolean;
  error: string | null;
  tail: boolean;
  levelCounts: Record<string, number>;
  fieldNames: { key: string; count: number }[];
  search: { query: string; total: number; durationMs: number } | null;
}

export function indexCacheDir(): string {
  const dir = path.join(tmpdir(), 'tracebox-index');
  mkdirSync(dir, { recursive: true });
  return dir;
}

let nextId = 1;

/**
 * One open log file: owns the sparse line index, the SQLite search index,
 * background indexing, the active search, and tail-follow state.
 */
export class LogSession extends EventEmitter {
  readonly id: string;
  readonly file: string;
  private index = new LineIndex();
  private store: IndexStore;
  private reader: LineReader;
  private parser: LogParser = new RawParser();

  phase: SessionStatus['phase'] = 'indexing';
  error: string | null = null;
  fileSize = 0;
  reusedIndex = false;
  private closed = false;

  private levelCounts: Record<string, number> = {};
  private fieldCounts = new Map<string, number>();

  /** Set while the last indexed line had no trailing newline (its start offset). */
  private partialTail: { offset: number; lineNo: number } | null = null;

  // search state
  private searchQuery = '';
  private searchAst: QueryNode | null = null;
  private searchTotal = 0;
  private searchDurationMs = 0;
  /** Lines below this number have been through the current search. */
  private searchedUpTo = 0;

  // tail state
  tail = false;
  private watcher: StatWatcher | null = null;
  private appendRunning = false;
  private appendQueued = false;

  constructor(file: string) {
    super();
    this.id = String(nextId++);
    this.file = path.resolve(file);
    const st = statSync(this.file);
    if (!st.isFile()) throw new Error('Not a file');
    this.fileSize = st.size;
    const hash = createHash('sha1').update(this.file.toLowerCase()).digest('hex').slice(0, 16);
    const dbPath = path.join(indexCacheDir(), `${hash}.db`);
    this.store = new IndexStore(dbPath);
    this.reader = new LineReader(this.file, this.index);
  }

  private fingerprint(size: number, mtimeMs: number): string {
    return `${this.file.toLowerCase()}|${size}|${Math.round(mtimeMs)}`;
  }

  async start(): Promise<void> {
    await this.reader.openFile();
    const st = statSync(this.file);
    const fp = this.fingerprint(st.size, st.mtimeMs);

    if (this.store.isReusable(fp)) {
      try {
        await this.restoreFromStore();
        this.reusedIndex = true;
        this.phase = 'ready';
        this.emit('done');
        return;
      } catch {
        // fall through to full rebuild
      }
    }
    this.store.createSchema();
    void this.indexLoop().catch((err: unknown) => {
      this.phase = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.emit('error-event', this.error);
    });
  }

  private async restoreFromStore(): Promise<void> {
    const lineCount = Number(this.store.getMeta('lineCount'));
    const indexedBytes = Number(this.store.getMeta('indexedBytes'));
    if (!Number.isFinite(lineCount) || !Number.isFinite(indexedBytes)) throw new Error('bad meta');
    const oldReader = this.reader;
    this.index = LineIndex.restore(this.store.loadCheckpoints(), lineCount, indexedBytes);
    this.reader = new LineReader(this.file, this.index);
    await this.reader.openFile();
    await oldReader.close();
    this.levelCounts = JSON.parse(this.store.getMeta('levelCounts') ?? '{}');
    this.fieldCounts = new Map(Object.entries(JSON.parse(this.store.getMeta('fieldCounts') ?? '{}')));
    const partial = this.store.getMeta('partialTail');
    this.partialTail = partial ? JSON.parse(partial) : null;
    // re-detect the parser on a sample (detection is deterministic; avoids
    // having to serialize regexes into the index database)
    const sample = await this.reader.readLines(0, Math.min(100, lineCount));
    this.parser = sample.length > 0 ? detectFormat(sample) : new RawParser();
    this.store.prepareForAppend();
  }

  // ---------------------------------------------------------------------------
  // Initial background indexing

  private async indexLoop(): Promise<void> {
    const fd = await open(this.file, 'r');
    try {
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      const scanner = new LineScanner(0);
      let pos = 0;
      let parserChosen = false;
      let batch: LineSpan[] = [];
      let lastProgress = 0;

      const flushBatch = (): void => {
        if (batch.length === 0) return;
        if (!parserChosen) {
          this.parser = detectFormat(batch.slice(0, 100).map((s) => s.text));
          parserChosen = true;
        }
        this.store.begin();
        for (const span of batch) {
          const lineNo = this.index.lineCount;
          this.index.addLine(span.offset);
          this.ingestLine(lineNo, span.text);
        }
        this.store.commit();
        batch = [];
      };

      for (;;) {
        if (this.closed) return;
        const { bytesRead } = await fd.read(buf, 0, READ_CHUNK, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        scanner.push(buf.subarray(0, bytesRead), (span) => batch.push(span));
        if (batch.length >= BATCH_LINES) flushBatch();
        const now = Date.now();
        if (now - lastProgress > 150) {
          lastProgress = now;
          this.index.indexedBytes = scanner.consumed;
          this.emit('progress');
        }
      }

      // trailing line without newline
      let partialSpan: LineSpan | null = null;
      scanner.flush((span) => {
        partialSpan = span;
        batch.push(span);
      });
      flushBatch();
      this.index.indexedBytes = scanner.consumed;
      if (partialSpan !== null) {
        const span: LineSpan = partialSpan;
        this.partialTail = { offset: span.offset, lineNo: this.index.lineCount - 1 };
      } else {
        this.partialTail = null;
      }

      this.phase = 'finalizing';
      this.emit('progress');
      await new Promise((r) => setImmediate(r)); // let the progress event flush
      this.store.createIndexes();
      this.persistMeta(pos);
      this.phase = 'ready';
      this.emit('done');
    } finally {
      await fd.close();
    }
  }

  private ingestLine(lineNo: number, text: string): void {
    const parsed = this.parser.parse(text);
    this.store.addLine(lineNo, text, parsed);
    const lv = parsed.level ?? 'NONE';
    this.levelCounts[lv] = (this.levelCounts[lv] ?? 0) + 1;
    if (parsed.fields) {
      for (const key of Object.keys(parsed.fields)) {
        this.fieldCounts.set(key, (this.fieldCounts.get(key) ?? 0) + 1);
      }
    }
  }

  private persistMeta(sizeAtIndex: number): void {
    const st = statSync(this.file);
    const snap = this.index.snapshot();
    this.store.saveCheckpoints(snap.blocks, snap.checkpoints);
    this.store.setMeta('fingerprint', this.fingerprint(st.size, st.mtimeMs));
    this.store.setMeta('lineCount', String(this.index.lineCount));
    this.store.setMeta('indexedBytes', String(this.index.indexedBytes));
    this.store.setMeta('format', this.parser.name);
    this.store.setMeta('levelCounts', JSON.stringify(this.levelCounts));
    this.store.setMeta('fieldCounts', JSON.stringify(Object.fromEntries(this.fieldCounts)));
    this.store.setMeta('partialTail', this.partialTail ? JSON.stringify(this.partialTail) : '');
    this.store.setMeta('complete', '1');
    this.fileSize = Math.max(this.fileSize, sizeAtIndex);
  }

  // ---------------------------------------------------------------------------
  // Search

  setSearch(query: string): { total: number; durationMs: number } {
    const trimmed = query.trim();
    if (trimmed === '') {
      this.searchQuery = '';
      this.searchAst = null;
      this.searchTotal = 0;
      this.searchDurationMs = 0;
      return { total: this.index.lineCount, durationMs: 0 };
    }
    const ast = parseQuery(trimmed);
    const t0 = performance.now();
    const total = this.store.runSearch(ast);
    this.searchDurationMs = Math.round(performance.now() - t0);
    this.searchQuery = trimmed;
    this.searchAst = ast;
    this.searchTotal = total;
    this.searchedUpTo = this.index.lineCount;
    return { total, durationMs: this.searchDurationMs };
  }

  get hasSearch(): boolean {
    return this.searchAst !== null;
  }

  /** Total rows in the current view (search results or whole file). */
  get viewTotal(): number {
    return this.hasSearch ? this.searchTotal : this.index.lineCount;
  }

  // ---------------------------------------------------------------------------
  // Row fetching

  async getRows(offset: number, limit: number, order: 'asc' | 'desc' = 'asc'): Promise<RowData[]> {
    limit = Math.min(Math.max(limit, 0), 2000);
    offset = Math.max(0, offset);
    const total = this.viewTotal;
    const count = Math.min(limit, Math.max(0, total - offset));
    if (count === 0) return [];
    // For newest-first display we read the mirrored ascending range (cheap,
    // contiguous file reads) and reverse it — the file is never reordered.
    const fetchOffset = order === 'desc' ? total - offset - count : offset;
    let lineNos: number[];
    if (this.hasSearch) {
      lineNos = this.store.resultPage(fetchOffset, count);
    } else {
      lineNos = Array.from({ length: count }, (_, i) => fetchOffset + i);
    }
    const rows = await this.readRows(lineNos);
    if (order === 'desc') rows.reverse();
    return rows;
  }

  private async readRows(lineNos: number[]): Promise<RowData[]> {
    if (lineNos.length === 0) return [];
    const meta = this.store.lineMeta(lineNos);
    const rows: RowData[] = [];
    // group into contiguous runs to batch file reads
    let runStart = 0;
    while (runStart < lineNos.length) {
      let runEnd = runStart + 1;
      while (runEnd < lineNos.length && lineNos[runEnd] === lineNos[runEnd - 1] + 1) runEnd++;
      const texts = await this.reader.readLines(lineNos[runStart], runEnd - runStart);
      for (let i = runStart; i < runEnd; i++) {
        const lineNo = lineNos[i];
        const text = texts[i - runStart] ?? '';
        const m = meta.get(lineNo);
        rows.push({
          lineNo,
          text: text.length > DISPLAY_TEXT_CAP ? text.slice(0, DISPLAY_TEXT_CAP) : text,
          truncated: text.length > DISPLAY_TEXT_CAP,
          ts: m?.ts ?? null,
          level: m?.level ?? null,
        });
      }
      runStart = runEnd;
    }
    return rows;
  }

  async getDetail(lineNo: number): Promise<{
    lineNo: number;
    raw: string;
    ts: number | null;
    level: string | null;
    fields: { key: string; value: string }[];
  } | null> {
    if (lineNo < 0 || lineNo >= this.index.lineCount) return null;
    const raw = await this.reader.readLine(lineNo);
    const meta = this.store.lineMeta([lineNo]).get(lineNo);
    const fields = this.store.lineFields(lineNo);
    return { lineNo, raw, ts: meta?.ts ?? null, level: meta?.level ?? null, fields };
  }

  histogram(): ReturnType<IndexStore['histogram']> {
    return this.store.histogram(this.hasSearch);
  }

  // ---------------------------------------------------------------------------
  // Tail (follow appended data)

  private readonly watchListener = (): void => {
    void this.checkAppend();
  };

  setTail(on: boolean): void {
    if (on === this.tail) return;
    this.tail = on;
    if (on) {
      this.watcher = watchFile(this.file, { interval: 400 }, this.watchListener);
      void this.checkAppend();
    } else if (this.watcher) {
      unwatchFile(this.file, this.watchListener);
      this.watcher = null;
    }
  }

  /** Manually poll the file for appended or truncated data — the same work tail
   * does on a watch event, triggered on demand by the refresh button. */
  async refresh(): Promise<void> {
    await this.checkAppend();
  }

  private async checkAppend(): Promise<void> {
    if (this.phase !== 'ready' || this.closed) return;
    if (this.appendRunning) {
      this.appendQueued = true;
      return;
    }
    this.appendRunning = true;
    try {
      do {
        this.appendQueued = false;
        await this.appendOnce();
      } while (this.appendQueued);
    } catch (err) {
      this.emit('error-event', err instanceof Error ? err.message : String(err));
    } finally {
      this.appendRunning = false;
    }
  }

  private async appendOnce(): Promise<void> {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      return; // file temporarily gone (rotation) — keep waiting
    }
    if (st.size < this.index.endOffset) {
      // file was truncated/rotated: signal the UI to reopen
      this.emit('truncated');
      return;
    }

    let startOffset = this.index.endOffset;
    const firstNewLine = this.partialTail ? this.partialTail.lineNo : this.index.lineCount;

    // a previously unterminated trailing line may have been extended: re-index it
    if (this.partialTail) {
      startOffset = this.partialTail.offset;
      this.index.removeLastLine();
      this.store.removeLine(this.partialTail.lineNo);
      this.partialTail = null;
    }
    if (st.size <= startOffset) {
      this.index.indexedBytes = startOffset;
      return;
    }

    const fd: FileHandle = await open(this.file, 'r');
    try {
      const scanner = new LineScanner(startOffset);
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      let pos = startOffset;
      const endTarget = st.size;
      let batch: LineSpan[] = [];

      const flushBatch = (): void => {
        if (batch.length === 0) return;
        this.store.begin();
        for (const span of batch) {
          const lineNo = this.index.lineCount;
          this.index.addLine(span.offset);
          this.ingestLine(lineNo, span.text);
        }
        this.store.commit();
        batch = [];
      };

      while (pos < endTarget) {
        const want = Math.min(READ_CHUNK, endTarget - pos);
        const { bytesRead } = await fd.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        scanner.push(buf.subarray(0, bytesRead), (span) => batch.push(span));
        if (batch.length >= BATCH_LINES) flushBatch();
      }
      // keep the unterminated tail visible: index it, remember to redo it later
      let partialSpan: LineSpan | null = null;
      scanner.flush((span) => {
        partialSpan = span;
        batch.push(span);
      });
      flushBatch();
      this.index.indexedBytes = pos;
      if (partialSpan !== null) {
        const span: LineSpan = partialSpan;
        this.partialTail = { offset: span.offset, lineNo: this.index.lineCount - 1 };
      }
      this.fileSize = st.size;

      // extend the active search over the new lines
      if (this.searchAst !== null && this.index.lineCount > firstNewLine) {
        this.store.pruneResultsFrom(firstNewLine);
        this.searchTotal = this.store.runSearch(this.searchAst, firstNewLine);
        this.searchedUpTo = this.index.lineCount;
      }
      this.persistMeta(st.size);
      this.emit('append');
    } finally {
      await fd.close();
    }
  }

  // ---------------------------------------------------------------------------

  status(): SessionStatus {
    return {
      id: this.id,
      file: this.file,
      fileSize: this.fileSize,
      phase: this.phase,
      bytesIndexed: Math.min(this.index.indexedBytes, this.fileSize),
      lineCount: this.index.lineCount,
      format: this.parser.name,
      reusedIndex: this.reusedIndex,
      error: this.error,
      tail: this.tail,
      levelCounts: this.levelCounts,
      fieldNames: [...this.fieldCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([key, count]) => ({ key, count })),
      search: this.searchAst
        ? { query: this.searchQuery, total: this.searchTotal, durationMs: this.searchDurationMs }
        : null,
    };
  }

  get lineCount(): number {
    return this.index.lineCount;
  }

  iterateResultRows(): Generator<number[]> {
    return this.store.iterateResults();
  }

  async readRowsForExport(lineNos: number[]): Promise<RowData[]> {
    return this.readRows(lineNos);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.setTail(false);
    this.store.close();
    await this.reader.close();
  }
}
