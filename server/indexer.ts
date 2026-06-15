import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type ParsedLine } from './parsers.ts';
import { type QueryNode } from './queryParser.ts';
import { compileQuery } from './queryCompiler.ts';

/** Bumped when the on-disk schema changes so stale cached indexes are rebuilt. */
export const SCHEMA_VERSION = '4';

export interface LineMeta {
  lineNo: number;
  ts: number | null;
  level: string | null;
}

export interface RecordRef {
  /** Line number of the record's first (head) physical line. */
  head: number;
  /** Number of physical lines in the record (1 = no continuation lines). */
  span: number;
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

export interface Facet {
  field: string;
  /** Top values by count (descending), capped at the requested limit. */
  values: { value: string; count: number }[];
  /** Distinct values for the field across the current scope. */
  distinctCount: number;
  /** Lines in the current scope that have this field at all. */
  covered: number;
}

export interface Clusters {
  /** Top patterns by count (descending), capped at the requested limit. */
  patterns: { id: number; pattern: string; count: number }[];
  /** Distinct patterns across the current scope. */
  distinctCount: number;
  /** Records (head lines) counted. */
  covered: number;
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
      const schema = this.db.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get() as
        | { value: string }
        | undefined;
      return row?.value === fingerprint && done?.value === '1' && schema?.value === SCHEMA_VERSION;
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
      DROP TABLE IF EXISTS records;
      DROP TABLE IF EXISTS checkpoints;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE lines(line_no INTEGER PRIMARY KEY, ts INTEGER, level TEXT, head INTEGER, is_head INTEGER, tmpl INTEGER);
      CREATE TABLE fields(line_no INTEGER NOT NULL, key TEXT NOT NULL, value TEXT COLLATE NOCASE, num REAL);
      CREATE VIRTUAL TABLE fts USING fts5(content, content='', contentless_delete=1);
      CREATE TABLE results(seq INTEGER PRIMARY KEY AUTOINCREMENT, line_no INTEGER NOT NULL);
      CREATE INDEX idx_results_line ON results(line_no);
      CREATE TABLE records(rec_no INTEGER PRIMARY KEY AUTOINCREMENT, head INTEGER NOT NULL, span INTEGER NOT NULL);
      CREATE TABLE templates(id INTEGER PRIMARY KEY, pattern TEXT NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE checkpoints(block INTEGER PRIMARY KEY, data BLOB NOT NULL);
    `);
    this.setMeta('schemaVersion', SCHEMA_VERSION);
    this.prepareInserts();
  }

  /** Build the per-field indexes; called once after the initial bulk load (much faster than indexing incrementally). */
  createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fields_kv ON fields(key, value);
      CREATE INDEX IF NOT EXISTS idx_fields_kn ON fields(key, num) WHERE num IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fields_line ON fields(line_no);
      CREATE INDEX IF NOT EXISTS idx_lines_ts ON lines(ts, level) WHERE ts IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_lines_level ON lines(level) WHERE level IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_lines_heads ON lines(line_no) WHERE is_head = 1;
      CREATE INDEX IF NOT EXISTS idx_lines_tmpl ON lines(tmpl) WHERE tmpl IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_records_head ON records(head);
    `);
  }

  private prepareInserts(): void {
    this.insLine = this.db.prepare(
      `INSERT OR REPLACE INTO lines(line_no, ts, level, head, is_head, tmpl) VALUES (?, ?, ?, ?, ?, ?)`,
    );
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

  addLine(lineNo: number, raw: string, parsed: ParsedLine, head: number, tmpl: number | null): void {
    this.insLine.run(lineNo, parsed.ts, parsed.level, head, head === lineNo ? 1 : 0, tmpl);
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

  /** The template id of a line, or null (continuation lines and unset lines have none). */
  tmplOf(lineNo: number): number | null {
    const row = this.db.prepare(`SELECT tmpl FROM lines WHERE line_no = ?`).get(lineNo) as
      | { tmpl: number | null }
      | undefined;
    return row?.tmpl ?? null;
  }

  /** The head (record-start) line number that a given line belongs to. */
  headOf(lineNo: number): number {
    const row = this.db.prepare(`SELECT head FROM lines WHERE line_no = ?`).get(lineNo) as
      | { head: number }
      | undefined;
    return row?.head ?? lineNo;
  }

  /**
   * (Re)build the records table for heads at or after `fromHead`. Existing record
   * rows from that point are dropped first, so this serves both the initial build
   * (fromHead = 0) and incremental tail updates (fromHead = the last record's head,
   * whose span may have grown). `lineCount` bounds the final record's span.
   */
  buildRecords(fromHead: number, lineCount: number): void {
    this.db.prepare(`DELETE FROM records WHERE head >= ?`).run(fromHead);
    this.db
      .prepare(
        `INSERT INTO records(head, span)
         SELECT head, LEAD(head, 1, ?) OVER (ORDER BY head) - head
         FROM (SELECT line_no AS head FROM lines WHERE is_head = 1 AND line_no >= ? ORDER BY line_no)`,
      )
      .run(lineCount, fromHead);
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
  runSearch(node: QueryNode, grouped = false, fromLineNo?: number, templateId: number | null = null): number {
    const { where, params } = compileQuery(node);
    // Grouped search materializes matching *records* (distinct heads), so a hit
    // anywhere in a record — including a stack-trace continuation line — surfaces
    // the record once. Ungrouped search materializes matching physical lines.
    // A templateId narrows to one cluster (its head lines).
    const selectCol = grouped ? 'DISTINCT l.head' : 'l.line_no';
    const orderCol = grouped ? 'l.head' : 'l.line_no';
    const conds: string[] = [];
    const p: (string | number)[] = [];
    if (fromLineNo !== undefined) {
      conds.push(`${orderCol} >= ?`);
      p.push(fromLineNo);
    }
    if (templateId !== null) {
      conds.push('l.tmpl = ?');
      p.push(templateId);
    }
    conds.push(`(${where})`);
    p.push(...params);
    if (fromLineNo === undefined) {
      this.db.exec(`DELETE FROM results; DELETE FROM sqlite_sequence WHERE name = 'results';`);
    }
    this.db
      .prepare(
        `INSERT INTO results(line_no) SELECT ${selectCol} FROM lines l WHERE ${conds.join(' AND ')} ORDER BY ${orderCol}`,
      )
      .run(...p);
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

  // -------------------------------------------------------------------------
  // Records (multi-line grouping)

  recordCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number };
    return row.n;
  }

  /** Page of records (head + span) for the whole file, in line order. */
  recordPage(offset: number, limit: number): RecordRef[] {
    return this.db
      .prepare(`SELECT head, span FROM records ORDER BY rec_no LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as RecordRef[];
  }

  /** Page of matching records: each result head joined to its span. */
  resultRecordPage(offset: number, limit: number): RecordRef[] {
    return this.db
      .prepare(
        `SELECT r.line_no AS head, COALESCE(rec.span, 1) AS span
         FROM results r LEFT JOIN records rec ON rec.head = r.line_no
         ORDER BY r.seq LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as RecordRef[];
  }

  /** Number of physical lines in the record headed by `head` (1 if it has none/unknown). */
  spanOf(head: number): number {
    const row = this.db.prepare(`SELECT span FROM records WHERE head = ?`).get(head) as
      | { span: number }
      | undefined;
    return row?.span ?? 1;
  }

  /** Zero-based position of a record (by its head) in file order. */
  recordIndexOf(head: number): number {
    const row = this.db.prepare(`SELECT rec_no FROM records WHERE head = ?`).get(head) as
      | { rec_no: number }
      | undefined;
    return row ? row.rec_no - 1 : 0;
  }

  /**
   * The next (dir = 1) or previous (dir = -1) matching line relative to `after`,
   * among the current result set, wrapping around the ends. Null if no results.
   */
  nextResult(after: number, dir: 1 | -1): number | null {
    const stmt =
      dir > 0
        ? this.db.prepare(`SELECT MIN(line_no) AS n FROM results WHERE line_no > ?`)
        : this.db.prepare(`SELECT MAX(line_no) AS n FROM results WHERE line_no < ?`);
    const row = stmt.get(after) as { n: number | null };
    if (row.n !== null) return row.n;
    // wrap: first match for forward, last match for backward
    const wrap = this.db
      .prepare(`SELECT ${dir > 0 ? 'MIN' : 'MAX'}(line_no) AS n FROM results`)
      .get() as { n: number | null };
    return wrap.n;
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

  /** Of the given lines, which are members of the current result set. */
  matchingLines(lineNos: number[]): Set<number> {
    const out = new Set<number>();
    if (lineNos.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT DISTINCT line_no FROM results WHERE line_no IN (${lineNos.map(() => '?').join(',')})`)
      .all(...lineNos) as { line_no: number }[];
    for (const r of rows) out.add(r.line_no);
    return out;
  }

  /** Structured fields for one line. */
  lineFields(lineNo: number): { key: string; value: string }[] {
    return this.db
      .prepare(`SELECT key, value FROM fields WHERE line_no = ? ORDER BY rowid`)
      .all(lineNo) as { key: string; value: string }[];
  }

  /** Values of selected field keys for a set of lines (for the columnar view). */
  fieldValues(lineNos: number[], keys: string[]): Map<number, Record<string, string>> {
    const out = new Map<number, Record<string, string>>();
    if (lineNos.length === 0 || keys.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT line_no, key, value FROM fields
         WHERE line_no IN (${lineNos.map(() => '?').join(',')}) AND key IN (${keys.map(() => '?').join(',')})`,
      )
      .all(...lineNos, ...keys) as { line_no: number; key: string; value: string }[];
    for (const r of rows) {
      let m = out.get(r.line_no);
      if (!m) {
        m = {};
        out.set(r.line_no, m);
      }
      m[r.key] = r.value;
    }
    return out;
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

  /**
   * Value breakdown for one field: the top values with counts, optionally
   * restricted to the current result set. Drives off `results` (small) joined to
   * `fields` via `idx_fields_line` when filtered, or `idx_fields_kv` over the
   * whole file otherwise.
   */
  facet(field: string, filtered: boolean, limit = 25): Facet {
    limit = Math.min(Math.max(limit, 1), 1000);
    const values = (
      filtered
        ? this.db.prepare(
            `SELECT f.value AS value, COUNT(*) AS count
             FROM results r JOIN fields f ON f.line_no = r.line_no
             WHERE f.key = ? GROUP BY f.value ORDER BY count DESC, value LIMIT ?`,
          )
        : this.db.prepare(
            `SELECT value, COUNT(*) AS count FROM fields
             WHERE key = ? GROUP BY value ORDER BY count DESC, value LIMIT ?`,
          )
    ).all(field, limit) as { value: string; count: number }[];

    const agg = (
      filtered
        ? this.db.prepare(
            `SELECT COUNT(DISTINCT f.value) AS distinctCount, COUNT(*) AS covered
             FROM results r JOIN fields f ON f.line_no = r.line_no WHERE f.key = ?`,
          )
        : this.db.prepare(
            `SELECT COUNT(DISTINCT value) AS distinctCount, COUNT(*) AS covered FROM fields WHERE key = ?`,
          )
    ).get(field) as { distinctCount: number; covered: number };

    return { field, values, distinctCount: agg.distinctCount, covered: agg.covered };
  }

  /**
   * Top log patterns (templates) by count, optionally restricted to the current
   * result set. Whole-file uses the precomputed templates table; filtered counts
   * the head lines in the result set grouped by template.
   */
  clusters(filtered: boolean, limit = 50): Clusters {
    limit = Math.min(Math.max(limit, 1), 1000);
    if (filtered) {
      const patterns = this.db
        .prepare(
          `SELECT t.id AS id, t.pattern AS pattern, COUNT(*) AS count
           FROM results r JOIN lines l ON l.line_no = r.line_no JOIN templates t ON t.id = l.tmpl
           GROUP BY l.tmpl ORDER BY count DESC, t.id LIMIT ?`,
        )
        .all(limit) as { id: number; pattern: string; count: number }[];
      const agg = this.db
        .prepare(
          `SELECT COUNT(DISTINCT l.tmpl) AS distinctCount, COUNT(l.tmpl) AS covered
           FROM results r JOIN lines l ON l.line_no = r.line_no WHERE l.tmpl IS NOT NULL`,
        )
        .get() as { distinctCount: number; covered: number };
      return { patterns, distinctCount: agg.distinctCount, covered: agg.covered };
    }
    const patterns = this.db
      .prepare(`SELECT id, pattern, count FROM templates ORDER BY count DESC, id LIMIT ?`)
      .all(limit) as { id: number; pattern: string; count: number }[];
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS distinctCount, COALESCE(SUM(count), 0) AS covered FROM templates`)
      .get() as { distinctCount: number; covered: number };
    return { patterns, distinctCount: agg.distinctCount, covered: agg.covered };
  }

  /** Replace the templates table from the in-memory pattern catalogue. */
  saveTemplates(entries: { id: number; pattern: string; count: number }[]): void {
    this.db.exec('DELETE FROM templates');
    const ins = this.db.prepare(`INSERT INTO templates(id, pattern, count) VALUES (?, ?, ?)`);
    this.db.exec('BEGIN');
    for (const e of entries) ins.run(e.id, e.pattern, e.count);
    this.db.exec('COMMIT');
  }

  /** Load the template catalogue (for resuming a cached index). */
  loadTemplates(): { id: number; pattern: string; count: number }[] {
    return this.db.prepare(`SELECT id, pattern, count FROM templates`).all() as {
      id: number;
      pattern: string;
      count: number;
    }[];
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
