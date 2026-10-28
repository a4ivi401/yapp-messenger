import crypto from 'node:crypto';
import { z } from 'zod';
import { findSessionUser, SESSION_COOKIE } from './middleware/auth.js';
import {
  isParticipant,
  createMessage,
  getConversationParticipantIds,
  findOrCreateDirectConversation,
  getConversationForUser,
  markConversationRead,
  markMessageDelivered,
  setMessageReaction,
  editMessage,
  deleteMessage,
  REACTION_EMOJIS,
} from './conversations.js';
import { addContact } from './contacts.js';
import { recordMatch } from './matches.js';
import {
  addSocket,
  removeSocket,
  isOnline,
  touchLastSeen,
  broadcastPresence,
  getPresenceAudience,
} from './presence.js';
import {
  findOrEnqueue,
  cancelSearch,
  leaveSession,
  requestContactMatch,
  saveStrangerMessage,
  setStrangerReaction,
  editStrangerMessage,
  deleteStrangerMessage,
  getSession,
  getSessionByUserId,
  handleDisconnect,
} from './stranger.js';

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

const attachmentSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  type: z.enum(['image', 'file', 'audio', 'video']),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional().nullable(),
  mime: z.string().trim().max(128).optional().nullable(),
});

const sendMessageSchema = z
  .object({
    conversationId: z.string().uuid(),
    body: z.string().trim().max(4000).optional().default(''),
    attachment: attachmentSchema.optional().nullable(),
  })
  .refine(
    (data) => (data.body && data.body.length > 0) || Boolean(data.attachment),
    { message: 'Повідомлення не може бути порожнім' },
  );

const strangerMsgSchema = z
  .object({
    sessionId: z.string().uuid(),
    body: z.string().trim().max(4000).optional().default(''),
    attachment: attachmentSchema.optional().nullable(),
  })
  .refine(
    (data) => (data.body && data.body.length > 0) || Boolean(data.attachment),
    { message: 'Повідомлення не може бути порожнім' },
  );

const strangerSessionSchema = z.object({
  sessionId: z.string().uuid(),
});

const deliveredSchema = z.object({
  messageId: z.string().uuid(),
});

const messageReactSchema = z.object({
  messageId: z.string().uuid(),
  // null = зняти реакцію (toggle); невідомі емодзі відсіює z.enum —
  // у message_reactions потрапляє лише набір з REACTION_EMOJIS
  emoji: z.enum(REACTION_EMOJIS).optional().nullable(),
});

const messageEditSchema = z.object({
  messageId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

const messageDeleteSchema = z.object({
  messageId: z.string().uuid(),
});

const typingSchema = z.object({
  conversationId: z.string().uuid(),
  isTyping: z.boolean(),
});

const strangerTypingSchema = z.object({
  sessionId: z.string().uuid(),
  isTyping: z.boolean(),
});

const strangerReactionSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().min(1),
  // null = зняти реакцію (toggle); невідомі емодзі відсіює z.enum
  emoji: z.enum(REACTION_EMOJIS).optional().nullable(),
});

// messageId ефемерних повідомлень не uuid, тому просто непорожній рядок
const strangerEditSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().min(1),
  body: z.string().trim().min(1).max(4000),
});

const strangerDeleteSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().min(1),
});

// Не частіше одного typing-сигналу на адресата за 500 мс: клієнт уже тротлить,
// це другий рубіж проти багатого/зламаного клієнта.
const TYPING_THROTTLE_MS = 500;

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

    // Присутність: користувач онлайн, поки в нього є хоч один живий сокет.
    // Повідомляємо лише при переході офлайн → онлайн, інакше кожна нова
    // вкладка спамила б співрозмовників однаковою подією.
    const { becameOnline } = addSocket(socket.user.id, socket.id);
    if (becameOnline) {
      // Предикат відсікає випадок, коли користувач уже встиг відключитися,
      // поки готувалася розсилка
      broadcastPresence(
        io,
        socket.user.id,
        { isOnline: true, lastSeenAt: null },
        () => isOnline(socket.user.id),
      );
    }

    // Передаємо щойно підключеному сокету актуальний онлайн-стан тих його
    // співрозмовників та контактів, які вже в мережі
    getPresenceAudience(socket.user.id)
      .then((audience) => {
        for (const partnerId of audience) {
          if (isOnline(partnerId)) {
            socket.emit('presence:update', {
              userId: partnerId,
              isOnline: true,
              lastSeenAt: null,
            });
          }
        }
      })
      .catch((err) => console.error('presence init error:', err));

    // Якщо у користувача вже є активна анонімна сесія — приєднуємо сокет до кімнати сесії
    const activeStranger = getSessionByUserId(socket.user.id);
    if (activeStranger) {
      socket.join(`stranger:${activeStranger.id}`);
    }

    // Стан тротлінгу typing-подій цього сокета. Живе в пам'яті процесу — свідомо:
    // для кількох інстансів знадобиться Socket.IO Redis adapter.
    const lastTypingSentAt = new Map();
    const isTypingThrottled = (key) => {
      const now = Date.now();
      if (now - (lastTypingSentAt.get(key) ?? 0) < TYPING_THROTTLE_MS) return true;
      lastTypingSentAt.set(key, now);
      return false;
    };

    // Надсилає подію лише співрозмовнику по діалогу (1:1).
    // Повертає false, якщо користувач не є учасником діалогу — тоді нічого не надіслано.
    async function emitToPartners(conversationId, event, payload) {
      const participantIds = await getConversationParticipantIds(conversationId);
      if (!participantIds.includes(socket.user.id)) return false;

      const partnerRooms = participantIds
        .filter((id) => id !== socket.user.id)
        .map((id) => `user:${id}`);

      if (partnerRooms.length > 0) io.to(partnerRooms).emit(event, payload);
      return true;
    }

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

        const { conversationId, body, attachment } = parsed.data;
        const participant = await isParticipant(conversationId, socket.user.id);
        if (!participant) {
          return ack?.({ ok: false, error: 'Діалог не знайдено' });
        }

        const message = await createMessage(conversationId, socket.user.id, body, attachment);

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

    // Ставить / знімає реакцію (toggle) на повідомлення постійного діалогу
    socket.on('message:react', async (data, ack) => {
      try {
        const parsed = messageReactSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { messageId } = parsed.data;
        const emoji = parsed.data.emoji || null;
        const result = await setMessageReaction(messageId, socket.user.id, emoji);
        if (!result) {
          // null = «нічого не змінилось»: no-op повторного кліку або немає прав.
          // Інтерпретують однаково (ok без розсилки), щоб подія не стала оракулом
          // для перебору чужих messageId.
          return ack?.({ ok: true });
        }

        const participantIds = await getConversationParticipantIds(result.conversationId);
        const targetRooms = [
          `conversation:${result.conversationId}`,
          ...participantIds.map((id) => `user:${id}`),
        ];
        io.to(targetRooms).emit('message:reaction', {
          conversationId: result.conversationId,
          messageId,
          reactions: result.reactions,
        });

        ack?.({ ok: true });
      } catch (err) {
        console.error('message:react error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Редагування власного повідомлення постійного діалогу
    socket.on('message:edit', async (data, ack) => {
      try {
        const parsed = messageEditSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { messageId, body } = parsed.data;
        const message = await editMessage(messageId, socket.user.id, body);
        if (!message) {
          return ack?.({ ok: false, error: 'Повідомлення не знайдено' });
        }

        const participantIds = await getConversationParticipantIds(message.conversationId);
        const targetRooms = [
          `conversation:${message.conversationId}`,
          ...participantIds.map((id) => `user:${id}`),
        ];
        io.to(targetRooms).emit('message:updated', { message });

        ack?.({ ok: true, message });
      } catch (err) {
        console.error('message:edit error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Tombstone-видалення власного повідомлення постійного діалогу
    socket.on('message:delete', async (data, ack) => {
      try {
        const parsed = messageDeleteSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { messageId } = parsed.data;
        const result = await deleteMessage(messageId, socket.user.id);
        if (!result) {
          return ack?.({ ok: false, error: 'Повідомлення не знайдено' });
        }

        const participantIds = await getConversationParticipantIds(result.conversationId);
        const targetRooms = [
          `conversation:${result.conversationId}`,
          ...participantIds.map((id) => `user:${id}`),
        ];
        io.to(targetRooms).emit('message:deleted', {
          conversationId: result.conversationId,
          messageId,
        });

        ack?.({ ok: true });
      } catch (err) {
        console.error('message:delete error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Позначення діалогу прочитаним: піднімає watermark і повідомляє співрозмовника,
    // щоб у відправника тіки стали «прочитано»
    socket.on('conversation:read', async (data, ack) => {
      try {
        const parsed = joinLeaveSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { conversationId } = parsed.data;
        const result = await markConversationRead(conversationId, socket.user.id);

        // null означає «немає нових вхідних» або «не учасник». Навмисно не розрізняємо:
        // інакше подія стала б оракулом для перебору чужих conversationId.
        if (result) {
          await emitToPartners(conversationId, 'message:read', {
            conversationId,
            userId: socket.user.id,
            lastReadAt: result.lastReadAt,
          });
        }

        ack?.({ ok: true });
      } catch (err) {
        console.error('conversation:read error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Підтвердження доставки повідомлення одержувачем (подвійна галочка у відправника)
    socket.on('message:delivered', async (data, ack) => {
      try {
        const parsed = deliveredSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { messageId } = parsed.data;
        const result = await markMessageDelivered(messageId, socket.user.id);

        if (result) {
          io.to(`user:${result.senderId}`).emit('message:delivered', {
            conversationId: result.conversationId,
            messageId,
            userId: socket.user.id,
            lastDeliveredAt: result.lastDeliveredAt,
          });
        }

        ack?.({ ok: true });
      } catch (err) {
        console.error('message:delivered error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Індикатор «друкує…» у прямому діалозі.
    // Сервер не зберігає стан: лише релеїть подію, а клієнт-одержувач сам гасить
    // індикатор за таймаутом, тож втрачена подія isTyping:false нічого не ламає.
    socket.on('typing', async (data, ack) => {
      try {
        const parsed = typingSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { conversationId, isTyping } = parsed.data;

        // Глушимо лише старт: подію зупинки треба пропускати завжди, інакше індикатор залипне
        if (isTyping && isTypingThrottled(`conversation:${conversationId}`)) {
          return ack?.({ ok: true });
        }

        const sent = await emitToPartners(conversationId, 'typing', {
          conversationId,
          userId: socket.user.id,
          isTyping,
        });
        if (!sent) {
          return ack?.({ ok: false, error: 'Діалог не знайдено' });
        }

        ack?.({ ok: true });
      } catch (err) {
        console.error('typing error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // ==========================================
    // Випадковий анонімний співрозмовник (Stranger)
    // ==========================================

    // Допоміжна функція для оповіщення пари про метч
    function notifyMatch(session) {
      // Приєднуємо всі відкриті сокети користувачів до кімнати сесії
      if (io.in) {
        io.in(`user:${session.user1.id}`).socketsJoin(`stranger:${session.id}`);
        io.in(`user:${session.user2.id}`).socketsJoin(`stranger:${session.id}`);
      }

      const socket1 = io.sockets.sockets.get(session.user1.socketId);
      const socket2 = io.sockets.sockets.get(session.user2.socketId);

      if (socket1) socket1.join(`stranger:${session.id}`);
      if (socket2) socket2.join(`stranger:${session.id}`);

      io.to(`user:${session.user1.id}`).emit('stranger:matched', {
        sessionId: session.id,
        myAnon: {
          anonId: session.user1.anonId,
          anonName: session.user1.anonName,
          anonAvatar: session.user1.anonAvatar,
        },
        partner: {
          anonId: session.user2.anonId,
          anonName: session.user2.anonName,
          anonAvatar: session.user2.anonAvatar,
        },
      });

      io.to(`user:${session.user2.id}`).emit('stranger:matched', {
        sessionId: session.id,
        myAnon: {
          anonId: session.user2.anonId,
          anonName: session.user2.anonName,
          anonAvatar: session.user2.anonAvatar,
        },
        partner: {
          anonId: session.user1.anonId,
          anonName: session.user1.anonName,
          anonAvatar: session.user1.anonAvatar,
        },
      });
    }

    // Початок пошуку
    socket.on('stranger:search', (ack) => {
      try {
        const result = findOrEnqueue(socket.user, socket.id, io);
        if (!result.matched) {
          return ack?.({ ok: true, status: 'waiting' });
        }

        notifyMatch(result.session);
        ack?.({ ok: true, status: 'matched', sessionId: result.sessionId });
      } catch (err) {
        console.error('stranger:search error:', err);
        ack?.({ ok: false, error: 'Помилка підбору співрозмовника' });
      }
    });

    // Скасування пошуку
    socket.on('stranger:cancel', (ack) => {
      try {
        cancelSearch(socket.user.id);
        ack?.({ ok: true });
      } catch (err) {
        console.error('stranger:cancel error:', err);
        ack?.({ ok: false, error: 'Помилка скасування пошуку' });
      }
    });

    // Відправка повідомлення незнайомцю (ефемерне повідомлення в пам'яті)
    socket.on('stranger:message', (data, ack) => {
      try {
        const parsed = strangerMsgSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { sessionId, body, attachment } = parsed.data;
        const session = getSession(sessionId);
        if (!session) {
          return ack?.({ ok: false, error: 'Сесію не знайдено або вже завершено' });
        }

        const isUser1 = session.user1.id === socket.user.id;
        const isUser2 = session.user2.id === socket.user.id;
        if (!isUser1 && !isUser2) {
          return ack?.({ ok: false, error: 'Ви не є учасником цієї сесії' });
        }

        const myUser = isUser1 ? session.user1 : session.user2;
        const message = {
          id: `stranger-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          sessionId,
          senderId: socket.user.id,
          senderAnonId: myUser.anonId,
          senderAnonName: myUser.anonName,
          senderAnonAvatar: myUser.anonAvatar,
          body: body || '',
          attachment: attachment || null,
          createdAt: new Date().toISOString(),
        };

        saveStrangerMessage(sessionId, message);
        io.to(`stranger:${sessionId}`)
          .to(`user:${session.user1.id}`)
          .to(`user:${session.user2.id}`)
          .emit('stranger:message', { message });

        ack?.({ ok: true, message });
      } catch (err) {
        console.error('stranger:message error:', err);
        ack?.({ ok: false, error: 'Не вдалося надіслати повідомлення' });
      }
    });

    // «Друкує…» в анонімному чаті: релей партнеру по сесії, без збереження стану
    socket.on('stranger:typing', (data, ack) => {
      try {
        const parsed = strangerTypingSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { sessionId, isTyping } = parsed.data;
        const session = getSession(sessionId);
        if (!session) {
          return ack?.({ ok: false, error: 'Сесію не знайдено або вже завершено' });
        }

        const isUser1 = session.user1.id === socket.user.id;
        const isUser2 = session.user2.id === socket.user.id;
        if (!isUser1 && !isUser2) {
          return ack?.({ ok: false, error: 'Ви не є учасником цієї сесії' });
        }

        if (isTyping && isTypingThrottled(`stranger:${sessionId}`)) {
          return ack?.({ ok: true });
        }

        const partner = isUser1 ? session.user2 : session.user1;
        io.to(`user:${partner.id}`).emit('stranger:typing', {
          sessionId,
          userId: socket.user.id,
          isTyping,
        });

        ack?.({ ok: true });
      } catch (err) {
        console.error('stranger:typing error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Toggle реакції на ефемерному повідомленні анонімного чату (in-memory стан сесії)
    socket.on('stranger:react', (data, ack) => {
      try {
        const parsed = strangerReactionSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { sessionId, messageId, emoji } = parsed.data;
        // null = «нічого не змінилось»: no-op або немає прав/повідомлення.
        // Інтерпретуємо однаково (ok без розсилки), щоб подія не стала оракулом.
        const result = setStrangerReaction(sessionId, socket.user.id, messageId, emoji || null);
        if (result) {
          io.to(`stranger:${sessionId}`).emit('stranger:reaction', {
            sessionId,
            messageId,
            reactions: result.reactions,
          });
        }

        ack?.({ ok: true });
      } catch (err) {
        console.error('stranger:react error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Редагування власного ефемерного повідомлення
    socket.on('stranger:edit', (data, ack) => {
      try {
        const parsed = strangerEditSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { sessionId, messageId, body } = parsed.data;
        const result = editStrangerMessage(sessionId, socket.user.id, messageId, body);
        if (!result) {
          return ack?.({ ok: false, error: 'Повідомлення не знайдено' });
        }

        io.to(`stranger:${sessionId}`).emit('stranger:updated', { message: result.message });

        ack?.({ ok: true, message: result.message });
      } catch (err) {
        console.error('stranger:edit error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Tombstone-видалення власного ефемерного повідомлення
    socket.on('stranger:delete', (data, ack) => {
      try {
        const parsed = strangerDeleteSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { sessionId, messageId } = parsed.data;
        const result = deleteStrangerMessage(sessionId, socket.user.id, messageId);
        if (!result) {
          return ack?.({ ok: false, error: 'Повідомлення не знайдено' });
        }

        io.to(`stranger:${sessionId}`).emit('stranger:updated', { message: result.message });

        ack?.({ ok: true, message: result.message });
      } catch (err) {
        console.error('stranger:delete error:', err);
        ack?.({ ok: false, error: 'Внутрішня помилка' });
      }
    });

    // Перехід до наступного співрозмовника («🎲 Інший»)
    socket.on('stranger:next', (ack) => {
      try {
        const left = leaveSession(socket.user.id, 'next');
        if (left) {
          socket.leave(`stranger:${left.sessionId}`);
          io.to(`user:${left.partner.id}`).emit('stranger:left', {
            sessionId: left.sessionId,
            reason: 'next',
          });
        }

        const result = findOrEnqueue(socket.user, socket.id, io);
        if (!result.matched) {
          return ack?.({ ok: true, status: 'waiting' });
        }

        notifyMatch(result.session);
        ack?.({ ok: true, status: 'matched', sessionId: result.sessionId });
      } catch (err) {
        console.error('stranger:next error:', err);
        ack?.({ ok: false, error: 'Помилка переходу до наступного співрозмовника' });
      }
    });

    // Завершення чату зі сторони користувача
    socket.on('stranger:leave', (ack) => {
      try {
        cancelSearch(socket.user.id);
        const left = leaveSession(socket.user.id, 'left');
        if (left) {
          socket.leave(`stranger:${left.sessionId}`);
          io.to(`user:${left.partner.id}`).emit('stranger:left', {
            sessionId: left.sessionId,
            reason: 'left',
          });
        }
        ack?.({ ok: true });
      } catch (err) {
        console.error('stranger:leave error:', err);
        ack?.({ ok: false, error: 'Помилка завершення розмови' });
      }
    });

    // Запит або підтвердження додавання в контакти («🤝 Додати в контакти»)
    socket.on('stranger:match-request', async (data, ack) => {
      try {
        const parsed = strangerSessionSchema.safeParse(data);
        if (!parsed.success) {
          return ack?.({ ok: false, error: parsed.error.issues[0].message });
        }

        const { sessionId } = parsed.data;
        const result = requestContactMatch(sessionId, socket.user.id);
        if (!result.ok) {
          return ack?.({ ok: false, error: result.error });
        }

        if (!result.mutual) {
          // Запит надіслано одним учасником — сповіщаємо партнера
          io.to(`user:${result.partner.id}`).emit('stranger:match-invited', {
            sessionId,
          });
          return ack?.({ ok: true, mutual: false });
        }

        // Взаємний метч! Обидва учасники погодилися
        const { user1, user2, messages } = result;

        // 1. Додаємо взаємні контакти в БД
        await addContact(user1.id, user2.id);
        await addContact(user2.id, user1.id);

        // 2. Створюємо постійний direct-діалог в БД
        const { id: conversationId } = await findOrCreateDirectConversation(user1.id, user2.id);

        // 3. Зберігаємо всі надіслані ефемерні повідомлення в таблицю messages
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            if (msg.senderId && ((msg.body && msg.body.trim().length > 0) || msg.attachment)) {
              try {
                await createMessage(conversationId, msg.senderId, msg.body || '', msg.attachment || null);
              } catch (mErr) {
                console.error('Error migrating message from ephemeral chat:', mErr);
              }
            }
          }
        }

        // 4. Фіксуємо метч в історії (ідемпотентно: повторний метч тієї ж пари не дублюється)
        const { match } = await recordMatch(user1.id, user2.id, conversationId);

        // 5. Отримуємо актуальні об'єкти діалогу для кожного користувача
        const convForUser1 = await getConversationForUser(conversationId, user1.id);
        const convForUser2 = await getConversationForUser(conversationId, user2.id);

        // 6. Сповіщаємо обох про розкриття особистостей
        io.to(`user:${user1.id}`).emit('stranger:revealed', {
          sessionId,
          conversationId,
          matchId: match.id,
          conversation: convForUser1,
          partner: {
            id: user2.id,
            username: user2.username,
          },
        });

        io.to(`user:${user2.id}`).emit('stranger:revealed', {
          sessionId,
          conversationId,
          matchId: match.id,
          conversation: convForUser2,
          partner: {
            id: user1.id,
            username: user1.username,
          },
        });

        // Також сповіщаємо про появу нового контакту
        io.to(`user:${user1.id}`).emit('contact:new', {
          contact: { id: user2.id, username: user2.username, addedAt: new Date().toISOString() },
        });
        io.to(`user:${user2.id}`).emit('contact:new', {
          contact: { id: user1.id, username: user1.username, addedAt: new Date().toISOString() },
        });

        // І про новий метч — клієнт оновлює лічильник у профілі без перезавантаження
        io.to(`user:${user1.id}`).emit('match:new', {
          match: {
            id: match.id,
            conversationId,
            createdAt: match.createdAt,
            partner: { id: user2.id, username: user2.username },
          },
        });
        io.to(`user:${user2.id}`).emit('match:new', {
          match: {
            id: match.id,
            conversationId,
            createdAt: match.createdAt,
            partner: { id: user1.id, username: user1.username },
          },
        });

        ack?.({ ok: true, mutual: true, conversationId, matchId: match.id });
      } catch (err) {
        console.error('stranger:match-request error:', err);
        ack?.({ ok: false, error: 'Помилка обробки запиту контакту' });
      }
    });

    // Розрив з'єднання сокета
    socket.on('disconnect', () => {
      // Присутність рахуємо до будь-яких інших перевірок: якщо це був останній
      // сокет користувача — фіксуємо час виходу і повідомляємо тих, кому він видимий.
      const { wentOffline } = removeSocket(socket.user.id, socket.id);
      if (wentOffline) {
        touchLastSeen(socket.user.id)
          .then((lastSeenAt) =>
            // Поки йшов запис у БД, користувач міг перепідключитися:
            // тоді стан перевіряємо ще раз, щоб не розіслати хибний «офлайн»
            broadcastPresence(
              io,
              socket.user.id,
              { isOnline: false, lastSeenAt },
              () => !isOnline(socket.user.id),
            ),
          )
          .catch((err) => console.error('presence disconnect error:', err));
      }

      // Якщо у користувача ще є інші активні підключення (інші вкладки або оновлення транспорту),
      // не скидаємо його сесію передчасно
      const remainingSockets = io.sockets.adapter?.rooms?.get(`user:${socket.user.id}`);
      if (remainingSockets && remainingSockets.size > 0) {
        return;
      }

      const left = handleDisconnect(socket.user.id, socket.id);
      if (left && left.partner) {
        io.to(`user:${left.partner.id}`).emit('stranger:left', {
          sessionId: left.sessionId,
          reason: 'disconnected',
        });
      }
    });
  });
}
