import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db.js';
import {
  findOrCreateDirectConversation,
  getConversationForUser,
  isParticipant,
  listConversationsForUser,
  listMessages,
  listMessagesAround,
  createMessage,
  getConversationParticipantIds,
} from '../conversations.js';

// Express 4 не передає помилки з async-обробників у error-middleware (а глобального тут і немає),
// тож обгортаємо кожен хендлер, щоб кинута помилка не стала unhandled rejection.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутрішня помилка' });
  });

const uuid = z.string().uuid();

const createConversationSchema = z.object({
  username: z.string().trim().min(3).max(20),
});

const attachmentSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  type: z.enum(['image', 'file', 'audio', 'video']),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional().nullable(),
  mime: z.string().trim().max(128).optional().nullable(),
});

const messageSchema = z
  .object({
    body: z.string().trim().max(4000).optional().default(''),
    attachment: attachmentSchema.optional().nullable(),
  })
  .refine(
    (data) => (data.body && data.body.length > 0) || Boolean(data.attachment),
    { message: 'Повідомлення не може бути порожнім' },
  );

const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().uuid().optional(),
  // Вікно навколо повідомлення (перехід зі пошуку): старші, цільове, новіші
  around: z.string().uuid().optional(),
});

export const conversationsRouter = Router();

// Усі маршрути діалогів доступні лише авторизованим користувачам.
conversationsRouter.use(requireAuth);

// GET /api/conversations — список діалогів поточного користувача
conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversations = await listConversationsForUser(req.user.user_id);
    res.json({ conversations });
  }),
);

// POST /api/conversations — почати (або відкрити наявний) прямий діалог за username
conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const me = req.user.user_id;
    const targetUsername = parsed.data.username.replace(/^@+/, '');
    const { rows } = await query('SELECT id FROM users WHERE username = $1', [
      targetUsername,
    ]);
    const target = rows[0];
    if (!target) {
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }
    if (target.id === me) {
      return res.status(400).json({ error: 'Не можна почати діалог із самим собою' });
    }

    const { id, created } = await findOrCreateDirectConversation(me, target.id);
    const conversation = await getConversationForUser(id, me);
    res.status(created ? 201 : 200).json({ conversation });
  }),
);

// GET /api/conversations/:id — деталі діалогу (лише для учасника)
conversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) {
      return res.status(404).json({ error: 'Діалог не знайдено' });
    }
    const conversation = await getConversationForUser(req.params.id, req.user.user_id);
    if (!conversation) {
      return res.status(404).json({ error: 'Діалог не знайдено' });
    }
    res.json({ conversation });
  }),
);

// GET /api/conversations/:id/messages — історія повідомлень (пагінація курсором before)
conversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) {
      return res.status(404).json({ error: 'Діалог не знайдено' });
    }
    const parsed = listMessagesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    if (!(await isParticipant(req.params.id, req.user.user_id))) {
      return res.status(404).json({ error: 'Діалог не знайдено' });
    }

    try {
      // around має пріоритет: клієнт навмисно йде до конкретного повідомлення
      if (parsed.data.around) {
        const window = await listMessagesAround(
          req.params.id,
          parsed.data.around,
          req.user.user_id,
        );
        if (!window) {
          return res.status(404).json({ error: 'Повідомлення не знайдено' });
        }
        return res.json(window);
      }
      const result = await listMessages(req.params.id, parsed.data);
      res.json(result);
    } catch (err) {
      if (err.code === 'INVALID_CURSOR') {
        return res.status(400).json({ error: 'Невірний курсор' });
      }
      throw err;
    }
  }),
);

// POST /api/conversations/:id/messages — надіслати повідомлення (persist; realtime додамо в Day 3)
conversationsRouter.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) {
      return res.status(404).json({ error: 'Діалог не знайдено' });
    }
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const me = req.user.user_id;
    if (!(await isParticipant(req.params.id, me))) {
      return res.status(404).json({ error: 'Діалог не знайдено' });
    }

    const message = await createMessage(
      req.params.id,
      me,
      parsed.data.body,
      parsed.data.attachment,
    );

    const io = req.app.get('io');
    if (io) {
      const participantIds = await getConversationParticipantIds(req.params.id);
      const targetRooms = [
        `conversation:${req.params.id}`,
        ...participantIds.map((id) => `user:${id}`),
      ];
      io.to(targetRooms).emit('message:new', { message });
    }

    res.status(201).json({ message });
  }),
);
