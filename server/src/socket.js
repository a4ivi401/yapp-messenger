import crypto from 'node:crypto';
import { z } from 'zod';
import { findSessionUser, SESSION_COOKIE } from './middleware/auth.js';
import {
  isParticipant,
  createMessage,
  getConversationParticipantIds,
  findOrCreateDirectConversation,
  getConversationForUser,
} from './conversations.js';
import { addContact } from './contacts.js';
import {
  findOrEnqueue,
  cancelSearch,
  leaveSession,
  requestContactMatch,
  saveStrangerMessage,
  getSession,
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

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

const strangerMsgSchema = z.object({
  sessionId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

const strangerSessionSchema = z.object({
  sessionId: z.string().uuid(),
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

    // ==========================================
    // Випадковий анонімний співрозмовник (Stranger)
    // ==========================================

    // Допоміжна функція для оповіщення пари про метч
    function notifyMatch(session) {
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

        const { sessionId, body } = parsed.data;
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
          body,
          createdAt: new Date().toISOString(),
        };

        saveStrangerMessage(sessionId, message);
        io.to(`stranger:${sessionId}`).emit('stranger:message', { message });

        ack?.({ ok: true, message });
      } catch (err) {
        console.error('stranger:message error:', err);
        ack?.({ ok: false, error: 'Не вдалося надіслати повідомлення' });
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
            if (msg.senderId && msg.body) {
              try {
                await createMessage(conversationId, msg.senderId, msg.body);
              } catch (mErr) {
                console.error('Помилка міграції повідомлення з ефемерного чату:', mErr);
              }
            }
          }
        }

        // 4. Отримуємо актуальні об'єкти діалогу для кожного користувача
        const convForUser1 = await getConversationForUser(conversationId, user1.id);
        const convForUser2 = await getConversationForUser(conversationId, user2.id);

        // 5. Сповіщаємо обох про розкриття особистостей
        io.to(`user:${user1.id}`).emit('stranger:revealed', {
          sessionId,
          conversationId,
          conversation: convForUser1,
          partner: {
            id: user2.id,
            username: user2.username,
          },
        });

        io.to(`user:${user2.id}`).emit('stranger:revealed', {
          sessionId,
          conversationId,
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

        ack?.({ ok: true, mutual: true, conversationId });
      } catch (err) {
        console.error('stranger:match-request error:', err);
        ack?.({ ok: false, error: 'Помилка обробки запиту контакту' });
      }
    });

    // Розрив з'єднання сокета
    socket.on('disconnect', () => {
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
