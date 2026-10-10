import crypto from 'node:crypto';

const KEYLEN = 64;

/**
 * scrypt-хеш із випадковою сіллю.
 * Зберігаємо у вигляді `salt:hash` (hex) в одній колонці.
 * scrypt — вбудований у Node, тому жодних нативних залежностей.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}