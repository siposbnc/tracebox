import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CaptureError,
  compileCapture,
  compileCaptures,
  extractCapture,
  globToRegExp,
} from './captureField.ts';

test('extracts the named group matching the field name', () => {
  const cap = compileCapture({ name: 'dur', pattern: '(?<dur>\\d+)ms' });
  assert.equal(extractCapture(cap, 'GET /api done in 1280ms ok'), '1280');
});

test('falls back to the first capturing group, then the whole match', () => {
  const firstGroup = compileCapture({ name: 'dur', pattern: '(\\d+)ms' });
  assert.equal(extractCapture(firstGroup, 'took 42ms'), '42');

  const wholeMatch = compileCapture({ name: 'code', pattern: '\\d{3}' });
  assert.equal(extractCapture(wholeMatch, 'status 503 here'), '503');
});

test('returns undefined when the pattern does not match', () => {
  const cap = compileCapture({ name: 'dur', pattern: '(?<dur>\\d+)ms' });
  assert.equal(extractCapture(cap, 'no duration here'), undefined);
});

test('extraction is verbatim/case-sensitive and stateless across calls', () => {
  const cap = compileCapture({ name: 'id', pattern: 'ID=(?<id>[A-Za-z0-9]+)' });
  assert.equal(extractCapture(cap, 'req ID=Ab12 done'), 'Ab12');
  // a global flag would advance lastIndex and break a second call — compile drops flags
  assert.equal(extractCapture(cap, 'req ID=Ab12 done'), 'Ab12');
});

test('rejects an invalid field name', () => {
  assert.throws(() => compileCapture({ name: '1bad', pattern: '\\d+' }), CaptureError);
  assert.throws(() => compileCapture({ name: 'a-b', pattern: '\\d+' }), CaptureError);
});

test('rejects an unparseable pattern', () => {
  assert.throws(() => compileCapture({ name: 'dur', pattern: '(' }), CaptureError);
});

test('compileCaptures keys by lower-cased name', () => {
  const map = compileCaptures([{ name: 'Dur', pattern: '(\\d+)ms' }]);
  assert.ok(map.has('dur'));
  assert.equal(map.size, 1);
});

test('globToRegExp matches case-insensitively with wildcards', () => {
  const re = globToRegExp('GET*api*');
  assert.ok(re.test('get /v1/api/users'));
  assert.ok(!re.test('post /api'));
  // anchored to the whole value
  assert.ok(!globToRegExp('api').test('the api call'));
});
