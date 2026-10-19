import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addSocket,
  removeSocket,
  isOnline,
  onlineUserIds,
  _resetStateForTesting,
} from '../src/presence.js';

test('presence.js: реєстр онлайн-стану', async (t) => {
  t.beforeEach(() => _resetStateForTesting());

  await t.test('нова сесія: користувач офлайн і не в списку онлайн', () => {
    assert.equal(isOnline('u1'), false);
    assert.deepEqual(onlineUserIds(), []);
  });

  await t.test('перший сокет робить користувача онлайн', () => {
    const { becameOnline } = addSocket('u1', 's1');
    assert.equal(becameOnline, true);
    assert.equal(isOnline('u1'), true);
    assert.deepEqual(onlineUserIds(), ['u1']);
  });

  await t.test('друга вкладка не рахується як новий перехід онлайн', () => {
    addSocket('u1', 's1');
    const { becameOnline } = addSocket('u1', 's2');
    assert.equal(becameOnline, false);
    assert.equal(isOnline('u1'), true);
  });

  await t.test('користувач лишається онлайн, поки живий хоч один сокет', () => {
    addSocket('u1', 's1');
    addSocket('u1', 's2');

    assert.equal(removeSocket('u1', 's1').wentOffline, false);
    assert.equal(isOnline('u1'), true);

    assert.equal(removeSocket('u1', 's2').wentOffline, true);
    assert.equal(isOnline('u1'), false);
  });

  await t.test('відключення невідомого сокета безпечне (ідемпотентність)', () => {
    addSocket('u1', 's1');

    assert.equal(removeSocket('u1', 'nope').wentOffline, false);
    assert.equal(isOnline('u1'), true);

    removeSocket('u1', 's1');
    // повторний виклик для того самого сокета не має кидати чи «оживляти» користувача
    assert.equal(removeSocket('u1', 's1').wentOffline, false);
    assert.equal(isOnline('u1'), false);
  });

  await t.test('стан різних користувачів незалежний', () => {
    addSocket('u1', 's1');
    addSocket('u2', 's2');

    removeSocket('u1', 's1');

    assert.equal(isOnline('u1'), false);
    assert.equal(isOnline('u2'), true);
    assert.deepEqual(onlineUserIds(), ['u2']);
  });

  await t.test('після виходу останнього сокета користувач зникає зі списку', () => {
    addSocket('u1', 's1');
    removeSocket('u1', 's1');

    assert.deepEqual(onlineUserIds(), []);
  });
});
