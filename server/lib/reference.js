/**
 * Per-month reference numbers: JOB-202610-0001, EX-202610-0001.
 *
 * The sequence comes from the HIGHEST number already issued for that prefix,
 * never from a row count. A count-based sequence looks identical until the
 * first record is deleted: the count then no longer matches the top of the
 * sequence, so it reissues a reference that already exists and the unique
 * index rejects every later insert for that month, permanently. This module
 * exists so that mistake cannot be made once per table.
 */

import { queryOne, isUniqueViolation } from '../db/connection.js';
import { monthKey } from './dates.js';

const MAX_ATTEMPTS = 5;

/** e.g. ('JOB', '2026-10') -> 'JOB-202610' */
export const referencePrefix = (kind, month) => `${kind}-${monthKey(month).replace('-', '')}`;

/**
 * The next free reference for a table's per-month sequence.
 *
 * `table` is interpolated, so it must come from this codebase and never from a
 * request. Every caller passes a literal.
 */
export function nextReference(table, kind, month) {
  const prefix = referencePrefix(kind, month);
  const row = queryOne(
    `SELECT MAX(CAST(substr(reference, $from) AS INTEGER)) AS n
       FROM ${table} WHERE reference LIKE $like`,
    { from: prefix.length + 2, like: `${prefix}-%` }
  );
  return `${prefix}-${String(Number(row.n ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * Insert a row that carries a generated reference, retrying if a concurrent
 * writer took the number first.
 *
 * `build(reference)` must perform the insert and return whatever the caller
 * wants back. On a unique violation the reference is re-derived rather than
 * mangled with a suffix, so references stay in a clean sequence under
 * concurrency instead of degrading to JOB-202610-0003-2.
 */
export function insertWithReference(table, kind, month, build) {
  let reference = nextReference(table, kind, month);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return build(reference);
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      reference = nextReference(table, kind, month);
    }
  }
}
