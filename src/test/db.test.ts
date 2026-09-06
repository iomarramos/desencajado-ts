// Cada archivo de test corre en su propio proceso con `node --test`, así
// que fijar DB_FILE aquí antes de requerir '../db' no interfiere con otros
// archivos de test ni con la base de datos de desarrollo.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `desencajado-test-db-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_FILE = TMP_DB;
process.env.SOLES_PER_PUNTO = '5';
process.env.REWARD_THRESHOLD = '50';
process.env.REFERRAL_BONUS_POINTS = '20';
process.env.REFERRAL_WELCOME_POINTS = '10';
process.env.TOTP_MAX_ATTEMPTS = '5';
process.env.TOTP_LOCKOUT_MINUTES = '5';
process.env.TIER_SILVER_THRESHOLD = '100';
process.env.TIER_GOLD_THRESHOLD = '300';
process.env.SPIN_COOLDOWN_HOURS = '24';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
const db = require('../db');

after(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(TMP_DB + suffix, { force: true });
  }
});

let userSeq = 0;
function makeUser(name: string) {
  userSeq += 1;
  return db.upsertGoogleUser({
    googleId: `g${userSeq}`,
    email: `user${userSeq}@example.com`,
    name,
    avatarUrl: null,
  });
}

// ───────────────────────── referidos ─────────────────────────

test('referidos: paga bono al referidor y al referido, una sola vez', () => {
  const ana = makeUser('Ana');
  const luis = makeUser('Luis');

  assert.equal(db.getPointsBalance(ana.id), 0);
  assert.equal(db.setReferredBy(luis.id, ana.id), true);
  assert.equal(db.getPointsBalance(ana.id), 20);
  assert.equal(db.getPointsBalance(luis.id), 10);

  // segundo intento no debe volver a pagar
  assert.equal(db.setReferredBy(luis.id, ana.id), false);
  assert.equal(db.getPointsBalance(ana.id), 20);
});

test('referidos: no se puede uno referir a sí mismo', () => {
  const carla = makeUser('Carla');
  assert.equal(db.setReferredBy(carla.id, carla.id), false);
});

// ───────────────────────── grupo familiar ─────────────────────────

test('familia: crear, unirse, expulsar y salir', () => {
  const owner = makeUser('Dueña');
  const member = makeUser('Miembro');
  const other = makeUser('Otro');

  const group = db.createFamilyGroup(owner.id, 'Familia Test');
  db.joinFamilyGroup(member.id, group.invite_code);

  const withMembers = db.getFamilyGroupForUser(owner.id);
  assert.equal(withMembers.members.length, 2);

  assert.throws(() => db.removeFamilyMember(member.id, owner.id), /NOT_OWNER/);
  db.removeFamilyMember(owner.id, member.id);
  assert.equal(db.getUserById(member.id).family_group_id, null);

  db.joinFamilyGroup(member.id, group.invite_code);
  const leaveNonOwner = db.leaveFamilyGroup(member.id);
  assert.equal(leaveNonOwner.disbanded, false);
  assert.equal(db.getUserById(member.id).family_group_id, null);
  assert.notEqual(db.getUserById(owner.id).family_group_id, null);

  const leaveOwner = db.leaveFamilyGroup(owner.id);
  assert.equal(leaveOwner.disbanded, true);
  assert.equal(db.getUserById(owner.id).family_group_id, null);

  assert.throws(() => db.leaveFamilyGroup(other.id), /NOT_IN_GROUP/);
});

// ───────────────────────── productos ─────────────────────────

test('productos: crear, editar, y bloquear borrado si está en uso', () => {
  const product = db.createProduct({ name: 'Frappé', photoUrl: null, price: 15 });
  const updated = db.updateProduct(product.id, { name: 'Frappé de Lúcuma', price: 18.5 });
  assert.equal(updated.name, 'Frappé de Lúcuma');
  assert.equal(updated.price, 18.5);

  const promo = db.createPromotion({ title: 'Promo', body: 'x', productIds: [product.id] });
  assert.throws(() => db.deleteProduct(product.id), /PRODUCT_IN_USE/);

  db.deletePromotion(promo.id);
  db.deleteProduct(product.id);
  assert.equal(db.getProductById(product.id), undefined);
});

test('combos solo-miembros: solo aparecen los productos con precio de socio', () => {
  const before = db.listActiveCombos().length;

  const normal = db.createProduct({ name: 'Café normal', photoUrl: null, price: 5 });
  const combo = db.createProduct({ name: 'Combo Socio', photoUrl: null, price: 20, memberPrice: 15 });

  const combos = db.listActiveCombos();
  assert.equal(combos.length, before + 1);
  assert.ok(!combos.some((p: any) => p.id === normal.id));
  assert.ok(combos.some((p: any) => p.id === combo.id && p.member_price === 15));

  const updated = db.updateProduct(combo.id, { memberPrice: null });
  assert.equal(updated.member_price, null);
  assert.equal(db.listActiveCombos().length, before);
});

// ───────────────────────── promociones y canje ─────────────────────────

test('promociones: código de publicación autogenerado y edición', () => {
  const promo = db.createPromotion({ title: 'Original', body: 'Texto' });
  assert.match(promo.publication_code, /^PROMO-\d{4}$/);

  const edited = db.updatePromotion(promo.id, { title: 'Editado' });
  assert.equal(edited.title, 'Editado');
  assert.equal(edited.body, 'Texto');
});

test('canje: valida código inexistente, vigencia y límite de usos', () => {
  const user = makeUser('Redimidor');
  const promo = db.createPromotion({ title: 'Con canje', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'LIMITADO', label: 'Centro', maxUses: 2 });

  assert.throws(() => db.redeemPromotionCode('NOEXISTE', user.id), /CODE_NOT_FOUND/);

  const r1 = db.redeemPromotionCode('limitado', user.id);
  assert.equal(r1.code.usesRemaining, 1);
  assert.equal(r1.promotion.codes, undefined); // no debe filtrar la lista de códigos

  db.redeemPromotionCode('LIMITADO', user.id);
  assert.throws(() => db.redeemPromotionCode('LIMITADO', user.id), /CODE_EXHAUSTED/);
});

test('canje: rechaza promoción fuera de vigencia', () => {
  const user = makeUser('Fuera de fecha');
  const expired = db.createPromotion({
    title: 'Vencida',
    body: 'x',
    startsAt: '2000-01-01 00:00:00',
    endsAt: '2000-01-02 00:00:00',
  });
  db.addPromotionCode(expired.id, { code: 'VENCIDO', label: null, maxUses: null });
  assert.throws(() => db.redeemPromotionCode('VENCIDO', user.id), /PROMOTION_EXPIRED/);
});

test('promociones: no se puede borrar una promoción con canjes', () => {
  const user = makeUser('Con canje previo');
  const promo = db.createPromotion({ title: 'Con historial', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'HIST', label: null, maxUses: null });
  db.redeemPromotionCode('HIST', user.id);
  assert.throws(() => db.deletePromotion(promo.id), /PROMOTION_HAS_REDEMPTIONS/);
});

// ───────────────────────── programación de promociones ─────────────────────────

test('promociones: sin fecha o con fecha pasada están listas para activar de inmediato', () => {
  const inmediata = db.createPromotion({ title: 'Sched inmediata', body: 'x' });
  const ayer = db.createPromotion({
    title: 'Sched ayer',
    body: 'x',
    startsAt: new Date(Date.now() - 86400000).toISOString().slice(0, 16),
  });

  const listas = db.listPromotionsReadyToActivate().map((p: { id: number }) => p.id);
  assert.ok(listas.includes(inmediata.id));
  assert.ok(listas.includes(ayer.id));
});

test('promociones: una fecha futura NO está lista para activar hasta que llegue el día', () => {
  const manana = db.createPromotion({
    title: 'Sched mañana',
    body: 'x',
    startsAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
  });

  const listas = db.listPromotionsReadyToActivate().map((p: { id: number }) => p.id);
  assert.ok(!listas.includes(manana.id));
});

test('promociones: markPromotionActivated saca a la promoción de la lista de pendientes', () => {
  const promo = db.createPromotion({ title: 'Sched a activar', body: 'x' });
  assert.ok(db.listPromotionsReadyToActivate().some((p: { id: number }) => p.id === promo.id));

  db.markPromotionActivated(promo.id);
  assert.ok(!db.listPromotionsReadyToActivate().some((p: { id: number }) => p.id === promo.id));
});

// ───────────────────────── puntos / recompensas ─────────────────────────

test('compras: calcula estrellas según SOLES_PER_PUNTO y actualiza el balance', () => {
  const user = makeUser('Comprador');
  const result = db.addPurchase({ userId: user.id, monto: 27, producto: 'Café' });
  assert.equal(result.puntos, 5); // floor(27 / 5)
  assert.equal(result.balance, 5);
});

test('canje de puntos: rechaza monto inválido o saldo insuficiente', () => {
  const user = makeUser('Canjeador');
  db.addPurchase({ userId: user.id, monto: 50, producto: 'x' }); // +10 puntos
  assert.throws(() => db.redeemPoints(user.id, 0, 'x'), /INVALID_AMOUNT/);
  assert.throws(() => db.redeemPoints(user.id, 100, 'x'), /INSUFFICIENT_BALANCE/);
  const balance = db.redeemPoints(user.id, 4, 'Frappé');
  assert.equal(balance, 6);
});

test('progreso de recompensa: calcula ciclo y recompensas disponibles', () => {
  const user = makeUser('Progreso');
  db.addPurchase({ userId: user.id, monto: 255, producto: 'x' }); // 51 puntos con SOLES_PER_PUNTO=5
  const progress = db.getRewardProgress(user.id);
  assert.equal(progress.balance, 51);
  assert.equal(progress.threshold, 50);
  assert.equal(progress.inCycle, 1);
  assert.equal(progress.remaining, 49);
  assert.equal(progress.rewardsAvailable, 1);
});

// ───────────────────────── 2FA: bloqueo de intentos ─────────────────────────

test('2FA: bloquea tras el máximo de intentos y se resetea', () => {
  const user = makeUser('Con 2FA');
  const token = db.createSession(user.id, 'pending_2fa');

  for (let i = 0; i < 4; i++) {
    db.registerTotpFailure(token);
    assert.equal(db.isTotpLocked(db.getSession(token)), false);
  }
  db.registerTotpFailure(token); // 5to intento: bloquea
  assert.equal(db.isTotpLocked(db.getSession(token)), true);

  db.resetTotpAttempts(token);
  assert.equal(db.isTotpLocked(db.getSession(token)), false);
});

// ───────────────────────── sesiones ─────────────────────────

test('sesiones: deleteAllSessionsForUser revoca todas las sesiones del usuario', () => {
  const user = makeUser('Multi sesión');
  const t1 = db.createSession(user.id, 'active');
  const t2 = db.createSession(user.id, 'active');
  assert.ok(db.getSession(t1));
  assert.ok(db.getSession(t2));

  db.deleteAllSessionsForUser(user.id);
  assert.equal(db.getSession(t1), undefined);
  assert.equal(db.getSession(t2), undefined);
});

// ───────────────────────── Google Wallet ─────────────────────────

test('wallet: markWalletSaved agrega al usuario a listWalletSavedUserIds', () => {
  const before = makeUser('Sin wallet guardada');
  const after1 = makeUser('Con wallet guardada');

  assert.ok(!db.listWalletSavedUserIds().includes(before.id));
  assert.ok(!db.listWalletSavedUserIds().includes(after1.id));

  db.markWalletSaved(after1.id);

  assert.ok(!db.listWalletSavedUserIds().includes(before.id));
  assert.ok(db.listWalletSavedUserIds().includes(after1.id));
});

// ───────────────────────── QR de registro en el local ─────────────────────────

test('signup_source: por defecto es "web", y "local" solo se fija al crear la cuenta', () => {
  userSeq += 1;
  const web = db.upsertGoogleUser({ googleId: `gsrc${userSeq}`, email: `src${userSeq}@example.com`, name: 'Fuente Web', avatarUrl: null });
  assert.equal(web.signup_source, 'web');

  userSeq += 1;
  const local = db.upsertGoogleUser({ googleId: `gsrc${userSeq}`, email: `src${userSeq}@example.com`, name: 'Fuente Local', avatarUrl: null, source: 'local' });
  assert.equal(local.signup_source, 'local');

  // un login posterior no debe cambiar la fuente original
  const relogin = db.upsertGoogleUser({ googleId: local.google_id, email: local.email, name: local.name, avatarUrl: null, source: 'web' });
  assert.equal(relogin.signup_source, 'local');
});

test('adminSignupSourceCounts: cuenta cuántos vinieron del QR del local vs. la web', () => {
  const before = db.adminSignupSourceCounts();

  userSeq += 1;
  db.upsertGoogleUser({ googleId: `gcount${userSeq}`, email: `count${userSeq}@example.com`, name: 'Conteo Local', avatarUrl: null, source: 'local' });

  const after = db.adminSignupSourceCounts();
  assert.equal(after.local, before.local + 1);
  assert.equal(after.web, before.web);
});

// ───────────────────────── niveles de fidelidad ─────────────────────────

test('niveles: sube de bronce a plata a oro según puntos de por vida, y el canje no baja de nivel', () => {
  const user = makeUser('Nivel');
  assert.equal(db.getTierForUser(user.id).tier, 'bronce');

  db.addPurchase({ userId: user.id, monto: 500, producto: 'x' }); // 100 puntos
  assert.equal(db.getTierForUser(user.id).tier, 'plata');
  assert.equal(db.getTierForUser(user.id).pointsToNext, 200);

  db.addPurchase({ userId: user.id, monto: 1000, producto: 'y' }); // +200 puntos = 300
  assert.equal(db.getTierForUser(user.id).tier, 'oro');
  assert.equal(db.getTierForUser(user.id).pointsToNext, 0);

  // canjear puntos baja el saldo pero no el nivel (se basa en lo ganado, no en el saldo)
  db.redeemPoints(user.id, 250, 'canje de prueba');
  assert.equal(db.getTierForUser(user.id).tier, 'oro');
});

// ───────────────────────── ruleta de premios ─────────────────────────

test('ruleta: la primera vez está disponible, otorga un premio válido y aplica cooldown', () => {
  const user = makeUser('Ruleta');
  assert.equal(db.getSpinStatus(user.id).available, true);

  const before = db.getPointsBalance(user.id);
  const result = db.spinWheel(user.id);
  assert.ok(result.prize.points >= 0);
  assert.equal(db.getPointsBalance(user.id), before + result.prize.points);
  assert.equal(db.getSpinStatus(user.id).available, false);
  assert.ok(db.getSpinStatus(user.id).nextSpinAt);

  assert.throws(() => db.spinWheel(user.id), /SPIN_COOLDOWN/);
});

// ───────────────────────── perfil: DNI y teléfono ─────────────────────────

test('perfil: setUserContactInfo vincula dni y teléfono al usuario', () => {
  const user = makeUser('Con perfil');
  assert.equal(db.getUserById(user.id).dni, null);

  db.setUserContactInfo(user.id, '12345678', '987654321');

  const updated = db.getUserById(user.id);
  assert.equal(updated.dni, '12345678');
  assert.equal(updated.telefono, '987654321');
});

test('perfil: un DNI ya vinculado a otro usuario lanza DNI_TAKEN', () => {
  const ana = makeUser('Ana perfil');
  const luis = makeUser('Luis perfil');
  db.setUserContactInfo(ana.id, '11111111', '911111111');

  assert.throws(() => db.setUserContactInfo(luis.id, '11111111', '922222222'), /DNI_TAKEN/);
});

// ───────────────────────── campos de perfil dinámicos ─────────────────────────

test('campos de perfil: un campo obligatorio sin llenar aparece en getMissingRequiredFields', () => {
  const user = makeUser('Campo obligatorio');
  const field = db.createProfileField({ key: 'cumple_test', label: 'Cumpleaños', type: 'date', required: true });

  const missing = db.getMissingRequiredFields(user.id);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].field_key, 'cumple_test');

  db.setUserProfileValues(user.id, { [field.id]: '2000-01-01' });
  assert.equal(db.getMissingRequiredFields(user.id).length, 0);

  const values = db.getUserProfileValues(user.id);
  assert.equal(values.find((v: { id: number }) => v.id === field.id).value, '2000-01-01');
});

test('campos de perfil: un campo opcional nunca bloquea', () => {
  const user = makeUser('Campo opcional');
  db.createProfileField({ key: 'opcional_test', label: 'Opcional', type: 'text', required: false });
  const missing = db.getMissingRequiredFields(user.id);
  assert.ok(!missing.some((f: { field_key: string }) => f.field_key === 'opcional_test'));
});

test('campos de perfil: no se puede borrar un campo con valores, sí desactivar', () => {
  const user = makeUser('Campo en uso');
  const field = db.createProfileField({ key: 'en_uso_test', label: 'En uso', type: 'text', required: false });
  db.setUserProfileValues(user.id, { [field.id]: 'algo' });

  assert.throws(() => db.deleteProfileField(field.id), /PROFILE_FIELD_IN_USE/);

  const updated = db.updateProfileField(field.id, { active: false });
  assert.equal(updated.active, 0);
  assert.ok(!db.listActiveProfileFields().some((f: { id: number }) => f.id === field.id));
});

// ───────────────────────── concurrencia: operaciones atómicas ─────────────────────────

test('concurrencia: redeemPoints nunca deja el saldo negativo bajo intentos repetidos', () => {
  const user = makeUser('Concurrencia puntos');
  db.addPurchase({ userId: user.id, monto: 50, producto: 'x' }); // 10 puntos

  const results = Array.from({ length: 5 }, () => {
    try { db.redeemPoints(user.id, 3, 'test'); return true; } catch { return false; }
  });
  assert.equal(results.filter(Boolean).length, 3); // 3x3=9 <= 10, un 4to ya no alcanza
  assert.equal(db.getPointsBalance(user.id), 1);
  assert.ok(db.getPointsBalance(user.id) >= 0);
});

test('concurrencia: un código con max_uses nunca se canjea más veces de lo permitido', () => {
  const promo = db.createPromotion({ title: 'Concurrencia promo', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'CONC1', label: null, maxUses: 3 });

  const users = Array.from({ length: 10 }, (_, i) => makeUser(`Conc${i}`));
  const results = users.map((u) => {
    try { db.redeemPromotionCode('CONC1', u.id); return true; } catch { return false; }
  });
  assert.equal(results.filter(Boolean).length, 3);
});

test('concurrencia: spinWheel solo permite un giro exitoso bajo intentos repetidos', () => {
  const user = makeUser('Concurrencia ruleta');
  const results = Array.from({ length: 5 }, () => {
    try { db.spinWheel(user.id); return true; } catch { return false; }
  });
  assert.equal(results.filter(Boolean).length, 1);
});

// ───────────────────────── listados admin: batch en vez de N+1 ─────────────────────────

test('adminListFamilyGroups: cada grupo trae solo sus propios miembros', () => {
  const ownerA = makeUser('Owner batch A');
  const ownerB = makeUser('Owner batch B');
  const memberA = makeUser('Member batch A');
  const memberB = makeUser('Member batch B');
  const groupA = db.createFamilyGroup(ownerA.id, 'Grupo Batch A');
  const groupB = db.createFamilyGroup(ownerB.id, 'Grupo Batch B');
  db.joinFamilyGroup(memberA.id, groupA.invite_code);
  db.joinFamilyGroup(memberB.id, groupB.invite_code);

  const items = db.adminListFamilyGroups({ limit: 50 }).items;
  const a = items.find((g: { id: number }) => g.id === groupA.id);
  const b = items.find((g: { id: number }) => g.id === groupB.id);
  assert.deepEqual(a.members.map((m: { name: string }) => m.name).sort(), ['Member batch A', 'Owner batch A'].sort());
  assert.deepEqual(b.members.map((m: { name: string }) => m.name).sort(), ['Member batch B', 'Owner batch B'].sort());
});

test('adminListPromotions: cada promoción trae solo sus propios códigos', () => {
  const promoA = db.createPromotion({ title: 'Batch promo A', body: 'x' });
  const promoB = db.createPromotion({ title: 'Batch promo B', body: 'x' });
  db.addPromotionCode(promoA.id, { code: 'BATCHA', label: null, maxUses: null });
  db.addPromotionCode(promoB.id, { code: 'BATCHB1', label: null, maxUses: null });
  db.addPromotionCode(promoB.id, { code: 'BATCHB2', label: null, maxUses: null });

  const items = db.adminListPromotions({ limit: 50 }).items;
  const a = items.find((p: { id: number }) => p.id === promoA.id);
  const b = items.find((p: { id: number }) => p.id === promoB.id);
  assert.deepEqual(a.codes.map((c: { code: string }) => c.code), ['BATCHA']);
  assert.deepEqual(b.codes.map((c: { code: string }) => c.code).sort(), ['BATCHB1', 'BATCHB2']);
});

// ───────────────────────── duplicidad de promociones ─────────────────────────

test('promociones: findActivePromotionByTitle detecta duplicados sin importar mayúsculas, tildes o espacios', () => {
  db.createPromotion({ title: '2x1 en Frappés', body: 'x' });
  assert.ok(db.findActivePromotionByTitle('2x1 en Frappés'));
  assert.ok(db.findActivePromotionByTitle('  2X1 EN FRAPPÉS  '));
  assert.ok(!db.findActivePromotionByTitle('Una promo totalmente distinta'));
});

test('promociones: una promoción desactivada no cuenta como duplicado', () => {
  const promo = db.createPromotion({ title: 'Promo a desactivar', body: 'x' });
  db.deactivatePromotion(promo.id);
  assert.ok(!db.findActivePromotionByTitle('Promo a desactivar'));
});

// ───────────────────────── reportes: alcance de promociones ─────────────────────────

test('adminPromotionsSummary + getPromotionRedeemers: cuenta canjeadores y no-canjeadores', () => {
  const a = makeUser('Reporte A');
  const b = makeUser('Reporte B');
  const promo = db.createPromotion({ title: 'Reporte promo', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'REPORTE1', label: null, maxUses: null });
  db.redeemPromotionCode('REPORTE1', a.id);

  const redeemers = db.getPromotionRedeemers(promo.id);
  assert.equal(redeemers.length, 1);
  assert.equal(redeemers[0].name, 'Reporte A');

  const summary = db.adminPromotionsSummary();
  assert.ok(summary.totalUsers >= 2);
  assert.ok(summary.totalRedeemers >= 1);
  assert.equal(summary.totalNeverRedeemed, summary.totalUsers - summary.totalRedeemers);
});

test('getPromotionNonRedeemers: excluye a quien canjeó, pagina y busca por nombre/correo', () => {
  const redeemer = makeUser('NoCanjeo Canjeador');
  const pending1 = makeUser('NoCanjeo Pendiente Uno');
  const pending2 = makeUser('NoCanjeo Pendiente Dos');
  const promo = db.createPromotion({ title: 'Promo no canjeada', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'NOCANJE1', label: null, maxUses: null });
  db.redeemPromotionCode('NOCANJE1', redeemer.id);

  const all = db.getPromotionNonRedeemers(promo.id, { limit: 50 });
  const ids = all.items.map((u: { user_id: number }) => u.user_id);
  assert.ok(ids.includes(pending1.id));
  assert.ok(ids.includes(pending2.id));
  assert.ok(!ids.includes(redeemer.id));

  const paged = db.getPromotionNonRedeemers(promo.id, { limit: 1, page: 1 });
  assert.equal(paged.items.length, 1);
  assert.ok(paged.total >= 2);

  const searched = db.getPromotionNonRedeemers(promo.id, { limit: 50, q: 'Pendiente Uno' });
  assert.equal(searched.items.length, 1);
  assert.equal(searched.items[0].user_id, pending1.id);
});

test('adminListPromotions: redeemedCount cuenta clientes distintos, no canjes totales', () => {
  const a = makeUser('Distinct A');
  const b = makeUser('Distinct B');
  const promo = db.createPromotion({ title: 'Distinct promo', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'DISTINCT1', label: null, maxUses: null });
  db.addPromotionCode(promo.id, { code: 'DISTINCT2', label: null, maxUses: null });
  db.redeemPromotionCode('DISTINCT1', a.id);
  db.redeemPromotionCode('DISTINCT2', b.id);

  const item = db.adminListPromotions({ limit: 50 }).items.find((p: { id: number }) => p.id === promo.id);
  assert.equal(item.redeemedCount, 2);
});

// ───────────────────────── reportes: clientes ─────────────────────────

test('adminTopCustomersByPurchases: ordena por compras y respeta el mínimo', () => {
  const frecuente = makeUser('Top frecuente');
  const ocasional = makeUser('Top ocasional');
  for (let i = 0; i < 3; i++) db.addPurchase({ userId: frecuente.id, monto: 10, producto: 'x' });
  db.addPurchase({ userId: ocasional.id, monto: 10, producto: 'x' });

  const all = db.adminTopCustomersByPurchases({ limit: 50, minCompras: 1 });
  const names = all.items.map((c: { name: string }) => c.name);
  assert.ok(names.indexOf('Top frecuente') < names.indexOf('Top ocasional'));

  const filtered = db.adminTopCustomersByPurchases({ limit: 50, minCompras: 2 });
  assert.ok(!filtered.items.some((c: { name: string }) => c.name === 'Top ocasional'));
});

test('adminRecurringPromoCustomers: cuenta promociones DISTINTAS, no canjes totales', () => {
  const user = makeUser('Recurrente test');
  const promoA = db.createPromotion({ title: 'Recurrente A', body: 'x' });
  const promoB = db.createPromotion({ title: 'Recurrente B', body: 'x' });
  db.addPromotionCode(promoA.id, { code: 'RECA', label: null, maxUses: null });
  db.addPromotionCode(promoB.id, { code: 'RECB', label: null, maxUses: null });
  db.redeemPromotionCode('RECA', user.id);
  db.redeemPromotionCode('RECB', user.id);

  const item = db.adminRecurringPromoCustomers({ limit: 50 }).items.find((c: { id: number }) => c.id === user.id);
  assert.equal(item.promos_canjeadas, 2);
  assert.equal(item.total_canjes, 2);
});
