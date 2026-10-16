import crypto from 'node:crypto';
import { query, queryOne, execute } from '../db/connection.js';
import { nowIso } from '../lib/dates.js';
import { randomToken, sha256 } from './passwords.js';

export const SESSION_COOKIE = 'vault_session';
export const CSRF_COOKIE = 'vault_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 12) * 60 * 60 * 1000;

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(idx + 1).trim()); }
    catch { out[key] = part.slice(idx + 1).trim(); }
  }
  return out;
}

function cookieHeader(name, value, { maxAge, httpOnly = true, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`);
  return parts.join('; ');
}

const isSecure = (req) =>
  process.env.COOKIE_SECURE === 'true' ||
  (process.env.NODE_ENV === 'production' && req.protocol === 'https');

export function createSession(req, res, user) {
  const id = crypto.randomUUID();
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  execute(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip, user_agent, created_at, expires_at)
     VALUES ($id, $user_id, $token_hash, $csrf_token, $ip, $user_agent, $created_at, $expires_at)`,
    {
      id,
      user_id: user.id,
      token_hash: sha256(token),
      csrf_token: csrf,
      ip: req.ip ?? null,
      user_agent: String(req.get('user-agent') ?? '').slice(0, 300),
      created_at: nowIso(),
      expires_at: expiresAt,
    }
  );

  const secure = isSecure(req);
  res.append('Set-Cookie', cookieHeader(SESSION_COOKIE, `${id}.${token}`, {
    maxAge: SESSION_TTL_MS, httpOnly: true, secure,
  }));
  // Readable by the SPA so it can echo it back in the CSRF header.
  res.append('Set-Cookie', cookieHeader(CSRF_COOKIE, csrf, {
    maxAge: SESSION_TTL_MS, httpOnly: false, secure,
  }));
  return { id, csrf, expiresAt };
}

export function readSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const idx = raw.indexOf('.');
  const id = raw.slice(0, idx);
  const token = raw.slice(idx + 1);
  const session = queryOne(
    `SELECT * FROM sessions WHERE id = $id AND revoked_at IS NULL AND expires_at > $now`,
    { id, now: nowIso() }
  );
  if (!session) return null;
  const expected = Buffer.from(session.token_hash, 'utf8');
  const actual = Buffer.from(sha256(token), 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return session;
}

export function revokeSession(res, sessionId) {
  if (sessionId) {
    execute('UPDATE sessions SET revoked_at = $now WHERE id = $id', { id: sessionId, now: nowIso() });
  }
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.append('Set-Cookie', `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0`);
}

export function revokeAllSessionsForUser(userId) {
  execute('UPDATE sessions SET revoked_at = $now WHERE user_id = $uid AND revoked_at IS NULL',
    { uid: userId, now: nowIso() });
}

export function purgeExpiredSessions() {
  execute('DELETE FROM sessions WHERE expires_at < $cutoff', {
    cutoff: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

export const listSessions = (userId) =>
  query(`SELECT id, ip, user_agent, created_at, expires_at, revoked_at
         FROM sessions WHERE user_id = $uid ORDER BY created_at DESC LIMIT 50`, { uid: userId });
