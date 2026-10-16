import { badRequest } from './errors.js';
import { transaction, snapshot } from '../db/connection.js';

/*
 * Run a write handler inside one transaction, and hold its response until the
 * transaction has committed. A handler that answers "created" and then fails
 * on its audit row must not leave the client believing the write happened:
 * the whole request is undone, and only an error goes out.
 */
async function inWriteTransaction(fn, req, res, next) {
  const pending = [];
  res.json = (body) => { pending.push(['json', body]); return res; };
  res.send = (body) => { pending.push(['send', body]); return res; };
  try {
    await transaction(() => fn(req, res, next));
  } finally {
    // Back to the prototype's own methods.
    delete res.json;
    delete res.send;
  }
  const [first] = pending;
  if (first) (first[0] === 'json' ? res.json(first[1]) : res.send(first[1]));
}

/**
 * Wrap a route handler so a rejected promise reaches the error middleware,
 * and so it runs against the database the way it was written to.
 *
 *   GET / HEAD   one consistent read-only snapshot for the whole request, so
 *                a report summed over many queries never mixes before and
 *                after a concurrent write.
 *   anything     one serialised write transaction, all or nothing.
 *   else
 *
 * `transactional: false` opts out, for a handler whose writes must survive
 * the error it then throws -- the failed-sign-in counter.
 */
export const handler = (fn, { transactional = true } = {}) => (req, res, next) => {
  const method = req.method.toUpperCase();
  let work;
  if (!transactional) work = Promise.resolve().then(() => fn(req, res, next));
  else if (method === 'GET' || method === 'HEAD') work = snapshot(() => fn(req, res, next));
  else work = inWriteTransaction(fn, req, res, next);
  work.catch(next);
};

export function pagination(req, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit));
  const page = Math.max(1, Number(req.query.page) || 1);
  return { limit, offset: (page - 1) * limit, page };
}

/**
 * Whitelisted ORDER BY, so a sort parameter can never become SQL injection.
 *
 * An unrecognised key falls back to the default column rather than failing, so
 * a stale bookmarked URL still works; the response reports which sort was
 * actually applied. `sql` is non-enumerable: route handlers use it to build the
 * query, but it never serialises into a response and so cannot disclose table
 * aliases or column names to a client.
 */
export function sorting(req, allowed, fallback) {
  const requested = String(req.query.sort ?? '').trim();
  const direction = String(req.query.dir ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const column = Object.hasOwn(allowed, requested) ? allowed[requested] : allowed[fallback];
  if (!column) throw badRequest('Unsupported sort column');

  const result = {
    sort: Object.hasOwn(allowed, requested) ? requested : fallback,
    dir: direction.toLowerCase(),
  };
  Object.defineProperty(result, 'sql', {
    value: `${column} ${direction}`, enumerable: false,
  });
  return result;
}

export const paged = (rows, total, { limit, page }) => ({
  rows,
  pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
});

export function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  return res;
}

/** Content-Disposition for a download, with a safe ASCII fallback name. */
export function attachmentHeaders(res, filename, contentType) {
  const safe = String(filename).replace(/[^\w.\- ]+/g, '_');
  res.set('Content-Type', contentType);
  res.set('Content-Disposition',
    `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  noStore(res);
}
