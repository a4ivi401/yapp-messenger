import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db.js';
import {
  listContactsForUser,
  countContactsForUser,
  addContact,
  removeContact,
} from '../contacts.js';

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутрішня помилка' });
  });

const uuid = z.string().uuid();

const addContactSchema = z.object({
  userId: z.string().uuid().optional(),
  username: z.string().trim().min(3).max(20).optional(),
}).refine((data) => data.userId || data.username, {
  message: "Потрібно вказати userId або username",
});

export const contactsRouter = Router();

contactsRouter.use(requireAuth);

// GET /api/contacts — список контактів поточного користувача
contactsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = req.user.user_id;
    const [contacts, count] = await Promise.all([
      listContactsForUser(me),
      countContactsForUser(me),
    ]);
    res.json({ contacts, count });
  }),
);

// POST /api/contacts — додати контакт за userId або username
contactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = addContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const me = req.user.user_id;
    let targetUserId = parsed.data.userId;

    if (!targetUserId && parsed.data.username) {
      const cleanUsername = parsed.data.username.replace(/^@+/, '');
      const { rows } = await query(
        `SELECT id FROM users WHERE username = $1`,
        [cleanUsername],
      );
      if (!rows[0]) {
        return res.status(404).json({ error: 'Користувача не знайдено' });
      }
      targetUserId = rows[0].id;
    }

    if (targetUserId === me) {
      return res.status(400).json({ error: 'Не можна додати самого себе в контакти' });
    }

    try {
      const result = await addContact(me, targetUserId);
      res.status(result.added ? 201 : 200).json(result);
    } catch (err) {
      if (err.code === 'USER_NOT_FOUND') {
        return res.status(404).json({ error: err.message });
      }
      if (err.code === 'SELF_CONTACT') {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }),
);

// DELETE /api/contacts/:userId — видалити контакт
contactsRouter.delete(
  '/:userId',
  asyncHandler(async (req, res) => {
    if (!uuid.safeParse(req.params.userId).success) {
      return res.status(400).json({ error: 'Невірний ідентифікатор користувача' });
    }

    const removed = await removeContact(req.user.user_id, req.params.userId);
    res.json({ ok: true, removed });
  }),
);
