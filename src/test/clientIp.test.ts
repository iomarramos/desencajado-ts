import { test } from 'node:test';
import assert from 'node:assert/strict';
const { isTrustedProxyAddress, getClientIp } = require('../auth/clientIp');

function fakeReq(remoteAddress: string | undefined, forwardedFor?: string) {
  return {
    headers: forwardedFor !== undefined ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress },
  };
}

test('isTrustedProxyAddress: confía en loopback', () => {
  assert.equal(isTrustedProxyAddress('127.0.0.1'), true);
  assert.equal(isTrustedProxyAddress('::1'), true);
  assert.equal(isTrustedProxyAddress('::ffff:127.0.0.1'), true);
});

test('isTrustedProxyAddress: confía en redes privadas (VPS/Docker)', () => {
  assert.equal(isTrustedProxyAddress('10.0.0.5'), true);
  assert.equal(isTrustedProxyAddress('172.17.0.2'), true);
  assert.equal(isTrustedProxyAddress('192.168.1.10'), true);
});

test('isTrustedProxyAddress: NO confía en una IP pública', () => {
  assert.equal(isTrustedProxyAddress('203.0.113.5'), false);
  assert.equal(isTrustedProxyAddress('8.8.8.8'), false);
  assert.equal(isTrustedProxyAddress(undefined), false);
});

test('getClientIp: ignora X-Forwarded-For si la conexión no viene de un proxy propio', () => {
  // Este es exactamente el ataque reportado: cualquiera puede mandar el
  // header y rotarlo en cada request para simular una IP distinta cada vez
  // y saltarse el rate limiting, a menos que se ignore cuando no viene de
  // un proxy de confianza.
  const req = fakeReq('203.0.113.5', '9.9.9.9');
  assert.equal(getClientIp(req), '203.0.113.5');
});

test('getClientIp: usa X-Forwarded-For solo si la conexión viene de un proxy propio', () => {
  const req = fakeReq('127.0.0.1', '198.51.100.20');
  assert.equal(getClientIp(req), '198.51.100.20');
});

test('getClientIp: toma la primera IP de una lista X-Forwarded-For', () => {
  const req = fakeReq('10.0.0.1', '198.51.100.20, 10.0.0.1');
  assert.equal(getClientIp(req), '198.51.100.20');
});

test('getClientIp: sin header, usa la IP de la conexión directa', () => {
  const req = fakeReq('203.0.113.5');
  assert.equal(getClientIp(req), '203.0.113.5');
});
