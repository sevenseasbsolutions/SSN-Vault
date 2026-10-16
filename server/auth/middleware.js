import { queryOne, execute } from '../db/connection.js';
import { unauthorized, forbidden, tooManyRequests, AppError } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';
import { buildActor } from './permissions.js';
import { readSession, CSRF_HEADER } from './session.js';

/** Resolves req.session / req.user / req.actor when a valid session exists. */
export async function attachUser(req, res, next) {
  try {
    const session = await readSession(req);
    if (session) {
      const user = await queryOne('SELECT * FROM users WHERE id = $id', { id: session.user_id });
      if (user && user.is_active) {
        const actor = await buildActor(user);
        req.session = session;
        req.user = user;
        req.actor = actor;
      }
    }
  } catch { /* an unreadable session is simply an anonymous request */ }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.actor) return next(unauthorized());
  next();
}

export const requirePermission = (...permissions) => (req, res, next) => {
  if (!req.actor) return next(unauthorized());
  const ok = permissions.some((p) => req.actor.can(p));
  if (!ok) return next(forbidden());
  next();
};

/**
 * Double-submit CSRF. State-changing requests must echo the session's CSRF
 * token in a HEADER.
 *
 * The header is the whole mechanism: a cross-site page can cause the browser
 * to SEND the cookie but cannot READ it to echo it back. Accepting the token
 * from the cookie as a fallback would therefore accept exactly the request
 * this guard exists to reject, leaving SameSite as the only real defence. The
 * frontend always sends the header (see public/js/api.js), so requiring it
 * costs nothing.
 */
export function csrfGuard(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (!req.session) return next();                      // unauthenticated: nothing to protect yet
  if (req.get('authorization')) return next();          // token auth is not cookie-driven
  const sent = req.get(CSRF_HEADER);
  if (!sent || sent !== req.session.csrf_token) {
    return next(new AppError(403, 'csrf_failed', 'Invalid or missing CSRF token'));
  }
  next();
}

/** Fixed-window in-memory limiter. Adequate for a single-process deployment. */
export function rateLimit({ windowMs = 60_000, max = 120, key = (req) => req.ip, message } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const bucket = key(req);
    if (bucket === null) return next();
    const entry = hits.get(bucket);
    if (!entry || entry.resetAt <= now) {
      hits.set(bucket, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
      if (entry.count > max) {
        res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
        return next(tooManyRequests(message));
      }
    }
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    next();
  };
}

export async function touchLogin(userId) {
  await execute('UPDATE users SET last_login_at = $now, failed_logins = 0, locked_until = NULL WHERE id = $id',
    { id: userId, now: nowIso() });
}
