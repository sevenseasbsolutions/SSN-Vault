import { api } from '../api.js';
import {
  el, card, dataTable, pill, field, checkboxField, withBusy, toastSuccess,
  applyErrors, mount,
} from '../ui.js';
import { centsToInput, parseMoney } from '../format.js';

/**
 * Settings.
 *
 * Two cards, each one thing you might come here to do: change how the
 * application behaves, and change your password. The company structure is
 * administered on its own page, since shares and tax rates belong next to the
 * SSNs they apply to rather than in a settings list.
 *
 * Nothing here explains the engine — that is what the README is for, and a
 * settings screen that doubles as documentation is one nobody can scan.
 */
export default async function settings({ view, session }) {
  const data = await api.get('/api/settings');
  const body = el('div', { class: 'stack' });
  view.append(body);

  const form = el('form', { class: 'form-grid', novalidate: true });
  const formError = el('p', { class: 'form-error', hidden: true });
  const inputs = new Map();

  for (const [key, spec] of Object.entries(data.editable)) {
    const current = data.settings[key];
    let node;
    if (key === 'allow_delete') {
      node = checkboxField({
        label: spec.label, name: key, checked: String(current) === 'true', hint: spec.help,
      });
    } else if (key === 'demo_mode') {
      node = checkboxField({
        label: spec.label, name: key, checked: String(current) === 'true',
      });
    } else if (spec.type === 'enum') {
      node = field({
        label: spec.label, name: key, type: 'select', value: current,
        options: spec.values.map((value) => ({ value, label: enumLabel(key, value) })),
      });
    } else if (key === 'require_reason_above_cents') {
      node = field({
        label: spec.label, name: key, type: 'text', value: centsToInput(current),
      });
    } else {
      node = field({
        label: spec.label, name: key, type: spec.type === 'int' ? 'number' : 'text',
        value: current, min: spec.min, max: spec.max,
      });
    }
    inputs.set(key, { node, spec });
  }

  const section = (heading, keys, { stacked = false } = {}) => {
    const present = keys.filter((key) => inputs.has(key));
    if (!present.length) return null;
    const nodes = present.map((key) => inputs.get(key).node);
    return el('div', { class: 'form-section' }, [
      el('h3', { text: heading }),
      stacked ? el('div', { class: 'stack' }, nodes) : el('div', { class: 'grid-2' }, nodes),
    ]);
  };

  form.append(
    section('Organisation', ['org_name', 'currency_symbol', 'currency_code', 'fiscal_year_start_month']),
    section('Records', ['require_reason_above_cents']),
    section('Deleting and display', ['allow_delete', 'demo_mode'], { stacked: true }),
    formError
  );

  const saveButton = el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Save settings',
    onClick: () => submit(),
  });

  async function submit() {
    await withBusy(saveButton, async () => {
      formError.hidden = true;
      const payload = {};
      for (const [key, { node }] of inputs) {
        let value = node.input.type === 'checkbox' ? String(node.input.checked) : node.input.value;
        if (key === 'require_reason_above_cents') {
          const cents = parseMoney(value);
          if (cents === null || cents < 0) {
            applyErrors(form, { [key]: 'Enter a valid amount' });
            return;
          }
          value = cents;
        }
        payload[key] = value;
      }
      try {
        const result = await api.put('/api/settings', payload);
        const changed = Object.keys(result.changes).length;
        // The delete switch decides whether other screens offer a Delete button
        // at all, so the live session learns about it immediately rather than
        // after a reload.
        if ('allow_delete' in result.changes) {
          session.settings = {
            ...session.settings,
            allow_delete: String(result.changes.allow_delete.to) === 'true',
          };
        }
        toastSuccess(changed ? `${changed} setting${changed === 1 ? '' : 's'} saved.` : 'No changes.');
      } catch (error) {
        if (!applyErrors(form, error.details)) {
          formError.textContent = error.message;
          formError.hidden = false;
        }
      }
    });
  }

  body.append(
    card({
      title: 'Settings',
      body: [form, el('div', { class: 'form-actions' }, saveButton)],
    }),
    card({ title: 'Your password', body: passwordForm() })
  );
}

function passwordForm() {
  const form = el('form', { class: 'form-grid', novalidate: true });
  const current = field({ label: 'Current password', name: 'current_password', type: 'password', required: true });
  const next = field({
    label: 'New password', name: 'new_password', type: 'password', required: true,
    hint: 'at least 12 characters',
  });
  const confirm = field({ label: 'Confirm new password', name: 'confirm', type: 'password', required: true });
  const formError = el('p', { class: 'form-error', hidden: true });

  const button = el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Update password',
    onClick: () => withBusy(button, async () => {
      formError.hidden = true;
      if (next.input.value !== confirm.input.value) {
        applyErrors(form, { confirm: 'The two new passwords do not match' });
        return;
      }
      try {
        await api.post('/api/auth/change-password', {
          current_password: current.input.value,
          new_password: next.input.value,
        });
        toastSuccess('Password updated. Your other sessions have been signed out.');
        form.reset();
      } catch (error) {
        if (!applyErrors(form, error.details)) {
          formError.textContent = error.message;
          formError.hidden = false;
        }
      }
    }),
  });

  form.append(
    el('div', { class: 'grid-3' }, [current, next, confirm]),
    formError,
    el('div', { class: 'form-actions' }, button)
  );
  return form;
}

/* No setting is an enum with wording of its own any more; the retired
 * calculation policies were the only ones. Kept as a lookup so adding one
 * later needs no new plumbing. */
const ENUM_LABELS = {};

const enumLabel = (key, value) => ENUM_LABELS[key]?.[value] ?? String(value);
