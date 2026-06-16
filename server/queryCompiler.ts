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

class Compiler {
  params: (string | number)[] = [];
  /** Schema prefix for the fts/fields tables (e.g. `s0.` for an attached DB), '' for the local schema. */
  private readonly p: string;

  constructor(schema = '') {
    this.p = schema;
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
