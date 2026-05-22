/**
 * Admin page logic — dashboard, all timesheets, billing, reports, masters.
 */
(function () {
  const me = Auth.requireAuth('admin'); if (!me) return;

  document.getElementById('topbar').innerHTML = renderTopBar('tab-dashboard');
  document.querySelectorAll('.topnav button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-mtab]').forEach(btn => {
    btn.addEventListener('click', () => switchMTab(btn.dataset.mtab));
  });

  let CLIENTS = [], MATTERS = [], USERS = [];
  let LAST_PREVIEW = null;

  setVal('af-from', monthStartISO());
  setVal('af-to',   todayISO());
  setVal('bi-from', monthStartISO());
  setVal('bi-to',   todayISO());
  setVal('bi-date', todayISO());
  setVal('rp-from', monthStartISO());
  setVal('rp-to',   todayISO());

  async function loadMasters() {
    const [u, c, m] = await Promise.all([
      api('/api/users'),
      api('/api/clients'),
      api('/api/matters')
    ]);
    USERS = u.users; CLIENTS = c.clients; MATTERS = m.matters;
    fillSelect('af-user', USERS,   'id', x => x.full_name + ' (' + x.role + ')', true);
    fillSelect('af-client', CLIENTS, 'id', x => x.name, true);
    fillSelect('af-matter', MATTERS, 'id', x => x.file_no + ' — ' + x.title, true);
    fillSelect('bi-client', CLIENTS, 'id', x => x.name, false);
  }

  function fillSelect(id, items, valKey, labelFn, withAll) {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = (withAll ? '<option value="">All</option>' : '<option value="">— Select —</option>') +
      items.map(it => `<option value="${it[valKey]}">${escapeHtml(labelFn(it))}</option>`).join('');
  }

  // -------------------- Dashboard --------------------
  async function loadDashboard() {
    const d = await api('/api/admin/dashboard');
    document.getElementById('dash-kpis').innerHTML = `
      <div class="kpi"><h4>Pending approval</h4><div class="val">${d.pending}</div><div class="sub">submitted entries</div></div>
      <div class="kpi"><h4>Approved entries</h4><div class="val">${d.approved}</div><div class="sub">all-time</div></div>
      <div class="kpi"><h4>Hours today</h4><div class="val">${Number(d.today_hours).toFixed(2)}</div></div>
      <div class="kpi"><h4>Hours this month</h4><div class="val">${Number(d.month_hours).toFixed(2)}</div><div class="sub">${Number(d.month_billable_hours).toFixed(2)} billable</div></div>
      <div class="kpi"><h4>Active associates</h4><div class="val">${d.active_users}</div></div>
      <div class="kpi"><h4>Open matters</h4><div class="val">${d.open_matters}</div></div>
      <div class="kpi"><h4>Open invoices</h4><div class="val">${d.open_invoices}</div><div class="sub">${fmtMoney(d.invoiced_total_month)} this month</div></div>`;
    loadPending();
  }

  window.loadPending = async function () {
    const r = await api('/api/timesheet?status=submitted');
    renderEntriesTable('pending-table', r.entries, { selectable: true, showApprove: true });
  };

  // -------------------- All entries --------------------
  window.loadAllEntries = async function () {
    const params = new URLSearchParams();
    const fields = { from: 'af-from', to: 'af-to', user_id: 'af-user', client_id: 'af-client', matter_id: 'af-matter', status: 'af-status' };
    for (const k in fields) {
      const v = document.getElementById(fields[k]).value;
      if (v) params.set(k, v);
    }
    const r = await api('/api/timesheet?' + params.toString());
    renderEntriesTable('all-entries-table', r.entries, { selectable: true, showApprove: true });
  };

  function renderEntriesTable(targetId, entries, opts = {}) {
    const wrap = document.getElementById(targetId);
    if (!entries.length) { wrap.innerHTML = '<div class="empty">No entries match these filters.</div>'; return; }
    wrap.innerHTML = `
      <table class="data">
        <thead><tr>
          ${opts.selectable ? '<th><input type="checkbox" onchange="toggleAllRows(this)"></th>' : ''}
          <th>Date</th><th>Associate</th><th>Client / Matter</th><th>Activity</th>
          <th>Description</th><th class="num">Hrs</th><th>Bill?</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${entries.map(e => `
            <tr>
              ${opts.selectable ? `<td><input type="checkbox" class="row-check" value="${e.id}"></td>` : ''}
              <td class="nowrap">${fmtDate(e.entry_date)}</td>
              <td>${escapeHtml(e.user_name)}</td>
              <td><strong>${escapeHtml(e.client_name)}</strong><br><span class="muted">${escapeHtml(e.file_no)} — ${escapeHtml(e.matter_title)}</span></td>
              <td>${escapeHtml(e.activity_type)}</td>
              <td>${escapeHtml(e.description)}${e.attachment_count ? ' 📎' : ''}</td>
              <td class="num">${Number(e.hours).toFixed(2)}</td>
              <td>${e.is_billable ? '✓' : '—'}</td>
              <td><span class="pill ${e.status}">${e.status}</span>${e.rejection_note?`<br><small class="muted">${escapeHtml(e.rejection_note)}</small>`:''}</td>
              <td class="row-actions">
                ${e.status === 'submitted' ? `<button class="btn btn-sm btn-success" onclick="approveEntry(${e.id})">Approve</button>` : ''}
                ${e.status === 'submitted' ? `<button class="btn btn-sm btn-warning" onclick="rejectEntry(${e.id})">Reject</button>` : ''}
                ${e.status !== 'invoiced' ? `<button class="btn btn-sm btn-ghost" onclick="adminEditEntry(${e.id})">Edit</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  window.toggleAllRows = function (chk) {
    document.querySelectorAll('.row-check').forEach(c => { c.checked = chk.checked; });
  };
  window.bulkApprove = async function () {
    const ids = [...document.querySelectorAll('.row-check:checked')].map(c => parseInt(c.value, 10));
    if (!ids.length) { alert('Select at least one row.'); return; }
    if (!confirm('Approve ' + ids.length + ' entr' + (ids.length===1?'y':'ies') + '?')) return;
    await api('/api/admin/timesheet/bulk-approve', { method: 'POST', body: { ids } });
    loadAllEntries(); loadPending(); loadDashboard();
  };
  window.approveEntry = async function (id) {
    await api('/api/admin/timesheet/' + id + '/approve', { method: 'POST' });
    loadAllEntries(); loadPending(); loadDashboard();
  };
  window.rejectEntry = async function (id) {
    const note = prompt('Reason for rejection (optional):') || '';
    await api('/api/admin/timesheet/' + id + '/reject', { method: 'POST', body: { note } });
    loadAllEntries(); loadPending(); loadDashboard();
  };

  window.adminEditEntry = async function (id) {
    const r = await api('/api/timesheet/' + id);
    const e = r.entry;
    const html = `
      <div class="modal-backdrop" id="edit-modal">
        <div class="modal">
          <div class="modal-head"><h3>Edit · ${escapeHtml(e.user_name)} · ${fmtDate(e.entry_date)}</h3>
            <button class="close" onclick="document.getElementById('edit-modal').remove()">×</button></div>
          <div class="modal-body">
            <div id="edit-alert" class="alert hidden"></div>
            <div class="form-grid cols-3">
              <div class="form-row"><label>Date</label><input type="date" id="e-date" value="${e.entry_date}"></div>
              <div class="form-row"><label>Hours</label><input type="number" step="0.25" id="e-hours" value="${e.hours}"></div>
              <div class="form-row"><label>Status</label>
                <select id="e-status">
                  ${['draft','submitted','approved','rejected'].map(s => `<option value="${s}" ${s===e.status?'selected':''}>${s}</option>`).join('')}
                </select></div>
              <div class="form-row full"><label>Description</label><input id="e-desc" value="${escapeHtml(e.description)}"></div>
              <div class="form-row full"><label>Notes</label><textarea id="e-notes">${escapeHtml(e.notes||'')}</textarea></div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" onclick="document.getElementById('edit-modal').remove()">Cancel</button>
            <button class="btn btn-accent" onclick="adminSubmitEdit(${id})">Save</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.adminSubmitEdit = async function (id) {
    const body = {
      entry_date: document.getElementById('e-date').value,
      hours: parseFloat(document.getElementById('e-hours').value),
      status: document.getElementById('e-status').value,
      description: document.getElementById('e-desc').value,
      notes: document.getElementById('e-notes').value
    };
    try {
      await api('/api/timesheet/' + id, { method: 'PATCH', body });
      document.getElementById('edit-modal').remove();
      loadAllEntries(); loadPending();
    } catch (err) { showAlert('edit-alert', err.message); }
  };

  window.exportEntriesCSV = async function () {
    const params = new URLSearchParams();
    const fields = { from: 'af-from', to: 'af-to', user_id: 'af-user', client_id: 'af-client', matter_id: 'af-matter', status: 'af-status' };
    for (const k in fields) { const v = document.getElementById(fields[k]).value; if (v) params.set(k, v); }
    const r = await api('/api/timesheet?' + params.toString());
    const headers = ['Date','Associate','Client','Matter File No','Matter','Activity','Description','Hours','Billable','Status'];
    const rows = r.entries.map(e => [
      e.entry_date, e.user_name, e.client_name, e.file_no, e.matter_title,
      e.activity_type, e.description, e.hours, e.is_billable ? 'Yes' : 'No', e.status
    ]);
    downloadCSV('timesheet.csv', [headers, ...rows]);
  };

  function downloadCSV(name, rows) {
    const csv = rows.map(r => r.map(c => {
      const s = (c == null ? '' : String(c));
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
  }

  // -------------------- Billing --------------------
  window.previewInvoice = async function () {
    const params = new URLSearchParams({
      client_id: document.getElementById('bi-client').value,
      from: document.getElementById('bi-from').value,
      to: document.getElementById('bi-to').value
    });
    if (!params.get('client_id') || !params.get('from') || !params.get('to')) { alert('Select client, period from & to'); return; }
    try {
      const r = await api('/api/billing/preview?' + params.toString());
      LAST_PREVIEW = r;
      const tax = parseFloat(document.getElementById('bi-tax').value) || 0;
      const taxAmt = r.subtotal * tax / 100;
      document.getElementById('bi-preview').innerHTML = !r.items.length ? '<div class="empty">No billable approved entries in this range.</div>' : `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
          <tbody>${r.items.map(i => `<tr>
            <td>${escapeHtml(i.description)}</td>
            <td class="num">${Number(i.quantity).toFixed(2)} ${i.unit}</td>
            <td class="num">${fmtMoney(i.rate)}</td>
            <td class="num">${fmtMoney(i.amount)}</td>
          </tr>`).join('')}
            <tr><td colspan="3" class="right"><strong>Subtotal</strong></td><td class="num"><strong>${fmtMoney(r.subtotal)}</strong></td></tr>
            <tr><td colspan="3" class="right">Tax (${tax}%)</td><td class="num">${fmtMoney(taxAmt)}</td></tr>
            <tr><td colspan="3" class="right"><strong>Total</strong></td><td class="num"><strong>${fmtMoney(r.subtotal + taxAmt)}</strong></td></tr>
          </tbody>
        </table></div>`;
    } catch (e) { alert(e.message); }
  };

  window.createInvoice = async function () {
    const body = {
      client_id: document.getElementById('bi-client').value,
      period_from: document.getElementById('bi-from').value,
      period_to: document.getElementById('bi-to').value,
      invoice_date: document.getElementById('bi-date').value,
      tax_rate: parseFloat(document.getElementById('bi-tax').value) || 0,
      notes: document.getElementById('bi-notes').value
    };
    if (!body.client_id || !body.period_from || !body.period_to || !body.invoice_date) { alert('All fields required'); return; }
    if (!confirm('Generate invoice and mark these entries as invoiced?')) return;
    try {
      const r = await api('/api/billing/invoices', { method: 'POST', body });
      alert('Invoice ' + r.invoice_no + ' created — total ' + fmtMoney(r.total));
      window.open('/api/billing/invoices/' + r.id + '/pdf?token=' + Auth.token(), '_blank');
      // PDF download via authenticated call:
      downloadInvoicePDF(r.id);
      loadInvoices(); loadAllEntries(); loadDashboard();
      document.getElementById('bi-preview').innerHTML = '';
    } catch (e) { alert(e.message); }
  };

  async function downloadInvoicePDF(id) {
    const res = await fetch('/api/billing/invoices/' + id + '/pdf', {
      headers: { 'Authorization': 'Bearer ' + Auth.token() }
    });
    if (!res.ok) { alert('Failed to fetch PDF'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.click();
  }
  window.downloadInvoicePDF = downloadInvoicePDF;

  window.loadInvoices = async function () {
    const r = await api('/api/billing/invoices');
    const wrap = document.getElementById('invoices-table');
    wrap.innerHTML = !r.invoices.length ? '<div class="empty">No invoices yet.</div>' : `
      <table class="data">
        <thead><tr><th>Invoice #</th><th>Date</th><th>Client</th><th>Period</th><th class="num">Subtotal</th><th class="num">Tax</th><th class="num">Total</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${r.invoices.map(i => `<tr>
          <td><strong>${escapeHtml(i.invoice_no)}</strong></td>
          <td class="nowrap">${i.invoice_date}</td>
          <td>${escapeHtml(i.client_name)}</td>
          <td class="nowrap muted">${i.period_from || ''} → ${i.period_to || ''}</td>
          <td class="num">${fmtMoney(i.subtotal, i.currency)}</td>
          <td class="num">${fmtMoney(i.tax_amount, i.currency)}</td>
          <td class="num"><strong>${fmtMoney(i.total, i.currency)}</strong></td>
          <td><span class="pill ${i.status}">${i.status}</span></td>
          <td class="row-actions">
            <button class="btn btn-sm btn-ghost" onclick="downloadInvoicePDF(${i.id})">PDF</button>
            ${i.status==='issued' ? `<button class="btn btn-sm btn-success" onclick="markPaid(${i.id})">Mark paid</button>` : ''}
            ${i.status!=='cancelled' && i.status!=='paid' ? `<button class="btn btn-sm btn-warning" onclick="cancelInvoice(${i.id})">Cancel</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
  };
  window.markPaid = async function (id) {
    if (!confirm('Mark this invoice as paid?')) return;
    await api('/api/billing/invoices/' + id, { method: 'PATCH', body: { status: 'paid' } });
    loadInvoices();
  };
  window.cancelInvoice = async function (id) {
    if (!confirm('Cancel this invoice? Entries will be released for re-billing.')) return;
    await api('/api/billing/invoices/' + id, { method: 'PATCH', body: { status: 'cancelled' } });
    loadInvoices(); loadAllEntries();
  };

  // -------------------- Reports --------------------
  window.loadReport = async function () {
    const params = new URLSearchParams({
      from: document.getElementById('rp-from').value,
      to:   document.getElementById('rp-to').value,
      group_by: document.getElementById('rp-group').value
    });
    const r = await api('/api/reports/summary?' + params.toString());
    const out = document.getElementById('report-out');
    if (!r.rows.length) { out.innerHTML = '<div class="empty">No data in this range.</div>'; return; }
    const totHrs = r.rows.reduce((s,x)=>s+x.hours,0);
    const totBill = r.rows.reduce((s,x)=>s+x.billable_hours,0);
    out.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi"><h4>Total hours</h4><div class="val">${totHrs.toFixed(2)}</div></div>
        <div class="kpi"><h4>Billable hours</h4><div class="val">${totBill.toFixed(2)}</div></div>
        <div class="kpi"><h4>Entries</h4><div class="val">${r.rows.reduce((s,x)=>s+x.entry_count,0)}</div></div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${labelByGroup(r.group_by)}</th><th class="num">Entries</th><th class="num">Hours</th><th class="num">Billable hours</th></tr></thead>
        <tbody>${r.rows.map(x => `<tr>
          <td>${escapeHtml(x.label || '—')}</td>
          <td class="num">${x.entry_count}</td>
          <td class="num">${Number(x.hours).toFixed(2)}</td>
          <td class="num">${Number(x.billable_hours).toFixed(2)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" onclick='downloadReportCSV(${JSON.stringify(r).replace(/'/g, "&#39;")})'>Export CSV</button></div>`;
  };
  function labelByGroup(g) { return ({ user:'Associate', client:'Client', matter:'Matter', activity:'Activity' })[g] || 'Group'; }
  window.downloadReportCSV = function (r) {
    const headers = [labelByGroup(r.group_by), 'Entries', 'Hours', 'Billable hours'];
    const rows = r.rows.map(x => [x.label, x.entry_count, x.hours, x.billable_hours]);
    downloadCSV('report-' + r.group_by + '-' + r.from + '_' + r.to + '.csv', [headers, ...rows]);
  };

  // -------------------- Masters: Users / Clients / Matters / Rates --------------------
  async function loadUsersTable() {
    const r = await api('/api/users');
    USERS = r.users;
    document.getElementById('users-table').innerHTML = `
      <table class="data">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Designation</th><th class="num">Default rate (₹/hr)</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${USERS.map(u => `<tr>
          <td>${escapeHtml(u.full_name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${u.role}</td>
          <td>${escapeHtml(u.designation || '')}</td>
          <td class="num">${Number(u.default_rate||0).toFixed(2)}</td>
          <td>${u.is_active ? '✓' : '—'}</td>
          <td class="row-actions">
            <button class="btn btn-sm btn-ghost" onclick='editUser(${JSON.stringify(u).replace(/'/g,"&#39;")})'>Edit</button>
            ${u.is_active ? `<button class="btn btn-sm btn-danger" onclick="deactivateUser(${u.id})">Deactivate</button>` : `<button class="btn btn-sm btn-ghost" onclick="reactivateUser(${u.id})">Activate</button>`}
            <button class="btn btn-sm" style="background:#7f1d1d;color:#fff;border:none;" onclick="deleteUser(${u.id},'${escapeHtml(u.full_name)}')">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
  }
  window.newUser = function () { editUser(null); };
  window.editUser = function (u) {
    const isNew = !u;
    const html = `
      <div class="modal-backdrop" id="u-modal"><div class="modal">
        <div class="modal-head"><h3>${isNew ? 'New user' : 'Edit user'}</h3><button class="close" onclick="document.getElementById('u-modal').remove()">×</button></div>
        <div class="modal-body">
          <div id="u-alert" class="alert hidden"></div>
          <div class="form-grid cols-2">
            <div class="form-row"><label>Full name</label><input id="u-name" value="${escapeHtml(u?u.full_name:'')}"></div>
            <div class="form-row"><label>Email</label><input id="u-email" type="email" value="${escapeHtml(u?u.email:'')}" ${u?'disabled':''}></div>
            <div class="form-row"><label>Role</label><select id="u-role">
              <option value="associate" ${u && u.role==='associate'?'selected':''}>Associate</option>
              <option value="admin" ${u && u.role==='admin'?'selected':''}>Admin</option>
            </select></div>
            <div class="form-row"><label>Designation</label><input id="u-desig" value="${escapeHtml(u?(u.designation||''):'')}"></div>
            <div class="form-row"><label>Default rate (₹/hr)</label><input type="number" step="0.01" id="u-rate" value="${u?u.default_rate:0}"></div>
            <div class="form-row"><label>${isNew ? 'Password' : 'New password (leave blank to keep)'}</label><input type="password" id="u-pwd"></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" onclick="document.getElementById('u-modal').remove()">Cancel</button>
          <button class="btn btn-accent" onclick="saveUser(${u?u.id:'null'})">Save</button>
        </div>
      </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveUser = async function (id) {
    const body = {
      full_name: document.getElementById('u-name').value,
      role: document.getElementById('u-role').value,
      designation: document.getElementById('u-desig').value,
      default_rate: parseFloat(document.getElementById('u-rate').value) || 0
    };
    const pwd = document.getElementById('u-pwd').value;
    try {
      if (id) {
        if (pwd) body.password = pwd;
        await api('/api/users/' + id, { method: 'PATCH', body });
      } else {
        body.email = document.getElementById('u-email').value;
        if (!pwd) { showAlert('u-alert', 'Password required'); return; }
        body.password = pwd;
        await api('/api/users', { method: 'POST', body });
      }
      document.getElementById('u-modal').remove();
      loadUsersTable();
    } catch (e) { showAlert('u-alert', e.message); }
  };
  window.deactivateUser = async function (id) {
    if (!confirm('Deactivate this user? They will not be able to log in.')) return;
    await api('/api/users/' + id, { method: 'PATCH', body: { is_active: 0 } });
    loadUsersTable();
  };
  window.reactivateUser = async function (id) {
    if (!confirm('Activate this user?')) return;
    await api('/api/users/' + id, { method: 'PATCH', body: { is_active: 1 } });
    loadUsersTable();
  };
  window.deleteUser = async function (id, name) {
    if (!confirm('PERMANENTLY delete "' + name + '"?\n\nYeh action undo nahi ho sakta!\n\nNote: Agar is user ke timesheet entries hain toh delete nahi hoga.')) return;
    try {
      await api('/api/users/' + id, { method: 'DELETE' });
      showAlert('alert', '"' + name + '" permanently delete ho gaya.', 'success');
      loadUsersTable();
    } catch (e) { alert(e.message); }
  };

  window.deleteClient = async function (id, name) {
    if (!confirm('PERMANENTLY delete client "' + name + '"?\n\nYeh action undo nahi ho sakta!\n\nNote: Agar is client ke matters hain toh delete nahi hoga.')) return;
    try {
      await api('/api/clients/' + id, { method: 'DELETE' });
      showAlert('alert', '"' + name + '" permanently delete ho gaya.', 'success');
      loadClientsTable(); loadMasters();
    } catch (e) { alert(e.message); }
  };

  async function loadClientsTable() {
    const r = await api('/api/clients'); CLIENTS = r.clients;
    document.getElementById('clients-table').innerHTML = `
      <table class="data">
        <thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>GSTIN</th><th class="num">Matters</th><th>Actions</th></tr></thead>
        <tbody>${CLIENTS.map(c => `<tr>
          <td>${escapeHtml(c.code||'')}</td>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${escapeHtml(c.contact_person||'')}</td>
          <td>${escapeHtml(c.email||'')}</td>
          <td>${escapeHtml(c.phone||'')}</td>
          <td>${escapeHtml(c.gstin||'')}</td>
          <td class="num">${c.matter_count||0}</td>
          <td class="row-actions">
            <button class="btn btn-sm btn-ghost" onclick='editClient(${JSON.stringify(c).replace(/'/g,"&#39;")})'>Edit</button>
            <button class="btn btn-sm" style="background:#7f1d1d;color:#fff;border:none;" onclick="deleteClient(${c.id},'${escapeHtml(c.name)}')">Delete</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
  }
  window.newClient = function () { editClient(null); };
  window.editClient = function (c) {
    const isNew = !c;
    const html = `
      <div class="modal-backdrop" id="c-modal"><div class="modal">
        <div class="modal-head"><h3>${isNew?'New client':'Edit client'}</h3><button class="close" onclick="document.getElementById('c-modal').remove()">×</button></div>
        <div class="modal-body">
          <div id="c-alert" class="alert hidden"></div>
          <div class="form-grid cols-2">
            <div class="form-row"><label>Code</label><input id="c-code" value="${escapeHtml(c?(c.code||''):'')}"></div>
            <div class="form-row"><label>Name</label><input id="c-name" value="${escapeHtml(c?c.name:'')}"></div>
            <div class="form-row"><label>Contact person</label><input id="c-contact" value="${escapeHtml(c?(c.contact_person||''):'')}"></div>
            <div class="form-row"><label>Email</label><input id="c-email" value="${escapeHtml(c?(c.email||''):'')}"></div>
            <div class="form-row"><label>Phone</label><input id="c-phone" value="${escapeHtml(c?(c.phone||''):'')}"></div>
            <div class="form-row"><label>GSTIN</label><input id="c-gstin" value="${escapeHtml(c?(c.gstin||''):'')}"></div>
            <div class="form-row full"><label>Address</label><textarea id="c-addr">${escapeHtml(c?(c.address||''):'')}</textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" onclick="document.getElementById('c-modal').remove()">Cancel</button>
          <button class="btn btn-accent" onclick="saveClient(${c?c.id:'null'})">Save</button>
        </div>
      </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveClient = async function (id) {
    const body = {
      code: document.getElementById('c-code').value,
      name: document.getElementById('c-name').value,
      contact_person: document.getElementById('c-contact').value,
      email: document.getElementById('c-email').value,
      phone: document.getElementById('c-phone').value,
      gstin: document.getElementById('c-gstin').value,
      address: document.getElementById('c-addr').value
    };
    try {
      if (id) await api('/api/clients/' + id, { method: 'PATCH', body });
      else    await api('/api/clients',         { method: 'POST',  body });
      document.getElementById('c-modal').remove();
      loadClientsTable(); loadMasters();
    } catch (e) { showAlert('c-alert', e.message); }
  };

  async function loadMattersTable() {
    const r = await api('/api/matters'); MATTERS = r.matters;
    document.getElementById('matters-table').innerHTML = `
      <table class="data">
        <thead><tr><th>File No</th><th>Client</th><th>Title</th><th>Billing</th><th class="num">Rate / Fee</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${MATTERS.map(m => `<tr>
          <td><strong>${escapeHtml(m.file_no)}</strong></td>
          <td>${escapeHtml(m.client_name)}</td>
          <td>${escapeHtml(m.title)}</td>
          <td>${escapeHtml(m.billing_type)}</td>
          <td class="num">${
            m.billing_type==='hourly_matter' ? fmtMoney(m.matter_rate)+'/hr' :
            m.billing_type==='flat'         ? fmtMoney(m.flat_fee) :
            m.billing_type==='retainer'     ? fmtMoney(m.retainer_amount)+' (retainer)' :
            'per associate'
          }</td>
          <td><span class="pill ${m.status}">${m.status}</span></td>
          <td class="row-actions">
            <button class="btn btn-sm btn-ghost" onclick='editMatter(${JSON.stringify(m).replace(/'/g,"&#39;")})'>Edit</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
  }
  window.newMatter = function () { editMatter(null); };
  window.editMatter = function (m) {
    const isNew = !m;
    const html = `
      <div class="modal-backdrop" id="m-modal"><div class="modal">
        <div class="modal-head"><h3>${isNew?'New matter':'Edit matter'}</h3><button class="close" onclick="document.getElementById('m-modal').remove()">×</button></div>
        <div class="modal-body">
          <div id="m-alert" class="alert hidden"></div>
          <div class="form-grid cols-2">
            <div class="form-row"><label>Client</label><select id="m-client">${CLIENTS.map(c => `<option value="${c.id}" ${m && m.client_id===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
            <div class="form-row"><label>File No.</label><input id="m-file" value="${escapeHtml(m?m.file_no:'')}"></div>
            <div class="form-row full"><label>Title</label><input id="m-title" value="${escapeHtml(m?m.title:'')}"></div>
            <div class="form-row full"><label>Description</label><textarea id="m-desc">${escapeHtml(m?(m.description||''):'')}</textarea></div>
            <div class="form-row"><label>Billing type</label>
              <select id="m-btype">
                <option value="hourly_user" ${m && m.billing_type==='hourly_user'?'selected':''}>Hourly — per associate's rate</option>
                <option value="hourly_matter" ${m && m.billing_type==='hourly_matter'?'selected':''}>Hourly — single matter rate</option>
                <option value="flat" ${m && m.billing_type==='flat'?'selected':''}>Flat fee</option>
                <option value="retainer" ${m && m.billing_type==='retainer'?'selected':''}>Retainer (advance)</option>
              </select>
            </div>
            <div class="form-row"><label>Matter hourly rate (₹)</label><input type="number" step="0.01" id="m-rate" value="${m?m.matter_rate:0}"></div>
            <div class="form-row"><label>Flat fee (₹)</label><input type="number" step="0.01" id="m-flat" value="${m?m.flat_fee:0}"></div>
            <div class="form-row"><label>Retainer amount (₹)</label><input type="number" step="0.01" id="m-retainer" value="${m?m.retainer_amount:0}"></div>
            <div class="form-row"><label>Status</label>
              <select id="m-status">
                <option value="open" ${m && m.status==='open'?'selected':''}>Open</option>
                <option value="closed" ${m && m.status==='closed'?'selected':''}>Closed</option>
              </select>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" onclick="document.getElementById('m-modal').remove()">Cancel</button>
          <button class="btn btn-accent" onclick="saveMatter(${m?m.id:'null'})">Save</button>
        </div>
      </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveMatter = async function (id) {
    const body = {
      client_id: parseInt(document.getElementById('m-client').value, 10),
      file_no: document.getElementById('m-file').value,
      title: document.getElementById('m-title').value,
      description: document.getElementById('m-desc').value,
      billing_type: document.getElementById('m-btype').value,
      matter_rate: parseFloat(document.getElementById('m-rate').value) || 0,
      flat_fee: parseFloat(document.getElementById('m-flat').value) || 0,
      retainer_amount: parseFloat(document.getElementById('m-retainer').value) || 0,
      status: document.getElementById('m-status').value
    };
    try {
      if (id) await api('/api/matters/' + id, { method: 'PATCH', body });
      else    await api('/api/matters',         { method: 'POST',  body });
      document.getElementById('m-modal').remove();
      loadMattersTable(); loadMasters();
    } catch (e) { showAlert('m-alert', e.message); }
  };

  async function loadRatesTable() {
    const r = await api('/api/rates');
    document.getElementById('rates-table').innerHTML = !r.rates.length ? '<div class="empty">No rate overrides yet. Without a row here, the associate\'s default rate is used.</div>' : `
      <table class="data">
        <thead><tr><th>Matter</th><th>Associate</th><th class="num">Rate (₹/hr)</th><th>Effective from</th><th>Actions</th></tr></thead>
        <tbody>${r.rates.map(rt => `<tr>
          <td><strong>${escapeHtml(rt.file_no)}</strong> — ${escapeHtml(rt.matter_title)}</td>
          <td>${escapeHtml(rt.full_name)}</td>
          <td class="num">${fmtMoney(rt.hourly_rate)}</td>
          <td>${rt.effective_from}</td>
          <td><button class="btn btn-sm btn-danger" onclick="deleteRate(${rt.id})">Delete</button></td>
        </tr>`).join('')}</tbody></table>`;
  }
  window.newRate = function () {
    const html = `
      <div class="modal-backdrop" id="r-modal"><div class="modal">
        <div class="modal-head"><h3>Add rate override</h3><button class="close" onclick="document.getElementById('r-modal').remove()">×</button></div>
        <div class="modal-body">
          <div id="r-alert" class="alert hidden"></div>
          <div class="form-grid cols-2">
            <div class="form-row"><label>Matter</label><select id="r-matter">${MATTERS.map(m => `<option value="${m.id}">${escapeHtml(m.file_no+' — '+m.title)}</option>`).join('')}</select></div>
            <div class="form-row"><label>Associate</label><select id="r-user">${USERS.filter(u => u.role==='associate' || u.role==='admin').map(u => `<option value="${u.id}">${escapeHtml(u.full_name)}</option>`).join('')}</select></div>
            <div class="form-row"><label>Rate (₹/hr)</label><input type="number" step="0.01" id="r-rate"></div>
            <div class="form-row"><label>Effective from</label><input type="date" id="r-eff" value="${todayISO()}"></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" onclick="document.getElementById('r-modal').remove()">Cancel</button>
          <button class="btn btn-accent" onclick="saveRate()">Save</button>
        </div>
      </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveRate = async function () {
    const body = {
      matter_id: parseInt(document.getElementById('r-matter').value, 10),
      user_id: parseInt(document.getElementById('r-user').value, 10),
      hourly_rate: parseFloat(document.getElementById('r-rate').value) || 0,
      effective_from: document.getElementById('r-eff').value
    };
    try {
      await api('/api/rates', { method: 'POST', body });
      document.getElementById('r-modal').remove();
      loadRatesTable();
    } catch (e) { showAlert('r-alert', e.message); }
  };
  window.deleteRate = async function (id) {
    if (!confirm('Delete this rate override?')) return;
    await api('/api/rates/' + id, { method: 'DELETE' });
    loadRatesTable();
  };

  // -------------------- Tabs --------------------
  function switchTab(id) {
    document.querySelectorAll('main > section.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.topnav button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    document.getElementById(id).classList.add('active');
    if (id === 'tab-dashboard') loadDashboard();
    if (id === 'tab-entries')   loadAllEntries();
    if (id === 'tab-billing')   loadInvoices();
    if (id === 'tab-masters')   { loadUsersTable(); }
  }
  function switchMTab(id) {
    document.querySelectorAll('#tab-masters > .tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('[data-mtab]').forEach(b => b.classList.toggle('active', b.dataset.mtab === id));
    document.getElementById(id).classList.add('active');
    if (id === 'm-users')   loadUsersTable();
    if (id === 'm-clients') loadClientsTable();
    if (id === 'm-matters') loadMattersTable();
    if (id === 'm-rates')   loadRatesTable();
  }

  // boot
  (async () => {
    await loadMasters();
    loadDashboard();
  })();
