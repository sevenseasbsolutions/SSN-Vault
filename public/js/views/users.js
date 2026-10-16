import { api } from '../api.js';
import {
  el, card, dataTable, pill, empty, modal, field, applyErrors, withBusy,
  toastSuccess, toastWarn, confirmDialog, detailList, timeline, statCard, mount,
} from '../ui.js';
import { timestampLabel, titleCase } from '../format.js';

export default async function users({ view, actions, session }) {
  const body = el('div', { class: 'stack' });
  view.append(body);

  const [catalog, units] = await Promise.all([
    api.get('/api/auth/permissions').then((r) => r.rows),
    api.get('/api/org').then((r) => r.rows).catch(() => []),
  ]);
  const lookups = { catalog, units };

  actions.append(el('button', {
    class: 'btn btn-primary', type: 'button', icon: 'plus', text: 'Add user',
    onClick: () => openUserForm({ lookups, onSaved: load }),
  }));

  async function load() {
    mount(body, el('div', { class: 'card' },
      el('div', { class: 'card-body', style: 'display:grid;gap:8px' },
        Array.from({ length: 4 }, () => el('div', { class: 'skeleton' })))));

    const data = await api.get('/api/users');
    const byRole = (role) => data.rows.filter((u) => u.role === role).length;

    mount(
    body,
      el('div', { class: 'stat-grid' }, [
        statCard({ label: 'Users', icon: 'users', value: String(data.rows.length),
          foot: `${data.rows.filter((u) => u.is_active).length} active` }),
        statCard({ label: 'Owners', icon: 'star', value: String(byRole('owner')) }),
        statCard({ label: 'Editors', icon: 'edit', value: String(byRole('editor')),
          foot: 'Add and edit, within scope' }),
        statCard({ label: 'Viewers', icon: 'eye', value: String(byRole('viewer')),
          foot: 'Read only, within scope' }),
      ]),

      el('p', { class: 'form-note', text:
        'Permissions are enforced on the server for every read, write and export. '
        + 'A scoped account reaches only the part of the company tree granted to it, and '
        + 'nobody can change their own role, permissions or access scope.' }),

      card({
        title: 'Users and access',
        tight: true,
        body: dataTable({
          columns: [
            { header: 'User', render: (row) => el('div', { class: 'cell-stack' }, [
              el('strong', { text: row.name }),
              el('small', { text: row.email }),
            ]) },
            { header: 'Role', render: (row) => pill(
              row.role === 'owner' ? 'approved' : (row.role === 'viewer' ? 'draft' : 'open'),
              titleCase(row.role)) },
            { header: 'Permissions', align: 'right', render: (row) =>
              el('span', { class: 'num', text: String(row.effective_permissions.length) }) },
            { header: 'Access scope', wrap: true, render: (row) => scopeSummary(row, lookups) },
            { header: 'Last sign-in', render: (row) => row.last_login_at
              ? timestampLabel(row.last_login_at) : 'never' },
            { header: 'Status', render: (row) => el('div', { class: 'row', style: 'gap:5px' }, [
              pill(row.is_active ? 'active' : 'void', row.is_active ? 'Active' : 'Deactivated'),
              row.must_change_pw ? pill('open', 'Must set password') : null,
              row.locked_until ? pill('void', 'Locked') : null,
            ]) },
            {
              header: 'Actions', align: 'right', actions: true,
              render: (row) => el('div', { class: 'row-actions' }, [
                el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Open',
                  onClick: () => openUserDetail(row.id, { lookups, session, reload: load }) }),
                el('button', { class: 'btn btn-sm', type: 'button', text: 'Access',
                  disabled: row.id === session.user.id,
                  title: row.id === session.user.id
                    ? 'You cannot change your own access' : 'Edit permissions and scope',
                  onClick: () => openAccessForm({ user: row, lookups, onSaved: load }) }),
              ]),
            },
          ],
          rows: data.rows,
          emptyState: empty({ title: 'No users yet' }),
        }),
      })
    );
  }

  await load();
}

/**
 * Scopes are reported as what was GRANTED, not as what it expands to.
 *
 * The server expands a sub-company grant to its SSNs, so echoing the
 * expansion back would list SSNs the owner never picked and would grow
 * silently as new ones are added. Naming the grant is both shorter and true.
 */
function scopeSummary(user, lookups) {
  const granted = user.scopes?.org_unit;
  if (granted === null || granted === undefined) {
    return el('small', { class: 'muted', text: 'Whole company' });
  }
  if (!granted.length) return el('small', { text: 'No access' });

  const byId = new Map(lookups.units.map((u) => [u.id, u]));
  // Drop any SSN that is already covered by a granted ancestor.
  const names = granted
    .filter((id) => {
      const unit = byId.get(id);
      if (!unit) return true;
      return !String(unit.path ?? '').split('/').map(Number)
        .some((ancestor) => ancestor !== id && granted.includes(ancestor));
    })
    .map((id) => byId.get(id)?.name ?? `#${id}`);

  return el('div', { class: 'cell-stack' },
    names.map((text) => el('small', { text })));
}

/* ------------------------------------------------------------------ form -- */

function openUserForm({ lookups, onSaved }) {
  const form = el('form', { class: 'form-grid', novalidate: true });
  const formError = el('p', { class: 'form-error', hidden: true });

  const name = field({ label: 'Name', name: 'name', required: true });
  const email = field({ label: 'Email', name: 'email', type: 'email', required: true });
  const role = field({
    label: 'Role', name: 'role', type: 'select', required: true, value: 'viewer',
    options: [
      { value: 'viewer', label: 'Viewer — read only, within scope' },
      { value: 'editor', label: 'Editor — add and edit, within scope' },
      { value: 'owner', label: 'Owner — full access' },
    ],
  });
  const password = field({
    label: 'Password', name: 'password', type: 'password',
    hint: 'leave blank to generate a temporary one the user must change',
  });

  const scopePicker = buildScopePicker(lookups, { org_unit: [] });
  const permissionPicker = buildPermissionPicker(lookups.catalog, [], role);

  const roleNote = el('p', { class: 'form-note' });
  const syncRole = () => {
    const value = role.input.value;
    roleNote.textContent = value === 'owner'
      ? 'An owner has every permission, including user management and financial settings.'
      : 'Leave the scope empty for the whole company, or pick parts of the tree to '
        + 'restrict this user to. Granting a sub-company also grants its SSNs, '
        + 'including ones added later.';
    permissionPicker.refresh();
  };
  role.input.addEventListener('change', syncRole);

  form.append(
    el('div', { class: 'form-section' }, [
      el('h3', { text: 'Account' }),
      el('div', { class: 'grid-2' }, [name, email]),
      el('div', { class: 'grid-2' }, [role, password]),
      roleNote,
    ]),
    el('div', { class: 'form-section' }, [
      el('h3', { text: 'Access scope — which records this user can reach' }),
      scopePicker.node,
    ]),
    el('div', { class: 'form-section' }, [
      el('h3', { text: 'Permissions' }),
      permissionPicker.node,
    ]),
    formError
  );
  syncRole();

  const saveButton = el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Create user', onClick: () => submit(),
  });
  const dialog = modal({
    title: 'Add user',
    wide: true, body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      saveButton,
    ],
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  async function submit() {
    await withBusy(saveButton, async () => {
      formError.hidden = true;
      try {
        const result = await api.post('/api/users', {
          name: name.input.value.trim(),
          email: email.input.value.trim(),
          role: role.input.value,
          password: password.input.value || undefined,
          permissions: permissionPicker.value(),
          scopes: scopePicker.value(),
        });
        dialog.close();
        if (result.temporary_password) showTemporaryPassword(result);
        else toastSuccess('User created.');
        onSaved();
      } catch (error) {
        if (!applyErrors(form, error.details)) { formError.textContent = error.message; formError.hidden = false; }
      }
    });
  }
}

function showTemporaryPassword(result) {
  const dialog = modal({
    title: 'Temporary password',
    body: [
      el('p', { text: `Give this one-time password to ${result.user.name}. `
        + 'It is shown only now and they must change it at first sign-in.' }),
      el('p', { class: 'mono', style: 'font-size:17px;padding:12px;background:var(--surface-2);'
        + 'border:1px solid var(--border-strong);border-radius:8px;user-select:all',
        text: result.temporary_password }),
      el('p', { class: 'hint', text: 'Send it over a channel you trust. It is not stored in cleartext.' }),
    ],
    footer: [el('button', { class: 'btn btn-primary', type: 'button', text: 'Done',
      onClick: () => dialog.close() })],
  });
}

/* ----------------------------------------------------------------- access -- */

/**
 * Scope picker over the company tree.
 *
 * The main company is not offered: scoping someone to it would grant
 * everything, which is what leaving the scope empty already means, and having
 * two ways to say the same thing invites one of them to be wrong.
 */
function buildScopePicker(lookups, initial) {
  const groups = [
    {
      type: 'org_unit', label: 'Sub-companies',
      items: lookups.units.filter((u) => u.kind === 'sub'), labelKey: 'name',
    },
    {
      type: 'org_unit', label: 'Individual SSNs',
      items: lookups.units.filter((u) => u.kind === 'ssn'), labelKey: 'name',
    },
  ];
  const node = el('div', { class: 'stack' });
  const boxes = [];

  for (const group of groups) {
    if (!group.items?.length) continue;
    const selected = new Set((initial[group.type] ?? []).map(Number));
    const list = el('div', { class: 'row', style: 'gap:8px' });
    for (const item of group.items) {
      const id = `scope-${group.type}-${item.id}`;
      const input = el('input', { type: 'checkbox', id, style: 'width:auto;min-height:0' });
      input.checked = selected.has(Number(item.id));
      boxes.push({ group: group.type, id: Number(item.id), input });
      list.append(el('label', {
        class: 'chip', for: id,
        style: 'cursor:pointer;padding-left:8px',
      }, [input, el('span', { text: item[group.labelKey] })]));
    }
    node.append(el('div', { class: 'field' }, [
      el('span', { text: group.label }),
      list,
    ]));
  }
  if (!node.children.length) {
    node.append(el('p', { class: 'hint',
      text: 'No sub-companies or SSNs exist yet to scope access to.' }));
  }
  return {
    node,
    value: () => boxes.filter((b) => b.input.checked)
      .map((b) => ({ scope_type: b.group, scope_id: b.id })),
  };
}

function buildPermissionPicker(catalog, initialGrants, roleField) {
  const state = new Map(initialGrants.map((g) => [g.permission, g.effect]));
  const node = el('div', { class: 'stack' });

  const render = () => {
    const role = roleField?.input?.value;
    mount(node, 
      el('p', { class: 'hint', text:
        'Leave everything on "Role default" to use the standard permissions for the role. '
        + 'An explicit Deny always wins over a role default or an Allow.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { scope: 'col' }, el('span', { text: 'Permission' })),
            el('th', { scope: 'col' }, el('span', { text: 'Setting' })),
          ])),
          el('tbody', {}, catalog.map((permission) => {
            const select = el('select', {
              style: 'min-width:150px',
              disabled: permission.owner_only && role !== 'owner',
            }, [
              el('option', { value: '', text: 'Role default',
                selected: !state.has(permission.key) }),
              el('option', { value: 'allow', text: 'Allow',
                selected: state.get(permission.key) === 'allow' }),
              el('option', { value: 'deny', text: 'Deny',
                selected: state.get(permission.key) === 'deny' }),
            ]);
            select.addEventListener('change', () => {
              if (select.value) state.set(permission.key, select.value);
              else state.delete(permission.key);
            });
            return el('tr', {}, [
              el('td', { dataset: { label: 'Permission' } }, el('div', { class: 'cell-stack' }, [
                el('span', { text: permission.label }),
                el('small', { class: 'mono', text: permission.key
                  + (permission.owner_only ? ' · owner only' : '') }),
              ])),
              el('td', { dataset: { label: 'Setting' } }, select),
            ]);
          })),
        ])),
    );
  };
  render();

  return {
    node,
    refresh: render,
    value: () => [...state.entries()].map(([permission, effect]) => ({ permission, effect })),
  };
}

function openAccessForm({ user, lookups, onSaved }) {
  const form = el('form', { class: 'form-grid', novalidate: true });
  const formError = el('p', { class: 'form-error', hidden: true });
  const scopePicker = buildScopePicker(lookups, user.scopes);
  const permissionPicker = buildPermissionPicker(lookups.catalog, user.grants,
    { input: { value: user.role } });
  const reason = field({ label: 'Reason', name: 'reason', type: 'text',
    hint: 'recorded in the audit history' });

  form.append(
    el('p', { class: 'form-note', text:
      `${user.name} · ${titleCase(user.role)}. Changes take effect immediately and are logged.` }),
    el('div', { class: 'form-section' }, [
      el('h3', { text: 'Access scope' }),
      scopePicker.node,
    ]),
    el('div', { class: 'form-section' }, [
      el('h3', { text: 'Permissions' }),
      permissionPicker.node,
    ]),
    reason, formError
  );

  const saveButton = el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Save access', onClick: () => submit(),
  });
  const dialog = modal({
    title: `Access — ${user.name}`,
    wide: true, body: form,
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => dialog.close() }),
      saveButton,
    ],
  });

  async function submit() {
    await withBusy(saveButton, async () => {
      formError.hidden = true;
      try {
        await api.put(`/api/users/${user.id}/access`, {
          permissions: permissionPicker.value(),
          scopes: scopePicker.value(),
          reason: reason.input.value.trim() || undefined,
        });
        toastSuccess('Access updated.');
        dialog.close();
        onSaved();
      } catch (error) {
        if (!applyErrors(form, error.details)) { formError.textContent = error.message; formError.hidden = false; }
      }
    });
  }
}

/* ----------------------------------------------------------------- detail -- */

async function openUserDetail(id, { lookups, session, reload }) {
  const { user, sessions, activity } = await api.get(`/api/users/${id}`);
  const isSelf = user.id === session.user.id;

  const dialog = modal({
    title: `${user.name} (${user.email})`,
    wide: true,
    body: [
      detailList([
        ['Role', pill(user.role === 'owner' ? 'approved' : 'open', titleCase(user.role))],
        ['Status', pill(user.is_active ? 'active' : 'void', user.is_active ? 'Active' : 'Deactivated')],
        ['Access scope', scopeSummary(user, lookups)],
        ['Effective permissions', el('span', { class: 'mono', style: 'font-size:11.5px',
          text: user.effective_permissions.join(', ') })],
        ['Explicit grants', user.grants.length
          ? user.grants.map((g) => `${g.effect}: ${g.permission}`).join(', ') : 'none'],
        ['Last sign-in', user.last_login_at ? timestampLabel(user.last_login_at) : 'never'],
        ['Created', timestampLabel(user.created_at)],
        ['Active sessions', String(sessions.filter((s) => !s.revoked_at).length)],
      ]),
      card({ title: 'Recent activity', body: timeline(activity) }),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Close', onClick: () => dialog.close() }),
      el('button', {
        class: 'btn', type: 'button', text: 'Reset password',
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: `Reset the password for ${user.name}?`,
            message: 'A new temporary password is generated, every session is signed out, and the '
              + 'user must choose a new password at next sign-in.',
            confirmLabel: 'Reset password', danger: true,
          });
          if (!confirmed.confirmed) return;
          const result = await api.post(`/api/users/${user.id}/reset-password`, {});
          dialog.close();
          if (result.temporary_password) {
            showTemporaryPassword({ user, temporary_password: result.temporary_password });
          }
        },
      }),
      el('button', {
        class: 'btn', type: 'button', text: 'Sign out all sessions',
        onClick: async () => {
          await api.post(`/api/users/${user.id}/revoke-sessions`, {});
          toastSuccess('All sessions for this user have been revoked.');
        },
      }),
      isSelf
        ? null
        : el('button', {
          class: user.is_active ? 'btn btn-danger' : 'btn btn-primary',
          type: 'button', text: user.is_active ? 'Deactivate' : 'Reactivate',
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: user.is_active ? `Deactivate ${user.name}?` : `Reactivate ${user.name}?`,
              message: user.is_active
                ? 'They are signed out immediately and cannot sign in again until reactivated. '
                  + 'Their historical records and audit entries are kept.'
                : 'They will be able to sign in again with their existing permissions.',
              confirmLabel: user.is_active ? 'Deactivate' : 'Reactivate',
              danger: user.is_active,
            });
            if (!confirmed.confirmed) return;
            try {
              await api.put(`/api/users/${user.id}`, { is_active: !user.is_active });
              toastSuccess(user.is_active ? 'User deactivated.' : 'User reactivated.');
              dialog.close();
              reload();
            } catch (error) { toastWarn(error.message); }
          },
        }),
    ],
  });
}
