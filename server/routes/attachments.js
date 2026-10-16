import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { queryOne, execute } from '../db/connection.js';
import { handler, noStore } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { ROOT } from '../db/connection.js';

const router = Router();
router.use(requireAuth);

const UPLOAD_DIR = path.join(ROOT, 'uploads');
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Receipts only. The allow-list is by magic bytes as well as declared type, so
 * a renamed executable cannot be stored as a "receipt", and nothing uploaded is
 * ever served as HTML or executed.
 */
const ALLOWED = {
  'application/pdf': { ext: '.pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  'image/png': { ext: '.png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/jpeg': { ext: '.jpg', magic: [[0xff, 0xd8, 0xff]] },
  'image/webp': { ext: '.webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
};

const matchesMagic = (buffer, signatures) =>
  signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));

/**
 * Raw body upload: the client PUTs the file bytes with a Content-Type header
 * and an X-Filename header. This avoids a multipart dependency while keeping
 * strict server-side validation.
 */
router.post('/', requirePermission('attachments.upload'),
  (req, res, next) => {
    const declared = String(req.get('content-type') ?? '').split(';')[0].trim();
    if (!ALLOWED[declared]) {
      return next(badRequest('Only PDF, PNG, JPEG and WebP receipts can be uploaded'));
    }
    const length = Number(req.get('content-length') ?? 0);
    if (length > MAX_BYTES) return next(badRequest('The file exceeds the 8 MB limit'));

    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        req.destroy();
        next(badRequest('The file exceeds the 8 MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    req.on('error', next);
  },
  handler((req, res) => {
    const declared = String(req.get('content-type') ?? '').split(';')[0].trim();
    const spec = ALLOWED[declared];
    const buffer = req.rawBody ?? Buffer.alloc(0);
    if (buffer.length === 0) throw badRequest('The uploaded file is empty');
    if (!matchesMagic(buffer, spec.magic)) {
      throw badRequest('The file contents do not match the declared file type');
    }

    const original = String(req.get('x-filename') ?? 'receipt')
      .replace(/[\r\n]/g, '').slice(0, 120);
    const safeName = path.basename(original).replace(/[^\w.\- ]+/g, '_') || 'receipt';
    const stored = `${crypto.randomUUID()}${spec.ext}`;

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer, { mode: 0o600 });

    const id = Number(execute(
      `INSERT INTO attachments (filename, stored_name, mime_type, byte_size, checksum, uploaded_by, created_at)
       VALUES ($filename, $stored, $mime, $size, $checksum, $actor, $now)`,
      {
        filename: safeName, stored, mime: declared, size: buffer.length,
        checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
        actor: req.user.id, now: nowIso(),
      }
    ).lastInsertRowid);

    audit(req, 'attachment', id, 'uploaded', {
      filename: { from: null, to: safeName }, byte_size: { from: null, to: buffer.length },
    });
    res.status(201).json({ attachment: { id, filename: safeName, mime_type: declared, byte_size: buffer.length } });
  }));

router.get('/:id', handler((req, res) => {
  const attachment = queryOne('SELECT * FROM attachments WHERE id = $id', { id: Number(req.params.id) });
  if (!attachment) throw notFound('Attachment not found');

  /*
   * An attachment is only visible to someone who can see a record it belongs
   * to, and SSNs are the access axis now: being able to read jobs in
   * general is not enough if this job belongs to an SSN outside the
   * viewer's scope.
   */
  const job = queryOne(
    'SELECT ssn_id FROM jobs WHERE attachment_id = $id', { id: attachment.id });
  const expense = job ? null : queryOne(
    'SELECT ssn_id FROM expenses WHERE attachment_id = $id', { id: attachment.id });

  if (job) {
    if (!req.actor.can('jobs.view') || !req.actor.allowsScope('org_unit', job.ssn_id)) {
      throw notFound('Attachment not found');
    }
  } else if (expense) {
    if (!req.actor.can('expenses.view') || !req.actor.allowsScope('org_unit', expense.ssn_id)) {
      throw notFound('Attachment not found');
    }
  } else if (Number(attachment.uploaded_by) !== Number(req.user.id) && req.actor.role !== 'owner') {
    // Not yet linked to a record: only its uploader or an owner may read it.
    throw notFound('Attachment not found');
  }

  const file = path.join(UPLOAD_DIR, attachment.stored_name);
  if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) throw notFound('Attachment file is missing');

  noStore(res);
  res.set('Content-Type', attachment.mime_type);
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition',
    `inline; filename="${attachment.filename.replace(/"/g, '')}"`);
  res.send(fs.readFileSync(file));
}));

export default router;
