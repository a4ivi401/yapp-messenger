import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db.js';
import {
  recordMatch,
  countMatchesForUser,
  listMatchesForUser,
  hasMatchWith,
  getMatchStatsForUser,
} from '../src/matches.js';

test('matches.js database integration & validation tests', async (t) => {
  // Перевіряємо доступність бази даних
  let dbAvailable = false;
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('PostgreSQL is unavailable, skipping database tests:', err.message);
  }

  await t.test('validation: throws if pair is invalid', async () => {
    await assert.rejects(
      () => recordMatch(null, 'u2'),
      { code: 'INVALID_PAIR' },
    );
    await assert.rejects(
      () => recordMatch('same-id', 'same-id'),
      { code: 'INVALID_PAIR' },
    );
  });

  await t.test('hasMatchWith returns false for identical ids', async () => {
    const res = await hasMatchWith('user-a', 'user-a');
    assert.equal(res, false);
  });

  if (!dbAvailable) {
    return;
  }

  // Створюємо двох унікальних тестових користувачів
  const testSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const usernameA = `test_match_a_${testSuffix}`;
  const usernameB = `test_match_b_${testSuffix}`;

  const { rows: userRowsA } = await query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
    [usernameA],
  );
  const userAId = userRowsA[0].id;

  const { rows: userRowsB } = await query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'dummy_hash') RETURNING id`,
    [usernameB],
  );
  const userBId = userRowsB[0].id;

  t.after(async () => {
    try {
      await query(`DELETE FROM matches WHERE user1_id IN ($1, $2) OR user2_id IN ($1, $2)`, [userAId, userBId]);
      await query(`DELETE FROM users WHERE id IN ($1, $2)`, [userAId, userBId]);
    } finally {
      await pool.end();
    }
  });

  await t.test('initial state: no matches', async () => {
    assert.equal(await hasMatchWith(userAId, userBId), false);
    assert.equal(await hasMatchWith(userBId, userAId), false);
    assert.equal(await countMatchesForUser(userAId), 0);

    const stats = await getMatchStatsForUser(userAId);
    assert.equal(stats.matchesCount, 0);
  });

  await t.test('recordMatch inserts match atomically with canonical ordering', async () => {
    const res = await recordMatch(userAId, userBId);
    assert.equal(res.created, true);
    assert.ok(res.match.id);
    assert.ok(res.match.createdAt);

    // Перевіряємо в БД канонічний порядок
    const { rows } = await query(
      `SELECT user1_id, user2_id FROM matches WHERE id = $1`,
      [res.match.id],
    );
    const expectedFirst = userAId < userBId ? userAId : userBId;
    const expectedSecond = userAId < userBId ? userBId : userAId;
    assert.equal(rows[0].user1_id, expectedFirst);
    assert.equal(rows[0].user2_id, expectedSecond);
  });

  await t.test('recordMatch is idempotent: duplicate call does not throw and returns created=false', async () => {
    // Викликаємо зі зворотним порядком аргументів
    const res = await recordMatch(userBId, userAId);
    assert.equal(res.created, false);
    assert.ok(res.match.id);
  });

  await t.test('hasMatchWith and counts reflect recorded match', async () => {
    assert.equal(await hasMatchWith(userAId, userBId), true);
    assert.equal(await hasMatchWith(userBId, userAId), true);

    assert.equal(await countMatchesForUser(userAId), 1);
    assert.equal(await countMatchesForUser(userBId), 1);

    const statsA = await getMatchStatsForUser(userAId);
    assert.equal(statsA.matchesCount, 1);
    assert.equal(statsA.contactsCount, 0);
  });

  await t.test('listMatchesForUser returns match with partner information', async () => {
    const matchesA = await listMatchesForUser(userAId);
    assert.equal(matchesA.length, 1);
    assert.equal(matchesA[0].partner.id, userBId);
    assert.equal(matchesA[0].partner.username, usernameB);

    const matchesB = await listMatchesForUser(userBId);
    assert.equal(matchesB.length, 1);
    assert.equal(matchesB[0].partner.id, userAId);
    assert.equal(matchesB[0].partner.username, usernameA);
  });
});
