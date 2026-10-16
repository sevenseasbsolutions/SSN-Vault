import { api } from '../api.js';
import {
  el, card, dataTable, statCard, empty, field, mount, loading, moneyCell, pill,
} from '../ui.js';
import {
  money, percent, monthLabel, monthValue, dateLabel,
  currentMonthValue, todayValue, addMonthsValue,
} from '../format.js';
import { chartBox, barChart, destroyCharts } from '../charts.js';
import {
  filterDisclosure, cleanFilters, countActiveFilters, rangePicker,
} from '../filters.js';
import { icon } from '../icons.js';

/**
 * Tax holds, and nothing else.
 *
 * Four questions, and only those: what was held, what the salaries' own rates
 * came to, where an override changed that, and what rate it actually works out
 * to. Income beyond the amount the hold is taken FROM lives on the dashboard —
 * repeating it here would make this a second, worse dashboard.
 */

const BASES = [
  { key: '', label: 'However it was set' },
  { key: 'per_job', label: 'From the job rates only' },
  { key: 'override', label: 'Overridden only' },
];

export default async function tax({ view, actions, query, session, navigate, setQuery }) {
  const [ssnList, subList] = await Promise.all([
    api.get('/api/org/meta/ssns').then((r) => r.rows).catch(() => []),
    api.get('/api/org/meta/sub-companies').then((r) => r.rows).catch(() => []),
  ]);

  let filters = {
    month: query.month ?? '',
    date_from: query.date_from ?? '',
    date_to: query.date_to ?? '',
    sub_id: query.sub_id ?? '',
    ssn_id: query.ssn_id ?? '',
    basis: BASES.some((b) => b.key && b.key === query.basis) ? query.basis : '',
  };

  const controls = el('div');
  const body = el('div');
  view.append(controls, body);

  /* ------------------------------------------------------------- filtering -- */

  // A month, or a span of dates -- never both. The picker enforces that.
  const picker = rangePicker({ value: filters, onChange: () => apply() });

  const subField = field({
    label: 'Sub-company', name: 'sub_id', type: 'select', value: filters.sub_id,
    options: [{ value: '', label: 'All sub-companies' },
      ...subList.filter((s) => s.is_active).map((s) => ({ value: s.id, label: s.name }))],
  });
  const ssnField = field({
    label: 'SSN', name: 'ssn_id', type: 'select', value: filters.ssn_id,
    options: [{ value: '', label: 'All SSNs' },
      ...ssnList.map((d) => ({ value: d.id, label: `${d.sub_name} · ${d.name}` }))],
  });
  const basisField = field({
    label: 'How the hold was set', name: 'basis', type: 'select', value: filters.basis,
    options: BASES.map((b) => ({ value: b.key, label: b.label })),
    hint: 'Find the months someone overrode',
  });

  // Choosing a sub-company narrows the SSN list to it, so the two filters
  // cannot be set to contradict each other.
  const syncSsnOptions = () => {
    const subId = subField.input.value;
    const eligible = subId
      ? ssnList.filter((d) => String(d.sub_id) === String(subId))
      : ssnList;
    const current = ssnField.input.value;
    mount(ssnField.input,
      el('option', { value: '', text: subId ? 'All SSNs in this sub-company' : 'All SSNs' }),
      ...eligible.map((d) => el('option', {
        value: d.id, text: subId ? d.name : `${d.sub_name} · ${d.name}`,
      })));
    ssnField.input.value = eligible.some((d) => String(d.id) === String(current)) ? current : '';
  };

  /*
   * A span of months is asked for with dates: from the first of the earliest
   * month wanted, to today. "This month" answers the other question, so it
   * sets the single-month control instead.
   */
  const lastMonths = (count) => {
    const start = addMonthsValue(currentMonthValue(), -(count - 1));
    picker.setDates(`${start}-01`, todayValue());
    apply();
  };

  const presets = el('div', { class: 'preset-row' }, [
    el('span', { class: 'preset-label', text: 'Quick range' }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: 'This month',
      onClick: () => { picker.setMonth(currentMonthValue()); apply(); },
    }),
    el('button', { class: 'btn btn-sm', type: 'button', text: 'Last 3 months', onClick: () => lastMonths(3) }),
    el('button', { class: 'btn btn-sm', type: 'button', text: 'Last 12 months', onClick: () => lastMonths(12) }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: 'Tax year to date',
      onClick: () => {
        picker.setDates(`${todayValue().slice(0, 4)}-01-01`, todayValue());
        apply();
      },
    }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: 'Clear',
      onClick: () => {
        picker.clear();
        for (const f of [subField, ssnField, basisField]) f.input.value = '';
        apply();
      },
    }),
  ]);

  /**
   * Read the controls, update the URL quietly, and re-render the results.
   *
   * The filter panel is never rebuilt, so it stays open across as many changes
   * as you want to make, and the page does not flash.
   */
  function apply() {
    filters = {
      ...picker.read(),
      sub_id: subField.input.value,
      ssn_id: ssnField.input.value,
      basis: basisField.input.value,
    };
    syncFilters();
    setQuery('tax', cleanFilters(filters));
    load();
  }

  subField.input.addEventListener('change', () => { syncSsnOptions(); apply(); });
  for (const f of [ssnField, basisField]) {
    f.input.addEventListener('change', apply);
  }

  const { panel, sync: syncFilters } = filterDisclosure({
    actions, id: 'tax-filters', count: () => countActiveFilters(filters),
  });
  panel.append(card({
    body: el('div', {}, [
      el('div', { class: 'filter-row' }, [...picker.fields, subField, ssnField, basisField]),
      presets,
    ]),
  }));
  controls.append(panel);
  syncSsnOptions();

  /* ---------------------------------------------------------------- render -- */

  /*
   * Re-render the results, and only the results.
   *
   * Every pass replaces the whole of `body`, so the charts drawn by the last
   * one are destroyed first: Chart.js holds each instance in a registry with
   * its own resize and hover listeners, and dropping the canvas alone would
   * leave those behind on every filter change.
   */
  async function load() {
    destroyCharts();
    mount(body, el('div', { class: 'card' }, loading(5)));
    const data = await api.get('/api/tax', cleanFilters(filters));
    const t = data.totals;
    const range = data.range;

    const rangeLabel = range.from === range.to
      ? monthLabel(range.from)
      : `${monthLabel(range.from)} – ${monthLabel(range.to)}`;
    /*
     * Asked for by date, the dates are what was typed and the months are what
     * came back. Both are shown: a date span is answered in whole months.
     */
    const askedByDate = range.basis === 'dates' && (range.date_from || range.date_to);
    const dateLabelText = askedByDate
      ? `${range.date_from ? dateLabel(range.date_from) : 'the start'} – `
        + `${range.date_to ? dateLabel(range.date_to) : 'today'}`
      : null;

    const narrowed = [
      data.filters.ssn_name ? `SSN: ${data.filters.ssn_name}` : null,
      data.filters.sub_name && !data.filters.ssn_name
        ? `Sub-company: ${data.filters.sub_name}` : null,
      data.filters.basis
        ? BASES.find((b) => b.key === data.filters.basis)?.label ?? null
        : null,
    ].filter(Boolean);

    /*
     * How the override moved the figure, in words. "0 overrides" is worth saying
     * plainly; a non-zero one is only meaningful next to the amount it shifted.
     */
    const overrideFoot = t.override_months === 0
      ? 'every month left to the job rates'
      : `${t.override_delta_cents === 0 ? 'no net change' : money(t.override_delta_cents, { signed: true })}`
        + ' against the job rates';

    mount(body,
      el('div', { class: 'range-bar' }, [
        el('span', { class: 'range-main' }, [
          icon('calendar-clock', { size: 13 }),
          el('strong', { text: askedByDate ? dateLabelText : rangeLabel }),
          el('small', {
            text: askedByDate
              ? `${rangeLabel} · ${range.months === 1 ? '1 month' : `${range.months} months`} in full`
              : (range.months === 1 ? '1 month' : `${range.months} months`),
          }),
        ]),
        ...narrowed.map((text) => pill('draft', text)),
        range.truncated ? pill('void', `capped at ${range.max_months} months`) : null,
      ]),

      el('div', { class: 'stat-grid' }, [
        statCard({
          label: 'Total Tax Hold',
          icon: 'shield',
          value: money(t.tax_hold_cents),
          tone: 'reserve',
          foot: `across ${t.ssn_count} SSN${t.ssn_count === 1 ? '' : 's'}`,
        }),
        statCard({
          label: 'From the job rates',
          icon: 'percent',
          value: money(t.computed_tax_cents),
          foot: 'what the salaries come to on their own',
        }),
        statCard({
          label: 'Overridden',
          icon: 'edit',
          value: `${t.override_months} month${t.override_months === 1 ? '' : 's'}`,
          foot: overrideFoot,
        }),
        statCard({
          label: 'Effective rate',
          icon: 'equals',
          value: t.effective_bps === null ? '—' : percent(t.effective_bps),
          foot: t.effective_bps === null
            ? 'nothing credited to hold from'
            : `of ${money(t.credited_cents)} credited`,
        }),
      ]),

      card({
        title: `Tax Hold · ${rangeLabel}`,
        sub: 'A job carries the rate; every salary on it is held at that rate. '
          + 'Override a single month from an SSN’s statement.',
        tight: true,
        body: dataTable({
          rowKey: (r) => r.ssn_id,
          columns: [
            {
              key: 'ssn_name', header: 'SSN',
              render: (r) => el('div', { class: 'cell-stack' }, [
                el('strong', { text: r.ssn_name }),
                el('small', { text: r.sub_name }),
              ]),
            },
            {
              key: 'credited_cents', header: 'Held from', align: 'right', phone: false,
              render: (r) => moneyCell(r.credited_cents, { colour: false }),
            },
            {
              key: 'computed_tax_cents', header: 'Job rates', align: 'right',
              render: (r) => moneyCell(r.computed_tax_cents, { colour: false }),
            },
            {
              key: 'override_months', header: 'Override',
              render: (r) => (r.override_months === 0
                ? el('small', { class: 'muted', text: '—' })
                : el('div', { class: 'cell-stack' }, [
                  pill('draft', `${r.override_months} month${r.override_months === 1 ? '' : 's'}`),
                  r.override_delta_cents !== 0
                    ? el('small', { text: money(r.override_delta_cents, { signed: true }) })
                    : null,
                ])),
            },
            {
              key: 'tax_hold_cents', header: 'Tax Hold', align: 'right',
              render: (r) => el('strong', {}, moneyCell(r.tax_hold_cents, { colour: false })),
            },
            {
              key: 'effective_bps', header: 'Effective', align: 'right',
              render: (r) => el('span', {
                class: 'num', text: r.effective_bps === null ? '—' : percent(r.effective_bps),
              }),
            },
            {
              key: 'actions', header: '', actions: true,
              render: (r) => el('button', {
                class: 'btn btn-ghost btn-sm', type: 'button',
                text: session.can('tax.manage') ? 'Statement / override' : 'Statement',
                onClick: () => navigate('statement', {
                  ssn: r.ssn_id, month: monthValue(r.month_to ?? range.to),
                }),
              }),
            },
          ],
          rows: data.rows,
          footer: data.rows.length ? {
            ssn_name: el('strong', { text: 'Total' }),
            credited_cents: moneyCell(t.credited_cents, { colour: false }),
            computed_tax_cents: moneyCell(t.computed_tax_cents, { colour: false }),
            tax_hold_cents: el('strong', {}, moneyCell(t.tax_hold_cents, { colour: false })),
            effective_bps: t.effective_bps === null ? '—' : percent(t.effective_bps),
          } : null,
          emptyState: empty({
            icon: 'shield',
            title: narrowed.length ? 'Nothing matches these filters' : 'Nothing held back',
            message: narrowed.length
              ? 'Widen the range, or clear the SSN, sub-company and basis filters.'
              : 'A hold comes out of what a salary credited. With no salaries recorded '
                + 'there is nothing to hold.',
          }),
        }),
      }),

      /*
       * The job rates against what was actually held, month by month. Where the
       * two bars differ, an override moved that month — which is the one thing
       * this chart exists to make obvious.
       */
      data.trend.length > 1
        ? chartBox({
          title: 'Tax Hold by month',
          basis: 'Accounting month',
          height: 260,
          build: (node) => barChart(node, {
            labels: data.trend.map((r) => monthLabel(r.month)),
            datasets: [
              { label: 'From the job rates', data: data.trend.map((r) => r.computed_tax_cents / 100) },
              { label: 'Actually held', data: data.trend.map((r) => r.tax_hold_cents / 100) },
            ],
          }),
        })
        : null,

      card({
        title: 'How the hold is decided',
        tight: true,
        body: el('div', { class: 'flow-note' }, [
          el('p', { text: 'Each job carries a tax-hold percentage, applied to the amount '
            + 'credited on every salary recorded against it — so two salaries in one month '
            + 'can be held at different rates. Each is worked out and rounded on its own, '
            + 'then summed, so this page always agrees with the lines on a statement.' }),
          el('p', { class: 'muted', text: 'When the real tax bill differs, record an override '
            + 'on that month’s statement. The salaries stay as recorded and the exception is '
            + 'kept with its reason and author — which is why "Job rates" and "Tax Hold" are '
            + 'shown side by side above.' }),
          el('p', { class: 'muted', text: 'A hold never exceeds the amount credited, so a '
            + 'month that credited nothing holds nothing.' }),
        ]),
      }),
    );
  }

  await load();
}
