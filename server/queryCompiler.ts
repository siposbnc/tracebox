import type { DatabaseSync } from 'node:sqlite';
import { type QueryNode, type CmpOp, QuerySyntaxError } from './queryParser.ts';
import { normalizeLevel } from './parsers.ts';

/**
 * Compiles a query AST into a SQL boolean expression over the index schema
 * (alias `l` = the `lines` table). Leaf predicates use IN-subqueries against
 * the FTS5 index / fields table so SQLite can drive them from indexes.
 */

const LEVEL_FIELDS = new Set(['level', 'lvl', 'severity', 'loglevel']);
const TS_FIELDS = new Set(['timestamp', 'ts', 'time', '@timestamp', 'date', 'datetime']);

export interface CompiledQuery {
  /** Boolean SQL expression referencing alias `l`. */
  where: string;
  params: (string | number)[];
}

/**
 * Parse a timestamp query value into a [start, end) range whose width follows
 * the precision of the input ("2024-01-31" covers the whole day, etc.).
 */
export function parseTsRange(value: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    value.trim(),
  );
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : { start: t, end: t + 1 };
  }
  const [, y, mo, d, h, mi, se, frac, zone] = m;
  let offsetMs = 0;
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? 1 : -1;
    offsetMs = sign * (+zone.slice(1, 3) * 60 + +zone.slice(zone.includes(':') ? 4 : 3)) * 60_000;
  }
  const base = (endParts: boolean): number => {
    if (!d) return Date.UTC(+y, +mo - 1 + (endParts ? 1 : 0), 1);
    if (!h) return Date.UTC(+y, +mo - 1, +d + (endParts ? 1 : 0));
    if (!se) return Date.UTC(+y, +mo - 1, +d, +h, +mi + (endParts ? 1 : 0));
    const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : null;
    if (ms === null) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se + (endParts ? 1 : 0));
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, ms + (endParts ? 1 : 0));
  };
  return { start: base(false) + offsetMs, end: base(true) + offsetMs };
}

function ftsQueryFor(value: string, phrase: boolean): string {
  const quoted = `"${value.replaceAll('"', '""')}"`;
  return phrase ? quoted : `${quoted}*`;
}

function likePattern(glob: string): string {
  return glob.replace(/[\\%_]/g, (c) => `\\${c}`).replaceAll('*', '%');
}

// ---------------------------------------------------------------------------
// REGEXP SQL function (powers `field:~pattern`)

/**
 * Bounded cache of compiled patterns so the `regexp()` SQL function does not
 * recompile per row. Patterns are case-insensitive, matching the dedicated
 * whole-line regex search and the query language's case-insensitive fields.
 */
const regexCache = new Map<string, RegExp>();

function compileRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern, 'i');
    if (regexCache.size >= 256) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return re;
}

/**
 * Register the `regexp(pattern, value)` scalar so SQLite's `value REGEXP ?`
 * operator works. Must be called on every database that compiled queries run
 * against (per-file index and the merged timeline). A null value never matches;
 * an unparseable pattern matches nothing rather than aborting the query.
 */
export function registerRegexp(db: DatabaseSync): void {
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown): number => {
    if (value === null || value === undefined || pattern === null || pattern === undefined) return 0;
    try {
      return compileRegex(String(pattern)).test(String(value)) ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

/** A whole-line `/regex/` leaf, numbered in compile order; its matches are
 *  materialized into a temp table the exact query then references. */
export interface RegexLeaf {
  index: number;
  pattern: string;
  flags: string;
}

class Compiler {
  params: (string | number)[] = [];
  /** Whole-line regex leaves encountered, in compile (DFS) order. */
  readonly leaves: RegexLeaf[] = [];
  /** Schema prefix for the fts/fields tables (e.g. `s0.` for an attached DB), '' for the local schema. */
  private readonly p: string;
  /** Resolves a regex leaf's index to the temp table holding its matches; absent
   *  when whole-line regex isn't supported in this context (then it throws). */
  private readonly regexTable?: (index: number) => string;

  constructor(schema = '', regexTable?: (index: number) => string) {
    this.p = schema;
    this.regexTable = regexTable;
  }

  compile(node: QueryNode): string {
    switch (node.type) {
      case 'all':
        return '1';
      case 'and':
        return `(${node.children.map((c) => this.compile(c)).join(' AND ')})`;
      case 'or':
        return `(${node.children.map((c) => this.compile(c)).join(' OR ')})`;
      case 'not':
        return `(NOT ${this.compile(node.child)})`;
      case 'regex': {
        if (!this.regexTable) {
          throw new QuerySyntaxError('Whole-line /regex/ is not supported in this context');
        }
        const index = this.leaves.length;
        this.leaves.push({ index, pattern: node.pattern, flags: node.flags });
        return `l.line_no IN (SELECT line_no FROM ${this.regexTable(index)})`;
      }
      case 'text': {
        this.params.push(ftsQueryFor(node.value, node.phrase));
        // column-form MATCH works whether or not the table is schema-qualified
        return `l.line_no IN (SELECT rowid FROM ${this.p}fts WHERE content MATCH ?)`;
      }
      case 'exists': {
        const f = node.field.toLowerCase();
        if (LEVEL_FIELDS.has(f)) return `l.level IS NOT NULL`;
        if (TS_FIELDS.has(f)) return `l.ts IS NOT NULL`;
        this.params.push(node.field);
        return `l.line_no IN (SELECT line_no FROM ${this.p}fields WHERE key = ?)`;
      }
      case 'fieldLike': {
        const f = node.field.toLowerCase();
        if (LEVEL_FIELDS.has(f)) {
          this.params.push(likePattern(node.pattern.toUpperCase()));
          return `l.level LIKE ? ESCAPE '\\'`;
        }
        if (TS_FIELDS.has(f)) {
          throw new QuerySyntaxError('Wildcards are not supported on the timestamp field');
        }
        this.params.push(node.field, likePattern(node.pattern));
        return `l.line_no IN (SELECT line_no FROM ${this.p}fields WHERE key = ? AND value LIKE ? ESCAPE '\\')`;
      }
      case 'fieldRegex': {
        const f = node.field.toLowerCase();
        if (TS_FIELDS.has(f)) {
          throw new QuerySyntaxError('Regular expressions are not supported on the timestamp field');
        }
        if (LEVEL_FIELDS.has(f)) {
          this.params.push(node.pattern);
          return `l.level REGEXP ?`;
        }
        this.params.push(node.field, node.pattern);
        return `l.line_no IN (SELECT line_no FROM ${this.p}fields WHERE key = ? AND value REGEXP ?)`;
      }
      case 'field':
        return this.fieldCmp(node.field, node.op, node.value);
    }
  }

  private fieldCmp(field: string, op: CmpOp, value: string): string {
    const f = field.toLowerCase();

    if (LEVEL_FIELDS.has(f)) {
      const level = normalizeLevel(value) ?? value.toUpperCase();
      this.params.push(level);
      return `l.level ${SQL_OP[op]} ?`;
    }

    if (TS_FIELDS.has(f)) {
      const range = parseTsRange(value);
      if (!range) throw new QuerySyntaxError(`Cannot parse timestamp value "${value}"`);
      // Elasticsearch-style rounded ranges: gt = after the whole unit, etc.
      switch (op) {
        case 'eq':
          this.params.push(range.start, range.end);
          return `(l.ts >= ? AND l.ts < ?)`;
        case 'gt':
          this.params.push(range.end);
          return `l.ts >= ?`;
        case 'gte':
          this.params.push(range.start);
          return `l.ts >= ?`;
        case 'lt':
          this.params.push(range.start);
          return `l.ts < ?`;
        case 'lte':
          this.params.push(range.end);
          return `l.ts < ?`;
      }
    }

    const num = value === '' ? NaN : Number(value);
    if (op !== 'eq' && Number.isFinite(num)) {
      this.params.push(field, num);
      return `l.line_no IN (SELECT line_no FROM ${this.p}fields WHERE key = ? AND num ${SQL_OP[op]} ?)`;
    }
    this.params.push(field, value);
    return `l.line_no IN (SELECT line_no FROM ${this.p}fields WHERE key = ? AND value ${SQL_OP[op]} ?)`;
  }

  /**
   * A pure-SQL *superset* of the matches, used to gather candidate lines a regex
   * then verifies. Non-regex leaves compile exactly; a whole-line regex can't be
   * evaluated in SQL, so it's approximated by `1` in positive position and `0`
   * under a `NOT` (`positive` tracks the parity) — which keeps the result a
   * superset while letting the surrounding field/term filters narrow the scan.
   */
  prefilter(node: QueryNode, positive: boolean): string {
    switch (node.type) {
      case 'regex':
        return positive ? '1' : '0';
      case 'and':
        return `(${node.children.map((c) => this.prefilter(c, positive)).join(' AND ')})`;
      case 'or':
        return `(${node.children.map((c) => this.prefilter(c, positive)).join(' OR ')})`;
      case 'not':
        return `(NOT ${this.prefilter(node.child, !positive)})`;
      default:
        return this.compile(node); // exact SQL for every non-regex leaf
    }
  }
}

const SQL_OP: Record<CmpOp, string> = {
  eq: '=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

export function compileQuery(node: QueryNode, schema = ''): CompiledQuery {
  const c = new Compiler(schema);
  const where = c.compile(node);
  return { where, params: c.params };
}

/** Whether a query contains a whole-line `/regex/` term (which needs the two-phase path). */
export function hasRegex(node: QueryNode): boolean {
  switch (node.type) {
    case 'regex':
      return true;
    case 'and':
    case 'or':
      return node.children.some(hasRegex);
    case 'not':
      return hasRegex(node.child);
    default:
      return false;
  }
}

export interface RegexPlan {
  /** The regex leaves to verify, indexed to match the temp tables `regexTable` names. */
  leaves: RegexLeaf[];
  /** Superset SQL over `lines l` to gather candidate lines for verification. */
  prefilter: CompiledQuery;
  /** Exact SQL over `lines l`; each regex leaf references its temp table of verified lines. */
  exact: CompiledQuery;
}

/**
 * Plan a two-phase search for a query containing whole-line regex terms: gather
 * candidates with {@link RegexPlan.prefilter}, verify each regex leaf against
 * those lines, load the matches into the temp tables `regexTable(index)`, then
 * materialize the result with {@link RegexPlan.exact}.
 */
export function planRegexSearch(node: QueryNode, regexTable: (index: number) => string): RegexPlan {
  const exact = new Compiler('', regexTable);
  const exactWhere = exact.compile(node);
  const pref = new Compiler('');
  const prefWhere = pref.prefilter(node, true);
  return {
    leaves: exact.leaves,
    exact: { where: exactWhere, params: exact.params },
    prefilter: { where: prefWhere, params: pref.params },
  };
}

/** Normalize whole-line regex flags: always case-insensitive (like the rest of the
 *  query language), and never stateful (`g`/`y` would break repeated `.test()`). */
export function regexFlags(flags: string): string {
  const set = new Set((flags + 'i').split('').filter((f) => f !== 'g' && f !== 'y'));
  return [...set].join('');
}
