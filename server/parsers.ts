/**
 * Log line parsers: format auto-detection, field extraction, and
 * timestamp / level normalization.
 */

export interface ParsedLine {
  /** Epoch milliseconds (UTC) or null if no timestamp found. */
  ts: number | null;
  /** Canonical level: TRACE | DEBUG | INFO | WARN | ERROR | FATAL, or null. */
  level: string | null;
  message: string | null;
  /** Flattened structured fields (nested JSON becomes dot.paths). */
  fields: Record<string, string> | null;
}

export interface LogParser {
  name: string;
  parse(raw: string): ParsedLine;
  /**
   * Whether this line begins a new logical record. Lines that don't (stack-trace
   * frames, wrapped messages, pretty-printed JSON bodies) are folded into the
   * preceding record when multi-line grouping is enabled.
   */
  startsRecord(raw: string): boolean;
}

/**
 * Heuristic for unstructured / wrapped lines: a continuation is blank, indented,
 * or a well-known JVM trace marker ("Caused by:", "... N more").
 */
export function looksLikeContinuation(raw: string): boolean {
  if (raw === '') return true;
  if (/^\s/.test(raw)) return true;
  return /^(Caused by:|\.{3}\s*\d+\s+more\b|at\s)/.test(raw);
}

// ---------------------------------------------------------------------------
// Level normalization

const LEVEL_MAP: Record<string, string> = {
  trace: 'TRACE', trc: 'TRACE', verbose: 'TRACE', vrb: 'TRACE', finest: 'TRACE',
  debug: 'DEBUG', dbg: 'DEBUG', fine: 'DEBUG', finer: 'DEBUG',
  info: 'INFO', information: 'INFO', informational: 'INFO', notice: 'INFO', inf: 'INFO',
  warn: 'WARN', warning: 'WARN', wrn: 'WARN',
  error: 'ERROR', err: 'ERROR', severe: 'ERROR', failure: 'ERROR',
  fatal: 'FATAL', critical: 'FATAL', crit: 'FATAL', emerg: 'FATAL', emergency: 'FATAL',
  alert: 'FATAL', panic: 'FATAL',
};

export function normalizeLevel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return LEVEL_MAP[raw.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Timestamp parsing

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 2024-01-31 13:45:01.123+02:00 / 2024/01/31T13:45:01,123Z / ...
const RE_YMD = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/;
// 31/Jan/2024:13:45:01 +0200  (Apache/nginx access logs)
const RE_CLF = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/;
// Jan 31 13:45:01  (syslog, no year)
const RE_SYSLOG = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parse a timestamp string into epoch ms. Timestamps without an explicit
 * zone are interpreted as UTC so that ordering/filtering is deterministic.
 */
export function parseTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  let m = RE_YMD.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se, frac, zone] = m;
    const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
    let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, ms);
    if (zone && zone !== 'Z') {
      const sign = zone[0] === '-' ? 1 : -1; // offset is subtracted to get UTC
      const zh = +zone.slice(1, 3);
      const zm = +zone.slice(zone.includes(':') ? 4 : 3);
      t += sign * (zh * 60 + zm) * 60_000;
    }
    return t;
  }

  m = RE_CLF.exec(s);
  if (m) {
    const [, d, mon, y, h, mi, se, zone] = m;
    const month = MONTHS[mon.toLowerCase()];
    if (month === undefined) return null;
    let t = Date.UTC(+y, month, +d, +h, +mi, +se);
    if (zone) {
      const sign = zone[0] === '-' ? 1 : -1;
      t += sign * (+zone.slice(1, 3) * 60 + +zone.slice(3, 5)) * 60_000;
    }
    return t;
  }

  m = RE_SYSLOG.exec(s);
  if (m) {
    const [, mon, d, h, mi, se] = m;
    const month = MONTHS[mon.toLowerCase()];
    if (month === undefined) return null;
    return Date.UTC(new Date().getUTCFullYear(), month, +d, +h, +mi, +se);
  }

  // Pure epoch (seconds or milliseconds)
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return Number(s);

  // Generic ISO-ish fallback
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// JSON parser

const TS_KEYS = ['timestamp', '@timestamp', 'time', 'ts', 'date', 'datetime', 'eventtime'];
const LEVEL_KEYS = ['level', 'log.level', 'severity', 'loglevel', 'lvl', 'event.severity', 'labels.severity'];
const MSG_KEYS = ['message', 'msg', 'text', 'event.message', 'log.message'];

function flatten(value: unknown, out: Record<string, string>, prefix: string): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = '';
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(item, out, `${prefix}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, out, prefix ? `${prefix}.${k}` : k);
    }
    return;
  }
  out[prefix] = String(value);
}

function pickKey(fields: Record<string, string>, keys: string[]): string | null {
  // exact match first, then case-insensitive
  for (const k of keys) if (k in fields) return fields[k];
  const lower = new Map(Object.keys(fields).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k);
    if (real !== undefined) return fields[real];
  }
  return null;
}

export class JsonParser implements LogParser {
  name = 'json';

  /** A record is a fresh object; a line not opening with `{` continues a pretty-printed one. */
  startsRecord(raw: string): boolean {
    return raw.trimStart().startsWith('{');
  }

  parse(raw: string): ParsedLine {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return rawFallback(raw);
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return rawFallback(raw);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return rawFallback(raw);

    const fields: Record<string, string> = {};
    flatten(obj, fields, '');

    const ts = parseTimestamp(pickKey(fields, TS_KEYS));
    const level = normalizeLevel(pickKey(fields, LEVEL_KEYS));
    const message = pickKey(fields, MSG_KEYS);
    return { ts, level, message, fields };
  }
}

// ---------------------------------------------------------------------------
// Regex-based parsers for common text formats

interface RegexFormat {
  name: string;
  re: RegExp;
}

const REGEX_FORMATS: RegexFormat[] = [
  {
    // 2024-01-31 13:45:01.123 [INFO] message   |   2024-01-31T13:45:01Z ERROR message
    name: 'timestamped',
    re: /^(?<timestamp>\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?:\[(?<level>[A-Za-z]+)\]|(?<level2>[A-Z]{3,12}):?)\s+(?:\[?(?<logger>[\w.$/-]+)\]?\s*[-:]\s+)?(?<message>.*)$/,
  },
  {
    // [2024-01-31 13:45:01] [ERROR] message   |   [Wed Jan 31 13:45:01 2024] [error] message
    name: 'bracketed',
    re: /^\[(?<timestamp>[^\]]{8,40})\]\s*\[?(?<level>[A-Za-z]+)\]?:?\s+(?<message>.*)$/,
  },
  {
    // 127.0.0.1 - alice [31/Jan/2024:13:45:01 +0000] "GET /api HTTP/1.1" 200 512
    name: 'access',
    re: /^(?<ip>\S+)\s+\S+\s+(?<user>\S+)\s+\[(?<timestamp>[^\]]+)\]\s+"(?<method>\S+)\s+(?<path>\S+)(?:\s+(?<protocol>[^"]*))?"\s+(?<status>\d{3})\s+(?<bytes>\d+|-)(?:\s+"(?<referer>[^"]*)"\s+"(?<agent>[^"]*)")?/,
  },
  {
    // Jan 31 13:45:01 myhost sshd[1234]: message
    name: 'syslog',
    re: /^(?<timestamp>[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(?<host>\S+)\s+(?<proc>[\w\-./]+)(?:\[(?<pid>\d+)\])?:\s*(?<message>.*)$/,
  },
  {
    // ERROR:root:Something went wrong  (Python logging default)
    name: 'python',
    re: /^(?<level>[A-Z]{4,12}):(?<logger>[\w.]+):(?<message>.*)$/,
  },
];

const META_GROUPS = new Set(['timestamp', 'level', 'level2', 'message']);

export class RegexParser implements LogParser {
  name: string;
  private readonly re: RegExp;

  constructor(name: string, re: RegExp) {
    this.name = name;
    this.re = re;
  }

  /** A record is a line matching the format; anything else (e.g. a stack frame) continues it. */
  startsRecord(raw: string): boolean {
    return this.re.test(raw);
  }

  parse(raw: string): ParsedLine {
    const m = this.re.exec(raw);
    if (!m || !m.groups) return rawFallback(raw);
    const g = m.groups;
    const ts = parseTimestamp(g.timestamp);
    const level = normalizeLevel(g.level ?? g.level2);
    const message = g.message ?? null;
    let fields: Record<string, string> | null = null;
    for (const [key, value] of Object.entries(g)) {
      if (META_GROUPS.has(key) || value === undefined) continue;
      (fields ??= {})[key] = value;
    }
    if (message !== null) (fields ??= {}).message = message;
    return { ts, level, message, fields };
  }
}

// ---------------------------------------------------------------------------
// logfmt parser: time=2024-01-31T13:45:01Z level=info msg="hello world" n=42

const LOGFMT_PAIR = /([A-Za-z_][\w.@-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;

export class LogfmtParser implements LogParser {
  name = 'logfmt';

  startsRecord(raw: string): boolean {
    return !looksLikeContinuation(raw);
  }

  parse(raw: string): ParsedLine {
    LOGFMT_PAIR.lastIndex = 0;
    let fields: Record<string, string> | null = null;
    let m: RegExpExecArray | null;
    while ((m = LOGFMT_PAIR.exec(raw)) !== null) {
      const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
      (fields ??= {})[m[1]] = value;
    }
    if (!fields) return rawFallback(raw);
    const ts = parseTimestamp(pickKey(fields, TS_KEYS));
    const level = normalizeLevel(pickKey(fields, LEVEL_KEYS));
    const message = pickKey(fields, MSG_KEYS);
    return { ts, level, message, fields };
  }
}

// ---------------------------------------------------------------------------
// Raw fallback: still sniff a level keyword and a timestamp so that
// level filters and the histogram work on unrecognized formats.

const RE_SNIFF_LEVEL = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL|SEVERE|NOTICE)\b/i;
const RE_SNIFF_TS = /\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/;

function rawFallback(raw: string): ParsedLine {
  const lm = RE_SNIFF_LEVEL.exec(raw);
  const tm = RE_SNIFF_TS.exec(raw);
  return {
    ts: tm ? parseTimestamp(tm[0]) : null,
    level: lm ? normalizeLevel(lm[1]) : null,
    message: raw,
    fields: null,
  };
}

export class RawParser implements LogParser {
  name = 'raw';
  startsRecord(raw: string): boolean {
    return !looksLikeContinuation(raw);
  }
  parse(raw: string): ParsedLine {
    return rawFallback(raw);
  }
}

// ---------------------------------------------------------------------------
// Log templating (clustering): reduce a line to a pattern by masking the tokens
// that vary between otherwise-identical lines (numbers, ids, timestamps, hex),
// so near-identical lines collapse to one template.

const TPL_MAX_CHARS = 4096;
const TPL_MAX_TOKENS = 80;
const TPL_PLACEHOLDER = '<*>';

/** True if a whitespace-delimited token looks like a variable value. */
function isVariableToken(t: string): boolean {
  if (/\d/.test(t)) return true; // numbers, timestamps, ids, sizes, durations…
  if (/^[0-9a-f]{12,}$/i.test(t)) return true; // long hex (hashes), even without digits
  return false;
}

/**
 * Collapse a line to its template by masking variable tokens. Consecutive masked
 * tokens are merged so "GET /a/1 200 5ms" and "GET /a/2 404 9ms" share one
 * template. Bounded in length and token count for very long lines.
 */
export function templateOf(raw: string): string {
  const s = raw.length > TPL_MAX_CHARS ? raw.slice(0, TPL_MAX_CHARS) : raw;
  const out: string[] = [];
  let count = 0;
  let lastMasked = false;
  for (const t of s.split(/\s+/)) {
    if (t === '') continue;
    if (count >= TPL_MAX_TOKENS) {
      out.push('…');
      break;
    }
    const masked = isVariableToken(t);
    if (masked && lastMasked) continue; // merge runs of variables
    out.push(masked ? TPL_PLACEHOLDER : t);
    lastMasked = masked;
    count++;
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Format detection: score each candidate on a sample of lines.

/**
 * Compile user-defined parser specs (a name + a regex string with named groups)
 * into {@link RegexParser}s. Invalid regexes are skipped — config-level validation
 * is the gate; this is defensive so one bad spec can't break detection.
 */
export function compileCustomParsers(specs: { name: string; pattern: string }[]): RegexParser[] {
  const out: RegexParser[] = [];
  for (const spec of specs) {
    try {
      out.push(new RegexParser(spec.name, new RegExp(spec.pattern)));
    } catch {
      // skip — a malformed pattern shouldn't break opening a file
    }
  }
  return out;
}

/** Built-in format names, in detection order, for the parser picker. */
export const BUILTIN_PARSER_NAMES: string[] = [
  'json',
  ...REGEX_FORMATS.map((f) => f.name),
  'logfmt',
  'raw',
];

/** Instantiate a parser by name — a custom parser if one matches, else a built-in. */
export function parserByName(name: string, custom: LogParser[] = []): LogParser | null {
  const c = custom.find((p) => p.name === name);
  if (c) return c;
  if (name === 'json') return new JsonParser();
  if (name === 'logfmt') return new LogfmtParser();
  if (name === 'raw') return new RawParser();
  const rf = REGEX_FORMATS.find((f) => f.name === name);
  return rf ? new RegexParser(rf.name, rf.re) : null;
}

/** How well a parser matches a sample: the fraction of lines it parses structurally. */
function scoreParser(parser: LogParser, sample: string[]): number {
  let score = 0;
  for (const line of sample) {
    const p = parser.parse(line);
    // a structured parse must beat the raw fallback: fields are only set on a real
    // match (the fallback always returns fields: null)
    if (parser.name === 'json' || parser.name === 'logfmt') {
      if (p.fields && Object.keys(p.fields).length >= 2) score++;
    } else if (p.fields) {
      score++;
    }
  }
  return score / sample.length;
}

/**
 * Pick the best parser for a sample. User-defined parsers take precedence: if any
 * of them parses the sample well enough, the best-scoring one wins outright — even
 * over a built-in that would score higher — because the user defined it for this
 * format on purpose. Only when none qualifies do the built-ins compete.
 */
export function detectFormat(sampleLines: string[], custom: LogParser[] = []): LogParser {
  const sample = sampleLines.filter((l) => l.trim().length > 0).slice(0, 100);
  if (sample.length === 0) return new RawParser();

  // user-defined parsers first, as a priority tier
  let bestCustom: LogParser | null = null;
  let bestCustomScore = 0;
  for (const parser of custom) {
    const ratio = scoreParser(parser, sample);
    if (ratio > bestCustomScore) {
      bestCustomScore = ratio;
      bestCustom = parser;
    }
  }
  if (bestCustom && bestCustomScore >= 0.5) return bestCustom;

  // otherwise fall back to the built-in formats
  const builtins: LogParser[] = [
    new JsonParser(),
    ...REGEX_FORMATS.map((f) => new RegexParser(f.name, f.re)),
    new LogfmtParser(),
  ];
  let best: LogParser = new RawParser();
  let bestScore = 0;
  for (const parser of builtins) {
    const ratio = scoreParser(parser, sample);
    if (ratio > bestScore) {
      bestScore = ratio;
      best = parser;
    }
  }
  return bestScore >= 0.5 ? best : new RawParser();
}
