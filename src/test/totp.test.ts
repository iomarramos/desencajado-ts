import { test } from 'node:test';
import assert from 'node:assert/strict';
const totp = require('../auth/totp');

test('genera un secreto base32 de 32 caracteres', () => {
  const secret = totp.generateSecret();
  assert.equal(secret.length, 32);
  assert.match(secret, /^[A-Z2-7]+$/);
});

test('un código generado se verifica correctamente', () => {
  const secret = totp.generateSecret();
  const code = totp.generateTOTP(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(totp.verifyTOTP(secret, code), true);
});

test('rechaza un código incorrecto', () => {
  const secret = totp.generateSecret();
  const wrong = totp.generateTOTP(secret) === '000000' ? '111111' : '000000';
  assert.equal(totp.verifyTOTP(secret, wrong), false);
});

test('rechaza códigos con formato inválido', () => {
  const secret = totp.generateSecret();
  assert.equal(totp.verifyTOTP(secret, ''), false);
  assert.equal(totp.verifyTOTP(secret, 'abcdef'), false);
  assert.equal(totp.verifyTOTP(secret, '12345'), false);
});

test('acepta el código de un paso de tiempo anterior (tolerancia de reloj)', () => {
  const secret = totp.generateSecret();
  const past = totp.generateTOTP(secret, Date.now() - 30_000);
  assert.equal(totp.verifyTOTP(secret, past), true);
});

test('otpauthUrl incluye el secreto y el emisor', () => {
  const secret = totp.generateSecret();
  const url = totp.otpauthUrl({ secret, email: 'cliente@example.com' });
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, new RegExp(`secret=${secret}`));
  assert.match(url, /issuer=DESENCAJADO/);
});
