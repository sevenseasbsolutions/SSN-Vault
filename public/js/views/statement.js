import { api } from '../api.js';
import {
  el, card, dataTable, empty, field, mount, loading, moneyCell, pill,
  modal, applyErrors, withBusy, toastSuccess, confirmDialog,
} from '../ui.js';
import {
  money, percent, monthLabel, dateLabel, currentMonthValue, centsToInput, periodLabel,
} from '../format.js';
import { icon } from '../icons.js';

/**
 * An SSN's month, as the waterfall it is.
 *
 * This is the screen that answers "where did Alpha's money go". Every line is
 * labelled with what it is and where it came from, and the two final lines --
 * what the SSN keeps and what goes up -- always add back to the
 * distributable amount, which the page states explicitly.
 */

export default async function statement({ view, actions, query, session, navigate }) {
  const ssns = await api.get('/api/org/meta/ssns').then((r) => r.rows);

  if (!ssns.length) {
    return view.append(card({
      body: empty({
        icon: 'layers',
        title: 'No SSNs yet',
        message: 'A statement is per SSN, per month. Add an SSN under a '
          + 'sub-company first.',
        action: session.can('org.manage')
          ? el('button', {
            class: 'btn btn-primary', type: 'button', text: 'Go to the structure',
            onClick: () => navigate('org'),
          })
          : null,
      }),
    }));
  }

  let ssnId = Number(query.ssn) || ssns[0].id;
  let month = query.month || currentMonthValue();

  const ssnPicker = field({
    label: 'SSN', name: 'ssn', type: 'select', value: String(ssnId),
    options: ssns.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` })),
  });
  const monthPicker = field({
    label: 'Accounting month', name: 'month', type: 'month', value: month,
  });

  ssnPicker.input.addEventListener('change', () => {
    ssnId = Number(ssnPicker.input.value);
    navigate('statement', { ssn: ssnId, month });
  });
  monthPicker.input.addEventListener('change', () => {
    month = monthPicker.input.value || currentMonthValue();
    navigate('statement', { ssn: ssnId, month });
  });

  view.append(card({ body: el('div', { class: 'filter-row' }, [ssnPicker, monthPicker]) }));

  const body = el('div');
  view.append(body);

  async function load() {
    mount(body, el('div', { class: 'card' }, loading(6)));
    const data = await api.get(`/api/org/${ssnId}/statement`, { month });
    const s = data.statement;

    /*
     * A real anchor, not a fetch-and-blob: the browser's own download handling
     * keeps the session cookie and honours the Content-Disposition filename,
     * both of which a scripted download would have to reinvent badly.
     */
    mount(actions,
      session.can('reports.export')
        ? el('a', {
          class: 'btn', icon: 'download', text: 'Download PDF',
          href: api.exportUrl(`/api/reports/export/statement/${ssnId}`, { month }),
        })
        : null,
      session.can('tax.manage')
        ? el('button', {
          class: 'btn', type: 'button', icon: 'shield',
          text: s.tax_basis === 'override' ? 'Edit tax override' : 'Override tax hold',
          onClick: () => openTaxOverride({ statement: s, onSaved: load }),
        })
        : null,
    );

    mount(body,
      waterfall(s),
      card({
        title: `Salaries · ${monthLabel(s.accounting_month)}`,
        sub: `${data.salaries.length} recorded across ${s.job_count} job(s)`,
        tight: true,
        body: dataTable({
          columns: [
            { key: 'reference', header: 'Reference', phone: false },
            {
              key: 'job_title', header: 'Job', wrap: true,
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('strong', { text: r.job_title }),
                el('small', { text: r.client_name ?? '—' }),
                r.pay_period_from || r.pay_period_to
                  ? el('small', { text: periodLabel(r.pay_period_from, r.pay_period_to) })
                  : null,
              ]),
            },
            {
              key: 'tax_category', header: 'Terms', phone: false,
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('span', { text: r.tax_category === 'w2' ? 'W2' : '1099' }),
                el('small', { text: `${percent(r.tax_hold_bps)} hold` }),
              ]),
            },
            {
              key: 'invoice_cents', header: 'Invoiced', align: 'right', phone: false,
              render: (r) => moneyCell(r.invoice_cents, { colour: false }),
            },
            {
              key: 'withheld_cents', header: 'Deducted', align: 'right', phone: false,
              render: (r) => moneyCell(r.withheld_cents, { colour: false }),
            },
            {
              key: 'credited_cents', header: 'Credited', align: 'right',
              render: (r) => moneyCell(r.credited_cents, { colour: false }),
            },
            {
              key: 'tax_hold_cents', header: 'Tax Hold', align: 'right',
              render: (r) => moneyCell(r.tax_hold_cents, { colour: false }),
            },
            {
              key: 'to_ssn_cents', header: 'To the SSN', align: 'right',
              render: (r) => el('strong', {}, moneyCell(r.to_ssn_cents, { colour: false })),
            },
          ],
          rows: data.salaries,
          footer: data.salaries.length ? {
            reference: el('small', { text: 'month total' }),
            invoice_cents: moneyCell(s.invoice_cents, { colour: false }),
            withheld_cents: moneyCell(s.withheld_cents, { colour: false }),
            credited_cents: moneyCell(s.credited_cents, { colour: false }),
            tax_hold_cents: moneyCell(s.tax_hold_cents, { colour: false }),
            to_ssn_cents: el('strong', {}, moneyCell(s.salary_cents, { colour: false })),
          } : null,
          emptyState: empty({
            icon: 'inbox', title: 'No salaries in this month',
            message: 'A salary is one month’s money on a job. Record one to see it '
              + 'flow through.',
          }),
        }),
      }),
      card({
        title: 'Expenses charged',
        sub: `${data.expenses.length} recorded`,
        tight: true,
        body: dataTable({
          columns: [
            { key: 'reference', header: 'Reference' },
            { key: 'expense_date', header: 'Date', render: (r) => dateLabel(r.expense_date) },
            { key: 'category_name', header: 'Category' },
            { key: 'description', header: 'Description', render: (r) => r.description ?? '—' },
            { key: 'vendor', header: 'Vendor', render: (r) => r.vendor ?? '—' },
            { key: 'status', header: 'Status', render: (r) => pill(r.status) },
            {
              key: 'amount_cents', header: 'Amount', align: 'right',
              render: (r) => moneyCell(r.amount_cents, { colour: false }),
            },
          ],
          rows: data.expenses,
          emptyState: empty({ icon: 'inbox', title: 'No expenses in this month' }),
        }),
      }),
    );
  }

  await load();
}

/* --------------------------------------------------------------- waterfall -- */

/**
 * The flow, top to bottom.
 *
 * Deliberately a list of labelled steps rather than a table: the reader is
 * following one number down through subtractions, and a table invites them to
 * scan across instead.
 */
function waterfall(s) {
  const step = (label, value, { kind = '', note = null } = {}) =>
    el('div', { class: `wf-row ${kind}` }, [
      el('span', { class: 'wf-label' }, [
        el('span', { text: label }),
        note ? el('small', { text: note }) : null,
      ]),
      el('span', { class: 'wf-value num', text: money(value, { signed: kind === 'minus' }) }),
    ]);

  const reconciles = s.keep_cents + s.upstream_cents === s.distributable_cents;

  return card({
    title: `${s.ssn_name} · ${monthLabel(s.accounting_month)}`,
    sub: s.sub_name ? `Under ${s.sub_name}` : null,
    body: el('div', { class: 'waterfall' }, [
      step('Invoiced', s.invoice_cents, {
        kind: 'plus',
        note: `${s.salary_count} salar${s.salary_count === 1 ? 'y' : 'ies'} `
          + `across ${s.job_count} job${s.job_count === 1 ? '' : 's'}`,
      }),
      step('Deducted by companies (W2)', -s.withheld_cents, {
        kind: 'minus',
        note: 'before the money was credited',
      }),
      step('Credited', s.credited_cents, { kind: 'subtotal' }),
      step('Tax Hold', -s.tax_hold_cents, {
        kind: 'minus',
        note: s.tax_basis === 'override'
          ? `overridden — ${s.tax_override_reason} (the jobs come to ${money(s.computed_tax_cents)})`
          : (s.tax_basis === 'per_job'
            ? 'each job’s own rate, on its own credited amount'
            : 'nothing credited, so nothing held'),
      }),
      step(`To ${s.ssn_name}`, s.salary_cents, { kind: 'subtotal' }),
      step('Expenses', -s.expense_cents, { kind: 'minus', note: 'charged to this SSN' }),
      step('Remaining', s.distributable_cents, { kind: 'subtotal strong' }),

      el('div', { class: 'wf-split' }, [
        el('div', { class: 'wf-half keep' }, [
          el('span', { class: 'wf-half-label' }, [
            icon('layers', { size: 13 }),
            el('span', { text: `${s.ssn_name} keeps` }),
          ]),
          el('span', { class: 'wf-half-value num', text: money(s.keep_cents) }),
          el('small', { text: `${percent(s.share_bps)} of what remains` }),
        ]),
        el('div', { class: 'wf-half up' }, [
          el('span', { class: 'wf-half-label' }, [
            icon('arrow-up', { size: 13 }),
            el('span', { text: `Up to ${s.sub_name ?? 'the sub-company'}` }),
          ]),
          el('span', { class: 'wf-half-value num', text: money(s.upstream_cents) }),
          el('small', { text: `${percent(10000 - s.share_bps)} of what remains` }),
        ]),
      ]),

      el('p', { class: reconciles ? 'wf-check ok' : 'wf-check bad' }, [
        icon(reconciles ? 'check-circle' : 'warning', { size: 13 }),
        el('span', {
          text: reconciles
            ? `${money(s.keep_cents)} + ${money(s.upstream_cents)} = ${money(s.distributable_cents)}`
            : 'These figures do not reconcile — please report this.',
        }),
      ]),

      s.distributable_cents < 0
        ? el('p', { class: 'form-note warn', text: 'This month made a loss. The SSN '
          + 'carries it in full and nothing is passed up — a loss never travels to the '
          + 'company above.' })
        : null,
    ]),
  });
}

/* ----------------------------------------------------------- tax override -- */

async function openTaxOverride({ statement: s, onSaved }) {
  const form = el('form', { class: 'form-grid' });
  const hasOverride = s.tax_basis === 'override';

  const amount = field({
    label: 'Tax hold for this month', name: 'amount', type: 'text',
    required: true, value: centsToInput(s.tax_hold_cents),
    hint: `This SSN's salaries come to ${money(s.computed_tax_cents)} of tax between them`,
  });
  const reason = field({
    label: 'Reason', name: 'reason', type: 'textarea', required: true,
    value: s.tax_override_reason ?? '',
    hint: 'Recorded against the override and in the audit history',
  });
  const error = el('p', { class: 'form-error', hidden: true });
  form.append(
    el('p', {
      class: 'form-note',
      text: `${s.ssn_name}, ${monthLabel(s.accounting_month)}. An override replaces what the `
        + 'rate computes for this one month; the SSN\'s standing rate is unchanged.',
    }),
    amount, reason, error,
  );

  const dialog = modal({
    title: hasOverride ? 'Edit the tax override' : 'Override the tax hold',
    body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      hasOverride
        ? el('button', {
          class: 'btn btn-danger', type: 'button', text: 'Remove override',
          onClick: async (event) => withBusy(event.currentTarget, async () => {
            const result = await confirmDialog({
              title: 'Remove the override?',
              message: `${s.ssn_name} will go back to the ${money(s.computed_tax_cents)} `
                + 'its salaries come to for this month.',
              confirmLabel: 'Remove',
              danger: true,
            });
            if (!result.confirmed) return;
            const overrides = await api.get('/api/tax/overrides', {
              ssn_id: s.ssn_id, month: s.accounting_month,
            });
            const row = overrides.rows[0];
            if (row) await api.del(`/api/tax/overrides/${row.id}`);
            toastSuccess('Override removed.');
            dialog.close();
            await onSaved?.();
          }),
        })
        : null,
      el('button', {
        class: 'btn btn-primary', type: 'button', text: 'Save',
        onClick: (event) => withBusy(event.currentTarget, async () => {
          error.hidden = true;
          try {
            await api.put('/api/tax/overrides', {
              ssn_id: s.ssn_id,
              accounting_month: s.accounting_month,
              amount: amount.input.value,
              reason: reason.input.value.trim(),
            });
            toastSuccess('Tax hold overridden for this month.');
            dialog.close();
            await onSaved?.();
          } catch (err) {
            if (!applyErrors(form, err.details)) {
              error.textContent = err.message;
              error.hidden = false;
            }
          }
        }),
      }),
    ],
  });
}
