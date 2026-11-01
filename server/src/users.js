import { query } from './db.js';
import { isOnline } from './presence.js';
import { isBlockedPair } from './blocks.js';
import { hasMatchWith } from './matches.js';

/**
 * Отримує детальний профіль користувача для перегляду співрозмовником або власником.
 *
 * @param {string} currentUserId - ID авторизованого користувача
 * @param {string} targetUserId - ID цільового користувача
 * @returns {Promise<object|null>}
 */
export async function getUserProfile(currentUserId, targetUserId) {
  if (!targetUserId) return null;

  const { rows } = await query(
    `SELECT id, username, display_name, avatar_url, bio, created_at, last_seen_at
       FROM users
      WHERE id = $1`,
    [targetUserId],
  );

  const targetUser = rows[0];
  if (!targetUser) return null;

  const isMe = currentUserId === targetUserId;

  let isContact = false;
  let isBlocked = false;
  let hasMatch = false;

  if (!isMe) {
    // Перевірка наявності в контактах
    const { rows: contactRows } = await query(
      `SELECT 1 FROM contacts WHERE user_id = $1 AND contact_user_id = $2`,
      [currentUserId, targetUserId],
    );
    isContact = contactRows.length > 0;

    // Перевірка взаємного блокування
    isBlocked = await isBlockedPair(currentUserId, targetUserId);

    // Перевірка взаємного метчу
    hasMatch = await hasMatchWith(currentUserId, targetUserId);
  }

  return {
    id: targetUser.id,
    username: targetUser.username,
    displayName: targetUser.display_name || null,
    avatarUrl: targetUser.avatar_url || null,
    bio: targetUser.bio || null,
    createdAt: targetUser.created_at,
    lastSeenAt: targetUser.last_seen_at || null,
    isOnline: isOnline(targetUser.id),
    isContact,
    isBlocked,
    hasMatch,
    isMe,
  };
}

/**
 * Оновлює профіль користувача (нікнейм, ім'я, аватарка, біографія).
 *
 * @param {string} userId - ID користувача
 * @param {object} updates - { username?, displayName?, avatarUrl?, bio? }
 * @returns {Promise<object>}
 */
export async function updateUserProfile(userId, updates = {}) {
  const { username, displayName, avatarUrl, bio } = updates;

  // Якщо змінюється нікнейм, перевіряємо унікальність без урахування регістру
  if (username !== undefined) {
    const cleanUsername = username.trim().replace(/^@+/, '');
    const { rows: existing } = await query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2`,
      [cleanUsername, userId],
    );
    if (existing.length > 0) {
      const err = new Error('Це імʼя вже зайняте');
      err.code = 'USERNAME_TAKEN';
      throw err;
    }
  }

  const fields = [];
  const values = [userId];
  let idx = 2;

  if (username !== undefined) {
    fields.push(`username = $${idx++}`);
    values.push(username.trim().replace(/^@+/, ''));
  }

  if (displayName !== undefined) {
    fields.push(`display_name = $${idx++}`);
    values.push(displayName ? displayName.trim() : null);
  }

  if (avatarUrl !== undefined) {
    fields.push(`avatar_url = $${idx++}`);
    values.push(avatarUrl ? avatarUrl.trim() : null);
  }

  if (bio !== undefined) {
    fields.push(`bio = $${idx++}`);
    values.push(bio ? bio.trim() : null);
  }

  if (fields.length === 0) {
    const profile = await getUserProfile(userId, userId);
    return profile;
  }

  const { rows } = await query(
    `UPDATE users
        SET ${fields.join(', ')}
      WHERE id = $1
     RETURNING id, username, display_name, avatar_url, bio, created_at, last_seen_at`,
    values,
  );

  const updated = rows[0];
  return {
    id: updated.id,
    username: updated.username,
    displayName: updated.display_name || null,
    avatarUrl: updated.avatar_url || null,
    bio: updated.bio || null,
    createdAt: updated.created_at,
    lastSeenAt: updated.last_seen_at || null,
  };
}
