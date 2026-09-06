import crypto from 'node:crypto';

const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '';
const CLASS_SUFFIX = process.env.GOOGLE_WALLET_CLASS_SUFFIX || 'desencajado_loyalty_class';
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL || '';
const PRIVATE_KEY = (process.env.GOOGLE_WALLET_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const ORIGIN = process.env.GOOGLE_WALLET_ORIGIN || '';

const configured = Boolean(ISSUER_ID && SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY && ORIGIN);

function isConfigured(): boolean {
  return configured;
}

// Aviso de proximidad nativo de Google Wallet: si el local tiene coordenadas
// configuradas, el celular del cliente le muestra una notificación en la
// pantalla de bloqueo al pasar cerca — lo maneja Google, no este servidor.
// Completamente opcional: sin estas dos variables, la tarjeta funciona igual,
// solo sin ese aviso.
const LOCATION_LAT = process.env.GOOGLE_WALLET_LOCATION_LAT ? Number(process.env.GOOGLE_WALLET_LOCATION_LAT) : null;
const LOCATION_LNG = process.env.GOOGLE_WALLET_LOCATION_LNG ? Number(process.env.GOOGLE_WALLET_LOCATION_LNG) : null;
const hasStoreLocation =
  LOCATION_LAT != null && !Number.isNaN(LOCATION_LAT) && LOCATION_LNG != null && !Number.isNaN(LOCATION_LNG);

function sanitizeId(value: unknown): string {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function objectIdFor(userId: number | string): string {
  return `${ISSUER_ID}.user_${sanitizeId(userId)}`;
}

// ───────────────────────── Wallet REST API (push a pases ya guardados) ─────────────────────────
//
// A diferencia de buildSaveUrl (que solo genera el link inicial "Guardar en
// wallet"), esto llama a la Wallet REST API para actualizar/notificar un
// loyaltyObject que el usuario ya guardó, sin que tenga que volver a la web.

const WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: TOKEN_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), PRIVATE_KEY).toString('base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`GOOGLE_WALLET_TOKEN_FAILED (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

type WalletApiResult =
  | { ok: true }
  | { ok: false; skipped?: boolean; notFound?: boolean; error?: string };

// Actualiza el saldo de estrellas en el pase ya guardado del usuario. Si el
// usuario nunca llegó a guardarlo del lado de Google, la API responde 404 —
// no es un error real, el llamador simplemente lo ignora.
async function patchLoyaltyPoints(userId: number | string, points: number): Promise<WalletApiResult> {
  if (!configured) return { ok: false, skipped: true };
  try {
    const token = await getAccessToken();
    const res = await fetch(`${WALLET_API_BASE}/loyaltyObject/${objectIdFor(userId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ loyaltyPoints: { label: 'Estrellas', balance: { int: points } } }),
    });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Envía un mensaje al pase ya guardado del usuario — aparece como
// notificación en la app de Google Wallet (ej. para avisar una promo nueva
// sin depender de push del navegador).
async function pushLoyaltyMessage(
  userId: number | string,
  { header, body }: { header: string; body: string }
): Promise<WalletApiResult> {
  if (!configured) return { ok: false, skipped: true };
  try {
    const token = await getAccessToken();
    const res = await fetch(`${WALLET_API_BASE}/loyaltyObject/${objectIdFor(userId)}/addMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { header, body, id: `promo_${Date.now()}`, messageType: 'TEXT' },
      }),
    });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Actualiza la imagen grande (heroImage) del pase ya guardado — más
// visual que el mensaje de texto de pushLoyaltyMessage, útil para que la
// foto de la promo activa aparezca directamente en la tarjeta guardada.
async function patchHeroImage(
  userId: number | string,
  { imageUrl, description }: { imageUrl: string; description?: string }
): Promise<WalletApiResult> {
  if (!configured) return { ok: false, skipped: true };
  try {
    const token = await getAccessToken();
    const res = await fetch(`${WALLET_API_BASE}/loyaltyObject/${objectIdFor(userId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        heroImage: {
          sourceUri: { uri: imageUrl },
          contentDescription: { defaultValue: { language: 'es', value: description || 'Promoción' } },
        },
      }),
    });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface WalletUser {
  id: number | string;
  name: string;
  referralCode: string;
}

// Construye el JWT "Save to Google Wallet" (RFC 7519, firmado RS256) con la
// clase y el objeto de fidelidad embebidos: Google los crea/actualiza al
// abrir el link, sin necesidad de llamar antes a la Wallet REST API.
function buildSaveUrl({ user, points }: { user: WalletUser; points: number }): string {
  if (!configured) throw new Error('GOOGLE_WALLET_NOT_CONFIGURED');

  const classId = `${ISSUER_ID}.${sanitizeId(CLASS_SUFFIX)}`;
  const objectId = objectIdFor(user.id);

  const loyaltyClass = {
    id: classId,
    issuerName: 'DESENCAJADO',
    programName: 'DESENCAJADO Rewards',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: '#1A1A1A',
    ...(hasStoreLocation ? { locations: [{ latitude: LOCATION_LAT, longitude: LOCATION_LNG }] } : {}),
  };

  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountId: String(user.id),
    accountName: user.name,
    loyaltyPoints: {
      label: 'Estrellas',
      balance: { int: points },
    },
    barcode: {
      type: 'QR_CODE',
      value: user.referralCode,
      alternateText: user.referralCode,
    },
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: SERVICE_ACCOUNT_EMAIL,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [ORIGIN],
    payload: {
      loyaltyClasses: [loyaltyClass],
      loyaltyObjects: [loyaltyObject],
    },
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), PRIVATE_KEY).toString('base64url');

  return `https://pay.google.com/gp/v/save/${signingInput}.${signature}`;
}

module.exports = { isConfigured, buildSaveUrl, patchLoyaltyPoints, pushLoyaltyMessage, patchHeroImage };
