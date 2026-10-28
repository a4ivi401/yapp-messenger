import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db.js';
import {
  createMessage,
  findOrCreateDirectConversation,
  listConversationsForUser,
  markConversationRead,
} from '../src/conversations.js';

test('conversations.js: персистентні непрочитані (unread_count за watermark-ом)', async (t) => {
  let dbAvailable = false;
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('PostgreSQL is unavailable, skipping unread tests:', err.message);
  }

  if (!dbAvailable) {
    return;
  }

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const createUser = async (label) => {
    const { rows } = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
      [`test_unread_${label}_${suffix}`],
    );
    return rows[0].id;
  };

  const readerId = await createUser('r'); // хто читає — його рахуємо непрочитані
  const senderId = await createUser('s'); // хто пише

  const { id: conversationId } = await findOrCreateDirectConversation(readerId, senderId);

  t.after(async () => {
    try {
      await query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[readerId, senderId]]);
    } finally {
      await pool.end();
    }
  });

  const unreadFor = async (userId) => {
    const list = await listConversationsForUser(userId);
    return list.find((c) => c.id === conversationId)?.unreadCount ?? null;
  };

  await t.test('новий діалог без повідомлень — 0', async () => {
    assert.equal(await unreadFor(readerId), 0);
  });

  await t.test('вхідні рахуються до watermark-а прочитано', async () => {
    for (const body of ['1', '2', '3']) {
      await createMessage(conversationId, senderId, body);
    }
    // 3 вхідних, жодного прочитання
    assert.equal(await unreadFor(readerId), 3);
    // Власні повідомлення не зараховуються собі
    await createMessage(conversationId, readerId, 'моє');
    assert.equal(await unreadFor(readerId), 3);
    // У відправника — 1 (відповідь читача)
    assert.equal(await unreadFor(senderId), 1);
  });

  await t.test('markConversationRead скидає лічильник', async () => {
    await markConversationRead(conversationId, readerId);
    assert.equal(await unreadFor(readerId), 0);
  });

  await t.test('повідомлення після прочитання рахується знову', async () => {
    await createMessage(conversationId, senderId, 'після прочитання');
    assert.equal(await unreadFor(readerId), 1);
  });
});
