import { query } from '../db/connection.js';
import { forbidden } from '../lib/errors.js';

/**
 * Permission catalog. Every mutating or reading endpoint names one of these,
 * and the check always happens on the server, inside the request handler --
 * never only by hiding a button in the frontend.
 */
export const PERMISSIONS = {
  'dashboard.view': 'View the dashboard and company roll-up',
  'org.view': 'View the company structure',
  'org.manage': 'Create and edit companies and SSNs, and set their shares',
  'jobs.view': 'View jobs',
  'jobs.create': 'Set up jobs',
  'jobs.edit': 'Edit jobs and their tax terms',
  'jobs.delete': 'Delete jobs permanently',
  'salaries.view': 'View salaries',
  'salaries.create': 'Record salaries',
  'salaries.edit': 'Edit salaries',
  'salaries.delete': 'Delete salaries permanently',
  'expenses.view': 'View expenses',
  'expenses.create': 'Record expenses',
  'expenses.edit': 'Edit expenses',
  'expenses.delete': 'Delete expenses permanently',
  'tax.view': 'View tax holds',
  'tax.manage': 'Set tax rates and override a month\'s tax hold',
  'reports.view': 'View reports and SSN statements',
  'reports.export': 'Export reports to CSV and Excel',
  'attachments.upload': 'Upload invoices and supporting documents',
  'users.manage': 'Create users, assign roles, grant permissions',
  'settings.manage': 'Change financial settings',
  'audit.view': 'View the audit history',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/*
 * 'partner' is retired. It stays in the users table CHECK constraint (see
 * migration 007 for why the table is not rebuilt) but nothing creates one, and
 * it is absent from ROLE_DEFAULTS so an account left on it holds nothing.
 */
export const ROLES = ['owner', 'editor', 'viewer'];

/** Baseline permissions per role; per-user allow/deny rows layer on top. */
export const ROLE_DEFAULTS = {
  owner: ALL_PERMISSIONS,
  editor: [
    'dashboard.view',
    'org.view',
    'jobs.view', 'jobs.create', 'jobs.edit',
    'salaries.view', 'salaries.create', 'salaries.edit',
    'expenses.view', 'expenses.create', 'expenses.edit',
    'tax.view',
    'reports.view', 'reports.export',
    'attachments.upload',
  ],
  viewer: [
    'dashboard.view',
    'org.view',
    'jobs.view', 'salaries.view', 'expenses.view', 'tax.view',
    'reports.view',
  ],
};

/**
 * Permissions a user can never hold through anything but the owner role.
 * Blocks a privilege-escalation path where an owner accidentally grants
 * user management to a scoped account.
 */
export const OWNER_ONLY = new Set(['users.manage', 'settings.manage']);

export const SCOPE_TYPES = ['org_unit'];

/**
 * The catalog as the access screen needs it: every permission with its
 * description and whether it is owner-only, so the UI can disable the ones a
 * non-owner could never hold instead of offering a grant the server refuses.
 */
export const publicPermissionCatalog = () =>
  ALL_PERMISSIONS.map((key) => ({
    key,
    label: PERMISSIONS[key],
    owner_only: OWNER_ONLY.has(key),
  }));

export async function resolvePermissions(user) {
  if (!user) return new Set();
  if (!user.is_active) return new Set();
  const base = new Set(ROLE_DEFAULTS[user.role] ?? []);
  const rows = await query(
    'SELECT permission, effect FROM user_permissions WHERE user_id = $user_id',
    { user_id: user.id }
  );
  for (const row of rows) {
    if (!PERMISSIONS[row.permission]) continue;
    if (row.effect === 'allow') base.add(row.permission);
  }
  // Denials are applied last and always win.
  for (const row of rows) {
    if (row.effect === 'deny') base.delete(row.permission);
  }
  if (user.role !== 'owner') {
    for (const perm of OWNER_ONLY) base.delete(perm);
  }
  return base;
}

/**
 * Row-level scopes, on the one axis that now exists: the org tree.
 *
 * Returns null for "unrestricted", or an array of allowed org_unit ids
 * (possibly empty, meaning "nothing is visible"). A user scoped to a
 * sub-company implicitly reaches every SSN under it, so granting
 * access to MBS1 does not mean listing Alpha, Beta and every SSN added
 * later by hand.
 */
export async function resolveScopes(user) {
  if (!user) return { org_unit: [] };
  if (user.role === 'owner') return { org_unit: null };

  const rows = await query(
    "SELECT scope_id FROM user_scopes WHERE user_id = $user_id AND scope_type = 'org_unit'",
    { user_id: user.id }
  );
  if (rows.length === 0) return { org_unit: null };

  const granted = [...new Set(rows.map((r) => Number(r.scope_id)))];
  const keys = Object.fromEntries(granted.map((id, i) => [`s${i}`, id]));
  const placeholders = granted.map((_, i) => `$s${i}`).join(',');
  // Expand each granted unit to itself plus everything beneath it.
  const expanded = (await query(`
    WITH RECURSIVE walk(id) AS (
      SELECT id FROM org_units WHERE id IN (${placeholders})
      UNION
      SELECT u.id FROM org_units u JOIN walk w ON u.parent_id = w.id
    )
    SELECT id FROM walk
  `, keys)).map((r) => Number(r.id));

  return { org_unit: [...new Set([...granted, ...expanded])] };
}

export async function buildActor(user) {
  const permissions = await resolvePermissions(user);
  const scopes = await resolveScopes(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    is_active: user.is_active,
    permissions,
    scopes,
    can(permission) { return permissions.has(permission); },
    canAny(list) { return list.some((p) => permissions.has(p)); },
    require(permission) {
      if (!permissions.has(permission)) {
        throw forbidden(`Missing permission: ${PERMISSIONS[permission] ?? permission}`);
      }
    },
    /** null = unrestricted, [] = nothing visible. */
    scope(type) { return scopes[type] ?? null; },
    allowsScope(type, id) {
      const allowed = scopes[type];
      if (allowed === null || allowed === undefined) return true;
      return allowed.includes(Number(id));
    },
  };
}

/**
 * Append an `IN (...)` restriction for a scope to a WHERE-clause builder.
 * Returns false when the scope is empty, which the caller uses to short-circuit
 * to an empty result set rather than leaking rows.
 */
export function applyScope(actor, type, column, clauses, params, prefix) {
  const allowed = actor.scope(type);
  if (allowed === null) return true;
  if (allowed.length === 0) { clauses.push('1 = 0'); return false; }
  const keys = allowed.map((id, i) => {
    const key = `${prefix}${i}`;
    params[key] = id;
    return `$${key}`;
  });
  clauses.push(`${column} IN (${keys.join(', ')})`);
  return true;
}
