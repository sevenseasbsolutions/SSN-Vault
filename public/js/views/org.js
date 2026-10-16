import { api } from '../api.js';
import {
  el, card, empty, modal, field, applyErrors, withBusy, toastSuccess,
  confirmDialog, mount, loading,
} from '../ui.js';
import { percent, centsToInput } from '../format.js';
import { icon } from '../icons.js';

/**
 * The company structure.
 *
 * Rendered as the tree it is, not as a flat table, because the whole point of
 * the model is which SSN sits under which company. Each SSN
 * shows what it KEEPS; the remainder travels up, and the row says so in words
 * so nobody has to remember which way the percentage points.
 */

const KIND_LABEL = { main: 'Main company', sub: 'Sub-company', ssn: 'SSN' };

export default async function org({ view, actions, session, navigate }) {
  const canManage = session.can('org.manage');

  const body = el('div');
  view.append(body);

  if (canManage) {
    actions.append(el('button', {
      class: 'btn btn-primary', type: 'button', icon: 'plus', text: 'Add',
      onClick: () => openAddMenu(),
    }));
  }

  async function load() {
    mount(body, el('div', { class: 'card' }, loading(4)));
    const data = await api.get('/api/org');

    if (!data.tree.length) {
      return mount(body, card({
        body: empty({
          icon: 'building',
          title: 'No company structure yet',
          message: 'Start with the main company, then add a sub-company under it, '
            + 'then the SSNs that land the jobs.',
          action: canManage
            ? el('button', {
              class: 'btn btn-primary', type: 'button', text: 'Create the main company',
              onClick: () => openForm({ kind: 'main', onSaved: load }),
            })
            : null,
        }),
      }));
    }

    mount(body,
      card({
        title: 'Structure',
        sub: 'An SSN keeps its share; the rest goes up to its sub-company, and on to the main company.',
        body: el('div', { class: 'org-tree' }, data.tree.flatMap((unit) => renderUnit(unit, 0))),
      }),
      card({
        title: 'How the money moves',
        tight: true,
        body: el('div', { class: 'flow-note' }, [
          el('p', { text: 'Each SSN, each month: the salaries its jobs paid, less its '
            + 'expenses, less the tax those jobs carry. What remains is split — the SSN '
            + 'keeps its share, and the rest is passed up.' }),
          el('p', { class: 'muted', text: 'The tax rate is set on each job, not here, so '
            + 'two jobs in the same month can be taxed differently.' }),
          el('p', { class: 'muted', text: 'A sub-company keeps nothing. Everything it collects '
            + 'from its SSNs goes to the main company.' }),
        ]),
      }),
    );
  }

  /** One row per unit, indented by depth, children following. */
  function renderUnit(unit, depth) {
    const isSsn = unit.kind === 'ssn';
    const keeps = isSsn ? percent(unit.share_bps) : null;
    const passes = isSsn ? percent(10000 - unit.share_bps) : null;

    const row = el('div', {
      class: `org-row kind-${unit.kind}${unit.is_active ? '' : ' inactive'}`,
      style: `--depth:${depth}`,
    }, [
      el('span', { class: 'org-mark' },
        icon(unit.kind === 'ssn' ? 'layers' : 'building', { size: 15 })),
      el('span', { class: 'org-name' }, [
        el('strong', { text: unit.name }),
        el('small', { text: KIND_LABEL[unit.kind] + (unit.code ? ` · ${unit.code}` : '') }),
      ]),
      isSsn
        ? el('span', { class: 'org-share' }, [
          el('span', { class: 'num', text: keeps }),
          el('small', { text: `keeps · ${passes} goes up` }),
        ])
        : el('span', { class: 'org-share muted', text: unit.kind === 'sub' ? 'passes on everything' : 'receives everything' }),
      // No tax column: the rate lives on each job, not on the SSN.
      el('span', { class: 'org-tax' }),
      el('span', { class: 'org-actions' }, [
        !unit.is_active ? el('span', { class: 'pill void', text: 'Inactive' }) : null,
        isSsn
          ? el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', text: 'Statement',
            onClick: () => navigate('statement', { ssn: unit.id }),
          })
          : null,
        canManage
          ? el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', icon: 'edit', text: 'Edit',
            onClick: () => openForm({ unit, onSaved: load }),
          })
          : null,
        canManage && unit.kind !== 'ssn'
          ? el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', icon: 'plus',
            text: unit.kind === 'main' ? 'Sub-company' : 'SSN',
            onClick: () => openForm({
              kind: unit.kind === 'main' ? 'sub' : 'ssn',
              parent: unit,
              onSaved: load,
            }),
          })
          : null,
        session.canDelete('org.manage')
          ? el('button', {
            class: 'btn btn-ghost btn-sm danger', type: 'button', icon: 'x', text: 'Delete',
            onClick: () => remove(unit, load),
          })
          : null,
      ]),
    ]);

    return [row, ...(unit.children ?? []).flatMap((child) => renderUnit(child, depth + 1))];
  }

  function openAddMenu() {
    const choose = (kind) => { dialog.close(); openForm({ kind, onSaved: load }); };
    const dialog = modal({
      title: 'What are you adding?',
      body: el('div', { class: 'choice-grid' }, [
        el('button', { class: 'choice', type: 'button', onClick: () => choose('main') }, [
          el('strong', { text: 'Main company' }),
          el('small', { text: 'The top of the tree. There can only be one.' }),
        ]),
        el('button', { class: 'choice', type: 'button', onClick: () => choose('sub') }, [
          el('strong', { text: 'Sub-company' }),
          el('small', { text: 'Sits under the main company and collects from its SSNs.' }),
        ]),
        el('button', { class: 'choice', type: 'button', onClick: () => choose('ssn') }, [
          el('strong', { text: 'SSN' }),
          el('small', { text: 'Lands jobs, holds tax, and keeps a share of what is left.' }),
        ]),
      ]),
    });
  }

  await load();
}

/* -------------------------------------------------------------------- form -- */

async function openForm({ unit = null, kind = null, parent = null, onSaved }) {
  const editing = Boolean(unit);
  const resolvedKind = unit?.kind ?? kind;
  const isSsn = resolvedKind === 'ssn';

  // Parent options are only needed when creating, and only for sub/ssn.
  let parentOptions = [];
  if (!editing && resolvedKind !== 'main') {
    if (resolvedKind === 'sub') {
      const data = await api.get('/api/org');
      parentOptions = data.main ? [{ value: data.main.id, label: data.main.name }] : [];
    } else {
      const data = await api.get('/api/org/meta/sub-companies');
      parentOptions = data.rows.filter((r) => r.is_active).map((r) => ({ value: r.id, label: r.name }));
    }
  }

  const form = el('form', { class: 'form-grid' });

  const name = field({
    label: 'Name', name: 'name', required: true,
    value: unit?.name ?? '',
    placeholder: resolvedKind === 'ssn' ? 'Alpha' : 'MBS',
  });
  const code = field({ label: 'Short code', name: 'code', value: unit?.code ?? '', hint: 'Optional' });

  const parentField = (!editing && resolvedKind !== 'main')
    ? field({
      label: resolvedKind === 'sub' ? 'Main company' : 'Sub-company',
      name: 'parent_id', type: 'select', required: true,
      value: parent?.id ?? parentOptions[0]?.value ?? '',
      options: parentOptions.length
        ? parentOptions
        : [{ value: '', label: resolvedKind === 'sub' ? 'Create the main company first' : 'Create a sub-company first' }],
    })
    : null;

  const share = isSsn
    ? field({
      label: 'Share the SSN keeps (%)', name: 'share', type: 'number',
      min: 0, max: 100, step: '0.01', required: true,
      value: unit ? centsToInput(unit.share_bps) : '30',
      hint: 'The rest is passed up to the sub-company',
    })
    : null;

  /*
   * There is no tax rate here. Tax is asked for on each job and applied to
   * that job's own salary, so two jobs in the same month can be taxed
   * differently and the statement still adds up.
   */

  // Live echo of what the split means, so a percentage is never ambiguous.
  const echo = el('p', { class: 'form-note' });
  const updateEcho = () => {
    if (!isSsn) {
      echo.textContent = resolvedKind === 'sub'
        ? 'A sub-company keeps nothing — it passes everything it collects to the main company.'
        : 'The main company receives everything the sub-companies collect.';
      return;
    }
    const pct = Number(share.input.value);
    if (!Number.isFinite(pct)) { echo.textContent = ''; return; }
    echo.textContent = `Keeps ${pct}% of its distributable amount; `
      + `${(100 - pct).toFixed(2).replace(/\.00$/, '')}% goes up to the sub-company.`;
  };
  share?.input.addEventListener('input', updateEcho);

  const description = field({
    label: 'Description', name: 'description', type: 'textarea',
    value: unit?.description ?? '',
  });

  const activeField = editing
    ? field({
      label: 'Status', name: 'is_active', type: 'select',
      value: unit.is_active ? 'true' : 'false',
      options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
      hint: 'Deactivating keeps its history but stops new records being recorded against it',
    })
    : null;

  const error = el('p', { class: 'form-error', hidden: true });
  form.append(name, code, parentField, share, description, activeField, echo, error);
  updateEcho();

  const save = async (event) => {
    error.hidden = true;
    const payload = {
      name: name.input.value.trim(),
      code: code.input.value.trim() || null,
      description: description.input.value.trim() || null,
    };
    if (!editing) {
      payload.kind = resolvedKind;
      if (parentField) payload.parent_id = Number(parentField.input.value);
    }
    if (isSsn) {
      // Sent as a percentage; the server converts to basis points.
      payload.share = share.input.value;
    }
    if (activeField) payload.is_active = activeField.input.value === 'true';

    try {
      if (editing) await api.put(`/api/org/${unit.id}`, payload);
      else await api.post('/api/org', payload);
      toastSuccess(editing ? `${payload.name} updated.` : `${payload.name} added.`);
      dialog.close();
      await onSaved?.();
    } catch (err) {
      if (!applyErrors(form, err.details)) { error.textContent = err.message; error.hidden = false; }
    }
  };

  const dialog = modal({
    title: editing ? `Edit ${unit.name}` : `Add a ${KIND_LABEL[resolvedKind].toLowerCase()}`,
    body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: editing ? 'Save' : 'Add',
        onClick: (event) => withBusy(event.currentTarget, () => save(event)),
      }),
    ],
  });
}

async function remove(unit, onDone) {
  const result = await confirmDialog({
    title: `Delete ${unit.name}?`,
    message: 'This is permanent. Anything with jobs or expenses recorded against it '
      + 'cannot be deleted — deactivate it instead, so its past months keep reconciling.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!result.confirmed) return;
  await api.del(`/api/org/${unit.id}`);
  toastSuccess(`${unit.name} deleted.`);
  await onDone?.();
}
