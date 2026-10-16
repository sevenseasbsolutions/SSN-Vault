import crypto from 'node:crypto';

const KEY_LEN = 64;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt with a per-password random salt. Format: scrypt$N$r$p$salt$hash */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT);
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), hash.toString('base64'),
  ].join('$');
}

/** Constant-time verification. Never throws on malformed stored values. */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Password policy. Deliberately length-first rather than a symbol zoo, which is
 * what actually resists guessing.
 */
export function validatePasswordStrength(password) {
  const value = String(password ?? '');
  if (value.length < 12) return 'Password must be at least 12 characters';
  if (value.length > 256) return 'Password must be at most 256 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 3) {
    return 'Password must combine at least three of: lowercase, uppercase, digits, symbols';
  }
  if (/^(.)\1+$/.test(value)) return 'Password is too predictable';
  return null;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
