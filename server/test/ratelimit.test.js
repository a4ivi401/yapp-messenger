import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlidingWindowStore,
  rateLimit,
  createSocketRateLimiter,
} from '../src/rateLimit.js';

test('rateLimit: createSlidingWindowStore (ковзне вікно)', async (t) => {
  await t.test('пропускає дозволену кількість дій та обчислює remaining', () => {
    const limiter = createSlidingWindowStore(1000, 3);
    const r1 = limiter.check('user1');
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);

    const r2 = limiter.check('user1');
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1);

    const r3 = limiter.check('user1');
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);

    const r4 = limiter.check('user1');
    assert.equal(r4.allowed, false);
    assert.equal(r4.remaining, 0);
    assert.ok(r4.retryAfterMs > 0);
  });

  await t.test('різні ключі мають незалежні лічильники', () => {
    const limiter = createSlidingWindowStore(1000, 2);
    limiter.check('keyA');
    limiter.check('keyA');
    assert.equal(limiter.check('keyA').allowed, false);

    assert.equal(limiter.check('keyB').allowed, true);
    assert.equal(limiter.check('keyB').allowed, true);
    assert.equal(limiter.check('keyB').allowed, false);
  });

  await t.test('reset очищує стан', () => {
    const limiter = createSlidingWindowStore(1000, 1);
    limiter.check('user');
    assert.equal(limiter.check('user').allowed, false);
    limiter.reset();
    assert.equal(limiter.check('user').allowed, true);
  });
});

test('rateLimit: HTTP Express middleware', async (t) => {
  await t.test('пропускає запит у межах ліміту і виставляє заголовки', () => {
    const mw = rateLimit({ windowMs: 10_000, max: 2, keyGenerator: () => 'ip-test-1' });
    const req = {};
    const headers = {};
    const res = {
      setHeader: (name, val) => {
        headers[name] = val;
      },
      status: () => res,
      json: () => res,
    };

    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(headers['RateLimit-Limit'], 2);
    assert.equal(headers['RateLimit-Remaining'], 1);
  });

  await t.test('блокує запит зі статусом 429 при перевищенні ліміту', () => {
    const mw = rateLimit({
      windowMs: 10_000,
      max: 1,
      message: 'Забагато запитів',
      keyGenerator: () => 'ip-test-2',
    });
    const req = {};
    const headers = {};
    let statusCode = null;
    let jsonBody = null;

    const res = {
      setHeader: (name, val) => {
        headers[name] = val;
      },
      status: (code) => {
        statusCode = code;
        return res;
      },
      json: (data) => {
        jsonBody = data;
        return res;
      },
    };

    // Перший запит — ОК
    mw(req, res, () => {});

    // Другий запит — 429
    let secondNextCalled = false;
    mw(req, res, () => {
      secondNextCalled = true;
    });

    assert.equal(secondNextCalled, false);
    assert.equal(statusCode, 429);
    assert.equal(jsonBody?.error, 'Забагато запитів');
    assert.ok(Number(headers['Retry-After']) >= 1);
  });
});

test('rateLimit: createSocketRateLimiter', async (t) => {
  await t.test('обмежує дії сокета за вказаним лімітом', () => {
    const socketLimiter = createSocketRateLimiter({ windowMs: 500, max: 2 });
    assert.equal(socketLimiter.check('socket-user').allowed, true);
    assert.equal(socketLimiter.check('socket-user').allowed, true);
    assert.equal(socketLimiter.check('socket-user').allowed, false);
  });
});
