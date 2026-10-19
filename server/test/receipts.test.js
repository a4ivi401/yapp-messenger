import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db.js';
import {
  createMessage,
  findOrCreateDirectConversation,
  getConversationForUser,
  markConversationRead,
  markMessageDelivered,
} from '../src/conversations.js';

test('conversations.js: watermark-и «доставлено / прочитано»', async (t) => {
  // Перевіряємо доступність бази даних
  let dbAvailable = false;
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('PostgreSQL недоступний, тести квитанцій будуть пропущені:', err.message);
  }

  if (!dbAvailable) {
    return;
  }

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const createUser = async (label) => {
    const { rows } = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
      [`test_receipts_${label}_${suffix}`],
    );
    return rows[0].id;
  };

  const senderId = await createUser('a');
  const recipientId = await createUser('b');
  const outsiderId = await createUser('c');

  const { id: conversationId } = await findOrCreateDirectConversation(senderId, recipientId);

  t.after(async () => {
    try {
      await query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [senderId, recipientId, outsiderId],
      ]);
    } finally {
      await pool.end();
    }
  });

  await t.test('новий діалог не має watermark-ів', async () => {
    const conv = await getConversationForUser(conversationId, senderId);
    assert.equal(conv.otherUser.lastDeliveredAt, null);
    assert.equal(conv.otherUser.lastReadAt, null);
  });

  let message;

  await t.test('доставка: одержувач піднімає last_delivered_at', async () => {
    message = await createMessage(conversationId, senderId, 'привіт');

    const res = await markMessageDelivered(message.id, recipientId);
    assert.ok(res, 'доставка має оновити watermark');
    assert.equal(res.conversationId, conversationId);
    assert.equal(res.senderId, senderId);
    assert.ok(res.lastDeliveredAt);

    const conv = await getConversationForUser(conversationId, senderId);
    assert.equal(
      new Date(conv.otherUser.lastDeliveredAt).toISOString(),
      new Date(res.lastDeliveredAt).toISOString(),
    );
    // Доставка сама по собі не робить повідомлення прочитаним
    assert.equal(conv.otherUser.lastReadAt, null);
  });

  await t.test('повторна доставка того ж повідомлення — no-op', async () => {
    assert.equal(await markMessageDelivered(message.id, recipientId), null);
  });

  await t.test('власне повідомлення не можна позначити доставленим собі', async () => {
    assert.equal(await markMessageDelivered(message.id, senderId), null);
  });

  await t.test('сторонній користувач не впливає на чужі watermark-и', async () => {
    assert.equal(await markMessageDelivered(message.id, outsiderId), null);
    assert.equal(await markConversationRead(conversationId, outsiderId), null);

    const conv = await getConversationForUser(conversationId, senderId);
    assert.equal(conv.otherUser.lastReadAt, null);
  });

  await t.test('прочитання піднімає обидва watermark-и', async () => {
    const res = await markConversationRead(conversationId, recipientId);
    assert.ok(res, 'прочитання має оновити watermark');
    assert.ok(res.lastReadAt);
    assert.ok(res.lastDeliveredAt);
    // «прочитано» завжди покриває «доставлено»
    assert.ok(new Date(res.lastDeliveredAt) >= new Date(res.lastReadAt));

    const conv = await getConversationForUser(conversationId, senderId);
    assert.equal(
      new Date(conv.otherUser.lastReadAt).toISOString(),
      new Date(res.lastReadAt).toISOString(),
    );
  });

  await t.test('повторне прочитання без нових вхідних — no-op', async () => {
    assert.equal(await markConversationRead(conversationId, recipientId), null);
  });

  await t.test('власні повідомлення не піднімають власний read-watermark', async () => {
    await createMessage(conversationId, senderId, 'друге');
    // У відправника «вхідних» немає взагалі, тому оновлювати нічого
    assert.equal(await markConversationRead(conversationId, senderId), null);

    const conv = await getConversationForUser(conversationId, recipientId);
    assert.equal(conv.otherUser.lastReadAt, null);
  });

  await t.test('watermark монотонний: старіше повідомлення не відкочує його назад', async () => {
    const older = await createMessage(conversationId, senderId, 'третє');
    await markMessageDelivered(older.id, recipientId);

    const { rows } = await query(
      `SELECT last_delivered_at FROM conversation_participants
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, recipientId],
    );
    const before = new Date(rows[0].last_delivered_at).toISOString();

    // Повторна доставка того ж повідомлення не має зсунути watermark
    assert.equal(await markMessageDelivered(older.id, recipientId), null);

    const { rows: afterRows } = await query(
      `SELECT last_delivered_at FROM conversation_participants
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, recipientId],
    );
    assert.equal(new Date(afterRows[0].last_delivered_at).toISOString(), before);
  });
});
