import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db.js';
import {
  blockUser,
  unblockUser,
  isBlockedPair,
  getBlockedUserIds,
  createReport,
  listReportsForUser,
  REPORT_REASONS,
} from '../src/blocks.js';
import {
  findOrEnqueue,
  leaveSession,
  getStrangerSessionOrRecent,
  hasSeenPartner,
  recordSeenPair,
  _resetStateForTesting,
} from '../src/stranger.js';

test('blocks.js & reports integration and stranger safety tests', async (t) => {
  let dbAvailable = false;
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('PostgreSQL is unavailable, skipping database tests:', err.message);
  }

  await t.test('validation: self-block returns null', async () => {
    assert.equal(await blockUser('same-id', 'same-id'), null);
    assert.equal(await blockUser(null, 'user-2'), null);
  });

  await t.test('validation: invalid report reasons throw or return null', async () => {
    assert.equal(await createReport('same-id', 'same-id', 'spam'), null);
    await assert.rejects(
      () => createReport('u1', 'u2', 'invalid_reason'),
      /Неприпустима причина скарги/,
    );
    assert.ok(REPORT_REASONS.includes('spam'));
    assert.ok(REPORT_REASONS.includes('abuse'));
    assert.ok(REPORT_REASONS.includes('inappropriate'));
    assert.ok(REPORT_REASONS.includes('other'));
  });

  if (!dbAvailable) {
    return;
  }

  const testSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const usernameA = `test_block_a_${testSuffix}`;
  const usernameB = `test_block_b_${testSuffix}`;
  const usernameC = `test_block_c_${testSuffix}`;

  const { rows: rowsA } = await query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
    [usernameA],
  );
  const userAId = rowsA[0].id;

  const { rows: rowsB } = await query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
    [usernameB],
  );
  const userBId = rowsB[0].id;

  const { rows: rowsC } = await query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
    [usernameC],
  );
  const userCId = rowsC[0].id;

  t.after(async () => {
    try {
      await query(`DELETE FROM reports WHERE reporter_id IN ($1, $2, $3) OR reported_id IN ($1, $2, $3)`, [
        userAId,
        userBId,
        userCId,
      ]);
      await query(`DELETE FROM user_blocks WHERE blocker_id IN ($1, $2, $3) OR blocked_id IN ($1, $2, $3)`, [
        userAId,
        userBId,
        userCId,
      ]);
      await query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [userAId, userBId, userCId]);
    } finally {
      await pool.end();
    }
  });

  await t.test('initial state: no blocks between users', async () => {
    assert.equal(await isBlockedPair(userAId, userBId), false);
    assert.equal(await isBlockedPair(userBId, userAId), false);
    const blockedA = await getBlockedUserIds(userAId);
    assert.equal(blockedA.length, 0);
  });

  await t.test('blockUser creates persistent block and isBlockedPair is bidirectional', async () => {
    const res = await blockUser(userAId, userBId);
    assert.equal(res.created, true);
    assert.equal(res.blockerId, userAId);
    assert.equal(res.blockedId, userBId);

    // В обидва боки isBlockedPair повертає true
    assert.equal(await isBlockedPair(userAId, userBId), true);
    assert.equal(await isBlockedPair(userBId, userAId), true);

    // userC не заблокований
    assert.equal(await isBlockedPair(userAId, userCId), false);
    assert.equal(await isBlockedPair(userBId, userCId), false);

    // getBlockedUserIds повертає зв'язок для обох учасників
    const blockedA = await getBlockedUserIds(userAId);
    assert.ok(blockedA.includes(userBId));
    const blockedB = await getBlockedUserIds(userBId);
    assert.ok(blockedB.includes(userAId));
  });

  await t.test('blockUser is idempotent (duplicate block returns created=false)', async () => {
    const dup = await blockUser(userAId, userBId);
    assert.equal(dup.created, false);
  });

  await t.test('createReport creates durable report in DB', async () => {
    const report = await createReport(userAId, userBId, 'spam', 'Спамить посиланнями');
    assert.ok(report.id);
    assert.equal(report.reporterId, userAId);
    assert.equal(report.reportedId, userBId);
    assert.equal(report.reason, 'spam');
    assert.equal(report.details, 'Спамить посиланнями');

    const reportsOnB = await listReportsForUser(userBId);
    assert.equal(reportsOnB.length, 1);
    assert.equal(reportsOnB[0].id, report.id);
  });

  await t.test('unblockUser removes the block', async () => {
    const res = await unblockUser(userAId, userBId);
    assert.equal(res.unblocked, true);
    assert.equal(await isBlockedPair(userAId, userBId), false);
    assert.equal(await isBlockedPair(userBId, userAId), false);
  });

  await t.test('stranger safety: getStrangerSessionOrRecent and seen exclusion on block', async () => {
    _resetStateForTesting();

    // 1. Користувачі A та B знаходять один одного
    const resA = findOrEnqueue({ id: userAId, username: usernameA }, 'sock-a');
    assert.equal(resA.matched, false);
    const resB = findOrEnqueue({ id: userBId, username: usernameB }, 'sock-b');
    assert.equal(resB.matched, true);

    const sessionId = resB.sessionId;
    assert.ok(getStrangerSessionOrRecent(sessionId));

    // 2. Користувач B залишає чат
    leaveSession(userBId, 'left');

    // 3. getStrangerSessionOrRecent все одно знаходить недавню сесію
    const recent = getStrangerSessionOrRecent(sessionId);
    assert.ok(recent);
    assert.equal(recent.id, sessionId);
    assert.equal(recent.user1.id, userAId);
    assert.equal(recent.user2.id, userBId);

    // 4. Блокуємо та синхронізуємо в seenPartners
    await blockUser(userAId, userBId);
    const blockedForA = await getBlockedUserIds(userAId);
    for (const bid of blockedForA) {
      recordSeenPair(userAId, bid);
    }
    assert.equal(hasSeenPartner(userAId, userBId), true);

    // 5. Новий підбір між A та B неможливий
    const searchAgainA = findOrEnqueue({ id: userAId, username: usernameA }, 'sock-a2');
    assert.equal(searchAgainA.matched, false);
    const searchAgainB = findOrEnqueue({ id: userBId, username: usernameB }, 'sock-b2');
    // Повинні не з'єднатися, тому що вони в seenPartners!
    assert.equal(searchAgainB.matched, false);

    // А от користувач C може з'єднатися з B!
    const searchC = findOrEnqueue({ id: userCId, username: usernameC }, 'sock-c');
    assert.equal(searchC.matched, true);
    assert.equal(searchC.session.user2.id, userCId);

    _resetStateForTesting();
  });
});
