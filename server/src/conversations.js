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
    // Персистентні непрочитані: вхідні, старіші за власний watermark «прочитано»
    // (NULL = ще нічого не читали — рахуємо всі вхідні). Скидаються через conversation:read.
    unreadCount: Number(row.unread_count || 0),
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
          // Tombstone-прев'ю: клієнт покаже «Повідомлення видалено»
          deleted: row.last_message_deleted_at != null,
          attachment: row.last_message_attachment_url && row.last_message_deleted_at == null
            ? {
                url: row.last_message_attachment_url,
                type: row.last_message_attachment_type,
                name: row.last_message_attachment_name,
                size: row.last_message_attachment_size,
                mime: row.last_message_attachment_mime,
              }
            : null,
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
       my_p.last_read_at         AS my_last_read_at,
       (SELECT COUNT(*)
          FROM messages um
         WHERE um.conversation_id = c.id
           AND um.sender_id <> my_p.user_id
           AND (my_p.last_read_at IS NULL OR um.created_at > my_p.last_read_at)
       ) AS unread_count,
       lm.id            AS last_message_id,
       lm.body          AS last_message_body,
       lm.sender_id     AS last_message_sender_id,
       lm.created_at    AS last_message_created_at,
       lm.attachment_url  AS last_message_attachment_url,
       lm.attachment_type AS last_message_attachment_type,
       lm.attachment_name AS last_message_attachment_name,
       lm.attachment_size AS last_message_attachment_size,
       lm.attachment_mime AS last_message_attachment_mime,
       lm.deleted_at      AS last_message_deleted_at
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
       SELECT msg.id, msg.body, msg.sender_id, msg.created_at, msg.deleted_at,
              msg.attachment_url, msg.attachment_type, msg.attachment_name,
              msg.attachment_size, msg.attachment_mime
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
       my_p.last_read_at         AS my_last_read_at,
       (SELECT COUNT(*)
          FROM messages um
         WHERE um.conversation_id = c.id
           AND um.sender_id <> my_p.user_id
           AND (my_p.last_read_at IS NULL OR um.created_at > my_p.last_read_at)
       ) AS unread_count,
       lm.id            AS last_message_id,
       lm.body          AS last_message_body,
       lm.sender_id     AS last_message_sender_id,
       lm.created_at    AS last_message_created_at,
       lm.attachment_url  AS last_message_attachment_url,
       lm.attachment_type AS last_message_attachment_type,
       lm.attachment_name AS last_message_attachment_name,
       lm.attachment_size AS last_message_attachment_size,
       lm.attachment_mime AS last_message_attachment_mime,
       lm.deleted_at      AS last_message_deleted_at
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
       SELECT msg.id, msg.body, msg.sender_id, msg.created_at, msg.deleted_at,
              msg.attachment_url, msg.attachment_type, msg.attachment_name,
              msg.attachment_size, msg.attachment_mime
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
    body: row.body || '',
    createdAt: row.created_at,
    // Мітка «редаговано» біля часу (null = не редагували)
    editedAt: row.edited_at || null,
    // Tombstone: тіло й вкладення очищені на сервері, клієнт показує «Повідомлення видалено»
    deleted: row.deleted_at != null,
    attachment: row.attachment_url && row.deleted_at == null
      ? {
          url: row.attachment_url,
          type: row.attachment_type,
          name: row.attachment_name,
          size: row.attachment_size,
          mime: row.attachment_mime,
        }
      : null,
    // Агрегат { emoji: { count, userIds } }: наповнюється attachReactions для сторінок,
    // для нових message:send — початково порожній
    reactions: formatReactionRows(row.reaction_rows),
  };
}

/**
 * Швидкий набір реакцій контекстного меню. Оскільки там лише емодзі-рядок,
 * сервер валідує payload за цим фіксованим списком.
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/**
 * Збирає рядки message_reactions в агрегат { emoji: { count, userIds } }.
 * Хіпси під бульбашкою показують кількість і підсвічують власну реакцію за userIds.
 */
function formatReactionRows(rows) {
  const aggregate = {};
  for (const row of rows || []) {
    const { emoji, user_id: userId } = row;
    if (!aggregate[emoji]) {
      aggregate[emoji] = { count: 0, userIds: [] };
    }
    aggregate[emoji].count += 1;
    aggregate[emoji].userIds.push(userId);
  }
  return aggregate;
}

/**
 * Дозавантажує агрегат реакцій для сторінки повідомлень: один IN-запит
 * на всі id сторінки дешевший за LATERAL-join на кожен рядок.
 */
async function attachReactions(pageRows) {
  if (pageRows.length === 0) return;

  const pageIds = pageRows.map((row) => row.id);
  const { rows } = await query(
    `SELECT message_id, user_id, emoji
       FROM message_reactions
      WHERE message_id = ANY($1::uuid[])`,
    [pageIds],
  );

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.message_id)) grouped.set(row.message_id, []);
    grouped.get(row.message_id).push(row);
  }

  for (const row of pageRows) {
    row.reaction_rows = grouped.get(row.id) || [];
  }
}

/**
 * Повертає для повідомлення { conversationId, reactions } — учасник перевіряється
 * через conversation_participants в умові WHERE, тож перебір чужих messageId
 * неможливий. null = повідомлення не існує або я не учасник діалогу.
 */
async function getMessageWithReactions(messageId, userId) {
  const { rows } = await query(
    `SELECT m.conversation_id, r.emoji, r.user_id
       FROM messages m
       JOIN conversation_participants p
         ON p.conversation_id = m.conversation_id AND p.user_id = $2
       LEFT JOIN message_reactions r ON r.message_id = m.id
      WHERE m.id = $1`,
    [messageId, userId],
  );
  if (rows.length === 0) return null;
  return {
    conversationId: rows[0].conversation_id,
    reactions: formatReactionRows(rows),
  };
}

/**
 * Ставить / прибирає реакцію користувача на повідомлення (toggle).
 * Одна реакція на юзера на повідомлення: те саме емодзі — знімає, інше — замінює.
 * emoji === null означає «зняти реакцію».
 * Повертає { conversationId, reactions } або null, якщо зміни не було
 * (повторний клік того ж емодзі / зняття відсутньої реакції / немає прав).
 */
export async function setMessageReaction(messageId, userId, emoji) {
  // Політика приватності: перевірка учасника — в умові INSERT/WHERE,
  // тож перебір чужих messageId не змінює чужі дані та повертає null.
  const participantCondition = `
    EXISTS (
      SELECT 1
        FROM messages m
        JOIN conversation_participants p
          ON p.conversation_id = m.conversation_id AND p.user_id = $2
       WHERE m.id = $1
    )`;

  if (emoji) {
    const { rows: changed } = await query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       SELECT $1, $2, $3
        WHERE ${participantCondition}
      ON CONFLICT (message_id, user_id)
           DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()
           WHERE message_reactions.emoji <> EXCLUDED.emoji
       RETURNING message_id`,
      [messageId, userId, emoji],
    );
    if (changed.length === 0) return null;
  } else {
    const { rows: removed } = await query(
      `DELETE FROM message_reactions
        WHERE message_id = $1 AND user_id = $2 AND ${participantCondition}
       RETURNING message_id`,
      [messageId, userId],
    );
    if (removed.length === 0) return null;
  }

  return getMessageWithReactions(messageId, userId);
}

/**
 * Редагує власне текстове повідомлення (лише відправник, лише не tombstone).
 * Повертає свіжий об'єкт повідомлення (з edited_at) або null.
 */
export async function editMessage(messageId, userId, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE messages
          SET body = $3, edited_at = now(), deleted_at = NULL
        WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
        RETURNING id, conversation_id, sender_id, body, created_at, edited_at, deleted_at,
                  attachment_url, attachment_type, attachment_name, attachment_size, attachment_mime,
                  (SELECT username FROM users WHERE id = messages.sender_id) AS sender_username`,
      [messageId, userId, body],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    // Свіжий агрегат реакцій у тій самій транзакції: editMessage повертає повний
    // об'єкт повідомлення, тож broadcast message:updated не обнуляє чіпси реакцій.
    const { rows: reactionRows } = await client.query(
      `SELECT emoji, user_id FROM message_reactions WHERE message_id = $1`,
      [messageId],
    );
    await client.query('COMMIT');

    const message = rows[0];
    message.reaction_rows = reactionRows;
    return formatMessageRow(message);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tombstone-видалення власного повідомлення: очищає тіло й вкладення, ставить
 * deleted_at. Реакції прибирає в тій самій транзакції. Розсильний (сокет) далі
 * сам покаже tombstone клієнтам. Повертає { conversationId } або null.
 */
export async function deleteMessage(messageId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE messages
          SET deleted_at = now(), body = '', edited_at = NULL,
              attachment_url = NULL, attachment_type = NULL, attachment_name = NULL,
              attachment_size = NULL, attachment_mime = NULL
        WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
        RETURNING conversation_id`,
      [messageId, userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    // Реакції на tombstone не мають сенсу — прибираємо атомарно з видаленням
    await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);

    await client.query('COMMIT');
    return { conversationId: rows[0].conversation_id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Пошук по тілах повідомлень у всіх діалогах користувача (tombstone не шукаємо).
 * Підрядок, як і пошук людей: %/_ екрановані, щоб `%` у запиті не став wildcard.
 * Повертає [{ message, otherUsername }] — клієнт за другим кликом відкриє діалог.
 */
export async function searchMessages(userId, queryStr, { limit = 20 } = {}) {
  const escaped = queryStr.replace(/[\\%_]/g, '\\$&');
  const { rows } = await query(
    `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at, m.edited_at,
            u.username AS sender_username,
            other_u.username AS other_username
       FROM messages m
       JOIN conversation_participants my_p
         ON my_p.conversation_id = m.conversation_id AND my_p.user_id = $1
       JOIN conversation_participants other_p
         ON other_p.conversation_id = m.conversation_id AND other_p.user_id <> $1
       JOIN users other_u ON other_u.id = other_p.user_id
       JOIN users u ON u.id = m.sender_id
      WHERE m.deleted_at IS NULL
        AND length(trim(COALESCE(m.body, ''))) > 0
        AND m.body ILIKE '%' || $2 || '%' ESCAPE '\\'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [userId, escaped, limit],
  );

  return rows.map((row) => ({
    message: {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderUsername: row.sender_username,
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
    },
    otherUsername: row.other_username,
    senderId: row.sender_id,
  }));
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
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at,
              m.edited_at, m.deleted_at,
              m.attachment_url, m.attachment_type, m.attachment_name,
              m.attachment_size, m.attachment_mime,
              u.username AS sender_username
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
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at,
              m.edited_at, m.deleted_at,
              m.attachment_url, m.attachment_type, m.attachment_name,
              m.attachment_size, m.attachment_mime,
              u.username AS sender_username
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

  // Реакції сторінки одним агрегатним запитом (за id, порядок не важливий)
  await attachReactions(pageRows);

  // Реверсимо в хронологічний порядок (найстаріші перші), зручно для клієнта
  pageRows.reverse();

  return {
    messages: pageRows.map(formatMessageRow),
    hasMore,
  };
}

/**
 * Вікно повідомлень навколо цільового (перехід до повідомлення зі пошуку).
 * Повертає до `context` повідомлень перед цільовим та після нього
 * (хронологічно ASC), щоб ціль гарантовано потрапила у список клієнта,
 * і прапорці, чи є історія поза вікном. null — цільового не існує або
 * я не учасник діалогу (перевірка учасника в самому запиті цільового).
 */
export async function listMessagesAround(conversationId, messageId, userId, { context = 12 } = {}) {
  const pageSelect = `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at,
              m.edited_at, m.deleted_at,
              m.attachment_url, m.attachment_type, m.attachment_name,
              m.attachment_size, m.attachment_mime,
              u.username AS sender_username
         FROM messages m
         JOIN users u ON u.id = m.sender_id`;

  const { rows: targetRows } = await query(
    `${pageSelect}
      WHERE m.id = $1 AND m.conversation_id = $2
        AND EXISTS (
          SELECT 1 FROM conversation_participants p
           WHERE p.conversation_id = m.conversation_id AND p.user_id = $3
        )`,
    [messageId, conversationId, userId],
  );
  if (targetRows.length === 0) return null;
  const target = targetRows[0];

  // created_at курсора розвʼязуємо ВСЕРЕДИНІ SQL підзапитом: node-pg віддає
  // timestamptz як JS Date з точністю до мс, а в БД значення мікросекундне —
  // параметр, що повернувся через JS, «зсуває» ціль у сусідні сторінки
  // (обидва запити включали ціль у вибірку, що давало дублікат у списку).
  const [beforeRes, afterRes] = await Promise.all([
    query(
      `${pageSelect}
        WHERE m.conversation_id = $1
          AND (m.created_at, m.id) < ((SELECT created_at FROM messages WHERE id = $2::uuid), $2::uuid)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $3`,
      [conversationId, messageId, context + 1],
    ),
    query(
      `${pageSelect}
        WHERE m.conversation_id = $1
          AND (m.created_at, m.id) > ((SELECT created_at FROM messages WHERE id = $2::uuid), $2::uuid)
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $3`,
      [conversationId, messageId, context + 1],
    ),
  ]);

  const hasMoreBefore = beforeRes.rows.length > context;
  const hasMoreAfter = afterRes.rows.length > context;
  const beforeRows = beforeRes.rows.slice(0, context);
  const afterRows = afterRes.rows.slice(0, context);

  // Хронологія: старі → цільове → нові
  const pageRows = [...beforeRows].reverse().concat([target], afterRows);
  await attachReactions(pageRows);

  return {
    messages: pageRows.map(formatMessageRow),
    hasMoreBefore,
    hasMoreAfter,
  };
}

/**
 * Створює нове повідомлення в діалозі.
 */
export async function createMessage(conversationId, senderId, body, attachment = null) {
  const attachmentUrl = attachment?.url || null;
  const attachmentType = attachment?.type || null;
  const attachmentName = attachment?.name || null;
  const attachmentSize =
    attachment?.size !== undefined && attachment?.size !== null
      ? Number(attachment.size)
      : null;
  const attachmentMime = attachment?.mime || null;

  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO messages (
         conversation_id, sender_id, body,
         attachment_url, attachment_type, attachment_name, attachment_size, attachment_mime
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, conversation_id, sender_id, body,
                 attachment_url, attachment_type, attachment_name, attachment_size, attachment_mime,
                 created_at
     )
     SELECT ins.id, ins.conversation_id, ins.sender_id, ins.body,
            ins.attachment_url, ins.attachment_type, ins.attachment_name, ins.attachment_size, ins.attachment_mime,
            ins.created_at, u.username AS sender_username
       FROM inserted ins
       JOIN users u ON u.id = ins.sender_id`,
    [
      conversationId,
      senderId,
      body || '',
      attachmentUrl,
      attachmentType,
      attachmentName,
      attachmentSize,
      attachmentMime,
    ],
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
