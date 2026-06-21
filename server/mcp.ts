import path from 'node:path';
import { statSync, writeFileSync } from 'node:fs';
import { LogSession } from './session.ts';
import { detectRotationGroup } from './rotation.ts';
import { QuerySyntaxError } from './queryParser.ts';
import { RegexParser } from './parsers.ts';
import { addParser, getConfig, removeParser, validateParser } from './config.ts';
import { renderReportMarkdown, renderReportHtml, type ReportSection } from './report.ts';
import type { RowData } from './session.ts';

/**
 * Hand-rolled Model Context Protocol (MCP) server exposing TraceBox's index and
 * query engine to AI agents, with no SDK and no runtime dependencies. It speaks
 * JSON-RPC 2.0 (transport-agnostic: {@link McpServer.handle} takes a parsed
 * message and returns the response object, or null for notifications); the stdio
 * entry in `mcp-main.ts` does the newline framing.
 *
 * Every tool drives the same {@link LogSession} layer the UI uses, so an agent
 * searches, pages, and aggregates over a multi-gigabyte file instead of streaming
 * it into a context window. Stays `127.0.0.1`/offline by construction — it opens
 * no network sockets of its own.
 *
 * Line numbers are 0-based throughout (matching the engine); the UI's 1-based
 * display is a presentation concern that does not apply here.
 */

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_NAME = 'tracebox';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'TraceBox indexes large log files for fast, paged search — use it instead of reading raw log files into context.',
  'Start with open_log(path) to index a file; it returns a sessionId, detected format, line/record counts, levels, and fields.',
  'Then search(sessionId, query) with the query language: terms (implicit AND), "phrases", field:value, numeric comparisons (status:>=500),',
  'timestamp ranges (timestamp:>2024-01-31), wildcards (path:/api/*), field existence (user:*), and boolean AND/OR/NOT with parentheses.',
  'search returns only matching rows plus the total; page with offset/limit. When you only need a few fields across many rows, use',
  'table(query, columns) instead — it returns a compact table (lineNo/ts/level + your fields) rather than full lines, so you do not',
  'have to post-process. Use get_context for surrounding lines, get_record for a',
  'line\'s parsed fields and full multi-line record, and stats/histogram/clusters/facet for aggregates. The aggregates take an optional',
  'query to scope themselves (e.g. clusters(query:"level:error")); omit it to reuse the active search, or pass "" for the whole file.',
  'If a log\'s fields are not being extracted (a proprietary format), define a custom parser: test_parser(pattern) to dry-run a regex,',
  'then add_parser(name, pattern) to save it, and reopen the log.',
  'When you have found what the user asked about, finish with build_report: a title, a summary, and sections that cite evidence by',
  'line number — TraceBox inserts the real indexed lines so the report quotes logs verbatim. This is usually the deliverable.',
  'Line numbers are 0-based.',
].join(' ');

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** A tool reported a problem the model should see (returned as an isError result, not a protocol error). */
class ToolError extends Error {}

function prop(type: string, description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, description, ...extra };
}

export class McpServer {
  private sessions = new Map<string, LogSession>();
  /** Signature of each session's last materialized search, so paging skips re-running it. */
  private lastSearch = new Map<string, string>();
  private nextId = 1;
  private readonly tools: ToolDef[];

  constructor() {
    this.tools = this.buildTools();
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC dispatch

  /** Handle one parsed JSON-RPC message; returns the response object, or null for notifications. */
  async handle(msg: JsonRpcRequest): Promise<object | null> {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return this.error(null, INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const isNotification = msg.id === undefined;
    const id = msg.id ?? null;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      switch (msg.method) {
        case 'initialize':
          return this.result(id, this.initialize(params));
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null; // notifications get no response
        case 'ping':
          return this.result(id, {});
        case 'tools/list':
          return this.result(id, {
            tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          });
        case 'tools/call':
          return this.result(id, await this.callTool(params));
        case 'resources/list':
          return this.result(id, { resources: [] });
        case 'resources/templates/list':
          return this.result(id, { resourceTemplates: [] });
        case 'prompts/list':
          return this.result(id, { prompts: [] });
        default:
          if (isNotification) return null;
          return this.error(id, METHOD_NOT_FOUND, `Unknown method: ${msg.method}`);
      }
    } catch (err) {
      if (err instanceof JsonRpcParamError) return this.error(id, INVALID_PARAMS, err.message);
      return this.error(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    }
  }

  private initialize(params: Record<string, unknown>): object {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name;
    if (typeof name !== 'string') throw new JsonRpcParamError('Missing tool "name"');
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new JsonRpcParamError(`Unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const out = await tool.handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      // Tool-level failures (bad args, unknown session, query syntax) are surfaced
      // to the model as an error result so it can correct course, not as a transport error.
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  private result(id: string | number | null, result: object): object {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number | null, code: number, message: string): object {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  // ---------------------------------------------------------------------------
  // Sessions

  private getSession(args: Record<string, unknown>): LogSession {
    const id = args.sessionId;
    if (typeof id !== 'string') throw new ToolError('Missing "sessionId"');
    const s = this.sessions.get(id);
    if (!s) throw new ToolError(`Unknown sessionId: ${id}. Call open_log first, or list_sessions to see open ones.`);
    return s;
  }

  /** Run a search only when its signature changed; otherwise reuse the materialized set for paging. */
  private async ensureSearch(
    s: LogSession,
    query: string,
    grouped: boolean,
    regex: boolean,
  ): Promise<{ total: number; durationMs: number }> {
    const sig = `${regex ? 'r' : 'q'}|${grouped ? 'g' : 'u'}|${query}`;
    if (this.lastSearch.get(s.id) === sig) {
      return { total: s.viewTotal, durationMs: 0 };
    }
    const r = regex ? await s.setRegexSearch(query, grouped) : s.setSearch(query, grouped);
    this.lastSearch.set(s.id, sig);
    return r;
  }

  /**
   * Optionally scope the next aggregate to a query. When `query` is a string the
   * session's active search is set to it first (so the aggregate runs over those
   * rows); `""` scopes to the whole file. When `query` is omitted the active
   * search (if any) is left in place — aggregates stay chainable off a prior
   * search, but a caller can always pass `query` to be self-contained.
   */
  private async scopeView(s: LogSession, query: unknown): Promise<void> {
    if (typeof query !== 'string') return;
    try {
      await this.ensureSearch(s, query, false, false);
    } catch (err) {
      if (err instanceof QuerySyntaxError) throw new ToolError(err.message);
      throw err;
    }
  }

  /** Close all sessions (process shutdown). */
  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    this.lastSearch.clear();
  }

  // ---------------------------------------------------------------------------
  // Row serialization

  private row(r: RowData): Record<string, unknown> {
    const out: Record<string, unknown> = {
      lineNo: r.lineNo,
      ts: r.ts !== null ? new Date(r.ts).toISOString() : null,
      level: r.level,
      text: r.text,
    };
    if (r.truncated) out.truncated = true;
    if (r.span !== undefined && r.span > 1) out.span = r.span;
    if (r.match !== undefined) out.match = r.match;
    return out;
  }

  private summary(s: LogSession): Record<string, unknown> {
    const st = s.status();
    return {
      sessionId: s.id,
      file: st.file,
      kind: st.kind,
      command: st.command,
      sourceCount: st.sourceCount,
      format: st.format,
      phase: st.phase,
      lineCount: st.lineCount,
      recordCount: st.recordCount,
      sizeBytes: st.fileSize,
      tail: st.tail,
      reusedIndex: st.reusedIndex,
      levels: st.levelCounts,
      fields: st.fieldNames,
      search: st.search,
    };
  }

  // ---------------------------------------------------------------------------
  // Tools

  private buildTools(): ToolDef[] {
    const clampLimit = (v: unknown, def: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(500, Math.max(1, Math.trunc(n))) : def;
    };
    const intArg = (v: unknown, def: number, min = 0): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : def;
    };
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    return [
      {
        name: 'open_log',
        description:
          'Open and index a log file (or a rotation group) so it can be searched. Returns a sessionId plus the detected ' +
          'format, line/record counts, size, per-level counts, and detected fields. Reuses a cached index when the file is unchanged. ' +
          'Blocks until indexing finishes. Pass an absolute path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: prop('string', 'Absolute path to the log file (.log/.txt/.jsonl/.gz, …).'),
            rotation: prop('boolean', 'Open the file together with its rotated siblings (app.log + app.log.1 …) as one time-ordered stream.', {
              default: false,
            }),
          },
          required: ['path'],
        },
        handler: async (args) => {
          const p = str(args.path);
          if (!p) throw new ToolError('Missing "path"');
          const resolved = path.resolve(p);
          let st;
          try {
            st = statSync(resolved);
          } catch {
            throw new ToolError(`File not found: ${resolved}`);
          }
          if (!st.isFile()) throw new ToolError('Not a file');
          // reuse an already-open session for the same file
          for (const existing of this.sessions.values()) {
            if (existing.file.toLowerCase() === resolved.toLowerCase() && existing.sources.length === 1) {
              return this.summary(existing);
            }
          }
          const group = args.rotation === true ? detectRotationGroup(resolved).map((m) => m.path) : [resolved];
          const session = new LogSession(resolved, { sources: group });
          const ready = new Promise<void>((resolve, reject) => {
            session.once('done', () => resolve());
            session.once('error-event', (m: string) => reject(new Error(m)));
          });
          this.sessions.set(session.id, session);
          try {
            await session.start();
            if (session.phase !== 'ready') await ready;
          } catch (err) {
            this.sessions.delete(session.id);
            await session.close().catch(() => {});
            throw new ToolError(err instanceof Error ? err.message : String(err));
          }
          return this.summary(session);
        },
      },

      {
        name: 'list_sessions',
        description: 'List the currently open log sessions with their file, format, counts, and any active search.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ sessions: [...this.sessions.values()].map((s) => this.summary(s)) }),
      },

      {
        name: 'close_log',
        description: 'Close an open log session and free its resources.',
        inputSchema: {
          type: 'object',
          properties: { sessionId: prop('string', 'The session to close.') },
          required: ['sessionId'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          this.sessions.delete(s.id);
          this.lastSearch.delete(s.id);
          await s.close();
          return { ok: true };
        },
      },

      {
        name: 'search',
        description:
          'Search a session with the TraceBox query language and return a page of matching rows plus the total match count. ' +
          'Query language: bare terms are ANDed (prefix match); "double quotes" for an exact phrase; field:value (e.g. level:error); ' +
          'numeric comparisons field:>=N (>, >=, <, <=); timestamp ranges timestamp:>2024-01-31 (precision-aware); wildcards path:/api/*; ' +
          'field existence user:*; negation -term or NOT term; boolean AND/OR with parentheses. Page large result sets with offset/limit.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session to search.'),
            query: prop('string', 'The query. An empty string matches everything (browse the whole file).'),
            limit: prop('integer', 'Max rows to return (1–500).', { default: 50 }),
            offset: prop('integer', 'Row offset into the result set, for paging.', { default: 0 }),
            order: prop('string', 'Row order by time/position.', { enum: ['asc', 'desc'], default: 'asc' }),
            grouped: prop('boolean', 'Group multi-line records (stack traces) into one row each.', { default: false }),
            regex: prop('boolean', 'Treat the query as a regular expression scanned over line text instead of the query language.', {
              default: false,
            }),
          },
          required: ['sessionId', 'query'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const query = str(args.query);
          const grouped = args.grouped === true;
          const regex = args.regex === true;
          const order = args.order === 'desc' ? 'desc' : 'asc';
          const limit = clampLimit(args.limit, 50);
          const offset = intArg(args.offset, 0);
          let total: number;
          let durationMs: number;
          try {
            ({ total, durationMs } = await this.ensureSearch(s, query, grouped, regex));
          } catch (err) {
            if (err instanceof QuerySyntaxError) throw new ToolError(err.message);
            throw err;
          }
          const rows = await s.getRows(offset, limit, order, false, grouped);
          return {
            sessionId: s.id,
            query,
            total,
            durationMs,
            offset,
            returned: rows.length,
            order,
            grouped,
            rows: rows.map((r) => this.row(r)),
          };
        },
      },

      {
        name: 'table',
        description:
          'Like search, but return only the fields you ask for as a compact table — column names once, then each row as an array ' +
          'of values — instead of full log lines. Use this (not search) when you only need a few fields across many rows, so the ' +
          'result stays small and you do not have to post-process it. `lineNo`, `ts`, and `level` are always included as the first ' +
          'columns (cite `lineNo` in build_report); list your structured fields in `columns` (see the fields tool for what exists). ' +
          'A missing field is null on that row. Page with offset/limit.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session to query.'),
            query: prop('string', 'The query (same language as search). "" matches everything.'),
            columns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Structured field names to project (e.g. ["status","duration","host"]). lineNo/ts/level are added automatically.',
            },
            limit: prop('integer', 'Max rows to return (1–500).', { default: 100 }),
            offset: prop('integer', 'Row offset into the result set, for paging.', { default: 0 }),
            order: prop('string', 'Row order by time/position.', { enum: ['asc', 'desc'], default: 'asc' }),
            grouped: prop('boolean', 'Group multi-line records (stack traces) into one row each.', { default: false }),
          },
          required: ['sessionId', 'query', 'columns'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const query = str(args.query);
          const cols = Array.isArray(args.columns)
            ? (args.columns as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 50)
            : [];
          if (cols.length === 0) throw new ToolError('Provide at least one field name in "columns" (see the fields tool)');
          const grouped = args.grouped === true;
          const order = args.order === 'desc' ? 'desc' : 'asc';
          const limit = clampLimit(args.limit, 100);
          const offset = intArg(args.offset, 0);
          let total: number;
          let durationMs: number;
          try {
            ({ total, durationMs } = await this.ensureSearch(s, query, grouped, false));
          } catch (err) {
            if (err instanceof QuerySyntaxError) throw new ToolError(err.message);
            throw err;
          }
          const fetched = await s.getRows(offset, limit, order, false, grouped, cols);
          const rows = fetched.map((r) => [
            r.lineNo,
            r.ts !== null ? new Date(r.ts).toISOString() : null,
            r.level,
            ...cols.map((c) => r.cols?.[c] ?? null),
          ]);
          return {
            sessionId: s.id,
            query,
            total,
            durationMs,
            offset,
            returned: rows.length,
            order,
            grouped,
            columns: ['lineNo', 'ts', 'level', ...cols],
            rows,
          };
        },
      },

      {
        name: 'get_lines',
        description:
          'Read a contiguous range of raw lines [start, start+count) by line number, ignoring any active search. ' +
          'Use it to browse, or to read the tail (start = lineCount - count). Line numbers are 0-based.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session to read from.'),
            start: prop('integer', 'First line number (0-based).', { default: 0 }),
            count: prop('integer', 'How many lines to read (1–500).', { default: 50 }),
          },
          required: ['sessionId'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const count = clampLimit(args.count, 50);
          const start = Math.min(intArg(args.start, 0), Math.max(0, s.lineCount - 1));
          const end = Math.min(start + count, s.lineCount);
          const lineNos = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
          const rows = await s.readRowsForExport(lineNos);
          return { sessionId: s.id, start, count: rows.length, lineCount: s.lineCount, rows: rows.map((r) => this.row(r)) };
        },
      },

      {
        name: 'get_context',
        description:
          'Return the lines surrounding a given line (like grep -C), with the line numbers that match the active search ' +
          'flagged. Useful after a search hit to see what led up to it.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session.'),
            lineNo: prop('integer', 'The center line (0-based).'),
            before: prop('integer', 'Lines of context before.', { default: 5 }),
            after: prop('integer', 'Lines of context after.', { default: 5 }),
          },
          required: ['sessionId', 'lineNo'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const lineNo = intArg(args.lineNo, 0);
          const before = Math.min(intArg(args.before, 5), 200);
          const after = Math.min(intArg(args.after, 5), 200);
          const ctx = await s.getContext(lineNo, before, after);
          return {
            sessionId: s.id,
            center: ctx.center,
            matchLines: ctx.matchLines,
            rows: ctx.rows.map((r) => this.row(r)),
          };
        },
      },

      {
        name: 'get_record',
        description:
          "Return one line's parsed detail: timestamp, level, extracted fields (flattened dot.paths for JSON), and — when the line " +
          'heads a multi-line record (e.g. a stack trace) — the full record text.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session.'),
            lineNo: prop('integer', 'The line number (0-based).'),
          },
          required: ['sessionId', 'lineNo'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const detail = await s.getDetail(intArg(args.lineNo, 0));
          if (!detail) throw new ToolError('Line out of range');
          return {
            sessionId: s.id,
            lineNo: detail.lineNo,
            ts: detail.ts !== null ? new Date(detail.ts).toISOString() : null,
            level: detail.level,
            fields: detail.fields,
            record: detail.record,
            raw: detail.raw,
          };
        },
      },

      {
        name: 'fields',
        description: 'List the structured fields detected across the file, with occurrence counts (most common first).',
        inputSchema: {
          type: 'object',
          properties: { sessionId: prop('string', 'The session.') },
          required: ['sessionId'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          return { sessionId: s.id, fields: s.status().fieldNames };
        },
      },

      {
        name: 'facet',
        description:
          "Break down one field's top values with counts. By default it covers the current view (the active search result set, " +
          'or the whole file when there is no search); pass query to scope it directly (query:"" for the whole file). Numeric ' +
          'coverage is reported so you can tell whether a range view would apply.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session.'),
            field: prop('string', 'Field name (e.g. status, http.status, host).'),
            query: prop('string', 'Optional query to scope this facet to (query language). Omit to use the active search/whole file; "" forces the whole file.'),
            limit: prop('integer', 'Max distinct values to return (1–500).', { default: 25 }),
          },
          required: ['sessionId', 'field'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const field = str(args.field);
          if (!field) throw new ToolError('Missing "field"');
          await this.scopeView(s, args.query);
          return s.facet(field, clampLimit(args.limit, 25));
        },
      },

      {
        name: 'stats',
        description:
          'Summary statistics: total rows, how many have a timestamp, the time span, peak lines/min, the per-level breakdown, ' +
          'and the top structured fields with their common values. Covers the current view by default; pass query to scope it ' +
          'directly (query:"" for the whole file).',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session.'),
            query: prop('string', 'Optional query to scope these stats to (query language). Omit to use the active search/whole file; "" forces the whole file.'),
            grouped: prop('boolean', 'Count multi-line records instead of physical lines.', { default: false }),
          },
          required: ['sessionId'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          await this.scopeView(s, args.query);
          return s.stats(args.grouped === true);
        },
      },

      {
        name: 'histogram',
        description:
          'Time histogram of log volume, split per level. Buckets cover the data span; each has a start timestamp and per-level ' +
          'counts — useful for spotting spikes and gaps. Covers the current view by default; pass query to scope it directly ' +
          '(query:"" for the whole file). Returns null when no line has a timestamp.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session.'),
            query: prop('string', 'Optional query to scope this histogram to (query language). Omit to use the active search/whole file; "" forces the whole file.'),
            maxBuckets: prop('integer', 'Max time buckets to return (1–500). Fewer = coarser and more compact.', { default: 50 }),
          },
          required: ['sessionId'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          await this.scopeView(s, args.query);
          const h = s.histogram(clampLimit(args.maxBuckets, 50));
          if (!h) return { histogram: null };
          return {
            minTs: new Date(h.minTs).toISOString(),
            maxTs: new Date(h.maxTs).toISOString(),
            bucketMs: h.bucketMs,
            withoutTs: h.withoutTs,
            buckets: h.buckets.map((b) => ({ start: new Date(b.start).toISOString(), total: b.total, counts: b.counts })),
          };
        },
      },

      {
        name: 'clusters',
        description:
          'Top log patterns (templates) by count — variable parts (numbers, ids, timestamps) are masked so similar lines collapse ' +
          'into one pattern. The fastest way to see "what kinds of lines are in here". Covers the current view by default; pass ' +
          'query to scope it directly (query:"" for the whole file).',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session.'),
            query: prop('string', 'Optional query to scope these clusters to (query language). Omit to use the active search/whole file; "" forces the whole file.'),
            limit: prop('integer', 'Max patterns to return (1–500).', { default: 50 }),
          },
          required: ['sessionId'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          await this.scopeView(s, args.query);
          return s.clusters(clampLimit(args.limit, 50));
        },
      },

      {
        name: 'build_report',
        description:
          'Assemble an investigation report (Markdown) from your findings and deliver it to the user. Provide a title, a ' +
          'summary (the headline conclusion), and ordered sections — each a heading + Markdown narrative, with optional cited ' +
          'evidence. Cite evidence by line number (lines) or ranges; TraceBox pulls the REAL indexed lines (with their ' +
          'timestamp and level) so the quoted log lines are authoritative, not paraphrased. Returns the rendered Markdown; pass ' +
          'savePath to also write it to a file. Choose format "markdown" (default, for chat/tickets) or "html" (a standalone, ' +
          'self-styled file to save and open). Use this as the final step after searching/inspecting to summarize what you found.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: prop('string', 'The session the evidence lines are read from.'),
            title: prop('string', 'Report title (e.g. "Checkout 503s — root cause").'),
            summary: prop('string', 'Markdown summary: the headline finding / conclusion (the TL;DR).'),
            format: prop('string', 'Output format.', { enum: ['markdown', 'html'], default: 'markdown' }),
            sections: {
              type: 'array',
              description: 'Ordered findings, each a heading + Markdown body with optional cited evidence lines.',
              items: {
                type: 'object',
                properties: {
                  heading: prop('string', 'Section heading.'),
                  body: prop('string', 'Markdown narrative explaining this finding.'),
                  lines: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Line numbers (0-based) to include verbatim as evidence.',
                  },
                  ranges: {
                    type: 'array',
                    description: 'Line ranges to include as evidence (e.g. a multi-line stack trace).',
                    items: {
                      type: 'object',
                      properties: {
                        start: prop('integer', 'First line (0-based).'),
                        count: prop('integer', 'How many lines (1–500).'),
                      },
                      required: ['start', 'count'],
                    },
                  },
                },
                required: ['heading'],
              },
            },
            savePath: prop('string', 'Optional absolute path to also write the report to (e.g. C:\\\\reports\\\\incident.md).'),
          },
          required: ['sessionId', 'title', 'sections'],
        },
        handler: async (args) => {
          const s = this.getSession(args);
          const sectionsIn = Array.isArray(args.sections) ? args.sections : [];
          if (sectionsIn.length === 0) throw new ToolError('Provide at least one section');

          // Resolve cited line numbers/ranges to real indexed lines, capped so a
          // report can't pull the whole file.
          const MAX_TOTAL = 1000;
          let budget = MAX_TOTAL;
          const sections: ReportSection[] = [];
          for (const raw of sectionsIn) {
            const r = (raw ?? {}) as Record<string, unknown>;
            const lineNos: number[] = [];
            if (Array.isArray(r.lines)) {
              for (const n of r.lines) {
                const v = Number(n);
                if (Number.isFinite(v)) lineNos.push(Math.trunc(v));
              }
            }
            if (Array.isArray(r.ranges)) {
              for (const rng of r.ranges) {
                const o = (rng ?? {}) as Record<string, unknown>;
                const start = intArg(o.start, -1);
                const count = Math.min(Math.max(intArg(o.count, 0), 0), 500);
                if (start >= 0) for (let i = 0; i < count; i++) lineNos.push(start + i);
              }
            }
            const uniq = [...new Set(lineNos)].filter((n) => n >= 0 && n < s.lineCount).slice(0, Math.max(0, budget));
            budget -= uniq.length;
            const rows = uniq.length > 0 ? await s.readRowsForExport(uniq) : [];
            sections.push({
              heading: str(r.heading),
              body: str(r.body),
              evidence: rows.map((row) => ({ lineNo: row.lineNo, text: row.text, ts: row.ts, level: row.level, truncated: row.truncated })),
            });
          }

          const st = s.status();
          const doc = {
            title: str(args.title),
            summary: str(args.summary),
            source: { file: st.file, lineCount: st.lineCount },
            generatedAt: Date.now(),
            sections,
          };
          const format = args.format === 'html' ? 'html' : 'markdown';
          const content = format === 'html' ? renderReportHtml(doc) : renderReportMarkdown(doc);

          let savedPath: string | null = null;
          const save = str(args.savePath);
          if (save) {
            const resolved = path.resolve(save);
            try {
              writeFileSync(resolved, content);
              savedPath = resolved;
            } catch (err) {
              throw new ToolError(`Could not write report to ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return { sessionId: s.id, format, savedPath, sections: sections.length, evidenceLines: MAX_TOTAL - budget, content };
        },
      },

      {
        name: 'list_parsers',
        description:
          'List the user-defined custom parsers (name + regex) currently configured. They extend format auto-detection beyond the built-in formats.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ parsers: getConfig().parsers }),
      },

      {
        name: 'test_parser',
        description:
          'Dry-run a regex against sample lines and show what it would extract (timestamp, level, fields) — a live tester for ' +
          'building a custom parser before saving it. Provide samples directly, or a sessionId to test against the head of an ' +
          'open log. Named groups timestamp/level/message are metadata; every other named group becomes a field.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: prop('string', 'The regex to test, with named capture groups.'),
            samples: { type: 'array', items: { type: 'string' }, description: 'Sample lines to test against.' },
            sessionId: prop('string', 'Instead of samples, test against the first lines of this open session.'),
            count: prop('integer', 'How many head lines to read when sessionId is given (1–50).', { default: 5 }),
          },
          required: ['pattern'],
        },
        handler: async (args) => {
          const pattern = str(args.pattern);
          if (!pattern) throw new ToolError('Missing "pattern"');
          const v = validateParser({ name: 'test', pattern });
          if (!v.ok) throw new ToolError(v.error);
          const parser = new RegexParser('test', new RegExp(pattern));
          let samples: string[];
          if (Array.isArray(args.samples) && args.samples.length > 0) {
            samples = (args.samples as unknown[]).filter((x): x is string => typeof x === 'string');
          } else {
            const s = this.getSession(args);
            const count = Math.min(clampLimit(args.count, 5), 50);
            const lineNos = Array.from({ length: Math.min(count, s.lineCount) }, (_, i) => i);
            const rows = await s.readRowsForExport(lineNos);
            samples = rows.map((r) => r.text);
          }
          const results = samples.map((line) => {
            const p = parser.parse(line);
            return {
              line,
              matched: parser.startsRecord(line),
              ts: p.ts !== null ? new Date(p.ts).toISOString() : null,
              level: p.level,
              fields: p.fields ?? {},
            };
          });
          return { matched: results.filter((r) => r.matched).length, total: results.length, results };
        },
      },

      {
        name: 'add_parser',
        description:
          'Define (or replace, by name) a custom log format: a regex with named capture groups. timestamp, level (or level2), ' +
          'and message groups are metadata; every other named group becomes a queryable field. The parser is persisted and joins ' +
          'auto-detection — reopen a log with open_log for it to take effect (this re-indexes the file). Tip: capture numbers ' +
          'without their unit, e.g. (?<duration>\\d+)ms, so numeric comparisons like duration:>5000 work.',
        inputSchema: {
          type: 'object',
          properties: {
            name: prop('string', 'A unique name for the format (e.g. "myapp").'),
            pattern: prop('string', 'A JavaScript regex with named groups, e.g. ^(?<timestamp>\\S+) (?<level>\\w+) (?<message>.*)$'),
          },
          required: ['name', 'pattern'],
        },
        handler: async (args) => {
          const name = str(args.name);
          const pattern = str(args.pattern);
          try {
            const cfg = addParser({ name, pattern });
            return {
              ok: true,
              parsers: cfg.parsers,
              note: 'Saved. Reopen the log with open_log to (re)index it using this parser.',
            };
          } catch (err) {
            throw new ToolError(err instanceof Error ? err.message : String(err));
          }
        },
      },

      {
        name: 'remove_parser',
        description: 'Remove a custom parser by name. Reopen affected logs to re-index them with the built-in detection.',
        inputSchema: {
          type: 'object',
          properties: { name: prop('string', 'The parser name to remove.') },
          required: ['name'],
        },
        handler: async (args) => ({ ok: removeParser(str(args.name)) }),
      },
    ];
  }
}

/** A protocol-level invalid-params error (becomes a JSON-RPC error, not a tool result). */
class JsonRpcParamError extends Error {}

/** Parse a raw JSON-RPC line; throws on malformed JSON so the caller can return a parse error. */
export function parseMessage(line: string): JsonRpcRequest {
  return JSON.parse(line) as JsonRpcRequest;
}

export { PARSE_ERROR, INVALID_REQUEST };
