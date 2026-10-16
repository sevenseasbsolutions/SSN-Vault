import { api } from '../api.js';
import {
  el, card, dataTable, statCard, empty, field, mount, loading, moneyCell,
} from '../ui.js';
import { money, percent, monthLabel, monthValue, currentMonthValue, addMonthsValue } from '../format.js';
import { chartBox, barChart } from '../charts.js';

/**
 * Reports.
 *
 * Two questions, two tabs: what every SSN did in one month, and what
 * one SSN did across several. Each states the basis it is built on,
 * because a figure without its basis is not a figure.
 */

const TABS = [
  { key: 'month', label: 'One month, all SSNs' },
  { key: 'ssn', label: 'One SSN, over time' },
];

export default async function reports({ view, actions, query, session, navigate }) {
  const ssns = await api.get('/api/org/meta/ssns').then((r) => r.rows);
  let tab = TABS.some((t) => t.key === query.tab) ? query.tab : 'month';

  const tabBar = el('div', { class: 'tabs' }, TABS.map((t) => el('button', {
    class: `tab${t.key === tab ? ' active' : ''}`, type: 'button', text: t.label,
    onClick: () => navigate('reports', { tab: t.key }),
  })));
  view.append(tabBar);

  const body = el('div');
  view.append(body);

  if (!ssns.length) {
    return mount(body, card({
      body: empty({
        icon: 'report',
        title: 'Nothing to report yet',
        message: 'Reports are built from SSNs. Add one to its sub-company first.',
      }),
    }));
  }

  if (tab === 'month') await monthReport({ body, actions, query, session, navigate });
  else await ssnReport({ body, actions, query, session, ssns, navigate });
}

/* ------------------------------------------------------------ month report -- */

async function monthReport({ body, actions, query, session, navigate }) {
  let month = query.month || '';

  const monthPicker = field({
    label: 'Accounting month', name: 'month', type: 'month', value: month || currentMonthValue(),
  });
  monthPicker.input.addEventListener('change', () => {
    navigate('reports', { tab: 'month', month: monthPicker.input.value });
  });
  mount(actions, el('div', { class: 'inline-field' }, monthPicker));

  mount(body, el('div', { class: 'card' }, loading(5)));
  const data = await api.get('/api/reports/month', month ? { month } : {});

  if (session.can('reports.export')) {
    actions.append(exportButtons(`/api/reports/export/month`, month ? { month } : {}));
  }

  mount(body,
    el('div', { class: 'stat-grid' }, [
      statCard({ label: 'Credited', icon: 'trending-up', value: money(data.totals.credited_cents),
        foot: `${money(data.totals.withheld_cents)} withheld` }),
      statCard({ label: 'Expenses', icon: 'trending-down', value: money(data.totals.expense_cents) }),
      statCard({ label: 'Tax Hold', icon: 'shield', value: money(data.totals.tax_hold_cents) }),
      statCard({ label: 'SSN share', icon: 'layers', value: money(data.totals.keep_cents) }),
      statCard({
        label: `${data.main?.name ?? 'Main company'} share`, icon: 'vault', tone: 'primary',
        value: money(data.received_by_main_cents),
      }),
    ]),

    card({
      title: data.basis.title,
      basis: 'Accounting month',
      sub: data.basis.note,
      tight: true,
      body: dataTable({
        rowKey: (r) => r.ssn_id,
        columns: ssnColumns(navigate),
        rows: data.rows,
        footer: data.rows.length ? footerFor(data.totals) : null,
        emptyState: empty({ icon: 'inbox', title: 'No activity in this month' }),
      }),
    }),

    data.rows.length
      ? chartBox({
        title: 'What each SSN kept and passed up',
        basis: 'Accounting month',
        height: 260,
        build: (node) => barChart(node, {
          labels: data.rows.map((r) => r.ssn_name),
          datasets: [
            { label: 'Kept', data: data.rows.map((r) => r.keep_cents / 100) },
            { label: 'Passed up', data: data.rows.map((r) => r.upstream_cents / 100) },
          ],
          stacked: true,
        }),
      })
      : null,
  );
}

/* ------------------------------------------------------- SSN report -- */

async function ssnReport({ body, actions, query, session, ssns, navigate }) {
  const ssnId = Number(query.ssn) || ssns[0].id;
  const to = query.month_to || currentMonthValue();
  const from = query.month_from || addMonthsValue(to, -5);

  const ssnPicker = field({
    label: 'SSN', name: 'ssn', type: 'select', value: String(ssnId),
    options: ssns.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` })),
  });
  const fromPicker = field({ label: 'From', name: 'month_from', type: 'month', value: from });
  const toPicker = field({ label: 'To', name: 'month_to', type: 'month', value: to });

  const reload = () => navigate('reports', {
    tab: 'ssn',
    ssn: ssnPicker.input.value,
    month_from: fromPicker.input.value,
    month_to: toPicker.input.value,
  });
  for (const picker of [ssnPicker, fromPicker, toPicker]) {
    picker.input.addEventListener('change', reload);
  }
  mount(actions, el('div', { class: 'inline-field' }, [ssnPicker, fromPicker, toPicker]));

  mount(body, el('div', { class: 'card' }, loading(5)));
  const data = await api.get(`/api/reports/ssn/${ssnId}`, {
    month_from: from, month_to: to,
  });

  if (session.can('reports.export')) {
    actions.append(exportButtons(`/api/reports/export/ssn/${ssnId}`, {
      month_from: from, month_to: to,
    }));
  }

  mount(body,
    el('div', { class: 'stat-grid' }, [
      statCard({ label: 'Credited', icon: 'trending-up', value: money(data.totals.credited_cents),
        foot: `${money(data.totals.withheld_cents)} withheld` }),
      statCard({ label: 'Expenses', icon: 'trending-down', value: money(data.totals.expense_cents) }),
      statCard({ label: 'Tax Hold', icon: 'shield', value: money(data.totals.tax_hold_cents) }),
      statCard({
        label: `${data.ssn.name} kept`, icon: 'layers', tone: 'primary',
        value: money(data.totals.keep_cents),
        foot: `${percent(data.ssn.share_bps)} of distributable`,
      }),
      statCard({
        label: `Passed to ${data.ssn.sub_name ?? 'the sub-company'}`, icon: 'arrow-up',
        value: money(data.totals.upstream_cents),
      }),
    ]),

    card({
      title: data.basis.title,
      basis: 'Accounting month',
      sub: data.basis.note,
      tight: true,
      body: dataTable({
        rowKey: (r) => r.accounting_month,
        columns: [
          {
            key: 'accounting_month', header: 'Month',
            render: (r) => el('button', {
              class: 'link-btn', type: 'button', text: monthLabel(r.accounting_month),
              onClick: () => navigate('statement', {
                ssn: r.ssn_id, month: monthValue(r.accounting_month),
              }),
            }),
          },
          { key: 'job_count', header: 'Jobs', align: 'right', phone: false },
          { key: 'credited_cents', header: 'Credited', align: 'right', render: (r) => moneyCell(r.credited_cents, { colour: false }) },
  { key: 'salary_cents', header: 'To the SSN', align: 'right', phone: false, render: (r) => moneyCell(r.salary_cents, { colour: false }) },
          { key: 'expense_cents', header: 'Expenses', align: 'right', phone: false, render: (r) => moneyCell(r.expense_cents, { colour: false }) },
          { key: 'tax_hold_cents', header: 'Tax Hold', align: 'right', phone: false, render: (r) => moneyCell(r.tax_hold_cents, { colour: false }) },
          { key: 'distributable_cents', header: 'Distributable', align: 'right', render: (r) => moneyCell(r.distributable_cents) },
          { key: 'keep_cents', header: 'SSN share', align: 'right', render: (r) => moneyCell(r.keep_cents, { colour: false }) },
          { key: 'upstream_cents', header: 'Passed up', align: 'right', render: (r) => el('strong', {}, moneyCell(r.upstream_cents, { colour: false })) },
        ],
        rows: data.rows,
        footer: footerFor(data.totals, { first: 'accounting_month' }),
        emptyState: empty({ icon: 'inbox', title: 'No activity in this range' }),
      }),
    }),

    data.rows.length > 1
      ? chartBox({
        title: `${data.ssn.name} month by month`,
        basis: 'Accounting month',
        height: 260,
        build: (node) => barChart(node, {
          labels: data.rows.map((r) => monthLabel(r.accounting_month)),
          datasets: [
            { label: 'Kept', data: data.rows.map((r) => r.keep_cents / 100) },
            { label: 'Passed up', data: data.rows.map((r) => r.upstream_cents / 100) },
            { label: 'Tax Hold', data: data.rows.map((r) => r.tax_hold_cents / 100) },
          ],
          stacked: true,
        }),
      })
      : null,
  );
}

/* ----------------------------------------------------------------- shared -- */

const ssnColumns = (navigate) => [
  {
    key: 'ssn_name', header: 'SSN',
    render: (r) => el('button', {
      class: 'link-btn', type: 'button', text: r.ssn_name,
      onClick: () => navigate('statement', {
        ssn: r.ssn_id, month: monthValue(r.accounting_month),
      }),
    }),
  },
  { key: 'sub_name', header: 'Sub-company', phone: false },
  { key: 'job_count', header: 'Jobs', align: 'right', phone: false },
  { key: 'credited_cents', header: 'Credited', align: 'right', render: (r) => moneyCell(r.credited_cents, { colour: false }) },
  { key: 'salary_cents', header: 'To the SSN', align: 'right', phone: false, render: (r) => moneyCell(r.salary_cents, { colour: false }) },
  { key: 'expense_cents', header: 'Expenses', align: 'right', phone: false, render: (r) => moneyCell(r.expense_cents, { colour: false }) },
  { key: 'tax_hold_cents', header: 'Tax Hold', align: 'right', phone: false, render: (r) => moneyCell(r.tax_hold_cents, { colour: false }) },
  { key: 'share_bps', header: 'Share %', align: 'right', phone: false, render: (r) => el('span', { class: 'num', text: percent(r.share_bps) }) },
  { key: 'keep_cents', header: 'SSN share', align: 'right', render: (r) => moneyCell(r.keep_cents, { colour: false }) },
  { key: 'upstream_cents', header: 'Passed up', align: 'right', render: (r) => el('strong', {}, moneyCell(r.upstream_cents, { colour: false })) },
];

const footerFor = (totals, { first = 'ssn_name' } = {}) => ({
  [first]: el('strong', { text: 'Total' }),
  job_count: String(totals.job_count),
  credited_cents: moneyCell(totals.credited_cents, { colour: false }),
  salary_cents: moneyCell(totals.salary_cents, { colour: false }),
  expense_cents: moneyCell(totals.expense_cents, { colour: false }),
  tax_hold_cents: moneyCell(totals.tax_hold_cents, { colour: false }),
  distributable_cents: moneyCell(totals.distributable_cents),
  keep_cents: moneyCell(totals.keep_cents, { colour: false }),
  upstream_cents: el('strong', {}, moneyCell(totals.upstream_cents, { colour: false })),
});

/**
 * Export links as real anchors.
 *
 * The browser's own download handling keeps the session cookie and the
 * Content-Disposition filename, which a fetch-and-blob would both lose.
 */
function exportButtons(path, params) {
  const href = (format) => {
    const search = new URLSearchParams({ ...params, format });
    return `${path}?${search}`;
  };
  return el('div', { class: 'btn-group' }, [
    el('a', { class: 'btn', href: href('csv'), icon: 'download', text: 'CSV' }),
    el('a', { class: 'btn', href: href('xlsx'), icon: 'download', text: 'Excel' }),
  ]);
}
