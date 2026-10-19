import { query } from './db.js';

/**
 * Присутність користувачів: хто зараз онлайн і коли кого востаннє бачили.
 *
 * Онлайн-стан живе лише в пам'яті процесу — це свідомий вибір (див. ADR-006):
 * Redis не використовується, тому сервер розрахований на один інстанс.
 * Джерело істини про «зараз онлайн» — множина живих сокетів, а не БД:
 * запис у БД на кожне підключення був би зайвим навантаженням і все одно
 * розсинхронізувався б після падіння процесу.
 *
 * Для «востаннє в мережі» навпаки потрібна персистентність — вона в
 * users.last_seen_at (міграція 006).
 */

/** userId -> Set<socketId>. Користувач онлайн, поки множина не порожня. */
const socketsByUser = new Map();

/**
 * Раз на стільки мілісекунд робимо один пакетний UPDATE last_seen_at
 * для всіх онлайн-користувачів. Ціна — один запит на хвилину незалежно
 * від кількості користувачів.
 */
export const LAST_SEEN_FLUSH_MS = 60_000;

/**
 * Реєструє новий сокет користувача.
 * Повертає { becameOnline } — true лише для першого сокета (перша вкладка,
 * перший пристрій). Друга вкладка не має права перезаписувати last_seen_at.
 */
export function addSocket(userId, socketId) {
  let sockets = socketsByUser.get(userId);
  if (!sockets) {
    sockets = new Set();
    socketsByUser.set(userId, sockets);
  }
  const becameOnline = sockets.size === 0;
  sockets.add(socketId);
  return { becameOnline };
}

/**
 * Знімає сокет з обліку.
 * Повертає { wentOffline } — true, коли це був останній сокет користувача.
 * Повторний виклик для того самого socketId безпечний (ідемпотентний).
 */
export function removeSocket(userId, socketId) {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return { wentOffline: false };

  sockets.delete(socketId);
  if (sockets.size > 0) return { wentOffline: false };

  socketsByUser.delete(userId);
  return { wentOffline: true };
}

/** Чи є в користувача хоч один живий сокет. */
export function isOnline(userId) {
  return socketsByUser.has(userId);
}

/** Усі користувачі, які зараз онлайн (для пакетного оновлення last_seen_at). */
export function onlineUserIds() {
  return [...socketsByUser.keys()];
}

/**
 * Фіксує момент виходу для одного користувача.
 * Повертає фактичний last_seen_at з БД (timestamptz), щоб клієнти одразу
 * отримали ту саму мітку, а не власний локальний час.
 */
export async function touchLastSeen(userId) {
  const { rows } = await query(
    `UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at`,
    [userId],
  );
  return rows[0]?.last_seen_at ?? null;
}

/**
 * Пакетно оновлює last_seen_at для всіх, хто зараз онлайн.
 * Викликається за таймером і при коректному завершенні процесу.
 * Повертає кількість оновлених рядків.
 */
export async function flushLastSeen() {
  const ids = onlineUserIds();
  if (ids.length === 0) return 0;

  const { rowCount } = await query(
    `UPDATE users SET last_seen_at = now() WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rowCount;
}

/**
 * Кому видно онлайн-стан користувача: співрозмовники по всіх його діалогах
 * плюс контакти в обидва боки.
 *
 * Свідомо НЕ io.emit на всіх: в застосунку є анонімний режим, і глобальна
 * розсилка «хто зараз онлайн» зливала б присутність будь-якого користувача
 * кожному підключеному. Список обмежений тими, хто й так бачить цю людину
 * у своєму інтерфейсі.
 */
export async function getPresenceAudience(userId) {
  const { rows } = await query(
    `SELECT DISTINCT partner.user_id AS id
       FROM conversation_participants me
       JOIN conversation_participants partner
         ON partner.conversation_id = me.conversation_id
        AND partner.user_id <> me.user_id
      WHERE me.user_id = $1
      UNION
     SELECT contact_user_id FROM contacts WHERE user_id = $1
      UNION
     SELECT user_id FROM contacts WHERE contact_user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.id);
}

/**
 * Розсилає presence:update усім, кому видно цей стан.
 *
 * isCurrent — необов'язковий предикат, який перевіряється безпосередньо перед
 * відправкою. Потрібен через гонку: поки виконується запит до БД, користувач
 * міг перепідключитися, і тоді подія «офлайн» прийшла б клієнтам після «онлайн»,
 * залишивши всіх зі старим станом.
 *
 * Помилки не пробиваються нагору: збій розсилки не має ламати обробку
 * підключення чи відключення сокета.
 */
export async function broadcastPresence(
  io,
  userId,
  { isOnline: online, lastSeenAt },
  isCurrent = null,
) {
  try {
    const audience = await getPresenceAudience(userId);
    if (isCurrent && !isCurrent()) return;
    if (audience.length === 0) return;

    io.to(audience.map((id) => `user:${id}`)).emit('presence:update', {
      userId,
      isOnline: online,
      lastSeenAt: online ? null : lastSeenAt,
    });
  } catch (err) {
    console.error('presence broadcast error:', err);
  }
}

/** Скидає стан між тестами (у процесі живе один екземпляр модуля). */
export function _resetStateForTesting() {
  socketsByUser.clear();
}
