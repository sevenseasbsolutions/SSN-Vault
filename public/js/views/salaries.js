import { api } from '../api.js';
import {
  el, card, dataTable, pager, moneyCell, pill, empty, modal, field, applyErrors,
  withBusy, toastSuccess, statCard, mount, loading, confirmDialog, detailList,
} from '../ui.js';
import {
  money, percent, dateLabel, monthLabel, monthValue, timestampLabel,
  currentMonthValue, todayValue, centsToInput, parseMoney, periodLabel,
} from '../format.js';
import { filterDisclosure, cleanFilters, countActiveFilters } from '../filters.js';

/**
 * The salary register: what each job paid, month by month.
 *
 * Two amounts are typed and the rest is derived, so the table shows the whole
 * chain across one row -- invoiced, credited, what the hiring company deducted,
 * the job's hold, and what actually reached the SSN. Showing only the ends of
 * that chain is what makes people recompute it by hand.
 */

const CATEGORY_LABEL = { w2: 'W2', 1099: '1099' };

export default async function salaries({ view, actions, query, session, navigate }) {
  const [jobs, ssns] = await Promise.all([
    api.get('/api/jobs/meta/open').then((r) => r.rows).catch(() => []),
    api.get('/api/org/meta/ssns').then((r) => r.rows).catch(() => []),
  ]);

  let page = 1;
  let sort = { sort: 'accounting_month', dir: 'desc' };
  let filters = {
    job_id: query.job_id ?? '',
    ssn_id: query.ssn_id ?? '',
    tax_category: '',
    status: '',
    month_from: query.month_from ?? '',
    month_to: query.month_to ?? '',
    search: '',
  };

  if (session.can('salaries.create')) {
    actions.append(el('button', {
      class: 'btn btn-primary', type: 'button', icon: 'plus', text: 'Record salary',
      onClick: () => openForm({ jobs, onSaved: load }),
    }));
  }

  const controls = el('div');
  const body = el('div');
  view.append(controls, body);

  /* ------------------------------------------------------------- filtering -- */

  const ssnFilter = field({
    label: 'SSN', name: 'ssn_id', type: 'select', value: filters.ssn_id,
    options: [{ value: '', label: 'All SSNs' },
      ...ssns.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` }))],
  });
  const jobFilter = field({
    label: 'Job', name: 'job_id', type: 'select', value: filters.job_id,
    options: [{ value: '', label: 'All jobs' },
      ...jobs.map((j) => ({ value: j.id, label: `${j.ssn_name} · ${j.title}` }))],
  });
  const categoryFilter = field({
    label: 'Tax category', name: 'tax_category', type: 'select', value: filters.tax_category,
    options: [
      { value: '', label: 'W2 and 1099' },
      { value: 'w2', label: 'W2 only' },
      { value: '1099', label: '1099 only' },
    ],
  });
  const statusFilter = field({
    label: 'Status', name: 'status', type: 'select', value: filters.status,
    options: [
      { value: '', label: 'All but nothing hidden' },
      { value: 'active', label: 'Active (counts)' },
      { value: 'draft', label: 'Draft (not yet counted)' },
      { value: 'void', label: 'Void (reversed)' },
    ],
  });
  const fromFilter = field({ label: 'Month from', name: 'month_from', type: 'month', value: filters.month_from });
  const toFilter = field({ label: 'Month to', name: 'month_to', type: 'month', value: filters.month_to });
  const searchFilter = field({
    label: 'Search', name: 'search', type: 'search', placeholder: 'Job, client or reference…',
  });

  const apply = () => {
    filters = {
      ssn_id: ssnFilter.input.value,
      job_id: jobFilter.input.value,
      tax_category: categoryFilter.input.value,
      status: statusFilter.input.value,
      month_from: fromFilter.input.value,
      month_to: toFilter.input.value,
      search: searchFilter.input.value.trim(),
    };
    page = 1;
    syncFilters();
    load();
  };

  for (const f of [ssnFilter, jobFilter, categoryFilter, statusFilter, fromFilter, toFilter]) {
    f.input.addEventListener('change', apply);
  }
  let debounce;
  searchFilter.input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(apply, 220);
  });

  const { panel, sync: syncFilters } = filterDisclosure({
    actions, id: 'salary-filters', count: () => countActiveFilters(filters),
  });
  panel.append(card({
    body: el('div', { class: 'filter-row' },
      [ssnFilter, jobFilter, categoryFilter, statusFilter, fromFilter, toFilter, searchFilter]),
  }));
  controls.append(panel);

  /* ----------------------------------------------------------------- render -- */

  async function load() {
    mount(body, el('div', { class: 'card' }, loading(5)));

    const data = await api.get('/api/salaries', {
      ...cleanFilters(filters), page, limit: 25, sort: sort.sort, dir: sort.dir,
    });
    const t = data.totals;

    mount(body,
      el('div', { class: 'stat-grid' }, [
        statCard({ label: 'Invoiced', icon: 'receipt', value: money(t.invoice_cents) }),
        statCard({
          label: 'Deducted by companies (W2)', icon: 'lock',
          value: money(t.withheld_cents),
          foot: 'never reached the SSN',
        }),
        statCard({ label: 'Tax Hold', icon: 'shield', value: money(t.tax_hold_cents),
          foot: 'each job at its own rate' }),
        statCard({
          label: 'Reached the SSNs', icon: 'wallet', value: money(t.to_ssn_cents),
          tone: 'primary', foot: `${t.count} salar${t.count === 1 ? 'y' : 'ies'}`,
        }),
      ]),

      card({
        title: 'Salaries',
        sub: 'Invoiced → credited → less the job’s hold → what reached the SSN',
        tight: true,
        body: dataTable({
          rowKey: (r) => r.id,
          sort: data.sort,
          onSort: (key, dir) => { sort = { sort: key, dir }; load(); },
          columns: [
            {
              key: 'accounting_month', header: 'Month', sortKey: 'accounting_month',
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('strong', { text: monthLabel(r.accounting_month) }),
                r.pay_period_from || r.pay_period_to
                  ? el('small', { text: periodLabel(r.pay_period_from, r.pay_period_to) })
                  : null,
                r.credit_date ? el('small', { text: `credited ${dateLabel(r.credit_date)}` }) : null,
              ]),
            },
            {
              key: 'job_title', header: 'Job', sortKey: 'job', wrap: true,
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('strong', { text: r.job_title }),
                el('small', { text: r.client_name ? `${r.ssn_name} · ${r.client_name}` : r.ssn_name }),
              ]),
            },
            {
              key: 'tax_category', header: 'Terms', sortKey: 'tax_category', phone: false,
              render: (r) => el('div', { class: 'cell-stack' }, [
                pill(r.tax_category === 'w2' ? 'active' : 'draft', CATEGORY_LABEL[r.tax_category]),
                el('small', { text: `${percent(r.tax_hold_bps)} hold` }),
              ]),
            },
            {
              key: 'invoice_cents', header: 'Invoiced', align: 'right', sortKey: 'invoice',
              phone: false,
              render: (r) => moneyCell(r.invoice_cents, { colour: false }),
            },
            {
              key: 'credited_cents', header: 'Credited', align: 'right', sortKey: 'credited',
              render: (r) => el('div', { class: 'cell-stack right' }, [
                moneyCell(r.credited_cents, { colour: false }),
                r.withheld_cents > 0
                  ? el('small', { text: `${money(r.withheld_cents)} deducted` })
                  : null,
              ]),
            },
            {
              key: 'tax_hold_cents', header: 'Tax Hold', align: 'right', phone: false,
              render: (r) => moneyCell(r.tax_hold_cents, { colour: false }),
            },
            {
              key: 'to_ssn_cents', header: 'To the SSN', align: 'right',
              render: (r) => el('strong', {}, moneyCell(r.to_ssn_cents, { colour: false })),
            },
            { key: 'status', header: 'Status', sortKey: 'status', render: (r) => pill(r.status) },
            {
              key: 'actions', header: '', actions: true,
              render: (r) => el('div', { class: 'row-actions' }, [
                el('button', {
                  class: 'btn btn-ghost btn-sm', type: 'button', icon: 'eye', text: 'View',
                  onClick: () => openDetail({ salary: r, session, onSaved: load, navigate }),
                }),
                session.can('salaries.edit')
                  ? el('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', icon: 'edit', text: 'Edit',
                    onClick: () => openForm({ salary: r, jobs, onSaved: load }),
                  })
                  : null,
              ]),
            },
          ],
          rows: data.rows,
          footer: data.rows.length ? {
            accounting_month: el('small', { text: 'page total, active only' }),
            invoice_cents: pageTotal(data.rows, 'invoice_cents'),
            credited_cents: pageTotal(data.rows, 'credited_cents'),
            tax_hold_cents: pageTotal(data.rows, 'tax_hold_cents'),
            to_ssn_cents: el('strong', {}, pageTotal(data.rows, 'to_ssn_cents')),
          } : null,
          emptyState: empty({
            icon: 'inbox',
            title: 'No salaries match',
            message: jobs.length
              ? 'A salary is one month’s money on a job. Record one to see it flow through.'
              : 'Set up a job first — a salary has to belong to one.',
            action: jobs.length && session.can('salaries.create')
              ? el('button', {
                class: 'btn btn-primary', type: 'button', text: 'Record a salary',
                onClick: () => openForm({ jobs, onSaved: load }),
              })
              : el('button', {
                class: 'btn', type: 'button', text: 'Go to Jobs',
                onClick: () => navigate('jobs'),
              }),
          }),
        }),
      }),
      pager({ pagination: data.pagination, onPage: (next) => { page = next; load(); } }),
    );
  }

  await load();
}

const pageTotal = (rows, key) => moneyCell(
  rows.reduce((acc, r) => acc + (r.status === 'active' ? r[key] : 0), 0),
  { colour: false }
);

/* -------------------------------------------------------------------- form -- */

function openForm({ salary = null, jobs, onSaved }) {
  const editing = Boolean(salary);
  const form = el('form', { class: 'form-grid' });

  // An edited salary's job may be inactive and so absent from the open list.
  const options = editing && !jobs.some((j) => j.id === salary.job_id)
    ? [{ value: salary.job_id, label: `${salary.ssn_name} · ${salary.job_title}` }, ...jobs]
    : jobs;

  const job = field({
    label: 'Job', name: 'job_id', type: 'select', required: true,
    value: salary?.job_id ?? options[0]?.id ?? '',
    options: options.map((j) => ({
      value: j.id,
      label: `${j.ssn_name} · ${j.title}${j.client_name ? ` (${j.client_name})` : ''}`,
    })),
  });
  const month = field({
    label: 'Accounting month', name: 'accounting_month', type: 'month', required: true,
    value: salary ? monthValue(salary.accounting_month) : currentMonthValue(),
  });
  const invoice = field({
    label: 'Invoice amount', name: 'invoice_amount', required: true,
    value: salary ? centsToInput(salary.invoice_amount_cents) : '',
    placeholder: '1000.00',
    hint: 'What was billed',
  });
  const credited = field({
    label: 'Amount credited', name: 'credited_amount', required: true,
    value: salary ? centsToInput(salary.credited_amount_cents) : '',
    placeholder: '800.00',
    hint: 'What actually arrived. The difference is what the company deducted.',
  });
  const creditDate = field({
    label: 'Credit date', name: 'credit_date', type: 'date',
    value: salary?.credit_date ?? todayValue(),
  });
  /*
   * Optional, and deliberately not tied to the accounting month: a pay period
   * routinely straddles a month boundary, and the accounting month is what
   * decides which statement the money lands in.
   */
  const periodFrom = field({
    label: 'Pay period from', name: 'pay_period_from', type: 'date',
    value: salary?.pay_period_from ?? '',
    hint: 'Optional',
  });
  const periodTo = field({
    label: 'Pay period to', name: 'pay_period_to', type: 'date',
    value: salary?.pay_period_to ?? '',
    hint: 'May run into another month',
  });
  const status = field({
    label: 'Status', name: 'status', type: 'select', value: salary?.status ?? 'active',
    options: [
      { value: 'active', label: 'Active — counts' },
      { value: 'draft', label: 'Draft — not yet counted' },
      { value: 'void', label: 'Void — reversed' },
    ],
  });
  const notes = field({ label: 'Notes', name: 'notes', type: 'textarea', value: salary?.notes ?? '' });

  // Opened when the salary already carries any of these, so an existing pay
  // period is never hidden behind a collapsed section.
  const hasExtras = Boolean(editing || salary?.pay_period_from || salary?.pay_period_to);
  const extras = el('div', { class: 'form-grid extras', hidden: !hasExtras });
  extras.append(creditDate, periodFrom, periodTo, status, notes);
  const MORE = 'Add pay period, credit date, status or notes';
  const LESS = 'Hide pay period, credit date, status and notes';
  const moreToggle = el('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', text: hasExtras ? LESS : MORE,
    'aria-expanded': String(hasExtras),
    onClick: (event) => {
      extras.hidden = !extras.hidden;
      event.currentTarget.setAttribute('aria-expanded', String(!extras.hidden));
      event.currentTarget.textContent = extras.hidden ? MORE : LESS;
    },
  });

  const error = el('p', { class: 'form-error', hidden: true });

  /*
   * The whole chain, worked out live. This is the only place the two typed
   * amounts turn into four, and seeing it before saving is what stops a
   * transposed invoice/credited pair going in unnoticed.
   */
  const echo = el('div', { class: 'echo-chain' });
  const updateEcho = () => {
    const chosen = options.find((j) => String(j.id) === String(job.input.value));
    const inv = parseMoney(invoice.input.value);
    const cred = parseMoney(credited.input.value);

    if (!chosen) { mount(echo, el('p', { class: 'form-note' })); return; }
    if (inv === null || cred === null) {
      mount(echo, el('p', {
        class: 'form-note',
        text: `${CATEGORY_LABEL[chosen.tax_category]} · ${percent(chosen.tax_hold_bps)} hold. `
          + 'Enter both amounts to see what reaches the SSN.',
      }));
      return;
    }
    if (cred > inv) {
      mount(echo, el('p', {
        class: 'form-note warn',
        text: 'More cannot be credited than was invoiced.',
      }));
      return;
    }

    const withheld = inv - cred;
    const hold = Math.trunc((cred * chosen.tax_hold_bps) / 10000);
    const toSsn = cred - hold;
    const line = (label, value, note) => el('div', { class: 'echo-row' }, [
      el('span', {}, [el('span', { text: label }), note ? el('small', { text: note }) : null]),
      el('span', { class: 'num', text: money(value) }),
    ]);

    mount(echo,
      line('Invoiced', inv),
      line('Credited', cred, withheld > 0
        ? `${money(withheld)} deducted by ${chosen.client_name ?? 'the company'}`
        : 'nothing deducted'),
      line('Tax Hold', -hold, `${percent(chosen.tax_hold_bps)} of credited`),
      el('div', { class: 'echo-row total' }, [
        el('span', { text: `To ${chosen.ssn_name}` }),
        el('span', { class: 'num', text: money(toSsn) }),
      ]),
      el('p', { class: 'form-note', text: `${chosen.ssn_name}'s expenses come off its monthly `
        + 'total, not off this one salary.' }),
    );
  };
  for (const node of [invoice, credited]) node.input.addEventListener('input', updateEcho);
  job.input.addEventListener('change', updateEcho);
  updateEcho();

  form.append(job, month, invoice, credited, echo, moreToggle, extras, error);

  const dialog = modal({
    title: editing ? `Edit ${salary.reference}` : 'Record a salary',
    body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: editing ? 'Save' : 'Record',
        onClick: (event) => withBusy(event.currentTarget, async () => {
          error.hidden = true;
          const payload = {
            job_id: Number(job.input.value),
            accounting_month: month.input.value,
            invoice_amount: invoice.input.value,
            credited_amount: credited.input.value,
            credit_date: creditDate.input.value || null,
            pay_period_from: periodFrom.input.value || null,
            pay_period_to: periodTo.input.value || null,
            status: status.input.value,
            notes: notes.input.value.trim() || null,
          };
          try {
            if (editing) {
              await api.put(`/api/salaries/${salary.id}`, payload);
              toastSuccess('Salary updated.');
            } else {
              const result = await api.post('/api/salaries', payload);
              toastSuccess(`${money(result.effect.to_ssn_cents)} reached `
                + `${result.effect.ssn_name}.`);
            }
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

/* ------------------------------------------------------------------ detail -- */

function openDetail({ salary, session, onSaved, navigate }) {
  const dialog = modal({
    title: salary.reference,
    body: [
      detailList([
        ['Job', `${salary.job_title}${salary.client_name ? ` · ${salary.client_name}` : ''}`],
        ['SSN', `${salary.sub_name} · ${salary.ssn_name}`],
        ['Accounting month', monthLabel(salary.accounting_month)],
        ['Terms', `${CATEGORY_LABEL[salary.tax_category]} · ${percent(salary.tax_hold_bps)} hold`],
        ['Invoiced', money(salary.invoice_cents)],
        ['Credited', money(salary.credited_cents)],
        ['Deducted by the company (W2)', money(salary.withheld_cents)],
        ['Tax Hold', money(salary.tax_hold_cents)],
        ['Reached the SSN', money(salary.to_ssn_cents)],
        ['Pay period', periodLabel(salary.pay_period_from, salary.pay_period_to)],
        ['Credit date', salary.credit_date ? dateLabel(salary.credit_date) : '—'],
        ['Status', salary.status],
        ['Notes', salary.notes ?? '—'],
        ['Recorded', `${timestampLabel(salary.created_at)}${salary.created_by_name ? ` by ${salary.created_by_name}` : ''}`],
      ]),
    ],
    footer: [
      el('button', {
        class: 'btn', type: 'button', text: 'Open statement',
        onClick: () => {
          dialog.close();
          navigate('statement', {
            ssn: salary.ssn_id, month: monthValue(salary.accounting_month),
          });
        },
      }),
      session.canDelete('salaries.delete')
        ? el('button', {
          class: 'btn btn-danger', type: 'button', text: 'Delete',
          onClick: async () => {
            const result = await confirmDialog({
              title: `Delete ${salary.reference}?`,
              message: `This permanently removes ${money(salary.to_ssn_cents)} from `
                + `${salary.ssn_name}'s ${monthLabel(salary.accounting_month)} statement.`,
              confirmLabel: 'Delete',
              danger: true,
              requireReason: true,
            });
            if (!result.confirmed) return;
            await api.del(`/api/salaries/${salary.id}`, { reason: result.reason });
            toastSuccess('Salary deleted.');
            dialog.close();
            await onSaved?.();
          },
        })
        : null,
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Close', onClick: () => dialog.close() }),
    ],
  });
}
