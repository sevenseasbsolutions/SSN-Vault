/** DOM helpers, toasts, modals, tables, filter bars. No framework. */

import { money, percent, titleCase } from './format.js';
import { icon } from './icons.js';

/**
 * Create an element.
 *
 * Text is always set via textContent, never parsed as HTML, and there is
 * deliberately no innerHTML escape hatch: every value rendered here may contain
 * user-entered notes, names or references.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  let leadingIcon = null;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    // `icon: 'plus'` prepends a decorative SVG before the label.
    else if (key === 'icon') leadingIcon = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (leadingIcon) node.prepend(icon(leadingIcon, { size: 14 }));
  return node;
}

export const frag = (children) => {
  const f = document.createDocumentFragment();
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    f.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return f;
};

export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); return node; };
export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Replace a container's children, skipping conditional blanks.
 *
 * Native replaceChildren() stringifies null/undefined/false into visible
 * "null" text, which is exactly what a `condition ? node : null` argument
 * produces. Always use this instead.
 */
export function mount(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(
    (child) => child !== null && child !== undefined && child !== false && child !== ''
  ));
  return node;
}

/* ---------------------------------------------------------------- toasts -- */

const TOAST_ICONS = { success: 'check-circle', error: 'warning', warning: 'warning', info: 'info' };

export function toast(message, { type = 'info', title, timeout = 5000 } = {}) {
  const host = $('#toasts');
  const node = el('div', {
    class: `toast ${type}`,
    // Errors interrupt; confirmations are polite.
    role: type === 'error' ? 'alert' : 'status',
  }, [
    icon(TOAST_ICONS[type] ?? 'info', { size: 16, className: 'toast-ico' }),
    el('div', { class: 'body' }, [
      title ? el('strong', { text: title }) : null,
      el('span', { text: message }),
    ]),
    el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss' },
      icon('x', { size: 14 })),
  ]);
  node.querySelector('.toast-close').addEventListener('click', () => node.remove());
  host.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

export const toastSuccess = (message, title = 'Saved') => toast(message, { type: 'success', title });
export const toastError = (message, title = 'Could not complete') =>
  toast(message, { type: 'error', title, timeout: 9000 });
export const toastWarn = (message, title = 'Please note') =>
  toast(message, { type: 'warning', title, timeout: 9000 });

/* ---------------------------------------------------------------- modals -- */

let openModals = 0;

export function modal({ title, body, footer, wide = false, onClose }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const panel = el('div', {
    class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true',
    'aria-label': title ?? 'Dialog',
  });

  const close = (result) => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    openModals -= 1;
    if (openModals === 0) document.body.style.removeProperty('overflow');
    onClose?.(result);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(null); }
  };

  const closeButton = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' },
    icon('x', { size: 15 }));
  closeButton.addEventListener('click', () => close(null));

  panel.append(
    el('div', { class: 'modal-head' }, [el('h2', { text: title ?? '' }), closeButton]),
    el('div', { class: 'modal-body' }, body ?? [])
  );
  if (footer) panel.append(el('div', { class: 'modal-foot' }, footer));

  backdrop.append(panel);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(null); });
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  openModals += 1;
  document.body.style.overflow = 'hidden';

  const focusable = panel.querySelector(
    'input:not([type=hidden]), select, textarea, button.btn-primary, button');
  focusable?.focus();

  return { close, panel, backdrop };
}

/** Confirmation dialog for high-impact actions, optionally requiring a reason. */
export function confirmDialog({
  title, message, confirmLabel = 'Confirm', danger = false,
  requireReason = false, reasonLabel = 'Reason (recorded in the audit history)',
}) {
  return new Promise((resolve) => {
    const reasonInput = el('textarea', { rows: 2, name: 'reason',
      placeholder: 'Why is this change being made?' });
    const error = el('p', { class: 'field-error', hidden: true });

    const dialog = modal({
      title,
      body: [
        el('p', { text: message }),
        requireReason ? el('label', { class: 'field' }, [
          el('span', {}, [reasonLabel, el('span', { class: 'req', text: '*' })]),
          reasonInput, error,
        ]) : null,
      ],
      footer: [
        el('button', { class: 'btn', type: 'button', text: 'Cancel',
          onClick: () => dialog.close(null) }),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', text: confirmLabel,
          onClick: () => {
            const reason = reasonInput.value.trim();
            if (requireReason && reason.length < 3) {
              error.textContent = 'Please give a reason of at least 3 characters.';
              error.hidden = false;
              reasonInput.focus();
              return;
            }
            dialog.close({ confirmed: true, reason });
          },
        }),
      ],
      onClose: (result) => resolve(result ?? { confirmed: false }),
    });
  });
}

/* ----------------------------------------------------------------- cards -- */

export function statCard({ label, value, tone = '', icon: iconName, foot, onClick, valueClass = '' }) {
  const node = el('div', { class: `stat ${tone}` }, [
    el('div', { class: 'label' }, [
      iconName ? icon(iconName, { size: 13, className: 'ico' }) : null,
      el('span', { text: label }),
    ]),
    el('div', { class: `value num ${valueClass}`, text: value }),
    foot ? el('div', { class: 'foot', text: foot }) : null,
  ]);
  if (onClick) {
    node.style.cursor = 'pointer';
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.addEventListener('click', onClick);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    });
  }
  return node;
}

export function card({ title, sub, actions, body, tight = false, basis }) {
  const head = (title || actions || basis)
    ? el('div', { class: 'card-head' }, [
      title ? el('h2', { text: title }) : null,
      sub ? el('span', { class: 'sub', text: sub }) : null,
      el('span', { class: 'spacer' }),
      basis ? el('span', { class: 'basis-tag', title: `Reporting basis: ${basis}` },
        [icon('calendar-clock', { size: 12 }), el('span', { text: basis })]) : null,
      ...[].concat(actions ?? []),
    ])
    : null;
  return el('section', { class: 'card' }, [
    head,
    el('div', { class: `card-body${tight ? ' tight' : ''}` }, body ?? []),
  ]);
}

export const pill = (value, label) =>
  el('span', { class: `pill ${String(value ?? '').toLowerCase()}`, text: label ?? titleCase(value) });

export const moneyCell = (cents, { signed = false, colour = true } = {}) => {
  const n = Number(cents ?? 0);
  const tone = !colour ? '' : (n > 0 ? ' pos' : (n < 0 ? ' neg' : ''));
  return el('span', { class: `money${tone}`, text: money(cents, { signed }) });
};

export const empty = ({ icon: iconName = 'inbox', title, message, action }) =>
  el('div', { class: 'empty' }, [
    el('div', { class: 'ico' }, icon(iconName, { size: 26, strokeWidth: 1.4 })),
    el('strong', { text: title }),
    message ? el('p', { text: message }) : null,
    action ?? null,
  ]);

export const loading = (rows = 5) =>
  el('div', { class: 'card-body', style: 'display:grid;gap:10px' },
    Array.from({ length: rows }, (_, i) =>
      el('div', { class: 'skeleton', style: `width:${100 - i * 7}%` })));

/* ---------------------------------------------------------------- tables -- */

/**
 * Render a data table. Columns describe both the desktop table and the mobile
 * card view (via data-label), so no content is lost on a small screen.
 */
export function dataTable({ columns: given, rows, sort, onSort, footer, emptyState, rowKey }) {
  if (!rows.length) return emptyState ?? empty({ title: 'Nothing to show yet' });

  // A caller may null out a column it does not want, so a conditional column
  // reads as one expression rather than a rebuilt array.
  const columns = given.filter(Boolean);

  const thead = el('thead', {}, el('tr', {}, columns.map((column) => {
    const sortable = Boolean(column.sortKey) && Boolean(onSort);
    // Guard on sortKey as well: without it an unsorted column would compare
    // undefined === undefined and report itself as the active sort.
    const active = Boolean(column.sortKey) && sort?.sort === column.sortKey;
    const label = el('span', { text: column.header });
    const th = el('th', {
      /*
       * `phone: false` drops a column on a narrow screen. A row becomes a card
       * there, so every column costs a line of vertical space; the columns a
       * list is scanned by stay, and the rest are one tap away in the record
       * itself.
       */
      class: [sortable ? 'sortable' : '', column.align === 'right' ? 'right' : '',
        column.phone === false ? 'phone-hide' : ''].join(' ').trim(),
      scope: 'col',
      'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null,
    }, [label, sortable
      ? icon(active ? (sort.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort-both',
        { size: 11, className: 'arrow' })
      : null]);
    if (sortable) {
      // A real button keeps the sort control keyboard reachable.
      const trigger = el('button', { class: 'th-sort', type: 'button',
        'aria-label': `Sort by ${column.header}` });
      while (th.firstChild) trigger.append(th.firstChild);
      trigger.addEventListener('click',
        () => onSort(column.sortKey, active && sort.dir === 'desc' ? 'asc' : 'desc'));
      th.append(trigger);
    }
    return th;
  })));

  const tbody = el('tbody', {}, rows.map((row, index) => el('tr', {
    dataset: rowKey ? { key: String(rowKey(row)) } : undefined,
  }, columns.map((column) => {
    const content = column.render ? column.render(row, index) : row[column.key];
    return el('td', {
      class: [
        column.align === 'right' ? 'right' : '',
        column.wrap ? 'wrap' : '',
        column.actions ? 'actions-cell' : '',
        column.phone === false ? 'phone-hide' : '',
      ].join(' ').trim(),
      dataset: { label: typeof column.header === 'string' ? column.header : '' },
    }, content instanceof Node ? content : [content ?? '—']);
  }))));

  const table = el('table', { class: 'data' }, [thead, tbody]);
  if (footer) {
    table.append(el('tfoot', {}, el('tr', {}, columns.map((column) => {
      const content = footer[column.key] ?? (column.footer ? column.footer() : null);
      return el('td', { class: column.align === 'right' ? 'right' : '' },
        content instanceof Node ? content : [content ?? '']);
    }))));
  }
  return el('div', { class: 'table-wrap' }, table);
}

export function pager({ pagination, onPage }) {
  if (!pagination) return null;
  const { page, pages, total, limit } = pagination;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const prev = el('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1 },
    [icon('chevron-left', { size: 13 }), el('span', { text: 'Previous' })]);
  const next = el('button', { class: 'btn btn-sm', type: 'button', disabled: page >= pages },
    [el('span', { text: 'Next' }), icon('chevron-right', { size: 13 })]);
  prev.addEventListener('click', () => onPage(page - 1));
  next.addEventListener('click', () => onPage(page + 1));

  return el('div', { class: 'pagination' }, [
    el('span', { text: `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` }),
    el('span', { class: 'spacer' }),
    prev,
    el('span', { class: 'nowrap', text: `Page ${page} of ${pages}` }),
    next,
  ]);
}

/* ----------------------------------------------------------------- forms -- */

let fieldSeq = 0;

export function field({ label, name, type = 'text', value = '', required = false, hint,
  options, placeholder, min, max, step, rows, disabled = false, list, maxlength }) {
  const uid = `fld${++fieldSeq}`;
  const errorId = `${uid}-error`;
  const hintId = hint ? `${uid}-hint` : null;

  let input;
  if (type === 'select') {
    input = el('select', { name, required, disabled, id: uid });
    for (const option of options ?? []) {
      input.append(el('option', {
        value: option.value,
        text: option.label,
        selected: String(option.value) === String(value ?? ''),
        disabled: option.disabled,
      }));
    }
  } else if (type === 'textarea') {
    input = el('textarea', { name, required, placeholder, rows: rows ?? 3, disabled, id: uid, maxlength });
    input.value = value ?? '';
  } else {
    input = el('input', { name, type, required, placeholder, min, max, step, disabled, list, id: uid, maxlength });
    input.value = value ?? '';
  }
  // The error element is referenced even while hidden, so the message is
  // announced the moment it appears rather than being read as a label.
  input.setAttribute('aria-describedby', [hintId, errorId].filter(Boolean).join(' '));

  const wrapper = el('label', { class: 'field', for: uid }, [
    el('span', {}, [label, required ? el('span', { class: 'req', text: '*', 'aria-hidden': 'true' }) : null,
      hint ? el('span', { class: 'hint', id: hintId, text: hint }) : null]),
    input,
    el('p', { class: 'field-error', id: errorId, role: 'alert', dataset: { error: name }, hidden: true }),
  ]);
  wrapper.input = input;
  return wrapper;
}

/**
 * A checkbox, shaped like field() so a form can mix the two freely.
 *
 * The label sits beside the box rather than above it, which is the only way a
 * checkbox reads correctly, and the whole row is the hit target.
 */
export function checkboxField({ label, name, checked = false, hint, disabled = false }) {
  const uid = `fld${++fieldSeq}`;
  const errorId = `${uid}-error`;
  const hintId = hint ? `${uid}-hint` : null;

  const input = el('input', { type: 'checkbox', name, id: uid, disabled });
  input.checked = Boolean(checked);
  input.setAttribute('aria-describedby', [hintId, errorId].filter(Boolean).join(' '));

  const wrapper = el('div', { class: 'field field-check' }, [
    el('label', { class: 'check-row', for: uid }, [input, el('span', { text: label })]),
    hint ? el('p', { class: 'hint', id: hintId, text: hint }) : null,
    el('p', { class: 'field-error', id: errorId, role: 'alert', dataset: { error: name }, hidden: true }),
  ]);
  wrapper.input = input;
  return wrapper;
}

/**
 * Paint server-side validation errors.
 *
 * Each invalid field gets an inline message wired through aria-describedby, AND
 * a focusable summary is placed at the top of the form linking to each field.
 * Focus moves to the summary so a keyboard or screen-reader user lands on the
 * explanation rather than having to hunt for it.
 */
export function applyErrors(form, details) {
  for (const node of form.querySelectorAll('[data-error]')) {
    node.hidden = true;
    node.textContent = '';
  }
  for (const node of form.querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
  form.querySelector('[data-error-summary]')?.remove();
  if (!details || typeof details !== 'object') return false;

  const items = [];
  for (const [key, message] of Object.entries(details)) {
    const slot = form.querySelector(`[data-error="${cssEscape(key)}"]`)
      ?? form.querySelector(`[data-error="${cssEscape(key.replace(/_cents$/, ''))}"]`);
    const input = form.querySelector(`[name="${cssEscape(key)}"]`);
    if (slot) { slot.textContent = message; slot.hidden = false; }
    if (input) input.setAttribute('aria-invalid', 'true');
    items.push({ message, input });
  }

  const summary = el('div', {
    class: 'error-summary', role: 'alert', tabindex: '-1', dataset: { errorSummary: '1' },
  }, [
    el('h3', { text: items.length === 1 ? 'There is a problem' : `There are ${items.length} problems` }),
    el('ul', {}, items.map(({ message, input }) => el('li', {}, input
      ? el('a', {
        href: `#${input.id}`,
        text: message,
        onClick: (event) => { event.preventDefault(); input.focus(); },
      })
      : [message]))),
  ]);
  form.prepend(summary);
  summary.focus();
  summary.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return true;
}

const cssEscape = (value) =>
  (window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
export const formValues = (form) => {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = typeof value === 'string' ? value.trim() : value;
  }
  return data;
};

/** Disable a submit button while a request is in flight. */
export async function withBusy(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try { return await fn(); }
  finally { button.disabled = false; button.textContent = original; }
}

/* --------------------------------------------------------------- filters -- */

export const PRESETS = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'year_to_date', label: 'Year to date' },
  { key: 'last_year', label: 'Last year' },
];

export function detailList(entries) {
  return el('div', { class: 'detail-list' }, entries
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => el('div', {}, [
      el('span', { class: 'k', text: key }),
      el('span', {}, value instanceof Node ? value : [String(value)]),
    ])));
}

export function timeline(entries) {
  if (!entries?.length) return el('p', { class: 'muted', text: 'No history recorded yet.' });
  return el('div', { class: 'timeline' }, entries.map((entry) => el('div', { class: 'timeline-item' }, [
    el('strong', { text: `${titleCase(entry.action)}${entry.entity_type ? ` · ${titleCase(entry.entity_type)}` : ''}` }),
    el('span', { class: 'when', text: `${entry.user_label ?? 'system'} · ${new Date(entry.created_at).toLocaleString()}` }),
    entry.reason ? el('span', { class: 'muted', text: `Reason: ${entry.reason}` }) : null,
    entry.changes_json || entry.changes
      ? el('span', { class: 'changes', text: summariseChanges(entry.changes ?? JSON.parse(entry.changes_json)) })
      : null,
  ])));
}

export function summariseChanges(changes) {
  if (!changes) return '';
  return Object.entries(changes)
    .map(([key, change]) => `${key}: ${format(change.from)} → ${format(change.to)}`)
    .join('  ·  ');
}

const format = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
};

export const sharePill = (bps) => el('span', { class: 'num', text: percent(bps) });
