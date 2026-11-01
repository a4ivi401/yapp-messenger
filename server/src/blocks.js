import { pool } from './db.js';

export const REPORT_REASONS = ['spam', 'abuse', 'inappropriate', 'other'];

/**
 * Блокує користувача: створює спрямований зв'язок (blockerId -> blockedId).
 * Ідемпотентна дія (ON CONFLICT DO NOTHING).
 */
export function blockUser(blockerId, blockedId) {
  if (!blockerId || !blockedId || blockerId === blockedId) {
    return Promise.resolve(null);
  }

  return pool
    .query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING
       RETURNING blocker_id AS "blockerId", blocked_id AS "blockedId", created_at AS "createdAt"`,
      [blockerId, blockedId],
    )
    .then((res) => {
      if (res.rows.length === 0) {
        return { blockerId, blockedId, created: false };
      }
      return { ...res.rows[0], created: true };
    });
}

/**
 * Розблоковує користувача (видаляє запис блокування).
 */
export function unblockUser(blockerId, blockedId) {
  if (!blockerId || !blockedId) {
    return Promise.resolve({ unblocked: false });
  }

  return pool
    .query(
      `DELETE FROM user_blocks
       WHERE blocker_id = $1 AND blocked_id = $2
       RETURNING blocker_id, blocked_id`,
      [blockerId, blockedId],
    )
    .then((res) => ({ unblocked: res.rowCount > 0 }));
}

/**
 * Перевіряє, чи заблокована взаємодія між двома користувачами в будь-який бік
 * (A заблокував B АБО B заблокував A).
 */
export function isBlockedPair(userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) {
    return Promise.resolve(false);
  }

  return pool
    .query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
       LIMIT 1`,
      [userIdA, userIdB],
    )
    .then((res) => res.rows.length > 0);
}

/**
 * Отримує список ідентифікаторів користувачів, з якими заблокована взаємодія
 * (користувач заблокував їх АБО вони заблокували його).
 */
export function getBlockedUserIds(userId) {
  if (!userId) {
    return Promise.resolve([]);
  }

  return pool
    .query(
      `SELECT DISTINCT CASE
         WHEN blocker_id = $1 THEN blocked_id
         ELSE blocker_id
       END AS user_id
       FROM user_blocks
       WHERE blocker_id = $1 OR blocked_id = $1`,
      [userId],
    )
    .then((res) => res.rows.map((r) => r.user_id));
}

/**
 * Створює скаргу (report) на користувача.
 *
 * @param {string} reporterId - UUID скаржника
 * @param {string} reportedId - UUID користувача, на якого скаржаться
 * @param {string} reason - причина ('spam' | 'abuse' | 'inappropriate' | 'other')
 * @param {string} [details] - додатковий коментар
 */
export function createReport(reporterId, reportedId, reason, details = '') {
  if (!reporterId || !reportedId || reporterId === reportedId) {
    return Promise.resolve(null);
  }
  if (!REPORT_REASONS.includes(reason)) {
    return Promise.reject(new Error('Неприпустима причина скарги'));
  }

  return pool
    .query(
      `INSERT INTO reports (reporter_id, reported_id, reason, details)
       VALUES ($1, $2, $3, $4)
       RETURNING id, reporter_id AS "reporterId", reported_id AS "reportedId",
                 reason, details, created_at AS "createdAt"`,
      [reporterId, reportedId, reason, String(details || '').slice(0, 1000)],
    )
    .then((res) => res.rows[0] || null);
}

/**
 * Отримує всі скарги на користувача (для тестів та перевірки).
 */
export function listReportsForUser(reportedId) {
  if (!reportedId) return Promise.resolve([]);

  return pool
    .query(
      `SELECT id, reporter_id AS "reporterId", reported_id AS "reportedId",
              reason, details, created_at AS "createdAt"
       FROM reports
       WHERE reported_id = $1
       ORDER BY created_at DESC`,
      [reportedId],
    )
    .then((res) => res.rows);
}
