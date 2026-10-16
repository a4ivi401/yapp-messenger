import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  listMatchesForUser,
  countMatchesForUser,
  getMatchStatsForUser,
} from '../matches.js';

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутрішня помилка' });
  });

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const matchesRouter = Router();

matchesRouter.use(requireAuth);

// GET /api/matches — історія взаємних метчів (найновіші перші)
matchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const me = req.user.user_id;
    const [matches, count] = await Promise.all([
      listMatchesForUser(me, { limit: parsed.data.limit ?? 50 }),
      countMatchesForUser(me),
    ]);

    res.json({ matches, count });
  }),
);

// GET /api/matches/stats — агрегати для профілю (метчі + контакти)
matchesRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const stats = await getMatchStatsForUser(req.user.user_id);
    res.json(stats);
  }),
);
