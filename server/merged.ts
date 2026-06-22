import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { LogSession, indexCacheDir } from './session.ts';
import { type Histogram, type HistogramBucket } from './indexer.ts';
import { parseQuery, type QueryNode } from './queryParser.ts';
import { compileQuery, registerRegexp } from './queryCompiler.ts';

/**
 * A time-ordered view across several open files, for correlating events between
 * services. Each participating session's index DB is attached for the lifetime
 * of the timeline; their timestamped record-head lines are merged into one
 * `merged` table ordered by time. Search compiles the query against each
 * attached index (schema-qualified) and materializes matching rows into
 * `merged_results`. Row text is read on demand from each source file.
 *
 * The timeline is **live**: it subscribes to each source session and folds
 * appended lines in as they arrive (the same way single-file tail does), so a
 * merge over tailed/captured sources keeps following without a manual rebuild.
 * New lines are appended at the live edge in timestamp order; the initial
 * snapshot stays globally sorted. Emits `update` whenever the merged set grows.
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

export class MergedTimeline extends EventEmitter {
  private db: DatabaseSync;
  private readonly dbPath: string;
  readonly sources: LogSession[];
  private searchActive = false;
  private searchTotal = 0;
  /** Parsed query of the active search, kept so appended lines can be re-evaluated. */
  private searchAst: QueryNode | null = null;

  // live-follow state (per source, indexed like `sources`)
  /** Line number from which the next sync re-merges a source — the head of its
   * last merged record, so a record that gained continuation lines (or a
   * re-indexed partial tail line) is refreshed. */
  private scanFrom: number[] = [];
  /** Sources that emitted append/done since the last sync and need re-merging. */
  private dirty = new Set<number>();
  /** Append/done listeners attached to the sources, for detach on close. */
  private followers: { session: LogSession; fn: () => void }[] = [];
  private syncing = false;
  private closed = false;

  constructor(sessions: LogSession[]) {
    super();
    if (sessions.length > MAX_SOURCES) {
      throw new Error(`The merged timeline supports up to ${MAX_SOURCES} files at once`);
    }
    this.sources = sessions;
    this.dbPath = path.join(indexCacheDir(), `merged-${process.pid}-${Date.now()}.db`);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;`);
    registerRegexp(this.db);
    this.build();
    this.attachFollow();
  }

  /** The per-source SELECT feeding the merged table; `fromLine` limits it to a tail region. */
  private sourceSelect(i: number, fromLine = 0): string {
    return `SELECT l.ts, ${i} AS sess, l.line_no, l.level, COALESCE(rec.span, 1) AS span
       FROM s${i}.lines l LEFT JOIN s${i}.records rec ON rec.head = l.line_no
       WHERE l.ts IS NOT NULL AND l.line_no >= ${fromLine}`;
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
    this.searchAst = null;
    if (this.sources.length === 0) return;
    const unions: string[] = [];
    this.sources.forEach((s, i) => {
      // attached for the lifetime of the timeline so search can query it later
      this.db.prepare(`ATTACH DATABASE ? AS s${i}`).run(s.dbPath);
      unions.push(this.sourceSelect(i));
    });
    // ORDER BY ts makes the AUTOINCREMENT seq follow time order
    this.db.exec(`INSERT INTO merged(ts, sess, line_no, level, span) ${unions.join(' UNION ALL ')} ORDER BY ts`);
    this.db.exec(`CREATE INDEX idx_merged_ts ON merged(ts, level)`);
    // keeps the per-source delete / last-record lookup in sync() off a full scan
    this.db.exec(`CREATE INDEX idx_merged_sess ON merged(sess, line_no)`);
    this.dirty.clear();
    this.scanFrom = this.sources.map((_, i) => this.recordHeadAfterLast(i));
  }

  /** Head line of the highest-line_no record merged for source `i`; its line
   * count when nothing is merged yet (so old, tsless lines aren't rescanned). */
  private recordHeadAfterLast(i: number): number {
    const row = this.db
      .prepare(`SELECT l.head AS head FROM s${i}.lines l WHERE l.line_no = (SELECT MAX(line_no) FROM merged WHERE sess = ?)`)
      .get(i) as { head: number } | undefined;
    return row ? row.head : this.sources[i].lineCount;
  }

  // ---------------------------------------------------------------------------
  // Live follow

  /** Subscribe to each source so appended/finished indexing folds in automatically. */
  private attachFollow(): void {
    this.sources.forEach((session, i) => {
      const fn = (): void => {
        this.dirty.add(i);
        this.scheduleSync();
      };
      session.on('append', fn);
      session.on('done', fn);
      this.followers.push({ session, fn });
    });
  }

  private detachFollow(): void {
    for (const { session, fn } of this.followers) {
      session.off('append', fn);
      session.off('done', fn);
    }
    this.followers = [];
  }

  /** Run a sync, guarding against re-entrancy from overlapping source events. */
  private scheduleSync(): void {
    if (this.syncing || this.closed || this.sources.length === 0) return;
    this.syncing = true;
    try {
      this.sync();
    } catch (err) {
      this.emit('error-event', err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Fold newly-indexed lines from each grown source into the merged table. Each
   * changed source is re-merged from the head of its last merged record (so span
   * growth and a re-indexed partial tail line are picked up), and the combined
   * new rows are inserted in timestamp order at the live edge. An active search
   * is extended over the new rows. Emits `update` when anything changed.
   */
  private sync(): void {
    const changed = [...this.dirty];
    this.dirty.clear();
    if (changed.length === 0) return;

    const prevMaxSeq = (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM merged`).get() as { m: number }).m;

    // Drop the trailing region we're about to re-merge (and any of its result rows).
    for (const i of changed) {
      const from = this.scanFrom[i];
      if (this.searchActive) {
        this.db
          .prepare(`DELETE FROM merged_results WHERE seq IN (SELECT seq FROM merged WHERE sess = ? AND line_no >= ?)`)
          .run(i, from);
      }
      this.db.prepare(`DELETE FROM merged WHERE sess = ? AND line_no >= ?`).run(i, from);
    }

    // Re-insert the trailing region + new lines for all changed sources, ts-ordered.
    const unions = changed.map((i) => this.sourceSelect(i, this.scanFrom[i]));
    this.db.exec(`INSERT INTO merged(ts, sess, line_no, level, span) ${unions.join(' UNION ALL ')} ORDER BY ts`);

    // Extend the active search over rows that are new this tick.
    if (this.searchActive && this.searchAst) {
      for (const i of changed) {
        const { where, params } = compileQuery(this.searchAst, `s${i}.`);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO merged_results(seq)
             SELECT m.seq FROM merged m
             WHERE m.sess = ? AND m.seq > ? AND m.line_no IN (SELECT DISTINCT l.head FROM s${i}.lines l WHERE (${where}))`,
          )
          .run(i, prevMaxSeq, ...params);
      }
      this.searchTotal = (this.db.prepare(`SELECT COUNT(*) AS n FROM merged_results`).get() as { n: number }).n;
    }

    for (const i of changed) this.scanFrom[i] = this.recordHeadAfterLast(i);
    this.emit('update');
  }

  /** Fold in any pending source growth synchronously (used by tests / on demand). */
  refresh(): void {
    this.scheduleSync();
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
      this.searchAst = null;
      return { total: this.mergedCount(), durationMs: 0 };
    }
    const ast = parseQuery(trimmed);
    this.searchAst = ast;
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
    // Order by ts (seq breaks ties) so lines appended live slot into their
    // chronological position, rather than always landing at the end as they
    // would if paged by the autoincrement seq.
    const refs = (
      filtered
        ? this.db.prepare(
            `SELECT m.seq, m.ts, m.sess, m.line_no, m.level, m.span
             FROM merged_results mr JOIN merged m ON m.seq = mr.seq ORDER BY m.ts, m.seq LIMIT ? OFFSET ?`,
          )
        : this.db.prepare(`SELECT seq, ts, sess, line_no, level, span FROM merged ORDER BY ts, seq LIMIT ? OFFSET ?`)
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
    this.closed = true;
    this.detachFollow();
    this.removeAllListeners();
    try {
      this.db.close();
    } catch {}
    try {
      rmSync(this.dbPath, { force: true });
    } catch {}
  }
}
