import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { pool, query } from '../src/db.js';
import { getUserProfile, updateUserProfile } from '../src/users.js';
import { addContact } from '../src/contacts.js';
import { blockUser } from '../src/blocks.js';
import { setupZodLocalization, ukrainianErrorMap } from '../src/zodErrors.js';

test('users.js domain & zod localization tests', async (t) => {
  setupZodLocalization();

  await t.test('zod localization: transforms validation errors into Ukrainian', () => {
    const testSchema = z.object({
      username: z.string().min(3).max(20),
      id: z.string().uuid(),
    });

    const emptyRes = testSchema.safeParse({});
    assert.equal(emptyRes.success, false);
    assert.equal(emptyRes.error.issues[0].message, 'Поле є обовʼязковим');

    const shortRes = testSchema.safeParse({ username: 'ab', id: 'not-a-uuid' });
    assert.equal(shortRes.success, false);
    assert.equal(shortRes.error.issues[0].message, 'Мінімум 3 симв.');
    assert.equal(shortRes.error.issues[1].message, 'Некоректний формат ідентифікатора (UUID)');

    const longRes = testSchema.safeParse({ username: 'a'.repeat(25), id: '123e4567-e89b-12d3-a456-426614174000' });
    assert.equal(longRes.success, false);
    assert.equal(longRes.error.issues[0].message, 'Максимум 20 симв.');
  });

  let dbAvailable = false;
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('PostgreSQL is unavailable, skipping database tests:', err.message);
  }

  if (!dbAvailable) {
    return;
  }

  const suffix = Date.now().toString(36);
  const u1Name = `prof_a_${suffix}`;
  const u2Name = `prof_b_${suffix}`;
  const u3Name = `prof_c_${suffix}`;

  let userAId, userBId, userCId;

  await t.test('setup: create test users with clean profiles', async () => {
    const r1 = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'hash1') RETURNING id`,
      [u1Name],
    );
    userAId = r1.rows[0].id;

    const r2 = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'hash2') RETURNING id`,
      [u2Name],
    );
    userBId = r2.rows[0].id;

    const r3 = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'hash3') RETURNING id`,
      [u3Name],
    );
    userCId = r3.rows[0].id;
  });

  await t.test('getUserProfile: reads initial null profile fields and relationship flags', async () => {
    const profileA = await getUserProfile(userAId, userAId);
    assert.ok(profileA);
    assert.equal(profileA.id, userAId);
    assert.equal(profileA.username, u1Name);
    assert.equal(profileA.displayName, null);
    assert.equal(profileA.avatarUrl, null);
    assert.equal(profileA.bio, null);
    assert.equal(profileA.isMe, true);
    assert.equal(profileA.isContact, false);
    assert.equal(profileA.isBlocked, false);

    const profileBFromA = await getUserProfile(userAId, userBId);
    assert.ok(profileBFromA);
    assert.equal(profileBFromA.id, userBId);
    assert.equal(profileBFromA.isMe, false);
    assert.equal(profileBFromA.isContact, false);
    assert.equal(profileBFromA.isBlocked, false);
  });

  await t.test('updateUserProfile: sets display name, avatar url, and bio', async () => {
    const updated = await updateUserProfile(userAId, {
      displayName: 'Олексій Тестовий',
      avatarUrl: '/api/uploads/files/avatar-123.jpg',
      bio: 'Привіт! Я тестую профіль у Yapp.',
    });

    assert.equal(updated.id, userAId);
    assert.equal(updated.displayName, 'Олексій Тестовий');
    assert.equal(updated.avatarUrl, '/api/uploads/files/avatar-123.jpg');
    assert.equal(updated.bio, 'Привіт! Я тестую профіль у Yapp.');

    // Перевіряємо персистентність через getUserProfile
    const profile = await getUserProfile(userBId, userAId);
    assert.equal(profile.displayName, 'Олексій Тестовий');
    assert.equal(profile.avatarUrl, '/api/uploads/files/avatar-123.jpg');
    assert.equal(profile.bio, 'Привіт! Я тестую профіль у Yapp.');
  });

  await t.test('updateUserProfile: changes username cleanly', async () => {
    const newUsername = `${u1Name}_new`;
    const updated = await updateUserProfile(userAId, {
      username: newUsername,
    });
    assert.equal(updated.username, newUsername);

    const profile = await getUserProfile(userAId, userAId);
    assert.equal(profile.username, newUsername);
  });

  await t.test('updateUserProfile: rejects username collision with USERNAME_TAKEN', async () => {
    await assert.rejects(
      () => updateUserProfile(userAId, { username: u2Name }),
      (err) => err.code === 'USERNAME_TAKEN' && err.message === 'Це імʼя вже зайняте',
    );
  });

  await t.test('relationships reflection: contacts and blocking in profile', async () => {
    // Додаємо B у контакти A
    await addContact(userAId, userBId);

    const profileB = await getUserProfile(userAId, userBId);
    assert.equal(profileB.isContact, true);
    assert.equal(profileB.isBlocked, false);

    // Блокуємо C
    await blockUser(userAId, userCId);

    const profileC = await getUserProfile(userAId, userCId);
    assert.equal(profileC.isBlocked, true);
  });

  await t.test('cleanup test users', async () => {
    await query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [userAId, userBId, userCId]);
  });
});
