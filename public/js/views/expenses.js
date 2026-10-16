import { api } from '../api.js';
import {
  el, card, dataTable, pager, moneyCell, pill, empty, modal, field, applyErrors,
  withBusy, toastSuccess, statCard, mount, loading, confirmDialog, detailList,
} from '../ui.js';
import {
  money, dateLabel, monthLabel, monthValue, timestampLabel, currentMonthValue,
  todayValue, centsToInput,
} from '../format.js';
import { filterDisclosure, cleanFilters, countActiveFilters } from '../filters.js';

/**
 * The expense register.
 *
 * Every expense is charged to exactly one SSN and reduces that
 * SSN's net in the accounting month it was assigned to. There is no
 * allocation step and nothing to split, so a cost can only ever be counted
 * once.
 */

export default async function expenses({ view, actions, query, session, navigate }) {
  const [ssns, categories] = await Promise.all([
    api.get('/api/org/meta/ssns').then((r) => r.rows),
    api.get('/api/expenses/meta/categories').then((r) => r.rows),
  ]);

  let page = 1;
  let sort = { sort: 'expense_date', dir: 'desc' };
  let filters = {
    ssn_id: query.ssn_id ?? '',
    category_id: '',
    status: '',
    month_from: query.month_from ?? '',
    month_to: query.month_to ?? '',
    search: '',
  };

  if (session.can('expenses.create')) {
    actions.append(el('button', {
      class: 'btn btn-primary', type: 'button', icon: 'plus', text: 'Record expense',
      onClick: () => openForm({ ssns, categories, onSaved: load }),
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
    label: 'Category', name: 'category_id', type: 'select', value: filters.category_id,
    options: [{ value: '', label: 'All categories' },
      ...categories.map((c) => ({ value: c.id, label: c.name }))],
  });
  const statusFilter = field({
    label: 'Status', name: 'status', type: 'select', value: filters.status,
    options: [
      { value: '', label: 'All but nothing hidden' },
      { value: 'approved', label: 'Approved (deducted)' },
      { value: 'draft', label: 'Draft (not yet deducted)' },
      { value: 'void', label: 'Void (reversed)' },
    ],
  });
  const fromFilter = field({ label: 'Month from', name: 'month_from', type: 'month', value: filters.month_from });
  const toFilter = field({ label: 'Month to', name: 'month_to', type: 'month', value: filters.month_to });
  const searchFilter = field({
    label: 'Search', name: 'search', type: 'search', placeholder: 'Description, vendor or reference…',
  });

  const apply = () => {
    filters = {
      ssn_id: ssnFilter.input.value,
      category_id: categoryFilter.input.value,
      status: statusFilter.input.value,
      month_from: fromFilter.input.value,
      month_to: toFilter.input.value,
      search: searchFilter.input.value.trim(),
    };
    page = 1;
    syncFilters();
    load();
  };

  for (const f of [ssnFilter, categoryFilter, statusFilter, fromFilter, toFilter]) {
    f.input.addEventListener('change', apply);
  }
  let debounce;
  searchFilter.input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(apply, 220);
  });

  const { panel, sync: syncFilters } = filterDisclosure({
    actions, id: 'expense-filters', count: () => countActiveFilters(filters),
  });
  panel.append(card({
    body: el('div', { class: 'filter-row' },
      [ssnFilter, categoryFilter, statusFilter, fromFilter, toFilter, searchFilter]),
  }));
  controls.append(panel);

  async function load() {
    mount(body, el('div', { class: 'card' }, loading(5)));

    const data = await api.get('/api/expenses', {
      ...cleanFilters(filters), page, limit: 25, sort: sort.sort, dir: sort.dir,
    });

    mount(body,
      el('div', { class: 'stat-grid' }, [
        statCard({
          label: 'Total Expenses', icon: 'trending-down',
          value: money(data.totals.amount_cents),
          foot: `${data.totals.count} approved`,
        }),
        statCard({
          label: 'Rows matched', icon: 'hash', value: String(data.pagination.total),
          foot: `page ${data.pagination.page} of ${data.pagination.pages}`,
        }),
      ]),
      card({
        title: 'Expenses',
        tight: true,
        body: dataTable({
          rowKey: (r) => r.id,
          sort: data.sort,
          onSort: (key, dir) => { sort = { sort: key, dir }; load(); },
          columns: [
            { key: 'reference', header: 'Reference', phone: false },
            {
              key: 'expense_date', header: 'Date', sortKey: 'expense_date',
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('span', { text: dateLabel(r.expense_date) }),
                el('small', { text: `${monthLabel(r.accounting_month)} books` }),
              ]),
            },
            {
              key: 'description', header: 'Description', wrap: true,
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('strong', { text: r.description || r.category_name }),
                el('small', { text: r.vendor ? `${r.category_name} · ${r.vendor}` : r.category_name }),
              ]),
            },
            {
              key: 'ssn_name', header: 'SSN', sortKey: 'ssn',
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('span', { text: r.ssn_name }),
                el('small', { text: r.sub_name }),
              ]),
            },
            { key: 'status', header: 'Status', sortKey: 'status', render: (r) => pill(r.status) },
            {
              key: 'amount_cents', header: 'Amount', align: 'right', sortKey: 'amount',
              render: (r) => moneyCell(r.amount_cents, { colour: false }),
            },
            {
              key: 'actions', header: '', actions: true,
              render: (r) => el('div', { class: 'row-actions' }, [
                el('button', {
                  class: 'btn btn-ghost btn-sm', type: 'button', icon: 'eye', text: 'View',
                  onClick: () => openDetail({ expense: r, session, onSaved: load, navigate }),
                }),
                session.can('expenses.edit')
                  ? el('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', icon: 'edit', text: 'Edit',
                    onClick: () => openForm({ expense: r, ssns, categories, onSaved: load }),
                  })
                  : null,
              ]),
            },
          ],
          rows: data.rows,
          emptyState: empty({
            icon: 'inbox',
            title: 'No expenses match',
            message: ssns.length
              ? 'An expense reduces the net of the SSN it is charged to.'
              : 'Add an SSN first — an expense has to be charged to one.',
            action: session.can('expenses.create') && ssns.length
              ? el('button', {
                class: 'btn btn-primary', type: 'button', text: 'Record an expense',
                onClick: () => openForm({ ssns, categories, onSaved: load }),
              })
              : null,
          }),
          footer: data.rows.length ? {
            amount_cents: el('strong', {}, moneyCell(
              data.rows.reduce((acc, r) => acc + (r.status === 'approved' ? r.amount_cents : 0), 0),
              { colour: false }
            )),
            status: el('small', { text: 'page total, approved only' }),
          } : null,
        }),
      }),
      pager({ pagination: data.pagination, onPage: (next) => { page = next; load(); } }),
    );
  }

  await load();
}

/* -------------------------------------------------------------------- form -- */

function openForm({ expense = null, ssns, categories, onSaved }) {
  const editing = Boolean(expense);
  const form = el('form', { class: 'form-grid' });

  const ssn = field({
    label: 'Charge to SSN', name: 'ssn_id', type: 'select', required: true,
    value: expense?.ssn_id ?? ssns[0]?.id ?? '',
    options: ssns.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` })),
    hint: 'This reduces that SSN\'s net for the month',
  });
  const category = field({
    label: 'Category', name: 'category_id', type: 'select', required: true,
    value: expense?.category_id ?? categories[0]?.id ?? '',
    options: categories.map((c) => ({ value: c.id, label: c.name })),
  });
  const amount = field({
    label: 'Amount', name: 'amount', required: true,
    value: expense ? centsToInput(expense.amount_cents) : '',
    placeholder: '3000.00',
  });
  const description = field({
    label: 'Description', name: 'description', value: expense?.description ?? '',
    placeholder: 'Contract designer',
  });
  const vendor = field({ label: 'Vendor', name: 'vendor', value: expense?.vendor ?? '' });
  const expenseDate = field({
    label: 'Expense date', name: 'expense_date', type: 'date', required: true,
    value: expense?.expense_date ?? todayValue(),
  });
  const month = field({
    label: 'Accounting month', name: 'accounting_month', type: 'month', required: true,
    value: expense ? monthValue(expense.accounting_month) : currentMonthValue(),
    hint: 'Which month\'s statement this cost belongs to',
  });
  const method = field({ label: 'Payment method', name: 'payment_method', value: expense?.payment_method ?? '' });
  const paymentRef = field({
    label: 'Payment reference', name: 'payment_reference', value: expense?.payment_reference ?? '',
  });
  const status = field({
    label: 'Status', name: 'status', type: 'select', value: expense?.status ?? 'approved',
    options: [
      { value: 'approved', label: 'Approved — deducted' },
      { value: 'draft', label: 'Draft — not yet deducted' },
      { value: 'void', label: 'Void — reversed' },
    ],
  });
  const error = el('p', { class: 'form-error', hidden: true });

  form.append(ssn, category, amount, description, vendor, expenseDate, month,
    method, paymentRef, status, error);

  const dialog = modal({
    title: editing ? `Edit ${expense.reference}` : 'Record an expense',
    body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: editing ? 'Save' : 'Record',
        onClick: (event) => withBusy(event.currentTarget, async () => {
          error.hidden = true;
          const payload = {
            ssn_id: Number(ssn.input.value),
            category_id: Number(category.input.value),
            amount: amount.input.value,
            description: description.input.value.trim() || null,
            vendor: vendor.input.value.trim() || null,
            expense_date: expenseDate.input.value,
            accounting_month: month.input.value,
            payment_method: method.input.value.trim() || null,
            payment_reference: paymentRef.input.value.trim() || null,
            status: status.input.value,
          };
          try {
            if (editing) await api.put(`/api/expenses/${expense.id}`, payload);
            else await api.post('/api/expenses', payload);
            toastSuccess(editing ? 'Expense updated.' : 'Expense recorded.');
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

function openDetail({ expense, session, onSaved, navigate }) {
  const dialog = modal({
    title: expense.reference,
    body: [
      detailList([
        ['Amount', money(expense.amount_cents)],
        ['Charged to', `${expense.sub_name} · ${expense.ssn_name}`],
        ['Category', expense.category_name],
        ['Description', expense.description ?? '—'],
        ['Vendor', expense.vendor ?? '—'],
        ['Expense date', dateLabel(expense.expense_date)],
        ['Accounting month', monthLabel(expense.accounting_month)],
        ['Payment', [expense.payment_method, expense.payment_reference].filter(Boolean).join(' · ') || '—'],
        ['Status', expense.status],
        ['Recorded', `${timestampLabel(expense.created_at)}${expense.created_by_name ? ` by ${expense.created_by_name}` : ''}`],
      ]),
    ],
    footer: [
      el('button', {
        class: 'btn', type: 'button', text: 'Open statement',
        onClick: () => {
          dialog.close();
          navigate('statement', {
            ssn: expense.ssn_id, month: monthValue(expense.accounting_month),
          });
        },
      }),
      session.canDelete('expenses.delete')
        ? el('button', {
          class: 'btn btn-danger', type: 'button', text: 'Delete',
          onClick: async () => {
            const result = await confirmDialog({
              title: `Delete ${expense.reference}?`,
              message: `This permanently removes ${money(expense.amount_cents)} of cost from `
                + `${expense.ssn_name}'s ${monthLabel(expense.accounting_month)} statement, `
                + 'which will increase what that month distributes.',
              confirmLabel: 'Delete',
              danger: true,
              requireReason: true,
            });
            if (!result.confirmed) return;
            await api.del(`/api/expenses/${expense.id}`, { reason: result.reason });
            toastSuccess('Expense deleted.');
            dialog.close();
            await onSaved?.();
          },
        })
        : null,
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Close', onClick: () => dialog.close() }),
    ],
  });
}
