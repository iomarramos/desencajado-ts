// X-Forwarded-For lo puede mandar cualquier cliente directo, así que solo se
// confía en él cuando la conexión TCP en sí viene de una IP propia (loopback
// o red privada del VPS/Docker) — es decir, de nuestro propio nginx/Caddy
// delante de la app, nunca de internet. Sin esta verificación, cualquiera
// podía rotar el header para que cada request pareciera venir de una IP
// nueva y saltarse por completo el rate limiting.

function isTrustedProxyAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const ip = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const octets = ip.split('.').map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function getClientIp(req: { headers: { [key: string]: string | string[] | undefined }; socket: { remoteAddress?: string } }): string {
  const remoteAddress = req.socket.remoteAddress;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && isTrustedProxyAddress(remoteAddress)) {
    return String(forwarded).split(',')[0].trim();
  }
  return remoteAddress || 'unknown';
}

module.exports = { isTrustedProxyAddress, getClientIp };
