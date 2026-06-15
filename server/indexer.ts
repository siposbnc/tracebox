import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type ParsedLine } from './parsers.ts';
import { type QueryNode } from './queryParser.ts';
import { compileQuery } from './queryCompiler.ts';

export interface LineMeta {
  lineNo: number;
  ts: number | null;
  level: string | null;
}

export interface HistogramBucket {
  start: number;
  counts: Record<string, number>;
  total: number;
}

export interface Histogram {
  minTs: number;
  maxTs: number;
  bucketMs: number;
  buckets: HistogramBucket[];
  /** Lines that had no parseable timestamp (not shown in the chart). */
  withoutTs: number;
}

/**
 * SQLite-backed search index for one log file. Stores per-line metadata
 * (timestamp, level), an FTS5 full-text index, and a key/value fields table.
 * Search results are materialized into a `results` table for O(1) paging.
 */
export class IndexStore {
  private db: DatabaseSync;
  private insLine!: StatementSync;
  private insFts!: StatementSync;
  private insField!: StatementSync;
  private inTx = false;

  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA cache_size = -65536;
    `);
  }

  /** True if this database already contains a finished index for the given file fingerprint. */
  isReusable(fingerprint: string): boolean {
    try {
      const row = this.db
        .prepare(`SELECT value FROM meta WHERE key = 'fingerprint'`)
        .get() as { value: string } | undefined;
      const done = this.db.prepare(`SELECT value FROM meta WHERE key = 'complete'`).get() as
        | { value: string }
        | undefined;
      return row?.value === fingerprint && done?.value === '1';
    } catch {
      return false;
    }
  }

  createSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS lines;
      DROP TABLE IF EXISTS fields;
      DROP TABLE IF EXISTS fts;
      DROP TABLE IF EXISTS results;
      DROP TABLE IF EXISTS checkpoints;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE lines(line_no INTEGER PRIMARY KEY, ts INTEGER, level TEXT);
      CREATE TABLE fields(line_no INTEGER NOT NULL, key TEXT NOT NULL, value TEXT COLLATE NOCASE, num REAL);
      CREATE VIRTUAL TABLE fts USING fts5(content, content='', contentless_delete=1);
      CREATE TABLE results(seq INTEGER PRIMARY KEY AUTOINCREMENT, line_no INTEGER NOT NULL);
      CREATE TABLE checkpoints(block INTEGER PRIMARY KEY, data BLOB NOT NULL);
    `);
    this.prepareInserts();
  }

  /** Build the per-field indexes; called once after the initial bulk load (much faster than indexing incrementally). */
  createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fields_kv ON fields(key, value);
      CREATE INDEX IF NOT EXISTS idx_fields_kn ON fields(key, num) WHERE num IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_lines_ts ON lines(ts, level) WHERE ts IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_lines_level ON lines(level) WHERE level IS NOT NULL;
    `);
  }

  private prepareInserts(): void {
    this.insLine = this.db.prepare(`INSERT OR REPLACE INTO lines(line_no, ts, level) VALUES (?, ?, ?)`);
    this.insFts = this.db.prepare(`INSERT INTO fts(rowid, content) VALUES (?, ?)`);
    this.insField = this.db.prepare(`INSERT INTO fields(line_no, key, value, num) VALUES (?, ?, ?, ?)`);
  }

  /** Re-prepare statements when opening an existing database for reuse. */
  prepareForAppend(): void {
    this.prepareInserts();
  }

  begin(): void {
    if (!this.inTx) {
      this.db.exec('BEGIN');
      this.inTx = true;
    }
  }

  commit(): void {
    if (this.inTx) {
      this.db.exec('COMMIT');
      this.inTx = false;
    }
  }

  addLine(lineNo: number, raw: string, parsed: ParsedLine): void {
    this.insLine.run(lineNo, parsed.ts, parsed.level);
    this.insFts.run(lineNo, raw);
    if (parsed.fields) {
      for (const [key, value] of Object.entries(parsed.fields)) {
        const num = value !== '' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ? Number(value) : null;
        this.insField.run(lineNo, key, value, num);
      }
    }
  }

  /** Remove a line that is being re-indexed (a previously unterminated tail line that grew). */
  removeLine(lineNo: number): void {
    this.db.prepare(`DELETE FROM lines WHERE line_no = ?`).run(lineNo);
    this.db.prepare(`DELETE FROM fields WHERE line_no = ?`).run(lineNo);
    this.db.prepare(`DELETE FROM fts WHERE rowid = ?`).run(lineNo);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)`).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  saveCheckpoints(blocks: Float64Array[], used: number): void {
    this.db.prepare(`DELETE FROM checkpoints`).run();
    const ins = this.db.prepare(`INSERT INTO checkpoints(block, data) VALUES (?, ?)`);
    this.db.exec('BEGIN');
    for (let i = 0; i < blocks.length; i++) {
      const countInBlock = Math.min(used - i * blocks[i].length, blocks[i].length);
      if (countInBlock <= 0) break;
      const view = blocks[i].subarray(0, countInBlock);
      ins.run(i, Buffer.from(view.buffer, view.byteOffset, view.byteLength));
    }
    this.db.exec('COMMIT');
  }

  loadCheckpoints(): Float64Array[] {
    const rows = this.db
      .prepare(`SELECT block, data FROM checkpoints ORDER BY block`)
      .all() as { block: number; data: Uint8Array }[];
    return rows.map((r) => {
      const buf = Buffer.from(r.data);
      return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    });
  }

  // -------------------------------------------------------------------------
  // Search

  /**
   * Materialize the result set for a query. Returns the total match count.
   * When `fromLineNo` is given, appends matches among lines >= fromLineNo to
   * the existing result set (incremental tail search) instead of resetting.
   */
  runSearch(node: QueryNode, fromLineNo?: number): number {
    const { where, params } = compileQuery(node);
    if (fromLineNo === undefined) {
      this.db.exec(`DELETE FROM results; DELETE FROM sqlite_sequence WHERE name = 'results';`);
      this.db
        .prepare(`INSERT INTO results(line_no) SELECT l.line_no FROM lines l WHERE ${where} ORDER BY l.line_no`)
        .run(...params);
    } else {
      this.db
        .prepare(
          `INSERT INTO results(line_no) SELECT l.line_no FROM lines l WHERE l.line_no >= ? AND ${where} ORDER BY l.line_no`,
        )
        .run(fromLineNo, ...params);
    }
    return this.resultCount();
  }

  /** Drop result rows for lines >= lineNo (before re-running an incremental search over them). */
  pruneResultsFrom(lineNo: number): void {
    this.db.prepare(`DELETE FROM results WHERE line_no >= ?`).run(lineNo);
  }

  resultCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM results`).get() as { n: number };
    return row.n;
  }

  /** Page through materialized results: returns line numbers for [offset, offset+limit). */
  resultPage(offset: number, limit: number): number[] {
    const rows = this.db
      .prepare(`SELECT line_no FROM results ORDER BY seq LIMIT ? OFFSET ?`)
      .all(limit, offset) as { line_no: number }[];
    return rows.map((r) => r.line_no);
  }

  /** Iterate all result line numbers in order (for export). */
  *iterateResults(batch = 10_000): Generator<number[]> {
    let offset = 0;
    for (;;) {
      const page = this.resultPage(offset, batch);
      if (page.length === 0) return;
      yield page;
      offset += page.length;
    }
  }

  /** Fetch ts/level metadata for a set of lines. */
  lineMeta(lineNos: number[]): Map<number, LineMeta> {
    const out = new Map<number, LineMeta>();
    if (lineNos.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT line_no, ts, level FROM lines WHERE line_no IN (${lineNos.map(() => '?').join(',')})`,
    );
    for (const row of stmt.all(...lineNos) as { line_no: number; ts: number | null; level: string | null }[]) {
      out.set(row.line_no, { lineNo: row.line_no, ts: row.ts, level: row.level });
    }
    return out;
  }

  /** Structured fields for one line. */
  lineFields(lineNo: number): { key: string; value: string }[] {
    return this.db
      .prepare(`SELECT key, value FROM fields WHERE line_no = ? ORDER BY rowid`)
      .all(lineNo) as { key: string; value: string }[];
  }

  // -------------------------------------------------------------------------
  // Aggregations

  /**
   * Histogram of log volume over time, optionally restricted to the current
   * result set. Buckets are split per level.
   */
  histogram(filtered: boolean, bucketCount = 100): Histogram | null {
    const from = filtered ? `results r JOIN lines l ON l.line_no = r.line_no` : `lines l`;
    const range = this.db
      .prepare(`SELECT MIN(l.ts) AS lo, MAX(l.ts) AS hi, COUNT(*) AS n FROM ${from} WHERE l.ts IS NOT NULL`)
      .get() as { lo: number | null; hi: number | null; n: number };
    if (range.lo === null || range.hi === null) return null;

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get() as { n: number };
    const span = Math.max(1, range.hi - range.lo);
    const bucketMs = Math.max(1, Math.ceil(span / bucketCount));

    const rows = this.db
      .prepare(
        `SELECT CAST((l.ts - ?) / ? AS INTEGER) AS b, COALESCE(l.level, 'NONE') AS level, COUNT(*) AS n
         FROM ${from} WHERE l.ts IS NOT NULL GROUP BY b, level`,
      )
      .all(range.lo, bucketMs) as { b: number; level: string; n: number }[];

    const buckets = new Map<number, HistogramBucket>();
    for (const row of rows) {
      let bucket = buckets.get(row.b);
      if (!bucket) {
        bucket = { start: range.lo + row.b * bucketMs, counts: {}, total: 0 };
        buckets.set(row.b, bucket);
      }
      bucket.counts[row.level] = row.n;
      bucket.total += row.n;
    }

    return {
      minTs: range.lo,
      maxTs: range.hi,
      bucketMs,
      buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      withoutTs: totalRow.n - range.n,
    };
  }

  /** Per-level counts over the whole file. */
  levelCounts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT COALESCE(level, 'NONE') AS level, COUNT(*) AS n FROM lines GROUP BY level`)
      .all() as { level: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.level, r.n]));
  }

  /** Distinct field names with occurrence counts (for autocomplete / sidebar). */
  fieldNames(limit = 200): { key: string; count: number }[] {
    return this.db
      .prepare(`SELECT key, COUNT(*) AS count FROM fields GROUP BY key ORDER BY count DESC LIMIT ?`)
      .all(limit) as { key: string; count: number }[];
  }

  close(): void {
    try {
      if (this.inTx) this.db.exec('COMMIT');
    } catch {}
    try {
      this.db.close();
    } catch {}
  }
}
