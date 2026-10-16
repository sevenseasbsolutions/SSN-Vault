/**
 * Which months a page is being asked about.
 *
 * Two ways to ask, and exactly one may be used at a time:
 *
 *   month=YYYY-MM              one accounting month
 *   date_from=…&date_to=…      a span of dates
 *
 * A date span is answered in whole accounting months: every month the dates
 * touch is included, start to finish. That is not a rounding convenience --
 * this system has no per-day ledger. A salary belongs to the month it was
 * recorded against, an expense to the month it was charged to, and a share is
 * split once per month. Half a month cannot be totalled without inventing a
 * basis the statements do not share, so the dates choose months and the
 * caller is told plainly which ones came back.
 *
 * month_from/month_to are still accepted so older links and saved reports
 * keep working; the filter bars no longer produce them.
 */

import { toDate, toMonth, currentMonth } from '../lib/dates.js';
import { validationError } from '../lib/errors.js';
import { activeMonths } from './rollup.js';

const MONTH_PARAMS = ['month', 'month_from', 'month_to'];

/** The outer bounds of everything recorded, for a range left open at one end. */
function activeSpan() {
  const months = activeMonths();
  return {
    earliest: months[months.length - 1] ?? currentMonth(),
    latest: months[0] ?? currentMonth(),
  };
}

/** A date filter must be a real date; a typo must not quietly widen the range. */
function boundDate(name, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const date = toDate(raw);
  if (!date) throw validationError({ [name]: 'Not a real date' });
  return date;
}

/**
 * Read the range filters off a request.
 *
 * Returns the canonical month bounds plus the basis they were chosen by, so a
 * page can label what it is showing with the dates that were actually typed
 * rather than the months they resolved to.
 */
export function resolveRange(req) {
  const given = req.query ?? {};
  const dateFrom = boundDate('date_from', given.date_from);
  const dateTo = boundDate('date_to', given.date_to);

  if (dateFrom || dateTo) {
    /*
     * Refused rather than resolved by precedence: a request carrying both a
     * month and a date span has two different answers in it, and silently
     * picking one would show figures nobody asked for.
     */
    const alsoMonth = MONTH_PARAMS.find((param) => given[param]);
    if (alsoMonth) {
      throw validationError({
        [alsoMonth]: 'Choose either a single month or a date range, not both',
      });
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw validationError({ date_from: 'The start date is after the end date' });
    }
    const span = activeSpan();
    return {
      basis: 'dates',
      date_from: dateFrom,
      date_to: dateTo,
      from: dateFrom ? toMonth(dateFrom) : span.earliest,
      to: dateTo ? toMonth(dateTo) : span.latest,
    };
  }

  const single = toMonth(given.month);
  const from = toMonth(given.month_from) ?? single;
  const to = toMonth(given.month_to) ?? single;

  // Nothing asked for: the newest month with any activity, which is what the
  // pages showed before any filter existed.
  if (!from && !to) {
    const latest = activeMonths({ limit: 1 })[0] ?? currentMonth();
    return { basis: 'month', date_from: null, date_to: null, from: latest, to: latest };
  }

  const span = activeSpan();
  return {
    basis: 'month',
    date_from: null,
    date_to: null,
    from: from ?? span.earliest,
    to: to ?? span.latest,
  };
}
