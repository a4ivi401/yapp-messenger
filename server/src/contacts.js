import { query } from './db.js';
import { isOnline } from './presence.js';

/**
 * Отримує список контактів користувача (відсортований за алфавітом).
 */
export async function listContactsForUser(userId) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.last_seen_at, c.created_at AS added_at
       FROM contacts c
       JOIN users u ON u.id = c.contact_user_id
      WHERE c.user_id = $1
      ORDER BY u.username ASC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    isOnline: isOnline(r.id),
    lastSeenAt: r.last_seen_at || null,
    addedAt: r.added_at,
  }));
}

/**
 * Додає контакт користувачу.
 * Повертає { contact: { id, username, addedAt }, added: boolean }.
 */
export async function addContact(userId, targetUserId) {
  if (userId === targetUserId) {
    const err = new Error('Не можна додати самого себе в контакти');
    err.code = 'SELF_CONTACT';
    throw err;
  }

  // Отримуємо цільового користувача
  const { rows: userRows } = await query(
    `SELECT id, username FROM users WHERE id = $1`,
    [targetUserId],
  );
  const targetUser = userRows[0];
  if (!targetUser) {
    const err = new Error('Користувача не знайдено');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const { rows: insertRows } = await query(
    `INSERT INTO contacts (user_id, contact_user_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, contact_user_id) DO NOTHING
     RETURNING created_at`,
    [userId, targetUserId],
  );

  const added = insertRows.length > 0;
  let addedAt = insertRows[0]?.created_at;

  if (!added) {
    // Якщо вже був у контактах, дізнаємося дату первинного додавання
    const { rows: existingRows } = await query(
      `SELECT created_at FROM contacts WHERE user_id = $1 AND contact_user_id = $2`,
      [userId, targetUserId],
    );
    addedAt = existingRows[0]?.created_at;
  }

  return {
    contact: {
      id: targetUser.id,
      username: targetUser.username,
      addedAt,
    },
    added,
  };
}

/**
 * Видаляє контакт у користувача.
 * Повертає true, якщо контакт було видалено, інакше false.
 */
export async function removeContact(userId, targetUserId) {
  const { rows } = await query(
    `DELETE FROM contacts
      WHERE user_id = $1 AND contact_user_id = $2
     RETURNING contact_user_id`,
    [userId, targetUserId],
  );
  return rows.length > 0;
}

/**
 * Перевіряє, чи є цільовий користувач у списку контактів.
 */
export async function isContact(userId, targetUserId) {
  const { rows } = await query(
    `SELECT 1 FROM contacts WHERE user_id = $1 AND contact_user_id = $2`,
    [userId, targetUserId],
  );
  return rows.length > 0;
}

/**
 * Рахує загальну кількість контактів користувача.
 */
export async function countContactsForUser(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM contacts WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.count ?? 0;
}

/**
 * Глобальний пошук користувачів за нікнеймом.
 * Виключає поточного користувача.
 * Повертає { id, username, isContact: boolean }, відсортовані за точністю збігу.
 */
export async function searchUsers(currentUserId, queryStr, { limit = 20 } = {}) {
  const trimmed = (queryStr || '').trim().replace(/^@+/, '');
  if (!trimmed) return [];

  // Екранування спецсимволів LIKE (% та _)
  const escaped = trimmed.replace(/[%_\\]/g, '\\$&');

  const { rows } = await query(
    `SELECT
       u.id,
       u.username,
       u.last_seen_at,
       EXISTS (
         SELECT 1 FROM contacts c
          WHERE c.user_id = $1 AND c.contact_user_id = u.id
       ) AS is_contact
     FROM users u
     WHERE u.id <> $1
       AND u.username ILIKE '%' || $2 || '%' ESCAPE '\\'
     ORDER BY
       CASE
         WHEN LOWER(u.username) = LOWER($3) THEN 0
         WHEN LOWER(u.username) LIKE LOWER($3) || '%' THEN 1
         ELSE 2
       END,
       u.username ASC
     LIMIT $4`,
    [currentUserId, escaped, trimmed, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    isContact: Boolean(r.is_contact),
    isOnline: isOnline(r.id),
    lastSeenAt: r.last_seen_at || null,
  }));
}
