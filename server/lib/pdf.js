/**
 * PDF rendering for an SSN statement.
 *
 * Layout only. Every figure arrives already computed by services/rollup.js --
 * nothing here adds, subtracts or rounds, so a PDF cannot disagree with the
 * screen it was printed from.
 *
 * Built on pdfkit's standard Helvetica, so no font file has to ship or be
 * found at runtime. That constrains the currency symbol: see `moneyFor`.
 */

import PDFDocument from 'pdfkit';
import { fromCents } from './money.js';
import { formatMonth, formatDate, formatPeriod } from './dates.js';

const PAGE = { size: 'A4', margin: 40 };
const INK = '#111827';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const RULE = '#e5e7eb';
const BAND = '#f3f4f6';

/**
 * A money formatter safe for the built-in fonts.
 *
 * Helvetica is WinAnsi-encoded, so a symbol outside Latin-1 -- a rupee sign,
 * say -- would either throw or print as a bare box. Those fall back to the
 * currency code, which is always ASCII and always readable.
 */
function moneyFor(settings) {
  const symbol = String(settings.currency_symbol ?? '$');
  const printable = [...symbol].every((ch) => ch.codePointAt(0) <= 0xff);
  const prefix = printable ? symbol : `${settings.currency_code ?? 'USD'} `;

  return (cents, { signed = false } = {}) => {
    const n = Math.trunc(Number(cents) || 0);
    const body = fromCents(Math.abs(n));
    const [whole, frac] = body.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const sign = n < 0 ? '-' : (signed && n > 0 ? '+' : '');
    return `${sign}${prefix}${grouped}.${frac}`;
  };
}

const percent = (bps) => (bps === null || bps === undefined ? '—' : `${(bps / 100).toFixed(2)}%`);

/**
 * Render the statement and resolve to a Buffer.
 *
 * pdfkit streams, so the chunks are collected rather than written to disk --
 * the route sends it straight to the client and nothing touches the filesystem.
 */
export function statementPdf({ statement: s, salaries, expenses, settings, orgName, generatedBy }) {
  const money = moneyFor(settings);
  const doc = new PDFDocument({ ...PAGE, info: {
    Title: `${s.ssn_name} statement — ${formatMonth(s.accounting_month)}`,
    Author: orgName,
    Creator: orgName,
  } });

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  /** Start a new page when `needed` points will not fit. */
  const room = (needed) => {
    if (doc.y + needed > bottom()) {
      doc.addPage();
      return true;
    }
    return false;
  };

  const rule = (y = doc.y) => {
    doc.save().moveTo(left, y).lineTo(right, y)
      .lineWidth(0.5).strokeColor(RULE).stroke().restore();
  };

  /* ------------------------------------------------------------- the header -- */

  doc.font('Helvetica-Bold').fontSize(9).fillColor(FAINT)
    .text(orgName.toUpperCase(), left, doc.y, { characterSpacing: 1.2 });
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK)
    .text(`${s.ssn_name} · ${formatMonth(s.accounting_month)}`);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(s.sub_name ? `SSN statement · under ${s.sub_name}` : 'SSN statement');
  doc.moveDown(0.8);
  rule();
  doc.moveDown(0.8);

  /* ---------------------------------------------------------- the waterfall -- */
  /*
   * The same lines, in the same order, as the statement on screen. A reader
   * holding both should not have to work out which is which.
   */
  const step = (label, value, { note = null, kind = '' } = {}) => {
    room(34);
    const top = doc.y;
    const h = note ? 30 : 20;

    if (kind.includes('subtotal')) {
      doc.save().rect(left, top - 3, width, h).fillColor(BAND).fill().restore();
    }

    const strong = kind.includes('strong');
    doc.font(strong || kind.includes('subtotal') ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(strong ? 12 : 10.5).fillColor(INK)
      .text(label, left + 6, top, { width: width * 0.62, continued: false });

    if (note) {
      doc.font('Helvetica').fontSize(8).fillColor(FAINT)
        .text(note, left + 6, top + 12, { width: width * 0.62 });
    }

    doc.font('Helvetica-Bold').fontSize(strong ? 13 : 11)
      .fillColor(kind.includes('minus') ? '#b45309' : INK)
      .text(money(value, { signed: kind.includes('minus') }),
        left + width * 0.62, top + (note ? 4 : 1),
        { width: width * 0.38 - 6, align: 'right' });

    doc.y = top + h;
    if (!kind.includes('subtotal')) rule(doc.y - 2);
  };

  step('Invoiced', s.invoice_cents, {
    kind: 'plus',
    note: `${s.salary_count} salar${s.salary_count === 1 ? 'y' : 'ies'} across `
      + `${s.job_count} job${s.job_count === 1 ? '' : 's'}`,
  });
  step('Deducted by companies (W2)', -s.withheld_cents, {
    kind: 'minus', note: 'before the money was credited',
  });
  step('Credited', s.credited_cents, { kind: 'subtotal' });
  step('Tax Hold', -s.tax_hold_cents, {
    kind: 'minus',
    note: s.tax_basis === 'override'
      ? `overridden — ${s.tax_override_reason} (the salaries come to ${money(s.computed_tax_cents)})`
      : (s.tax_basis === 'per_job'
        ? 'each job’s own rate, on its own credited amount'
        : 'nothing credited, so nothing held'),
  });
  step(`To ${s.ssn_name}`, s.salary_cents, { kind: 'subtotal' });
  step('Expenses', -s.expense_cents, { kind: 'minus', note: 'charged to this SSN' });
  step('Remaining', s.distributable_cents, { kind: 'subtotal strong' });

  /* --------------------------------------------------------------- the split -- */

  doc.moveDown(0.8);
  room(74);
  const splitTop = doc.y;
  const halfW = (width - 12) / 2;

  const half = (x, label, value, note, tint) => {
    doc.save().rect(x, splitTop, halfW, 60).lineWidth(0.8)
      .fillColor(tint).fillAndStroke(tint, RULE).restore();
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text(label, x + 10, splitTop + 10, { width: halfW - 20 });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
      .text(value, x + 10, splitTop + 24, { width: halfW - 20 });
    doc.font('Helvetica').fontSize(8).fillColor(FAINT)
      .text(note, x + 10, splitTop + 45, { width: halfW - 20 });
  };

  half(left, `${s.ssn_name} keeps`, money(s.keep_cents),
    `${percent(s.share_bps)} of what remains`, '#eff6ff');
  half(left + halfW + 12, `Up to ${s.sub_name ?? 'the sub-company'}`, money(s.upstream_cents),
    `${percent(10000 - s.share_bps)} of what remains`, '#ecfdf5');

  doc.y = splitTop + 60;
  doc.moveDown(0.6);

  // The reconciliation, stated rather than implied: the two halves must add
  // back to what remained, and the reader can check it by eye.
  const reconciles = s.keep_cents + s.upstream_cents === s.distributable_cents;
  doc.font('Helvetica').fontSize(9).fillColor(reconciles ? MUTED : '#b91c1c')
    .text(reconciles
      ? `${money(s.keep_cents)} + ${money(s.upstream_cents)} = ${money(s.distributable_cents)}`
      : 'These figures do not reconcile — please report this.', left, doc.y);

  if (s.distributable_cents < 0) {
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#b45309').text(
      'This month made a loss. The SSN carries it in full and nothing is passed up.',
      left, doc.y
    );
  }

  /* ------------------------------------------------------------- the tables -- */

  const table = ({ heading, columns, rows, footer, emptyNote }) => {
    doc.moveDown(1.4);
    room(90);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED)
      .text(heading.toUpperCase(), left, doc.y, { characterSpacing: 0.8 });
    doc.moveDown(0.5);

    if (!rows.length) {
      doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(FAINT).text(emptyNote, left, doc.y);
      return;
    }

    const total = columns.reduce((a, c) => a + c.w, 0);
    const xs = [];
    let x = left;
    for (const c of columns) { xs.push(x); x += (c.w / total) * width; }
    const colW = columns.map((c) => (c.w / total) * width);

    const header = () => {
      const top = doc.y;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
      columns.forEach((c, i) => doc.text(c.header.toUpperCase(), xs[i], top, {
        width: colW[i] - 6, align: c.align ?? 'left', characterSpacing: 0.5,
      }));
      doc.y = top + 12;
      rule(doc.y - 2);
    };
    header();

    doc.font('Helvetica').fontSize(9).fillColor(INK);
    for (const row of rows) {
      if (room(26)) header();
      const top = doc.y;
      let tallest = 12;
      columns.forEach((c, i) => {
        const text = String(c.value(row) ?? '—');
        doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK);
        doc.text(text, xs[i], top, { width: colW[i] - 6, align: c.align ?? 'left' });
        tallest = Math.max(tallest, doc.y - top);
      });
      doc.y = top + tallest + 4;
      rule(doc.y - 2);
    }

    if (footer) {
      const top = doc.y + 1;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
      columns.forEach((c, i) => {
        const text = footer[c.key];
        if (text === undefined || text === null) return;
        doc.text(String(text), xs[i], top, { width: colW[i] - 6, align: c.align ?? 'left' });
      });
      doc.y = top + 14;
    }
  };

  table({
    heading: `Salaries · ${formatMonth(s.accounting_month)}`,
    columns: [
      { key: 'reference', header: 'Reference', w: 16, value: (r) => r.reference },
      { key: 'job', header: 'Job', w: 26, value: (r) => (r.client_name
        ? `${r.job_title}\n${r.client_name}` : r.job_title) },
      { key: 'terms', header: 'Terms', w: 13, value: (r) =>
        `${r.tax_category === 'w2' ? 'W2' : '1099'} · ${percent(r.tax_hold_bps)}` },
      { key: 'period', header: 'Pay period', w: 16, value: (r) =>
        (r.pay_period_from || r.pay_period_to
          ? formatPeriod(r.pay_period_from, r.pay_period_to) || '—' : '—') },
      { key: 'invoice', header: 'Invoiced', w: 13, align: 'right',
        value: (r) => money(r.invoice_cents) },
      { key: 'withheld', header: 'Deducted', w: 13, align: 'right',
        value: (r) => money(r.withheld_cents) },
      { key: 'credited', header: 'Credited', w: 13, align: 'right',
        value: (r) => money(r.credited_cents) },
      { key: 'hold', header: 'Tax Hold', w: 13, align: 'right',
        value: (r) => money(r.tax_hold_cents) },
      { key: 'to_ssn', header: 'To the SSN', w: 14, align: 'right', bold: true,
        value: (r) => money(r.to_ssn_cents) },
    ],
    rows: salaries,
    footer: {
      reference: 'Month total',
      invoice: money(s.invoice_cents),
      withheld: money(s.withheld_cents),
      credited: money(s.credited_cents),
      hold: money(s.tax_hold_cents),
      to_ssn: money(s.salary_cents),
    },
    emptyNote: 'No salaries recorded in this month.',
  });

  table({
    heading: 'Expenses charged',
    columns: [
      { key: 'reference', header: 'Reference', w: 16, value: (r) => r.reference },
      { key: 'date', header: 'Date', w: 14, value: (r) => formatDate(r.expense_date) },
      { key: 'category', header: 'Category', w: 22, value: (r) => r.category_name },
      { key: 'description', header: 'Description', w: 26, value: (r) => r.description ?? '—' },
      { key: 'vendor', header: 'Vendor', w: 18, value: (r) => r.vendor ?? '—' },
      { key: 'amount', header: 'Amount', w: 14, align: 'right', bold: true,
        value: (r) => money(r.amount_cents) },
    ],
    rows: expenses,
    footer: { reference: 'Month total', amount: money(s.expense_cents) },
    emptyNote: 'No expenses charged in this month.',
  });

  /* -------------------------------------------------------------- the footer -- */

  doc.moveDown(1.6);
  room(40);
  rule();
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text(
    'Accounting month basis: a salary or expense counts in the month it was assigned to, '
    + 'not the month it is dated. Tax is held per salary, from the credited amount, at the '
    + 'rate its job carries.',
    left, doc.y, { width }
  );
  doc.moveDown(0.4);
  doc.fontSize(7.5).fillColor(FAINT).text(
    `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`
    + (generatedBy ? ` by ${generatedBy}` : '') + ` · ${orgName}`,
    left, doc.y, { width }
  );

  doc.end();
  return done;
}
