import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JsonParser,
  LogfmtParser,
  RawParser,
  RegexParser,
  detectFormat,
  looksLikeContinuation,
  normalizeLevel,
  parseTimestamp,
  templateOf,
} from './parsers.ts';

test('normalizeLevel maps common variants', () => {
  assert.equal(normalizeLevel('warning'), 'WARN');
  assert.equal(normalizeLevel('ERR'), 'ERROR');
  assert.equal(normalizeLevel('Critical'), 'FATAL');
  assert.equal(normalizeLevel('information'), 'INFO');
  assert.equal(normalizeLevel('weird'), null);
  assert.equal(normalizeLevel(null), null);
});

test('parseTimestamp handles common formats as UTC', () => {
  assert.equal(parseTimestamp('2024-01-31 13:45:01'), Date.UTC(2024, 0, 31, 13, 45, 1));
  assert.equal(parseTimestamp('2024-01-31T13:45:01.500Z'), Date.UTC(2024, 0, 31, 13, 45, 1, 500));
  assert.equal(parseTimestamp('2024-01-31T13:45:01+02:00'), Date.UTC(2024, 0, 31, 11, 45, 1));
  assert.equal(parseTimestamp('31/Jan/2024:13:45:01 +0000'), Date.UTC(2024, 0, 31, 13, 45, 1));
  assert.equal(parseTimestamp('1706708701'), 1706708701000);
  assert.equal(parseTimestamp('1706708701000'), 1706708701000);
  assert.equal(parseTimestamp('not a date'), null);
});

test('JsonParser extracts and flattens fields', () => {
  const p = new JsonParser();
  const r = p.parse(
    '{"timestamp":"2024-01-31T13:45:01Z","level":"warning","message":"disk low","ctx":{"host":"web1","disk":{"free":12}},"tags":["a","b"]}',
  );
  assert.equal(r.ts, Date.UTC(2024, 0, 31, 13, 45, 1));
  assert.equal(r.level, 'WARN');
  assert.equal(r.message, 'disk low');
  assert.equal(r.fields?.['ctx.host'], 'web1');
  assert.equal(r.fields?.['ctx.disk.free'], '12');
  assert.equal(r.fields?.['tags[0]'], 'a');
});

test('JsonParser falls back gracefully on invalid JSON', () => {
  const r = new JsonParser().parse('not json at all ERROR something');
  assert.equal(r.level, 'ERROR');
  assert.equal(r.fields, null);
});

test('LogfmtParser parses key=value pairs', () => {
  const r = new LogfmtParser().parse('time=2024-01-31T13:45:01Z level=info msg="hello world" count=42');
  assert.equal(r.ts, Date.UTC(2024, 0, 31, 13, 45, 1));
  assert.equal(r.level, 'INFO');
  assert.equal(r.message, 'hello world');
  assert.equal(r.fields?.count, '42');
});

test('RawParser sniffs level and timestamp', () => {
  const r = new RawParser().parse('some text 2024-01-31 13:45:01 stuff WARNING happened');
  assert.equal(r.level, 'WARN');
  assert.equal(r.ts, Date.UTC(2024, 0, 31, 13, 45, 1));
});

test('detectFormat picks json for JSON lines', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `{"level":"info","message":"m${i}","n":${i}}`);
  assert.equal(detectFormat(lines).name, 'json');
});

test('detectFormat picks timestamped for classic app logs', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `2024-01-31 13:45:${String(i % 60).padStart(2, '0')} [INFO] message ${i}`);
  const parser = detectFormat(lines);
  assert.equal(parser.name, 'timestamped');
  const r = parser.parse(lines[0]);
  assert.equal(r.level, 'INFO');
  assert.equal(r.message, 'message 0');
});

test('detectFormat picks access log format', () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `192.168.1.${i} - alice [31/Jan/2024:13:45:01 +0000] "GET /api/items HTTP/1.1" 200 ${100 + i}`,
  );
  const parser = detectFormat(lines);
  assert.equal(parser.name, 'access');
  const r = parser.parse(lines[0]);
  assert.equal(r.fields?.status, '200');
  assert.equal(r.fields?.method, 'GET');
  assert.equal(r.ts, Date.UTC(2024, 0, 31, 13, 45, 1));
});

test('detectFormat picks syslog', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `Jan 31 13:45:0${i % 10} myhost sshd[1234]: accepted connection ${i}`);
  const parser = detectFormat(lines);
  assert.equal(parser.name, 'syslog');
  const r = parser.parse(lines[0]);
  assert.equal(r.fields?.host, 'myhost');
  assert.equal(r.fields?.pid, '1234');
});

test('detectFormat falls back to raw on plain text', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `free text line number ${i} with nothing special`);
  assert.equal(detectFormat(lines).name, 'raw');
});

test('looksLikeContinuation flags wrapped / stack-trace lines', () => {
  assert.equal(looksLikeContinuation('    at com.app.Service.handle(Service.java:42)'), true);
  assert.equal(looksLikeContinuation('\tat com.app.Worker.run(Worker.java:88)'), true);
  assert.equal(looksLikeContinuation('Caused by: java.lang.NullPointerException'), true);
  assert.equal(looksLikeContinuation('... 26 more'), true);
  assert.equal(looksLikeContinuation(''), true);
  assert.equal(looksLikeContinuation('a normal unindented message'), false);
});

test('templateOf masks variable tokens so similar lines share a pattern', () => {
  const a = templateOf('2024-01-01 00:00:01 [INFO] GET /api/users/42 200 in 13ms');
  const b = templateOf('2024-01-01 09:15:33 [INFO] GET /api/users/9001 200 in 5ms');
  assert.equal(a, b); // same shape despite different ids/times/durations
  assert.match(a, /\[INFO\] GET/);
  assert.match(a, /<\*>/);

  // different status / message shape → different template
  assert.notEqual(templateOf('[ERROR] connection failed to db-1'), a);

  // runs of variable tokens collapse to a single placeholder
  assert.equal(templateOf('id 1 2 3 done'), 'id <*> done');
});

test('startsRecord distinguishes record heads from continuations', () => {
  // timestamped app log: the dated line starts a record, the stack frames continue it
  const ts = detectFormat(['2024-01-31 13:45:01 [ERROR] boom']);
  assert.equal(ts.name, 'timestamped');
  assert.equal(ts.startsRecord('2024-01-31 13:45:01 [ERROR] boom'), true);
  assert.equal(ts.startsRecord('    at com.app.Foo(Foo.java:1)'), false);
  assert.equal(ts.startsRecord('java.lang.RuntimeException: boom'), false);

  // raw parser uses indentation / markers
  const raw = new RawParser();
  assert.equal(raw.startsRecord('something happened'), true);
  assert.equal(raw.startsRecord('   continued detail'), false);

  // json: a fresh object starts a record; a pretty-printed body line continues it
  const json = new JsonParser();
  assert.equal(json.startsRecord('{"level":"info"}'), true);
  assert.equal(json.startsRecord('  "level": "info",'), false);

  // a hand-built regex parser delegates to its pattern
  const rx = new RegexParser('t', /^\d{4}-\d{2}-\d{2}/);
  assert.equal(rx.startsRecord('2024-01-31 hi'), true);
  assert.equal(rx.startsRecord('  indented'), false);
});
