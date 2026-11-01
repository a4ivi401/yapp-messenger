/**
 * Модуль базового rate-limiting (обмеження частоти запитів) без зовнішніх залежностей.
 * Реалізує точне ковзне вікно (sliding window log) для HTTP Express middleware
 * та окремих Socket.IO обробників подій.
 */

/**
 * Створює сховище ковзного вікна з автоматичним очищенням застарілих записів.
 * @param {number} windowMs - розмір вікна в мілісекундах
 * @param {number} max - максимальна кількість дій у вікні
 */
export function createSlidingWindowStore(windowMs, max) {
  // Map<key, number[]> — масив позначок часу успішних дій
  const store = new Map();

  const cleanup = () => {
    const now = Date.now();
    const threshold = now - windowMs;
    for (const [key, timestamps] of store.entries()) {
      const valid = timestamps.filter((t) => t > threshold);
      if (valid.length === 0) {
        store.delete(key);
      } else if (valid.length !== timestamps.length) {
        store.set(key, valid);
      }
    }
  };

  // Періодичне очищення раз на хвилину (unref, щоб не блокувати завершення процесу)
  const timer = setInterval(cleanup, Math.max(windowMs, 30_000));
  timer.unref?.();

  const check = (key) => {
    const now = Date.now();
    const threshold = now - windowMs;
    let timestamps = store.get(key) || [];

    // Фільтруємо старі мітки
    if (timestamps.length > 0 && timestamps[0] <= threshold) {
      timestamps = timestamps.filter((t) => t > threshold);
    }

    if (timestamps.length >= max) {
      const oldest = timestamps[0];
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      store.set(key, timestamps);
      return {
        allowed: false,
        limit: max,
        remaining: 0,
        resetMs: retryAfterMs,
        retryAfterMs,
      };
    }

    timestamps.push(now);
    store.set(key, timestamps);

    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, max - timestamps.length),
      resetMs: windowMs,
    };
  };

  const reset = () => {
    store.clear();
  };

  return {
    check,
    reset,
    _store: store,
    _timer: timer,
  };
}

/**
 * Express middleware для HTTP rate-limiting.
 *
 * @param {object} options
 * @param {number} options.windowMs - вікно часу в мс (за замовчуванням 60_000)
 * @param {number} options.max - макс. кількість запитів (за замовчуванням 60)
 * @param {string} [options.message] - повідомлення про помилку українською
 * @param {function} [options.keyGenerator] - функція визначення ключа (за замовчуванням IP)
 */
export function rateLimit(options = {}) {
  const windowMs = Number(options.windowMs) || 60_000;
  const max = Number(options.max) || 60;
  const message = options.message || 'Забагато запитів. Будь ласка, зачекайте…';
  const keyGenerator =
    options.keyGenerator ||
    ((req) => req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown');

  const limiterStore = createSlidingWindowStore(windowMs, max);

  const middleware = (req, res, next) => {
    const key = keyGenerator(req);
    const result = limiterStore.check(key);

    const resetSec = Math.ceil((result.resetMs || windowMs) / 1000);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', resetSec);

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.retryAfterMs || 1000) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        error: message,
        retryAfter: retryAfterSec,
      });
    }

    next();
  };

  middleware.reset = () => limiterStore.reset();
  return middleware;
}

/**
 * Socket.IO rate limiter для окремих подій (message:send, stranger:message, stranger:search тощо).
 *
 * @param {object} options
 * @param {number} options.windowMs
 * @param {number} options.max
 */
export function createSocketRateLimiter(options = {}) {
  const windowMs = Number(options.windowMs) || 5000;
  const max = Number(options.max) || 10;
  const store = createSlidingWindowStore(windowMs, max);

  return {
    check: (key) => store.check(key),
    reset: () => store.reset(),
  };
}
