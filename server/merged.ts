import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { LogSession, indexCacheDir } from './session.ts';
import { type Histogram, type HistogramBucket } from './indexer.ts';
import { parseQuery } from './queryParser.ts';
import { compileQuery } from './queryCompiler.ts';

/**
 * A time-ordered view across several open files, for correlating events between
 * services. Each participating session's index DB is attached for the lifetime
 * of the timeline; their timestamped record-head lines are merged into one
 * `merged` table ordered by time. Search compiles the query against each
 * attached index (schema-qualified) and materializes matching rows into
 * `merged_results`. Row text is read on demand from each source file.
 */

/** SQLite's default cap on attached databases. */
const MAX_SOURCES = 10;

export interface MergedRow {
  seq: number;
  source: number;
  file: string;
  lineNo: number;
  ts: number;
  level: string | null;
  text: string;
  truncated: boolean;
  /** Physical lines in the record this row heads (1 = none). */
  span: number;
  /** In highlight mode, whether this row matches the active search. */
  match?: boolean;
}

export class MergedTimeline {
  private db: DatabaseSync;
  private readonly dbPath: string;
  readonly sources: LogSession[];
  private searchActive = false;
  private searchTotal = 0;

  constructor(sessions: LogSession[]) {
    if (sessions.length > MAX_SOURCES) {
      throw new Error(`The merged timeline supports up to ${MAX_SOURCES} files at once`);
    }
    this.sources = sessions;
    this.dbPath = path.join(indexCacheDir(), `merged-${process.pid}-${Date.now()}.db`);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;`);
    this.build();
  }

  /** (Re)materialize the merged table from the current per-file indexes. */
  build(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS merged;
      DROP TABLE IF EXISTS merged_results;
      CREATE TABLE merged(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sess INTEGER, line_no INTEGER, level TEXT, span INTEGER);
    `);
    this.searchActive = false;
    this.searchTotal = 0;
    if (this.sources.length === 0) return;
    const unions: string[] = [];
    this.sources.forEach((s, i) => {
      // attached for the lifetime of the timeline so search can query it later
      this.db.prepare(`ATTACH DATABASE ? AS s${i}`).run(s.dbPath);
      unions.push(
        `SELECT l.ts, ${i} AS sess, l.line_no, l.level, COALESCE(rec.span, 1) AS span
         FROM s${i}.lines l LEFT JOIN s${i}.records rec ON rec.head = l.line_no
         WHERE l.ts IS NOT NULL`,
      );
    });
    // ORDER BY ts makes the AUTOINCREMENT seq follow time order
    this.db.exec(`INSERT INTO merged(ts, sess, line_no, level, span) ${unions.join(' UNION ALL ')} ORDER BY ts`);
    this.db.exec(`CREATE INDEX idx_merged_ts ON merged(ts, level)`);
  }

  /**
   * Filter the timeline to lines matching `query`. Compiles the query against
   * each attached index and collects the matching record heads (so a hit inside a
   * stack trace surfaces its record). Empty query clears the filter.
   */
  setSearch(query: string): { total: number; durationMs: number } {
    this.db.exec(`DROP TABLE IF EXISTS merged_results; CREATE TABLE merged_results(seq INTEGER PRIMARY KEY);`);
    const trimmed = query.trim();
    if (trimmed === '') {
      this.searchActive = false;
      this.searchTotal = 0;
      return { total: this.mergedCount(), durationMs: 0 };
    }
    const ast = parseQuery(trimmed);
    const t0 = performance.now();
    this.sources.forEach((_, i) => {
      const { where, params } = compileQuery(ast, `s${i}.`);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO merged_results(seq)
           SELECT m.seq FROM merged m
           WHERE m.sess = ? AND m.line_no IN (SELECT DISTINCT l.head FROM s${i}.lines l WHERE (${where}))`,
        )
        .run(i, ...params);
    });
    this.searchActive = true;
    this.searchTotal = (this.db.prepare(`SELECT COUNT(*) AS n FROM merged_results`).get() as { n: number }).n;
    return { total: this.searchTotal, durationMs: Math.round(performance.now() - t0) };
  }

  private mergedCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM merged`).get() as { n: number }).n;
  }

  /** Rows shown for a given mode: the matched subset when filtering, else the whole timeline. */
  count(highlight = false): number {
    return this.searchActive && !highlight ? this.searchTotal : this.mergedCount();
  }

  /** A page of merged rows in time order; flags matches in highlight mode. */
  async page(offset: number, limit: number, order: 'asc' | 'desc' = 'asc', highlight = false): Promise<MergedRow[]> {
    limit = Math.min(Math.max(limit, 0), 2000);
    offset = Math.max(0, offset);
    const filtered = this.searchActive && !highlight;
    const total = this.count(highlight);
    const count = Math.min(limit, Math.max(0, total - offset));
    if (count === 0) return [];
    const fetchOffset = order === 'desc' ? total - offset - count : offset;
    const refs = (
      filtered
        ? this.db.prepare(
            `SELECT m.seq, m.ts, m.sess, m.line_no, m.level, m.span
             FROM merged_results mr JOIN merged m ON m.seq = mr.seq ORDER BY mr.seq LIMIT ? OFFSET ?`,
          )
        : this.db.prepare(`SELECT seq, ts, sess, line_no, level, span FROM merged ORDER BY seq LIMIT ? OFFSET ?`)
    ).all(count, fetchOffset) as {
      seq: number;
      ts: number;
      sess: number;
      line_no: number;
      level: string | null;
      span: number;
    }[];

    // read line text from each source's reader, batched per session
    const bySess = new Map<number, number[]>();
    for (const r of refs) {
      let arr = bySess.get(r.sess);
      if (!arr) bySess.set(r.sess, (arr = []));
      arr.push(r.line_no);
    }
    const textBySess = new Map<number, Map<number, { text: string; truncated: boolean }>>();
    for (const [sess, lineNos] of bySess) {
      const rows = await this.sources[sess].readRowsForExport(lineNos);
      textBySess.set(sess, new Map(rows.map((r) => [r.lineNo, { text: r.text, truncated: r.truncated }])));
    }

    // highlight: which of these rows are matches
    let hits: Set<number> | null = null;
    if (highlight && this.searchActive) {
      hits = new Set();
      const seqs = refs.map((r) => r.seq);
      const found = this.db
        .prepare(`SELECT seq FROM merged_results WHERE seq IN (${seqs.map(() => '?').join(',')})`)
        .all(...seqs) as { seq: number }[];
      for (const f of found) hits.add(f.seq);
    }

    const out: MergedRow[] = refs.map((r) => ({
      seq: r.seq,
      source: r.sess,
      file: this.sources[r.sess].file,
      lineNo: r.line_no,
      ts: r.ts,
      level: r.level,
      text: textBySess.get(r.sess)?.get(r.line_no)?.text ?? '',
      truncated: textBySess.get(r.sess)?.get(r.line_no)?.truncated ?? false,
      span: r.span,
      ...(hits ? { match: hits.has(r.seq) } : {}),
    }));
    if (order === 'desc') out.reverse();
    return out;
  }

  /** Combined volume histogram (filtered subset when searching), stacked by level. */
  histogram(highlight = false, bucketCount = 100): Histogram | null {
    const filtered = this.searchActive && !highlight;
    const from = filtered ? `merged_results mr JOIN merged m ON m.seq = mr.seq` : `merged m`;
    const range = this.db.prepare(`SELECT MIN(m.ts) AS lo, MAX(m.ts) AS hi, COUNT(*) AS n FROM ${from}`).get() as {
      lo: number | null;
      hi: number | null;
      n: number;
    };
    if (range.lo === null || range.hi === null) return null;
    const span = Math.max(1, range.hi - range.lo);
    const bucketMs = Math.max(1, Math.ceil(span / bucketCount));
    const rows = this.db
      .prepare(
        `SELECT CAST((m.ts - ?) / ? AS INTEGER) AS b, COALESCE(m.level, 'NONE') AS level, COUNT(*) AS n
         FROM ${from} GROUP BY b, level`,
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
      withoutTs: 0,
    };
  }

  /** Zero-based index of the first displayed row at or after `ts` (for time navigation). */
  seekTs(ts: number, highlight = false): number {
    const filtered = this.searchActive && !highlight;
    const sql = filtered
      ? `SELECT COUNT(*) AS n FROM merged_results mr JOIN merged m ON m.seq = mr.seq WHERE m.ts < ?`
      : `SELECT COUNT(*) AS n FROM merged WHERE ts < ?`;
    return (this.db.prepare(sql).get(ts) as { n: number }).n;
  }

  /** Source files in merge order, for the UI legend. */
  sourceList(): { id: string; file: string }[] {
    return this.sources.map((s) => ({ id: s.id, file: s.file }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
    try {
      rmSync(this.dbPath, { force: true });
    } catch {}
  }
}
