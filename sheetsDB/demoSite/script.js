const api = {
  get baseUrl() { return document.getElementById('apiUrl').value.trim(); },
  get authKey() { return document.getElementById('authKey').value.trim(); },

  _buildUrl(table, params) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('table', table);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    return url;
  },

  async _request(method, table, params, body) {
    const url = this._buildUrl(table, params);
    const payload = { _method: method, ...(body || {}) };
    const headers = { 'Content-Type': 'text/plain' };
    // Send JWT as Authorization: Bearer <token>
    // Falls back to body.auth for legacy plain-text keys
    const token = this.authKey;
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    const opts = {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    };
    const start = performance.now();
    let res, data;
    try {
      res = await fetch(url.toString(), opts);
      data = await res.json();
    } catch (err) {
      data = { error: true, message: err.message || 'Network error', code: 0 };
    }
    const elapsed = (performance.now() - start).toFixed(1);
    return { data, elapsed, ok: !data.error };
  },

  listTables()              { return this._request('GET', '_tables', {}, null); },
  describeTable(name)       { return this._request('GET', '_tables', { name }, null); },
  createTable(name, columns) { return this._request('POST', '_tables', {}, { name, columns }); },
  dropTable(name)           { return this._request('DELETE', '_tables', { name }, null); },
  renameTable(oldName, newName) { return this._request('PUT', '_tables', {}, { oldName, newName }); },

  query(table, params)      { return this._request('GET', table, params, null); },
  insert(table, record)     { return this._request('POST', table, {}, record); },
  insertMany(table, records) { return this._request('POST', table, {}, { records }); },
  update(table, where, values) { return this._request('PUT', table, {}, { where, values }); },
  deleteRows(table, where)  { return this._request('DELETE', table, { where }, null); },

  addColumn(table, column)  { return this._request('POST', '_schema', {}, { table, column }); },
  removeColumn(table, column) { return this._request('DELETE', '_schema', {}, { table, column }); },
  renameColumn(table, oldName, newName) { return this._request('PUT', '_schema', {}, { table, oldName, newName }); },
  changeColumnType(table, column, type) { return this._request('PUT', '_schema', {}, { table, column, type }); },

  // --- RLS management (service key only) ---
  rlsStatus()             { return this._request('GET', '_rls', { status: '1' }, null); },
  rlsEnable()             { return this._request('GET', '_rls', { toggle: 'on' }, null); },
  rlsDisable()            { return this._request('GET', '_rls', { toggle: 'off' }, null); },
  rlsListUsers()          { return this._request('GET', '_rls', {}, null); },
  rlsGetUser(id)          { return this._request('GET', '_rls', { id: String(id) }, null); },
  rlsCreateUser(gperms, tables) { return this._request('POST', '_rls', {}, { gperms, tables }); },
  rlsUpdateUser(id, updates)    { return this._request('PUT', '_rls', {}, { id, ...updates }); },
  rlsDeleteUser(id)       { return this._request('DELETE', '_rls', { id: String(id) }, null); },

  async test() {
    try {
      const r = await this.listTables();
      return r;
    } catch {
      return { ok: false, data: { error: true, message: 'Connection failed' }, elapsed: 0 };
    }
  }
};


const ui = {
  /** Show results in the panel */
  showResult(data, elapsed, ok) {
    const status = document.getElementById('resStatus');
    const time   = document.getElementById('resTime');
    const body   = document.getElementById('resBody');

    status.className = 'status-pill ' + (ok ? 'ok' : 'error');
    status.textContent = ok ? 'OK' : 'ERROR';
    time.textContent = elapsed ? `${elapsed}ms` : '';

    const formatted = JSON.stringify(data, null, 2);
    body.textContent = formatted;
    body.classList.add('json-loaded');

    // Scroll to results
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  /** Clear results */
  clearResult() {
    document.getElementById('resStatus').className = 'status-pill';
    document.getElementById('resTime').textContent = '';
    document.getElementById('resBody').textContent = '// Run a query to see results here';
    document.getElementById('resBody').classList.remove('json-loaded');
  },

  /** Toast notification */
  toast(msg, type) {
    const container = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2500);
    setTimeout(() => el.remove(), 2900);
  },

  /** Set inline HTML result for a card */
  setInline(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  },

  /** Set query count badge */
  setCount(text) {
    document.getElementById('queryCount').textContent = text;
  },

  /** Get field value, returns empty string if element missing */
  val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; },

  /** Parse JSON from a field, showing toast on failure. Returns parsed value or null. */
  parseJSON(id, label) {
    const raw = this.val(id);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch {
      this.toast(`Invalid JSON in ${label}`, 'error');
      throw new Error(`Invalid JSON in ${label}`);
    }
  },

  /** Get value parsed as a simple where clause (string or object). Returns null if empty. */
  whereVal(id) {
    const raw = this.val(id);
    if (!raw) return null;
    // Try parsing as JSON first (object where)
    try { return JSON.parse(raw); } catch { /* not JSON, treat as string */ }
    // Remove wrapping quotes if present
    return raw;
  },

  /** Buld where-as-object from equals shorthand: "id=4" → {id:4} */
  whereValShort(id) {
    const raw = this.val(id);
    if (!raw) return null;
    // Try JSON
    try { return JSON.parse(raw); } catch {}
    // Try "col=val" shorthand → return as string (server's parseWhere handles it)
    return raw;
  },

  /** Build query params object from form fields, omitting empties */
  buildQueryParams() {
    const p = {};
    const w = this.val('q-where');     if (w) p.where  = w;
    const s = this.val('q-select');    if (s) p.select = s;
    const o = this.val('q-sort');      if (o) p.sort   = o;
    const l = this.val('q-limit');     if (l) p.limit  = l;
    const f = this.val('q-offset');    if (f) p.offset = f;
    return p;
  },

  /** Persist config to localStorage */
  saveConfig() {
    localStorage.setItem('sheetsdb_url', document.getElementById('apiUrl').value);
    localStorage.setItem('sheetsdb_auth', document.getElementById('authKey').value);
  },

  /** Restore config from localStorage */
  loadConfig() {
    const url = localStorage.getItem('sheetsdb_url');
    const auth = localStorage.getItem('sheetsdb_auth');
    if (url) document.getElementById('apiUrl').value = url;
    if (auth) document.getElementById('authKey').value = auth;
  },

  /** Validate that API URL and auth are set */
  ensureConfig() {
    if (!api.baseUrl) { this.toast('Enter your API URL first', 'error'); return false; }
    if (!api.authKey) { this.toast('Enter your Auth Key first', 'error'); return false; }
    return true;
  }
};

// ============================================================
//  Action handlers — each returns {ok, data, elapsed}
// ============================================================

const actions = {

  // --- Tables ---
  async createTable() {
    const name = ui.val('ct-name');
    if (!name) { ui.toast('Table name required', 'error'); return; }
    let columns = [];
    const raw = ui.val('ct-columns');
    if (raw) {
      try { columns = JSON.parse(raw); } catch { ui.toast('Invalid JSON in columns', 'error'); return; }
    }
    return api.createTable(name, columns);
  },

  async listTables() {
    const r = await api.listTables();
    if (r.ok && Array.isArray(r.data)) {
      const items = r.data.length
        ? r.data.map(t => `<span class="table-chip">📋 ${esc(t)}</span>`).join(' ')
        : '<span style="color:var(--text-muted)">No tables yet</span>';
      ui.setInline('tableList', items);
    }
    return r;
  },

  async describeTable() {
    const name = ui.val('desc-name');
    if (!name) { ui.toast('Table name required', 'error'); return; }
    return api.describeTable(name);
  },

  async renameTable() {
    const oldName = ui.val('rn-old');
    const newName = ui.val('rn-new');
    if (!oldName || !newName) { ui.toast('Old and new names required', 'error'); return; }
    return api.renameTable(oldName, newName);
  },

  async dropTable() {
    const name = ui.val('drop-name');
    if (!name) { ui.toast('Table name required', 'error'); return; }
    if (!confirm(`Drop table "${name}"? This deletes all data permanently.`)) return;
    return api.dropTable(name);
  },

  // --- Query ---
  async query() {
    const table = ui.val('q-table');
    if (!table) { ui.toast('Table name required', 'error'); return; }
    const params = ui.buildQueryParams();
    const r = await api.query(table, params);
    if (r.ok && Array.isArray(r.data)) {
      ui.setCount(`(${r.data.length} row${r.data.length !== 1 ? 's' : ''})`);
    } else {
      ui.setCount('');
    }
    return r;
  },

  // --- Insert ---
  async insert() {
    const table = ui.val('ins-table');
    if (!table) { ui.toast('Table name required', 'error'); return; }
    const raw = ui.val('ins-data');
    if (!raw) { ui.toast('Record data required', 'error'); return; }
    let data;
    try { data = JSON.parse(raw); } catch { ui.toast('Invalid JSON in record', 'error'); return; }

    const bulk = document.getElementById('ins-bulk').checked;
    if (bulk) {
      if (!Array.isArray(data)) { ui.toast('Bulk insert expects a JSON array', 'error'); return; }
      return api.insertMany(table, data);
    }
    return api.insert(table, data);
  },

  // --- Update ---
  async update() {
    const table = ui.val('upd-table');
    if (!table) { ui.toast('Table name required', 'error'); return; }
    const whereRaw = ui.val('upd-where');
    if (!whereRaw) { ui.toast('Where clause required', 'error'); return; }
    let where;
    try { where = JSON.parse(whereRaw); } catch { where = whereRaw; }
    const valuesRaw = ui.val('upd-values');
    let values = {};
    if (valuesRaw) {
      try { values = JSON.parse(valuesRaw); } catch { ui.toast('Invalid JSON in values', 'error'); return; }
    }
    return api.update(table, where, values);
  },

  // --- Delete ---
  async deleteRows() {
    const table = ui.val('del-table');
    if (!table) { ui.toast('Table name required', 'error'); return; }
    const whereRaw = ui.val('del-where');
    if (!whereRaw) { ui.toast('Where clause required', 'error'); return; }
    let where;
    try { where = JSON.parse(whereRaw); } catch { where = whereRaw; }
    return api.deleteRows(table, where);
  },

  // --- Schema ---
  async addColumn() {
    const table = ui.val('ac-table');
    const name  = ui.val('ac-name');
    const type  = ui.val('ac-type');
    if (!table || !name) { ui.toast('Table and column name required', 'error'); return; }
    return api.addColumn(table, { name, type });
  },

  async removeColumn() {
    const table  = ui.val('rc-table');
    const column = ui.val('rc-name');
    if (!table || !column) { ui.toast('Table and column name required', 'error'); return; }
    if (!confirm(`Remove column "${column}" from "${table}"? Data in this column will be lost.`)) return;
    return api.removeColumn(table, column);
  },

  async renameColumn() {
    const table   = ui.val('rnc-table');
    const oldName = ui.val('rnc-old');
    const newName = ui.val('rnc-new');
    if (!table || !oldName || !newName) { ui.toast('Table, old name, and new name required', 'error'); return; }
    return api.renameColumn(table, oldName, newName);
  },

  async changeColumnType() {
    const table  = ui.val('cct-table');
    const column = ui.val('cct-column');
    const type   = ui.val('cct-type');
    if (!table || !column) { ui.toast('Table and column name required', 'error'); return; }
    return api.changeColumnType(table, column, type);
  },

  // --- RLS ---

  async rlsRefreshStatus() {
    const r = await api.rlsStatus();
    if (r.ok && r.data) {
      const badge = document.getElementById('rlsStatusBadge');
      badge.textContent = r.data.rls_enabled ? 'ENABLED' : 'DISABLED';
      badge.className = 'status-pill ' + (r.data.rls_enabled ? 'ok' : 'error');
      document.getElementById('rlsUserCount').textContent =
        r.data.user_count !== undefined ? '(' + r.data.user_count + ' user' + (r.data.user_count !== 1 ? 's' : '') + ')' : '';
    }
    return r;
  },

  async rlsEnable() {
    const r = await api.rlsEnable();
    if (r.ok) await actions.rlsRefreshStatus();
    return r;
  },

  async rlsDisable() {
    if (!confirm('Disable RLS? All valid keys will get full read+write access.')) return;
    const r = await api.rlsDisable();
    if (r.ok) await actions.rlsRefreshStatus();
    return r;
  },

  async rlsListUsers() {
    const r = await api.rlsListUsers();
    if (r.ok && Array.isArray(r.data)) {
      const rowsEl = document.getElementById('rlsKeyRows');
      if (r.data.length === 0) {
        rowsEl.innerHTML = '<div class="rls-key-placeholder">No users yet. Create one above.</div>';
      } else {
        rowsEl.innerHTML = r.data.map(function(u) {
          const tablesStr = u.tables && Object.keys(u.tables).length
            ? JSON.stringify(u.tables)
            : '—';
          return '<div class="rls-key-row">' +
            '<span>' + esc(String(u._id)) + '</span>' +
            '<span class="rls-key-cell-gperm" data-gperm="' + esc(u.gperms) + '">' + esc(u.gperms) + '</span>' +
            '<span class="rls-key-cell-tables" title="' + esc(tablesStr) + '">' + esc(tablesStr) + '</span>' +
            '<span></span>' +
            '</div>';
        }).join('');
      }
    }
    return r;
  },

  async rlsCreateUser() {
    const gperms = document.getElementById('rls-create-gperms').value;
    const tablesRaw = ui.val('rls-create-tables');
    let tables = null;
    if (tablesRaw) {
      try { tables = JSON.parse(tablesRaw); } catch { ui.toast('Invalid JSON in table overrides', 'error'); return; }
    }
    const r = await api.rlsCreateUser(gperms, tables);
    const keyEl = document.getElementById('rlsNewKey');
    if (r.ok && r.data.token) {
      keyEl.innerHTML = '<strong>JWT Token (copy now — never shown again):</strong>\n<code>' + esc(r.data.token) + '</code>';
      keyEl.style.display = 'block';
      // Auto-fill the auth field with the new token
      document.getElementById('authKey').value = r.data.token;
      ui.saveConfig();
      await actions.rlsListUsers();
      await actions.rlsRefreshStatus();
    } else {
      keyEl.style.display = 'none';
    }
    return r;
  },

  async rlsUpdateUser() {
    const idRaw = ui.val('rls-mgmt-id');
    if (!idRaw) { ui.toast('User ID required', 'error'); return; }
    const id = Number(idRaw);
    const updates = {};
    const gperms = document.getElementById('rls-mgmt-gperms').value;
    if (gperms) updates.gperms = gperms;
    const tablesRaw = ui.val('rls-mgmt-tables');
    if (tablesRaw) {
      try { updates.tables = JSON.parse(tablesRaw); } catch { ui.toast('Invalid JSON in tables', 'error'); return; }
    }
    if (Object.keys(updates).length === 0) { ui.toast('gperms or tables required', 'error'); return; }
    const r = await api.rlsUpdateUser(id, updates);
    if (r.ok) await actions.rlsListUsers();
    return r;
  },

  async rlsDeleteUser() {
    const idRaw = ui.val('rls-mgmt-id');
    if (!idRaw) { ui.toast('User ID required', 'error'); return; }
    if (!confirm('Delete user ' + idRaw + '? Their token will stop working immediately.')) return;
    const r = await api.rlsDeleteUser(Number(idRaw));
    if (r.ok) {
      await actions.rlsListUsers();
      await actions.rlsRefreshStatus();
    }
    return r;
  }
};

// ============================================================
//  Bootstrap
// ============================================================

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Handle a button action: call handler, show result, toast */
async function handleAction(actionName) {
  if (!ui.ensureConfig()) return;
  const fn = actions[actionName];
  if (!fn) { ui.toast(`Unknown action: ${actionName}`, 'error'); return; }

  // Show loading state
  const resBody = document.getElementById('resBody');
  resBody.textContent = '...';
  resBody.classList.add('json-loaded');
  document.getElementById('resStatus').className = 'status-pill info';
  document.getElementById('resStatus').textContent = 'LOADING';
  document.getElementById('resTime').textContent = '';

  try {
    const r = await fn();
    if (r) {
      ui.showResult(r.data, r.elapsed, r.ok);
      ui.toast(r.ok ? 'Success' : (r.data.message || 'Request failed'), r.ok ? 'success' : 'error');
    }
  } catch (err) {
    ui.showResult({ error: true, message: err.message }, 0, false);
    ui.toast(err.message, 'error');
  }
}

// Tab switching
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      panels.forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('panel-' + target);
      if (panel) panel.classList.add('active');
    });
  });
}

// Button delegation — any [data-action] button
function setupActions() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    await handleAction(action);
  });
}

// Connection test — also detects key type
async function testConnection() {
  const btn = document.getElementById('btnConnect');
  btn.textContent = '…';
  btn.disabled = true;

  if (!api.baseUrl) { ui.toast('Enter API URL', 'error'); resetBtn(); return; }
  if (!api.authKey) { ui.toast('Enter Auth Key', 'error'); resetBtn(); return; }

  // First test basic connectivity
  const r = await api.test();
  if (r.ok) {
    // Detect key type: try _rls?status (succeeds only for service key)
    const rlsCheck = await api.rlsStatus();
    let keyType = '';
    if (rlsCheck.ok) {
      keyType = 'service';
      ui.toast('Connected as service key — full RLS management available', 'success');
    } else {
      // JWT tokens start with eyJ (base64url of {"alg"...)
      if (api.authKey.startsWith('eyJ')) {
        keyType = 'jwt';
        ui.toast('Connected with JWT token — RLS enforced', 'info');
      } else {
        keyType = 'legacy';
        ui.toast('Connected with legacy key — consider upgrading to JWT', 'info');
      }
    }
    updateKeyBadge(keyType);
    ui.showResult(r.data, r.elapsed, true);

    // If service key, auto-refresh RLS info
    if (keyType === 'service') {
      actions.rlsRefreshStatus();
      actions.rlsListUsers();
    }
  } else {
    updateKeyBadge('');
    ui.toast(r.data.message || 'Connection failed', 'error');
    ui.showResult(r.data, r.elapsed, false);
  }

  resetBtn();
  function resetBtn() {
    btn.innerHTML = '<span class="btn-icon">&#9889;</span> Connect';
    btn.disabled = false;
  }
}

function updateKeyBadge(type) {
  let badge = document.getElementById('keyTypeBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'keyTypeBadge';
    badge.className = 'badge key-type-badge';
    const connectBtn = document.getElementById('btnConnect');
    connectBtn.parentNode.insertBefore(badge, connectBtn.nextSibling);
  }
  if (type === 'service') {
    badge.textContent = '🔑 Service Key';
    badge.style.color = 'var(--success)';
    badge.style.borderColor = 'rgba(45,212,191,.35)';
  } else if (type === 'jwt') {
    badge.textContent = '🎫 JWT Token';
    badge.style.color = 'var(--accent)';
    badge.style.borderColor = 'rgba(99,102,241,.35)';
  } else if (type === 'legacy') {
    badge.textContent = '🔐 Legacy Key';
    badge.style.color = 'var(--warning)';
    badge.style.borderColor = 'rgba(251,191,36,.35)';
  } else {
    badge.textContent = '';
    badge.style.color = '';
    badge.style.borderColor = '';
  }
}

// Save config on change
function setupConfigPersistence() {
  document.getElementById('apiUrl').addEventListener('change', () => ui.saveConfig());
  document.getElementById('authKey').addEventListener('change', () => ui.saveConfig());
  document.getElementById('btnConnect').addEventListener('click', testConnection);
}

// Clear button
function setupResultControls() {
  document.getElementById('btnClear').addEventListener('click', () => ui.clearResult());
  document.getElementById('btnCopy').addEventListener('click', () => {
    const text = document.getElementById('resBody').textContent;
    navigator.clipboard.writeText(text).then(
      () => ui.toast('Copied to clipboard', 'success'),
      () => ui.toast('Failed to copy', 'error')
    );
  });
}

// Keyboard: Ctrl/Cmd+Enter submits the active panel form
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      const panel = document.querySelector('.panel.active');
      if (!panel) return;
      const btn = panel.querySelector('[data-action]');
      if (btn) btn.click();
    }
  });
}

// Bulk insert toggle updates label
function setupBulkToggle() {
  const toggle = document.getElementById('ins-bulk');
  const label  = document.getElementById('ins-label');
  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      label.innerHTML = 'Records <span class="hint">JSON array of objects</span>';
      document.getElementById('ins-data').placeholder = '[{"name":"John","age":25},{"name":"Jane","age":30}]';
    } else {
      label.innerHTML = 'Record <span class="hint">JSON object</span>';
      document.getElementById('ins-data').placeholder = '{"name":"John","age":25}';
    }
  });
}

// ============================================================
//  Init
// ============================================================

function init() {
  ui.loadConfig();
  setupTabs();
  setupActions();
  setupConfigPersistence();
  setupResultControls();
  setupKeyboard();
  setupBulkToggle();
}

document.addEventListener('DOMContentLoaded', init);
