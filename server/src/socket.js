import { z } from 'zod';
import { findSessionUser, SESSION_COOKIE } from './middleware/auth.js';
import { isParticipant, createMessage, getConversationParticipantIds } from './conversations.js';

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};
  for (const item of cookieHeader.split(';')) {
    const [rawKey, ...rawVal] = item.trim().split('=');
    if (!rawKey) continue;
    cookies[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal.join('='));
  }
  return cookies;
}

const joinLeaveSchema = z.object({
  conversationId: z.string().uuid(),
});

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

/**
 * Налаштовує Socket.IO сервер: авторизація, кімнати діалогів та realtime-повідомлення.
 */
export function setupSocket(io) {
  // Middleware авторизації сокета через сесійну cookie (sid)
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      const cookies = parseCookies(cookieHeader);
      const token = cookies[SESSION_COOKIE];

      if (!token) {
        return next(new Error('Не авторизовано'));
      }

      const session = await findSessionUser(token);
      if (!session) {
        return next(new Error('Не авторизовано'));
      }

      socket.user = {
        id: session.user_id,
        username: session.username,
      };
      next();
    } catch (err) {
      next(new Error('Помилка авторизації'));
    }
  });

  io.on('connection', (socket) => {
    // Персональна кімната користувача (для майбутніх системних сповіщень та метчингу)
    socket.join(`user:${socket.user.id}`);

    // Приєднання до кімнати діалогу
    socket.on('conversation:join', async (data, ack) => {
      try {
        const parsed = joinLeaveSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { conversationId } = parsed.data;
        const participant = await isParticipant(conversationId, socket.user.id);
        if (!participant) {
          return ack?.({ ok: false, error: 'Діалог не знайдено' });
        }

        socket.join(`conversation:${conversationId}`);
        ack?.({ ok: true });
      } catch (err) {
        console.error('conversation:join error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Вихід з кімнати діалогу
    socket.on('conversation:leave', (data, ack) => {
      try {
        const parsed = joinLeaveSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        socket.leave(`conversation:${parsed.data.conversationId}`);
        ack?.({ ok: true });
      } catch (err) {
        console.error('conversation:leave error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Відправка повідомлення через сокет
    socket.on('message:send', async (data, ack) => {
      try {
        const parsed = sendMessageSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { conversationId, body } = parsed.data;
        const participant = await isParticipant(conversationId, socket.user.id);
        if (!participant) {
          return ack?.({ ok: false, error: 'Діалог не знайдено' });
        }

        const message = await createMessage(conversationId, socket.user.id, body);

        // Отримуємо всіх учасників для трансляції в кімнату діалогу та персональні кімнати
        const participantIds = await getConversationParticipantIds(conversationId);
        const targetRooms = [
          `conversation:${conversationId}`,
          ...participantIds.map((id) => `user:${id}`),
        ];

        // Socket.IO автоматично уникає дублювання подій для одного й того ж клієнта при вказанні масиву кімнат
        io.to(targetRooms).emit('message:new', { message });

        ack?.({ ok: true, message });
      } catch (err) {
        console.error('message:send error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });
  });
}
