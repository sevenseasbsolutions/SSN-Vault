/**
 * Filter plumbing shared by the registers.
 *
 * Each register builds its own controls, because what you filter a job
 * register by and what you filter an expense register by are not the same set.
 * What IS shared is how filters are presented and counted: a page arrives
 * showing its answers, with the number of applied filters never hidden.
 *
 * The old generic filter bar lived here too. It was built around partners,
 * profiles, companies and pools, none of which exist any more, and nothing
 * rendered it -- so it is gone rather than left as a description of a model
 * the application no longer has.
 */

import { el, field } from './ui.js';
import { icon } from './icons.js';

/*
 * Date filters come in pairs that describe one range, so "July to September"
 * is one filter to the reader even though it is two fields.
 */
const MONTH_KEYS = new Set(['month', 'month_from', 'month_to']);

const PAIRED_KEYS = [
  ['month_from', 'month_to'],
  ['date_from', 'date_to'],
  ['amount_min', 'amount_max'],
];

/**
 * How many filters the user has actually applied.
 *
 * A view's own starting values are not filters the user chose, so pass them as
 * `defaults` and they are not counted until they change.
 */
export function countActiveFilters(filters = {}, defaults = {}) {
  const normalise = (key, value) => (MONTH_KEYS.has(key) ? String(value).slice(0, 7) : String(value));
  const applied = (key) => {
    const value = filters[key];
    if (value === undefined || value === null || value === '') return false;
    const base = defaults[key];
    if (base === undefined || base === null || base === '') return true;
    return normalise(key, value) !== normalise(key, base);
  };

  let count = 0;
  const paired = new Set();
  for (const [from, to] of PAIRED_KEYS) {
    paired.add(from); paired.add(to);
    if (applied(from) || applied(to)) count += 1;
  }
  for (const key of Object.keys(filters)) {
    if (!paired.has(key) && applied(key)) count += 1;
  }
  return count;
}

/**
 * A range picked one of two ways: a single month, or a span of dates.
 *
 * The two are mutually exclusive, and the controls say so rather than leaving
 * the reader to find out from the figures: typing dates empties and disables
 * the month, and choosing a month empties and disables the dates. Only one
 * question can be asked at a time, so only one can be answered.
 *
 * A date span is answered in whole accounting months -- everything in this
 * system is accounted by month, and half a month has no total -- so the hint
 * says which months the dates will pull in before they are applied.
 *
 * @param {object}   options
 * @param {object}   options.value     starting { month, date_from, date_to }
 * @param {Function} options.onChange  called after any of the three change
 */
export function rangePicker({ value = {}, onChange }) {
  const monthField = field({
    label: 'Month', name: 'month', type: 'month', value: value.month ?? '',
    hint: 'One month',
  });
  const fromField = field({
    label: 'Date from', name: 'date_from', type: 'date', value: value.date_from ?? '',
  });
  const toField = field({
    label: 'Date to', name: 'date_to', type: 'date', value: value.date_to ?? '',
    // Short enough to sit beside the label without wrapping it; the range bar
    // carries the full statement once a span is actually applied.
    hint: 'Whole months',
  });

  const dateInputs = [fromField.input, toField.input];
  const hasDates = () => dateInputs.some((input) => input.value !== '');
  const monthHint = monthField.querySelector('.hint');

  /**
   * While a date span is in play the month is emptied and switched off, and
   * says why.
   *
   * Only that direction is locked. Choosing a month clears the dates but
   * leaves them live, so there is always a way back: type a date and the
   * month steps aside again. Disabling both sides would leave whichever was
   * chosen first the only one reachable.
   */
  function sync() {
    const dates = hasDates();
    monthField.input.disabled = dates;
    monthField.classList.toggle('is-inactive', dates);
    monthHint.textContent = dates ? 'Set by the dates' : 'One month';
  }

  monthField.input.addEventListener('change', () => {
    // A month answers the range on its own, so any half-typed span goes.
    if (monthField.input.value) for (const input of dateInputs) input.value = '';
    sync();
    onChange?.();
  });
  for (const input of dateInputs) {
    input.addEventListener('change', () => {
      if (hasDates()) monthField.input.value = '';
      sync();
      onChange?.();
    });
  }

  const api = {
    fields: [monthField, fromField, toField],
    monthField,
    fromField,
    toField,
    /** What to send: never both, because only one side can be filled. */
    read: () => ({
      month: monthField.input.value,
      date_from: fromField.input.value,
      date_to: toField.input.value,
    }),
    setMonth(month) {
      monthField.input.value = month;
      for (const input of dateInputs) input.value = '';
      sync();
    },
    setDates(from, to) {
      monthField.input.value = '';
      fromField.input.value = from;
      toField.input.value = to;
      sync();
    },
    clear() {
      monthField.input.value = '';
      for (const input of dateInputs) input.value = '';
      sync();
    },
    sync,
  };
  sync();
  return api;
}

/**
 * Filters as a disclosure rather than a fixture.
 *
 * A page should arrive showing its answers, not its controls, so the panel
 * starts collapsed behind a button in the page's own toolbar. The one thing
 * that is never hidden is how many filters are applied: without it a filtered
 * page is indistinguishable from the whole picture.
 *
 * @param {object}   options
 * @param {Element}  options.actions  the page's toolbar, where the button goes
 * @param {string}   options.id       unique id, to tie the button to the panel
 * @param {Function} options.count    returns the number of applied filters
 * @returns {{ panel: Element, toggle: Element, sync: Function, setOpen: Function }}
 */
export function filterDisclosure({ actions, id = 'filters', count }) {
  const panel = el('div', { class: 'filter-panel', id, hidden: true });

  const badge = el('span', { class: 'count', 'aria-hidden': 'true', hidden: true });
  // One atomic sentence: a changed count is announced as a state, never as a
  // bare number with no subject.
  const status = el('span', { class: 'sr-only', role: 'status', 'aria-atomic': 'true' });

  let open = false;
  const toggle = el('button', {
    class: 'btn filter-toggle', type: 'button', text: 'Filters',
    'aria-expanded': 'false', 'aria-controls': id,
    onClick: () => setOpen(!open),
  });
  toggle.prepend(icon('filter', { size: 14 }));
  toggle.append(badge, status);

  function setOpen(next) {
    open = next;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      panel.hidden = false;
      // One frame laid out but still transparent, so the transition has a
      // starting point to animate from.
      requestAnimationFrame(() => panel.classList.add('open'));
    } else {
      panel.classList.remove('open');
      panel.hidden = true;
    }
  }

  function sync() {
    const n = count ? count() : 0;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    status.textContent = n ? `${n} filter${n === 1 ? '' : 's'} applied` : 'No filters applied';
    toggle.setAttribute('aria-label', n ? `Filters, ${n} applied` : 'Filters');
  }

  sync();
  // Prepended, not appended: the filter control sits ahead of a page's
  // create and export actions wherever the helper is called from, so the
  // toolbar reads the same on every screen.
  actions?.prepend(toggle);
  return { panel, toggle, sync, setOpen };
}

/** Strip empty values so they never reach the query string. */
export const cleanFilters = (filters) =>
  Object.fromEntries(Object.entries(filters).filter(([, v]) =>
    v !== undefined && v !== null && v !== ''));
