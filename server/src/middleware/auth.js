import { query } from '../db.js';

export const SESSION_COOKIE = 'sid';

async function loadSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await query(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  return rows[0] ?? null;
}

/** Ставить req.user (може бути null) для будь-якого запиту. */
export async function attachUser(req, _res, next) {
  try {
    req.user = await loadSession(req);
  } catch {
    req.user = null;
  }
  next();
}

/** Доступ лише для авторизованих. Використовується після attachUser. */
export async function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Не авторизовано' });
  next();
}