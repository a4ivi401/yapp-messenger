import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { searchMessages } from '../conversations.js';

// Express 4 не передає помилки з async-обробників у error-middleware (а глобального тут і немає),
// тож обгортаємо кожен хендлер, щоб кинута помилка не стала unhandled rejection.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутрішня помилка' });
  });

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const messagesRouter = Router();

messagesRouter.use(requireAuth);

// GET /api/messages/search?q=... — пошук по тілах повідомлень у всіх діалогах користувача.
// Тільки діалоги, де я учасник (перевірка в умові WHERE доменної функції).
messagesRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const results = await searchMessages(req.user.user_id, parsed.data.q, parsed.data);
    res.json({ messages: results });
  }),
);
