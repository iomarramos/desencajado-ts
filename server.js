const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  addSubscriber, dniExists, getCount, listSubscribers,
  upsertGoogleUser, getUserById, getUserByEmail, getUserByReferralCode, setReferredBy,
  setUserContactInfo, setTotpSecret, enableTotp, markWalletSaved, listWalletSavedUserIds,
  createSession, getSession, setSessionStage, deleteSession, deleteAllSessionsForUser,
  isTotpLocked, registerTotpFailure, resetTotpAttempts, TOTP_LOCKOUT_MINUTES,
  addPurchase, getPointsBalance, listPurchasesByUser, redeemPoints, getRewardProgress, SOLES_PER_PUNTO,
  getTierForUser, spinWheel, getSpinStatus,
  createFamilyGroup, joinFamilyGroup, getFamilyGroupForUser, leaveFamilyGroup, removeFamilyMember,
  createProduct, listActiveProducts, adminListProducts, deactivateProduct, updateProduct, deleteProduct,
  createProfileField, getProfileFieldByKey, adminListProfileFields,
  updateProfileField, deleteProfileField, getUserProfileValues, getMissingRequiredFields, setUserProfileValues,
  createPromotion, addPromotionCode, redeemPromotionCode, findActivePromotionByTitle,
  getPromotionRedeemers, getPromotionNonRedeemers, adminPromotionsSummary, adminTopCustomersByPurchases, adminRecurringPromoCustomers,
  listActivePromotions, adminListPromotions, deactivatePromotion, markPromotionPushed,
  listPromotionsReadyToActivate, markPromotionActivated,
  updatePromotion, deletePromotion,
  addPushSubscription, removePushSubscription, listAllPushSubscriptions,
  adminListUsers, adminListReferrals, adminListFamilyGroups, adminListPurchases, adminTrafficStats,
  adminAllUsers, adminAllPurchases, adminAllReferrals,
} = require('./db');
const google = require('./auth/google');
const totp = require('./auth/totp');
const push = require('./auth/push');
const googleWallet = require('./auth/googleWallet');
const { checkRateLimit } = require('./auth/rateLimit');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const REF_COOKIE = 'pending_ref';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, maxBytes = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function normalizePhone(raw) {
  return String(raw || '').replace(/[\s-]/g, '');
}

function validateSubscription({ nombre, telefono, dni, unasam }) {
  const errors = {};

  const cleanNombre = String(nombre || '').trim();
  if (cleanNombre.length < 2 || cleanNombre.length > 100) {
    errors.nombre = 'El nombre debe tener entre 2 y 100 caracteres.';
  }

  const cleanTelefono = normalizePhone(telefono);
  if (!/^9\d{8}$/.test(cleanTelefono)) {
    errors.telefono = 'Ingresa un celular peruano válido (9 dígitos, empieza con 9).';
  }

  const cleanDni = String(dni || '').trim();
  if (!/^\d{8}$/.test(cleanDni)) {
    errors.dni = 'El DNI debe tener exactamente 8 dígitos.';
  }

  const cleanUnasam = unasam === 'Sí' || unasam === 'No' ? unasam : null;
  if (!cleanUnasam) {
    errors.unasam = 'Indica si eres estudiante UNASAM.';
  }

  return {
    errors,
    value: { nombre: cleanNombre, telefono: cleanTelefono, dni: cleanDni, unasam: cleanUnasam },
  };
}

function validateContactInfo({ dni, telefono }) {
  const errors = {};

  const cleanDni = String(dni || '').trim();
  if (!/^\d{8}$/.test(cleanDni)) {
    errors.dni = 'El DNI debe tener exactamente 8 dígitos.';
  }

  const cleanTelefono = normalizePhone(telefono);
  if (!/^9\d{8}$/.test(cleanTelefono)) {
    errors.telefono = 'Ingresa un celular peruano válido (9 dígitos, empieza con 9).';
  }

  return { errors, value: { dni: cleanDni, telefono: cleanTelefono } };
}

// El primer IP de X-Forwarded-For (si hay un proxy/reverse-proxy delante,
// como en el despliegue con Docker detrás de nginx/Caddy); si no, la
// conexión directa. No se valida el proxy en sí (más allá del alcance de
// esta app), así que en un despliegue público real ese header solo debe
// confiarse si viene de una red/proxy propios.
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(req, res, routeKey, { max, windowMs }) {
  const result = checkRateLimit(`${routeKey}:${getClientIp(req)}`, { max, windowMs });
  if (!result.allowed) {
    sendJson(res, 429, {
      ok: false,
      error: `Demasiados intentos. Intenta de nuevo en ${result.retryAfterSeconds}s.`,
    }, { 'Retry-After': String(result.retryAfterSeconds) });
    return true;
  }
  return false;
}

function isAuthorizedAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const provided = req.headers['x-admin-token'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ───────────────────────── cookies ─────────────────────────

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function isHttpsRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

function cookieString(req, name, value, { maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isHttpsRequest(req)) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function clearCookieString(req, name) {
  return cookieString(req, name, '', { maxAge: 0 });
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const session = getSession(token);
  return session ? { token, session } : null;
}

function requireActiveUser(req) {
  const found = getSessionFromRequest(req);
  if (!found || found.session.stage !== 'active') return null;
  return getUserById(found.session.user_id);
}

// ───────────────────────── perfil / wallet ─────────────────────────

function serializeUser(user) {
  const family = getFamilyGroupForUser(user.id);
  const reward = getRewardProgress(user.id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url,
    puntos: reward.balance,
    reward,
    tier: getTierForUser(user.id),
    spinStatus: getSpinStatus(user.id),
    profileFields: getUserProfileValues(user.id),
    referralCode: user.referral_code,
    totpEnabled: Boolean(user.totp_enabled),
    familyGroup: family,
    solesPerPunto: SOLES_PER_PUNTO,
    pushConfigured: push.isConfigured(),
    googleWalletConfigured: googleWallet.isConfigured(),
  };
}

async function handleMe(req, res) {
  const found = getSessionFromRequest(req);
  if (!found) return sendJson(res, 200, { authenticated: false });

  const user = getUserById(found.session.user_id);
  if (!user) return sendJson(res, 200, { authenticated: false });

  // El perfil (DNI/teléfono) se pide antes que el 2FA: Google no los entrega
  // en el login, así que hay que completarlos aparte una sola vez.
  if (!user.dni || !user.telefono) {
    return sendJson(res, 200, {
      authenticated: false,
      stage: 'needs_profile',
      name: user.name,
      email: user.email,
    });
  }

  // Campos adicionales configurados desde el admin (ej. cumpleaños): se
  // revisa en cada /api/me, así que aplica incluso a sesiones que ya
  // estaban activas antes de que el admin marcara un campo como obligatorio.
  const missingFields = getMissingRequiredFields(user.id);
  if (missingFields.length > 0) {
    return sendJson(res, 200, {
      authenticated: false,
      stage: 'needs_extra_fields',
      name: user.name,
      email: user.email,
      fields: missingFields,
    });
  }

  if (found.session.stage !== 'active') {
    return sendJson(res, 200, {
      authenticated: false,
      stage: found.session.stage,
      name: user.name,
      email: user.email,
    });
  }

  sendJson(res, 200, { authenticated: true, stage: 'active', user: serializeUser(user) });
}

async function handleProfileComplete(req, res) {
  if (rateLimited(req, res, 'profile-complete', { max: 10, windowMs: 10 * 60_000 })) return;
  const found = getSessionFromRequest(req);
  if (!found) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });
  const user = getUserById(found.session.user_id);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const { errors, value } = validateContactInfo(body);
  if (Object.keys(errors).length > 0) {
    return sendJson(res, 400, { ok: false, errors });
  }

  try {
    setUserContactInfo(user.id, value.dni, value.telefono);
  } catch (err) {
    if (err.message === 'DNI_TAKEN') {
      return sendJson(res, 409, { ok: false, error: 'Ese DNI ya está vinculado a otra cuenta.' });
    }
    throw err;
  }

  sendJson(res, 200, { ok: true });
}

// ───────────────────────── auth Google + 2FA ─────────────────────────

function handleGoogleStart(req, res, query) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Login con Google no está configurado (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  const state = crypto.randomBytes(16).toString('base64url');
  const headers = { Location: google.buildAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: GOOGLE_REDIRECT_URI, state }) };
  const cookies = [cookieString(req, STATE_COOKIE, state, { maxAge: 600 })];
  const ref = String(query.get('ref') || '').trim();
  if (ref) cookies.push(cookieString(req, REF_COOKIE, ref, { maxAge: 600 }));
  headers['Set-Cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

async function handleGoogleCallback(req, res, query) {
  const cookies = parseCookies(req);
  const code = query.get('code');
  const state = query.get('state');

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Solicitud de login inválida o expirada.');
  }

  try {
    const tokens = await google.exchangeCode({
      code,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: GOOGLE_REDIRECT_URI,
    });
    const payload = await google.verifyIdToken(tokens.id_token, GOOGLE_CLIENT_ID);

    const user = upsertGoogleUser({
      googleId: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      avatarUrl: payload.picture,
    });

    const refCode = cookies[REF_COOKIE];
    if (refCode) {
      const referrer = getUserByReferralCode(refCode);
      if (referrer && setReferredBy(user.id, referrer.id)) {
        syncWalletPoints(user.id);
        syncWalletPoints(referrer.id);
      }
    }

    const stage = user.totp_enabled ? 'pending_2fa' : 'needs_2fa_setup';
    const token = createSession(user.id, stage);

    res.writeHead(302, {
      Location: '/cuenta.html',
      'Set-Cookie': [
        cookieString(req, SESSION_COOKIE, token, { maxAge: 30 * 86400 }),
        clearCookieString(req, STATE_COOKIE),
        clearCookieString(req, REF_COOKIE),
      ],
    });
    res.end();
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No pudimos verificar tu cuenta de Google. Intenta de nuevo.');
  }
}

function handleLogout(req, res) {
  const found = getSessionFromRequest(req);
  if (found) deleteSession(found.token);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookieString(req, SESSION_COOKIE) });
  res.end(JSON.stringify({ ok: true }));
}

// Cierra la sesión actual y todas las demás abiertas de este usuario (otros
// dispositivos/navegadores) — no hay forma de listarlas/revocarlas una por
// una, es todo o nada.
function handleLogoutAll(req, res) {
  const found = getSessionFromRequest(req);
  if (!found) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });
  deleteAllSessionsForUser(found.session.user_id);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookieString(req, SESSION_COOKIE) });
  res.end(JSON.stringify({ ok: true }));
}

async function handleTotpSetup(req, res) {
  const found = getSessionFromRequest(req);
  if (!found || found.session.stage !== 'needs_2fa_setup') {
    return sendJson(res, 400, { ok: false, error: 'No corresponde configurar 2FA en este momento.' });
  }
  const user = getUserById(found.session.user_id);
  const secret = totp.generateSecret();
  setTotpSecret(user.id, secret);
  sendJson(res, 200, { ok: true, secret, otpauthUrl: totp.otpauthUrl({ secret, email: user.email }) });
}

async function handleTotpVerify(req, res) {
  if (rateLimited(req, res, '2fa-verify', { max: 20, windowMs: 5 * 60_000 })) return;

  const found = getSessionFromRequest(req);
  if (!found || (found.session.stage !== 'needs_2fa_setup' && found.session.stage !== 'pending_2fa')) {
    return sendJson(res, 400, { ok: false, error: 'No hay una verificación 2FA pendiente.' });
  }

  if (isTotpLocked(found.session)) {
    return sendJson(res, 429, {
      ok: false,
      error: `Demasiados intentos incorrectos. Espera unos minutos (máx. ${TOTP_LOCKOUT_MINUTES} min) y vuelve a intentar.`,
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const user = getUserById(found.session.user_id);
  if (!user.totp_secret) {
    return sendJson(res, 400, { ok: false, error: 'Primero solicita el código QR de configuración.' });
  }

  if (!totp.verifyTOTP(user.totp_secret, body.code)) {
    registerTotpFailure(found.token);
    return sendJson(res, 401, { ok: false, error: 'Código incorrecto. Verifica la hora de tu dispositivo e intenta de nuevo.' });
  }

  resetTotpAttempts(found.token);
  if (found.session.stage === 'needs_2fa_setup') enableTotp(user.id);
  setSessionStage(found.token, 'active');
  sendJson(res, 200, { ok: true, user: serializeUser(getUserById(user.id)) });
}

// ───────────────────────── wallet (compras / canje / familia) ─────────────────────────

function handlePurchasesList(req, res, query) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });
  const result = listPurchasesByUser(user.id, { page: query.get('page'), limit: query.get('limit') });
  sendJson(res, 200, { ok: true, ...result });
}

async function handlePointsRedeem(req, res) {
  if (rateLimited(req, res, 'points-redeem', { max: 20, windowMs: 5 * 60_000 })) return;
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  try {
    const balance = redeemPoints(user.id, body.puntos, body.motivo);
    syncWalletPoints(user.id);
    sendJson(res, 200, { ok: true, balance });
  } catch (err) {
    const msg = err.message === 'INSUFFICIENT_BALANCE'
      ? 'No tienes suficientes puntos para este canje.'
      : 'Cantidad de puntos inválida.';
    sendJson(res, 400, { ok: false, error: msg });
  }
}

// ───────────────────────── ruleta de premios ─────────────────────────

function handleSpinStatus(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });
  sendJson(res, 200, { ok: true, ...getSpinStatus(user.id) });
}

function handleSpinPlay(req, res) {
  if (rateLimited(req, res, 'wallet-spin', { max: 10, windowMs: 5 * 60_000 })) return;
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  try {
    const result = spinWheel(user.id);
    syncWalletPoints(user.id);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err.message === 'SPIN_COOLDOWN') {
      return sendJson(res, 429, { ok: false, error: 'Todavía no puedes girar de nuevo.', ...getSpinStatus(user.id) });
    }
    sendJson(res, 500, { ok: false, error: 'No se pudo girar la ruleta.' });
  }
}

async function handleFamilyCreate(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 60) {
    return sendJson(res, 400, { ok: false, error: 'Ingresa un nombre de grupo válido.' });
  }
  const group = createFamilyGroup(user.id, name);
  sendJson(res, 201, { ok: true, group });
}

async function handleFamilyJoin(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  try {
    const group = joinFamilyGroup(user.id, body.inviteCode);
    sendJson(res, 200, { ok: true, group });
  } catch {
    sendJson(res, 404, { ok: false, error: 'Código de invitación no encontrado.' });
  }
}

function handleFamilyLeave(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  try {
    const result = leaveFamilyGroup(user.id);
    sendJson(res, 200, { ok: true, ...result });
  } catch {
    sendJson(res, 400, { ok: false, error: 'No perteneces a ningún grupo familiar.' });
  }
}

async function handleFamilyRemoveMember(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const FAMILY_REMOVE_ERRORS = {
    NOT_IN_GROUP: 'No perteneces a ningún grupo familiar.',
    NOT_OWNER: 'Solo el dueño del grupo puede expulsar miembros.',
    CANNOT_REMOVE_SELF: 'Usa "Salir del grupo" para vos mismo.',
    NOT_A_MEMBER: 'Ese usuario no pertenece a tu grupo.',
  };

  try {
    removeFamilyMember(user.id, body.userId);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: FAMILY_REMOVE_ERRORS[err.message] || 'No se pudo expulsar al miembro.' });
  }
}

// ───────────────────────── promociones (cliente) ─────────────────────────

// Público: las promociones activas son contenido de marketing, no datos
// privados, así que se muestran también a visitantes sin sesión en la
// landing (/). No incluyen los códigos de canje (ver listActivePromotions).
function handlePromotionsList(req, res) {
  sendJson(res, 200, { ok: true, items: listActivePromotions() });
}

const PROMO_REDEEM_ERRORS = {
  CODE_NOT_FOUND: 'Ese código no existe.',
  PROMOTION_INACTIVE: 'Esta promoción ya no está activa.',
  PROMOTION_NOT_STARTED: 'Esta promoción todavía no empieza.',
  PROMOTION_EXPIRED: 'Esta promoción ya venció.',
  CODE_EXHAUSTED: 'Este código ya alcanzó su límite de usos.',
};

async function handlePromotionRedeem(req, res) {
  if (rateLimited(req, res, 'promo-redeem', { max: 20, windowMs: 5 * 60_000 })) return;
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.code) return sendJson(res, 400, { ok: false, error: 'Ingresa un código.' });

  try {
    const { promotion, code } = redeemPromotionCode(body.code, user.id);
    sendJson(res, 200, { ok: true, promotion, code });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: PROMO_REDEEM_ERRORS[err.message] || 'No se pudo canjear el código.' });
  }
}

// ───────────────────────── notificaciones push (cliente) ─────────────────────────

function handlePushVapidKey(req, res) {
  sendJson(res, 200, { ok: true, configured: push.isConfigured(), publicKey: push.publicKey() });
}

async function handlePushSubscribe(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const endpoint = String(body.endpoint || '');
  const p256dh = body.keys && body.keys.p256dh;
  const authKey = body.keys && body.keys.auth;
  if (!endpoint || !p256dh || !authKey) {
    return sendJson(res, 400, { ok: false, error: 'Suscripción push inválida.' });
  }

  addPushSubscription(user.id, { endpoint, p256dh, auth: authKey });
  sendJson(res, 201, { ok: true });
}

async function handlePushUnsubscribe(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }
  if (body.endpoint) removePushSubscription(body.endpoint);
  sendJson(res, 200, { ok: true });
}

// ───────────────────────── Google Wallet (tarjeta de fidelidad) ─────────────────────────

function handleGoogleWalletPass(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });
  if (!googleWallet.isConfigured()) {
    return sendJson(res, 501, {
      ok: false,
      error: 'Agregar a Google Wallet no está configurado (faltan credenciales de Google Wallet Issuer).',
    });
  }
  try {
    const saveUrl = googleWallet.buildSaveUrl({
      user: { id: user.id, name: user.name, referralCode: user.referral_code },
      points: getPointsBalance(user.id),
    });
    markWalletSaved(user.id);
    sendJson(res, 200, { ok: true, saveUrl });
  } catch {
    sendJson(res, 500, { ok: false, error: 'No se pudo generar la tarjeta de Google Wallet.' });
  }
}

// Empuja el saldo actual al pase de Google Wallet ya guardado (si el usuario
// lo guardó y hay credenciales configuradas). Mejor esfuerzo: nunca bloquea
// ni hace fallar la respuesta HTTP que la disparó.
function syncWalletPoints(userId) {
  if (!googleWallet.isConfigured()) return;
  googleWallet.patchLoyaltyPoints(userId, getPointsBalance(userId));
}

// ───────────────────────── suscripción pre-apertura (existente) ─────────────────────────

async function handleSubscribe(req, res) {
  if (rateLimited(req, res, 'subscribe', { max: 10, windowMs: 60 * 60_000 })) return;
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return sendJson(res, 413, { ok: false, error: 'Solicitud demasiado grande.' });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const { errors, value } = validateSubscription(data);
  if (Object.keys(errors).length > 0) {
    return sendJson(res, 400, { ok: false, errors });
  }

  if (dniExists(value.dni)) {
    return sendJson(res, 409, {
      ok: false,
      error: 'Ese DNI ya está registrado. ¡Ya estás en la lista!',
    });
  }

  addSubscriber(value);
  return sendJson(res, 201, { ok: true, total: getCount() });
}

function handleCount(req, res) {
  sendJson(res, 200, { ok: true, total: getCount() });
}

function handleAdminList(req, res) {
  if (!isAuthorizedAdmin(req)) {
    return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  }
  sendJson(res, 200, { ok: true, subscribers: listSubscribers() });
}

// ───────────────────────── administrador (wallet / tráfico / referidos / familia) ─────────────────────────

function paginationParams(query) {
  return { page: query.get('page'), limit: query.get('limit'), q: query.get('q') || undefined };
}

async function handleAdminPurchaseCreate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const monto = Number(body.monto);
  if (!email || !(monto > 0)) {
    return sendJson(res, 400, { ok: false, error: 'Se requiere email del cliente y un monto válido.' });
  }

  const target = getUserByEmail(email);
  if (!target) {
    return sendJson(res, 404, { ok: false, error: 'Ese cliente aún no inició sesión con Google (no tiene wallet).' });
  }

  const result = addPurchase({ userId: target.id, monto, producto: body.producto });
  syncWalletPoints(target.id);
  sendJson(res, 201, { ok: true, ...result });
}

function handleAdminUsers(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListUsers(paginationParams(query)) });
}

// Fuerza el cierre de sesión de un cliente en todos sus dispositivos (ej.
// celular perdido/robado, sospecha de cuenta comprometida).
async function handleAdminForceLogout(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return sendJson(res, 400, { ok: false, error: 'Se requiere el email del cliente.' });

  const target = getUserByEmail(email);
  if (!target) return sendJson(res, 404, { ok: false, error: 'Cliente no encontrado.' });

  deleteAllSessionsForUser(target.id);
  sendJson(res, 200, { ok: true });
}

function handleAdminReferrals(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListReferrals(paginationParams(query)) });
}

function handleAdminFamilyGroups(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListFamilyGroups(paginationParams(query)) });
}

function handleAdminPurchases(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListPurchases(paginationParams(query)) });
}

function handleAdminTraffic(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminTrafficStats() });
}

// ───────────────────────── administrador: promociones + push ─────────────────────────

function handleAdminPromotionsList(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, pushConfigured: push.isConfigured(), ...adminListPromotions(paginationParams(query)) });
}

function handleAdminPromotionsSummary(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminPromotionsSummary() });
}

// Quiénes canjearon esta promoción — "quiénes fueron los elegidos". Los que
// no canjearon se calculan del lado del cliente restando esta lista del
// total de usuarios (adminPromotionsSummary ya trae ese total).
function handleAdminPromotionRedeemers(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  const id = Number(query.get('id'));
  if (!id) return sendJson(res, 400, { ok: false, error: 'Falta el id de la promoción.' });
  sendJson(res, 200, { ok: true, items: getPromotionRedeemers(id) });
}

// El complemento de handleAdminPromotionRedeemers: quiénes NO canjearon
// ningún código de esta promoción, paginado y con búsqueda — para no traer
// a los mil clientes de un jalón cuando la promoción tiene poco alcance.
function handleAdminPromotionNonRedeemers(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  const id = Number(query.get('id'));
  if (!id) return sendJson(res, 400, { ok: false, error: 'Falta el id de la promoción.' });
  sendJson(res, 200, { ok: true, ...getPromotionNonRedeemers(id, paginationParams(query)) });
}

function handleAdminTopCustomers(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, {
    ok: true,
    ...adminTopCustomersByPurchases({
      ...paginationParams(query),
      minCompras: query.get('minCompras'),
      sortBy: query.get('sortBy') || undefined,
    }),
  });
}

function handleAdminRecurringPromoCustomers(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminRecurringPromoCustomers(paginationParams(query)) });
}

// Ejecuta `task` sobre cada elemento de `items` con un máximo de
// `concurrency` llamadas en vuelo a la vez, en vez de disparar todas de
// golpe con Promise.all (eso satura la API de Google cuando hay miles de
// usuarios con la tarjeta guardada).
async function runInBatches(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

const WALLET_PUSH_CONCURRENCY = 5;

// Envía en tandas y en segundo plano (sin que nadie tenga que esperarla) el
// mensaje y la imagen destacada de Google Wallet a la lista de usuarios
// indicada. Se dispara "fire and forget" a propósito: activatePromotion no
// puede quedar bloqueada esperando cientos de llamadas a Google antes de
// responderle al admin. Los errores solo se registran; nunca deben tumbar
// la respuesta del admin ni el scheduler.
function sendWalletPromotionPushInBackground(userIds, { title, promoBody, photoUrl }) {
  runInBatches(userIds, WALLET_PUSH_CONCURRENCY, async (userId) => {
    await googleWallet.pushLoyaltyMessage(userId, { header: title, body: promoBody });
    if (photoUrl) {
      await googleWallet.patchHeroImage(userId, { imageUrl: photoUrl, description: title });
    }
  }).catch((err) => {
    console.error('Error enviando push de Google Wallet en segundo plano:', err);
  });
}

// Envía el push (navegador + Google Wallet) de una promoción y la marca
// como activada. La llama handleAdminPromotionCreate cuando la vigencia ya
// empezó, y runPromotionScheduler cuando le toca a una programada para
// más adelante — misma lógica en los dos casos, un solo lugar.
async function activatePromotion(promotion) {
  const { id, title, body: promoBody, photo_url: photoUrl } = promotion;

  let pushSent = 0;
  if (push.isConfigured()) {
    const subs = listAllPushSubscriptions();
    const results = await Promise.all(
      subs.map((sub) => push.sendToSubscription(sub, { title, body: promoBody }))
    );
    results.forEach((result, i) => {
      if (result.ok) pushSent += 1;
      else if (result.gone) removePushSubscription(subs[i].endpoint);
    });
    markPromotionPushed(id, pushSent);
  }

  let walletPushQueued = 0;
  if (googleWallet.isConfigured()) {
    const userIds = listWalletSavedUserIds();
    walletPushQueued = userIds.length;
    sendWalletPromotionPushInBackground(userIds, { title, promoBody, photoUrl });
  }

  markPromotionActivated(id);
  return { pushSent, walletPushQueued };
}

// Programación por día: si starts_at todavía no llegó, la promoción queda
// guardada pero sin avisarle a nadie hasta que runPromotionScheduler la
// recoja (ver el arranque del servidor, más abajo).
function isReadyToActivate(promotion) {
  if (!promotion.starts_at) return true;
  return String(promotion.starts_at).slice(0, 10) <= new Date().toISOString().slice(0, 10);
}

async function runPromotionScheduler() {
  for (const promotion of listPromotionsReadyToActivate()) {
    try {
      await activatePromotion(promotion);
    } catch (err) {
      console.error(`Error activando la promoción programada #${promotion.id}:`, err);
    }
  }
}

async function handleAdminPromotionCreate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const title = String(body.title || '').trim();
  const promoBody = String(body.body || '').trim();
  if (!title || !promoBody) {
    return sendJson(res, 400, { ok: false, error: 'La promoción necesita título y texto.' });
  }

  if (!body.confirmDuplicate) {
    const existing = findActivePromotionByTitle(title);
    if (existing) {
      return sendJson(res, 409, {
        ok: false,
        duplicate: true,
        error: `Ya existe una promoción activa con este título (creada el ${existing.created_at}). Confirma si quieres publicarla de todas formas.`,
        existingPromotion: { id: existing.id, title: existing.title, publication_code: existing.publication_code, created_at: existing.created_at },
      });
    }
  }

  const productIds = Array.isArray(body.productIds) ? body.productIds.map(Number).filter(Boolean) : [];
  const promotion = createPromotion({
    title,
    body: promoBody,
    photoUrl: body.photoUrl || null,
    startsAt: body.startsAt || null,
    endsAt: body.endsAt || null,
    productIds,
  });

  let pushSent = 0;
  let walletPushQueued = 0;
  const scheduled = !isReadyToActivate(promotion);
  if (!scheduled) {
    ({ pushSent, walletPushQueued } = await activatePromotion(promotion));
  }

  sendJson(res, 201, { ok: true, promotion, pushSent, walletPushQueued, scheduled });
}

async function handleAdminPromotionDeactivate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id de la promoción.' });
  deactivatePromotion(body.id);
  sendJson(res, 200, { ok: true });
}

async function handleAdminPromotionUpdate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id de la promoción.' });

  try {
    const productIds = Array.isArray(body.productIds) ? body.productIds.map(Number).filter(Boolean) : undefined;
    const promotion = updatePromotion(body.id, {
      title: body.title,
      body: body.body,
      photoUrl: body.photoUrl,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      productIds,
    });
    sendJson(res, 200, { ok: true, promotion });
  } catch {
    sendJson(res, 404, { ok: false, error: 'Promoción no encontrada.' });
  }
}

async function handleAdminPromotionDelete(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id de la promoción.' });

  try {
    deletePromotion(body.id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const msg = err.message === 'PROMOTION_HAS_REDEMPTIONS'
      ? 'Esta promoción ya tiene canjes registrados: no se puede borrar, solo desactivar.'
      : 'Promoción no encontrada.';
    sendJson(res, 400, { ok: false, error: msg });
  }
}

async function handleAdminPromotionAddCode(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.promotionId) return sendJson(res, 400, { ok: false, error: 'Falta el id de la promoción.' });

  const promotion = addPromotionCode(body.promotionId, {
    code: body.code,
    label: body.label,
    maxUses: body.maxUses,
  });
  sendJson(res, 201, { ok: true, promotion });
}

// ───────────────────────── administrador: catálogo de productos ─────────────────────────

function handleAdminProductsList(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListProducts(paginationParams(query)) });
}

function handleAdminProductsActive(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, items: listActiveProducts() });
}

async function handleAdminProductCreate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { ok: false, error: 'El producto necesita un nombre.' });

  const product = createProduct({ name, photoUrl: body.photoUrl, price: body.price });
  sendJson(res, 201, { ok: true, product });
}

async function handleAdminProductDeactivate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id del producto.' });
  deactivateProduct(body.id);
  sendJson(res, 200, { ok: true });
}

async function handleAdminProductUpdate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id del producto.' });

  try {
    const product = updateProduct(body.id, { name: body.name, photoUrl: body.photoUrl, price: body.price });
    sendJson(res, 200, { ok: true, product });
  } catch {
    sendJson(res, 404, { ok: false, error: 'Producto no encontrado.' });
  }
}

async function handleAdminProductDelete(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id del producto.' });

  try {
    deleteProduct(body.id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const msg = err.message === 'PRODUCT_IN_USE'
      ? 'Este producto está asociado a una o más promociones: no se puede borrar, solo desactivar.'
      : 'Producto no encontrado.';
    sendJson(res, 400, { ok: false, error: msg });
  }
}

// ───────────────────────── administrador: campos de perfil dinámicos ─────────────────────────

function handleAdminProfileFieldsList(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, items: adminListProfileFields() });
}

async function handleAdminProfileFieldCreate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const key = String(body.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label = String(body.label || '').trim();
  const type = ['text', 'number', 'date'].includes(body.type) ? body.type : 'text';
  if (!key || !label) return sendJson(res, 400, { ok: false, error: 'El campo necesita una clave y una etiqueta.' });

  if (getProfileFieldByKey(key)) {
    return sendJson(res, 409, { ok: false, error: 'Ya existe un campo con esa clave.' });
  }

  const field = createProfileField({ key, label, type, required: Boolean(body.required) });
  sendJson(res, 201, { ok: true, field });
}

async function handleAdminProfileFieldUpdate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id del campo.' });

  try {
    const field = updateProfileField(body.id, {
      label: body.label,
      type: body.type,
      required: body.required,
      active: body.active,
    });
    sendJson(res, 200, { ok: true, field });
  } catch {
    sendJson(res, 404, { ok: false, error: 'Campo no encontrado.' });
  }
}

async function handleAdminProfileFieldDelete(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  if (!body.id) return sendJson(res, 400, { ok: false, error: 'Falta el id del campo.' });

  try {
    deleteProfileField(body.id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const msg = err.message === 'PROFILE_FIELD_IN_USE'
      ? 'Ya hay clientes con datos en este campo: no se puede borrar, solo desactivar.'
      : 'Campo no encontrado.';
    sendJson(res, 400, { ok: false, error: msg });
  }
}

// ───────────────────────── cliente: campos de perfil dinámicos ─────────────────────────

async function handleProfileFieldsSubmit(req, res) {
  if (rateLimited(req, res, 'profile-fields', { max: 20, windowMs: 10 * 60_000 })) return;
  const found = getSessionFromRequest(req);
  if (!found) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const values = body.values && typeof body.values === 'object' ? body.values : {};
  setUserProfileValues(found.session.user_id, values);
  sendJson(res, 200, { ok: true, items: getUserProfileValues(found.session.user_id) });
}

// ───────────────────────── administrador: exportar CSV ─────────────────────────

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end('﻿' + csv);
}

function handleAdminExportUsers(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  const csv = toCsv(adminAllUsers(), [
    { key: 'name', label: 'Nombre' },
    { key: 'email', label: 'Email' },
    { key: 'dni', label: 'DNI' },
    { key: 'telefono', label: 'Celular' },
    { key: 'puntos', label: 'Estrellas' },
    { key: 'num_compras', label: 'Compras' },
    { key: 'total_gastado', label: 'Total gastado' },
    { key: 'totp_enabled', label: '2FA activo' },
    { key: 'created_at', label: 'Registrado' },
  ]);
  sendCsv(res, 'usuarios.csv', csv);
}

function handleAdminExportPurchases(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  const csv = toCsv(adminAllPurchases(), [
    { key: 'created_at', label: 'Fecha' },
    { key: 'user_name', label: 'Cliente' },
    { key: 'user_email', label: 'Email' },
    { key: 'producto', label: 'Producto' },
    { key: 'monto', label: 'Monto' },
    { key: 'puntos', label: 'Estrellas' },
  ]);
  sendCsv(res, 'compras.csv', csv);
}

function handleAdminExportReferrals(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  const csv = toCsv(adminAllReferrals(), [
    { key: 'name', label: 'Usuario' },
    { key: 'email', label: 'Email' },
    { key: 'referrer_name', label: 'Referido por' },
    { key: 'referrer_email', label: 'Email referidor' },
    { key: 'num_compras', label: 'Compras' },
    { key: 'puntos', label: 'Estrellas' },
    { key: 'fecha_registro', label: 'Fecha' },
  ]);
  sendCsv(res, 'referidos.csv', csv);
}

// ───────────────────────── estáticos ─────────────────────────

function serveStatic(req, res, urlPath) {
  const requestPath = decodeURIComponent(urlPath);
  const relativePath = requestPath === '/' ? '/index.html' : requestPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - No encontrado');
    }
    const ext = path.extname(resolvedPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ───────────────────────── router ─────────────────────────

const server = http.createServer(async (req, res) => {
  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const url = fullUrl.pathname;
  const query = fullUrl.searchParams;

  try {
    // suscripción pre-apertura
    if (req.method === 'POST' && url === '/api/subscribe') return handleSubscribe(req, res);
    if (req.method === 'GET' && url === '/api/subscribe/count') return handleCount(req, res);
    if (req.method === 'GET' && url === '/api/admin/subscribers') return handleAdminList(req, res);

    // auth Google + 2FA
    if (req.method === 'GET' && url === '/auth/google') return handleGoogleStart(req, res, query);
    if (req.method === 'GET' && url === '/auth/google/callback') return handleGoogleCallback(req, res, query);
    if (req.method === 'POST' && url === '/api/logout') return handleLogout(req, res);
    if (req.method === 'POST' && url === '/api/logout-all') return handleLogoutAll(req, res);
    if (req.method === 'GET' && url === '/api/me') return handleMe(req, res);
    if (req.method === 'POST' && url === '/api/profile/complete') return handleProfileComplete(req, res);
    if (req.method === 'POST' && url === '/api/2fa/setup') return handleTotpSetup(req, res);
    if (req.method === 'POST' && url === '/api/2fa/verify') return handleTotpVerify(req, res);

    // wallet del usuario
    if (req.method === 'GET' && url === '/api/purchases') return handlePurchasesList(req, res, query);
    if (req.method === 'POST' && url === '/api/points/redeem') return handlePointsRedeem(req, res);
    if (req.method === 'GET' && url === '/api/wallet/spin') return handleSpinStatus(req, res);
    if (req.method === 'POST' && url === '/api/wallet/spin') return handleSpinPlay(req, res);
    if (req.method === 'POST' && url === '/api/profile/fields') return handleProfileFieldsSubmit(req, res);
    if (req.method === 'POST' && url === '/api/family/create') return handleFamilyCreate(req, res);
    if (req.method === 'POST' && url === '/api/family/join') return handleFamilyJoin(req, res);
    if (req.method === 'POST' && url === '/api/family/leave') return handleFamilyLeave(req, res);
    if (req.method === 'POST' && url === '/api/family/remove-member') return handleFamilyRemoveMember(req, res);
    if (req.method === 'GET' && url === '/api/promotions') return handlePromotionsList(req, res);
    if (req.method === 'POST' && url === '/api/promotions/redeem') return handlePromotionRedeem(req, res);
    if (req.method === 'GET' && url === '/api/wallet/google-pass') return handleGoogleWalletPass(req, res);

    // notificaciones push
    if (req.method === 'GET' && url === '/api/push/vapid-public-key') return handlePushVapidKey(req, res);
    if (req.method === 'POST' && url === '/api/push/subscribe') return handlePushSubscribe(req, res);
    if (req.method === 'POST' && url === '/api/push/unsubscribe') return handlePushUnsubscribe(req, res);

    // admin
    if (req.method === 'POST' && url === '/api/admin/purchases') return handleAdminPurchaseCreate(req, res);
    if (req.method === 'GET' && url === '/api/admin/purchases') return handleAdminPurchases(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/users') return handleAdminUsers(req, res, query);
    if (req.method === 'POST' && url === '/api/admin/users/force-logout') return handleAdminForceLogout(req, res);
    if (req.method === 'GET' && url === '/api/admin/referrals') return handleAdminReferrals(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/family-groups') return handleAdminFamilyGroups(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/stats/traffic') return handleAdminTraffic(req, res);
    if (req.method === 'GET' && url === '/api/admin/promotions') return handleAdminPromotionsList(req, res, query);
    if (req.method === 'POST' && url === '/api/admin/promotions') return handleAdminPromotionCreate(req, res);
    if (req.method === 'GET' && url === '/api/admin/promotions/summary') return handleAdminPromotionsSummary(req, res);
    if (req.method === 'GET' && url === '/api/admin/promotions/redeemers') return handleAdminPromotionRedeemers(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/promotions/non-redeemers') return handleAdminPromotionNonRedeemers(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/reports/top-customers') return handleAdminTopCustomers(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/reports/recurring-promo-customers') return handleAdminRecurringPromoCustomers(req, res, query);
    if (req.method === 'POST' && url === '/api/admin/promotions/deactivate') return handleAdminPromotionDeactivate(req, res);
    if (req.method === 'POST' && url === '/api/admin/promotions/update') return handleAdminPromotionUpdate(req, res);
    if (req.method === 'POST' && url === '/api/admin/promotions/delete') return handleAdminPromotionDelete(req, res);
    if (req.method === 'POST' && url === '/api/admin/promotions/codes') return handleAdminPromotionAddCode(req, res);
    if (req.method === 'GET' && url === '/api/admin/products') return handleAdminProductsList(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/products/active') return handleAdminProductsActive(req, res);
    if (req.method === 'POST' && url === '/api/admin/products') return handleAdminProductCreate(req, res);
    if (req.method === 'POST' && url === '/api/admin/products/deactivate') return handleAdminProductDeactivate(req, res);
    if (req.method === 'POST' && url === '/api/admin/products/update') return handleAdminProductUpdate(req, res);
    if (req.method === 'POST' && url === '/api/admin/products/delete') return handleAdminProductDelete(req, res);
    if (req.method === 'GET' && url === '/api/admin/profile-fields') return handleAdminProfileFieldsList(req, res);
    if (req.method === 'POST' && url === '/api/admin/profile-fields') return handleAdminProfileFieldCreate(req, res);
    if (req.method === 'POST' && url === '/api/admin/profile-fields/update') return handleAdminProfileFieldUpdate(req, res);
    if (req.method === 'POST' && url === '/api/admin/profile-fields/delete') return handleAdminProfileFieldDelete(req, res);
    if (req.method === 'GET' && url === '/api/admin/export/users.csv') return handleAdminExportUsers(req, res);
    if (req.method === 'GET' && url === '/api/admin/export/purchases.csv') return handleAdminExportPurchases(req, res);
    if (req.method === 'GET' && url === '/api/admin/export/referrals.csv') return handleAdminExportReferrals(req, res);

    if (req.method === 'GET') return serveStatic(req, res, url);

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Método no permitido');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Error interno del servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`DESENCAJADO suscripción escuchando en http://localhost:${PORT}`);
});

// Revisa promociones programadas: una vez al levantar el servidor (para no
// esperar hasta 24h si algo quedó listo mientras estaba apagado) y luego
// una vez al día — la programación es por día, no por hora, así que no
// hace falta revisar más seguido.
runPromotionScheduler().catch((err) => console.error('Error en el scheduler de promociones:', err));
const promotionSchedulerTimer = setInterval(() => {
  runPromotionScheduler().catch((err) => console.error('Error en el scheduler de promociones:', err));
}, 24 * 3600_000);
promotionSchedulerTimer.unref();
