import { query } from './db.js';

/**
 * Канонічний порядок пари: менший UUID завжди перший.
 * Це дозволяє тримати унікальний індекс на (user1_id, user2_id)
 * і не записувати один і той самий метч двічі.
 */
function orderPair(userAId, userBId) {
  return userAId < userBId ? [userAId, userBId] : [userBId, userAId];
}

/**
 * Записує взаємний метч. Операція ідемпотентна: повторний виклик для тієї ж
 * пари не створить дубль і не перезапише вже збережений conversation_id.
 *
 * Повертає { match, created } — created=false, якщо метч уже існував.
 */
export async function recordMatch(userAId, userBId, conversationId = null) {
  if (!userAId || !userBId || userAId === userBId) {
    const err = new Error('Некоректна пара користувачів для метчу');
    err.code = 'INVALID_PAIR';
    throw err;
  }

  const [user1Id, user2Id] = orderPair(userAId, userBId);

  const { rows } = await query(
    `INSERT INTO matches (user1_id, user2_id, conversation_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user1_id, user2_id) DO NOTHING
     RETURNING id, user1_id, user2_id, conversation_id, created_at`,
    [user1Id, user2Id, conversationId],
  );

  if (rows.length > 0) {
    return { match: formatMatchRow(rows[0]), created: true };
  }

  const { rows: existingRows } = await query(
    `SELECT id, user1_id, user2_id, conversation_id, created_at
       FROM matches
      WHERE user1_id = $1 AND user2_id = $2`,
    [user1Id, user2Id],
  );

  return { match: formatMatchRow(existingRows[0]), created: false };
}

/**
 * Кількість метчів користувача (для статистики у профілі).
 */
export async function countMatchesForUser(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count
       FROM matches
      WHERE user1_id = $1 OR user2_id = $1`,
    [userId],
  );
  return rows[0]?.count ?? 0;
}

function formatMatchRow(row, partner = null) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    ...(partner
      ? { partner: { id: partner.id, username: partner.username } }
      : {}),
  };
}

/**
 * Історія метчів користувача (найновіші перші) разом із нікнеймом співрозмовника.
 */
export async function listMatchesForUser(userId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT
       m.id,
       m.conversation_id,
       m.created_at,
       u.id       AS partner_id,
       u.username AS partner_username
     FROM matches m
     JOIN users u
       ON u.id = CASE WHEN m.user1_id = $1 THEN m.user2_id ELSE m.user1_id END
    WHERE m.user1_id = $1 OR m.user2_id = $1
    ORDER BY m.created_at DESC
    LIMIT $2`,
    [userId, limit],
  );

  return rows.map((r) =>
    formatMatchRow(r, { id: r.partner_id, username: r.partner_username }),
  );
}

/**
 * Перевіряє, чи вже існує метч між двома користувачами.
 */
export async function hasMatchWith(userAId, userBId) {
  if (userAId === userBId) return false;
  const [user1Id, user2Id] = orderPair(userAId, userBId);
  const { rows } = await query(
    `SELECT 1 FROM matches WHERE user1_id = $1 AND user2_id = $2`,
    [user1Id, user2Id],
  );
  return rows.length > 0;
}

/**
 * Разом: кількість метчів + кількість контактів одним запитом.
 * Використовується у профілі, щоб не робити два окремі HTTP-запити.
 */
export async function getMatchStatsForUser(userId) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM matches
         WHERE user1_id = $1 OR user2_id = $1) AS matches_count,
       (SELECT count(*)::int FROM contacts
         WHERE user_id = $1) AS contacts_count`,
    [userId],
  );
  return {
    matchesCount: rows[0]?.matches_count ?? 0,
    contactsCount: rows[0]?.contacts_count ?? 0,
  };
}
