import { Router } from 'express';
import { query, queryOne, execute, transaction, isUniqueViolation } from '../db/connection.js';
import { handler, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { notFound, conflict, badRequest, forbidden, validationError } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';
import { audit, diff } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { hashPassword, validatePasswordStrength, randomToken } from '../auth/passwords.js';
import { revokeAllSessionsForUser } from '../auth/session.js';
import {
  ROLES, ALL_PERMISSIONS, ROLE_DEFAULTS, OWNER_ONLY, SCOPE_TYPES,
  resolvePermissions, resolveScopes,
} from '../auth/permissions.js';

const router = Router();
router.use(requireAuth, requirePermission('users.manage'));

/**
 * Self-escalation guard.
 *
 * A user may never change their own role, permissions, scopes or active state.
 * Without this, "users.manage" would be a path to unlimited privilege.
 */
function assertNotSelf(req, targetId, what) {
  if (Number(targetId) === Number(req.user.id)) {
    throw forbidden(`You cannot change your own ${what}. Ask another owner to make this change.`);
  }
}

const shape = (user) => ({
  ...user,
  password_hash: undefined,
  effective_permissions: [...resolvePermissions(user)].sort(),
  scopes: resolveScopes(user),
  grants: query(
    'SELECT permission, effect FROM user_permissions WHERE user_id = $id ORDER BY permission',
    { id: user.id }),
});

router.get('/', handler((req, res) => {
  const rows = query(
    `SELECT u.*, c.name AS created_by_name FROM users u
     LEFT JOIN users c ON c.id = u.created_by ORDER BY u.is_active DESC, u.name`
  ).map(shape);
  noStore(res).json({ rows, roles: ROLES, role_defaults: ROLE_DEFAULTS, permissions: ALL_PERMISSIONS });
}));

router.get('/:id', handler((req, res) => {
  const user = queryOne('SELECT * FROM users WHERE id = $id', { id: Number(req.params.id) });
  if (!user) throw notFound('User not found');
  noStore(res).json({
    user: shape(user),
    sessions: query(
      `SELECT id, ip, user_agent, created_at, expires_at, revoked_at FROM sessions
       WHERE user_id = $id ORDER BY created_at DESC LIMIT 20`, { id: user.id }),
    activity: query(
      'SELECT * FROM audit_log WHERE user_id = $id ORDER BY id DESC LIMIT 50', { id: user.id }),
  });
}));

router.post('/', handler((req, res) => {
  const data = check(req.body)
    .string('name', { required: true, max: 160, label: 'Name' })
    .email('email', { required: true, label: 'Email' })
    .enum('role', ROLES, { required: true, label: 'Role' })
    .string('password', { max: 256, label: 'Password' })
    .array('permissions', { max: 100 })
    .array('scopes', { max: 200 })
    .result();

  const password = data.password || randomToken(12);
  const weakness = validatePasswordStrength(password);
  if (data.password && weakness) throw badRequest(weakness);

  const grants = validateGrants(req, data.permissions ?? [], data.role);
  const scopes = validateScopes(data.scopes ?? []);
  const now = nowIso();

  let id;
  try {
    id = transaction(() => {
      const result = execute(
        `INSERT INTO users (email, name, password_hash, role, is_active, must_change_pw,
           created_by, created_at, updated_by, updated_at)
         VALUES ($email, $name, $hash, $role, 1, $must_change, $actor, $now, $actor, $now)`,
        {
          email: data.email, name: data.name, hash: hashPassword(password), role: data.role,
          must_change: data.password ? 0 : 1, actor: req.user.id, now,
        }
      );
      const userId = Number(result.lastInsertRowid);
      writeGrants(userId, grants, req.user.id, now);
      writeScopes(userId, scopes, req.user.id, now);
      return userId;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('A user with that email address already exists');
    throw err;
  }

  audit(req, 'user', id, 'created', {
    email: { from: null, to: data.email },
    role: { from: null, to: data.role },
    permissions: { from: null, to: grants.map((g) => `${g.effect}:${g.permission}`).join(', ') || 'role defaults' },
    scopes: { from: null, to: scopes.map((s) => `${s.scope_type}:${s.scope_id}`).join(', ') || 'none' },
  });

  res.status(201).json({
    user: shape(queryOne('SELECT * FROM users WHERE id = $id', { id })),
    // Shown once so the owner can hand it over; it is never stored in cleartext.
    temporary_password: data.password ? undefined : password,
  });
}));

function validateGrants(req, permissions, role) {
  const out = [];
  for (const entry of permissions) {
    const permission = typeof entry === 'string' ? entry : entry?.permission;
    const effect = typeof entry === 'string' ? 'allow' : (entry?.effect ?? 'allow');
    if (!ALL_PERMISSIONS.includes(permission)) {
      throw validationError({ permissions: `Unknown permission: ${permission}` });
    }
    if (!['allow', 'deny'].includes(effect)) {
      throw validationError({ permissions: 'Permission effect must be allow or deny' });
    }
    if (OWNER_ONLY.has(permission) && effect === 'allow' && role !== 'owner') {
      throw validationError({
        permissions: `"${permission}" can only be held by an owner account.`,
      });
    }
    out.push({ permission, effect });
  }
  return out;
}

/**
 * Scopes now have one axis: a unit of the company tree.
 *
 * Granting a sub-company reaches every SSN under it, including ones
 * added later -- resolveScopes() expands it on read, so nothing here has to be
 * revisited when MBS1 opens a new SSN.
 */
function validateScopes(scopes) {
  return scopes.map((scope) => {
    const type = scope?.scope_type;
    const id = Number(scope?.scope_id);
    if (!SCOPE_TYPES.includes(type) || !Number.isInteger(id)) {
      throw validationError({ scopes: 'Each scope needs a valid scope_type and scope_id' });
    }
    const unit = queryOne('SELECT id, kind FROM org_units WHERE id = $id', { id });
    if (!unit) throw validationError({ scopes: `No company or SSN with id ${id}` });
    if (unit.kind === 'main') {
      throw validationError({
        scopes: 'Scoping to the main company grants everything; leave the scope empty instead.',
      });
    }
    return { scope_type: type, scope_id: id };
  });
}

function writeGrants(userId, grants, actorId, now) {
  execute('DELETE FROM user_permissions WHERE user_id = $id', { id: userId });
  for (const grant of grants) {
    execute(
      `INSERT INTO user_permissions (user_id, permission, effect, granted_by, created_at)
       VALUES ($user_id, $permission, $effect, $granted_by, $now)`,
      { user_id: userId, permission: grant.permission, effect: grant.effect, granted_by: actorId, now }
    );
  }
}

function writeScopes(userId, scopes, actorId, now) {
  execute('DELETE FROM user_scopes WHERE user_id = $id', { id: userId });
  for (const scope of scopes) {
    execute(
      `INSERT INTO user_scopes (user_id, scope_type, scope_id, created_by, created_at)
       VALUES ($user_id, $scope_type, $scope_id, $created_by, $now)`,
      { user_id: userId, scope_type: scope.scope_type, scope_id: scope.scope_id, created_by: actorId, now }
    );
  }
}

router.put('/:id', handler((req, res) => {
  const existing = queryOne('SELECT * FROM users WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('User not found');

  const data = check(req.body)
    .string('name', { max: 160, label: 'Name' })
    .email('email', { label: 'Email' })
    .enum('role', ROLES, { label: 'Role' })
    .bool('is_active')
    .result();

  if (data.role !== undefined && data.role !== existing.role) assertNotSelf(req, existing.id, 'role');
  if (data.is_active !== undefined && data.is_active !== existing.is_active) {
    assertNotSelf(req, existing.id, 'active status');
  }

  const merged = {
    name: data.name ?? existing.name,
    email: data.email ?? existing.email,
    role: data.role ?? existing.role,
    is_active: data.is_active ?? existing.is_active,
  };

  // The last active owner cannot be demoted or deactivated.
  if (existing.role === 'owner' && (merged.role !== 'owner' || !merged.is_active)) {
    const owners = Number(queryOne(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id <> $id",
      { id: existing.id }).n);
    if (owners === 0) throw conflict('There must always be at least one active owner account');
  }

  try {
    execute(
      `UPDATE users SET name = $name, email = $email, role = $role, is_active = $is_active,
         updated_by = $actor, updated_at = $now WHERE id = $id`,
      { id: existing.id, ...merged, actor: req.user.id, now: nowIso() }
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('A user with that email address already exists');
    throw err;
  }

  if (!merged.is_active || merged.role !== existing.role) revokeAllSessionsForUser(existing.id);

  audit(req, 'user', existing.id, 'updated',
    diff(existing, merged, ['name', 'email', 'role', 'is_active']), req.body.reason ?? null);
  res.json({ user: shape(queryOne('SELECT * FROM users WHERE id = $id', { id: existing.id })) });
}));

/** Permissions and scopes are changed through their own guarded endpoint. */
router.put('/:id/access', handler((req, res) => {
  const existing = queryOne('SELECT * FROM users WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('User not found');
  assertNotSelf(req, existing.id, 'permissions');

  const data = check(req.body)
    .array('permissions', { max: 100 })
    .array('scopes', { max: 200 })
    .result();

  const before = {
    permissions: [...resolvePermissions(existing)].sort().join(', '),
    scopes: JSON.stringify(resolveScopes(existing)),
  };

  const grants = validateGrants(req, data.permissions ?? [], existing.role);
  const scopes = validateScopes(data.scopes ?? []);
  const now = nowIso();

  transaction(() => {
    writeGrants(existing.id, grants, req.user.id, now);
    writeScopes(existing.id, scopes, req.user.id, now);
  });

  const fresh = queryOne('SELECT * FROM users WHERE id = $id', { id: existing.id });
  const after = {
    permissions: [...resolvePermissions(fresh)].sort().join(', '),
    scopes: JSON.stringify(resolveScopes(fresh)),
  };
  audit(req, 'user', existing.id, 'access_changed', diff(before, after), req.body.reason ?? null);
  res.json({ user: shape(fresh) });
}));

router.post('/:id/reset-password', handler((req, res) => {
  const existing = queryOne('SELECT * FROM users WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('User not found');
  const supplied = String(req.body?.password ?? '').trim();
  if (supplied) {
    const weakness = validatePasswordStrength(supplied);
    if (weakness) throw badRequest(weakness);
  }
  const password = supplied || randomToken(12);
  execute(
    `UPDATE users SET password_hash = $hash, must_change_pw = $must, failed_logins = 0,
       locked_until = NULL, updated_by = $actor, updated_at = $now WHERE id = $id`,
    {
      id: existing.id, hash: hashPassword(password), must: supplied ? 0 : 1,
      actor: req.user.id, now: nowIso(),
    }
  );
  revokeAllSessionsForUser(existing.id);
  audit(req, 'user', existing.id, 'password_reset', null, req.body?.reason ?? null);
  res.json({ ok: true, temporary_password: supplied ? undefined : password });
}));

router.post('/:id/revoke-sessions', handler((req, res) => {
  const existing = queryOne('SELECT * FROM users WHERE id = $id', { id: Number(req.params.id) });
  if (!existing) throw notFound('User not found');
  revokeAllSessionsForUser(existing.id);
  audit(req, 'user', existing.id, 'sessions_revoked', null);
  res.json({ ok: true });
}));

export default router;
