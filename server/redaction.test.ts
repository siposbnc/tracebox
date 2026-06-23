import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRedactor, redactorFromQuery } from './redaction.ts';

test('masks built-in categories', () => {
  const r = buildRedactor({});
  assert.equal(r('user alice@example.com'), 'user [email]');
  assert.equal(r('from 10.0.0.5 ok'), 'from [ip] ok');
  assert.equal(r('host fe80::1ff:fe23:4567:890a'), 'host [ip]');
  assert.equal(r('password=hunter2 here'), 'password=[secret] here');
  // the key/value rule masks "Bearer", the catch-all masks the remaining token —
  // doubly redundant but nothing leaks
  assert.equal(r('Authorization: Bearer sk_live_abcDEF123456'), 'Authorization: [secret] [token]');
  assert.equal(r('card 4111 1111 1111 1111 paid'), 'card [card] paid');
});

test('card masking respects a Luhn check', () => {
  const r = buildRedactor({});
  assert.equal(r('card 4111111111111111 ok'), 'card [card] ok'); // valid Luhn (Visa test)
  assert.equal(r('num 1111111111111111 ok'), 'num 1111111111111111 ok'); // fails Luhn → untouched
});

test('disabled categories are not applied', () => {
  const r = buildRedactor({ disabled: ['email', 'ipv4'] });
  assert.equal(r('alice@example.com at 10.0.0.5'), 'alice@example.com at 10.0.0.5');
  // other categories still apply
  assert.equal(r('password=secret'), 'password=[secret]');
});

test('custom patterns mask with their label', () => {
  const r = buildRedactor({ disabled: ['token'], custom: [{ label: 'userid', pattern: 'cust_[0-9]+' }] });
  assert.equal(r('order for cust_4821 done'), 'order for [userid] done');
});

test('invalid custom patterns are skipped, not fatal', () => {
  const r = buildRedactor({ custom: [{ label: 'bad', pattern: '(' }] });
  assert.equal(r('alice@example.com'), '[email]');
});

test('redactorFromQuery is null unless redact=1', () => {
  assert.equal(redactorFromQuery(new URLSearchParams('')), null);
  const r = redactorFromQuery(new URLSearchParams('redact=1&rdisabled=ipv4'));
  assert.ok(r);
  assert.equal(r('mail x@y.com ip 10.0.0.5'), 'mail [email] ip 10.0.0.5');
});
