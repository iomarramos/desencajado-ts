// Consultas base (sin LIMIT/OFFSET) para las listas de administrador —
// compartidas entre db.ts (que les agrega LIMIT/OFFSET para las vistas
// paginadas del panel admin) y workers/exportWorker.ts (que las corre
// completas, sin límite, en su propio worker_thread para el export CSV).
// Una sola fuente de verdad para que ambos lados no terminen con el mismo
// SQL escrito dos veces y desincronizado.

export const ADMIN_USERS_QUERY = `
  SELECT u.id, u.name, u.email, u.avatar_url, u.totp_enabled, u.created_at,
         u.dni, u.telefono, u.signup_source,
         u.referred_by, u.family_group_id,
         COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos,
         COALESCE((SELECT SUM(monto) FROM purchases p WHERE p.user_id = u.id), 0) AS total_gastado,
         COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras
  FROM users u
  ORDER BY u.created_at DESC
`;

export const ADMIN_PURCHASES_QUERY = `
  SELECT p.id, p.monto, p.producto, p.puntos, p.created_at, u.name AS user_name, u.email AS user_email
  FROM purchases p
  JOIN users u ON u.id = p.user_id
  ORDER BY p.id DESC
`;

export const ADMIN_REFERRALS_QUERY = `
  SELECT u.id, u.name, u.email, u.created_at AS fecha_registro,
         r.id AS referrer_id, r.name AS referrer_name, r.email AS referrer_email,
         COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras,
         COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos
  FROM users u
  JOIN users r ON r.id = u.referred_by
  ORDER BY u.created_at DESC
`;
