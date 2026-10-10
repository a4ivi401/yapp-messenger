import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { requireAuth, SESSION_COOKIE } from '../middleware/auth.js';

const SESSION_HOURS = 24 * 7;

const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/, 'Імʼя: тільки латиниця, цифри та _'),
  password: z.string().min(6).max(72),
});

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAtMs = Date.now() + SESSION_HOURS * 3600 * 1000;
  await query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, new Date(expiresAtMs)],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 3600 * 1000,
  });
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { username, password } = parsed.data;
  try {
    const { rows } = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, hashPassword(password)],
    );
    await createSession(res, rows[0].id);
    res.status(201).json({ user: { id: rows[0].id, username } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Це імʼя вже зайняте' });
    throw err;
  }
});

authRouter.post('/login', async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { username, password } = parsed.data;
  const { rows } = await query(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [username],
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Невірне імʼя або пароль' });
  }
  await createSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  await query('DELETE FROM sessions WHERE token = $1', [req.cookies[SESSION_COOKIE]]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.user_id, username: req.user.username } });
});