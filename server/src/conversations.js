import { pool, query } from './db.js';

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
