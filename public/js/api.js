/** Thin API client. Attaches the CSRF token and normalises error shapes. */

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = payload?.error?.code;
    this.details = payload?.error?.details || null;
  }
}

function csrfToken() {
  const match = /(?:^|;\s*)vault_csrf=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : '';
}

async function request(method, path, { body, query, raw } = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, value);
  }

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();

  const response = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (raw) {
    if (!response.ok) throw new ApiError(response.status, await safeJson(response));
    return response;
  }

  if (response.status === 204) return null;
  const payload = await safeJson(response);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

async function safeJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 200) } }; }
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  del: (path, body) => request('DELETE', path, { body }),

  /** Build a download URL that carries the current filters and format. */
  exportUrl(path, query = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  },

  async upload(file) {
    const response = await fetch('/api/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type,
        'X-Filename': file.name,
        'X-CSRF-Token': csrfToken(),
      },
      body: file,
    });
    const payload = await safeJson(response);
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload.attachment;
  },
};
