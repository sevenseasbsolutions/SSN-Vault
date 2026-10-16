/**
 * Display formatting.
 *
 * All amounts arrive from the API as integer cents and are formatted here.
 * No arithmetic happens in the browser beyond presentation; the server is the
 * authority for every total.
 */

export const state = { currency: '$' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function money(cents, { signed = false, blankZero = false } = {}) {
  if (cents === null || cents === undefined || cents === '') return '—';
  const n = Math.trunc(Number(cents));
  if (blankZero && n === 0) return '—';
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  const sign = negative ? '-' : (signed && n > 0 ? '+' : '');
  return `${sign}${state.currency}${whole}.${frac}`;
}

/** Compact form for chart axes: $12.4k */
export function moneyShort(cents) {
  const n = Number(cents) / 100;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${state.currency}${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 1000) return `${sign}${state.currency}${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}${state.currency}${abs.toFixed(0)}`;
}

export const percent = (bps) =>
  bps === null || bps === undefined ? '—' : `${(Number(bps) / 100).toFixed(2)}%`;

/** 'YYYY-MM-01' or 'YYYY-MM' -> 'August 2026' */
export function monthLabel(value) {
  if (!value) return '—';
  const key = String(value).slice(0, 7);
  const [year, month] = key.split('-');
  const index = Number(month) - 1;
  return MONTHS[index] ? `${MONTHS[index]} ${year}` : key;
}

export const monthValue = (value) => (value ? String(value).slice(0, 7) : '');

/** 'YYYY-MM-DD' -> 'Sep 03, 2026'. Never constructs a Date, so no TZ drift. */
export function dateLabel(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  const index = Number(month) - 1;
  return MONTHS[index] ? `${MONTHS[index].slice(0, 3)} ${day}, ${year}` : String(value);
}

/** 'Jul 21 – Aug 05, 2026' */
export function periodLabel(from, to) {
  if (!from || !to) return '—';
  const short = (d) => {
    const [, m, day] = String(d).slice(0, 10).split('-');
    return `${MONTHS[Number(m) - 1].slice(0, 3)} ${day}`;
  };
  const yearFrom = String(from).slice(0, 4);
  const yearTo = String(to).slice(0, 4);
  return yearFrom === yearTo
    ? `${short(from)} – ${short(to)}, ${yearTo}`
    : `${short(from)}, ${yearFrom} – ${short(to)}, ${yearTo}`;
}

export function timestampLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export const titleCase = (value) =>
  String(value ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const todayValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const currentMonthValue = () => todayValue().slice(0, 7);

export function addMonthsValue(monthKey, delta) {
  const [year, month] = String(monthKey).split('-').map(Number);
  const total = year * 12 + (month - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Parse a typed money string into integer cents, mirroring the server parser. */
export function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().replace(/[\s,_$]/g, '');
  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === '' || raw === '-' || raw === '.') return null;
  const negative = raw.startsWith('-');
  const [whole = '0', frac = ''] = raw.replace('-', '').split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

export const centsToInput = (cents) =>
  cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2);
