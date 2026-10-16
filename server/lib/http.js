import { badRequest } from './errors.js';

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export const handler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
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
