import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // ± 30s de tolerancia por desfase de reloj

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str: string): Buffer {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer: Buffer, counter: number): number {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return code % 10 ** DIGITS;
}

function generateTOTP(secretBase32: string, forTimeMs: number = Date.now()): string {
  const counter = Math.floor(forTimeMs / 1000 / STEP_SECONDS);
  const code = hotp(base32Decode(secretBase32), counter);
  return String(code).padStart(DIGITS, '0');
}

function verifyTOTP(secretBase32: string, token: unknown): boolean {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const now = Date.now();
  for (let errorWindow = -WINDOW; errorWindow <= WINDOW; errorWindow++) {
    const candidate = generateTOTP(secretBase32, now + errorWindow * STEP_SECONDS * 1000);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(String(token)))) return true;
  }
  return false;
}

function otpauthUrl({ secret, email, issuer = 'DESENCAJADO' }: { secret: string; email: string; issuer?: string }): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

module.exports = { generateSecret, generateTOTP, verifyTOTP, otpauthUrl };
