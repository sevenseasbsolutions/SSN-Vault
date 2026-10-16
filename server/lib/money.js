/**
 * Decimal-safe monetary arithmetic.
 *
 * ACCOUNTING ASSUMPTION: all money is stored and computed as an integer number
 * of minor units ("cents"). Binary floating point is never used for arithmetic
 * that reaches the database or a reconciliation. Floats appear only at the very
 * edge, when parsing user input, and the parse is done on the decimal string.
 */

export const MINOR_UNITS = 100;

/** Parse a user-supplied money value ("1,234.56", 1234.56, "-12") to integer cents. */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Round half-away-from-zero on the decimal representation, not the binary one.
    return toCents(value.toFixed(6));
  }
  const raw = String(value).trim().replace(/[\s,_]/g, '').replace(/^\$/, '');
  const m = /^(-|\+)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) return null;
  const [, sign, intPart = '', fracPart = ''] = m;
  if (intPart === '' && fracPart === '') return null;
  const whole = intPart === '' ? 0n : BigInt(intPart);
  const fracDigits = (fracPart + '000000').slice(0, 6);
  const frac = BigInt(fracDigits);
  // scale 1e6 -> cents (1e2) with half-up rounding on the remainder
  const scaled = whole * 1000000n + frac;
  const divisor = 10000n; // 1e6 / 1e2
  const q = scaled / divisor;
  const r = scaled % divisor;
  let cents = q + (r * 2n >= divisor ? 1n : 0n);
  if (sign === '-') cents = -cents;
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/** Integer cents -> fixed 2dp decimal string, e.g. -1234 -> "-12.34". */
export function fromCents(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / MINOR_UNITS);
  const frac = abs % MINOR_UNITS;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Display helper: "$1,234.56" / "-$1,234.56". */
export function formatMoney(cents, currency = '$') {
  const s = fromCents(cents);
  const neg = s.startsWith('-');
  const [whole, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${currency}${grouped}.${frac}`;
}

export const sum = (values) => values.reduce((acc, v) => acc + Math.trunc(Number(v) || 0), 0);

/** Basis points: 3000 bps = 30%. Percentages are stored as integer bps, never floats. */
export function percentToBps(pct) {
  if (pct === null || pct === undefined || pct === '') return null;
  const cents = toCents(pct); // reuse the 2dp decimal parser: 30.25% -> 3025 bps
  return cents;
}

export const bpsToPercent = (bps) => fromCents(bps);

/**
 * cents * bps / 10000, truncated toward zero, plus the exact remainder so the
 * caller can perform largest-remainder apportionment.
 */
export function applyBps(cents, bps) {
  const n = BigInt(Math.trunc(cents));
  const b = BigInt(Math.trunc(bps));
  const product = n * b;
  const base = product / 10000n;
  const remainder = product - base * 10000n; // signed, same sign as product
  return { base: Number(base), remainder: Number(remainder) };
}


/**
 * Split `total` cents across arbitrary weights, exactly.
 *
 * Where `apportion` divides by a percentage, this divides by a measure -- each
 * SSN's own revenue, say -- and the parts always sum to `total` to the
 * cent. That exactness is what lets a per-SSN figure stay reconciled
 * with the company total it rolls up into.
 *
 * Largest remainder with the same stable tie-break on `key`, so the same inputs
 * always produce the same split. With no weight to divide by, nothing is
 * invented: every part is zero and the caller keeps the total.
 *
 * Integer arithmetic throughout, via BigInt, so no cent is lost to binary
 * floating point however large the amounts.
 */
export function apportionByWeight(total, parts) {
  const weights = parts.map((p) => BigInt(Math.trunc(Number(p.weight) || 0)));
  const weightTotal = weights.reduce((a, b) => a + b, 0n);
  if (weightTotal === 0n) return parts.map((p) => ({ ...p, amount: 0 }));

  const cents = BigInt(Math.trunc(Number(total) || 0));
  const computed = parts.map((p, i) => {
    const product = cents * weights[i];
    const base = product / weightTotal;                 // truncates toward zero
    const remainder = product - base * weightTotal;     // signed like product
    return { ...p, amount: Number(base), remainder: Number(remainder < 0n ? -remainder : remainder) };
  });

  const distributed = computed.reduce((acc, c) => acc + c.amount, 0);
  const shortfall = Number(cents) - distributed;
  if (shortfall !== 0) {
    const step = shortfall > 0 ? 1 : -1;
    const order = [...computed].sort(
      (a, b) => b.remainder - a.remainder || String(a.key).localeCompare(String(b.key))
    );
    for (let i = 0; i < Math.abs(shortfall); i += 1) {
      order[i % order.length].amount += step;
    }
  }
  return computed.map(({ remainder, ...rest }) => rest);
}

/**
 * Split `total` cents across weights (bps) deterministically.
 *
 * Uses largest-remainder apportionment with a stable tie-break on the caller's
 * `key`, so the same inputs always produce the same cent-level split and the
 * parts always sum exactly to `floor-able` total weighted amount. Any remaining
 * cent after the weighted split (because weights sum to < 100%) is NOT invented:
 * it stays with the caller (typically the owner residual).
 */
export function apportion(total, parts) {
  const computed = parts.map((p) => {
    const { base, remainder } = applyBps(total, p.bps);
    return { ...p, amount: base, remainder: Math.abs(remainder) };
  });
  const targetTotal = applyBps(total, sum(parts.map((p) => p.bps))).base;
  let distributed = sum(computed.map((c) => c.amount));
  let shortfall = targetTotal - distributed;
  if (shortfall !== 0) {
    const step = shortfall > 0 ? 1 : -1;
    const order = [...computed].sort(
      (a, b) => b.remainder - a.remainder || String(a.key).localeCompare(String(b.key))
    );
    for (let i = 0; i < Math.abs(shortfall); i += 1) {
      order[i % order.length].amount += step;
    }
  }
  return computed.map(({ remainder, ...rest }) => rest);
}
