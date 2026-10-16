/**
 * Unit tests for the primitives the whole system rests on: decimal-safe money
 * arithmetic and timezone-safe date-only handling.
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shutdown, money, dates } from './helpers.js';

after(shutdown);

describe('money', () => {
  test('parses decimal strings to exact cents', () => {
    assert.equal(money.toCents('2000.00'), 200000);
    assert.equal(money.toCents('2,000.00'), 200000);
    assert.equal(money.toCents('$1,234.56'), 123456);
    assert.equal(money.toCents('0.01'), 1);
    assert.equal(money.toCents('-12.34'), -1234);
    assert.equal(money.toCents('10'), 1000);
    assert.equal(money.toCents('.5'), 50);
    assert.equal(money.toCents(''), null);
    assert.equal(money.toCents('abc'), null);
    assert.equal(money.toCents('1.2.3'), null);
  });

  test('rounds half away from zero on the decimal, not the binary, value', () => {
    assert.equal(money.toCents('0.005'), 1);
    assert.equal(money.toCents('0.004'), 0);
    assert.equal(money.toCents('2.675'), 268,
      'the classic binary floating-point trap: 2.675 must round to 2.68');
    assert.equal(money.toCents(1.005), 101);
  });

  test('avoids floating-point drift when summing', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; in cents it is exact.
    const total = money.sum([money.toCents('0.1'), money.toCents('0.2')]);
    assert.equal(total, money.toCents('0.30'));
    assert.equal(money.fromCents(total), '0.30');

    const hundredCents = Array.from({ length: 100 }, () => money.toCents('0.01'));
    assert.equal(money.sum(hundredCents), 100);
    assert.equal(money.fromCents(money.sum(hundredCents)), '1.00');
  });

  test('formats cents back to a fixed two-decimal string', () => {
    assert.equal(money.fromCents(200000), '2000.00');
    assert.equal(money.fromCents(-1234), '-12.34');
    assert.equal(money.fromCents(5), '0.05');
    assert.equal(money.fromCents(0), '0.00');
    assert.equal(money.formatMoney(720000), '$7,200.00');
    assert.equal(money.formatMoney(-123456789), '-$1,234,567.89');
  });

  test('applies basis points exactly', () => {
    assert.equal(money.applyBps(720000, 3000).base, 216000, '30% of $7,200 is $2,160');
    assert.equal(money.applyBps(900000, 2000).base, 180000, '20% of $9,000 is $1,800');
    assert.equal(money.percentToBps('30'), 3000);
    assert.equal(money.percentToBps('33.33'), 3333);
    assert.equal(money.percentToBps('100'), 10000);
  });

  test('apportions a remainder deterministically and without inventing cents', () => {
    const thirds = [
      { key: 'a', bps: 3333 }, { key: 'b', bps: 3333 }, { key: 'c', bps: 3334 },
    ];
    const split = money.apportion(100, thirds);
    assert.equal(money.sum(split.map((s) => s.amount)), 100);

    // The same inputs always give the same split.
    const again = money.apportion(100, thirds);
    assert.deepEqual(split, again);

    // A balance that divides unevenly across equal shares still reconciles.
    const equal = money.apportion(1000, [
      { key: 'a', bps: 3333 }, { key: 'b', bps: 3333 }, { key: 'c', bps: 3333 },
    ]);
    assert.equal(money.sum(equal.map((s) => s.amount)), 999,
      'weights summing to 99.99% must not be rounded up to the whole balance');
  });
});

describe('dates', () => {
  test('normalises an accounting month only from an explicit month value', () => {
    assert.equal(dates.toMonth('2026-08'), '2026-08-01');
    assert.equal(dates.toMonth('2026-08-31'), '2026-08-01');
    assert.equal(dates.toMonth({ year: 2026, month: 8 }), '2026-08-01');
    assert.equal(dates.toMonth('nonsense'), null);
    assert.equal(dates.toMonth(''), null);
  });

  test('validates real calendar dates', () => {
    assert.equal(dates.toDate('2024-02-29'), '2024-02-29', 'a leap day is valid');
    assert.equal(dates.toDate('2026-02-29'), null, 'but not in a non-leap year');
    assert.equal(dates.toDate('2026-02-30'), null);
    assert.equal(dates.toDate('2026-13-01'), null);
    assert.equal(dates.toDate('2026-00-10'), null);
  });

  test('never shifts a date-only value across a timezone', () => {
    // A naive `new Date('2026-08-01')` in a negative-offset zone can render as
    // July 31. These helpers are pure string operations, so they cannot.
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      assert.equal(dates.toMonth('2026-08-01'), '2026-08-01');
      assert.equal(dates.formatMonth('2026-08-01'), 'August 2026');
      assert.equal(dates.formatDate('2026-09-03'), 'Sep 03, 2026');
      assert.equal(dates.monthEnd('2026-02-01'), '2026-02-28');
    }
    process.env.TZ = 'UTC';
  });

  test('detects closed-interval overlap in both directions', () => {
    const overlaps = (a, b, c, d) => dates.intervalsOverlap(a, b, c, d);
    assert.equal(overlaps('2026-07-21', '2026-08-05', '2026-07-25', '2026-08-10'), true);
    assert.equal(overlaps('2026-08-06', '2026-08-12', '2026-07-25', '2026-08-10'), true);
    assert.equal(overlaps('2026-08-11', '2026-08-20', '2026-07-25', '2026-08-10'), false);
    assert.equal(overlaps('2026-07-01', '2026-07-10', '2026-07-25', '2026-08-10'), false);
    assert.equal(overlaps('2026-08-10', '2026-08-10', '2026-07-25', '2026-08-10'), true,
      'a single-day period touching the boundary overlaps');
  });

  test('walks months across a year boundary', () => {
    assert.deepEqual(dates.monthRange('2026-11', '2027-02'),
      ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
    assert.equal(dates.addMonths('2026-12-01', 1), '2027-01-01');
    assert.equal(dates.addMonths('2026-01-01', -1), '2025-12-01');
    assert.deepEqual(dates.monthRange('2026-05', '2026-04'), [], 'an inverted range is empty');
  });

  test('formats a compact pay period', () => {
    assert.equal(dates.formatPeriod('2026-07-21', '2026-08-05'), 'Jul 21 – Aug 05, 2026');
    assert.equal(dates.formatPeriod('2026-12-28', '2027-01-03'), 'Dec 28, 2026 – Jan 03, 2027');
  });
});
