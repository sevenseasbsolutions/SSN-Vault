import { Router } from 'express';
import { queryOne, execute } from '../db/connection.js';
import { handler, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { unauthorized, forbidden, badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';
import { audit } from '../lib/audit.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../auth/passwords.js';
import { createSession, revokeSession, revokeAllSessionsForUser, listSessions } from '../auth/session.js';
import { requireAuth, rateLimit, touchLogin } from '../auth/middleware.js';
import { buildActor, publicPermissionCatalog } from '../auth/permissions.js';
import { loadSettings } from '../services/settings.js';

const router = Router();

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

const sessionPayload = async (user) => {
  const actor = await buildActor(user);
  const settings = await loadSettings();
  return {
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      must_change_password: !!user.must_change_pw, last_login_at: user.last_login_at,
    },
    permissions: [...actor.permissions].sort(),
    scopes: actor.scopes,
    settings: {
      org_name: settings.org_name,
      currency_symbol: settings.currency_symbol,
      demo_mode: settings.demo_mode === 'true',
      allow_delete: settings.allow_delete === 'true',
    },
  };
};

router.post('/login', loginLimiter, handler(async (req, res) => {
  const body = check(req.body).email('email', { required: true, label: 'Email' })
    .string('password', { required: true, max: 256, label: 'Password' }).result();

  const user = await queryOne('SELECT * FROM users WHERE lower(email) = $email', { email: body.email });
  // One generic message, so the response cannot be used to enumerate accounts.
  const generic = unauthorized('Incorrect email or password');

  if (!user) { verifyPassword(body.password, 'scrypt$1$1$1$x$y'); throw generic; }
  if (user.locked_until && user.locked_until > nowIso()) {
    throw forbidden('This account is temporarily locked after repeated failed sign-in attempts.');
  }
  if (!verifyPassword(body.password, user.password_hash)) {
    // One atomic statement, so two wrong guesses at once still count as two.
    await execute(
      `UPDATE users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $max THEN $locked ELSE NULL END
       WHERE id = $id`,
      {
        id: user.id, max: MAX_FAILED,
        locked: new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString(),
      }
    );
    throw generic;
  }
  if (!user.is_active) throw forbidden('This account has been deactivated.');

  await touchLogin(user.id);
  await createSession(req, res, user);
  const fresh = await queryOne('SELECT * FROM users WHERE id = $id', { id: user.id });
  req.actor = await buildActor(fresh);
  await audit(req, 'session', user.id, 'login', null);
  noStore(res).json(await sessionPayload(fresh));
  // Not one transaction: a failed attempt's counter must survive the error it throws.
}, { transactional: false }));

router.post('/logout', handler(async (req, res) => {
  if (req.session) await audit(req, 'session', req.user.id, 'logout', null);
  await revokeSession(res, req.session?.id);
  res.json({ ok: true });
}));

router.get('/session', handler(async (req, res) => {
  if (!req.user) return noStore(res).status(401).json({ error: { code: 'unauthorized', message: 'Not signed in' } });
  noStore(res).json(await sessionPayload(req.user));
}));

router.get('/permissions', requireAuth, handler((req, res) => {
  res.json({ rows: publicPermissionCatalog() });
}));

router.get('/sessions', requireAuth, handler(async (req, res) => {
  res.json({ rows: await listSessions(req.user.id), current: req.session?.id });
}));

router.post('/change-password', requireAuth, handler(async (req, res) => {
  const body = check(req.body)
    .string('current_password', { required: true, max: 256, label: 'Current password' })
    .string('new_password', { required: true, max: 256, label: 'New password' }).result();

  if (!verifyPassword(body.current_password, req.user.password_hash)) {
    throw badRequest('Your current password is incorrect');
  }
  const weakness = validatePasswordStrength(body.new_password);
  if (weakness) throw badRequest(weakness);
  if (body.current_password === body.new_password) {
    throw badRequest('The new password must be different from the current one');
  }

  await execute(
    `UPDATE users SET password_hash = $hash, must_change_pw = 0, updated_by = $actor, updated_at = $now
     WHERE id = $id`,
    { id: req.user.id, hash: hashPassword(body.new_password), actor: req.user.id, now: nowIso() }
  );
  await audit(req, 'user', req.user.id, 'password_changed', null);
  // Every other session for this user is invalidated.
  await revokeAllSessionsForUser(req.user.id);
  const fresh = await queryOne('SELECT * FROM users WHERE id = $id', { id: req.user.id });
  await createSession(req, res, fresh);
  res.json({ ok: true });
}));

export default router;
