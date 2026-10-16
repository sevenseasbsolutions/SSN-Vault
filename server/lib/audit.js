import { execute, query, queryOne } from '../db/connection.js';
import { nowIso } from './dates.js';

/** Fields that must never reach the audit log in cleartext. */
const REDACTED = new Set(['password', 'password_hash', 'token', 'token_hash', 'csrf_token', 'ssn']);

function sanitise(value) {
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED.has(k) ? '[redacted]' : v;
  }
  return out;
}

/**
 * Compute a before/after diff limited to the fields that actually changed.
 * Keeping the diff narrow is what makes the audit log readable a year later.
 */
export function diff(before, after, fields) {
  const keys = fields ?? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const changes = {};
  for (const key of keys) {
    if (REDACTED.has(key)) continue;
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    if (String(from) !== String(to)) changes[key] = { from, to };
  }
  return changes;
}

export function recordAudit({ entityType, entityId, action, actor, reason, changes, ip }) {
  execute(
    `INSERT INTO audit_log (entity_type, entity_id, action, user_id, user_label, reason, changes_json, ip, created_at)
     VALUES ($entity_type, $entity_id, $action, $user_id, $user_label, $reason, $changes_json, $ip, $created_at)`,
    {
      entity_type: entityType,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      action,
      user_id: actor?.id ?? null,
      user_label: actor ? `${actor.name} <${actor.email}>` : 'system',
      reason: reason ?? null,
      changes_json: changes && Object.keys(changes).length ? JSON.stringify(sanitise(changes)) : null,
      ip: ip ?? null,
      created_at: nowIso(),
    }
  );
}

/** Convenience wrapper used by route handlers, which always have req to hand. */
export const audit = (req, entityType, entityId, action, changes, reason) =>
  recordAudit({ entityType, entityId, action, actor: req.actor, reason, changes, ip: req.ip });

export function listAudit({ entityType, entityId, userId, action, from, to, limit = 50, offset = 0 }) {
  const clauses = [];
  const params = {};
  if (entityType) { clauses.push('entity_type = $entity_type'); params.entity_type = entityType; }
  if (entityId) { clauses.push('entity_id = $entity_id'); params.entity_id = String(entityId); }
  if (userId) { clauses.push('user_id = $user_id'); params.user_id = Number(userId); }
  if (action) { clauses.push('action = $action'); params.action = action; }
  if (from) { clauses.push('created_at >= $from'); params.from = from; }
  if (to) { clauses.push('created_at <= $to'); params.to = `${to}T23:59:59.999Z`; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = queryOne(`SELECT COUNT(*) AS n FROM audit_log ${where}`, params).n;
  const rows = query(
    `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT $limit OFFSET $offset`,
    { ...params, limit: Number(limit), offset: Number(offset) }
  ).map((row) => ({
    ...row,
    changes: row.changes_json ? JSON.parse(row.changes_json) : null,
  }));
  return { rows, total };
}
