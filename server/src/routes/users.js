import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { searchUsers } from '../contacts.js';

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутрішня помилка' });
  });

const searchQuerySchema = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const usersRouter = Router();

usersRouter.use(requireAuth);

// GET /api/users/search?q=... — глобальний пошук користувачів за нікнеймом
usersRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const queryStr = parsed.data.q.trim().replace(/^@+/, '');
    if (!queryStr) {
      return res.json({ users: [] });
    }

    const users = await searchUsers(req.user.user_id, queryStr, {
      limit: parsed.data.limit,
    });
    res.json({ users });
  }),
);
