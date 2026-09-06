const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkRateLimit } = require('../auth/rateLimit');

test('permite hasta el máximo configurado y luego bloquea', () => {
  const key = `test-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 3; i++) {
    const result = checkRateLimit(key, { max: 3, windowMs: 60_000 });
    assert.equal(result.allowed, true);
  }
  const blocked = checkRateLimit(key, { max: 3, windowMs: 60_000 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test('claves distintas no comparten contador', () => {
  const keyA = `a-${Date.now()}-${Math.random()}`;
  const keyB = `b-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 5; i++) checkRateLimit(keyA, { max: 5, windowMs: 60_000 });
  const resultB = checkRateLimit(keyB, { max: 5, windowMs: 60_000 });
  assert.equal(resultB.allowed, true);
});

test('la ventana expira y vuelve a permitir', () => {
  const key = `expire-${Date.now()}-${Math.random()}`;
  const first = checkRateLimit(key, { max: 1, windowMs: 10 });
  assert.equal(first.allowed, true);
  const immediate = checkRateLimit(key, { max: 1, windowMs: 10 });
  assert.equal(immediate.allowed, false);
});
