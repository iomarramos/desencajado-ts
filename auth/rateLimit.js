// Rate limiter en memoria (ventana fija) por clave arbitraria, ej. `ip:ruta`.
// Es de un solo proceso: alcanza para esta app (SQLite ya es de un solo
// proceso); si se corre con varias réplicas detrás de un balanceador, cada
// una lleva su propio conteo — no es un límite global estricto en ese caso.
const buckets = new Map();

function checkRateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now > entry.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

module.exports = { checkRateLimit };
