import { api, ApiError } from './api.js';
import { el, clear, $, toast, toastError } from './ui.js';
import { icon } from './icons.js';
import { state as formatState } from './format.js';
import { destroyCharts } from './charts.js';

/** Global session state, read by every view. */
export const session = {
  user: null,
  permissions: new Set(),
  scopes: {},
  settings: {},
  can(permission) { return this.permissions.has(permission); },
  canAny(...list) { return list.some((p) => this.permissions.has(p)); },
  /*
   * Deleting needs two things to be true: the owner has switched deletion on
   * in Settings, and this user holds the destructive permission. Asking in one
   * place means no screen can offer a Delete button the server would refuse.
   */
  canDelete(permission) {
    return this.settings?.allow_delete === true && this.permissions.has(permission);
  },
  /** A user may be restricted to part of the company tree. */
  get isScoped() { return (this.scopes?.org_unit ?? null) !== null; },
};

const ROUTES = [
  { path: 'dashboard', title: 'Dashboard', icon: 'dashboard', group: 'Overview',
    permission: 'dashboard.view', load: () => import('./views/dashboard.js'),
    subtitle: 'Income, tax, expenses and shares — for any range you pick' },
  { path: 'salaries', title: 'Salaries', icon: 'trending-up', group: 'Money',
    permission: 'salaries.view', load: () => import('./views/salaries.js'),
    subtitle: 'What each job paid, month by month' },
  { path: 'jobs', title: 'Jobs', icon: 'receipt', group: 'Money',
    permission: 'jobs.view', load: () => import('./views/jobs.js') },
  { path: 'expenses', title: 'Expenses', icon: 'trending-down', group: 'Money',
    permission: 'expenses.view', load: () => import('./views/expenses.js'),
    subtitle: 'Costs charged to an SSN' },
  { path: 'statement', title: 'Statements', icon: 'equals', group: 'Money',
    permission: 'reports.view', load: () => import('./views/statement.js'),
    subtitle: 'An SSN’s month, line by line' },
  { path: 'tax', title: 'Tax Hold', icon: 'shield', group: 'Money',
    permission: 'tax.view', load: () => import('./views/tax.js'),
    subtitle: 'Held from net before any share is split' },
  { path: 'org', title: 'Structure', icon: 'building', group: 'Company',
    permission: 'org.view', load: () => import('./views/org.js'),
    subtitle: 'Companies, SSNs, and the share each SSN keeps' },
  { path: 'reports', title: 'Reports', icon: 'report', group: 'Insight',
    permission: 'reports.view', load: () => import('./views/reports.js'),
    subtitle: 'Every report states the basis it is built on' },
  { path: 'audit', title: 'Audit history', icon: 'history', group: 'Insight',
    permission: 'audit.view', load: () => import('./views/audit.js') },
  { path: 'users', title: 'Users & access', icon: 'user-cog', group: 'Administration',
    permission: 'users.manage', load: () => import('./views/users.js') },
  { path: 'settings', title: 'Settings', icon: 'settings', group: 'Administration',
    permission: 'settings.manage', load: () => import('./views/settings.js') },
];

/* ----------------------------------------------------------------- theme -- */

const THEME_KEY = 'vault.theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  const preferred = stored
    ?? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(preferred);
  const toggle = $('#theme-toggle');
  clear(toggle).append(icon('theme', { size: 16 }), el('span', { text: 'Theme' }));
  toggle?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    render();
  });
}

/* ------------------------------------------------------------ navigation -- */

export const navigate = (path, query = {}) => {
  const search = new URLSearchParams(query).toString();
  window.location.hash = `#/${path}${search ? `?${search}` : ''}`;
};

/**
 * Update the URL's query WITHOUT re-rendering.
 *
 * navigate() sets the hash, which fires hashchange and tears the whole view
 * down and rebuilds it. That is right when moving between pages and wrong when
 * only a filter changed: the page blinks, and anything the view was holding
 * open -- a filter panel, an expanded detail -- snaps shut.
 *
 * replaceState leaves the hashchange listener alone, so a view can keep its own
 * state and re-render just the part that actually changed, while the URL stays
 * correct for bookmarking and sharing.
 */
export const setQuery = (path, query = {}) => {
  const search = new URLSearchParams(query).toString();
  window.history.replaceState(null, '', `#/${path}${search ? `?${search}` : ''}`);
};

export function currentRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, search] = raw.split('?');
  const route = ROUTES.find((r) => r.path === path);
  return {
    route: route && session.can(route.permission) ? route : firstAllowedRoute(),
    query: Object.fromEntries(new URLSearchParams(search ?? '')),
  };
}

const firstAllowedRoute = () => ROUTES.find((r) => session.can(r.permission)) ?? null;

function buildNav() {
  const nav = clear($('#nav'));
  let group = null;
  for (const route of ROUTES) {
    if (!session.can(route.permission)) continue;
    if (route.group !== group) {
      group = route.group;
      nav.append(el('div', { class: 'nav-group', text: group }));
    }
    nav.append(el('a', { href: `#/${route.path}`, dataset: { path: route.path } }, [
      icon(route.icon, { size: 16 }),
      el('span', { text: route.title }),
    ]));
  }
}

function markActive(path) {
  for (const link of document.querySelectorAll('#nav a')) {
    link.classList.toggle('active', link.dataset.path === path);
  }
}

/* ----------------------------------------------------------------- render -- */

let renderToken = 0;

export async function render() {
  const token = ++renderToken;
  const { route, query } = currentRoute();
  const view = $('#view');
  const actions = clear($('#page-actions'));
  destroyCharts();

  if (!route) {
    clear(view).append(el('div', { class: 'card' },
      el('div', { class: 'empty' }, [
        el('strong', { text: 'No sections are available to your account' }),
        el('p', { text: 'Ask the owner to grant you access to at least one area.' }),
      ])));
    return;
  }

  markActive(route.path);
  $('#page-title').textContent = route.title;
  $('#page-subtitle').textContent = route.subtitle ?? '';
  clear(view);
  view.append(el('div', { class: 'card' },
    el('div', { class: 'card-body', style: 'display:grid;gap:10px' },
      Array.from({ length: 4 }, (_, i) => el('div', { class: 'skeleton', style: `width:${100 - i * 9}%` })))));

  try {
    const module = await route.load();
    if (token !== renderToken) return;
    clear(view);
    await module.default({ view, actions, query, navigate, setQuery, session });
  } catch (error) {
    if (token !== renderToken) return;
    clear(view).append(el('div', { class: 'card' },
      el('div', { class: 'empty' }, [
        el('div', { class: 'ico' }, icon('warning', { size: 26, strokeWidth: 1.4 })),
        el('strong', { text: 'This section could not be loaded' }),
        el('p', { text: error.message }),
        el('button', { class: 'btn', type: 'button', text: 'Try again', onClick: render }),
      ])));
    if (!(error instanceof ApiError) || error.status >= 500) console.error(error);
  }
}

/* ------------------------------------------------------------ session I/O -- */

function applySession(payload) {
  session.user = payload.user;
  session.permissions = new Set(payload.permissions ?? []);
  session.scopes = payload.scopes ?? {};
  session.settings = payload.settings ?? {};
  formatState.currency = payload.settings?.currency_symbol || '$';

  $('#brand-name').textContent = payload.settings?.org_name || 'Vault';
  document.title = `${payload.settings?.org_name || 'Vault'} — Company Finance`;
  $('#demo-banner').hidden = !payload.settings?.demo_mode;

  clear($('#user-chip')).append(
    el('strong', { text: payload.user.name }),
    el('small', { text: `${payload.user.email} · ${payload.user.role}` }),
    (() => {
      const out = el('button', { type: 'button' },
        [icon('logout', { size: 13 }), el('span', { text: 'Sign out' })]);
      out.addEventListener('click', signOut);
      return out;
    })()
  );
  buildNav();
}

async function signOut() {
  try { await api.post('/api/auth/logout'); } catch { /* signing out regardless */ }
  session.user = null;
  session.permissions = new Set();
  $('#root').hidden = true;
  $('#login').hidden = false;
  $('#login-password').value = '';
}

function showApp() {
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#root').hidden = false;
  if (!window.location.hash) {
    const first = firstAllowedRoute();
    window.location.hash = `#/${first?.path ?? 'dashboard'}`;
  }
  render();
  if (session.user?.must_change_password) promptPasswordChange();
}

function showLogin() {
  $('#boot').hidden = true;
  $('#root').hidden = true;
  $('#login').hidden = false;
  $('#login-email').focus();
}

async function promptPasswordChange() {
  const { modal, field, applyErrors, withBusy, toastSuccess } = await import('./ui.js');
  const form = el('form', { class: 'form-grid' });
  const current = field({ label: 'Current password', name: 'current_password', type: 'password', required: true });
  const next = field({
    label: 'New password', name: 'new_password', type: 'password', required: true,
    hint: 'At least 12 characters, mixing three of: lowercase, uppercase, digits, symbols',
  });
  const error = el('p', { class: 'form-error', hidden: true });
  form.append(
    el('p', { class: 'form-note', text: 'Your account was created with a temporary password. Please choose a new one now.' }),
    current, next, error
  );

  const dialog = modal({
    title: 'Choose a new password',
    body: form,
    footer: [el('button', {
      class: 'btn btn-primary', type: 'button', text: 'Update password',
      onClick: (event) => withBusy(event.currentTarget, async () => {
        error.hidden = true;
        try {
          await api.post('/api/auth/change-password', {
            current_password: current.input.value,
            new_password: next.input.value,
          });
          session.user.must_change_password = false;
          toastSuccess('Your password has been updated.');
          dialog.close();
        } catch (err) {
          if (!applyErrors(form, err.details)) { error.textContent = err.message; error.hidden = false; }
        }
      }),
    })],
  });
}

/* ------------------------------------------------------------------ boot -- */

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-submit');
  const error = $('#login-error');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const payload = await api.post('/api/auth/login', {
      email: $('#login-email').value,
      password: $('#login-password').value,
    });
    applySession(payload);
    showApp();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('#login-password').select();
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

const menuButton = $('#menu-btn');
menuButton.addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (event) => {
  const sidebar = $('#sidebar');
  if (!sidebar.classList.contains('open')) return;
  if (sidebar.contains(event.target) || $('#menu-btn').contains(event.target)) {
    if (event.target.closest('a')) closeSidebar();
    return;
  }
  closeSidebar();
});

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

window.addEventListener('hashchange', render);

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason;
  if (error instanceof ApiError && error.status === 401) {
    event.preventDefault();
    signOut();
    toast('Your session has ended. Please sign in again.', { type: 'warning', title: 'Signed out' });
    return;
  }
  if (error instanceof ApiError) {
    event.preventDefault();
    toastError(error.message);
  }
});

initTheme();

try {
  const payload = await api.get('/api/auth/session');
  applySession(payload);
  showApp();
} catch {
  showLogin();
}
