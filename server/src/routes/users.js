import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { searchUsers } from '../contacts.js';
import { getUserProfile, updateUserProfile } from '../users.js';

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.code === 'USERNAME_TAKEN') {
      return res.status(409).json({ error: 'Це імʼя вже зайняте' });
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутрішня помилка' });
  });

const searchQuerySchema = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1, 'Ліміт має бути не менше 1').max(50, 'Ліміт не більше 50').default(20),
});

const updateProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Імʼя користувача має містити щонайменше 3 символи')
    .max(20, 'Імʼя користувача не може перевищувати 20 символів')
    .regex(/^[a-zA-Z0-9_]+$/, 'Імʼя: тільки латиниця, цифри та _')
    .optional(),
  displayName: z
    .string()
    .trim()
    .max(50, 'Імʼя не може перевищувати 50 символів')
    .nullable()
    .optional(),
  avatarUrl: z
    .string()
    .trim()
    .max(500, 'Посилання на аватар занадто довге')
    .nullable()
    .optional(),
  bio: z
    .string()
    .trim()
    .max(300, 'Опис профілю не може перевищувати 300 символів')
    .nullable()
    .optional(),
});

export const usersRouter = Router();

usersRouter.use(requireAuth);

// GET /api/users/search?q=... — глобальний пошук користувачів за нікнеймом або ім'ям
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

// GET /api/users/:id/profile — детальний перегляд профілю користувача
usersRouter.get(
  '/:id/profile',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validUuid = z.string().uuid().safeParse(id);
    if (!validUuid.success) {
      return res.status(400).json({ error: 'Некоректний ідентифікатор користувача' });
    }

    const user = await getUserProfile(req.user.user_id, id);
    if (!user) {
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }

    res.json({ user });
  }),
);

// PATCH /api/users/me — редагування власного профілю
usersRouter.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const updatedUser = await updateUserProfile(req.user.user_id, parsed.data);

    // Сповіщення підключених клієнтів про зміну профілю в реальному часі
    const io = req.app.get('io');
    if (io) {
      io.emit('user:updated', {
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          displayName: updatedUser.displayName,
          avatarUrl: updatedUser.avatarUrl,
        },
      });
    }

    res.json({ user: updatedUser });
  }),
);
