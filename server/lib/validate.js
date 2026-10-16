import { validationError } from './errors.js';
import { toCents, percentToBps } from './money.js';
import { toDate, toMonth } from './dates.js';

/**
 * Tiny schema validator. Every write endpoint runs its payload through this on
 * the server; frontend validation is a convenience only and is never trusted.
 */
export class Validator {
  constructor(input) {
    this.input = input && typeof input === 'object' ? input : {};
    this.errors = {};
    this.out = {};
  }

  fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return this;
  }

  present(field) {
    const v = this.input[field];
    return !(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''));
  }

  string(field, { required = false, min = 0, max = 2000, label } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const v = String(this.input[field]).trim();
    if (v.length < min) return this.fail(field, name + ' must be at least ' + min + ' characters');
    if (v.length > max) return this.fail(field, name + ' must be at most ' + max + ' characters');
    this.out[field] = v;
    return this;
  }

  email(field, { required = false, label } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const v = String(this.input[field]).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || v.length > 254) {
      return this.fail(field, name + ' must be a valid email address');
    }
    this.out[field] = v;
    return this;
  }

  enum(field, allowed, { required = false, label } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const v = String(this.input[field]).trim();
    if (!allowed.includes(v)) {
      return this.fail(field, name + ' must be one of: ' + allowed.join(', '));
    }
    this.out[field] = v;
    return this;
  }

  int(field, { required = false, min, max, label } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const n = Number(this.input[field]);
    if (!Number.isInteger(n)) return this.fail(field, name + ' must be a whole number');
    if (min !== undefined && n < min) return this.fail(field, name + ' must be at least ' + min);
    if (max !== undefined && n > max) return this.fail(field, name + ' must be at most ' + max);
    this.out[field] = n;
    return this;
  }

  bool(field, { required = false, label } = {}) {
    const name = label || field;
    if (this.input[field] === undefined || this.input[field] === null) {
      if (required) this.fail(field, name + ' is required');
      return this;
    }
    const v = this.input[field];
    this.out[field] = v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0;
    return this;
  }

  /** Money -> integer cents. */
  money(field, { required = false, min, max, label, allowNegative = false } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const cents = toCents(this.input[field]);
    if (cents === null) return this.fail(field, name + ' must be a valid amount');
    if (!allowNegative && cents < 0) return this.fail(field, name + ' cannot be negative');
    if (min !== undefined && cents < min) return this.fail(field, name + ' is below the minimum allowed amount');
    if (max !== undefined && cents > max) return this.fail(field, name + ' exceeds the maximum allowed amount');
    this.out[field] = cents;
    return this;
  }

  /**
   * Money, accepted in exactly one of two unambiguous forms:
   *
   *   `<name>`        a decimal amount in currency units, e.g. "2,000.00"
   *   `<name>_cents`  an explicit integer number of minor units, e.g. 200000
   *
   * Always written out as `<name>_cents`. Sending both is rejected rather than
   * guessed at: a silently mis-scaled amount is the most damaging bug this
   * application could have, so the two notations are never mixed.
   */
  amount(name, { required = false, min, max, label, allowNegative = false } = {}) {
    const centsKey = `${name}_cents`;
    const display = label || name;
    const hasDecimal = this.present(name);
    const hasCents = this.present(centsKey);

    if (hasDecimal && hasCents) {
      return this.fail(centsKey,
        `Send ${display} either as a decimal amount in "${name}" or as whole cents in "${centsKey}", not both`);
    }
    if (!hasDecimal && !hasCents) {
      if (required) this.fail(centsKey, display + ' is required');
      else if (centsKey in this.input || name in this.input) this.out[centsKey] = null;
      return this;
    }

    let cents;
    if (hasCents) {
      const n = Number(this.input[centsKey]);
      if (!Number.isInteger(n) || !Number.isSafeInteger(n)) {
        return this.fail(centsKey, display + ' in cents must be a whole number');
      }
      cents = n;
    } else {
      cents = toCents(this.input[name]);
      if (cents === null) return this.fail(name, display + ' must be a valid amount');
    }

    const key = hasCents ? centsKey : name;
    if (!allowNegative && cents < 0) return this.fail(key, display + ' cannot be negative');
    if (min !== undefined && cents < min) return this.fail(key, display + ' is below the minimum allowed amount');
    if (max !== undefined && cents > max) return this.fail(key, display + ' exceeds the maximum allowed amount');
    this.out[centsKey] = cents;
    return this;
  }

  /**
   * A share, accepted in exactly one of two unambiguous forms:
   *
   *   `<name>`      a percentage, e.g. 30 or 33.33
   *   `<name>_bps`  explicit integer basis points, e.g. 3000
   *
   * Always written out as `<name>_bps`. This mirrors `amount()`: a field whose
   * name says bps must carry bps, so a 30% share can never be stored as 0.3%
   * or as 3000%.
   */
  share(name, { required = false, label, min = 0, max = 10000 } = {}) {
    const bpsKey = `${name}_bps`;
    const display = label || name;
    const hasPercent = this.present(name);
    const hasBps = this.present(bpsKey);

    if (hasPercent && hasBps) {
      return this.fail(bpsKey,
        `Send ${display} either as a percentage in "${name}" or as basis points in "${bpsKey}", not both`);
    }
    if (!hasPercent && !hasBps) {
      if (required) this.fail(bpsKey, display + ' is required');
      else if (bpsKey in this.input || name in this.input) this.out[bpsKey] = null;
      return this;
    }

    let bps;
    if (hasBps) {
      const n = Number(this.input[bpsKey]);
      if (!Number.isInteger(n)) return this.fail(bpsKey, display + ' in basis points must be a whole number');
      bps = n;
    } else {
      bps = percentToBps(this.input[name]);
      if (bps === null) return this.fail(name, display + ' must be a valid percentage');
    }

    const key = hasBps ? bpsKey : name;
    if (bps < min) return this.fail(key, display + ' cannot be below ' + min / 100 + '%');
    if (bps > max) return this.fail(key, display + ' cannot exceed ' + max / 100 + '%');
    this.out[bpsKey] = bps;
    return this;
  }

  /** Percentage -> integer basis points (30 becomes 3000). */
  percent(field, { required = false, label, min = 0, max = 1000000 } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const bps = percentToBps(this.input[field]);
    if (bps === null) return this.fail(field, name + ' must be a valid percentage');
    if (bps < min) return this.fail(field, name + ' cannot be below ' + min / 100 + '%');
    if (bps > max) return this.fail(field, name + ' cannot exceed ' + max / 100 + '%');
    this.out[field] = bps;
    return this;
  }

  date(field, { required = false, label } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const v = toDate(this.input[field]);
    if (!v) return this.fail(field, name + ' must be a valid date (YYYY-MM-DD)');
    this.out[field] = v;
    return this;
  }

  /**
   * Accounting month. Accepts 'YYYY-MM' or a month-start date, and is NEVER
   * populated from another date field.
   */
  month(field, { required = false, label } = {}) {
    const name = label || field;
    if (!this.present(field)) {
      if (required) this.fail(field, name + ' is required');
      else if (field in this.input) this.out[field] = null;
      return this;
    }
    const v = toMonth(this.input[field]);
    if (!v) return this.fail(field, name + ' must be a valid month (YYYY-MM)');
    this.out[field] = v;
    return this;
  }

  array(field, { required = false, max = 500, label } = {}) {
    const name = label || field;
    const v = this.input[field];
    if (v === undefined || v === null) {
      if (required) this.fail(field, name + ' is required');
      return this;
    }
    if (!Array.isArray(v)) return this.fail(field, name + ' must be a list');
    if (v.length > max) return this.fail(field, name + ' has too many entries');
    this.out[field] = v;
    return this;
  }

  custom(field, message, predicate) {
    if (!predicate()) this.fail(field, message);
    return this;
  }

  get valid() { return Object.keys(this.errors).length === 0; }

  /** Throw a 422 if anything failed, otherwise return the coerced payload. */
  result() {
    if (!this.valid) throw validationError(this.errors);
    return this.out;
  }
}

export const check = (input) => new Validator(input);
