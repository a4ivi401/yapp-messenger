import { pool, query } from './db.js';
import { isOnline } from './presence.js';

/**
 * Перевіряє, чи є користувач учасником діалогу.
 */
export async function isParticipant(conversationId, userId) {
  const { rows } = await query(
    `SELECT 1 FROM conversation_participants
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

/**
 * Шукає прямий 1-на-1 діалог між двома користувачами.
 * Повертає id або null.
 */
export async function findDirectConversationId(userAId, userBId) {
  const { rows } = await query(
    `SELECT c.id
       FROM conversations c
       JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = $1
       JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = $2
      WHERE c.type = 'direct'
      LIMIT 1`,
    [userAId, userBId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Знаходить існуючий прямий діалог або атомарно створює новий у транзакції.
 * Повертає { id, created: boolean }.
 */
export async function findOrCreateDirectConversation(userAId, userBId) {
  const existingId = await findDirectConversationId(userAId, userBId);
  if (existingId) {
    return { id: existingId, created: false };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Повторна перевірка всередині транзакції для захисту від race condition
    const { rows: recheck } = await client.query(
      `SELECT c.id
         FROM conversations c
         JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = $1
         JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = $2
        WHERE c.type = 'direct'
        LIMIT 1`,
      [userAId, userBId],
    );
    if (recheck.length > 0) {
      await client.query('COMMIT');
      return { id: recheck[0].id, created: false };
    }

    const { rows: convRows } = await client.query(
      `INSERT INTO conversations (type) VALUES ('direct') RETURNING id`,
    );
    const convId = convRows[0].id;

    await client.query(
      `INSERT INTO conversation_participants (conversation_id, user_id)
       VALUES ($1, $2), ($1, $3)`,
      [convId, userAId, userBId],
    );

    await client.query('COMMIT');
    return { id: convId, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Отримує id усіх учасників діалогу.
 */
export async function getConversationParticipantIds(conversationId) {
  const { rows } = await query(
    `SELECT user_id FROM conversation_participants WHERE conversation_id = $1`,
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

function formatConversationRow(row) {
  return {
    id: row.id,
    type: row.type,
    createdAt: row.created_at,
    isMatch: Boolean(row.match_id),
    matchedAt: row.matched_at || null,
    otherUser: {
      id: row.other_user_id,
      username: row.other_username,
      // Онлайн-стан береться з пам'яті процесу (живі сокети), а не з БД —
      // тому він завжди актуальний на момент відповіді
      isOnline: isOnline(row.other_user_id),
      lastSeenAt: row.other_last_seen_at || null,
      // Watermark-и співрозмовника: за ними клієнт виводить статус власних повідомлень
      lastDeliveredAt: row.other_last_delivered_at || null,
      lastReadAt: row.other_last_read_at || null,
    },
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          body: row.last_message_body,
          senderId: row.last_message_sender_id,
          createdAt: row.last_message_created_at,
        }
      : null,
  };
}

/**
 * Отримує один діалог за id для конкретного користувача (якщо він учасник).
 * Повертає серіалізований об'єкт або null.
 */
export async function getConversationForUser(conversationId, userId) {
  const { rows } = await query(
    `SELECT
       c.id,
       c.type,
       c.created_at,
       m.id             AS match_id,
       m.created_at     AS matched_at,
       other_u.id       AS other_user_id,
       other_u.username AS other_username,
       other_u.last_seen_at AS other_last_seen_at,
       other_p.last_delivered_at AS other_last_delivered_at,
       other_p.last_read_at      AS other_last_read_at,
       lm.id            AS last_message_id,
       lm.body          AS last_message_body,
       lm.sender_id     AS last_message_sender_id,
       lm.created_at    AS last_message_created_at
     FROM conversations c
     JOIN conversation_participants my_p
       ON my_p.conversation_id = c.id AND my_p.user_id = $2
     JOIN conversation_participants other_p
       ON other_p.conversation_id = c.id AND other_p.user_id <> $2
     JOIN users other_u
       ON other_u.id = other_p.user_id
     LEFT JOIN matches m
       ON m.conversation_id = c.id
     LEFT JOIN LATERAL (
       SELECT msg.id, msg.body, msg.sender_id, msg.created_at
         FROM messages msg
        WHERE msg.conversation_id = c.id
        ORDER BY msg.created_at DESC, msg.id DESC
        LIMIT 1
     ) lm ON true
    WHERE c.id = $1`,
    [conversationId, userId],
  );

  return rows[0] ? formatConversationRow(rows[0]) : null;
}

/**
 * Список усіх діалогів користувача, відсортований за останнім повідомленням
 * (або за датою створення діалогу, якщо повідомлень ще немає).
 */
export async function listConversationsForUser(userId) {
  const { rows } = await query(
    `SELECT
       c.id,
       c.type,
       c.created_at,
       m.id             AS match_id,
       m.created_at     AS matched_at,
       other_u.id       AS other_user_id,
       other_u.username AS other_username,
       other_u.last_seen_at AS other_last_seen_at,
       other_p.last_delivered_at AS other_last_delivered_at,
       other_p.last_read_at      AS other_last_read_at,
       lm.id            AS last_message_id,
       lm.body          AS last_message_body,
       lm.sender_id     AS last_message_sender_id,
       lm.created_at    AS last_message_created_at
     FROM conversations c
     JOIN conversation_participants my_p
       ON my_p.conversation_id = c.id AND my_p.user_id = $1
     JOIN conversation_participants other_p
       ON other_p.conversation_id = c.id AND other_p.user_id <> $1
     JOIN users other_u
       ON other_u.id = other_p.user_id
     LEFT JOIN matches m
       ON m.conversation_id = c.id
     LEFT JOIN LATERAL (
       SELECT msg.id, msg.body, msg.sender_id, msg.created_at
         FROM messages msg
        WHERE msg.conversation_id = c.id
        ORDER BY msg.created_at DESC, msg.id DESC
        LIMIT 1
     ) lm ON true
    ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
    [userId],
  );

  return rows.map(formatConversationRow);
}

function formatMessageRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderUsername: row.sender_username ?? null,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * Отримує сторінку повідомлень діалогу.
 * Пагінація через курсор before (id попереднього повідомлення).
 * Повертає { messages: [...в хронологічному порядку (ASC)], hasMore: boolean }.
 */
export async function listMessages(conversationId, { limit = 50, before = null } = {}) {
  let rows;

  if (before) {
    // Резолвимо created_at для курсора, щоб зробити стабільне композитне сортування
    const { rows: cursorRows } = await query(
      `SELECT created_at FROM messages WHERE id = $1 AND conversation_id = $2`,
      [before, conversationId],
    );
    if (cursorRows.length === 0) {
      const err = new Error('Невірний курсор');
      err.code = 'INVALID_CURSOR';
      throw err;
    }
    const cursorCreatedAt = cursorRows[0].created_at;

    const res = await query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at, u.username AS sender_username
         FROM messages m
         JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
          AND (m.created_at, m.id) < ($2, $3)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4`,
      [conversationId, cursorCreatedAt, before, limit + 1],
    );
    rows = res.rows;
  } else {
    const res = await query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at, u.username AS sender_username
         FROM messages m
         JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2`,
      [conversationId, limit + 1],
    );
    rows = res.rows;
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Реверсимо в хронологічний порядок (найстаріші перші), зручно для клієнта
  pageRows.reverse();

  return {
    messages: pageRows.map(formatMessageRow),
    hasMore,
  };
}

/**
 * Створює нове повідомлення в діалозі.
 */
export async function createMessage(conversationId, senderId, body) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, conversation_id, sender_id, body, created_at
     )
     SELECT ins.id, ins.conversation_id, ins.sender_id, ins.body, ins.created_at, u.username AS sender_username
       FROM inserted ins
       JOIN users u ON u.id = ins.sender_id`,
    [conversationId, senderId, body],
  );
  return formatMessageRow(rows[0]);
}

/**
 * Позначає всі вхідні повідомлення діалогу прочитаними для конкретного учасника.
 *
 * Watermark піднімається до часу найновішого чужого повідомлення, тому:
 * - значення монотонне (умова `latest.ts > last_read_at` не дає відкотити його назад);
 * - «прочитано» завжди тягне за собою «доставлено» — окремого стану не існує;
 * - якщо нових вхідних немає, UPDATE не виконується взагалі (0 рядків), тож
 *   клієнт може кликати подію скільки завгодно без write amplification.
 *
 * Повертає { lastReadAt, lastDeliveredAt } або null, якщо змін не було
 * (немає нових вхідних або користувач не є учасником діалогу).
 */
export async function markConversationRead(conversationId, userId) {
  const { rows } = await query(
    `WITH latest AS (
       SELECT max(m.created_at) AS ts
         FROM messages m
        WHERE m.conversation_id = $1 AND m.sender_id <> $2
     )
     UPDATE conversation_participants p
        SET last_read_at      = latest.ts,
            last_delivered_at = GREATEST(COALESCE(p.last_delivered_at, latest.ts), latest.ts)
       FROM latest
      WHERE p.conversation_id = $1
        AND p.user_id = $2
        AND latest.ts IS NOT NULL
        AND latest.ts > COALESCE(p.last_read_at, '-infinity'::timestamptz)
     RETURNING p.last_read_at, p.last_delivered_at`,
    [conversationId, userId],
  );

  if (rows.length === 0) return null;
  return {
    lastReadAt: rows[0].last_read_at,
    lastDeliveredAt: rows[0].last_delivered_at,
  };
}

/**
 * Позначає одне повідомлення доставленим його одержувачу (watermark last_delivered_at).
 * Власні повідомлення та вже покриті watermark'ом ігноруються.
 *
 * Повертає { conversationId, senderId, lastDeliveredAt } або null, якщо
 * оновлювати нічого (повідомлення не існує, воно своє, або вже доставлене).
 */
export async function markMessageDelivered(messageId, userId) {
  const { rows } = await query(
    `UPDATE conversation_participants p
        SET last_delivered_at = m.created_at
       FROM messages m
      WHERE m.id = $1
        AND m.conversation_id = p.conversation_id
        AND p.user_id = $2
        AND m.sender_id <> $2
        AND m.created_at > COALESCE(p.last_delivered_at, '-infinity'::timestamptz)
     RETURNING p.conversation_id, p.last_delivered_at, m.sender_id`,
    [messageId, userId],
  );

  if (rows.length === 0) return null;
  return {
    conversationId: rows[0].conversation_id,
    senderId: rows[0].sender_id,
    lastDeliveredAt: rows[0].last_delivered_at,
  };
}
