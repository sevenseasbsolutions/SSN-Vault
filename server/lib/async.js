/**
 * Map over a list with an async function, one item at a time, keeping order.
 *
 * The database calls this is used for share one connection inside a request's
 * transaction, so running them "in parallel" would only queue them anyway;
 * doing it in series keeps the order obvious and the connection pool calm.
 */
export async function mapSeries(items, fn) {
  const out = [];
  for (const [index, item] of [...items].entries()) out.push(await fn(item, index));
  return out;
}
