import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.join(__dirname, '..', 'data');
// DB_FILE permite apuntar a otra base (ej. una temporal en los tests) sin
// tocar la de desarrollo; por defecto sigue siendo data/suscripciones.sqlite.
const DB_PATH = process.env.DB_FILE || path.join(DATA_DIR, 'suscripciones.sqlite');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL: permite que las lecturas sigan corriendo mientras hay una escritura
// en curso, en vez de bloquearse entre sí (el modo por defecto de SQLite).
// busy_timeout: si dos escrituras sí chocan, espera hasta 5s reintentando
// en vez de fallar al toque con SQLITE_BUSY.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    telefono TEXT NOT NULL,
    dni TEXT NOT NULL UNIQUE,
    unasam TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    referral_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER,
    family_group_id INTEGER,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS family_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    monto REAL NOT NULL,
    producto TEXT,
    puntos INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    pushed_to INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo_url TEXT,
    price REAL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_products (
    promotion_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    PRIMARY KEY (promotion_id, product_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id INTEGER NOT NULL,
    code TEXT NOT NULL UNIQUE,
    label TEXT,
    max_uses INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_code_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Campos de perfil configurables desde el admin (ej. fecha de nacimiento,
// algún número de referencia futuro) sin necesitar una migración de columna
// nueva cada vez — se agregan/quitan como filas, no como ALTER TABLE.
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text',
    required INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profile_values (
    user_id INTEGER NOT NULL,
    field_id INTEGER NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, field_id)
  )
`);

interface ColumnInfo {
  name: string;
  [key: string]: unknown;
}

// Migración in-place: agrega columnas nuevas a `promotions` si la base de
// datos ya existía de una versión anterior (SQLite no soporta
// "ADD COLUMN IF NOT EXISTS").
// Devuelve true si la columna no existía y hubo que agregarla — para
// migraciones que además necesitan un backfill único (ver activated_at).
function ensureColumn(table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

ensureColumn('promotions', 'photo_url', 'TEXT');
ensureColumn('promotions', 'starts_at', 'TEXT');
ensureColumn('promotions', 'ends_at', 'TEXT');
ensureColumn('promotions', 'publication_code', 'TEXT');
if (ensureColumn('promotions', 'activated_at', 'TEXT')) {
  // Las promociones que ya existían antes de este cambio se consideran ya
  // activadas (con su fecha de creación como referencia) — si no, el
  // scheduler las agarraría como "pendientes" y les volvería a mandar push
  // a todo el mundo la primera vez que arranque el servidor con la columna
  // nueva. En una base recién creada esta tabla está vacía, así que no
  // afecta a nadie.
  db.exec('UPDATE promotions SET activated_at = created_at WHERE activated_at IS NULL');
}
ensureColumn('sessions', 'totp_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('sessions', 'totp_locked_until', 'TEXT');
ensureColumn('users', 'wallet_saved_at', 'TEXT');
ensureColumn('users', 'last_spin_at', 'TEXT');
ensureColumn('users', 'dni', 'TEXT');
ensureColumn('users', 'telefono', 'TEXT');
// De dónde se registró el cliente ('web' = landing normal, 'local' = escaneó
// el QR físico del negocio) — puramente informativo para reportes, nunca
// cambia después del primer registro.
ensureColumn('users', 'signup_source', "TEXT NOT NULL DEFAULT 'web'");

// Precio especial para clientes logueados (combo solo-miembros, ej. Bembos):
// NULL = el producto no tiene precio de socio, se vende solo al precio normal.
ensureColumn('products', 'member_price', 'REAL');

// Único entre quienes ya lo llenaron: SQLite no deja agregar UNIQUE en un
// ALTER TABLE ADD COLUMN, así que va como índice parcial aparte. Permite
// múltiples NULL (usuarios que aún no completaron su perfil).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_dni ON users(dni) WHERE dni IS NOT NULL');

db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_promo_products_promo ON promotion_products(promotion_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_promo_codes_promo ON promotion_codes(promotion_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promotion_redemptions(promotion_code_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_profile_values_user ON user_profile_values(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_family_group ON users(family_group_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)');

const SOLES_PER_PUNTO = Number(process.env.SOLES_PER_PUNTO) > 0 ? Number(process.env.SOLES_PER_PUNTO) : 5;
const REWARD_THRESHOLD = Number(process.env.REWARD_THRESHOLD) > 0 ? Number(process.env.REWARD_THRESHOLD) : 50;
const REFERRAL_BONUS_POINTS = Number(process.env.REFERRAL_BONUS_POINTS) >= 0 ? Number(process.env.REFERRAL_BONUS_POINTS) : 20;
const REFERRAL_WELCOME_POINTS = Number(process.env.REFERRAL_WELCOME_POINTS) >= 0 ? Number(process.env.REFERRAL_WELCOME_POINTS) : 10;
const TOTP_MAX_ATTEMPTS = Number(process.env.TOTP_MAX_ATTEMPTS) > 0 ? Number(process.env.TOTP_MAX_ATTEMPTS) : 5;
const TOTP_LOCKOUT_MINUTES = Number(process.env.TOTP_LOCKOUT_MINUTES) > 0 ? Number(process.env.TOTP_LOCKOUT_MINUTES) : 5;
const TIER_SILVER_THRESHOLD = Number(process.env.TIER_SILVER_THRESHOLD) >= 0 ? Number(process.env.TIER_SILVER_THRESHOLD) : 100;
const TIER_GOLD_THRESHOLD = Number(process.env.TIER_GOLD_THRESHOLD) >= 0 ? Number(process.env.TIER_GOLD_THRESHOLD) : 300;
const SPIN_COOLDOWN_HOURS = Number(process.env.SPIN_COOLDOWN_HOURS) > 0 ? Number(process.env.SPIN_COOLDOWN_HOURS) : 24;

// ───────────────────────── tipos de dominio ─────────────────────────

export interface Subscriber {
  id: number;
  nombre: string;
  telefono: string;
  dni: string;
  unasam: string;
  created_at: string;
}

export interface User {
  id: number;
  google_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  referral_code: string;
  referred_by: number | null;
  family_group_id: number | null;
  totp_secret: string | null;
  totp_enabled: number;
  is_admin: number;
  created_at: string;
  wallet_saved_at: string | null;
  last_spin_at: string | null;
  dni: string | null;
  telefono: string | null;
  signup_source: string;
}

export interface Session {
  token: string;
  user_id: number;
  stage: string;
  created_at: string;
  expires_at: string;
  totp_attempts: number;
  totp_locked_until: string | null;
}

export interface FamilyGroup {
  id: number;
  name: string;
  owner_user_id: number;
  invite_code: string;
  created_at: string;
}

export interface FamilyMember {
  id: number;
  name: string;
  email: string;
  avatar_url: string | null;
}

export interface FamilyGroupWithMembers extends FamilyGroup {
  members: FamilyMember[];
}

export interface Product {
  id: number;
  name: string;
  photo_url: string | null;
  price: number | null;
  member_price: number | null;
  active: number;
  created_at: string;
}

export interface ProfileField {
  id: number;
  field_key: string;
  label: string;
  field_type: string;
  required: number;
  active: number;
  created_at: string;
}

export interface UserProfileValueRow {
  id: number;
  field_key: string;
  label: string;
  field_type: string;
  required: number;
  value: string | null;
}

export interface Promotion {
  id: number;
  title: string;
  body: string;
  active: number;
  pushed_to: number;
  created_at: string;
  photo_url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  publication_code: string | null;
  activated_at: string | null;
}

export interface PromotionCode {
  id: number;
  promotion_id: number;
  code: string;
  label: string | null;
  max_uses: number | null;
  uses_count: number;
  created_at: string;
}

export interface PromotionHydrated extends Promotion {
  products: Product[];
  codes: PromotionCode[];
}

export interface PromotionHydratedPublic extends Promotion {
  products: Product[];
}

export interface PushSubscriptionDbRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface Purchase {
  id: number;
  monto: number;
  producto: string | null;
  puntos: number;
  created_at: string;
}

export interface PaginationParams {
  limit?: number | string;
  page?: number | string;
  q?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ───────────────────────── suscripciones (pre-apertura) ─────────────────────────

const insertStmt = db.prepare(
  'INSERT INTO subscribers (nombre, telefono, dni, unasam) VALUES (?, ?, ?, ?)'
);
const countStmt = db.prepare('SELECT COUNT(*) AS total FROM subscribers');
const findByDniStmt = db.prepare('SELECT id FROM subscribers WHERE dni = ?');
const listStmt = db.prepare(
  'SELECT id, nombre, telefono, dni, unasam, created_at FROM subscribers ORDER BY id DESC'
);

function addSubscriber({ nombre, telefono, dni, unasam }: { nombre: string; telefono: string; dni: string; unasam: string }): void {
  insertStmt.run(nombre, telefono, dni, unasam);
}

function dniExists(dni: string): boolean {
  return findByDniStmt.get(dni) !== undefined;
}

function getCount(): number {
  return (countStmt.get() as unknown as { total: number }).total;
}

function listSubscribers(): Subscriber[] {
  return listStmt.all() as unknown as Subscriber[];
}

// ───────────────────────── helpers ─────────────────────────

function paginate({ limit = 20, page = 1 }: PaginationParams = {}): { limit: number; offset: number; page: number } {
  const l = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const p = Math.max(Number(page) || 1, 1);
  return { limit: l, offset: (p - 1) * l, page: p };
}

function randomCode(length = 8): string {
  return crypto.randomBytes(length).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, length).toUpperCase();
}

// ───────────────────────── usuarios / wallet ─────────────────────────

const getUserByGoogleIdStmt = db.prepare('SELECT * FROM users WHERE google_id = ?');
const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByReferralCodeStmt = db.prepare('SELECT * FROM users WHERE referral_code = ?');
const insertUserStmt = db.prepare(
  `INSERT INTO users (google_id, email, name, avatar_url, referral_code, signup_source)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const updateUserProfileStmt = db.prepare(
  'UPDATE users SET name = ?, avatar_url = ? WHERE id = ?'
);
const setUserContactStmt = db.prepare('UPDATE users SET dni = ?, telefono = ? WHERE id = ?');
const setReferredByStmt = db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL');
const deleteAllSessionsForUserStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const setTotpSecretStmt = db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?');
const enableTotpStmt = db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?');
const setFamilyGroupStmt = db.prepare('UPDATE users SET family_group_id = ? WHERE id = ?');
const markWalletSavedStmt = db.prepare("UPDATE users SET wallet_saved_at = datetime('now') WHERE id = ?");
const listWalletSavedUserIdsStmt = db.prepare('SELECT id FROM users WHERE wallet_saved_at IS NOT NULL');

function upsertGoogleUser({
  googleId,
  email,
  name,
  avatarUrl,
  source,
}: {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  source?: string | null;
}): User {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const existing = getUserByGoogleIdStmt.get(googleId) as unknown as User | undefined;
  if (existing) {
    updateUserProfileStmt.run(name, avatarUrl || null, existing.id);
    return getUserByIdStmt.get(existing.id) as unknown as User;
  }
  let referralCode: string;
  do {
    referralCode = randomCode(8);
  } while (getUserByReferralCodeStmt.get(referralCode));
  // `source` solo se guarda al CREAR la cuenta — es de dónde vino su primer
  // registro (QR del local vs. web normal), no algo que deba cambiar después.
  const cleanSource = source === 'local' ? 'local' : 'web';
  const info = insertUserStmt.run(googleId, cleanEmail, name, avatarUrl || null, referralCode, cleanSource);
  return getUserByIdStmt.get(info.lastInsertRowid) as unknown as User;
}

function getUserById(id: number): User | undefined {
  return getUserByIdStmt.get(id) as unknown as User | undefined;
}

function getUserByEmail(email: string): User | undefined {
  return getUserByEmailStmt.get(email) as unknown as User | undefined;
}

function getUserByReferralCode(code: string): User | undefined {
  return getUserByReferralCodeStmt.get(code) as unknown as User | undefined;
}

// Vincula DNI y teléfono a la cuenta de wallet del cliente (Google no los
// entrega en el login — se piden aparte, ver server.js: /api/profile/complete).
// Es la base para poder cruzar más adelante con fecha de nacimiento y mandar
// promociones dirigidas (ej. cumpleaños) por WhatsApp/SMS.
function setUserContactInfo(userId: number, dni: string, telefono: string): void {
  try {
    setUserContactStmt.run(dni, telefono, userId);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE constraint failed')) {
      throw new Error('DNI_TAKEN');
    }
    throw err;
  }
}

// Marca que el usuario abrió el link "Guardar en Google Wallet" — es la
// única señal que tenemos de que su loyaltyObject fue creado del lado de
// Google (la Wallet API no expone un endpoint para consultarlo).
function markWalletSaved(userId: number): void {
  markWalletSavedStmt.run(userId);
}

function listWalletSavedUserIds(): number[] {
  return (listWalletSavedUserIdsStmt.all() as unknown as { id: number }[]).map((row) => row.id);
}

// Solo aplica (y solo paga el bono) la primera vez: setReferredByStmt tiene
// `AND referred_by IS NULL`, así que un segundo intento no vuelve a pagar.
function setReferredBy(userId: number, referrerId: number): boolean {
  if (userId === referrerId) return false;
  const info = setReferredByStmt.run(referrerId, userId);
  if (info.changes === 0) return false;
  if (REFERRAL_BONUS_POINTS > 0) {
    insertLedgerStmt.run(referrerId, REFERRAL_BONUS_POINTS, `Bono por referir a un nuevo cliente`);
  }
  if (REFERRAL_WELCOME_POINTS > 0) {
    insertLedgerStmt.run(userId, REFERRAL_WELCOME_POINTS, 'Bono de bienvenida por registrarte con un código de referido');
  }
  return true;
}

function deleteAllSessionsForUser(userId: number): void {
  deleteAllSessionsForUserStmt.run(userId);
}

function setTotpSecret(userId: number, secret: string): void {
  setTotpSecretStmt.run(secret, userId);
}

function enableTotp(userId: number): void {
  enableTotpStmt.run(userId);
}

// ───────────────────────── sesiones ─────────────────────────

const insertSessionStmt = db.prepare(
  'INSERT INTO sessions (token, user_id, stage, expires_at) VALUES (?, ?, ?, ?)'
);
const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
const setSessionStageStmt = db.prepare('UPDATE sessions SET stage = ? WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpiredSessionsStmt = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')");

const SESSION_TTL_DAYS = 30;

function createSession(userId: number, stage: string): string {
  deleteExpiredSessionsStmt.run();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  insertSessionStmt.run(token, userId, stage, expiresAt);
  return token;
}

function getSession(token: string | undefined | null): Session | undefined {
  if (!token) return undefined;
  const session = getSessionStmt.get(token) as unknown as Session | undefined;
  if (!session) return undefined;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    deleteSessionStmt.run(token);
    return undefined;
  }
  return session;
}

function setSessionStage(token: string, stage: string): void {
  setSessionStageStmt.run(stage, token);
}

function deleteSession(token: string): void {
  deleteSessionStmt.run(token);
}

// ───────────────────────── bloqueo de intentos 2FA ─────────────────────────

const incrementTotpAttemptsStmt = db.prepare(
  `UPDATE sessions SET totp_attempts = totp_attempts + 1,
     totp_locked_until = CASE WHEN totp_attempts + 1 >= ? THEN datetime('now', ?) ELSE totp_locked_until END
   WHERE token = ?`
);
const resetTotpAttemptsStmt = db.prepare('UPDATE sessions SET totp_attempts = 0, totp_locked_until = NULL WHERE token = ?');

// SQLite datetime('now', ...) devuelve "YYYY-MM-DD HH:MM:SS" en UTC pero sin
// sufijo de zona horaria; hay que normalizarlo a ISO 8601 antes de comparar
// con `new Date()`, si no V8 lo interpreta como hora local.
function sqliteUtcToDate(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function isTotpLocked(session: Session): boolean {
  return Boolean(session.totp_locked_until && sqliteUtcToDate(session.totp_locked_until) > new Date());
}

function registerTotpFailure(token: string): void {
  incrementTotpAttemptsStmt.run(TOTP_MAX_ATTEMPTS, `+${TOTP_LOCKOUT_MINUTES} minutes`, token);
}

function resetTotpAttempts(token: string): void {
  resetTotpAttemptsStmt.run(token);
}

// ───────────────────────── puntos / compras (consumo) ─────────────────────────

const insertPurchaseStmt = db.prepare(
  'INSERT INTO purchases (user_id, monto, producto, puntos) VALUES (?, ?, ?, ?)'
);
const insertLedgerStmt = db.prepare(
  'INSERT INTO points_ledger (user_id, delta, reason) VALUES (?, ?, ?)'
);
const balanceStmt = db.prepare(
  'SELECT COALESCE(SUM(delta), 0) AS balance FROM points_ledger WHERE user_id = ?'
);
// El "revisar saldo y luego escribir" en dos pasos separados sería una
// condición de carrera bajo más de un proceso compartiendo la misma base;
// esta versión hace el chequeo y la escritura en una sola sentencia SQL
// (el WHERE de la subquery corre atómicamente dentro del propio INSERT),
// así que es segura sin importar cuántos procesos la llamen a la vez.
const insertLedgerIfBalanceStmt = db.prepare(`
  INSERT INTO points_ledger (user_id, delta, reason)
  SELECT ?, ?, ?
  WHERE (SELECT COALESCE(SUM(delta), 0) FROM points_ledger WHERE user_id = ?) >= ?
`);
const listPurchasesByUserStmt = db.prepare(
  `SELECT id, monto, producto, puntos, created_at FROM purchases
   WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
);
const countPurchasesByUserStmt = db.prepare('SELECT COUNT(*) AS total FROM purchases WHERE user_id = ?');

function addPurchase({ userId, monto, producto }: { userId: number; monto: number; producto?: string | null }): {
  purchaseId: number | bigint;
  puntos: number;
  balance: number;
} {
  const puntos = Math.max(Math.floor(monto / SOLES_PER_PUNTO), 0);
  const info = insertPurchaseStmt.run(userId, monto, producto || null, puntos);
  if (puntos > 0) {
    insertLedgerStmt.run(userId, puntos, `Compra #${info.lastInsertRowid}`);
  }
  return { purchaseId: info.lastInsertRowid, puntos, balance: getPointsBalance(userId) };
}

function getPointsBalance(userId: number): number {
  return (balanceStmt.get(userId) as unknown as { balance: number }).balance;
}

function listPurchasesByUser(userId: number, { limit = 20, page = 1 }: PaginationParams = {}): PaginatedResult<Purchase> {
  const p = paginate({ limit, page });
  const items = listPurchasesByUserStmt.all(userId, p.limit, p.offset) as unknown as Purchase[];
  const total = (countPurchasesByUserStmt.get(userId) as unknown as { total: number }).total;
  return { items, total, page: p.page, limit: p.limit };
}

function redeemPoints(userId: number, puntos: number, motivo?: string): number {
  const amount = Math.floor(Number(puntos));
  if (!(amount > 0)) throw new Error('INVALID_AMOUNT');
  const claimed = insertLedgerIfBalanceStmt.run(userId, -amount, motivo || 'Canje', userId, amount);
  if (claimed.changes === 0) throw new Error('INSUFFICIENT_BALANCE');
  return getPointsBalance(userId);
}

function getRewardProgress(userId: number): {
  balance: number;
  threshold: number;
  inCycle: number;
  remaining: number;
  progressPct: number;
  rewardsAvailable: number;
} {
  const balance = getPointsBalance(userId);
  const inCycle = ((balance % REWARD_THRESHOLD) + REWARD_THRESHOLD) % REWARD_THRESHOLD;
  return {
    balance,
    threshold: REWARD_THRESHOLD,
    inCycle,
    remaining: Math.max(REWARD_THRESHOLD - inCycle, 0),
    progressPct: Math.round((inCycle / REWARD_THRESHOLD) * 100),
    rewardsAvailable: Math.floor(balance / REWARD_THRESHOLD),
  };
}

// ───────────────────────── niveles de fidelidad ─────────────────────────
//
// A diferencia del saldo canjeable (getPointsBalance, que baja al redimir),
// el nivel se calcula sobre los puntos ganados de por vida: canjear premios
// no debería hacerte "bajar de nivel".

const lifetimePointsStmt = db.prepare(
  'SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger WHERE user_id = ? AND delta > 0'
);

function getLifetimePoints(userId: number): number {
  return (lifetimePointsStmt.get(userId) as unknown as { total: number }).total;
}

export type TierName = 'bronce' | 'plata' | 'oro';

export interface TierStatus {
  tier: TierName;
  lifetimePoints: number;
  nextTier: TierName | null;
  pointsToNext: number;
}

function tierForPoints(lifetimePoints: number): TierStatus {
  if (lifetimePoints >= TIER_GOLD_THRESHOLD) {
    return { tier: 'oro', lifetimePoints, nextTier: null, pointsToNext: 0 };
  }
  if (lifetimePoints >= TIER_SILVER_THRESHOLD) {
    return {
      tier: 'plata',
      lifetimePoints,
      nextTier: 'oro',
      pointsToNext: TIER_GOLD_THRESHOLD - lifetimePoints,
    };
  }
  return {
    tier: 'bronce',
    lifetimePoints,
    nextTier: 'plata',
    pointsToNext: TIER_SILVER_THRESHOLD - lifetimePoints,
  };
}

function getTierForUser(userId: number): TierStatus {
  return tierForPoints(getLifetimePoints(userId));
}

// ───────────────────────── ruleta de premios ─────────────────────────

interface SpinPrize {
  label: string;
  points: number;
  weight: number;
}

const SPIN_PRIZES: SpinPrize[] = [
  { label: 'Sigue participando', points: 0, weight: 10 },
  { label: '+5 estrellas', points: 5, weight: 40 },
  { label: '+10 estrellas', points: 10, weight: 30 },
  { label: '+20 estrellas', points: 20, weight: 15 },
  { label: '+50 estrellas', points: 50, weight: 5 },
];
const SPIN_WEIGHT_TOTAL = SPIN_PRIZES.reduce((sum, p) => sum + p.weight, 0);

function pickSpinPrize(): SpinPrize {
  let roll = Math.random() * SPIN_WEIGHT_TOTAL;
  for (const prize of SPIN_PRIZES) {
    if (roll < prize.weight) return prize;
    roll -= prize.weight;
  }
  return SPIN_PRIZES[SPIN_PRIZES.length - 1];
}

function nextSpinAt(user: User | undefined): Date | null {
  if (!user || !user.last_spin_at) return null;
  return new Date(sqliteUtcToDate(user.last_spin_at).getTime() + SPIN_COOLDOWN_HOURS * 3600_000);
}

export interface SpinStatus {
  available: boolean;
  nextSpinAt: string | null;
  cooldownHours: number;
}

function getSpinStatus(userId: number): SpinStatus {
  const next = nextSpinAt(getUserByIdStmt.get(userId) as unknown as User | undefined);
  const available = !next || next <= new Date();
  return {
    available,
    nextSpinAt: available || !next ? null : next.toISOString(),
    cooldownHours: SPIN_COOLDOWN_HOURS,
  };
}

// Reclama el giro (revisa el cooldown y marca last_spin_at) en una sola
// sentencia atómica — el WHERE decide, dentro del propio UPDATE, si a este
// usuario ya le tocaba girar de nuevo. Dos giros simultáneos del mismo
// usuario no pueden ganar los dos: solo el primero cambia una fila.
const claimSpinStmt = db.prepare(
  `UPDATE users SET last_spin_at = datetime('now')
   WHERE id = ? AND (last_spin_at IS NULL OR datetime(last_spin_at, '+' || ? || ' hours') <= datetime('now'))`
);

function spinWheel(userId: number): { prize: SpinPrize; balance: number; spinStatus: SpinStatus } {
  const claimed = claimSpinStmt.run(userId, SPIN_COOLDOWN_HOURS);
  if (claimed.changes === 0) throw new Error('SPIN_COOLDOWN');

  const prize = pickSpinPrize();
  if (prize.points > 0) {
    insertLedgerStmt.run(userId, prize.points, `Ruleta: ${prize.label}`);
  }
  return { prize, balance: getPointsBalance(userId), spinStatus: getSpinStatus(userId) };
}

// ───────────────────────── familia / compartidos ─────────────────────────

const insertFamilyGroupStmt = db.prepare(
  'INSERT INTO family_groups (name, owner_user_id, invite_code) VALUES (?, ?, ?)'
);
const getFamilyGroupByIdStmt = db.prepare('SELECT * FROM family_groups WHERE id = ?');
const getFamilyGroupByInviteCodeStmt = db.prepare('SELECT * FROM family_groups WHERE invite_code = ?');
const listFamilyMembersStmt = db.prepare(
  'SELECT id, name, email, avatar_url FROM users WHERE family_group_id = ?'
);

function createFamilyGroup(userId: number, name: string): FamilyGroup {
  let inviteCode: string;
  do {
    inviteCode = randomCode(6);
  } while (getFamilyGroupByInviteCodeStmt.get(inviteCode));
  const info = insertFamilyGroupStmt.run(name, userId, inviteCode);
  setFamilyGroupStmt.run(info.lastInsertRowid, userId);
  return getFamilyGroupByIdStmt.get(info.lastInsertRowid) as unknown as FamilyGroup;
}

function joinFamilyGroup(userId: number, inviteCode: string): FamilyGroup {
  const group = getFamilyGroupByInviteCodeStmt.get(String(inviteCode || '').toUpperCase()) as unknown as FamilyGroup | undefined;
  if (!group) throw new Error('GROUP_NOT_FOUND');
  setFamilyGroupStmt.run(group.id, userId);
  return group;
}

function getFamilyGroupForUser(userId: number): FamilyGroupWithMembers | null {
  const user = getUserById(userId);
  if (!user || !user.family_group_id) return null;
  const group = getFamilyGroupByIdStmt.get(user.family_group_id) as unknown as FamilyGroup | undefined;
  if (!group) return null;
  return { ...group, members: listFamilyMembersStmt.all(group.id) as unknown as FamilyMember[] };
}

const clearFamilyGroupForAllMembersStmt = db.prepare('UPDATE users SET family_group_id = NULL WHERE family_group_id = ?');
const deleteFamilyGroupStmt = db.prepare('DELETE FROM family_groups WHERE id = ?');

// Si sale el dueño, el grupo se disuelve para todos (no hay a quién
// transferir la propiedad); si sale un miembro normal, solo él se va.
function leaveFamilyGroup(userId: number): { disbanded: boolean } {
  const user = getUserById(userId);
  if (!user || !user.family_group_id) throw new Error('NOT_IN_GROUP');
  const group = getFamilyGroupByIdStmt.get(user.family_group_id) as unknown as FamilyGroup;

  if (group.owner_user_id === userId) {
    clearFamilyGroupForAllMembersStmt.run(group.id);
    deleteFamilyGroupStmt.run(group.id);
    return { disbanded: true };
  }
  setFamilyGroupStmt.run(null, userId);
  return { disbanded: false };
}

function removeFamilyMember(ownerId: number, memberUserId: number): void {
  const owner = getUserById(ownerId);
  if (!owner || !owner.family_group_id) throw new Error('NOT_IN_GROUP');
  const group = getFamilyGroupByIdStmt.get(owner.family_group_id) as unknown as FamilyGroup | undefined;
  if (!group || group.owner_user_id !== ownerId) throw new Error('NOT_OWNER');
  if (Number(memberUserId) === Number(ownerId)) throw new Error('CANNOT_REMOVE_SELF');

  const member = getUserById(memberUserId);
  if (!member || member.family_group_id !== group.id) throw new Error('NOT_A_MEMBER');
  setFamilyGroupStmt.run(null, memberUserId);
}

// ───────────────────────── catálogo de productos ─────────────────────────

const insertProductStmt = db.prepare(
  'INSERT INTO products (name, photo_url, price, member_price) VALUES (?, ?, ?, ?)'
);
const getProductByIdStmt = db.prepare('SELECT * FROM products WHERE id = ?');
const listActiveProductsStmt = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name');
const listActiveCombosStmt = db.prepare(
  'SELECT * FROM products WHERE active = 1 AND member_price IS NOT NULL ORDER BY name'
);
const adminListProductsStmt = db.prepare('SELECT * FROM products ORDER BY id DESC LIMIT ? OFFSET ?');
const adminProductsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM products');
const deactivateProductStmt = db.prepare('UPDATE products SET active = 0 WHERE id = ?');

function createProduct({
  name,
  photoUrl,
  price,
  memberPrice,
}: {
  name: string;
  photoUrl?: string | null;
  price?: number | string | null;
  memberPrice?: number | string | null;
}): Product {
  const info = insertProductStmt.run(
    name,
    photoUrl || null,
    price != null && price !== '' ? Number(price) : null,
    memberPrice != null && memberPrice !== '' ? Number(memberPrice) : null
  );
  return getProductByIdStmt.get(info.lastInsertRowid) as unknown as Product;
}

function getProductById(id: number): Product | undefined {
  return getProductByIdStmt.get(id) as unknown as Product | undefined;
}

function listActiveProducts(): Product[] {
  return listActiveProductsStmt.all() as unknown as Product[];
}

// Combos solo-miembros: catálogo de productos con precio de socio, visible
// únicamente para clientes logueados en cuenta.html (Bembos-style).
function listActiveCombos(): Product[] {
  return listActiveCombosStmt.all() as unknown as Product[];
}

function adminListProducts({ limit = 20, page = 1 }: PaginationParams = {}): PaginatedResult<Product> {
  const p = paginate({ limit, page });
  return {
    items: adminListProductsStmt.all(p.limit, p.offset) as unknown as Product[],
    total: (adminProductsCountStmt.get() as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

function deactivateProduct(id: number): void {
  deactivateProductStmt.run(id);
}

const updateProductStmt = db.prepare('UPDATE products SET name = ?, photo_url = ?, price = ?, member_price = ? WHERE id = ?');
const countPromotionProductsForProductStmt = db.prepare('SELECT COUNT(*) AS total FROM promotion_products WHERE product_id = ?');
const deleteProductStmt = db.prepare('DELETE FROM products WHERE id = ?');

function updateProduct(
  id: number,
  {
    name,
    photoUrl,
    price,
    memberPrice,
  }: { name?: string | null; photoUrl?: string | null; price?: number | string | null; memberPrice?: number | string | null }
): Product {
  const existing = getProductByIdStmt.get(id) as unknown as Product | undefined;
  if (!existing) throw new Error('PRODUCT_NOT_FOUND');
  updateProductStmt.run(
    name != null && name !== '' ? name : existing.name,
    photoUrl !== undefined ? (photoUrl || null) : existing.photo_url,
    price !== undefined ? (price != null && price !== '' ? Number(price) : null) : existing.price,
    memberPrice !== undefined ? (memberPrice != null && memberPrice !== '' ? Number(memberPrice) : null) : existing.member_price,
    id
  );
  return getProductByIdStmt.get(id) as unknown as Product;
}

// Borrado real solo si el producto no está asociado a ninguna promoción; si
// lo está, hay que desactivarlo en vez de borrarlo (no rompe el historial).
function deleteProduct(id: number): void {
  if ((countPromotionProductsForProductStmt.get(id) as unknown as { total: number }).total > 0) throw new Error('PRODUCT_IN_USE');
  const info = deleteProductStmt.run(id);
  if (info.changes === 0) throw new Error('PRODUCT_NOT_FOUND');
}

// ───────────────────────── campos de perfil dinámicos ─────────────────────────
//
// Permite pedir información adicional del cliente (fecha de nacimiento, algún
// número de referencia futuro, lo que sea) sin necesitar una migración de
// columna nueva cada vez: el admin crea el campo desde el panel y el cliente
// lo ve la próxima vez que entra, si está marcado como obligatorio.

const insertProfileFieldStmt = db.prepare(
  'INSERT INTO profile_fields (field_key, label, field_type, required) VALUES (?, ?, ?, ?)'
);
const getProfileFieldByIdStmt = db.prepare('SELECT * FROM profile_fields WHERE id = ?');
const getProfileFieldByKeyStmt = db.prepare('SELECT * FROM profile_fields WHERE field_key = ?');
const listActiveProfileFieldsStmt = db.prepare('SELECT * FROM profile_fields WHERE active = 1 ORDER BY id');
const adminListProfileFieldsStmt = db.prepare('SELECT * FROM profile_fields ORDER BY id');
const updateProfileFieldStmt = db.prepare(
  'UPDATE profile_fields SET label = ?, field_type = ?, required = ?, active = ? WHERE id = ?'
);
const countValuesForFieldStmt = db.prepare('SELECT COUNT(*) AS total FROM user_profile_values WHERE field_id = ?');
const deleteProfileFieldStmt = db.prepare('DELETE FROM profile_fields WHERE id = ?');
const getUserProfileValuesStmt = db.prepare(
  `SELECT f.id, f.field_key, f.label, f.field_type, f.required, v.value
   FROM profile_fields f
   LEFT JOIN user_profile_values v ON v.field_id = f.id AND v.user_id = ?
   WHERE f.active = 1
   ORDER BY f.id`
);
const upsertUserProfileValueStmt = db.prepare(
  `INSERT INTO user_profile_values (user_id, field_id, value, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(user_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);

function createProfileField({
  key,
  label,
  type,
  required,
}: {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
}): ProfileField {
  const info = insertProfileFieldStmt.run(key, label, type || 'text', required ? 1 : 0);
  return getProfileFieldByIdStmt.get(info.lastInsertRowid) as unknown as ProfileField;
}

function getProfileFieldByKey(key: string): ProfileField | undefined {
  return getProfileFieldByKeyStmt.get(key) as unknown as ProfileField | undefined;
}

function listActiveProfileFields(): ProfileField[] {
  return listActiveProfileFieldsStmt.all() as unknown as ProfileField[];
}

function adminListProfileFields(): ProfileField[] {
  return adminListProfileFieldsStmt.all() as unknown as ProfileField[];
}

function updateProfileField(
  id: number,
  { label, type, required, active }: { label?: string | null; type?: string | null; required?: boolean; active?: boolean }
): ProfileField {
  const existing = getProfileFieldByIdStmt.get(id) as unknown as ProfileField | undefined;
  if (!existing) throw new Error('PROFILE_FIELD_NOT_FOUND');
  updateProfileFieldStmt.run(
    label != null && label !== '' ? label : existing.label,
    type || existing.field_type,
    required !== undefined ? (required ? 1 : 0) : existing.required,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    id
  );
  return getProfileFieldByIdStmt.get(id) as unknown as ProfileField;
}

// Borrado real solo si nadie llenó ese campo todavía; si ya hay datos,
// desactivarlo en vez de borrarlo para no perder lo ya recolectado.
function deleteProfileField(id: number): void {
  if ((countValuesForFieldStmt.get(id) as unknown as { total: number }).total > 0) throw new Error('PROFILE_FIELD_IN_USE');
  const info = deleteProfileFieldStmt.run(id);
  if (info.changes === 0) throw new Error('PROFILE_FIELD_NOT_FOUND');
}

// Todos los campos activos con el valor del usuario (null si aún no lo llenó).
function getUserProfileValues(userId: number): UserProfileValueRow[] {
  return getUserProfileValuesStmt.all(userId) as unknown as UserProfileValueRow[];
}

function getMissingRequiredFields(userId: number): UserProfileValueRow[] {
  return getUserProfileValues(userId).filter((f) => f.required && (f.value === null || f.value === undefined));
}

function setUserProfileValues(userId: number, valuesByFieldId: Record<string, unknown>): void {
  for (const [fieldId, value] of Object.entries(valuesByFieldId)) {
    if (value === undefined || value === null || value === '') continue;
    upsertUserProfileValueStmt.run(userId, Number(fieldId), String(value));
  }
}

// ───────────────────────── promociones ─────────────────────────

const insertPromotionStmt = db.prepare(
  'INSERT INTO promotions (title, body, photo_url, starts_at, ends_at, publication_code) VALUES (?, ?, ?, ?, ?, ?)'
);
const getPromotionByIdStmt = db.prepare('SELECT * FROM promotions WHERE id = ?');
const listActivePromotionsRawStmt = db.prepare(
  `SELECT * FROM promotions
   WHERE active = 1
     AND (starts_at IS NULL OR starts_at <= datetime('now'))
     AND (ends_at IS NULL OR ends_at >= datetime('now'))
   ORDER BY id DESC LIMIT 5`
);
const adminListPromotionsStmt = db.prepare(
  'SELECT * FROM promotions ORDER BY id DESC LIMIT ? OFFSET ?'
);
const adminPromotionsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM promotions');
const deactivatePromotionStmt = db.prepare('UPDATE promotions SET active = 0 WHERE id = ?');
const markPromotionPushedStmt = db.prepare('UPDATE promotions SET pushed_to = ? WHERE id = ?');
// Programación por día (no por hora todavía): date() normaliza tanto el
// formato "YYYY-MM-DD HH:MM:SS" de SQLite como el "YYYY-MM-DDTHH:MM" que
// manda el <input type="datetime-local">, así que compara solo el día.
const listPromotionsReadyToActivateStmt = db.prepare(
  `SELECT * FROM promotions
   WHERE active = 1 AND activated_at IS NULL
     AND (starts_at IS NULL OR date(starts_at) <= date('now'))`
);
const markPromotionActivatedStmt = db.prepare("UPDATE promotions SET activated_at = datetime('now') WHERE id = ?");

const insertPromotionProductStmt = db.prepare(
  'INSERT OR IGNORE INTO promotion_products (promotion_id, product_id) VALUES (?, ?)'
);
const listPromotionProductsStmt = db.prepare(
  `SELECT pr.* FROM promotion_products pp
   JOIN products pr ON pr.id = pp.product_id
   WHERE pp.promotion_id = ?
   ORDER BY pr.name`
);

const insertPromotionCodeStmt = db.prepare(
  'INSERT INTO promotion_codes (promotion_id, code, label, max_uses) VALUES (?, ?, ?, ?)'
);
const listPromotionCodesStmt = db.prepare(
  'SELECT * FROM promotion_codes WHERE promotion_id = ? ORDER BY id'
);
const getPromotionCodeByCodeStmt = db.prepare('SELECT * FROM promotion_codes WHERE code = ?');
// Reclama un uso del código y revisa el límite en una sola sentencia
// atómica — si dos clientes canjean el mismo código al mismo tiempo y solo
// queda un uso disponible, el WHERE garantiza que como mucho uno de los dos
// UPDATE afecte una fila; el otro ve changes=0 y sabe que se agotó.
const claimPromotionCodeUseStmt = db.prepare(
  `UPDATE promotion_codes SET uses_count = uses_count + 1
   WHERE id = ? AND (max_uses IS NULL OR uses_count < max_uses)`
);
const insertPromotionRedemptionStmt = db.prepare(
  'INSERT INTO promotion_redemptions (promotion_code_id, user_id) VALUES (?, ?)'
);

function generatePublicationCode(promotionId: number | bigint): string {
  return `PROMO-${String(promotionId).padStart(4, '0')}`;
}

const setPromotionPublicationCodeStmt = db.prepare('UPDATE promotions SET publication_code = ? WHERE id = ?');

// Uso interno/admin: incluye los códigos de canje (uso interno del staff).
function hydratePromotion(promotion: Promotion): PromotionHydrated {
  return {
    ...promotion,
    products: listPromotionProductsStmt.all(promotion.id) as unknown as Product[],
    codes: listPromotionCodesStmt.all(promotion.id) as unknown as PromotionCode[],
  };
}

// Uso público (cliente): NO expone los códigos de canje — el cliente debe
// obtenerlos por el canal donde se distribuya la promo (flyer, redes, etc.)
// y canjearlos a mano; listarlos aquí los filtraría a cualquiera con sesión.
function hydratePromotionPublic(promotion: Promotion): PromotionHydratedPublic {
  return { ...promotion, products: listPromotionProductsStmt.all(promotion.id) as unknown as Product[] };
}

const listActivePromotionTitlesStmt = db.prepare('SELECT * FROM promotions WHERE active = 1');

// Un doble clic al publicar, o simplemente olvidar que ya existe, puede
// crear la misma promoción dos veces — esto la detecta (mismo título,
// insensible a mayúsculas/acentos/espacios) entre las promociones activas,
// para que el admin decida si de verdad quiere publicarla de nuevo.
// La comparación se hace en JS (no con LOWER() de SQLite) porque LOWER()
// solo pliega mayúsculas ASCII — "FRAPPÉS" no lo reconocería igual a
// "frappés" si se comparara dentro de la consulta.
function findActivePromotionByTitle(title: string): Promotion | undefined {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized) return undefined;
  return (listActivePromotionTitlesStmt.all() as unknown as Promotion[]).find((p) => p.title.trim().toLowerCase() === normalized);
}

function createPromotion({
  title,
  body,
  photoUrl,
  startsAt,
  endsAt,
  productIds = [],
}: {
  title: string;
  body: string;
  photoUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  productIds?: number[];
}): PromotionHydrated {
  const info = insertPromotionStmt.run(title, body, photoUrl || null, startsAt || null, endsAt || null, null);
  const id = info.lastInsertRowid;
  setPromotionPublicationCodeStmt.run(generatePublicationCode(id), id);
  for (const productId of productIds) {
    insertPromotionProductStmt.run(id, productId);
  }
  return hydratePromotion(getPromotionByIdStmt.get(id) as unknown as Promotion);
}

function addPromotionCode(
  promotionId: number,
  { code, label, maxUses }: { code?: string | null; label?: string | null; maxUses?: number | string | null }
): PromotionHydrated {
  const cleanCode = String(code || '').trim().toUpperCase() || randomCode(8);
  insertPromotionCodeStmt.run(promotionId, cleanCode, label || null, maxUses ? Number(maxUses) : null);
  return hydratePromotion(getPromotionByIdStmt.get(promotionId) as unknown as Promotion);
}

function redeemPromotionCode(
  code: string,
  userId: number
): { promotion: PromotionHydratedPublic; code: { label: string | null; usesRemaining: number | null } } {
  const promoCode = getPromotionCodeByCodeStmt.get(String(code || '').trim().toUpperCase()) as unknown as PromotionCode | undefined;
  if (!promoCode) throw new Error('CODE_NOT_FOUND');

  const promotion = getPromotionByIdStmt.get(promoCode.promotion_id) as unknown as Promotion | undefined;
  if (!promotion || !promotion.active) throw new Error('PROMOTION_INACTIVE');
  const now = new Date();
  if (promotion.starts_at && new Date(promotion.starts_at) > now) throw new Error('PROMOTION_NOT_STARTED');
  if (promotion.ends_at && new Date(promotion.ends_at) < now) throw new Error('PROMOTION_EXPIRED');

  const claimed = claimPromotionCodeUseStmt.run(promoCode.id);
  if (claimed.changes === 0) throw new Error('CODE_EXHAUSTED');
  insertPromotionRedemptionStmt.run(promoCode.id, userId);
  // Solo se devuelve el código canjeado, no el resto de códigos de la
  // promoción (podrían ser de otra sucursal/tanda y no le corresponden a este cliente).
  return {
    promotion: hydratePromotionPublic(promotion),
    code: { label: promoCode.label, usesRemaining: promoCode.max_uses != null ? promoCode.max_uses - (promoCode.uses_count + 1) : null },
  };
}

function listActivePromotions(): PromotionHydratedPublic[] {
  return (listActivePromotionsRawStmt.all() as unknown as Promotion[]).map(hydratePromotionPublic);
}

// Trae productos/códigos de TODAS las promociones de la página en dos
// consultas (en vez de dos por fila) — evita el N+1 al listar promociones.
function productsByPromotionId(promotionIds: (number | bigint)[]): Map<number, Product[]> {
  const map = new Map<number, Product[]>();
  if (promotionIds.length === 0) return map;
  const placeholders = promotionIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT pp.promotion_id AS promotion_id, pr.* FROM promotion_products pp
     JOIN products pr ON pr.id = pp.product_id
     WHERE pp.promotion_id IN (${placeholders})
     ORDER BY pr.name`
  ).all(...promotionIds) as unknown as (Product & { promotion_id: number })[];
  for (const { promotion_id, ...product } of rows) {
    if (!map.has(promotion_id)) map.set(promotion_id, []);
    map.get(promotion_id)!.push(product);
  }
  return map;
}

function codesByPromotionId(promotionIds: (number | bigint)[]): Map<number, PromotionCode[]> {
  const map = new Map<number, PromotionCode[]>();
  if (promotionIds.length === 0) return map;
  const placeholders = promotionIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM promotion_codes WHERE promotion_id IN (${placeholders}) ORDER BY id`
  ).all(...promotionIds) as unknown as PromotionCode[];
  for (const row of rows) {
    if (!map.has(row.promotion_id)) map.set(row.promotion_id, []);
    map.get(row.promotion_id)!.push(row);
  }
  return map;
}

// Cuántos clientes DISTINTOS canjearon algún código de cada promoción de la
// página, en una sola consulta batch (igual que products/codesByPromotionId).
function redeemedCountByPromotionId(promotionIds: (number | bigint)[]): Map<number, number> {
  const map = new Map<number, number>();
  if (promotionIds.length === 0) return map;
  const placeholders = promotionIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT pc.promotion_id AS promotion_id, COUNT(DISTINCT pr.user_id) AS redeemed_count
     FROM promotion_redemptions pr
     JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
     WHERE pc.promotion_id IN (${placeholders})
     GROUP BY pc.promotion_id`
  ).all(...promotionIds) as unknown as { promotion_id: number; redeemed_count: number }[];
  for (const row of rows) map.set(row.promotion_id, row.redeemed_count);
  return map;
}

const getPromotionRedeemersStmt = db.prepare(
  `SELECT u.id AS user_id, u.name, u.email, pc.code, pr.created_at AS redeemed_at
   FROM promotion_redemptions pr
   JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
   JOIN users u ON u.id = pr.user_id
   WHERE pc.promotion_id = ?
   ORDER BY pr.created_at DESC`
);

export interface PromotionRedeemerRow {
  user_id: number;
  name: string;
  email: string;
  code: string;
  redeemed_at: string;
}

// Quiénes canjearon esta promoción — para el admin, "quiénes fueron los
// elegidos". Los que NO canjearon se obtienen restando esta lista del
// total de clientes (adminPromotionsSummary / adminListUsers).
function getPromotionRedeemers(promotionId: number): PromotionRedeemerRow[] {
  return getPromotionRedeemersStmt.all(promotionId) as unknown as PromotionRedeemerRow[];
}

const nonRedeemersBaseStmt = db.prepare(
  `SELECT u.id AS user_id, u.name, u.email, u.created_at
   FROM users u
   WHERE u.id NOT IN (
     SELECT pr.user_id FROM promotion_redemptions pr
     JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
     WHERE pc.promotion_id = ?
   )
   ORDER BY u.created_at DESC
   LIMIT ? OFFSET ?`
);
const nonRedeemersBaseCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM users u
   WHERE u.id NOT IN (
     SELECT pr.user_id FROM promotion_redemptions pr
     JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
     WHERE pc.promotion_id = ?
   )`
);
const nonRedeemersSearchStmt = db.prepare(
  `SELECT u.id AS user_id, u.name, u.email, u.created_at
   FROM users u
   WHERE u.id NOT IN (
     SELECT pr.user_id FROM promotion_redemptions pr
     JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
     WHERE pc.promotion_id = ?
   ) AND (u.name LIKE ? OR u.email LIKE ?)
   ORDER BY u.created_at DESC
   LIMIT ? OFFSET ?`
);
const nonRedeemersSearchCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM users u
   WHERE u.id NOT IN (
     SELECT pr.user_id FROM promotion_redemptions pr
     JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
     WHERE pc.promotion_id = ?
   ) AND (u.name LIKE ? OR u.email LIKE ?)`
);

export interface NonRedeemerRow {
  user_id: number;
  name: string;
  email: string;
  created_at: string;
}

// Quiénes NO canjearon ningún código de esta promoción — el complemento de
// getPromotionRedeemers, paginado y con búsqueda por nombre/correo para no
// tener que traer a los mil clientes de un jalón.
function getPromotionNonRedeemers(promotionId: number, { limit = 20, page = 1, q }: PaginationParams = {}): PaginatedResult<NonRedeemerRow> {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: nonRedeemersBaseStmt.all(promotionId, p.limit, p.offset) as unknown as NonRedeemerRow[],
      total: (nonRedeemersBaseCountStmt.get(promotionId) as unknown as { total: number }).total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  return {
    items: nonRedeemersSearchStmt.all(promotionId, search, search, p.limit, p.offset) as unknown as NonRedeemerRow[],
    total: (nonRedeemersSearchCountStmt.get(promotionId, search, search) as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

const activePromotionsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM promotions WHERE active = 1');
const distinctPromoRedeemersStmt = db.prepare('SELECT COUNT(DISTINCT user_id) AS total FROM promotion_redemptions');
const signupSourceCountsStmt = db.prepare('SELECT signup_source, COUNT(*) AS total FROM users GROUP BY signup_source');

export interface SignupSourceCounts {
  web: number;
  local: number;
}

// Cuántos clientes se registraron desde el QR físico del local vs. desde la
// web normal — para medir si vale la pena el cartel/QR en el mostrador.
function adminSignupSourceCounts(): SignupSourceCounts {
  const rows = signupSourceCountsStmt.all() as unknown as { signup_source: string; total: number }[];
  const counts: SignupSourceCounts = { web: 0, local: 0 };
  for (const row of rows) {
    if (row.signup_source === 'local') counts.local += row.total;
    else counts.web += row.total;
  }
  return counts;
}

export interface PromotionsSummary {
  totalActivePromotions: number;
  totalUsers: number;
  totalRedeemers: number;
  totalNeverRedeemed: number;
  redemptionRatePct: number;
}

// Resumen general para el tope del dashboard de promociones: cuántas
// promociones activas hay, a cuántos clientes se les podría llegar, y de
// esos cuántos ya canjearon alguna promoción alguna vez.
function adminPromotionsSummary(): PromotionsSummary {
  const totalActivePromotions = (activePromotionsCountStmt.get() as unknown as { total: number }).total;
  const totalUsers = (adminUsersCountStmt.get() as unknown as { total: number }).total;
  const totalRedeemers = (distinctPromoRedeemersStmt.get() as unknown as { total: number }).total;
  return {
    totalActivePromotions,
    totalUsers,
    totalRedeemers,
    totalNeverRedeemed: Math.max(totalUsers - totalRedeemers, 0),
    redemptionRatePct: totalUsers > 0 ? Math.round((totalRedeemers / totalUsers) * 1000) / 10 : 0,
  };
}

export interface AdminPromotionRow extends PromotionHydrated {
  redeemedCount: number;
}

function adminListPromotions({ limit = 20, page = 1 }: PaginationParams = {}): PaginatedResult<AdminPromotionRow> {
  const p = paginate({ limit, page });
  const promotions = adminListPromotionsStmt.all(p.limit, p.offset) as unknown as Promotion[];
  const ids = promotions.map((promo) => promo.id);
  const productsMap = productsByPromotionId(ids);
  const codesMap = codesByPromotionId(ids);
  const redeemedMap = redeemedCountByPromotionId(ids);
  return {
    items: promotions.map((promo) => ({
      ...promo,
      products: productsMap.get(promo.id) || [],
      codes: codesMap.get(promo.id) || [],
      redeemedCount: redeemedMap.get(promo.id) || 0,
    })),
    total: (adminPromotionsCountStmt.get() as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

function deactivatePromotion(id: number): void {
  deactivatePromotionStmt.run(id);
}

function markPromotionPushed(id: number, count: number): void {
  markPromotionPushedStmt.run(count, id);
}

// Promociones activas, con fecha de inicio ya cumplida (o sin fecha = ya
// mismo) que todavía no se activaron — para el scheduler.
function listPromotionsReadyToActivate(): PromotionHydrated[] {
  return (listPromotionsReadyToActivateStmt.all() as unknown as Promotion[]).map(hydratePromotion);
}

function markPromotionActivated(id: number): void {
  markPromotionActivatedStmt.run(id);
}

const updatePromotionStmt = db.prepare(
  'UPDATE promotions SET title = ?, body = ?, photo_url = ?, starts_at = ?, ends_at = ? WHERE id = ?'
);
const deletePromotionProductsStmt = db.prepare('DELETE FROM promotion_products WHERE promotion_id = ?');
const countPromotionRedemptionsStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM promotion_redemptions r
   JOIN promotion_codes c ON c.id = r.promotion_code_id
   WHERE c.promotion_id = ?`
);
const deletePromotionCodesStmt = db.prepare('DELETE FROM promotion_codes WHERE promotion_id = ?');
const deletePromotionStmt = db.prepare('DELETE FROM promotions WHERE id = ?');

function updatePromotion(
  id: number,
  {
    title,
    body,
    photoUrl,
    startsAt,
    endsAt,
    productIds,
  }: {
    title?: string | null;
    body?: string | null;
    photoUrl?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    productIds?: number[];
  }
): PromotionHydrated {
  const existing = getPromotionByIdStmt.get(id) as unknown as Promotion | undefined;
  if (!existing) throw new Error('PROMOTION_NOT_FOUND');
  updatePromotionStmt.run(
    title != null && title !== '' ? title : existing.title,
    body != null && body !== '' ? body : existing.body,
    photoUrl !== undefined ? (photoUrl || null) : existing.photo_url,
    startsAt !== undefined ? (startsAt || null) : existing.starts_at,
    endsAt !== undefined ? (endsAt || null) : existing.ends_at,
    id
  );
  if (productIds !== undefined) {
    deletePromotionProductsStmt.run(id);
    for (const productId of productIds) insertPromotionProductStmt.run(id, productId);
  }
  return hydratePromotion(getPromotionByIdStmt.get(id) as unknown as Promotion);
}

// Borrado real solo si nadie canjeó ningún código de esta promoción (si no,
// se pierde el historial de canjes); si ya se usó, hay que desactivarla.
function deletePromotion(id: number): void {
  if ((countPromotionRedemptionsStmt.get(id) as unknown as { total: number }).total > 0) throw new Error('PROMOTION_HAS_REDEMPTIONS');
  deletePromotionProductsStmt.run(id);
  deletePromotionCodesStmt.run(id);
  const info = deletePromotionStmt.run(id);
  if (info.changes === 0) throw new Error('PROMOTION_NOT_FOUND');
}

// ───────────────────────── notificaciones push ─────────────────────────

const upsertPushSubscriptionStmt = db.prepare(
  `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
   ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
);
const deletePushSubscriptionStmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
const listAllPushSubscriptionsStmt = db.prepare('SELECT * FROM push_subscriptions');
const listPushSubscriptionsByUserStmt = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
const countPushSubscriptionsStmt = db.prepare('SELECT COUNT(*) AS total FROM push_subscriptions');

function addPushSubscription(userId: number, { endpoint, p256dh, auth }: { endpoint: string; p256dh: string; auth: string }): void {
  upsertPushSubscriptionStmt.run(userId, endpoint, p256dh, auth);
}

function removePushSubscription(endpoint: string): void {
  deletePushSubscriptionStmt.run(endpoint);
}

function listAllPushSubscriptions(): PushSubscriptionDbRow[] {
  return listAllPushSubscriptionsStmt.all() as unknown as PushSubscriptionDbRow[];
}

function listPushSubscriptionsByUser(userId: number): PushSubscriptionDbRow[] {
  return listPushSubscriptionsByUserStmt.all(userId) as unknown as PushSubscriptionDbRow[];
}

function countPushSubscriptions(): number {
  return (countPushSubscriptionsStmt.get() as unknown as { total: number }).total;
}

// ───────────────────────── panel administrador ─────────────────────────

export interface AdminUserRow {
  id: number;
  name: string;
  email: string;
  avatar_url: string | null;
  totp_enabled: number;
  created_at: string;
  dni: string | null;
  telefono: string | null;
  referred_by: number | null;
  family_group_id: number | null;
  puntos: number;
  total_gastado: number;
  num_compras: number;
  signup_source: string;
}

const adminUsersStmt = db.prepare(
  `SELECT u.id, u.name, u.email, u.avatar_url, u.totp_enabled, u.created_at,
          u.dni, u.telefono, u.signup_source,
          u.referred_by, u.family_group_id,
          COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos,
          COALESCE((SELECT SUM(monto) FROM purchases p WHERE p.user_id = u.id), 0) AS total_gastado,
          COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras
   FROM users u
   ORDER BY u.created_at DESC
   LIMIT ? OFFSET ?`
);
const adminUsersCountStmt = db.prepare('SELECT COUNT(*) AS total FROM users');
const adminUsersSearchStmt = db.prepare(`
  SELECT u.id, u.name, u.email, u.avatar_url, u.totp_enabled, u.created_at,
         u.dni, u.telefono, u.signup_source,
         u.referred_by, u.family_group_id,
         COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos,
         COALESCE((SELECT SUM(monto) FROM purchases p WHERE p.user_id = u.id), 0) AS total_gastado,
         COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras
  FROM users u
  WHERE u.name LIKE ? OR u.email LIKE ?
  ORDER BY u.created_at DESC
  LIMIT ? OFFSET ?
`);
const adminUsersSearchCountStmt = db.prepare('SELECT COUNT(*) AS total FROM users WHERE name LIKE ? OR email LIKE ?');

function adminListUsers({ limit = 20, page = 1, q }: PaginationParams = {}): PaginatedResult<AdminUserRow> {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: adminUsersStmt.all(p.limit, p.offset) as unknown as AdminUserRow[],
      total: (adminUsersCountStmt.get() as unknown as { total: number }).total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  return {
    items: adminUsersSearchStmt.all(search, search, p.limit, p.offset) as unknown as AdminUserRow[],
    total: (adminUsersSearchCountStmt.get(search, search) as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

export interface AdminReferralRow {
  id: number;
  name: string;
  email: string;
  fecha_registro: string;
  referrer_id: number;
  referrer_name: string;
  referrer_email: string;
  num_compras: number;
  puntos: number;
}

const adminReferralsStmt = db.prepare(
  `SELECT u.id, u.name, u.email, u.created_at AS fecha_registro,
          r.id AS referrer_id, r.name AS referrer_name, r.email AS referrer_email,
          COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras,
          COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos
   FROM users u
   JOIN users r ON r.id = u.referred_by
   ORDER BY u.created_at DESC
   LIMIT ? OFFSET ?`
);
const adminReferralsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM users WHERE referred_by IS NOT NULL');
const adminReferralsSearchStmt = db.prepare(`
  SELECT u.id, u.name, u.email, u.created_at AS fecha_registro,
         r.id AS referrer_id, r.name AS referrer_name, r.email AS referrer_email,
         COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras,
         COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos
  FROM users u
  JOIN users r ON r.id = u.referred_by
  WHERE u.name LIKE ? OR u.email LIKE ? OR r.name LIKE ? OR r.email LIKE ?
  ORDER BY u.created_at DESC
  LIMIT ? OFFSET ?
`);
const adminReferralsSearchCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM users u JOIN users r ON r.id = u.referred_by
   WHERE u.name LIKE ? OR u.email LIKE ? OR r.name LIKE ? OR r.email LIKE ?`
);

function adminListReferrals({ limit = 20, page = 1, q }: PaginationParams = {}): PaginatedResult<AdminReferralRow> {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: adminReferralsStmt.all(p.limit, p.offset) as unknown as AdminReferralRow[],
      total: (adminReferralsCountStmt.get() as unknown as { total: number }).total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  return {
    items: adminReferralsSearchStmt.all(search, search, search, search, p.limit, p.offset) as unknown as AdminReferralRow[],
    total: (adminReferralsSearchCountStmt.get(search, search, search, search) as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

export interface AdminFamilyGroupRow {
  id: number;
  name: string;
  invite_code: string;
  created_at: string;
  owner_name: string;
  owner_email: string;
  num_miembros: number;
  members: FamilyMember[];
}

const adminFamilyGroupsStmt = db.prepare(
  `SELECT g.id, g.name, g.invite_code, g.created_at, o.name AS owner_name, o.email AS owner_email,
          (SELECT COUNT(*) FROM users u WHERE u.family_group_id = g.id) AS num_miembros
   FROM family_groups g
   JOIN users o ON o.id = g.owner_user_id
   ORDER BY g.created_at DESC
   LIMIT ? OFFSET ?`
);
const adminFamilyGroupsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM family_groups');

// Trae los miembros de TODOS los grupos de la página en una sola consulta
// (en vez de una consulta por grupo) — evita el N+1 al listar grupos.
function membersByGroupId(groupIds: number[]): Map<number, FamilyMember[]> {
  const membersByGroup = new Map<number, FamilyMember[]>();
  if (groupIds.length === 0) return membersByGroup;
  const placeholders = groupIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, name, email, avatar_url, family_group_id FROM users WHERE family_group_id IN (${placeholders})`
  ).all(...groupIds) as unknown as (FamilyMember & { family_group_id: number })[];
  for (const row of rows) {
    if (!membersByGroup.has(row.family_group_id)) membersByGroup.set(row.family_group_id, []);
    membersByGroup.get(row.family_group_id)!.push(row);
  }
  return membersByGroup;
}

function adminListFamilyGroups({ limit = 20, page = 1 }: PaginationParams = {}): PaginatedResult<AdminFamilyGroupRow> {
  const p = paginate({ limit, page });
  const groups = adminFamilyGroupsStmt.all(p.limit, p.offset) as unknown as Omit<AdminFamilyGroupRow, 'members'>[];
  const membersByGroup = membersByGroupId(groups.map((g) => g.id));
  const items = groups.map((g) => ({ ...g, members: membersByGroup.get(g.id) || [] }));
  return {
    items,
    total: (adminFamilyGroupsCountStmt.get() as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

export interface AdminPurchaseRow {
  id: number;
  monto: number;
  producto: string | null;
  puntos: number;
  created_at: string;
  user_name: string;
  user_email: string;
}

const adminPurchasesStmt = db.prepare(
  `SELECT p.id, p.monto, p.producto, p.puntos, p.created_at, u.name AS user_name, u.email AS user_email
   FROM purchases p
   JOIN users u ON u.id = p.user_id
   ORDER BY p.id DESC
   LIMIT ? OFFSET ?`
);
const adminPurchasesCountStmt = db.prepare('SELECT COUNT(*) AS total FROM purchases');
const adminPurchasesSearchStmt = db.prepare(`
  SELECT p.id, p.monto, p.producto, p.puntos, p.created_at, u.name AS user_name, u.email AS user_email
  FROM purchases p
  JOIN users u ON u.id = p.user_id
  WHERE u.name LIKE ? OR u.email LIKE ? OR p.producto LIKE ?
  ORDER BY p.id DESC
  LIMIT ? OFFSET ?
`);
const adminPurchasesSearchCountStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM purchases p JOIN users u ON u.id = p.user_id
   WHERE u.name LIKE ? OR u.email LIKE ? OR p.producto LIKE ?`
);

function adminListPurchases({ limit = 20, page = 1, q }: PaginationParams = {}): PaginatedResult<AdminPurchaseRow> {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: adminPurchasesStmt.all(p.limit, p.offset) as unknown as AdminPurchaseRow[],
      total: (adminPurchasesCountStmt.get() as unknown as { total: number }).total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  return {
    items: adminPurchasesSearchStmt.all(search, search, search, p.limit, p.offset) as unknown as AdminPurchaseRow[],
    total: (adminPurchasesSearchCountStmt.get(search, search, search) as unknown as { total: number }).total,
    page: p.page,
    limit: p.limit,
  };
}

// ───────────────────────── reportes: clientes ─────────────────────────

interface TopCustomerRawRow {
  id: number;
  name: string;
  email: string;
  num_compras: number;
  total_gastado: number;
  primera_compra: string;
  ultima_compra: string;
}

export interface TopCustomerRow extends TopCustomerRawRow {
  comprasPorSemana: number | null;
}

const topCustomersBaseStmt = db.prepare(`
  SELECT u.id, u.name, u.email,
         COUNT(p.id) AS num_compras,
         COALESCE(SUM(p.monto), 0) AS total_gastado,
         MIN(p.created_at) AS primera_compra,
         MAX(p.created_at) AS ultima_compra
  FROM users u
  JOIN purchases p ON p.user_id = u.id
  GROUP BY u.id
`);
const topCustomersSearchStmt = db.prepare(`
  SELECT u.id, u.name, u.email,
         COUNT(p.id) AS num_compras,
         COALESCE(SUM(p.monto), 0) AS total_gastado,
         MIN(p.created_at) AS primera_compra,
         MAX(p.created_at) AS ultima_compra
  FROM users u
  JOIN purchases p ON p.user_id = u.id
  WHERE u.name LIKE ? OR u.email LIKE ?
  GROUP BY u.id
`);

// Compras por semana entre la primera y la última compra — null si solo
// tiene una compra (no hay ventana de tiempo real para medir frecuencia).
function withPurchaseFrequency(row: TopCustomerRawRow): TopCustomerRow {
  if (row.num_compras < 2) return { ...row, comprasPorSemana: null };
  const days = (sqliteUtcToDate(row.ultima_compra).getTime() - sqliteUtcToDate(row.primera_compra).getTime()) / 86400_000;
  const weeks = Math.max(days / 7, 1);
  return { ...row, comprasPorSemana: Math.round((row.num_compras / weeks) * 100) / 100 };
}

// Filtro personalizable: buscar por nombre/email (q), mínimo de compras
// para aparecer en la lista, y ordenar por compras / gasto total / frecuencia.
function adminTopCustomersByPurchases({
  limit = 20,
  page = 1,
  q,
  minCompras = 1,
  sortBy = 'num_compras',
}: PaginationParams & { minCompras?: number | string; sortBy?: string } = {}): PaginatedResult<TopCustomerRow> {
  const p = paginate({ limit, page });
  const rows = (q
    ? topCustomersSearchStmt.all(`%${q}%`, `%${q}%`)
    : topCustomersBaseStmt.all()) as unknown as TopCustomerRawRow[];

  const min = Math.max(Number(minCompras) || 1, 1);
  const items = rows.filter((r) => r.num_compras >= min).map(withPurchaseFrequency);

  const sortKey = (['num_compras', 'total_gastado', 'comprasPorSemana'].includes(sortBy) ? sortBy : 'num_compras') as unknown as keyof TopCustomerRow;
  items.sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));

  return { items: items.slice(p.offset, p.offset + p.limit), total: items.length, page: p.page, limit: p.limit };
}

export interface RecurringPromoCustomerRow {
  id: number;
  name: string;
  email: string;
  promos_canjeadas: number;
  total_canjes: number;
}

const recurringPromoCustomersStmt = db.prepare(`
  SELECT u.id, u.name, u.email,
         COUNT(DISTINCT pc.promotion_id) AS promos_canjeadas,
         COUNT(*) AS total_canjes
  FROM promotion_redemptions pr
  JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
  JOIN users u ON u.id = pr.user_id
  GROUP BY u.id
`);
const recurringPromoCustomersSearchStmt = db.prepare(`
  SELECT u.id, u.name, u.email,
         COUNT(DISTINCT pc.promotion_id) AS promos_canjeadas,
         COUNT(*) AS total_canjes
  FROM promotion_redemptions pr
  JOIN promotion_codes pc ON pc.id = pr.promotion_code_id
  JOIN users u ON u.id = pr.user_id
  WHERE u.name LIKE ? OR u.email LIKE ?
  GROUP BY u.id
`);

// Clientes recurrentes: los que canjearon más promociones DISTINTAS, no
// solo más veces la misma.
function adminRecurringPromoCustomers({ limit = 20, page = 1, q }: PaginationParams = {}): PaginatedResult<RecurringPromoCustomerRow> {
  const p = paginate({ limit, page });
  const rows = (q
    ? recurringPromoCustomersSearchStmt.all(`%${q}%`, `%${q}%`)
    : recurringPromoCustomersStmt.all()) as unknown as RecurringPromoCustomerRow[];
  const sorted = [...rows].sort(
    (a, b) => b.promos_canjeadas - a.promos_canjeadas || b.total_canjes - a.total_canjes
  );
  return { items: sorted.slice(p.offset, p.offset + p.limit), total: sorted.length, page: p.page, limit: p.limit };
}

const trafficByHourStmt = db.prepare(
  `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hora, COUNT(*) AS total, COALESCE(SUM(monto),0) AS monto
   FROM purchases GROUP BY hora ORDER BY hora`
);
const trafficByWeekdayStmt = db.prepare(
  `SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dia, COUNT(*) AS total, COALESCE(SUM(monto),0) AS monto
   FROM purchases GROUP BY dia ORDER BY dia`
);

const WEEKDAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function adminAllUsers(): AdminUserRow[] {
  return adminUsersStmt.all(-1, 0) as unknown as AdminUserRow[];
}

function adminAllPurchases(): AdminPurchaseRow[] {
  return adminPurchasesStmt.all(-1, 0) as unknown as AdminPurchaseRow[];
}

function adminAllReferrals(): AdminReferralRow[] {
  return adminReferralsStmt.all(-1, 0) as unknown as AdminReferralRow[];
}

export interface TrafficStats {
  byHour: { hora: number; total: number; monto: number }[];
  byWeekday: { dia: number; nombre: string; total: number; monto: number }[];
}

function adminTrafficStats(): TrafficStats {
  const byHourRaw = trafficByHourStmt.all() as unknown as { hora: number; total: number; monto: number }[];
  const byHour = Array.from({ length: 24 }, (_, hora) => {
    const row = byHourRaw.find((r) => r.hora === hora);
    return { hora, total: row ? row.total : 0, monto: row ? row.monto : 0 };
  });

  const byWeekdayRaw = trafficByWeekdayStmt.all() as unknown as { dia: number; total: number; monto: number }[];
  const byWeekday = WEEKDAY_NAMES.map((nombre, dia) => {
    const row = byWeekdayRaw.find((r) => r.dia === dia);
    return { dia, nombre, total: row ? row.total : 0, monto: row ? row.monto : 0 };
  });

  return { byHour, byWeekday };
}

module.exports = {
  // suscripciones pre-apertura
  addSubscriber,
  dniExists,
  getCount,
  listSubscribers,
  // usuarios / wallet
  upsertGoogleUser,
  getUserById,
  getUserByEmail,
  getUserByReferralCode,
  setReferredBy,
  setUserContactInfo,
  setTotpSecret,
  enableTotp,
  markWalletSaved,
  listWalletSavedUserIds,
  // sesiones
  createSession,
  getSession,
  setSessionStage,
  deleteSession,
  deleteAllSessionsForUser,
  isTotpLocked,
  registerTotpFailure,
  resetTotpAttempts,
  TOTP_MAX_ATTEMPTS,
  TOTP_LOCKOUT_MINUTES,
  // puntos / compras
  addPurchase,
  getPointsBalance,
  listPurchasesByUser,
  redeemPoints,
  getRewardProgress,
  SOLES_PER_PUNTO,
  REWARD_THRESHOLD,
  REFERRAL_BONUS_POINTS,
  REFERRAL_WELCOME_POINTS,
  // niveles de fidelidad
  getLifetimePoints,
  getTierForUser,
  TIER_SILVER_THRESHOLD,
  TIER_GOLD_THRESHOLD,
  // ruleta de premios
  spinWheel,
  getSpinStatus,
  SPIN_COOLDOWN_HOURS,
  // familia
  createFamilyGroup,
  joinFamilyGroup,
  getFamilyGroupForUser,
  leaveFamilyGroup,
  removeFamilyMember,
  // productos
  createProduct,
  getProductById,
  listActiveProducts,
  listActiveCombos,
  adminListProducts,
  deactivateProduct,
  updateProduct,
  deleteProduct,
  // campos de perfil dinámicos
  createProfileField,
  getProfileFieldByKey,
  listActiveProfileFields,
  adminListProfileFields,
  updateProfileField,
  deleteProfileField,
  getUserProfileValues,
  getMissingRequiredFields,
  setUserProfileValues,
  // promociones
  createPromotion,
  findActivePromotionByTitle,
  getPromotionRedeemers,
  getPromotionNonRedeemers,
  adminPromotionsSummary,
  addPromotionCode,
  redeemPromotionCode,
  listActivePromotions,
  adminListPromotions,
  deactivatePromotion,
  markPromotionPushed,
  listPromotionsReadyToActivate,
  markPromotionActivated,
  updatePromotion,
  deletePromotion,
  // push
  addPushSubscription,
  removePushSubscription,
  listAllPushSubscriptions,
  listPushSubscriptionsByUser,
  countPushSubscriptions,
  // admin
  adminListUsers,
  adminListReferrals,
  adminListFamilyGroups,
  adminListPurchases,
  adminTopCustomersByPurchases,
  adminRecurringPromoCustomers,
  adminTrafficStats,
  adminSignupSourceCounts,
  adminAllUsers,
  adminAllPurchases,
  adminAllReferrals,
};
