import { api } from '../api.js';
import {
  el, card, statCard, dataTable, empty, field, mount, loading, moneyCell, pill,
} from '../ui.js';
import {
  money, percent, monthLabel, monthValue, dateLabel,
  currentMonthValue, todayValue, addMonthsValue,
} from '../format.js';
import { chartBox, barChart, lineChart, monthLabels, destroyCharts } from '../charts.js';
import {
  filterDisclosure, cleanFilters, countActiveFilters, rangePicker,
} from '../filters.js';
import { icon } from '../icons.js';

/**
 * The dashboard: a month range, the whole tree, narrowed however you like.
 *
 * Every figure comes from one call to /api/dashboard, which applies the filters
 * in the engine. The page never re-sums anything, so a filtered total and an
 * unfiltered one cannot disagree.
 *
 * Changing a filter re-renders ONLY the results, via setQuery rather than
 * navigate: a hash change would tear the whole view down, which blinks the
 * screen and snaps the filter panel shut after every single change.
 */

/*
 * What a chart can be narrowed to. 'all' shows the two standing charts; naming
 * one measure replaces them with that series alone, which is how you look at,
 * say, expenses on their own.
 */
const MEASURES = [
  { key: 'all', label: 'Everything' },
  { key: 'invoice_cents', label: 'Invoiced' },
  { key: 'credited_cents', label: 'Income Before Tax Hold' },
  { key: 'withheld_cents', label: 'Deducted by companies (W2)' },
  { key: 'tax_hold_cents', label: 'Tax Hold' },
  { key: 'expense_cents', label: 'Expenses' },
  { key: 'salary_cents', label: 'To the SSNs' },
  { key: 'ssn_kept_cents', label: 'SSN share' },
  { key: 'received_cents', label: 'Main company share' },
];

export default async function dashboard({ view, actions, query, session, navigate, setQuery }) {
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
  };
  let measure = MEASURES.some((m) => m.key === query.measure) ? query.measure : 'all';
  // Which headline figure has its breakdown open. Survives a filter change,
  // because only the results are re-rendered.
  let open = null;

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
  const measureField = field({
    label: 'Chart', name: 'measure', type: 'select', value: measure,
    options: MEASURES.map((m) => ({ value: m.key, label: m.label })),
    hint: 'Pick one to chart it on its own',
  });

  /*
   * Choosing a sub-company narrows the SSN list to it, so the two filters
   * cannot be set to contradict each other.
   */
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
   * A span of months is now asked for with dates: from the first of the
   * earliest month wanted, to today. The single-month control answers the
   * other question, so "this month" sets that instead.
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
    el('button', { class: 'btn btn-sm', type: 'button', text: 'Last 6 months', onClick: () => lastMonths(6) }),
    el('button', { class: 'btn btn-sm', type: 'button', text: 'Last 12 months', onClick: () => lastMonths(12) }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: 'Clear',
      onClick: () => {
        picker.clear();
        for (const f of [subField, ssnField]) f.input.value = '';
        measureField.input.value = 'all';
        syncSsnOptions();
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
    };
    measure = measureField.input.value;
    syncFilters();
    setQuery('dashboard', cleanFilters({ ...filters, measure: measure === 'all' ? '' : measure }));
    load();
  }

  subField.input.addEventListener('change', () => { syncSsnOptions(); apply(); });
  for (const f of [ssnField, measureField]) {
    f.input.addEventListener('change', apply);
  }

  const { panel, sync: syncFilters } = filterDisclosure({
    actions, id: 'dashboard-filters',
    count: () => countActiveFilters({ ...filters, measure: measure === 'all' ? '' : measure }),
  });
  panel.append(card({
    body: el('div', {}, [
      el('div', { class: 'filter-row' }, [...picker.fields, subField, ssnField, measureField]),
      presets,
    ]),
  }));
  controls.append(panel);
  syncSsnOptions();

  /* ---------------------------------------------------------------- results -- */

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
    const data = await api.get('/api/dashboard', cleanFilters(filters));

    if (data.setup_needed) {
      return mount(body, card({
        body: empty({
          icon: 'building',
          title: 'Set up your company structure first',
          message: 'Create the main company, the sub-companies under it, and the SSNs '
            + 'that work the jobs. Every figure on this page is built from that tree.',
          action: session.can('org.manage')
            ? el('button', {
              class: 'btn btn-primary', type: 'button', text: 'Build the structure',
              onClick: () => navigate('org'),
            })
            : null,
        }),
      }));
    }

    const roll = data.rollup;
    const mainName = data.main?.name ?? 'the main company';
    const range = data.range;
    // One month reads as that month; several read as a span.
    const rangeLabel = range.from === range.to
      ? monthLabel(range.from)
      : `${monthLabel(range.from)} – ${monthLabel(range.to)}`;
    /*
     * Asked for by date, the dates are what the reader typed and the months
     * are what they got. Saying both is the only honest label: every month the
     * span touches is counted in full.
     */
    const askedByDate = range.basis === 'dates' && (range.date_from || range.date_to);
    const dateLabelText = askedByDate
      ? `${range.date_from ? dateLabel(range.date_from) : 'the start'} – `
        + `${range.date_to ? dateLabel(range.date_to) : 'today'}`
      : null;
    // The newest month in view, for links into a single-month statement.
    const linkMonth = monthValue(range.to);

    const narrowed = [
      data.filters.ssn_name ? `SSN: ${data.filters.ssn_name}` : null,
      data.filters.sub_name && !data.filters.ssn_name
        ? `Sub-company: ${data.filters.sub_name}` : null,
    ].filter(Boolean);

    /* ---------------------------------------- the cards, and their details -- */

    /*
     * Each headline figure opens a breakdown of itself, in a panel below the
     * grid rather than inside a card, so the figures stay put while the detail
     * changes underneath them. Every breakdown is built from rows already
     * fetched, so opening one costs no request and cannot show a figure that
     * disagrees with the card above it.
     */
    const detailHost = el('div');

    const col = (key, header, { bold = false, phone = true } = {}) => ({
      key, header, align: 'right', phone,
      render: (r) => (bold
        ? el('strong', {}, moneyCell(r[key], { colour: false }))
        : moneyCell(r[key], { colour: false })),
    });

    const ssnCol = {
      key: 'ssn_name', header: 'SSN',
      render: (r) => el('div', { class: 'cell-stack' }, [
        el('strong', { text: r.ssn_name }),
        el('small', { text: r.sub_name }),
      ]),
    };

    const statementAction = {
      key: 'actions', header: '', actions: true,
      render: (r) => el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: 'Statement',
        onClick: () => navigate('statement', { ssn: r.ssn_id, month: linkMonth }),
      }),
    };

    /** What each sub-company collected and passed up. */
    const bySubCompany = () => dataTable({
      columns: [
        { key: 'unit_name', header: 'Sub-company', render: (r) => el('strong', { text: r.unit_name }) },
        { key: 'ssn_count', header: 'SSNs', align: 'right', phone: false },
        col('credited_cents', 'Income'),
        col('tax_hold_cents', 'Tax Hold', { phone: false }),
        col('expense_cents', 'Expenses', { phone: false }),
        col('ssn_kept_cents', 'SSN share'),
        col('passed_up_cents', `To ${mainName}`, { bold: true }),
      ],
      rows: roll.sub_companies,
      footer: {
        unit_name: el('strong', { text: 'Total' }),
        ssn_count: String(roll.ssn_count),
        credited_cents: moneyCell(roll.credited_cents, { colour: false }),
        tax_hold_cents: moneyCell(roll.tax_hold_cents, { colour: false }),
        expense_cents: moneyCell(roll.expense_cents, { colour: false }),
        ssn_kept_cents: moneyCell(roll.ssn_kept_cents, { colour: false }),
        passed_up_cents: el('strong', {}, moneyCell(roll.total_received_cents, { colour: false })),
      },
      emptyState: empty({ icon: 'building', title: 'No sub-companies in view' }),
    });

    /** Where the income came from, and what the companies kept on the way. */
    const byIncome = () => dataTable({
      rowKey: (r) => r.ssn_id,
      columns: [
        ssnCol,
        { key: 'job_count', header: 'Jobs', align: 'right', phone: false },
        { key: 'salary_count', header: 'Salaries', align: 'right', phone: false },
        col('invoice_cents', 'Invoiced'),
        col('withheld_cents', 'Deducted (W2)'),
        col('credited_cents', 'Income', { bold: true }),
        statementAction,
      ],
      rows: data.ssns,
      footer: {
        ssn_name: el('strong', { text: 'Total' }),
        job_count: String(roll.job_count),
        salary_count: String(roll.salary_count),
        invoice_cents: moneyCell(roll.invoice_cents, { colour: false }),
        withheld_cents: moneyCell(roll.withheld_cents, { colour: false }),
        credited_cents: el('strong', {}, moneyCell(roll.credited_cents, { colour: false })),
      },
      emptyState: empty({ icon: 'inbox', title: 'No income in view' }),
    });

    /**
     * Expenses by category first, then by SSN.
     *
     * "What were the expenses" is a question about what they went on, so the
     * category breakdown leads; the per-SSN split answers who carried them.
     */
    const byExpenseCategory = () => el('div', { class: 'detail-stack' }, [
      dataTable({
        columns: [
          { key: 'name', header: 'Category', render: (r) => el('strong', { text: r.name }) },
          { key: 'count', header: 'Entries', align: 'right' },
          col('amount_cents', 'Amount', { bold: true }),
        ],
        rows: data.expense_categories,
        footer: data.expense_categories.length ? {
          name: el('strong', { text: 'Total' }),
          count: String(data.expense_categories.reduce((a, r) => a + r.count, 0)),
          amount_cents: el('strong', {}, moneyCell(roll.expense_cents, { colour: false })),
        } : null,
        emptyState: empty({
          icon: 'inbox',
          title: 'No expenses in view',
          message: 'Nothing was charged to these SSNs in this range.',
        }),
      }),
      data.expense_categories.length
        ? el('div', {}, [
          el('h3', { class: 'detail-head', text: 'And by SSN' }),
          dataTable({
            rowKey: (r) => r.ssn_id,
            columns: [ssnCol, col('expense_cents', 'Expenses', { bold: true }), statementAction],
            rows: data.ssns.filter((r) => r.expense_cents !== 0),
            footer: {
              ssn_name: el('strong', { text: 'Total' }),
              expense_cents: el('strong', {}, moneyCell(roll.expense_cents, { colour: false })),
            },
          }),
        ])
        : null,
    ]);

    /** What the job rates came to against what was actually held. */
    const byTax = () => el('div', { class: 'detail-stack' }, [
      dataTable({
        rowKey: (r) => r.ssn_id,
        columns: [
          ssnCol,
          col('credited_cents', 'Held from', { phone: false }),
          col('computed_tax_cents', 'Job rates'),
          {
            key: 'override_months', header: 'Override',
            render: (r) => (r.override_months === 0
              ? el('small', { class: 'muted', text: '—' })
              : pill('draft', `${r.override_months} month${r.override_months === 1 ? '' : 's'}`)),
          },
          col('tax_hold_cents', 'Tax Hold', { bold: true }),
          statementAction,
        ],
        rows: data.ssns,
        footer: {
          ssn_name: el('strong', { text: 'Total' }),
          credited_cents: moneyCell(roll.credited_cents, { colour: false }),
          computed_tax_cents: moneyCell(roll.computed_tax_cents, { colour: false }),
          tax_hold_cents: el('strong', {}, moneyCell(roll.tax_hold_cents, { colour: false })),
        },
        emptyState: empty({ icon: 'shield', title: 'Nothing held in view' }),
      }),
      el('p', {
        class: 'form-note',
        text: 'Where "Job rates" and "Tax Hold" differ, an override moved that month.',
      }),
      el('button', {
        class: 'btn btn-sm', type: 'button', icon: 'shield', text: 'Open Tax Hold',
        onClick: () => navigate('tax', cleanFilters(filters)),
      }),
    ]);

    /** How what remained was split, SSN by SSN. */
    const byShare = () => dataTable({
      rowKey: (r) => r.ssn_id,
      columns: [
        ssnCol,
        col('distributable_cents', 'Remaining'),
        {
          key: 'share_bps', header: 'Share %', align: 'right',
          render: (r) => el('span', { class: 'num', text: percent(r.share_bps) }),
        },
        col('keep_cents', 'SSN share', { bold: true }),
        col('upstream_cents', `To ${mainName}`),
        statementAction,
      ],
      rows: data.ssns,
      footer: {
        ssn_name: el('strong', { text: 'Total' }),
        distributable_cents: moneyCell(roll.distributable_cents, { colour: false }),
        keep_cents: el('strong', {}, moneyCell(roll.ssn_kept_cents, { colour: false })),
        upstream_cents: moneyCell(roll.total_received_cents, { colour: false }),
      },
      emptyState: empty({ icon: 'layers', title: 'Nothing to split in view' }),
    });

    const CARDS = [
      {
        key: 'main',
        label: `${mainName} share`,
        icon: 'vault',
        tone: 'distribution',
        value: money(roll.total_received_cents),
        foot: `from ${roll.ssn_count} SSN${roll.ssn_count === 1 ? '' : 's'}`,
        detail: bySubCompany,
      },
      {
        key: 'income',
        label: 'Income Before Tax Hold',
        icon: 'trending-up',
        tone: 'income',
        value: money(roll.credited_cents),
        foot: `${money(roll.withheld_cents)} deducted by the companies (W2)`,
        detail: byIncome,
      },
      {
        key: 'expenses',
        label: 'Expenses',
        icon: 'trending-down',
        tone: 'expense',
        value: money(roll.expense_cents),
        foot: 'charged to SSNs',
        detail: byExpenseCategory,
      },
      {
        key: 'tax',
        label: 'Tax Hold',
        icon: 'shield',
        tone: 'reserve',
        value: money(roll.tax_hold_cents),
        foot: 'before any share is taken',
        detail: byTax,
      },
      {
        key: 'ssn',
        label: 'SSN share',
        icon: 'layers',
        tone: 'payment',
        value: money(roll.ssn_kept_cents),
        foot: 'their own shares',
        detail: byShare,
      },
    ];

    const statGrid = () => el('div', { class: 'stat-grid' }, CARDS.map((c) => statCard({
      label: c.label,
      icon: c.icon,
      value: c.value,
      // The open card keeps its own tone and gains a marker, so which panel is
      // showing is never ambiguous.
      tone: [c.tone ?? '', open === c.key ? 'open' : ''].join(' ').trim(),
      foot: c.foot,
      onClick: () => toggle(c.key),
    })));

    function renderDetail() {
      if (!open) return mount(detailHost);
      const chosen = CARDS.find((c) => c.key === open);
      return mount(detailHost, card({
        title: `${chosen.label} · ${rangeLabel}`,
        actions: el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', icon: 'x', text: 'Close',
          onClick: () => toggle(chosen.key),
        }),
        tight: true,
        body: chosen.detail(),
      }));
    }

    function toggle(key) {
      open = open === key ? null : key;
      // Swap just the grid and the panel in place, so the tables and the chart
      // below are left untouched and the page does not jump.
      body.querySelector('.stat-grid').replaceWith(statGrid());
      renderDetail();
    }

    mount(body,
      /* ------------------------------------------------- what is being shown -- */
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

      statGrid(),
      detailHost,

      /* ----------------------------------------------------- per sub-company -- */
      roll.sub_companies.length > 1
        ? card({
          title: 'By sub-company',
          sub: 'Each one passes on everything it collects',
          tight: true,
          body: bySubCompany(),
        })
        : null,

      /* ------------------------------------------------------------- per SSN -- */
      card({
        title: 'By SSN',
        sub: range.months === 1
          ? 'Click a row for its full statement'
          : `Totalled across ${range.months} months — click a row for ${monthLabel(range.to)}`,
        tight: true,
        body: dataTable({
          rowKey: (r) => r.ssn_id,
          columns: [
            ssnCol,
            { key: 'job_count', header: 'Jobs', align: 'right', phone: false },
            col('credited_cents', 'Income'),
            col('salary_cents', 'To the SSN', { phone: false }),
            col('expense_cents', 'Expenses'),
            col('tax_hold_cents', 'Tax Hold', { phone: false }),
            {
              key: 'share_bps', header: 'Share %', align: 'right', phone: false,
              render: (r) => el('span', { class: 'num', text: percent(r.share_bps) }),
            },
            col('keep_cents', 'SSN share'),
            col('upstream_cents', 'Passed up', { bold: true }),
            statementAction,
          ],
          rows: data.ssns,
          footer: data.ssns.length ? {
            ssn_name: el('strong', { text: 'Total' }),
            job_count: String(roll.job_count),
            credited_cents: moneyCell(roll.credited_cents, { colour: false }),
            salary_cents: moneyCell(roll.salary_cents, { colour: false }),
            expense_cents: moneyCell(roll.expense_cents, { colour: false }),
            tax_hold_cents: moneyCell(roll.tax_hold_cents, { colour: false }),
            keep_cents: moneyCell(roll.ssn_kept_cents, { colour: false }),
            upstream_cents: el('strong', {}, moneyCell(roll.total_received_cents, { colour: false })),
          } : null,
          emptyState: empty({
            icon: 'layers',
            title: narrowed.length ? 'Nothing matches these filters' : 'No active SSNs',
            message: narrowed.length
              ? 'Widen the range, or clear the SSN and sub-company filters.'
              : 'SSNs are what work the jobs. Add one to its sub-company to get started.',
          }),
        }),
      }),

      /* --------------------------------------------------------------- trend -- */
      charts({ trend: data.trend, measure, mainName }),
    );

    // The detail panel survives a filter change, so put it back if one was open.
    return renderDetail();
  }

  await load();
}

/* ---------------------------------------------------------------- the charts -- */

/**
 * The trend, over exactly the range and filters in force.
 *
 * With a single measure chosen it becomes one chart of that series alone,
 * which is the point of the selector: looking at expenses, or the deducted
 * amount, without the rest of the waterfall drowning it out.
 */
function charts({ trend, measure, mainName }) {
  if (trend.length < 2) {
    return measure === 'all' ? null : card({
      body: empty({
        icon: 'report',
        title: 'A chart needs more than one month',
        message: 'Widen the range to see this measure over time.',
      }),
    });
  }

  if (measure !== 'all') {
    const chosen = MEASURES.find((m) => m.key === measure);
    return chartBox({
      title: `${chosen.label} by month`,
      height: 260,
      build: (node) => barChart(node, {
        labels: monthLabels(trend),
        datasets: [{ label: chosen.label, data: trend.map((r) => (r[measure] ?? 0) / 100) }],
      }),
    });
  }

  return el('div', { class: 'chart-grid' }, [
    chartBox({
      title: 'Income and expenses',
      height: 240,
      build: (node) => barChart(node, {
        labels: monthLabels(trend),
        datasets: [
          { label: 'Income', data: trend.map((r) => r.credited_cents / 100) },
          { label: 'Expenses', data: trend.map((r) => r.expense_cents / 100) },
        ],
      }),
    }),
    chartBox({
      title: `${mainName} share`,
      height: 240,
      build: (node) => lineChart(node, {
        labels: monthLabels(trend),
        datasets: [
          { label: `${mainName} share`, data: trend.map((r) => r.received_cents / 100) },
          { label: 'SSN share', data: trend.map((r) => r.ssn_kept_cents / 100) },
        ],
      }),
    }),
  ]);
}
