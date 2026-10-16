import { api } from '../api.js';
import {
  el, card, dataTable, pager, moneyCell, pill, empty, modal, field, applyErrors,
  withBusy, toastSuccess, toastWarn, statCard, mount, loading, confirmDialog, detailList,
} from '../ui.js';
import {
  money, percent, dateLabel, monthLabel, monthValue, timestampLabel,
  todayValue, centsToInput, periodLabel,
} from '../format.js';
import { filterDisclosure, cleanFilters, countActiveFilters } from '../filters.js';

/**
 * Jobs: the engagements an SSN works under.
 *
 * A job holds no money. It is set up once with the terms its salaries will be
 * treated by -- W2 or 1099, the tax hold, the joining date -- and then a
 * salary is recorded against it every month on the Salaries screen.
 *
 * The list still shows what each job has paid, because a job with no money
 * behind it and a job that has paid for a year look identical otherwise.
 */

const CATEGORY_LABEL = { w2: 'W2', 1099: '1099' };

export default async function jobs({ view, actions, query, session, navigate }) {
  const ssns = await api.get('/api/org/meta/ssns').then((r) => r.rows);

  let page = 1;
  let sort = { sort: 'joining_date', dir: 'desc' };
  let filters = {
    ssn_id: query.ssn_id ?? '',
    tax_category: '',
    active: '',
    search: '',
  };

  if (session.can('jobs.create')) {
    actions.append(el('button', {
      class: 'btn btn-primary', type: 'button', icon: 'plus', text: 'Set up job',
      onClick: () => openForm({ ssns, onSaved: load }),
    }));
  }

  const controls = el('div');
  const body = el('div');
  view.append(controls, body);

  const ssnFilter = field({
    label: 'SSN', name: 'ssn_id', type: 'select', value: filters.ssn_id,
    options: [{ value: '', label: 'All SSNs' },
      ...ssns.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` }))],
  });
  const categoryFilter = field({
    label: 'Tax category', name: 'tax_category', type: 'select', value: filters.tax_category,
    options: [
      { value: '', label: 'W2 and 1099' },
      { value: 'w2', label: 'W2 only' },
      { value: '1099', label: '1099 only' },
    ],
  });
  const activeFilter = field({
    label: 'Status', name: 'active', type: 'select', value: filters.active,
    options: [
      { value: '', label: 'Active and inactive' },
      { value: 'true', label: 'Active only' },
      { value: 'false', label: 'Inactive only' },
    ],
  });
  const searchFilter = field({
    label: 'Search', name: 'search', type: 'search', placeholder: 'Job, client or reference…',
  });

  const apply = () => {
    filters = {
      ssn_id: ssnFilter.input.value,
      tax_category: categoryFilter.input.value,
      active: activeFilter.input.value,
      search: searchFilter.input.value.trim(),
    };
    page = 1;
    syncFilters();
    load();
  };

  for (const f of [ssnFilter, categoryFilter, activeFilter]) {
    f.input.addEventListener('change', apply);
  }
  let debounce;
  searchFilter.input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(apply, 220);
  });

  const { panel, sync: syncFilters } = filterDisclosure({
    actions, id: 'job-filters', count: () => countActiveFilters(filters),
  });
  panel.append(card({
    body: el('div', { class: 'filter-row' }, [ssnFilter, categoryFilter, activeFilter, searchFilter]),
  }));
  controls.append(panel);

  async function load() {
    mount(body, el('div', { class: 'card' }, loading(5)));

    const data = await api.get('/api/jobs', {
      ...cleanFilters(filters), page, limit: 25, sort: sort.sort, dir: sort.dir,
    });
    const t = data.totals;

    mount(body,
      el('div', { class: 'stat-grid' }, [
        statCard({
          label: 'Jobs', icon: 'receipt', value: String(t.jobs),
          foot: `${t.active} active`,
        }),
        statCard({
          label: 'Income Before Tax Hold', icon: 'wallet',
          value: money(t.credited_total_cents),
        }),
        statCard({
          label: 'Deducted by companies (W2)', icon: 'lock',
          value: money(t.withheld_total_cents),
          foot: 'never reached an SSN',
        }),
      ]),

      card({
        title: 'Jobs',
        sub: 'Set up once; a salary is recorded against it each month',
        tight: true,
        body: dataTable({
          rowKey: (r) => r.id,
          sort: data.sort,
          onSort: (key, dir) => { sort = { sort: key, dir }; load(); },
          columns: [
            {
              key: 'title', header: 'Job', sortKey: 'title', wrap: true,
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('strong', { text: r.title }),
                el('small', { text: r.client_name ?? '—' }),
              ]),
            },
            {
              key: 'ssn_name', header: 'SSN', sortKey: 'ssn',
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('span', { text: r.ssn_name }),
                el('small', { text: r.sub_name }),
              ]),
            },
            {
              key: 'tax_category', header: 'Terms', sortKey: 'tax_category',
              render: (r) => el('div', { class: 'cell-stack' }, [
                pill(r.tax_category === 'w2' ? 'active' : 'draft', CATEGORY_LABEL[r.tax_category]),
                el('small', { text: `${percent(r.tax_hold_bps)} hold` }),
              ]),
            },
            {
              key: 'joining_date', header: 'Joined', sortKey: 'joining_date', phone: false,
              render: (r) => dateLabel(r.joining_date),
            },
            {
              key: 'salary_count', header: 'Salaries', align: 'right',
              render: (r) => el('div', { class: 'cell-stack right' }, [
                el('span', { text: String(r.salary_count) }),
                r.last_month
                  ? el('small', { text: `to ${monthLabel(r.last_month)}` })
                  : el('small', { text: 'none yet' }),
              ]),
            },
            {
              key: 'credited_total', header: 'Credited', align: 'right',
              render: (r) => el('div', { class: 'cell-stack right' }, [
                moneyCell(r.credited_total, { colour: false }),
                r.withheld_total > 0
                  ? el('small', { text: `${money(r.withheld_total)} deducted` })
                  : null,
              ]),
            },
            {
              key: 'is_active', header: '', phone: false,
              render: (r) => (r.is_active ? '' : pill('void', 'Inactive')),
            },
            {
              key: 'actions', header: '', actions: true,
              render: (r) => el('div', { class: 'row-actions' }, [
                session.can('salaries.create') && r.is_active
                  ? el('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', icon: 'plus', text: 'Salary',
                    onClick: () => navigate('salaries', { job_id: r.id }),
                  })
                  : null,
                el('button', {
                  class: 'btn btn-ghost btn-sm', type: 'button', icon: 'eye', text: 'View',
                  onClick: () => openDetail({ job: r, ssns, session, onSaved: load, navigate }),
                }),
                session.can('jobs.edit')
                  ? el('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', icon: 'edit', text: 'Edit',
                    onClick: () => openForm({ job: r, ssns, onSaved: load }),
                  })
                  : null,
              ]),
            },
          ],
          rows: data.rows,
          emptyState: empty({
            icon: 'receipt',
            title: 'No jobs match',
            message: ssns.length
              ? 'A job is an engagement an SSN works under. Set one up, then record its '
                + 'salary each month.'
              : 'Add an SSN first — a job has to belong to one.',
            action: session.can('jobs.create') && ssns.length
              ? el('button', {
                class: 'btn btn-primary', type: 'button', text: 'Set up a job',
                onClick: () => openForm({ ssns, onSaved: load }),
              })
              : null,
          }),
        }),
      }),
      pager({ pagination: data.pagination, onPage: (next) => { page = next; load(); } }),
    );
  }

  await load();
}

/* -------------------------------------------------------------------- form -- */

function openForm({ job = null, ssns, onSaved }) {
  const editing = Boolean(job);
  const form = el('form', { class: 'form-grid' });

  const ssn = field({
    label: 'SSN', name: 'ssn_id', type: 'select', required: true,
    value: job?.ssn_id ?? ssns[0]?.id ?? '',
    options: ssns.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` })),
  });
  const title = field({
    label: 'Job', name: 'title', required: true, value: job?.title ?? '',
    placeholder: 'Website rebuild',
  });
  const client = field({
    label: 'Client', name: 'client_name', value: job?.client_name ?? '',
    placeholder: 'Harbour Logistics',
  });
  const taxCategory = field({
    label: 'Tax category', name: 'tax_category', type: 'select', required: true,
    value: job?.tax_category ?? 'w2',
    options: [
      { value: 'w2', label: 'W2 — the company withholds tax before crediting' },
      { value: '1099', label: '1099 — the invoice is normally credited in full' },
    ],
  });
  const taxHold = field({
    label: 'Tax hold %', name: 'tax_hold', type: 'number',
    min: 0, max: 100, step: '0.01', required: true,
    value: job ? centsToInput(job.tax_hold_bps) : '10',
    hint: 'Held from each salary’s credited amount',
  });
  const joiningDate = field({
    label: 'Joining date', name: 'joining_date', type: 'date', required: true,
    value: job?.joining_date ?? todayValue(),
  });
  const activeField = editing
    ? field({
      label: 'Status', name: 'is_active', type: 'select',
      value: job.is_active ? 'true' : 'false',
      options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
      hint: 'An inactive job keeps its history but takes no new salaries',
    })
    : null;
  const notes = field({ label: 'Notes', name: 'notes', type: 'textarea', value: job?.notes ?? '' });

  const extras = el('div', { class: 'form-grid extras', hidden: !editing });
  extras.append(activeField, notes);
  const MORE = 'Add a note';
  const LESS = 'Hide notes';
  const moreToggle = el('button', {
    class: 'btn btn-ghost btn-sm', type: 'button',
    text: editing ? LESS : MORE, 'aria-expanded': String(editing),
    onClick: (event) => {
      extras.hidden = !extras.hidden;
      event.currentTarget.setAttribute('aria-expanded', String(!extras.hidden));
      event.currentTarget.textContent = extras.hidden ? MORE : LESS;
    },
  });

  const error = el('p', { class: 'form-error', hidden: true });

  /*
   * No money is asked for here, so say what will happen when it is. Without
   * this the form reads as if a job were free.
   */
  const echo = el('p', { class: 'form-note' });
  const updateEcho = () => {
    const chosen = ssns.find((d) => String(d.id) === String(ssn.input.value));
    const pct = Number(taxHold.input.value);
    if (!chosen || !Number.isFinite(pct)) { echo.textContent = ''; return; }
    echo.textContent = `No money is recorded here. Each month you record a salary against this `
      + `job: ${pct}% of whatever is credited is held for tax, and the rest joins `
      + `${chosen.name}'s total for that month.`;
  };
  for (const node of [ssn, taxHold]) {
    node.input.addEventListener('change', updateEcho);
    node.input.addEventListener('input', updateEcho);
  }
  updateEcho();

  form.append(ssn, title, client, taxCategory, taxHold, joiningDate, echo, moreToggle, extras, error);

  const dialog = modal({
    title: editing ? `Edit ${job.reference}` : 'Set up a job',
    body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: editing ? 'Save' : 'Set up',
        onClick: (event) => withBusy(event.currentTarget, async () => {
          error.hidden = true;
          const payload = {
            ssn_id: Number(ssn.input.value),
            title: title.input.value.trim(),
            client_name: client.input.value.trim() || null,
            tax_category: taxCategory.input.value,
            tax_hold: taxHold.input.value,
            joining_date: joiningDate.input.value,
            notes: notes.input.value.trim() || null,
          };
          if (activeField) payload.is_active = activeField.input.value === 'true';
          try {
            const result = editing
              ? await api.put(`/api/jobs/${job.id}`, payload)
              : await api.post('/api/jobs', payload);
            toastSuccess(editing ? 'Job updated.' : 'Job set up.');
            // Changing the hold restates months already recorded; say so.
            for (const warning of result.warnings ?? []) toastWarn(warning);
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

async function openDetail({ job, ssns, session, onSaved, navigate }) {
  const data = await api.get(`/api/jobs/${job.id}`);
  const salaries = data.salaries ?? [];

  const dialog = modal({
    title: job.reference,
    wide: true,
    body: [
      detailList([
        ['Job', job.title],
        ['Client', job.client_name ?? '—'],
        ['SSN', `${job.sub_name} · ${job.ssn_name}`],
        ['Tax category', CATEGORY_LABEL[job.tax_category]],
        ['Tax hold', `${percent(job.tax_hold_bps)} of each credited amount`],
        ['Joining date', dateLabel(job.joining_date)],
        ['Status', job.is_active ? 'Active' : 'Inactive'],
        ['Credited to date', money(job.credited_total)],
        ['Withheld by the company', money(job.withheld_total)],
        ['Notes', job.notes ?? '—'],
        ['Set up', `${timestampLabel(job.created_at)}${job.created_by_name ? ` by ${job.created_by_name}` : ''}`],
      ]),
      el('h3', { class: 'detail-head', text: `Salaries (${salaries.length})` }),
      dataTable({
        columns: [
          { key: 'reference', header: 'Reference' },
          {
            key: 'accounting_month', header: 'Month',
            render: (r) => el('div', { class: 'cell-stack' }, [
              el('span', { text: monthLabel(r.accounting_month) }),
              r.pay_period_from || r.pay_period_to
                ? el('small', { text: periodLabel(r.pay_period_from, r.pay_period_to) })
                : null,
            ]),
          },
          {
            key: 'invoice_amount_cents', header: 'Invoiced', align: 'right',
            render: (r) => moneyCell(r.invoice_amount_cents, { colour: false }),
          },
          {
            key: 'credited_amount_cents', header: 'Credited', align: 'right',
            render: (r) => moneyCell(r.credited_amount_cents, { colour: false }),
          },
          { key: 'status', header: 'Status', render: (r) => pill(r.status) },
        ],
        rows: salaries,
        emptyState: empty({
          icon: 'inbox',
          title: 'No salaries recorded yet',
          message: 'This job has been set up but has not been paid into any month.',
        }),
      }),
    ],
    footer: [
      session.can('salaries.create') && job.is_active
        ? el('button', {
          class: 'btn', type: 'button', icon: 'plus', text: 'Record a salary',
          onClick: () => { dialog.close(); navigate('salaries', { job_id: job.id }); },
        })
        : null,
      session.canDelete('jobs.delete')
        ? el('button', {
          class: 'btn btn-danger', type: 'button', text: 'Delete',
          onClick: async () => {
            const result = await confirmDialog({
              title: `Delete ${job.reference}?`,
              message: salaries.length
                ? `This job has ${salaries.length} salary record(s) and cannot be deleted. `
                  + 'Mark it inactive instead.'
                : 'This is permanent.',
              confirmLabel: 'Delete',
              danger: true,
              requireReason: true,
            });
            if (!result.confirmed) return;
            await api.del(`/api/jobs/${job.id}`, { reason: result.reason });
            toastSuccess('Job deleted.');
            dialog.close();
            await onSaved?.();
          },
        })
        : null,
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Close', onClick: () => dialog.close() }),
    ],
  });
}
