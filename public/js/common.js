/**
 * Shared helpers used by login, associate and admin pages.
 */
const TOKEN_KEY = 'ap_ts_token';
const USER_KEY  = 'ap_ts_user';

const Auth = {
  setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  token() { return localStorage.getItem(TOKEN_KEY); },
  user()  { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; } },
  clear() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); },
  logout() { this.clear(); window.location.href = '/'; },
  requireAuth(role) {
    const u = this.user();
    if (!this.token() || !u) { window.location.href = '/'; return null; }
    if (role && u.role !== role) {
      window.location.href = u.role === 'admin' ? '/admin' : '/associate';
      return null;
    }
    return u;
  }
};

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: {} };
  const token = Auth.token();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (options.body && !(options.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  } else if (options.body) {
    opts.body = options.body;
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    Auth.clear();
    if (location.pathname !== '/') location.href = '/';
    throw new Error('Session expired');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ('Request failed (' + res.status + ')');
    const err = new Error(msg); err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

function fmtMoney(amount, currency) {
  const sym = (currency || 'INR') === 'INR' ? '₹' : (currency || '');
  const n = Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sym + ' ' + n;
}
function fmtDate(d) { if (!d) return ''; return d.length > 10 ? d.slice(0, 10) : d; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthStartISO(d) { const x = d ? new Date(d) : new Date(); return x.toISOString().slice(0,8) + '01'; }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function showAlert(elId, msg, type = 'error') {
  const el = document.getElementById(elId); if (!el) return;
  el.className = 'alert ' + type;
  el.textContent = msg;
  setTimeout(() => { if (el) { el.className = 'alert ' + type + ' hidden'; el.textContent = ''; } }, 5000);
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setVal(id, v)     { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; }

function renderTopBar(activeTab) {
  const u = Auth.user(); if (!u) return '';
  const isAdmin = u.role === 'admin';
  const tabs = isAdmin ? [
    { id: 'tab-dashboard', label: 'Dashboard' },
    { id: 'tab-entries',   label: 'Timesheets' },
    { id: 'tab-billing',   label: 'Billing' },
    { id: 'tab-reports',   label: 'Reports' },
    { id: 'tab-masters',   label: 'Masters' }
  ] : [
    { id: 'tab-mine',  label: 'My Timesheet' },
    { id: 'tab-new',   label: 'New Entry' },
    { id: 'tab-month', label: 'Monthly Summary' }
  ];
  return `
    <div class="topbar">
      <div class="brand">
        <img class="brand-logo" src="/img/logo.png" alt="AP & Partners" onerror="this.style.display='none'">
        <div class="brand-text"><strong>AP &amp; Partners</strong><small>Timesheet &amp; Billing</small></div>
      </div>
      <div class="topnav">
        ${tabs.map(t => `<button data-tab="${t.id}" class="${activeTab === t.id ? 'active' : ''}">${t.label}</button>`).join('')}
      </div>
      <div class="userbox">
        <span>${escapeHtml(u.full_name)} <span class="muted">· ${escapeHtml(u.designation || u.role)}</span></span>
        <button onclick="changePasswordModal()">Password</button>
        <button onclick="Auth.logout()">Logout</button>
      </div>
    </div>`;
}

function changePasswordModal() {
  const html = `
    <div class="modal-backdrop" id="pw-modal">
      <div class="modal" style="max-width:420px;">
        <div class="modal-head">
          <h3>Change password</h3>
          <button class="close" onclick="document.getElementById('pw-modal').remove()">×</button>
        </div>
        <div class="modal-body">
          <div id="pw-alert" class="alert hidden"></div>
          <div class="form-row"><label>Current password</label><input id="pw-curr" type="password"/></div>
          <div class="form-row"><label>New password (min 8 chars)</label><input id="pw-new" type="password"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" onclick="document.getElementById('pw-modal').remove()">Cancel</button>
          <button class="btn" onclick="submitChangePassword()">Save</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function submitChangePassword() {
  const curr = document.getElementById('pw-curr').value;
  const next = document.getElementById('pw-new').value;
  try {
    await api('/api/auth/change-password', { method: 'POST', body: { current_password: curr, new_password: next } });
    document.getElementById('pw-modal').remove();
    alert('Password changed.');
  } catch (e) { showAlert('pw-alert', e.message); }
}
