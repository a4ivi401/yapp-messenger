import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db.js';
import {
  createMessage,
  deleteMessage,
  editMessage,
  findOrCreateDirectConversation,
  listMessages,
  searchMessages,
  setMessageReaction,
} from '../src/conversations.js';

test('conversations.js: реакції, редагування, tombstone та пошук', async (t) => {
  // Перевіряємо доступність бази даних
  let dbAvailable = false;
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('PostgreSQL is unavailable, skipping reactions tests:', err.message);
  }

  if (!dbAvailable) {
    return;
  }

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const createUser = async (label) => {
    const { rows } = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
      [`test_react_${label}_${suffix}`],
    );
    return rows[0].id;
  };

  const senderId = await createUser('a');
  const partnerId = await createUser('b');
  const outsiderId = await createUser('c');

  const { id: conversationId } = await findOrCreateDirectConversation(senderId, partnerId);

  t.after(async () => {
    try {
      await query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [senderId, partnerId, outsiderId],
      ]);
    } finally {
      await pool.end();
    }
  });

  const message = await createMessage(conversationId, senderId, 'привіт, як справи');

  await t.test('реакція ставиться й повертає агрегат з userIds', async () => {
    const res = await setMessageReaction(message.id, partnerId, '👍');
    assert.ok(res, 'реакція має оновити агрегат');
    assert.equal(res.conversationId, conversationId);
    assert.equal(res.reactions['👍'].count, 1);
    assert.deepEqual(res.reactions['👍'].userIds, [partnerId]);
  });

  await t.test('той самий емодзі повторно — no-op (null), інший — заміна', async () => {
    assert.equal(await setMessageReaction(message.id, partnerId, '👍'), null);

    const res = await setMessageReaction(message.id, partnerId, '❤️');
    assert.ok(res);
    assert.equal(res.reactions['❤️'].count, 1);
    assert.equal(res.reactions['👍'], undefined);
  });

  await t.test('дві реакції від різних користувачів рахуються в count', async () => {
    const res = await setMessageReaction(message.id, senderId, '❤️');
    assert.ok(res);
    assert.equal(res.reactions['❤️'].count, 2);
    // LEFT JOIN не гарантує порядок рядків — порівнюємо множини userIds
    assert.deepEqual(
      [...res.reactions['❤️'].userIds].sort(),
      [senderId, partnerId].sort(),
    );
  });

  await t.test('зняття реакції прибирає користувача з агрегату', async () => {
    const res = await setMessageReaction(message.id, partnerId, null);
    assert.ok(res);
    assert.equal(res.reactions['❤️'].count, 1);
    assert.equal(await setMessageReaction(message.id, partnerId, null), null); // нічого не ставити
  });

  await t.test('сторонній (не учасник) не ставить реакцію на чужі повідомлення', async () => {
    // Валідний емодзі від не-учасника: INSERT не спрацьовує (перевірка учасника в WHERE)
    const res = await setMessageReaction(message.id, outsiderId, '👍');
    assert.equal(res, null);
  });

  await t.test('editMessage міняє тіло і ставить edited_at лише для відправника', async () => {
    const ok = await editMessage(message.id, senderId, 'все добре!');
    assert.ok(ok);
    assert.equal(ok.body, 'все добре!');
    assert.ok(ok.editedAt);

    // Чужий не може редагувати (ownership у WHERE)
    assert.equal(await editMessage(message.id, partnerId, 'зламано'), null);
  });

  await t.test('editMessage не втрачає агрегат реакцій (баг message:updated)', async () => {
    // Встановлюємо реакцію і редагуємо: повернений message має нести актуальні реакції
    await setMessageReaction(message.id, partnerId, '👍');
    const edited = await editMessage(message.id, senderId, 'все добре, реакції на місці?');
    assert.ok(edited);
    assert.equal(edited.reactions['👍'].count, 1);
    assert.deepEqual(edited.reactions['👍'].userIds, [partnerId]);
  });

  await t.test('listMessages повертає edited_at та агрегат реакцій', async () => {
    const { messages } = await listMessages(conversationId);
    const found = messages.find((m) => m.id === message.id);
    assert.ok(found);
    assert.equal(found.body, 'все добре, реакції на місці?');
    assert.ok(found.editedAt);
    assert.equal(found.reactions['👍'].count, 1);
    assert.equal(found.reactions['❤️'].count, 1);
  });

  await t.test('searchMessages знаходить тіло у межах своїх діалогів', async () => {
    const mine = await searchMessages(senderId, 'добре');
    assert.ok(mine.some((r) => r.message.id === message.id));

    // Не-учасник не бачить чуже діалог
    const foreign = await searchMessages(outsiderId, 'добре');
    assert.equal(foreign.length, 0);
  });

  await t.test('deleteMessage робить tombstone: тіло очищено, deleted=true', async () => {
    const res = await deleteMessage(message.id, senderId);
    assert.ok(res);
    assert.equal(res.conversationId, conversationId);

    // Повторно видалити той самий tombstone (чи чужий) — ні
    assert.equal(await deleteMessage(message.id, partnerId), null);

    const { messages } = await listMessages(conversationId);
    const tomb = messages.find((m) => m.id === message.id);
    assert.ok(tomb);
    assert.equal(tomb.deleted, true);
    assert.equal(tomb.body, '');
    assert.equal(tomb.attachment, null);
    assert.equal(tomb.reactions['❤️'], undefined, 'реакції tombstone прибираються');
  });

  await t.test('tombstone не знаходиться пошуком', async () => {
    const mine = await searchMessages(senderId, 'добре');
    assert.ok(!mine.some((r) => r.message.id === message.id));
  });

  await t.test('tombstone зберігається в БД (порожнє тіло, deleted_at)', async () => {
    const other = await createMessage(conversationId, partnerId, 'останнє перед tombstone');
    await deleteMessage(other.id, partnerId);

    const { rows } = await query(
      `SELECT body, deleted_at FROM messages WHERE id = $1`,
      [other.id],
    );
    assert.equal(rows[0].body, '');
    assert.ok(rows[0].deleted_at);
  });
});
