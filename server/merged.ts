import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { LogSession, indexCacheDir } from './session.ts';
import { type Histogram, type HistogramBucket } from './indexer.ts';

/**
 * A time-ordered view across several open files, for correlating events between
 * services. Each participating session's index DB is attached and its
 * timestamped lines merged into one `merged` table ordered by time; row text is
 * read on demand from each source file. Lines without a timestamp are omitted
 * (they can't be placed on a timeline).
 */

export interface MergedRow {
  seq: number;
  /** Index into `sources` / the originating file. */
  source: number;
  file: string;
  ts: number;
  level: string | null;
  text: string;
  truncated: boolean;
}

export class MergedTimeline {
  private db: DatabaseSync;
  private readonly dbPath: string;
  readonly sources: LogSession[];

  constructor(sessions: LogSession[]) {
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
      CREATE TABLE merged(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sess INTEGER, line_no INTEGER, level TEXT);
    `);
    if (this.sources.length === 0) return;
    const unions: string[] = [];
    this.sources.forEach((s, i) => {
      this.db.prepare(`ATTACH DATABASE ? AS s${i}`).run(s.dbPath);
      unions.push(`SELECT ts, ${i} AS sess, line_no, level FROM s${i}.lines WHERE ts IS NOT NULL`);
    });
    // the ORDER BY ts on the union makes the AUTOINCREMENT seq follow time order
    this.db.exec(`INSERT INTO merged(ts, sess, line_no, level) ${unions.join(' UNION ALL ')} ORDER BY ts`);
    this.db.exec(`CREATE INDEX idx_merged_ts ON merged(ts, level)`);
    this.sources.forEach((_, i) => this.db.exec(`DETACH DATABASE s${i}`));
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM merged`).get() as { n: number }).n;
  }

  /** A page of merged rows in time order (or reversed for newest-first). */
  async page(offset: number, limit: number, order: 'asc' | 'desc' = 'asc'): Promise<MergedRow[]> {
    limit = Math.min(Math.max(limit, 0), 2000);
    offset = Math.max(0, offset);
    const total = this.count();
    const count = Math.min(limit, Math.max(0, total - offset));
    if (count === 0) return [];
    const fetchOffset = order === 'desc' ? total - offset - count : offset;
    const refs = this.db
      .prepare(`SELECT seq, ts, sess, line_no, level FROM merged ORDER BY seq LIMIT ? OFFSET ?`)
      .all(count, fetchOffset) as { seq: number; ts: number; sess: number; line_no: number; level: string | null }[];

    // fetch line text from each source's reader, batched per session
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

    const out: MergedRow[] = refs.map((r) => {
      const rd = textBySess.get(r.sess)?.get(r.line_no);
      return {
        seq: r.seq,
        source: r.sess,
        file: this.sources[r.sess].file,
        ts: r.ts,
        level: r.level,
        text: rd?.text ?? '',
        truncated: rd?.truncated ?? false,
      };
    });
    if (order === 'desc') out.reverse();
    return out;
  }

  /** Combined volume histogram across all sources, stacked by level. */
  histogram(bucketCount = 100): Histogram | null {
    const range = this.db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM merged`).get() as {
      lo: number | null;
      hi: number | null;
      n: number;
    };
    if (range.lo === null || range.hi === null) return null;
    const span = Math.max(1, range.hi - range.lo);
    const bucketMs = Math.max(1, Math.ceil(span / bucketCount));
    const rows = this.db
      .prepare(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b, COALESCE(level, 'NONE') AS level, COUNT(*) AS n
         FROM merged GROUP BY b, level`,
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
