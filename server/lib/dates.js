/**
 * Date-only handling.
 *
 * ACCOUNTING ASSUMPTION: pay_period_from, pay_period_to, credit_date,
 * expense_date and accounting_month are *calendar facts*, not instants. They are
 * stored as 'YYYY-MM-DD' TEXT and are never passed through a Date object in a
 * way that could shift them across a timezone boundary. All comparison is
 * lexicographic, which is correct for zero-padded ISO date strings.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function daysInMonth(year, month) {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Validate and normalise a date-only input. Returns 'YYYY-MM-DD' or null. */
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().slice(0, 10);
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return s;
}

/**
 * Normalise an accounting month to its month-start date 'YYYY-MM-01'.
 * Accepts 'YYYY-MM', 'YYYY-MM-DD', or { year, month }.
 *
 * This is the ONLY place a month is derived, and it is derived from an
 * explicitly supplied month value -- never from a credit date or pay period.
 */
export function toMonth(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value.year && value.month) {
    const y = Number(value.year);
    const mo = Number(value.month);
    if (!Number.isInteger(y) || !Number.isInteger(mo) || mo < 1 || mo > 12) return null;
    if (y < 1900 || y > 9999) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01`;
  }
  const s = String(value).trim();
  const mm = MONTH_RE.exec(s);
  if (mm) return toMonth({ year: Number(mm[1]), month: Number(mm[2]) });
  const d = toDate(s);
  if (!d) return null;
  return `${d.slice(0, 7)}-01`;
}

export const monthKey = (monthStart) => String(monthStart).slice(0, 7);

/** 'YYYY-MM-01' -> 'August 2026' */
export function formatMonth(monthStart) {
  const key = monthKey(monthStart);
  const mm = MONTH_RE.exec(key);
  if (!mm) return String(monthStart ?? '');
  return `${MONTH_NAMES[Number(mm[2]) - 1]} ${mm[1]}`;
}

/** Inclusive list of month-start dates between two months. */
export function monthRange(fromMonth, toMonthValue) {
  const a = toMonth(fromMonth);
  const b = toMonth(toMonthValue);
  if (!a || !b || a > b) return [];
  const out = [];
  let year = Number(a.slice(0, 4));
  let month = Number(a.slice(5, 7));
  const endYear = Number(b.slice(0, 4));
  const endMonth = Number(b.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(toMonth({ year, month }));
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    if (out.length > 2400) break; // hard safety bound
  }
  return out;
}

export function addMonths(monthStart, delta) {
  const base = toMonth(monthStart);
  if (!base) return null;
  let year = Number(base.slice(0, 4));
  let month = Number(base.slice(5, 7)) + Number(delta);
  year += Math.floor((month - 1) / 12);
  month = ((((month - 1) % 12) + 12) % 12) + 1;
  return toMonth({ year, month });
}

/** Last calendar day of an accounting month, as 'YYYY-MM-DD'. */
export function monthEnd(monthStart) {
  const base = toMonth(monthStart);
  if (!base) return null;
  const year = Number(base.slice(0, 4));
  const month = Number(base.slice(5, 7));
  return `${base.slice(0, 7)}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

/** Two closed intervals overlap iff aFrom <= bTo AND aTo >= bFrom. */
export function intervalsOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && aTo >= bFrom;
}

/** Today in the server's local calendar, as a date-only string. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const nowIso = () => new Date().toISOString();

/**
 * The accounting month we are currently in, canonically 'YYYY-MM-01'.
 *
 * Note that monthKey() and toMonth() are not interchangeable: toMonth() gives
 * the canonical month-start that the database stores and that month arithmetic
 * expects, while monthKey() only trims a string to 'YYYY-MM' for display.
 * Passing a Date to either returns nothing useful, which is why this exists.
 */
export const currentMonth = () => toMonth(today());

/** 'Jul 21 - Aug 05, 2026' compact pay-period label (same year collapses). */
export function formatPeriod(from, to) {
  if (!from || !to) return '';
  const short = (d) => `${MONTH_NAMES[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(8, 10)}`;
  const yearFrom = from.slice(0, 4);
  const yearTo = to.slice(0, 4);
  if (yearFrom === yearTo) return `${short(from)} \u2013 ${short(to)}, ${yearTo}`;
  return `${short(from)}, ${yearFrom} \u2013 ${short(to)}, ${yearTo}`;
}

/** 'Sep 03, 2026' */
export function formatDate(d) {
  const v = toDate(d);
  if (!v) return '';
  return `${MONTH_NAMES[Number(v.slice(5, 7)) - 1].slice(0, 3)} ${v.slice(8, 10)}, ${v.slice(0, 4)}`;
}

/** Quarter/YTD/month presets, resolved against a reference date. */
export function resolvePreset(preset, ref = today()) {
  const year = Number(ref.slice(0, 4));
  const month = Number(ref.slice(5, 7));
  switch (preset) {
    case 'this_month':
      return { monthFrom: toMonth({ year, month }), monthTo: toMonth({ year, month }) };
    case 'last_month': {
      const prev = addMonths(toMonth({ year, month }), -1);
      return { monthFrom: prev, monthTo: prev };
    }
    case 'this_quarter': {
      const qStart = Math.floor((month - 1) / 3) * 3 + 1;
      return { monthFrom: toMonth({ year, month: qStart }), monthTo: toMonth({ year, month: qStart + 2 }) };
    }
    case 'year_to_date':
      return { monthFrom: toMonth({ year, month: 1 }), monthTo: toMonth({ year, month }) };
    case 'last_year':
      return { monthFrom: toMonth({ year: year - 1, month: 1 }), monthTo: toMonth({ year: year - 1, month: 12 }) };
    default:
      return {};
  }
}
