import { api } from '../api.js';
import {
  el, card, dataTable, pager, empty, field, summariseChanges, detailList, modal, mount,
} from '../ui.js';
import { timestampLabel, titleCase, todayValue } from '../format.js';
import { filterDisclosure, countActiveFilters } from '../filters.js';

export default async function audit({ view, actions, query, session }) {
  let filters = {
    entity_type: query.entity_type ?? '',
    entity_id: query.entity_id ?? '',
    action: query.action ?? '',
    from: query.from ?? '',
    to: query.to ?? '',
  };
  let page = 1;
  let meta = { entity_types: [], actions: [] };

  if (session.can('reports.export')) {
    actions.append(el('a', {
      class: 'btn', icon: 'download', text: 'Export CSV', target: '_blank', rel: 'noopener',
      href: api.exportUrl('/api/reports/audit-history', { format: 'csv' }),
    }));
  }

  const { panel: bar, sync: syncFilters } = filterDisclosure({
    actions, id: 'audit-filters', count: () => countActiveFilters(filters),
  });
  const body = el('div');
  view.append(bar, body);

  function renderFilters() {
    const entityType = field({
      label: 'Record type', name: 'entity_type', type: 'select', value: filters.entity_type,
      options: [{ value: '', label: 'All record types' },
        ...meta.entity_types.map((t) => ({ value: t, label: titleCase(t) }))],
    });
    const action = field({
      label: 'Action', name: 'action', type: 'select', value: filters.action,
      options: [{ value: '', label: 'All actions' },
        ...meta.actions.map((a) => ({ value: a, label: titleCase(a) }))],
    });
    const entityId = field({
      label: 'Record ID', name: 'entity_id', value: filters.entity_id,
      placeholder: 'e.g. 12', hint: 'trace one record end to end',
    });
    const from = field({ label: 'From date', name: 'from', type: 'date', value: filters.from });
    const to = field({ label: 'To date', name: 'to', type: 'date', value: filters.to, max: todayValue() });

    for (const [key, node] of Object.entries({ entity_type: entityType, action, entity_id: entityId, from, to })) {
      node.input.addEventListener('change', () => {
        filters[key] = node.input.value.trim();
        page = 1;
        syncFilters();
        load();
      });
    }

    mount(bar, card({
      title: 'Audit history',
      sub: 'Every important financial operation, who did it, and what changed',
      body: [
        el('div', { class: 'filter-row' }, [entityType, action, entityId]),
        el('div', { class: 'filter-row' }, [from, to,
          el('div', { class: 'field' }, [
            el('span', { text: ' ' }),
            el('button', {
              class: 'btn', type: 'button', text: 'Reset filters',
              onClick: () => {
                filters = { entity_type: '', entity_id: '', action: '', from: '', to: '' };
                page = 1;
                renderFilters();
                syncFilters();
                load();
              },
            }),
          ]),
        ]),
      ],
    }));
  }

  async function load() {
    mount(body, el('div', { class: 'card' },
      el('div', { class: 'card-body', style: 'display:grid;gap:8px' },
        Array.from({ length: 6 }, () => el('div', { class: 'skeleton' })))));

    const params = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined));
    const data = await api.get('/api/audit', { ...params, page, limit: 50 });
    meta = { entity_types: data.entity_types, actions: data.actions };
    renderFilters();

    mount(body, card({
      title: 'Events',
      sub: `${data.pagination.total.toLocaleString()} event${data.pagination.total === 1 ? '' : 's'}`,
      basis: 'Event timestamp',
      tight: true,
      body: [
        dataTable({
          columns: [
            { header: 'When', render: (row) => el('div', { class: 'cell-stack' }, [
              el('span', { text: timestampLabel(row.created_at) }),
              el('small', { class: 'mono', text: `#${row.id}` }),
            ]) },
            { header: 'Record', render: (row) => el('div', { class: 'cell-stack' }, [
              el('strong', { text: titleCase(row.entity_type) }),
              row.entity_id ? el('small', { class: 'mono', text: row.entity_id }) : null,
            ]) },
            { header: 'Action', render: (row) => el('span', { text: titleCase(row.action) }) },
            { header: 'User', render: (row) => row.user_label ?? 'system' },
            { header: 'Reason', wrap: true, render: (row) => row.reason || '—' },
            { header: 'What changed', wrap: true, render: (row) => row.changes
              ? el('span', { class: 'mono', style: 'font-size:11.5px',
                text: truncate(summariseChanges(row.changes), 150) })
              : '—' },
            {
              header: '', align: 'right', actions: true,
              render: (row) => row.changes
                ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Detail',
                  onClick: () => openEvent(row) })
                : null,
            },
          ],
          rows: data.rows,
          emptyState: empty({
            icon: 'history', title: 'No audit events match these filters',
            message: 'Financial creations, edits, voids, approvals, payments, permission changes '
              + 'and exports are all recorded here.',
          }),
        }),
        pager({ pagination: data.pagination, onPage: (next) => { page = next; load(); } }),
      ],
    }));
  }

  renderFilters();
  await load();
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function openEvent(row) {
  const dialog = modal({
    title: `${titleCase(row.action)} — ${titleCase(row.entity_type)}${row.entity_id ? ` ${row.entity_id}` : ''}`,
    body: [
      detailList([
        ['When', timestampLabel(row.created_at)],
        ['User', row.user_label ?? 'system'],
        ['IP address', row.ip],
        ['Reason', row.reason],
      ]),
      card({
        title: 'Field changes',
        tight: true,
        body: dataTable({
          columns: [
            { header: 'Field', render: (entry) => el('span', { class: 'mono', text: entry.field }) },
            { header: 'Previous value', wrap: true, render: (entry) => format(entry.from) },
            { header: 'Updated value', wrap: true, render: (entry) => format(entry.to) },
          ],
          rows: Object.entries(row.changes ?? {}).map(([fieldName, change]) => ({
            field: fieldName, from: change.from, to: change.to,
          })),
          emptyState: empty({ title: 'No field-level detail recorded for this event' }),
        }),
      }),
    ],
    footer: [el('button', { class: 'btn', type: 'button', text: 'Close', onClick: () => dialog.close() })],
  });
}

const format = (value) =>
  (value === null || value === undefined || value === '' ? '—' : String(value));
