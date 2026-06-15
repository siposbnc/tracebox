import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, watchFile, unwatchFile, type StatWatcher } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LineIndex, LineScanner, type LineSpan } from './lineIndex.ts';
import { LineReader } from './reader.ts';
import { detectFormat, RawParser, templateOf, type LogParser } from './parsers.ts';
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
  /** Set in highlight mode: whether this (unfiltered) line is a search hit. */
  match?: boolean;
  /** Physical lines in this record when multi-line grouping is on (1 = no continuations). */
  span?: number;
  /** Selected field values for the columnar view (only the requested columns). */
  cols?: Record<string, string>;
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
  /** Number of logical (multi-line-grouped) records; 0 until indexing finishes. */
  recordCount: number;
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

  /** Head (record-start) line number of the record currently being extended. */
  private lastHead = 0;

  /** Log templates (clustering): pattern → id + occurrence count, over head lines. */
  private templates = new Map<string, { id: number; count: number }>();
  private lastTemplateId = 0;

  // search state
  private searchQuery = '';
  private searchAst: QueryNode | null = null;
  private searchTotal = 0;
  private searchDurationMs = 0;
  /** Whether the materialized result set holds record heads (grouped) or physical lines. */
  private searchGrouped = false;
  /** Active cluster drill-down (a template id), ANDed with any text query. */
  private templateId: number | null = null;
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
    this.lastHead = Number(this.store.getMeta('lastHead') ?? 0);
    const tpls = this.store.loadTemplates();
    this.templates = new Map(tpls.map((t) => [t.pattern, { id: t.id, count: t.count }]));
    this.lastTemplateId = tpls.reduce((max, t) => Math.max(max, t.id), 0);
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
      this.store.buildRecords(0, this.index.lineCount);
      this.persistTemplates();
      this.persistMeta(pos);
      this.phase = 'ready';
      this.emit('done');
    } finally {
      await fd.close();
    }
  }

  private ingestLine(lineNo: number, text: string): void {
    const parsed = this.parser.parse(text);
    // the first line always starts a record; otherwise the parser decides whether
    // this line begins a new record or continues the previous one (stack frames etc.)
    const head = lineNo === 0 || this.parser.startsRecord(text) ? lineNo : this.lastHead;
    // only head lines get a cluster template (continuation lines would be noise)
    let tmpl: number | null = null;
    if (head === lineNo) {
      this.lastHead = lineNo;
      tmpl = this.templateIdFor(text);
    }
    this.store.addLine(lineNo, text, parsed, head, tmpl);
    const lv = parsed.level ?? 'NONE';
    this.levelCounts[lv] = (this.levelCounts[lv] ?? 0) + 1;
    if (parsed.fields) {
      for (const key of Object.keys(parsed.fields)) {
        this.fieldCounts.set(key, (this.fieldCounts.get(key) ?? 0) + 1);
      }
    }
  }

  /** Map a line to its template id, registering a new pattern on first sight. */
  private templateIdFor(text: string): number {
    const pattern = templateOf(text);
    let entry = this.templates.get(pattern);
    if (!entry) {
      entry = { id: ++this.lastTemplateId, count: 0 };
      this.templates.set(pattern, entry);
    }
    entry.count++;
    return entry.id;
  }

  private decrementTemplate(id: number): void {
    for (const entry of this.templates.values()) {
      if (entry.id === id) {
        entry.count = Math.max(0, entry.count - 1);
        return;
      }
    }
  }

  private persistTemplates(): void {
    this.store.saveTemplates(
      [...this.templates.entries()].map(([pattern, e]) => ({ id: e.id, pattern, count: e.count })),
    );
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
    this.store.setMeta('lastHead', String(this.lastHead));
    this.store.setMeta('complete', '1');
    this.fileSize = Math.max(this.fileSize, sizeAtIndex);
  }

  // ---------------------------------------------------------------------------
  // Search

  setSearch(query: string, grouped = false, templateId: number | null = null): { total: number; durationMs: number } {
    const trimmed = query.trim();
    this.searchGrouped = grouped;
    this.templateId = templateId;
    if (trimmed === '' && templateId === null) {
      this.searchQuery = '';
      this.searchAst = null;
      this.searchTotal = 0;
      this.searchDurationMs = 0;
      return { total: grouped ? this.store.recordCount() : this.index.lineCount, durationMs: 0 };
    }
    // a template-only filter still needs an AST; "all" matches every line
    const ast: QueryNode = trimmed === '' ? { type: 'all' } : parseQuery(trimmed);
    const t0 = performance.now();
    const total = this.store.runSearch(ast, grouped, undefined, templateId);
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

  /** Number of logical records (multi-line groups) in the file. */
  recordCount(): number {
    return this.store.recordCount();
  }

  /** Rows in the current view for a given grouping mode (records vs physical lines). */
  displayTotal(grouped: boolean): number {
    if (this.hasSearch) return this.searchTotal;
    return grouped ? this.store.recordCount() : this.index.lineCount;
  }

  // ---------------------------------------------------------------------------
  // Row fetching

  async getRows(
    offset: number,
    limit: number,
    order: 'asc' | 'desc' = 'asc',
    highlight = false,
    grouped = false,
    columns?: string[],
  ): Promise<RowData[]> {
    limit = Math.min(Math.max(limit, 0), 2000);
    offset = Math.max(0, offset);
    // Highlight mode shows the whole file (unfiltered) and flags which lines are
    // search hits, instead of hiding the non-matching ones.
    const filtered = this.hasSearch && !highlight;
    const total = filtered ? this.searchTotal : grouped ? this.store.recordCount() : this.index.lineCount;
    const count = Math.min(limit, Math.max(0, total - offset));
    if (count === 0) return [];
    // For newest-first display we read the mirrored ascending range (cheap,
    // contiguous file reads) and reverse it — the file is never reordered.
    const fetchOffset = order === 'desc' ? total - offset - count : offset;

    let rows: RowData[];
    if (grouped) {
      // one row per record; the row text is the record's head line, with span
      // telling the UI how many physical lines (continuations) it covers
      const recs = filtered
        ? this.store.resultRecordPage(fetchOffset, count)
        : this.store.recordPage(fetchOffset, count);
      rows = await this.readRows(recs.map((r) => r.head));
      const spanByHead = new Map(recs.map((r) => [r.head, r.span]));
      for (const row of rows) row.span = spanByHead.get(row.lineNo) ?? 1;
    } else {
      const lineNos = filtered
        ? this.store.resultPage(fetchOffset, count)
        : Array.from({ length: count }, (_, i) => fetchOffset + i);
      rows = await this.readRows(lineNos);
    }

    if (highlight && this.hasSearch) {
      const hits = this.store.matchingLines(rows.map((r) => r.lineNo));
      for (const row of rows) row.match = hits.has(row.lineNo);
    }
    if (columns && columns.length > 0) {
      const vals = this.store.fieldValues(rows.map((r) => r.lineNo), columns);
      for (const row of rows) row.cols = vals.get(row.lineNo) ?? {};
    }
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
    record?: { span: number; text: string };
  } | null> {
    if (lineNo < 0 || lineNo >= this.index.lineCount) return null;
    const raw = await this.reader.readLine(lineNo);
    const meta = this.store.lineMeta([lineNo]).get(lineNo);
    const fields = this.store.lineFields(lineNo);
    // if this line heads a multi-line record, include the full record text
    const span = this.store.spanOf(lineNo);
    let record: { span: number; text: string } | undefined;
    if (span > 1) {
      const texts = await this.reader.readLines(lineNo, span);
      record = { span, text: texts.join('\n') };
    }
    return { lineNo, raw, ts: meta?.ts ?? null, level: meta?.level ?? null, fields, record };
  }

  /**
   * Surrounding lines for one line (grep -C). Returns the contiguous range
   * [lineNo - before, lineNo + after] clamped to the file, plus which of those
   * lines are members of the current search result set (so the UI can mark the
   * hits within the window).
   */
  async getContext(
    lineNo: number,
    before: number,
    after: number,
  ): Promise<{ center: number; rows: RowData[]; matchLines: number[] }> {
    const total = this.index.lineCount;
    if (lineNo < 0 || lineNo >= total) return { center: lineNo, rows: [], matchLines: [] };
    before = Math.min(Math.max(before, 0), 1000);
    after = Math.min(Math.max(after, 0), 1000);
    const start = Math.max(0, lineNo - before);
    const end = Math.min(total - 1, lineNo + after);
    const lineNos = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    const rows = await this.readRows(lineNos);
    const matchLines = this.hasSearch ? [...this.store.matchingLines(lineNos)] : [];
    return { center: lineNo, rows, matchLines };
  }

  histogram(): ReturnType<IndexStore['histogram']> {
    return this.store.histogram(this.hasSearch);
  }

  /** Value breakdown for one field over the current view (search results, or the whole file). */
  facet(field: string, limit?: number): ReturnType<IndexStore['facet']> {
    return this.store.facet(field, this.hasSearch, limit);
  }

  /** Top log patterns (clusters) over the current view (search results, or the whole file). */
  clusters(limit?: number): ReturnType<IndexStore['clusters']> {
    return this.store.clusters(this.hasSearch, limit);
  }

  /**
   * Next/previous matching line relative to `after` (for "find next" in highlight
   * mode), plus its zero-based position in the current browse view so the UI can
   * scroll to it. Wraps around. Null when there is no active search.
   */
  nextMatch(after: number, dir: 1 | -1, grouped: boolean): { lineNo: number; viewIndex: number } | null {
    if (!this.hasSearch) return null;
    const lineNo = this.store.nextResult(after, dir);
    if (lineNo === null) return null;
    const viewIndex = grouped ? this.store.recordIndexOf(lineNo) : lineNo;
    return { lineNo, viewIndex };
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
      // revert the grouping head to the record before the partial line, so the
      // re-indexed line is re-grouped from scratch
      this.lastHead =
        this.partialTail.lineNo > 0 ? this.store.headOf(this.partialTail.lineNo - 1) : 0;
      // undo the template count for the line we're about to re-index
      const oldTmpl = this.store.tmplOf(this.partialTail.lineNo);
      if (oldTmpl !== null) this.decrementTemplate(oldTmpl);
      this.index.removeLastLine();
      this.store.removeLine(this.partialTail.lineNo);
      this.partialTail = null;
    }

    // the earliest record head whose span may change once we append
    const rebuildFrom = this.lastHead;
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

      // refresh the records table for the tail region affected by the append
      this.store.buildRecords(rebuildFrom, this.index.lineCount);
      this.persistTemplates();

      // extend the active search over the new lines. A grouped search keys off the
      // record head, so re-run it from the rebuilt region's head to catch records
      // whose continuation lines just arrived; an ungrouped one resumes by line.
      if (this.searchAst !== null && this.index.lineCount > firstNewLine) {
        const from = this.searchGrouped ? Math.min(firstNewLine, rebuildFrom) : firstNewLine;
        this.store.pruneResultsFrom(from);
        this.searchTotal = this.store.runSearch(this.searchAst, this.searchGrouped, from, this.templateId);
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
      recordCount: this.phase === 'ready' ? this.store.recordCount() : 0,
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

  /** Path to this file's on-disk index DB (used by the merged timeline). */
  get dbPath(): string {
    return this.store.dbPath;
  }

  iterateResultRows(): Generator<number[]> {
    return this.store.iterateResults();
  }

  async readRowsForExport(lineNos: number[]): Promise<RowData[]> {
    return this.readRows(lineNos);
  }

  /**
   * Plain-text of the current view's rows for the clipboard (one row per line),
   * in display order, capped at `limit` rows. For grouped rows this is the head
   * line; for the whole untruncated record use the detail panel.
   */
  async copyText(limit: number, order: 'asc' | 'desc' = 'asc', grouped = false): Promise<{ text: string; count: number; total: number }> {
    limit = Math.min(Math.max(limit, 1), 100_000);
    const rows = await this.getRows(0, limit, order, false, grouped);
    return { text: rows.map((r) => r.text).join('\n'), count: rows.length, total: this.displayTotal(grouped) };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.setTail(false);
    this.store.close();
    await this.reader.close();
  }
}
