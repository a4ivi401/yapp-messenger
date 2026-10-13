import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAvatarPair,
  findOrEnqueue,
  cancelSearch,
  leaveSession,
  requestContactMatch,
  saveStrangerMessage,
  getSession,
  hasSeenPartner,
  _resetStateForTesting,
} from '../src/stranger.js';

test('stranger.js unit tests', async (t) => {
  t.beforeEach(() => {
    _resetStateForTesting();
  });

  await t.test('generateAvatarPair returns two distinct avatars', () => {
    for (let i = 0; i < 50; i++) {
      const [a1, a2] = generateAvatarPair();
      assert.notEqual(a1.anonName, a2.anonName);
      assert.notEqual(a1.anonAvatar, a2.anonAvatar);
      assert.match(a1.anonName, /^Анонімн/);
      assert.match(a2.anonName, /^Анонімн/);
    }
  });

  await t.test('first user enters waiting queue', () => {
    const res = findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1');
    assert.equal(res.matched, false);
    assert.equal(res.status, 'waiting');
  });

  await t.test('cancelling search removes user from queue', () => {
    findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1');
    const cancelled = cancelSearch('u1');
    assert.equal(cancelled, true);

    // Another user queues and shouldn't match with u1
    const res = findOrEnqueue({ id: 'u2', username: 'bob' }, 'sock2');
    assert.equal(res.matched, false);
  });

  await t.test('prevents self-match across different sockets/tabs', () => {
    findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1-tab1');
    const res = findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1-tab2');
    assert.equal(res.matched, false);
    assert.equal(res.status, 'waiting');
  });

  await t.test('matches two distinct users and assigns avatars', () => {
    const res1 = findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1');
    assert.equal(res1.matched, false);

    const res2 = findOrEnqueue({ id: 'u2', username: 'bob' }, 'sock2');
    assert.equal(res2.matched, true);
    assert.ok(res2.sessionId);

    const session = res2.session;
    assert.equal(session.user1.id, 'u1');
    assert.equal(session.user1.username, 'alice');
    assert.equal(session.user2.id, 'u2');
    assert.equal(session.user2.username, 'bob');

    assert.notEqual(session.user1.anonName, session.user2.anonName);
    assert.notEqual(session.user1.anonAvatar, session.user2.anonAvatar);

    assert.equal(hasSeenPartner('u1', 'u2'), true);
  });

  await t.test('buffers ephemeral messages up to limit', () => {
    findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1');
    const { sessionId } = findOrEnqueue({ id: 'u2', username: 'bob' }, 'sock2');

    saveStrangerMessage(sessionId, { id: 'm1', body: 'Привіт!' });
    saveStrangerMessage(sessionId, { id: 'm2', body: 'Як справи?' });

    const session = getSession(sessionId);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].body, 'Привіт!');
    assert.equal(session.messages[1].body, 'Як справи?');
  });

  await t.test('Session Exclusion: users who chatted cannot meet again in this session', () => {
    // 1. u1 and u2 match
    findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1');
    const match1 = findOrEnqueue({ id: 'u2', username: 'bob' }, 'sock2');
    assert.equal(match1.matched, true);

    // 2. u1 decides to switch to next stranger ('next')
    const left = leaveSession('u1', 'next');
    assert.ok(left);
    assert.equal(left.reason, 'next');
    assert.equal(left.partner.id, 'u2');

    // 3. Both u1 and u2 enter the queue again
    const u1SearchAgain = findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1-new');
    assert.equal(u1SearchAgain.matched, false);
    assert.equal(u1SearchAgain.status, 'waiting');

    const u2SearchAgain = findOrEnqueue({ id: 'u2', username: 'bob' }, 'sock2-new');
    // Crucial requirement: u1 and u2 MUST NOT match again!
    assert.equal(u2SearchAgain.matched, false);
    assert.equal(u2SearchAgain.status, 'waiting');

    // 4. A third user u3 enters queue: u1 should match with u3 (since they haven't met)
    const u3Search = findOrEnqueue({ id: 'u3', username: 'charlie' }, 'sock3');
    assert.equal(u3Search.matched, true);
    assert.equal(u3Search.session.user1.id, 'u1');
    assert.equal(u3Search.session.user2.id, 'u3');
  });

  await t.test('Mutual contact match request', () => {
    findOrEnqueue({ id: 'u1', username: 'alice' }, 'sock1');
    const { sessionId } = findOrEnqueue({ id: 'u2', username: 'bob' }, 'sock2');

    // u1 requests match
    const req1 = requestContactMatch(sessionId, 'u1');
    assert.equal(req1.ok, true);
    assert.equal(req1.mutual, false);
    assert.equal(req1.requestedBy, 'u1');

    // u2 accepts match
    const req2 = requestContactMatch(sessionId, 'u2');
    assert.equal(req2.ok, true);
    assert.equal(req2.mutual, true);
    assert.equal(req2.user1.username, 'alice');
    assert.equal(req2.user2.username, 'bob');

    // Active session is now converted/closed
    assert.equal(getSession(sessionId), null);
  });
});
