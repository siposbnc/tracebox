import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from './mcp.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'tracebox-mcp-'));
// isolate custom-parser config to a temp dir so tests never touch ~/.tracebox
const cfgDir = mkdtempSync(path.join(tmpdir(), 'tracebox-cfg-'));
process.env.TRACEBOX_CONFIG_DIR = cfgDir;
const server = new McpServer();

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

function appLogLines(n: number): string[] {
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'];
  // logfmt so structured fields (status, worker, …) are extracted and queryable
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * 1000).toISOString();
    return `timestamp=${ts} level=${levels[i % levels.length]} worker=worker-${i % 7} request=${i} took=${i % 900} status=${i % 2 ? 200 : 500}`;
  });
}

let reqId = 0;
async function rpc(method: string, params?: object): Promise<any> {
  return server.handle({ jsonrpc: '2.0', id: ++reqId, method, params } as any);
}

/** tools/call helper: returns the parsed JSON payload, or throws with the error text on isError. */
async function call(name: string, args: object): Promise<any> {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.result;
  assert.ok(result, `tools/call ${name} returned no result: ${JSON.stringify(res)}`);
  const text = result.content[0].text as string;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

function makeLog(name: string, lines: string[]): string {
  const file = path.join(dir, name);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('initialize negotiates protocol and advertises the tool capability', async () => {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(res.result.serverInfo.name, 'tracebox');
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.ok(res.result.capabilities.tools);
  // a notification gets no response
  const note = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);
  assert.equal(note, null);
});

test('tools/list exposes the toolkit', async () => {
  const res = await rpc('tools/list');
  const names = res.result.tools.map((t: any) => t.name);
  for (const expected of ['open_log', 'list_sessions', 'close_log', 'search', 'get_lines', 'get_context', 'get_record', 'fields', 'facet', 'stats', 'histogram', 'clusters', 'list_parsers', 'test_parser', 'add_parser', 'remove_parser']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // every tool has a JSON-schema input
  for (const t of res.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('open_log indexes a file and search/get_lines/context/stats work over it', async () => {
  const file = makeLog('app.log', appLogLines(600));
  const opened = await call('open_log', { path: file });
  assert.equal(opened.lineCount, 600);
  assert.equal(opened.format, 'logfmt');
  assert.ok(opened.sessionId);
  const sessionId = opened.sessionId;

  // level filter — every 6th line starting at index 4 is ERROR
  const errs = await call('search', { sessionId, query: 'level:ERROR' });
  assert.equal(errs.total, Math.floor(600 / 6));
  assert.ok(errs.rows.length > 0);
  assert.equal(errs.rows[0].level, 'ERROR');
  assert.match(errs.rows[0].text, /request=4 /);

  // numeric comparison via a field
  const s500 = await call('search', { sessionId, query: 'status:500' });
  assert.equal(s500.total, 300);

  // paging: offset advances into the result set
  const page2 = await call('search', { sessionId, query: 'level:ERROR', offset: 5, limit: 3 });
  assert.equal(page2.offset, 5);
  assert.equal(page2.rows.length, 3);

  // get_lines browses raw lines regardless of the active search
  const lines = await call('get_lines', { sessionId, start: 0, count: 3 });
  assert.equal(lines.rows.length, 3);
  assert.equal(lines.rows[0].lineNo, 0);

  // get_context centers on a line and flags matches
  const ctx = await call('get_context', { sessionId, lineNo: 10, before: 2, after: 2 });
  assert.equal(ctx.center, 10);
  assert.deepEqual(ctx.rows.map((r: any) => r.lineNo), [8, 9, 10, 11, 12]);

  // get_record exposes parsed fields
  const rec = await call('get_record', { sessionId, lineNo: 4 });
  assert.equal(rec.level, 'ERROR');
  assert.ok(rec.fields.some((f: any) => f.key === 'status'));

  // aggregates reflect the current view — clear the search to summarize the whole file
  await call('search', { sessionId, query: '' });

  // stats + fields + clusters
  const stats = await call('stats', { sessionId });
  assert.equal(stats.total, 600);
  assert.ok(stats.levels.find((l: any) => l.level === 'ERROR'));
  const fields = await call('fields', { sessionId });
  assert.ok(fields.fields.some((f: any) => f.key === 'status'));
  const clusters = await call('clusters', { sessionId, limit: 10 });
  assert.ok(clusters.patterns.length > 0);

  const sessions = await call('list_sessions', {});
  assert.ok(sessions.sessions.some((s: any) => s.sessionId === sessionId));

  const closed = await call('close_log', { sessionId });
  assert.equal(closed.ok, true);
});

test('aggregates take an optional query to scope themselves (stateless), without a prior search', async () => {
  const file = makeLog('agg.log', appLogLines(600));
  const opened = await call('open_log', { path: file });
  const sessionId = opened.sessionId;

  // no search has been run; query scopes the aggregate directly
  const errStats = await call('stats', { sessionId, query: 'level:ERROR' });
  assert.equal(errStats.total, 100); // every 6th line is ERROR

  // clusters scoped to the 500s — every masked pattern should be a status=500 line
  const c500 = await call('clusters', { sessionId, query: 'status:500' });
  assert.ok(c500.patterns.length > 0);
  assert.equal(c500.covered, 300);

  // facet with query:"" covers the whole file regardless of the active search
  const f = await call('facet', { sessionId, field: 'status', query: '' });
  assert.equal(f.covered, 600);
  assert.equal(f.values.find((v: any) => v.value === '500').count, 300);

  // omitting query reuses the active search — here it is now status:"" (whole file)
  const allStats = await call('stats', { sessionId });
  assert.equal(allStats.total, 600);

  await call('close_log', { sessionId });
});

test('histogram caps the number of buckets it returns', async () => {
  const file = makeLog('hist.log', appLogLines(600));
  const opened = await call('open_log', { path: file });
  const sessionId = opened.sessionId;

  const small = await call('histogram', { sessionId, maxBuckets: 10 });
  assert.ok(small.buckets.length <= 10, `expected ≤10 buckets, got ${small.buckets.length}`);

  const dflt = await call('histogram', { sessionId });
  assert.ok(dflt.buckets.length <= 50, `default should cap at 50, got ${dflt.buckets.length}`);

  await call('close_log', { sessionId });
});

// A proprietary format the built-in parsers can't field-extract (level first,
// no key=value, no bracketed/access/syslog shape) → needs a custom parser.
function proprietaryLines(n: number): string[] {
  const levels = ['INFO', 'WARN', 'ERROR'];
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * 1000).toISOString();
    return `${levels[i % 3]} ${ts} api-${i % 3} handled request ${1000 + i} in ${i * 5}ms`;
  });
}

const CUSTOM_PATTERN =
  '^(?<level>\\w+) (?<timestamp>\\S+) (?<service>\\S+) handled request (?<req>\\d+) in (?<dur>\\d+)ms$';

test('test_parser dry-runs a regex and shows extracted fields', async () => {
  const out = await call('test_parser', { pattern: CUSTOM_PATTERN, samples: proprietaryLines(3) });
  assert.equal(out.total, 3);
  assert.equal(out.matched, 3);
  assert.equal(out.results[0].level, 'INFO');
  assert.equal(out.results[0].fields.service, 'api-0');
  assert.equal(out.results[0].fields.dur, '0');
  // an invalid / group-less pattern is rejected
  await assert.rejects(call('test_parser', { pattern: 'no groups here' }), /named capture group/);
});

test('add_parser teaches open_log a proprietary format, then fields are queryable', async () => {
  const file = makeLog('custom.log', proprietaryLines(20));

  // without a custom parser the format is unrecognized (no structured fields)
  const before = await call('open_log', { path: file });
  assert.equal(before.format, 'raw');
  await call('close_log', { sessionId: before.sessionId });

  // define the parser, then reopen — adding a parser changes the index fingerprint,
  // so the same path re-indexes with the new format instead of reusing the stale index
  const added = await call('add_parser', { name: 'myfmt', pattern: CUSTOM_PATTERN });
  assert.equal(added.ok, true);
  assert.ok(added.parsers.some((p: any) => p.name === 'myfmt'));

  const opened = await call('open_log', { path: file });
  assert.equal(opened.format, 'myfmt');
  assert.ok(opened.fields.some((f: any) => f.key === 'service'));
  const sessionId = opened.sessionId;

  // numeric comparison works because the parser captures the bare number (no "ms")
  const slow = await call('search', { sessionId, query: 'dur:>40' });
  assert.equal(slow.total, 11); // dur = i*5 for i in 9..19

  // and the extracted field facets
  const f = await call('facet', { sessionId, field: 'service', query: '' });
  assert.equal(f.covered, 20);
  assert.equal(f.distinctCount, 3);

  await call('close_log', { sessionId });

  // cleanup: removing the parser is reflected in the config
  const removed = await call('remove_parser', { name: 'myfmt' });
  assert.equal(removed.ok, true);
  const list = await call('list_parsers', {});
  assert.ok(!list.parsers.some((p: any) => p.name === 'myfmt'));
});

test('protocol and tool errors are reported the right way', async () => {
  // unknown method → JSON-RPC method-not-found
  const unknown = await rpc('does/not/exist');
  assert.equal(unknown.error.code, -32601);

  // unknown tool → invalid params
  const badTool = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(badTool.error.code, -32602);

  // a tool failure (unknown session) comes back as an isError result, not a transport error
  const res = await rpc('tools/call', { name: 'search', arguments: { sessionId: 'ghost', query: 'x' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown sessionId/);

  // a query syntax error is also an isError result
  const file = makeLog('app2.log', appLogLines(20));
  const opened = await call('open_log', { path: file });
  const bad = await rpc('tools/call', { name: 'search', arguments: { sessionId: opened.sessionId, query: 'level:(' } });
  assert.equal(bad.result.isError, true);
});
