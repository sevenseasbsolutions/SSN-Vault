import { Router } from 'express';
import { query } from '../db/connection.js';
import { handler, noStore } from '../lib/http.js';
import { check } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { loadSettings, setSetting, DEFAULT_SETTINGS } from '../services/settings.js';
import { listAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

/** Settings that may be changed, with their allowed values. */
const EDITABLE = {
  org_name: { label: 'Organisation name', type: 'text', max: 80 },
  currency_symbol: { label: 'Currency symbol', type: 'text', max: 4 },
  currency_code: { label: 'Currency code', type: 'text', max: 8 },
  fiscal_year_start_month: { label: 'Fiscal year starts in month', type: 'int', min: 1, max: 12 },
  require_reason_above_cents: {
    label: 'Reason required above', type: 'int', min: 0, max: 100000000,
  },
  allow_delete: {
    label: 'Allow records to be deleted', type: 'enum', values: ['false', 'true'],
    help: 'Deleting is permanent. Every deletion is recorded in the audit history.',
  },
  demo_mode: { label: 'Demo banner', type: 'enum', values: ['true', 'false'] },
};

router.get('/', requireAuth, handler((req, res) => {
  const all = loadSettings();
  const canManage = req.actor.can('settings.manage');
  const visible = canManage ? all : {
    org_name: all.org_name, currency_symbol: all.currency_symbol,
    currency_code: all.currency_code, demo_mode: all.demo_mode,
    allow_delete: all.allow_delete,
  };
  noStore(res).json({
    settings: visible,
    editable: canManage ? EDITABLE : {},
    defaults: canManage ? DEFAULT_SETTINGS : {},
  });
}));

router.put('/', requirePermission('settings.manage'), handler((req, res) => {
  const updates = req.body && typeof req.body === 'object' ? req.body : {};
  const before = loadSettings();
  const changes = {};

  for (const [key, value] of Object.entries(updates)) {
    const spec = EDITABLE[key];
    if (!spec) throw badRequest(`"${key}" is not a configurable setting`);
    const next = coerce(key, value, spec);
    if (String(before[key]) !== String(next)) {
      changes[key] = { from: before[key], to: next };
      setSetting(key, next, req.user.id);
    }
  }
  if (Object.keys(changes).length) audit(req, 'settings', null, 'updated', changes);
  res.json({ settings: loadSettings(), changes });
}));

function coerce(key, value, spec) {
  if (spec.type === 'enum') {
    const v = String(value);
    if (!spec.values.includes(v)) {
      throw badRequest(`${spec.label} must be one of: ${spec.values.join(', ')}`);
    }
    return v;
  }
  if (spec.type === 'int') {
    const data = check({ v: value }).int('v', {
      required: true, min: spec.min, max: spec.max, label: spec.label,
    }).result();
    return String(data.v);
  }
  const data = check({ v: value }).string('v', {
    required: true, max: spec.max ?? 200, label: spec.label,
  }).result();
  return data.v;
}

/* -------------------------------------------------------------- audit log -- */

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePermission('audit.view'));

auditRouter.get('/', handler((req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const { rows, total } = listAudit({
    entityType: req.query.entity_type,
    entityId: req.query.entity_id,
    userId: req.query.user_id,
    action: req.query.action,
    from: req.query.from,
    to: req.query.to,
    limit,
    offset: (page - 1) * limit,
  });
  noStore(res).json({
    rows, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    entity_types: query('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type')
      .map((r) => r.entity_type),
    actions: query('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action),
  });
}));

export default router;
