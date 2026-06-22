import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, QuerySyntaxError } from './queryParser.ts';
import { parseTsRange } from './queryCompiler.ts';

test('bare word is a text term', () => {
  assert.deepEqual(parseQuery('error'), { type: 'text', value: 'error', phrase: false });
});

test('quoted string is a phrase', () => {
  assert.deepEqual(parseQuery('"connection failed"'), {
    type: 'text',
    value: 'connection failed',
    phrase: true,
  });
});

test('implicit AND between terms', () => {
  const q = parseQuery('error database');
  assert.equal(q.type, 'and');
  assert.equal((q as { children: unknown[] }).children.length, 2);
});

test('explicit AND / OR with precedence (AND binds tighter)', () => {
  const q = parseQuery('a AND b OR c');
  assert.equal(q.type, 'or');
  const or = q as { children: { type: string }[] };
  assert.equal(or.children[0].type, 'and');
  assert.equal(or.children[1].type, 'text');
});

test('parentheses override precedence', () => {
  const q = parseQuery('a AND (b OR c)');
  assert.equal(q.type, 'and');
  const and = q as { children: { type: string }[] };
  assert.equal(and.children[0].type, 'text');
  assert.equal(and.children[1].type, 'or');
});

test('NOT and dash negation', () => {
  assert.deepEqual(parseQuery('NOT error'), {
    type: 'not',
    child: { type: 'text', value: 'error', phrase: false },
  });
  assert.deepEqual(parseQuery('-error'), {
    type: 'not',
    child: { type: 'text', value: 'error', phrase: false },
  });
});

test('field queries with operators', () => {
  assert.deepEqual(parseQuery('level:error'), { type: 'field', field: 'level', op: 'eq', value: 'error' });
  assert.deepEqual(parseQuery('status:>=500'), { type: 'field', field: 'status', op: 'gte', value: '500' });
  assert.deepEqual(parseQuery('status:<400'), { type: 'field', field: 'status', op: 'lt', value: '400' });
  assert.deepEqual(parseQuery('ts:>2024-01-01'), { type: 'field', field: 'ts', op: 'gt', value: '2024-01-01' });
});

test('field with quoted phrase value', () => {
  assert.deepEqual(parseQuery('message:"connection failed"'), {
    type: 'field',
    field: 'message',
    op: 'eq',
    value: 'connection failed',
  });
});

test('wildcards and exists', () => {
  assert.deepEqual(parseQuery('path:/api/*'), { type: 'fieldLike', field: 'path', pattern: '/api/*' });
  assert.deepEqual(parseQuery('user:*'), { type: 'exists', field: 'user' });
});

test('field regex with the ~ operator', () => {
  assert.deepEqual(parseQuery('msg:~time.*out'), { type: 'fieldRegex', field: 'msg', pattern: 'time.*out' });
  // quoting carries spaces, parens, and quotes the tokenizer would otherwise split on
  assert.deepEqual(parseQuery('msg:~"(read|write) timeout"'), {
    type: 'fieldRegex',
    field: 'msg',
    pattern: '(read|write) timeout',
  });
  // a leading-slash value is still a wildcard/path value, not a regex
  assert.deepEqual(parseQuery('path:/api/v1'), { type: 'field', field: 'path', op: 'eq', value: '/api/v1' });
});

test('invalid regex and empty regex are syntax errors', () => {
  assert.throws(() => parseQuery('msg:~"(unclosed"'), QuerySyntaxError);
  assert.throws(() => parseQuery('msg:~""'), QuerySyntaxError);
});

test('bare /regex/ is a whole-line regex term', () => {
  assert.deepEqual(parseQuery('/timeout\\d+/'), { type: 'regex', pattern: 'timeout\\d+', flags: '' });
  assert.deepEqual(parseQuery('/foo/i'), { type: 'regex', pattern: 'foo', flags: 'i' });
  // an escaped slash stays inside the pattern
  assert.deepEqual(parseQuery('/a\\/b/'), { type: 'regex', pattern: 'a\\/b', flags: '' });
});

test('whole-line regex composes with the rest of the query', () => {
  const q = parseQuery('level:error AND /timeout\\d+/');
  assert.equal(q.type, 'and');
  const and = q as { children: { type: string }[] };
  assert.equal(and.children[1].type, 'regex');
  assert.deepEqual(parseQuery('NOT /retry/'), {
    type: 'not',
    child: { type: 'regex', pattern: 'retry', flags: '' },
  });
});

test('a slash-bearing value is not mistaken for a regex', () => {
  // a bare path that does not close as /…/ stays a plain term
  assert.deepEqual(parseQuery('/var/log/app'), { type: 'text', value: '/var/log/app', phrase: false });
  // a field value keeps its leading slash (wildcard path), unaffected by regex syntax
  assert.deepEqual(parseQuery('path:/api/*'), { type: 'fieldLike', field: 'path', pattern: '/api/*' });
});

test('an invalid whole-line regex is a syntax error', () => {
  assert.throws(() => parseQuery('/(unclosed/'), QuerySyntaxError);
});

test('complex nested query parses', () => {
  const q = parseQuery('(level:ERROR OR level:WARN) AND NOT (host:web1 status:>=500) "slow query"');
  assert.equal(q.type, 'and');
});

test('syntax errors are reported', () => {
  assert.throws(() => parseQuery('(a OR b'), QuerySyntaxError);
  assert.throws(() => parseQuery('a)'), QuerySyntaxError);
  assert.throws(() => parseQuery('"unterminated'), QuerySyntaxError);
  assert.throws(() => parseQuery('level:'), QuerySyntaxError);
});

test('empty query matches all', () => {
  assert.deepEqual(parseQuery(''), { type: 'all' });
  assert.deepEqual(parseQuery('   '), { type: 'all' });
});

test('parseTsRange granularity follows input precision', () => {
  assert.deepEqual(parseTsRange('2024-01-31'), {
    start: Date.UTC(2024, 0, 31),
    end: Date.UTC(2024, 1, 1),
  });
  assert.deepEqual(parseTsRange('2024-01'), {
    start: Date.UTC(2024, 0, 1),
    end: Date.UTC(2024, 1, 1),
  });
  assert.deepEqual(parseTsRange('2024-01-31T10:30'), {
    start: Date.UTC(2024, 0, 31, 10, 30),
    end: Date.UTC(2024, 0, 31, 10, 31),
  });
  assert.deepEqual(parseTsRange('2024-01-31 10:30:15'), {
    start: Date.UTC(2024, 0, 31, 10, 30, 15),
    end: Date.UTC(2024, 0, 31, 10, 30, 16),
  });
});
