import crypto from 'node:crypto';

/**
 * Пул анонімних українських образів тварин з граматично узгодженими префіксами та емодзі.
 */
export const ANONYMOUS_AVATARS = [
  { name: 'Лисиця', emoji: '🦊', prefix: 'Анонімна' },
  { name: 'Панда', emoji: '🐼', prefix: 'Анонімна' },
  { name: 'Лев', emoji: '🦁', prefix: 'Анонімний' },
  { name: 'Тигр', emoji: '🐯', prefix: 'Анонімний' },
  { name: 'Коала', emoji: '🐨', prefix: 'Анонімна' },
  { name: 'Заєць', emoji: '🐰', prefix: 'Анонімний' },
  { name: 'Сова', emoji: '🦉', prefix: 'Анонімна' },
  { name: 'Єнот', emoji: '🦝', prefix: 'Анонімний' },
  { name: 'Видра', emoji: '🦦', prefix: 'Анонімна' },
  { name: 'Їжак', emoji: '🦔', prefix: 'Анонімний' },
  { name: 'Вовк', emoji: '🐺', prefix: 'Анонімний' },
  { name: 'Ведмідь', emoji: '🐻', prefix: 'Анонімний' },
  { name: 'Пінгвін', emoji: '🐧', prefix: 'Анонімний' },
  { name: 'Бобер', emoji: '🦫', prefix: 'Анонімний' },
  { name: 'Олень', emoji: '🦌', prefix: 'Анонімний' },
  { name: 'Дельфін', emoji: '🐬', prefix: 'Анонімний' },
  { name: 'Кіт', emoji: '🐱', prefix: 'Анонімний' },
  { name: 'Пес', emoji: '🐶', prefix: 'Анонімний' },
];

/**
 * Обирає два гарантовано різних анонімних образи для двох співрозмовників.
 */
export function generateAvatarPair() {
  const index1 = Math.floor(Math.random() * ANONYMOUS_AVATARS.length);
  let index2 = Math.floor(Math.random() * (ANONYMOUS_AVATARS.length - 1));
  if (index2 >= index1) {
    index2 += 1;
  }
  const a1 = ANONYMOUS_AVATARS[index1];
  const a2 = ANONYMOUS_AVATARS[index2];
  return [
    {
      anonName: `${a1.prefix} ${a1.name}`,
      anonAvatar: a1.emoji,
    },
    {
      anonName: `${a2.prefix} ${a2.name}`,
      anonAvatar: a2.emoji,
    },
  ];
}

/**
 * Черга користувачів, які очікують підбору:
 * [{ userId, username, socketId, joinedAt }]
 */
const waitingQueue = [];

/**
 * Активні анонімні сесії:
 * Map<sessionId, SessionObject>
 */
const activeSessions = new Map();

/**
 * Індекс користувач -> активна сесія:
 * Map<userId, sessionId>
 */
const userSessionIndex = new Map();

/**
 * Індекс сокет -> активна сесія:
 * Map<socketId, sessionId>
 */
const socketSessionIndex = new Map();

/**
 * Історія раніше зустрінутих співрозмовників у поточній сесії сервера:
 * Map<userId, Set<partnerUserId>>
 * Забезпечує вимогу: після переходу до наступного або завершення чату
 * користувачі більше НЕ зможуть зустрітись знову в цій сесії!
 */
const userSeenPartners = new Map();

/**
 * Перевіряє, чи зустрічались користувачі раніше в поточній сесії.
 */
export function hasSeenPartner(userIdA, userIdB) {
  if (userIdA === userIdB) return true;
  return (
    userSeenPartners.get(userIdA)?.has(userIdB) ||
    userSeenPartners.get(userIdB)?.has(userIdA) ||
    false
  );
}

/**
 * Фіксує взаємний запис у список раніше зустрінутих співрозмовників.
 */
export function recordSeenPair(userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return;
  if (!userSeenPartners.has(userIdA)) {
    userSeenPartners.set(userIdA, new Set());
  }
  if (!userSeenPartners.has(userIdB)) {
    userSeenPartners.set(userIdB, new Set());
  }
  userSeenPartners.get(userIdA).add(userIdB);
  userSeenPartners.get(userIdB).add(userIdA);
}

/**
 * Знаходить активну сесію за sessionId.
 */
export function getSession(sessionId) {
  return activeSessions.get(sessionId) || null;
}

/**
 * Знаходить активну сесію користувача за userId.
 */
export function getSessionByUserId(userId) {
  const sessionId = userSessionIndex.get(userId);
  if (!sessionId) return null;
  return activeSessions.get(sessionId) || null;
}

/**
 * Знаходить активну сесію за socketId.
 */
export function getSessionBySocketId(socketId) {
  const sessionId = socketSessionIndex.get(socketId);
  if (!sessionId) return null;
  return activeSessions.get(sessionId) || null;
}

/**
 * Додає повідомлення до тимчасового буфера сесії (до 200 повідомлень).
 */
export function saveStrangerMessage(sessionId, message) {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.messages.push(message);
  if (session.messages.length > 200) {
    session.messages.shift();
  }
  return true;
}

/**
 * Видаляє користувача з черги очікування.
 */
export function cancelSearch(userId) {
  const index = waitingQueue.findIndex((entry) => entry.userId === userId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
    return true;
  }
  return false;
}

/**
 * Завершує активну анонімну сесію користувача, повертаючи дані для сповіщення партнера.
 */
export function leaveSession(userId, reason = 'left') {
  const sessionId = userSessionIndex.get(userId);
  if (!sessionId) return null;

  const session = activeSessions.get(sessionId);
  if (!session) {
    userSessionIndex.delete(userId);
    return null;
  }

  // Завжди фіксуємо взаємний запис у seenPartners, щоб більше не зустрітися
  recordSeenPair(session.user1.id, session.user2.id);

  // Очищаємо індекси
  activeSessions.delete(sessionId);
  userSessionIndex.delete(session.user1.id);
  userSessionIndex.delete(session.user2.id);
  socketSessionIndex.delete(session.user1.socketId);
  socketSessionIndex.delete(session.user2.socketId);

  const isUser1 = session.user1.id === userId;
  const leaver = isUser1 ? session.user1 : session.user2;
  const partner = isUser1 ? session.user2 : session.user1;

  return {
    sessionId,
    reason,
    leaver,
    partner,
    messages: session.messages,
  };
}

/**
 * Запитує або підтверджує додавання в контакти в рамках анонімної сесії.
 * Повертає { ok, mutual, session, requestedBy }
 */
export function requestContactMatch(sessionId, userId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: 'Сесію не знайдено' };
  }

  const isParticipant = session.user1.id === userId || session.user2.id === userId;
  if (!isParticipant) {
    return { ok: false, error: 'Ви не є учасником цієї сесії' };
  }

  session.matchRequests.add(userId);

  const bothAccepted =
    session.matchRequests.has(session.user1.id) &&
    session.matchRequests.has(session.user2.id);

  if (bothAccepted) {
    // Взаємний контакт підтверджено!
    // Сесія вважається завершеною як анонімна і конвертується у постійну
    activeSessions.delete(sessionId);
    userSessionIndex.delete(session.user1.id);
    userSessionIndex.delete(session.user2.id);
    socketSessionIndex.delete(session.user1.socketId);
    socketSessionIndex.delete(session.user2.socketId);

    // Додаємо в seenPartners
    recordSeenPair(session.user1.id, session.user2.id);

    return {
      ok: true,
      mutual: true,
      session,
      user1: session.user1,
      user2: session.user2,
      messages: session.messages,
    };
  }

  return {
    ok: true,
    mutual: false,
    requestedBy: userId,
    partner: session.user1.id === userId ? session.user2 : session.user1,
  };
}

/**
 * Пошук співрозмовника або додавання до черги очікування.
 *
 * @param {object} user - { id, username }
 * @param {string} socketId - ідентифікатор активного сокета
 * @param {object} [io] - опціональний екземпляр Socket.IO для перевірки доступності сокетів кандидатів
 */
export function findOrEnqueue(user, socketId, io = null) {
  // Якщо користувач вже в активній сесії — спочатку завершуємо її
  if (userSessionIndex.has(user.id)) {
    leaveSession(user.id, 'next');
  }

  // Видаляємо старий запис користувача з черги, якщо він уже чекав
  cancelSearch(user.id);

  // Шукаємо першого валідного кандидата в черзі (FIFO)
  let candidateIndex = -1;

  for (let i = 0; i < waitingQueue.length; i++) {
    const candidate = waitingQueue[i];

    // 1. Захист від само-підбору (навіть якщо дві вкладки одного користувача)
    if (candidate.userId === user.id) {
      continue;
    }

    // 2. Захист від повторної зустрічі в цій сесії (Session Exclusion)
    if (hasSeenPartner(user.id, candidate.userId)) {
      continue;
    }

    // 3. Перевірка на «мертвий» сокет, якщо передано Socket.IO
    if (io) {
      let candidateSocket = io.sockets.sockets.get(candidate.socketId);
      if (!candidateSocket || !candidateSocket.connected) {
        // Перевіряємо, чи користувач має активний підключений сокет у персональній кімнаті user:<userId>
        const userRoom = io.sockets.adapter?.rooms?.get(`user:${candidate.userId}`);
        const activeSocketId = userRoom ? Array.from(userRoom)[0] : null;
        if (activeSocketId && io.sockets.sockets.get(activeSocketId)?.connected) {
          candidate.socketId = activeSocketId;
          candidateSocket = io.sockets.sockets.get(activeSocketId);
        } else {
          // Видаляємо мертвий запис і продовжуємо перевірку наступного
          waitingQueue.splice(i, 1);
          i--;
          continue;
        }
      }
    }

    // Знайшли підходящого кандидата!
    candidateIndex = i;
    break;
  }

  if (candidateIndex === -1) {
    // Кандидата немає — додаємо поточного користувача в чергу
    waitingQueue.push({
      userId: user.id,
      username: user.username,
      socketId,
      joinedAt: Date.now(),
    });

    return {
      matched: false,
      status: 'waiting',
    };
  }

  // Витягуємо знайденого кандидата з черги
  const [candidate] = waitingQueue.splice(candidateIndex, 1);

  // Генеруємо два унікальні анонімні образи
  const [avatar1, avatar2] = generateAvatarPair();

  const sessionId = crypto.randomUUID();

  const session = {
    id: sessionId,
    user1: {
      id: candidate.userId,
      username: candidate.username,
      socketId: candidate.socketId,
      anonId: 'user1',
      anonName: avatar1.anonName,
      anonAvatar: avatar1.anonAvatar,
    },
    user2: {
      id: user.id,
      username: user.username,
      socketId,
      anonId: 'user2',
      anonName: avatar2.anonName,
      anonAvatar: avatar2.anonAvatar,
    },
    messages: [],
    matchRequests: new Set(),
    createdAt: new Date().toISOString(),
  };

  // Зберігаємо сесію та індекси
  activeSessions.set(sessionId, session);
  userSessionIndex.set(candidate.userId, sessionId);
  userSessionIndex.set(user.id, sessionId);
  socketSessionIndex.set(candidate.socketId, sessionId);
  socketSessionIndex.set(socketId, sessionId);

  // Фіксуємо взаємну зустріч у seenPartners для цієї сесії
  recordSeenPair(candidate.userId, user.id);

  return {
    matched: true,
    sessionId,
    session,
  };
}

/**
 * Обробка розриву з'єднання сокета.
 */
export function handleDisconnect(userId, socketId) {
  // Якщо сокет чекав у черзі — видаляємо
  const qIndex = waitingQueue.findIndex((entry) => entry.socketId === socketId || entry.userId === userId);
  if (qIndex !== -1) {
    waitingQueue.splice(qIndex, 1);
  }

  // Якщо сокет був у активній сесії — завершуємо сесію
  const sessionId = socketSessionIndex.get(socketId) || userSessionIndex.get(userId);
  if (sessionId) {
    return leaveSession(userId, 'disconnected');
  }

  return null;
}

/**
 * Службова функція для скидання внутрішнього стану (корисно для тестів).
 */
export function _resetStateForTesting() {
  waitingQueue.length = 0;
  activeSessions.clear();
  userSessionIndex.clear();
  socketSessionIndex.clear();
  userSeenPartners.clear();
}
