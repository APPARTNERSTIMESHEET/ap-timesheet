/**
 * Admin page logic — topbar, dashboard, timesheets, billing, outstanding, reports, masters.
 */
(function () {
  const me = Auth.requireAuth(['admin', 'billing']); if (!me) return;

  // ─── Render topbar with admin tabs (including Outstanding) ───────────
  const topbarEl = document.getElementById('topbar');
  if (topbarEl) {
    // Build initials from full name for the user-avatar circle ("Mohd Amir" → "MA").
    const initials = String(me.full_name || me.email || '?')
      .split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';

    topbarEl.innerHTML = `
      <div class="topbar">
        <div class="brand">
          <img class="brand-logo" src="/img/logo.png" alt="AP & Partners" onerror="this.style.display='none'">
          <div class="brand-text"><strong>AP &amp; Partners</strong><small>Timesheet &amp; Billing</small></div>
        </div>
        <div class="topnav-wrap">
          <div class="topnav">
            <button data-tab="tab-dashboard" class="active">Dashboard</button>
            <button data-tab="tab-entries">Timesheets</button>
            <button data-tab="tab-billing">Billing</button>
            <button data-tab="tab-outstanding">Outstanding</button>
            <button data-tab="tab-reports">Reports</button>
            <button data-tab="tab-leaves">Leaves &amp; WFH</button>
            <button data-tab="tab-masters">Masters</button>
            ${me.role === 'admin' || me.role === 'super_admin' ? '<button data-tab="tab-activity">Activity Log</button>' : ''}
            <button data-tab="tab-superadmin" id="tab-superadmin-btn" class="icon-only" title="Super Admin" style="display:none;">🛡️</button>
          </div>
        </div>
        <div class="userbox">
          <div class="userbox-info">
            <span class="userbox-name">${escapeHtml(me.full_name)}</span>
            <span class="userbox-role">${escapeHtml(me.designation || me.role)}</span>
          </div>
          <div class="userbox-avatar" title="${escapeHtml(me.email || '')}">${initials}</div>
          <button onclick="Auth.logout()">Logout</button>
        </div>
      </div>`;
  }

  // Date display
  const dateEl = document.getElementById('th-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // ─── State ────────────────────────────────────────────────────────────
  let CLIENTS = [], MATTERS = [], USERS = [];
  let LAST_PREVIEW = null;
  let _ENTRY_MAP = {}; // id → entry object, for safe onclick references
  let hoursChart = null, revenueChart = null;
  let calYear, calMonth;
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth(); // 0-indexed

  function setActiveTab(tab) {
    document.querySelectorAll('.topnav button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  }

  // ─── Default dates ───────────────────────────────────────────────────
  setVal('af-from', monthStartISO());
  setVal('af-to',   todayISO());
  setVal('bi-from', monthStartISO());
  setVal('bi-to',   todayISO());
  setVal('bi-date', todayISO());
  // default due date = invoice date + 30 days
  const dueDef = new Date(); dueDef.setDate(dueDef.getDate() + 30);
  setVal('bi-due', dueDef.toISOString().slice(0,10));
  setVal('mi-from', monthStartISO());
  setVal('mi-to',   todayISO());
  setVal('mi-date', todayISO());
  const miDueDef = new Date(); miDueDef.setDate(miDueDef.getDate() + 30);
  setVal('mi-due', miDueDef.toISOString().slice(0,10));
  setVal('rp-from', monthStartISO());
  setVal('rp-to',   todayISO());
  setVal('pr-from', monthStartISO());
  setVal('pr-to',   todayISO());
  // util month = current month
  const ym = now.toISOString().slice(0,7);
  setVal('util-month', ym);

  // ─── Masters loader ──────────────────────────────────────────────────
  async function loadMasters() {
    const [u, c, m] = await Promise.all([
      api('/api/users'),
      api('/api/clients'),
      api('/api/matters')
    ]);
    USERS = u.users; CLIENTS = c.clients; MATTERS = m.matters;
    fillSelect('af-user',   USERS,   'id', x => x.full_name + ' (' + (x.designation||x.role) + ')', true);
    fillSelect('af-client', CLIENTS, 'id', x => x.name, true);
    fillSelect('af-matter', MATTERS, 'id', x => x.file_no + ' — ' + x.title, true);
    fillSelect('bi-client', CLIENTS, 'id', x => x.name, false);
    fillSelect('mi-client', CLIENTS, 'id', x => x.name, false);
    // Auto-set manual invoice currency when client changes
    const miClientEl = document.getElementById('mi-client');
    if (miClientEl) {
      miClientEl.onchange = function() {
        const cid = parseInt(this.value);
        const client = CLIENTS.find(c => c.id === cid);
        if (client && client.default_currency) {
          const curEl = document.getElementById('mi-currency');
          if (curEl) { curEl.value = client.default_currency; onManualCurrencyChange(client.default_currency); }
        }
      };
    }
    // Auto-set currency when client changes
    const biClient = document.getElementById('bi-client');
    if (biClient) {
      biClient.onchange = function() {
        const cid = parseInt(this.value);
        const client = CLIENTS.find(c => c.id === cid);
        if (client && client.default_currency) {
          const curEl = document.getElementById('bi-currency');
          if (curEl) { curEl.value = client.default_currency; onCurrencyChange(client.default_currency); }
        }
      };
    }
    fillSelect('pr-client', CLIENTS, 'id', x => x.name, true);
    // Dept filter
    const depts = [...new Set(USERS.map(u => u.designation||'').filter(Boolean))].sort();
    const df = document.getElementById('dept-filter');
    if (df) {
      df.innerHTML = '<option value="">All Departments</option>' +
        depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    }
  }

  function fillSelect(id, items, valKey, labelFn, withAll) {
    const sel = document.getElementById(id); if (!sel) return;
    sel.innerHTML = (withAll ? '<option value="">All</option>' : '<option value="">— Select —</option>') +
      items.map(it => `<option value="${it[valKey]}">${escapeHtml(labelFn(it))}</option>`).join('');
  }

  // ─── Department filter ───────────────────────────────────────────────
  window.onDeptFilter = function () {
    const dept = document.getElementById('dept-filter').value;
    // filter af-user dropdown
    const sel = document.getElementById('af-user'); if (!sel) return;
    sel.innerHTML = '<option value="">All</option>' +
      USERS.filter(u => !dept || (u.designation||'') === dept)
           .map(u => `<option value="${u.id}">${escapeHtml(u.full_name)}</option>`).join('');
  };

  // ─── DASHBOARD ───────────────────────────────────────────────────────
  async function loadDashboard() {
    const d = await api('/api/admin/dashboard');
    let overdueCount = 0;
    try { const ov = await api('/api/billing/outstanding'); overdueCount = (ov.overdue||[]).length; } catch(e){}

    const util = d.month_hours > 0 ? ((d.month_billable_hours / d.month_hours) * 100) : 0;
    const utilColor = util >= 80 ? '' : util >= 60 ? 'warn' : 'danger';

    document.getElementById('dash-kpis').innerHTML = `
      <div class="kpi2 kpi-warning">
        <div class="kpi2-icon">⏳</div>
        <div class="kpi2-label">Pending Approval</div>
        <div class="kpi2-val">${d.pending}</div>
        <div class="kpi2-sub">entries awaiting review</div>
      </div>
      <div class="kpi2">
        <div class="kpi2-icon">🕐</div>
        <div class="kpi2-label">Hours Today</div>
        <div class="kpi2-val">${Number(d.today_hours).toFixed(1)}</div>
        <div class="kpi2-sub">across all associates</div>
      </div>
      <div class="kpi2 kpi-teal">
        <div class="kpi2-icon">📅</div>
        <div class="kpi2-label">Hours This Month</div>
        <div class="kpi2-val">${Number(d.month_hours).toFixed(0)}</div>
        <div class="kpi2-sub">${Number(d.month_billable_hours).toFixed(0)} billable</div>
        <div class="util-bar" title="${util.toFixed(1)}% billable"><div class="util-bar-fill ${utilColor}" style="width:${Math.min(util,100)}%"></div></div>
      </div>
      <div class="kpi2 kpi-success">
        <div class="kpi2-icon">👥</div>
        <div class="kpi2-label">Active Associates</div>
        <div class="kpi2-val">${d.active_users}</div>
        <div class="kpi2-sub">${d.open_matters} open matters</div>
      </div>
      <div class="kpi2 kpi-accent">
        <div class="kpi2-icon">📄</div>
        <div class="kpi2-label">Invoiced This Month</div>
        <div class="kpi2-val" style="font-size:20px">${fmtMoney(d.invoiced_total_month)}</div>
        <div class="kpi2-sub">${d.open_invoices} open invoice${d.open_invoices===1?'':'s'}</div>
      </div>
      <div class="kpi2 ${overdueCount>0?'kpi-danger':''}">
        <div class="kpi2-icon">⚠️</div>
        <div class="kpi2-label">Overdue Invoices</div>
        <div class="kpi2-val">${overdueCount}</div>
        <div class="kpi2-sub">${overdueCount > 0 ? '<span style="color:var(--danger)">Requires attention</span>' : 'All on time'}</div>
      </div>`;

    // Calendar
    renderMiniCal(calYear, calMonth);
    // Chart
    await loadHoursChart();
    // Pending entries
    await loadPendingEntries();
  }

  // ─── Mini Calendar ───────────────────────────────────────────────────
  async function renderMiniCal(year, month) {
    // Fetch entry dates for this month
    const from = `${year}-${String(month+1).padStart(2,'0')}-01`;
    const lastDay = new Date(year, month+1, 0).getDate();
    const to = `${year}-${String(month+1).padStart(2,'0')}-${lastDay}`;
    let entryDates = new Set();
    try {
      const r = await api('/api/timesheet?from='+from+'&to='+to);
      (r.entries||[]).forEach(e => entryDates.add(e.entry_date ? e.entry_date.slice(0,10) : ''));
    } catch(e){}

    const todayStr = todayISO();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const daysInPrev  = new Date(year, month, 0).getDate();

    let html = `<div class="mini-cal-nav">
      <button onclick="calNav(-1)">‹</button>
      <span>${monthNames[month]} ${year}</span>
      <button onclick="calNav(1)">›</button>
    </div>
    <table><thead><tr>
      <th>Su</th><th>Mo</th><th>Tu</th><th>We</th><th>Th</th><th>Fr</th><th>Sa</th>
    </tr></thead><tbody>`;

    let day = 1, nextDay = 1;
    for (let row = 0; row < 6; row++) {
      html += '<tr>';
      for (let col = 0; col < 7; col++) {
        const cellIdx = row * 7 + col;
        let d, cls = 'cal-day', dateStr = '';
        if (cellIdx < firstDay) {
          d = daysInPrev - (firstDay - cellIdx - 1);
          cls += ' other-month';
        } else if (day <= daysInMonth) {
          d = day++;
          dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          if (dateStr === todayStr) cls += ' today';
          else if (col === 0 || col === 6) cls += ' weekend';
          if (entryDates.has(dateStr)) cls += ' has-entry';
        } else {
          d = nextDay++;
          cls += ' other-month';
        }
        html += `<td><span class="${cls}">${d}</span></td>`;
      }
      html += '</tr>';
      if (day > daysInMonth && row >= 4) break;
    }
    html += '</tbody></table>';
    const el = document.getElementById('mini-cal'); if (el) el.innerHTML = html;
  }

  window.calNav = function(dir) {
    calMonth += dir;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    if (calMonth < 0)  { calMonth = 11; calYear--; }
    renderMiniCal(calYear, calMonth);
  };

  // ─── Hours chart ─────────────────────────────────────────────────────
  async function loadHoursChart() {
    try {
      const from = monthStartISO();
      const to   = todayISO();
      const r = await api('/api/reports/summary?from='+from+'&to='+to+'&group_by=user');
      const labels = r.rows.map(x => x.label || '?');
      const data   = r.rows.map(x => Number(x.hours).toFixed(2));
      const billable = r.rows.map(x => Number(x.billable_hours).toFixed(2));
      const canvas = document.getElementById('chart-hours'); if (!canvas) return;
      if (hoursChart) hoursChart.destroy();
      hoursChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Total hours', data, backgroundColor: 'rgba(28,61,90,.7)', borderRadius: 4 },
            { label: 'Billable hours', data: billable, backgroundColor: 'rgba(200,176,140,.8)', borderRadius: 4 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
          scales: { y: { beginAtZero: true, ticks: { font: { size: 11 } } }, x: { ticks: { font: { size: 10 } } } }
        }
      });
    } catch(e) { console.error('Chart load failed', e); }
  }

  // ─── Pending entries on dashboard ───────────────────────────────────
  async function loadPendingEntries() {
    try {
      const r = await api('/api/timesheet?status=submitted&from=2020-01-01&to='+todayISO());
      const entries = (r.entries||[]).slice(0, 10);
      const wrap = document.getElementById('dash-pending'); if (!wrap) return;
      if (!entries.length) { wrap.innerHTML = '<div class="empty" style="padding:14px;color:var(--muted)">No entries pending approval.</div>'; return; }
      wrap.innerHTML = `<table class="data">
        <thead><tr><th>Date</th><th>Associate</th><th>Client / Matter</th><th>Activity</th><th class="num">Hrs</th><th>Actions</th></tr></thead>
        <tbody>${entries.map(e => `<tr>
          <td>${fmtDate(e.entry_date)}</td>
          <td>${escapeHtml(e.full_name||'')}</td>
          <td>${escapeHtml(e.client_name||'')} <span style="color:var(--muted)">/ ${escapeHtml(e.matter_title||'')}</span></td>
          <td>${escapeHtml(e.activity_type||'')}</td>
          <td class="num">${Number(e.hours).toFixed(2)}</td>
          <td class="row-actions">
            <button class="btn btn-sm btn-success" onclick="quickApprove(${e.id})">✓ Approve</button>
            <button class="btn btn-sm btn-danger" onclick="quickReject(${e.id})">✗ Reject</button>
          </td>
        </tr>`).join('')}</tbody></table>`;
    } catch(e) {}
  }

  window.quickApprove = async function(id) {
    await api('/api/timesheet/'+id, { method:'PATCH', body:{status:'approved'} });
    loadDashboard();
  };
  window.quickReject = async function(id) {
    const note = prompt('Rejection reason (optional):') || '';
    await api('/api/timesheet/'+id, { method:'PATCH', body:{status:'rejected', rejection_note:note} });
    loadDashboard();
  };

  // ─── ALL ENTRIES ─────────────────────────────────────────────────────
  window.loadAllEntries = async function () {
    const params = new URLSearchParams();
    const fields = { from:'af-from', to:'af-to', user_id:'af-user', client_id:'af-client', matter_id:'af-matter', status:'af-status' };
    for (const k in fields) { const v = document.getElementById(fields[k]).value; if (v) params.set(k, v); }
    const r = await api('/api/timesheet?' + params.toString());
    renderEntriesTable('all-entries-table', r.entries, { selectable:true, showApprove:true });
  };

  window.exportEntriesCSV = async function () {
    const params = new URLSearchParams();
    const fields = { from:'af-from', to:'af-to', user_id:'af-user', client_id:'af-client', matter_id:'af-matter', status:'af-status' };
    for (const k in fields) { const v = document.getElementById(fields[k]).value; if (v) params.set(k, v); }
    const r = await api('/api/timesheet?' + params.toString());
    const hdrs = ['Date','Associate','Client','Matter','Activity','Hours','Billable','Status','Description'];
    const rows = r.entries.map(e => [e.entry_date,e.full_name,e.client_name,e.matter_title,e.activity_type,e.hours,e.is_billable?'Yes':'No',e.status,e.description]);
    downloadCSV('timesheet-export.csv', [hdrs,...rows]);
  };

  function renderEntriesTable(targetId, entries, opts = {}) {
    const wrap = document.getElementById(targetId); if (!wrap) return;
    if (!entries.length) { wrap.innerHTML = '<div class="empty" style="padding:16px;color:var(--muted)">No entries match these filters.</div>'; return; }
    const sel = opts.selectable;
    // Store entries by id so onclick can look up safely (avoids JSON/quote issues)
    entries.forEach(e => { _ENTRY_MAP[e.id] = e; });
    wrap.innerHTML = `<table class="data">
      <thead><tr>
        ${sel ? '<th><input type="checkbox" id="chk-all" onchange="toggleAllEntries(this)"></th>' : ''}
        <th>Date</th><th>Associate</th><th>Client / Matter</th><th>Activity</th>
        <th>Narration</th><th class="num">Hrs</th><th>Bill?</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${entries.map(e => `<tr>
        ${sel ? `<td><input type="checkbox" class="entry-chk" value="${e.id}"></td>` : ''}
        <td style="white-space:nowrap">${fmtDate(e.entry_date)}</td>
        <td>${escapeHtml(e.full_name||'')}</td>
        <td><strong>${escapeHtml(e.client_name||'')}</strong><br><small style="color:var(--muted)">${escapeHtml(e.matter_title||'')}</small></td>
        <td><span style="font-size:11px;background:var(--bg-alt);padding:2px 7px;border-radius:4px;">${escapeHtml(e.activity_type||'')}</span></td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(e.description||'')}">${escapeHtml(e.description||'')}</td>
        <td class="num">${Number(e.hours).toFixed(2)}</td>
        <td style="text-align:center">${e.is_billable ? '✓' : '—'}</td>
        <td><span class="pill ${e.status}">${e.status}</span></td>
        <td class="row-actions">
          ${e.status==='submitted' ? `<button class="btn btn-sm btn-success" onclick="approveEntry(${e.id})">✓</button>
            <button class="btn btn-sm btn-danger" onclick="rejectEntry(${e.id})">✗</button>` : ''}
          ${e.status!=='invoiced' ? `<button class="btn btn-sm btn-ghost" onclick="editEntry(${e.id})">Edit</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>`;

    if (sel) {
      const bulk = document.getElementById('bulk-actions');
      if (bulk) bulk.innerHTML = `<button class="btn btn-sm btn-success" onclick="bulkApprove()">✓ Approve selected</button>
        <button class="btn btn-sm btn-danger" onclick="bulkReject()">✗ Reject selected</button>
        <button class="btn btn-sm btn-ghost" onclick="loadAllEntries()">↻ Refresh</button>`;
    }
  }

  window.toggleAllEntries = function(chk) {
    document.querySelectorAll('.entry-chk').forEach(c => c.checked = chk.checked);
  };
  window.bulkApprove = async function() {
    const ids = [...document.querySelectorAll('.entry-chk:checked')].map(c => parseInt(c.value));
    if (!ids.length) { alert('Select at least one entry to approve.'); return; }
    if (!confirm(`Approve ${ids.length} entries?`)) return;
    try {
      // Use the dedicated bulk endpoint — single transaction, no N+1 round-trips,
      // and returns counts so we can show the user what really happened.
      const r = await api('/api/admin/timesheet/bulk-approve', { method:'POST', body:{ ids } });
      const skipped = r.skipped || 0;
      const msg = `✓ Approved: ${r.approved}` + (skipped ? `   (Skipped: ${skipped} — already invoiced/approved)` : '');
      showAlert('alert', msg, 'success');
      loadAllEntries();
    } catch(e) { showAlert('alert', 'Bulk approve failed: ' + e.message); }
  };
  window.bulkReject = async function() {
    const ids = [...document.querySelectorAll('.entry-chk:checked')].map(c => parseInt(c.value));
    if (!ids.length) { alert('Select at least one entry to reject.'); return; }
    const note = prompt(`Reject ${ids.length} entries. Reason (optional):`);
    if (note === null) return;   // user cancelled
    try {
      // No dedicated bulk-reject endpoint — fall back to parallel PATCHes.
      // Rejections need an individual note anyway so this is fine.
      const results = await Promise.allSettled(ids.map(id =>
        api('/api/timesheet/'+id, { method:'PATCH', body:{ status:'rejected', rejection_note:note } })
      ));
      const ok = results.filter(r => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      showAlert('alert', `Rejected: ${ok}` + (fail ? `, Failed: ${fail}` : ''), fail ? 'error' : 'success');
      loadAllEntries();
    } catch(e) { showAlert('alert', 'Bulk reject failed: ' + e.message); }
  };
  window.approveEntry = async function(id) {
    await api('/api/timesheet/'+id, {method:'PATCH', body:{status:'approved'}});
    loadAllEntries();
  };
  window.rejectEntry = async function(id) {
    const note = prompt('Rejection reason (optional):') || '';
    await api('/api/timesheet/'+id, {method:'PATCH', body:{status:'rejected', rejection_note:note}});
    loadAllEntries();
  };
  window.editEntry = function(id) {
    const e = _ENTRY_MAP[id]; if (!e) return;
    const html = `<div class="modal-backdrop" id="ee-modal"><div class="modal">
      <div class="modal-head"><h3>Edit entry</h3><button class="close" onclick="document.getElementById('ee-modal').remove()">×</button></div>
      <div class="modal-body">
        <div id="ee-alert" class="alert hidden"></div>
        <div class="form-grid cols-2">
          <div class="form-row"><label>Date</label><input type="date" id="ee-date" value="${e.entry_date}"></div>
          <div class="form-row"><label>Hours</label><input type="number" step="0.25" id="ee-hrs" value="${e.hours}"></div>
          <div class="form-row full"><label>Description</label><textarea id="ee-desc">${escapeHtml(e.description||'')}</textarea></div>
          <div class="form-row"><label>Activity</label>
            <select id="ee-act">
              ${['drafting','court','research','meeting','call','other','appearing'].map(a => `<option value="${a}" ${e.activity_type===a?'selected':''}>${a.charAt(0).toUpperCase()+a.slice(1)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row"><label>Billable?</label>
            <select id="ee-bill"><option value="1" ${e.is_billable?'selected':''}>Yes</option><option value="0" ${!e.is_billable?'selected':''}>No</option></select>
          </div>
          <div class="form-row"><label>Rate Override (₹/hr)</label>
            <input type="number" step="0.01" min="0" id="ee-rate"
              value="${e.rate_override != null ? e.rate_override : ''}"
              placeholder="Leave blank to use default rate">
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="document.getElementById('ee-modal').remove()">Cancel</button>
        <button class="btn btn-accent" onclick="saveEntry(${e.id})">Save</button>
      </div>
    </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveEntry = async function(id) {
    const rateVal = document.getElementById('ee-rate').value;
    const body = {
      entry_date: document.getElementById('ee-date').value,
      hours: parseFloat(document.getElementById('ee-hrs').value),
      description: document.getElementById('ee-desc').value,
      activity_type: document.getElementById('ee-act').value,
      is_billable: parseInt(document.getElementById('ee-bill').value),
      rate_override: rateVal !== '' ? parseFloat(rateVal) : ''
    };
    try {
      await api('/api/timesheet/'+id, {method:'PATCH', body});
      document.getElementById('ee-modal').remove();
      loadAllEntries();
    } catch(e) { showAlert('ee-alert', e.message); }
  };

  function downloadCSV(name, rows) {
    const csv = rows.map(r => r.map(v => '"' + String(v==null?'':v).replace(/"/g,'""') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  // ─── BILLING ─────────────────────────────────────────────────────────
  window.onCurrencyChange = function(val) {
    const sym = { INR:'₹', USD:'$', EUR:'€', GBP:'£', SGD:'S$', AED:'AED' }[val] || val;
    document.querySelectorAll('.cur-sym').forEach(el => el.textContent = sym);

    const isINR   = val === 'INR';
    const fxRow      = document.getElementById('bi-fx-row');
    const fxLbl      = document.getElementById('bi-fx-label');
    const taxInp     = document.getElementById('bi-tax');
    const taxHint    = document.getElementById('bi-tax-hint');
    const fxInp      = document.getElementById('bi-fx-rate');
    const taxTypeRow = document.getElementById('bi-tax-type-row');

    if (isINR) {
      fxRow.style.display = 'none';
      taxInp.value        = 18;
      if (taxHint) taxHint.textContent = '(GST)';
      if (taxTypeRow) taxTypeRow.style.display = '';
    } else {
      fxRow.style.display = '';
      if (fxLbl) fxLbl.textContent = '(1 ' + val + ' = ? INR)';
      taxInp.value = 0;
      if (taxHint) taxHint.textContent = '(Export of services — 0% GST)';
      if (taxTypeRow) taxTypeRow.style.display = 'none';
      const hints = { USD:'84.50', EUR:'91.00', GBP:'107.00', SGD:'63.00', AED:'23.00' };
      if (fxInp && !fxInp.value) fxInp.placeholder = hints[val] || 'e.g. 84.50';
    }
  };

  // ── EDITABLE PREVIEW ─────────────────────────────────────────────────
  // Holds the live, user-edited line items for Generate Invoice. Issue / Save
  // Draft read from here and send to the backend so the server doesn't have
  // to re-derive from timesheets (and the user's edits don't get lost).
  let BI_EDIT_ITEMS = [];
  let BI_EDIT_ROW_SEQ = 0;

  function biEdRowId() { return 'bi-ed-' + (++BI_EDIT_ROW_SEQ); }

  function biEdRowHTML(it) {
    const rid = biEdRowId();
    // Detect a row that's already marked as no-charge (description carries the
    // "[NO CHARGE]" prefix from a previous save) so the checkbox stays in sync.
    const noChargePrefix = '[NO CHARGE] ';
    const isNoCharge = (it.description || '').startsWith(noChargePrefix);
    const cleanDesc  = isNoCharge ? (it.description || '').slice(noChargePrefix.length) : (it.description || '');
    return `<tr id="${rid}" data-row-id="${rid}" data-matter-id="${it.matter_id || ''}" data-user-id="${it.user_id || ''}" data-source-ids='${JSON.stringify(it.source_entry_ids || [])}' style="${isNoCharge ? 'opacity:.55;' : ''}">
      <td style="text-align:center;width:30px;">
        <input type="checkbox" class="bi-ed-nocharge" title="Mark this line as No Charge — rate forced to 0" ${isNoCharge ? 'checked' : ''} onchange="biEdToggleNoCharge('${rid}', this.checked)">
      </td>
      <td><input type="text" class="bi-ed-desc" value="${escapeHtml(cleanDesc)}" placeholder="Description"></td>
      <td><input type="number" step="0.01" min="0" class="bi-ed-qty" value="${Number(it.quantity || 0).toFixed(2)}"></td>
      <td><input type="text" class="bi-ed-unit" value="${escapeHtml(it.unit || 'hr')}" style="width:60px;"></td>
      <td><input type="number" step="0.01" min="0" class="bi-ed-rate" value="${Number(it.rate || 0).toFixed(2)}" ${isNoCharge ? 'disabled' : ''}></td>
      <td><input type="number" step="0.01" min="0" class="bi-ed-amount" value="${Number(it.amount || 0).toFixed(2)}" ${isNoCharge ? 'disabled' : ''}></td>
      <td style="text-align:center;"><button type="button" class="btn btn-sm btn-ghost" title="Delete row" onclick="biEdDeleteRow('${rid}')">🗑</button></td>
    </tr>`;
  }

  // Toggle no-charge state for a single editable preview row. When checked the
  // rate + amount inputs are zeroed AND disabled, and the row's text dims so
  // the admin can still see what's been excluded; the *original* rate is
  // stashed on the row so unchecking restores it.
  window.biEdToggleNoCharge = function(rid, checked) {
    const tr = document.getElementById(rid); if (!tr) return;
    const rateInp = tr.querySelector('.bi-ed-rate');
    const amtInp  = tr.querySelector('.bi-ed-amount');
    if (checked) {
      // Save current rate so we can restore on uncheck.
      tr.dataset.savedRate = rateInp.value;
      rateInp.value = '0.00'; rateInp.disabled = true;
      amtInp.value  = '0.00'; amtInp.disabled  = true;
      tr.style.opacity = '.55';
    } else {
      const saved = tr.dataset.savedRate;
      if (saved != null) rateInp.value = saved;
      rateInp.disabled = false; amtInp.disabled = false;
      tr.style.opacity = '';
      biEdRecalcRow(tr);
    }
    biEdRecalcTotals();
  };

  function biEdRecalcRow(tr) {
    const qty  = parseFloat(tr.querySelector('.bi-ed-qty').value)  || 0;
    const rate = parseFloat(tr.querySelector('.bi-ed-rate').value) || 0;
    tr.querySelector('.bi-ed-amount').value = (qty * rate).toFixed(2);
  }

  function biEdRecalcTotals() {
    const tbody = document.getElementById('bi-ed-body'); if (!tbody) return;
    let sub = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      sub += parseFloat(tr.querySelector('.bi-ed-amount').value) || 0;
    });
    const taxRate = parseFloat(document.getElementById('bi-tax').value) || 0;
    const cur     = document.getElementById('bi-currency').value || 'INR';
    // Discount: either flat ₹ or percent of pre-discount subtotal. Clamp to
    // [0, sub] so we never produce a negative payable.
    const dType = document.getElementById('bi-disc-type')?.value || 'flat';
    const dInput = Math.max(0, parseFloat(document.getElementById('bi-disc-amt')?.value) || 0);
    const discAmt = dType === 'percent' ? sub * dInput / 100 : Math.min(dInput, sub);
    const netSub  = Math.max(0, sub - discAmt);
    const effectiveTax = (cur === 'INR') ? taxRate : 0;
    const taxAmt = netSub * (effectiveTax / 100);

    setText('bi-ed-sub',  fmtMoney(sub,    cur));
    setText('bi-ed-disc', fmtMoney(discAmt, cur));
    setText('bi-ed-net',  fmtMoney(netSub, cur));
    setText('bi-ed-tax',  fmtMoney(taxAmt, cur));
    setText('bi-ed-tot',  fmtMoney(netSub, cur));    // reverse-charge: total = net subtotal

    // Show/hide the discount + net-subtotal rows depending on whether a
    // discount is actually applied.
    const discRow = document.getElementById('bi-ed-disc-row');
    const netRow  = document.getElementById('bi-ed-net-row');
    if (discRow) discRow.style.display = discAmt > 0 ? '' : 'none';
    if (netRow)  netRow.style.display  = discAmt > 0 ? '' : 'none';

    const taxLabelEl = document.getElementById('bi-ed-tax-label');
    if (taxLabelEl) {
      taxLabelEl.textContent = (cur === 'INR')
        ? `GST @ ${taxRate}% (Reverse Charge — payable by client)`
        : `Tax (export of services — 0%)`;
    }
  }

  window.biEdDeleteRow = function(rid) {
    const tr = document.getElementById(rid); if (tr) tr.remove();
    biEdRecalcTotals();
  };

  window.biEdAddRow = function() {
    const tbody = document.getElementById('bi-ed-body'); if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', biEdRowHTML({ description: '', quantity: 1, unit: 'lot', rate: 0, amount: 0 }));
    wireBiEdInputs(); biEdRecalcTotals();
  };

  function wireBiEdInputs() {
    document.querySelectorAll('#bi-ed-body tr').forEach(tr => {
      ['.bi-ed-qty', '.bi-ed-rate'].forEach(sel => {
        const el = tr.querySelector(sel);
        if (el && !el.dataset.wired) {
          el.dataset.wired = '1';
          el.addEventListener('input', () => { biEdRecalcRow(tr); biEdRecalcTotals(); });
        }
      });
      const amt = tr.querySelector('.bi-ed-amount');
      if (amt && !amt.dataset.wired) {
        amt.dataset.wired = '1';
        amt.addEventListener('input', biEdRecalcTotals);
      }
    });
  }

  // Read the currently-edited items back out of the DOM in the shape the
  // backend's createInvoice() expects.
  function biEdCollectItems() {
    const out = [];
    document.querySelectorAll('#bi-ed-body tr').forEach(tr => {
      let desc = tr.querySelector('.bi-ed-desc').value.trim();
      if (!desc) return;       // skip empty rows
      // No-charge marker is round-tripped via a description prefix so the saved
      // invoice row also signals it on the PDF (line still shown to the client
      // but at ₹0 — useful for "we did this work but aren't billing it" cases).
      const noCharge = !!tr.querySelector('.bi-ed-nocharge')?.checked;
      if (noCharge && !desc.startsWith('[NO CHARGE] ')) desc = '[NO CHARGE] ' + desc;
      let sourceIds = [];
      try { sourceIds = JSON.parse(tr.dataset.sourceIds || '[]'); } catch(_) {}
      out.push({
        matter_id:        tr.dataset.matterId ? parseInt(tr.dataset.matterId, 10) : null,
        user_id:          tr.dataset.userId   ? parseInt(tr.dataset.userId,   10) : null,
        description:      desc,
        quantity:         parseFloat(tr.querySelector('.bi-ed-qty').value)  || 0,
        unit:             tr.querySelector('.bi-ed-unit').value.trim() || 'hr',
        rate:             noCharge ? 0 : (parseFloat(tr.querySelector('.bi-ed-rate').value) || 0),
        amount:           noCharge ? 0 : (parseFloat(tr.querySelector('.bi-ed-amount').value) || 0),
        source_entry_ids: sourceIds
      });
    });
    return out;
  }

  window.previewInvoice = async function () {
    const cid = document.getElementById('bi-client').value;
    if (!cid) { alert('Select a client first.'); return; }
    const params = new URLSearchParams({ client_id:cid, from:document.getElementById('bi-from').value, to:document.getElementById('bi-to').value });
    const data = await api('/api/billing/preview?' + params.toString());
    LAST_PREVIEW = data;
    const prev = document.getElementById('bi-preview'); if (!prev) return;
    if (!data.items || !data.items.length) {
      prev.innerHTML = '<div class="empty" style="padding:12px;color:var(--muted)">No approved billable entries in this period.</div>'; return;
    }
    BI_EDIT_ITEMS = data.items.slice();
    BI_EDIT_ROW_SEQ = 0;
    const cur = document.getElementById('bi-currency').value || 'INR';
    prev.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;">Editable preview — change anything, then Issue / Save</strong>
        <button type="button" class="btn btn-sm btn-accent" onclick="biEdAddRow()">+ Add line</button>
      </div>
      <div class="table-wrap" style="overflow-x:auto;">
        <table class="data" style="width:100%;">
          <thead><tr>
            <th style="width:32px;" title="Mark line as No Charge">N/C</th>
            <th style="min-width:280px;">Description</th>
            <th style="width:90px;">Qty</th>
            <th style="width:70px;">Unit</th>
            <th style="width:110px;">Rate</th>
            <th style="width:120px;">Amount</th>
            <th style="width:40px;"></th>
          </tr></thead>
          <tbody id="bi-ed-body">
            ${data.items.map(it => biEdRowHTML(it)).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px;">
        <table style="font-size:13px;min-width:340px;border-collapse:collapse;">
          <tr><td style="padding:4px 14px 4px 0;color:var(--muted);">Gross Value of Services</td>
              <td style="text-align:right;font-weight:600;" id="bi-ed-sub">${fmtMoney(0, cur)}</td></tr>
          <tr id="bi-ed-disc-row" style="display:none;">
              <td style="padding:4px 14px 4px 0;color:#ef4444;">Less: Discount</td>
              <td style="text-align:right;color:#ef4444;" id="bi-ed-disc">${fmtMoney(0, cur)}</td></tr>
          <tr id="bi-ed-net-row" style="display:none;">
              <td style="padding:4px 14px 4px 0;color:var(--muted);font-weight:600;">Net Value (before tax)</td>
              <td style="text-align:right;font-weight:600;" id="bi-ed-net">${fmtMoney(0, cur)}</td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:var(--muted);font-size:11px;" id="bi-ed-tax-label">GST (Reverse Charge — payable by client)</td>
              <td style="text-align:right;color:var(--muted);font-size:11px;" id="bi-ed-tax">${fmtMoney(0, cur)}</td></tr>
          <tr><td style="padding:8px 14px 4px 0;font-weight:700;border-top:1px solid var(--border-strong);">Total Payable to Firm</td>
              <td style="text-align:right;font-weight:700;border-top:1px solid var(--border-strong);" id="bi-ed-tot">${fmtMoney(0, cur)}</td></tr>
        </table>
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:10px;">
        📋 ${data.items.length} line items pre-populated from approved entries.
        Edit qty / rate / description, add custom lines, or delete unwanted rows.
        Rows you delete won't be marked as invoiced — they'll stay available for the next billing cycle.
      </p>`;

    wireBiEdInputs();
    biEdRecalcTotals();

    // Recalc when user changes tax rate or currency
    document.getElementById('bi-tax').addEventListener('input', biEdRecalcTotals);
    document.getElementById('bi-currency').addEventListener('change', biEdRecalcTotals);

    const draftBtn = document.getElementById('bi-draft-btn');
    if (draftBtn) draftBtn.style.display = '';
    const saveDraftBtn = document.getElementById('bi-save-draft-btn');
    if (saveDraftBtn) saveDraftBtn.style.display = '';
  };

  window.downloadDraftExcel = function () {
    if (!LAST_PREVIEW || !LAST_PREVIEW.items || !LAST_PREVIEW.items.length) {
      alert('Run "Preview line items" first.'); return;
    }
    if (typeof XLSX === 'undefined') { alert('SheetJS not loaded yet. Try again in a moment.'); return; }
    const client = CLIENTS.find(c => c.id === parseInt(document.getElementById('bi-client').value));
    const clientName = client ? client.name : 'Client';
    const periodFrom = document.getElementById('bi-from').value;
    const periodTo   = document.getElementById('bi-to').value;

    // Header rows (for partner review)
    const rows = [
      ['DRAFT INVOICE — FOR PARTNER REVIEW ONLY', '', '', '', '', ''],
      ['AP & Partners, Advocates', '', '', '', '', ''],
      ['', '', '', '', '', ''],
      [`Client: ${clientName}`, '', `Period: ${periodFrom} to ${periodTo}`, '', `Date: ${new Date().toISOString().slice(0,10)}`, ''],
      ['', '', '', '', '', ''],
      ['S.No', 'Matter / Description', 'Associate', 'Hours', 'Rate (INR)', 'Amount (INR)'],
    ];

    LAST_PREVIEW.items.forEach((it, i) => {
      rows.push([
        i + 1,
        it.description || it.matter_title || '',
        it.user_name || '',
        Number(it.quantity || 0),
        Number(it.rate || 0),
        Number(it.amount || 0)
      ]);
    });

    rows.push(['', '', '', '', '', '']);
    rows.push(['', '', '', '', 'SUBTOTAL', Number(LAST_PREVIEW.subtotal || 0)]);
    rows.push(['', '', '', '', '', '']);
    rows.push(['NOTES:', '', '', '', '', '']);
    rows.push(['', '', '', '', '', '']);
    rows.push(['Partner Comments:', '', '', '', '', '']);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Column widths
    ws['!cols'] = [{wch:6},{wch:45},{wch:22},{wch:10},{wch:14},{wch:14}];
    // Bold headers
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Draft Invoice');
    const fname = `Draft_Invoice_${clientName.replace(/\s+/g,'_')}_${periodFrom}.xlsx`;
    XLSX.writeFile(wb, fname);
  };

  window.createInvoice = async function () {
    const cid = document.getElementById('bi-client').value;
    if (!cid) { alert('Select a client first.'); return; }
    const currency = document.getElementById('bi-currency').value;
    const fxInp    = document.getElementById('bi-fx-rate');
    const fxRate   = parseFloat(fxInp && fxInp.value) || 0;
    if (currency !== 'INR' && (!fxRate || fxRate <= 0)) {
      alert('Please enter the exchange rate (e.g. 1 ' + currency + ' = 84.50 INR) to generate a foreign currency invoice.');
      if (fxInp) fxInp.focus();
      return;
    }
    // If the editable preview is open, use the user-edited items instead of
    // letting the backend re-derive from timesheets.
    const editedItems = document.getElementById('bi-ed-body') ? biEdCollectItems() : null;
    if (editedItems && !editedItems.length) {
      alert('Preview has no line items — add at least one row or run Preview again.');
      return;
    }
    if (!confirm('Generate invoice?')) return;
    try {
      const taxTypeEl = document.getElementById('bi-tax-type');
      const taxTypeVal = taxTypeEl ? taxTypeEl.value : 'auto';
      const out = await api('/api/billing/invoices', { method:'POST', body:{
        client_id: parseInt(cid),
        invoice_date: document.getElementById('bi-date').value,
        due_date: document.getElementById('bi-due').value,
        period_from: document.getElementById('bi-from').value,
        period_to: document.getElementById('bi-to').value,
        tax_rate: parseFloat(document.getElementById('bi-tax').value) || 0,
        currency: currency,
        fx_rate: fxRate || 1,
        tax_type: taxTypeVal === 'auto' ? null : taxTypeVal,
        firm_entity: document.getElementById('bi-firm-entity')?.value || 'delhi',
        notes: document.getElementById('bi-notes').value,
        invoice_no: (document.getElementById('bi-inv-no')?.value || '').trim() || null,
        items: editedItems || null,
        discount_amount: parseFloat(document.getElementById('bi-disc-amt')?.value) || 0,
        discount_type:   document.getElementById('bi-disc-type')?.value || 'flat',
        discount_note:   (document.getElementById('bi-disc-note')?.value || '').trim() || null
      }});
      showAlert('alert', 'Invoice ' + out.invoice_no + ' created. Total: ' + fmtMoney(out.total), 'success');
      switchTab('tab-billing');
      switchSubTab('stab-invoices');
      loadInvoices();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.saveInvoiceDraft = async function () {
    const cid = document.getElementById('bi-client').value;
    if (!cid) { alert('Select a client first.'); return; }
    if (!LAST_PREVIEW || !LAST_PREVIEW.items || !LAST_PREVIEW.items.length) {
      alert('Run "Preview line items" first.'); return;
    }
    const currency = document.getElementById('bi-currency').value;
    const fxInp    = document.getElementById('bi-fx-rate');
    const fxRate   = parseFloat(fxInp && fxInp.value) || 0;
    if (currency !== 'INR' && (!fxRate || fxRate <= 0)) {
      alert('Please enter the exchange rate (e.g. 1 ' + currency + ' = 84.50 INR).');
      if (fxInp) fxInp.focus(); return;
    }
    // Use the user-edited items (from the editable preview) if available.
    const editedItems = document.getElementById('bi-ed-body') ? biEdCollectItems() : null;
    if (editedItems && !editedItems.length) {
      alert('Preview has no line items — add at least one row or run Preview again.');
      return;
    }
    if (!confirm('Save as draft? The invoice will not be issued yet — you can edit and issue it later.')) return;
    try {
      const taxTypeEl = document.getElementById('bi-tax-type');
      const taxTypeVal = taxTypeEl ? taxTypeEl.value : 'auto';
      const out = await api('/api/billing/invoices', { method:'POST', body:{
        client_id: parseInt(cid),
        invoice_date: document.getElementById('bi-date').value,
        due_date: document.getElementById('bi-due').value,
        period_from: document.getElementById('bi-from').value,
        period_to: document.getElementById('bi-to').value,
        tax_rate: parseFloat(document.getElementById('bi-tax').value) || 0,
        currency: currency,
        fx_rate: fxRate || 1,
        tax_type: taxTypeVal === 'auto' ? null : taxTypeVal,
        firm_entity: document.getElementById('bi-firm-entity')?.value || 'delhi',
        notes: document.getElementById('bi-notes').value,
        invoice_no: (document.getElementById('bi-inv-no')?.value || '').trim() || null,
        items: editedItems || null,
        discount_amount: parseFloat(document.getElementById('bi-disc-amt')?.value) || 0,
        discount_type:   document.getElementById('bi-disc-type')?.value || 'flat',
        discount_note:   (document.getElementById('bi-disc-note')?.value || '').trim() || null,
        save_as_draft: true
      }});
      showAlert('alert', '💾 Draft ' + out.invoice_no + ' saved. Open All Invoices to edit and issue it.', 'success');
      switchSubTab('stab-invoices');
      loadInvoices();
    } catch(e) { showAlert('alert', e.message); }
  };

  // ─── MANUAL INVOICE ──────────────────────────────────────────────────
  let miRowCount = 0;

  window.onManualCurrencyChange = function(val) {
    const isINR = val === 'INR';
    const fxRow      = document.getElementById('mi-fx-row');
    const fxLbl      = document.getElementById('mi-fx-label');
    const taxInp     = document.getElementById('mi-tax');
    const taxHint    = document.getElementById('mi-tax-hint');
    const fxInp      = document.getElementById('mi-fx-rate');
    const taxTypeRow = document.getElementById('mi-tax-type-row');
    if (isINR) {
      fxRow.style.display = 'none';
      taxInp.value = 18;
      if (taxHint) taxHint.textContent = '(GST)';
      if (taxTypeRow) taxTypeRow.style.display = '';
    } else {
      fxRow.style.display = '';
      if (fxLbl) fxLbl.textContent = '(1 ' + val + ' = ? INR)';
      taxInp.value = 0;
      if (taxHint) taxHint.textContent = '(Export of services — 0% GST)';
      if (taxTypeRow) taxTypeRow.style.display = 'none';
      const hints = { USD:'84.50', EUR:'91.00', GBP:'107.00', SGD:'63.00', AED:'23.00' };
      if (fxInp && !fxInp.value) fxInp.placeholder = hints[val] || 'e.g. 84.50';
    }
    miRecalc();
  };

  window.miAddRow = function(desc, hsn, qty, unit, rate) {
    const id = ++miRowCount;
    const tbody = document.getElementById('mi-items-body'); if (!tbody) return;
    const tr = document.createElement('tr');
    tr.id = 'mi-row-' + id;
    tr.innerHTML = `
      <td><input class="form-control" style="width:100%;" id="mi-desc-${id}" placeholder="Description of service" value="${escapeHtml(desc||'')}" oninput="miRecalc()"></td>
      <td><input class="form-control" style="width:80px;text-align:center;" id="mi-hsn-${id}" value="${escapeHtml(hsn||'9982')}" placeholder="9982"></td>
      <td><input class="form-control" style="width:70px;text-align:right;" id="mi-qty-${id}" type="number" step="0.01" value="${qty||1}" oninput="miRecalcRow(${id})"></td>
      <td><select class="form-control" id="mi-unit-${id}" style="padding:5px 6px;">
        <option value="hr" ${unit==='hr'?'selected':''}>hr</option>
        <option value="lot" ${(!unit||unit==='lot')?'selected':''}>lot</option>
        <option value="month" ${unit==='month'?'selected':''}>month</option>
        <option value="pcs" ${unit==='pcs'?'selected':''}>pcs</option>
      </select></td>
      <td><input class="form-control" style="width:100px;text-align:right;" id="mi-rate-${id}" type="number" step="0.01" value="${rate||''}" placeholder="0.00" oninput="miRecalcRow(${id})"></td>
      <td style="text-align:right;font-weight:600;padding:0 8px;" id="mi-amt-${id}">0.00</td>
      <td style="text-align:center;"><button class="btn btn-sm btn-danger" onclick="miRemoveRow(${id})" style="padding:3px 8px;">×</button></td>`;
    tbody.appendChild(tr);
    miRecalcRow(id);
  };

  window.miRemoveRow = function(id) {
    const tr = document.getElementById('mi-row-' + id);
    if (tr) { tr.remove(); miRecalc(); }
  };

  window.miRecalcRow = function(id) {
    const qty  = parseFloat(document.getElementById('mi-qty-' + id)?.value) || 0;
    const rate = parseFloat(document.getElementById('mi-rate-' + id)?.value) || 0;
    const amt  = Math.round(qty * rate * 100) / 100;
    const amtEl = document.getElementById('mi-amt-' + id);
    if (amtEl) amtEl.textContent = fmtMoney(amt, document.getElementById('mi-currency')?.value || 'INR').replace(/[₹$€£]/,'').trim();
    miRecalc();
  };

  window.miRecalc = function() {
    const cur = document.getElementById('mi-currency')?.value || 'INR';
    const taxRate = parseFloat(document.getElementById('mi-tax')?.value) || 0;
    let subtotal = 0;
    document.querySelectorAll('[id^="mi-amt-"]').forEach(el => {
      subtotal += parseFloat(el.textContent.replace(/[^0-9.]/g,'')) || 0;
    });
    subtotal = Math.round(subtotal * 100) / 100;
    const taxAmt = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    // Reverse charge: total = service fee only. GST shown for information — NOT collected by firm.
    const total = subtotal;
    const fmt = n => n.toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 });
    const sub = document.getElementById('mi-subtotal'); if (sub) sub.textContent = fmt(subtotal);
    const tax = document.getElementById('mi-tax-amt'); if (tax) tax.textContent = fmt(taxAmt);
    const tot = document.getElementById('mi-total');   if (tot) tot.textContent = fmt(total);
    const taxLbl = document.getElementById('mi-tax-label');
    if (taxLbl) taxLbl.textContent = `GST ${taxRate}% (Reverse Charge — payable by client)`;
    const taxRow = document.getElementById('mi-tax-row');
    if (taxRow) taxRow.style.display = taxRate > 0 ? '' : 'none';
  };

  window.createManualInvoice = async function() {
    const cid = document.getElementById('mi-client').value;
    if (!cid) { showAlert('mi-alert', 'Please select a client.'); return; }
    const currency = document.getElementById('mi-currency').value;
    const fxInp    = document.getElementById('mi-fx-rate');
    const fxRate   = parseFloat(fxInp?.value) || 0;
    if (currency !== 'INR' && (!fxRate || fxRate <= 0)) {
      showAlert('mi-alert', 'Please enter the exchange rate for ' + currency + ' invoices.'); return;
    }

    // Gather line items
    const rows = document.querySelectorAll('#mi-items-body tr');
    if (!rows.length) { showAlert('mi-alert', 'Add at least one line item.'); return; }
    const items = [];
    for (const tr of rows) {
      const id = tr.id.replace('mi-row-','');
      const qty  = parseFloat(document.getElementById('mi-qty-' + id)?.value) || 0;
      const rate = parseFloat(document.getElementById('mi-rate-' + id)?.value) || 0;
      const desc = document.getElementById('mi-desc-' + id)?.value || '';
      if (!desc.trim()) { showAlert('mi-alert', 'Please fill in the description for all line items.'); return; }
      items.push({
        description: desc,
        hsn_code:    document.getElementById('mi-hsn-' + id)?.value || '9982',
        quantity:    qty,
        unit:        document.getElementById('mi-unit-' + id)?.value || 'lot',
        rate:        rate,
        amount:      Math.round(qty * rate * 100) / 100
      });
    }
    if (!confirm('Generate manual invoice with ' + items.length + ' line item(s)?')) return;
    try {
      const taxTypeEl = document.getElementById('mi-tax-type');
      const taxTypeVal = taxTypeEl ? taxTypeEl.value : 'auto';
      const customInvNo = (document.getElementById('mi-inv-no')?.value || '').trim();
      const out = await api('/api/billing/invoices/manual', { method:'POST', body:{
        client_id:    parseInt(cid),
        invoice_date: document.getElementById('mi-date').value,
        due_date:     document.getElementById('mi-due').value,
        period_from:  document.getElementById('mi-from').value,
        period_to:    document.getElementById('mi-to').value,
        invoice_no:   customInvNo || undefined,
        state_name:   (document.getElementById('mi-state')?.value || '').trim() || undefined,
        state_code:   (document.getElementById('mi-statecode')?.value || '').trim() || undefined,
        currency,
        fx_rate: fxRate || 1,
        tax_rate: parseFloat(document.getElementById('mi-tax').value) || 0,
        tax_type: taxTypeVal === 'auto' ? null : taxTypeVal,
        firm_entity: document.getElementById('mi-firm-entity')?.value || 'delhi',
        notes:    document.getElementById('mi-notes').value,
        items
      }});
      showAlert('mi-alert', 'Invoice ' + out.invoice_no + ' created! Total: ' + fmtMoney(out.total, currency), 'success');
      // Clear rows
      document.getElementById('mi-items-body').innerHTML = '';
      miRowCount = 0; miRecalc();
      // Switch to all invoices
      setTimeout(() => { switchSubTab('stab-invoices'); loadInvoices(); }, 1200);
    } catch(e) { showAlert('mi-alert', e.message); }
  };

  // ─── REVIEW STAGE HELPERS ──────────────────────────────────────────────────
  // Human-readable label + emoji for each review_stage value (matches the
  // dropdown options in admin.html so the UI stays consistent).
  window.reviewStageLabel = function(stage) {
    return ({
      drafting:          '🟡 Drafting',
      sent_for_review:   '📤 Sent for Review',
      revisions_pending: '✏ Revisions Pending',
      ready_to_issue:    '✅ Ready to Issue'
    })[stage] || stage;
  };

  // Quick prompt-based stage changer. Light-weight on purpose — power users
  // who want assignee + free-form notes can use the full draft editor.
  window.showReviewStageMenu = async function(invoiceId, currentStage) {
    const stages = [
      { v: 'drafting',          n: '1. 🟡 Drafting (still preparing)' },
      { v: 'sent_for_review',   n: '2. 📤 Sent for Review (printed & handed over)' },
      { v: 'revisions_pending', n: '3. ✏ Revisions Pending (reviewer marked changes)' },
      { v: 'ready_to_issue',    n: '4. ✅ Ready to Issue (reviewer approved)' }
    ];
    const menu = stages.map(s => s.n).join('\n');
    const pick = prompt(
      `Select review stage (current: ${currentStage || 'none'}):\n\n${menu}\n\nType 1, 2, 3 or 4:`
    );
    if (!pick) return;
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= stages.length) {
      alert('Invalid choice — must be 1, 2, 3 or 4'); return;
    }
    const stage = stages[idx].v;
    const note = prompt('Optional note about this change (e.g. "RKM has the printed copy"):') || '';
    try {
      await api('/api/billing/invoices/' + invoiceId + '/review-stage', {
        method: 'POST',
        body: { stage, note }
      });
      loadInvoices();
    } catch (e) { alert('Failed to update review stage: ' + e.message); }
  };

  // Pre-populate mi-client when masters load (handled in loadMasters patch below)
  window.loadInvoices = async function () {
    const status      = document.getElementById('inv-filter-status').value;
    const reviewStage = (document.getElementById('inv-filter-review') || {}).value || '';
    const qs = new URLSearchParams();
    if (status)      qs.set('status', status);
    if (reviewStage) qs.set('review_stage', reviewStage);
    const params = qs.toString() ? ('?' + qs.toString()) : '';
    const r = await api('/api/billing/invoices'+params);
    const invs = r.invoices || [];
    const wrap = document.getElementById('invoices-table'); if (!wrap) return;
    if (!invs.length) { wrap.innerHTML = '<div class="empty" style="padding:16px;color:var(--muted)">No invoices found.</div>'; return; }
    const today = todayISO();
    wrap.innerHTML = `<table class="data">
      <thead><tr>
        <th>Invoice No</th><th>Client</th><th>Date</th><th>Due Date</th>
        <th class="num">Subtotal</th><th class="num">Tax</th><th class="num">Total</th>
        <th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${invs.map(i => {
        const isOverdue = i.status==='issued' && i.due_date && i.due_date < today;
        const displayStatus = isOverdue ? 'overdue' : i.status;
        return `<tr>
          <td><strong>${escapeHtml(i.invoice_no)}</strong></td>
          <td>${escapeHtml(i.client_name)}</td>
          <td>${fmtDate(i.invoice_date)}</td>
          <td>${i.due_date ? `<span class="${isOverdue?'due-badge':''}">` + fmtDate(i.due_date) + (isOverdue?' ⚠':'') + '</span>' : '<span style="color:var(--muted)">—</span>'}</td>
          <td class="num">${fmtMoney(i.subtotal, i.currency)}</td>
          <td class="num">${fmtMoney(i.tax_amount, i.currency)}</td>
          <td class="num"><strong>${fmtMoney(i.total, i.currency)}</strong></td>
          <td><span class="pill ${displayStatus}">${displayStatus}</span>
            ${i.status === 'draft' && i.review_stage ? `<div class="review-badge review-${i.review_stage}" title="Review stage">${reviewStageLabel(i.review_stage)}</div>` : ''}
            ${i.status === 'draft' && i.review_assignee_name ? `<div class="payment-ref">👤 ${escapeHtml(i.review_assignee_name)}</div>` : ''}
            ${i.payment_ref ? `<div class="payment-ref">Ref: ${escapeHtml(i.payment_ref)}</div>` : ''}
            ${i.paid_at ? `<div class="payment-ref">Paid: ${fmtDate(i.paid_at)}</div>` : ''}
          </td>
          <td class="row-actions">
            ${i.status === 'draft'
              ? `<button class="btn btn-sm btn-ghost" onclick="editDraftInvoice(${i.id})">✏ Edit</button>
                 <button class="btn btn-sm btn-ghost" onclick="downloadInvoicePDF(${i.id})">👁 Preview</button>
                 <button class="btn btn-sm btn-ghost" onclick="showReviewStageMenu(${i.id}, '${i.review_stage||''}')" title="Change review stage">🏷 Stage</button>
                 <button class="btn btn-sm btn-accent" onclick="issueDraftFromList(${i.id})">✅ Issue</button>
                 <button class="btn btn-sm btn-warning" onclick="cancelInvoice(${i.id})">Cancel</button>`
              : `<button class="btn btn-sm btn-ghost" onclick="downloadInvoicePDF(${i.id})">PDF</button>
                 <button class="btn btn-sm btn-ghost" onclick="exportLEDES(${i.id}, '${escapeHtml(i.invoice_no)}')" title="Export in LEDES format for corporate e-billing platforms (Tymetrix, LegalTracker, etc.)">📤 LEDES</button>
                 <button class="btn btn-sm btn-ghost" onclick="emailInvoice(${i.id},'${escapeHtml(i.client_name)}')">📧 Email</button>
                 ${(i.status==='issued'||isOverdue) ? `<button class="btn btn-sm btn-success" onclick="markPaid(${i.id})">✓ Paid</button>` : ''}
                 ${i.status==='issued' ? `<button class="btn btn-sm btn-ghost" onclick="reviseInvoice(${i.id}, '${escapeHtml(i.invoice_no)}')" title="Cancel this invoice and start a new draft with the same items">🔁 Revise</button>` : ''}
                 ${i.status!=='cancelled'&&i.status!=='paid' ? `<button class="btn btn-sm btn-warning" onclick="cancelInvoice(${i.id})">Cancel</button>` : ''}`
            }
          </td>
        </tr>`;
      }).join('')}</tbody></table>`;
  };

  window.downloadInvoicePDF = function(id) {
    const token = Auth.token();
    window.open('/api/billing/invoices/'+id+'/pdf?token='+encodeURIComponent(token), '_blank');
  };

  // ─── LEDES Export ─────────────────────────────────────────────────────────
  // Shows a modal asking for the LEDES format, then downloads the file. The
  // format choice depends on what the client's e-billing platform accepts —
  // most accept 1998BI (international, includes currency). XML 2.1 is preferred
  // by modern platforms (Tymetrix 360, LegalTracker).
  window.exportLEDES = function(invoiceId, invoiceNo) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
    // Override .btn defaults by using a custom class with !important + plain divs.
    // Earlier version used <button class="btn"> which inherited the app's dark
    // navy background, making text invisible. Now we use clickable <div>s with
    // explicit white backgrounds and dark text for guaranteed readability.
    modal.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:24px;max-width:560px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.2);">
        <h3 style="margin:0 0 10px;font-family:Georgia,serif;color:#1E2761;font-size:20px;">📤 Export LEDES — ${escapeHtml(invoiceNo)}</h3>
        <p style="font-size:13px;color:#64748b;margin:0 0 18px;line-height:1.5;">
          Choose the LEDES format that matches your client's e-billing platform requirements.
        </p>
        <div style="display:flex;flex-direction:column;gap:10px;">

          <div class="ledes-fmt-card" data-fmt="1998BI" style="cursor:pointer;padding:14px 16px;border:2px solid #C9A961;background:#FEF9E7 !important;border-radius:8px;transition:all 0.15s;">
            <div style="font-weight:700;color:#1E2761 !important;font-size:15px;">
              LEDES 1998BI
              <span style="display:inline-block;font-size:10px;background:#16A34A;color:#FFFFFF;padding:2px 8px;border-radius:10px;margin-left:8px;font-weight:700;letter-spacing:0.5px;">RECOMMENDED</span>
            </div>
            <div style="font-size:12px;color:#64748B !important;margin-top:6px;line-height:1.5;">
              International format with currency support. Most widely accepted by corporate e-billing platforms (~80% coverage).
            </div>
          </div>

          <div class="ledes-fmt-card" data-fmt="XML-2.1" style="cursor:pointer;padding:14px 16px;border:1px solid #E2E8F0;background:#FFFFFF !important;border-radius:8px;transition:all 0.15s;">
            <div style="font-weight:700;color:#1E2761 !important;font-size:15px;">LEDES XML 2.1</div>
            <div style="font-size:12px;color:#64748B !important;margin-top:6px;line-height:1.5;">
              Modern XML format with structured data. Preferred by Tymetrix 360, LegalTracker, and Brightflag.
            </div>
          </div>

          <div class="ledes-fmt-card" data-fmt="1998B" style="cursor:pointer;padding:14px 16px;border:1px solid #E2E8F0;background:#FFFFFF !important;border-radius:8px;transition:all 0.15s;">
            <div style="font-weight:700;color:#1E2761 !important;font-size:15px;">LEDES 1998B</div>
            <div style="font-size:12px;color:#64748B !important;margin-top:6px;line-height:1.5;">
              Original US-only format. Use only if client specifically requests this version.
            </div>
          </div>

        </div>
        <div style="text-align:right;margin-top:18px;">
          <button id="ledes-cancel" style="padding:8px 18px;background:#F1F5F9;color:#1E2761;border:1px solid #CBD5E1;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    // Hover effect via JS (since we don't have CSS file editing here)
    modal.querySelectorAll('.ledes-fmt-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        card.style.borderColor = '#C9A961';
        card.style.transform = 'translateY(-1px)';
        card.style.boxShadow = '0 2px 8px rgba(201,169,97,0.2)';
      });
      card.addEventListener('mouseleave', () => {
        if (card.dataset.fmt !== '1998BI') card.style.borderColor = '#E2E8F0';
        card.style.transform = 'none';
        card.style.boxShadow = 'none';
      });
    });

    const close = () => modal.remove();
    modal.querySelector('#ledes-cancel').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    modal.querySelectorAll('.ledes-fmt-card').forEach(card => {
      card.onclick = () => {
        const fmt = card.dataset.fmt;
        const token = Auth.token();
        const url = `/api/billing/invoices/${invoiceId}/export-ledes?format=${encodeURIComponent(fmt)}&token=${encodeURIComponent(token)}`;
        window.open(url, '_blank');
        close();
        showAlert('alert', `LEDES ${fmt} exported — check your downloads folder.`, 'success');
      };
    });
  };

  window.markPaid = async function(id) {
    const ref = prompt('Payment reference (UTR / cheque no. / transaction ID):') || '';
    if (!confirm('Mark this invoice as paid?')) return;
    await api('/api/billing/invoices/'+id, { method:'PATCH', body:{ status:'paid', payment_ref:ref } });
    loadInvoices();
    // refresh outstanding if visible
    if (document.getElementById('tab-outstanding').classList.contains('active')) loadOutstanding();
  };

  window.cancelInvoice = async function(id) {
    if (!confirm('Cancel this invoice? Entries will be released for re-billing.')) return;
    await api('/api/billing/invoices/'+id, { method:'PATCH', body:{ status:'cancelled' } });
    loadInvoices(); loadAllEntries();
  };

  // ─── Revise an issued invoice ─────────────────────────────────────────────
  // One-click: cancel current invoice + create a new draft with all the same
  // items + open editor so billing can correct + re-issue.
  window.reviseInvoice = async function(id, invoiceNo) {
    const ok = confirm(
      `Revise invoice ${invoiceNo}?\n\n` +
      `This will:\n` +
      `• Cancel ${invoiceNo} (preserved in records for audit)\n` +
      `• Create a new DRAFT invoice with the same items\n` +
      `• Open the editor so you can correct it\n\n` +
      `Use this when an issued invoice has an error that wasn't sent to the client yet.\n` +
      `If the client already has it, use a Credit Note instead (coming soon).`
    );
    if (!ok) return;
    try {
      const r = await api('/api/billing/invoices/'+id+'/revise', { method:'POST' });
      showAlert('alert', `✓ ${r.original.invoice_no} cancelled. New draft ${r.draft.invoice_no} created — opening editor.`, 'success');
      loadInvoices();
      // Auto-open the new draft for editing
      setTimeout(() => editDraftInvoice(r.draft.id), 600);
    } catch(e) {
      showAlert('alert', 'Revise failed: ' + e.message);
    }
  };

  // ─── DRAFT INVOICE EDITOR ─────────────────────────────────────────────────
  let DRAFT_EDIT_ID = null;
  let DRAFT_EDIT_TAX_RATE = 0;
  let edRowCount = 0;

  window.editDraftInvoice = async function(id) {
    DRAFT_EDIT_ID = id;
    edRowCount = 0;
    try {
      const r = await api('/api/billing/invoices/' + id);
      const inv = r.invoice; const items = r.items || [];
      DRAFT_EDIT_TAX_RATE = Number(inv.tax_rate || 0);

      document.getElementById('ed-inv-no-display').textContent = inv.invoice_no;
      document.getElementById('ed-inv-no').value = inv.invoice_no || '';
      document.getElementById('ed-inv-no').dataset.original = inv.invoice_no || '';
      document.getElementById('ed-date').value = inv.invoice_date || '';
      document.getElementById('ed-due').value  = inv.due_date  || '';
      document.getElementById('ed-notes').value = inv.notes || '';
      document.getElementById('ed-items-body').innerHTML = '';
      document.getElementById('ed-alert').className = 'alert hidden';

      // Review workflow fields
      const stageEl    = document.getElementById('ed-review-stage');
      const assigneeEl = document.getElementById('ed-review-assignee');
      const noteEl     = document.getElementById('ed-review-notes');
      if (stageEl)    stageEl.value    = inv.review_stage || '';
      if (noteEl)     noteEl.value     = inv.review_notes || '';

      // Populate assignee dropdown from cached users list
      if (assigneeEl) {
        try {
          const u = await api('/api/users');
          assigneeEl.innerHTML = '<option value="">— Anyone —</option>' +
            (u.users || []).filter(x => x.is_active !== 0).map(x =>
              `<option value="${x.id}" ${inv.review_assignee==x.id?'selected':''}>${escapeHtml(x.full_name)}${x.designation?' · '+escapeHtml(x.designation):''}</option>`
            ).join('');
        } catch(e) { /* if users API fails, leave blank */ }
      }

      // Load review history (audit trail)
      try {
        const h = await api('/api/billing/invoices/' + id + '/review-history');
        const hist = (h.history || []).slice(0, 6);
        const histEl = document.getElementById('ed-review-history');
        if (histEl) {
          histEl.innerHTML = hist.length
            ? '<strong>Recent activity:</strong> ' + hist.map(x =>
                `<div>• ${fmtDate(x.at)} ${x.at.slice(11,16)} — <em>${escapeHtml(x.action)}</em>` +
                (x.user_name?` by ${escapeHtml(x.user_name)}`:'') +
                (x.detail?` <span style="color:#666;">(${escapeHtml(x.detail)})</span>`:'') + '</div>'
              ).join('')
            : '<em>No review activity yet.</em>';
        }
      } catch(e) { /* non-blocking */ }

      for (const it of items) {
        edAddRow(it.description, it.quantity, it.unit, it.rate, it.amount, it.matter_id, it.user_id);
      }
      if (!items.length) edAddRow();
      edRecalc();
      document.getElementById('edit-draft-overlay').style.display = '';
    } catch(e) { alert('Could not load draft: ' + e.message); }
  };

  window.closeDraftEditor = function() {
    document.getElementById('edit-draft-overlay').style.display = 'none';
    DRAFT_EDIT_ID = null;
  };

  window.edAddRow = function(desc, qty, unit, rate, amt, matterId, userId) {
    const id = ++edRowCount;
    const tbody = document.getElementById('ed-items-body');
    const tr = document.createElement('tr');
    tr.id = 'ed-row-' + id;
    // Persist matter_id / user_id on the row so edGatherItems can round-trip
    // them back to the backend. Earlier we dropped these on save, leaving the
    // line items orphaned (matter_id=user_id=NULL) and breaking annexure-rate
    // lookup + per-matter reporting.
    tr.dataset.matterId = matterId != null ? matterId : '';
    tr.dataset.userId   = userId   != null ? userId   : '';
    tr.innerHTML = `
      <td><input class="form-control" style="width:100%;" id="ed-desc-${id}"
          value="${escapeHtml(desc||'')}" placeholder="Description of service" oninput="edRecalc()"></td>
      <td><input class="form-control" style="width:72px;text-align:right;" id="ed-qty-${id}"
          type="number" step="0.01" value="${qty!=null?qty:1}" oninput="edRecalcRow(${id})"></td>
      <td><select class="form-control" id="ed-unit-${id}" style="padding:5px 6px;">
        <option value="hr" ${unit==='hr'?'selected':''}>hr</option>
        <option value="lot" ${(!unit||unit==='lot')?'selected':''}>lot</option>
        <option value="month" ${unit==='month'?'selected':''}>month</option>
        <option value="pcs" ${unit==='pcs'?'selected':''}>pcs</option>
      </select></td>
      <td><input class="form-control" style="width:100px;text-align:right;" id="ed-rate-${id}"
          type="number" step="0.01" value="${rate!=null?rate:''}" placeholder="0.00" oninput="edRecalcRow(${id})"></td>
      <td style="text-align:right;font-weight:600;padding:0 8px;" id="ed-amt-${id}">${Number(amt||0).toFixed(2)}</td>
      <td style="text-align:center;"><button class="btn btn-sm btn-danger" onclick="edRemoveRow(${id})"
          style="padding:3px 8px;">×</button></td>`;
    tbody.appendChild(tr);
    if (amt != null && amt > 0) { document.getElementById('ed-amt-'+id).textContent = Number(amt).toFixed(2); }
    edRecalc();
  };

  window.edRemoveRow = function(id) {
    const tr = document.getElementById('ed-row-'+id); if (tr) { tr.remove(); edRecalc(); }
  };

  window.edRecalcRow = function(id) {
    const qty  = parseFloat(document.getElementById('ed-qty-'+id)?.value)  || 0;
    const rate = parseFloat(document.getElementById('ed-rate-'+id)?.value) || 0;
    const amt  = Math.round(qty * rate * 100) / 100;
    const amtEl = document.getElementById('ed-amt-'+id);
    if (amtEl) amtEl.textContent = amt.toFixed(2);
    edRecalc();
  };

  window.edRecalc = function() {
    let subtotal = 0;
    document.querySelectorAll('[id^="ed-amt-"]').forEach(el => {
      subtotal += parseFloat(el.textContent) || 0;
    });
    subtotal = Math.round(subtotal * 100) / 100;
    const taxAmt = Math.round(subtotal * (DRAFT_EDIT_TAX_RATE / 100) * 100) / 100;
    const total  = subtotal; // reverse charge
    const fmt = n => n.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
    const subEl = document.getElementById('ed-subtotal'); if (subEl) subEl.textContent = fmt(subtotal);
    const taxEl = document.getElementById('ed-tax-amt');  if (taxEl) taxEl.textContent = fmt(taxAmt);
    const totEl = document.getElementById('ed-total');    if (totEl) totEl.textContent = fmt(total);
    const taxLbl = document.getElementById('ed-tax-label');
    if (taxLbl) taxLbl.textContent = `GST ${DRAFT_EDIT_TAX_RATE}% (Reverse Charge — payable by client)`;
    const taxRow = document.getElementById('ed-tax-row');
    if (taxRow) taxRow.style.display = DRAFT_EDIT_TAX_RATE > 0 ? '' : 'none';
  };

  function edGatherItems() {
    const rows = document.querySelectorAll('#ed-items-body tr');
    const items = [];
    for (const tr of rows) {
      const id = tr.id.replace('ed-row-','');
      const qty  = parseFloat(document.getElementById('ed-qty-'+id)?.value)  || 0;
      const rate = parseFloat(document.getElementById('ed-rate-'+id)?.value) || 0;
      const desc = document.getElementById('ed-desc-'+id)?.value || '';
      if (!desc.trim()) return null; // validation fail
      items.push({
        description: desc,
        // Preserve matter / user metadata so the line item stays linked to the
        // original source for annexure rate lookup and per-matter reports.
        matter_id:   tr.dataset.matterId ? parseInt(tr.dataset.matterId, 10) : null,
        user_id:     tr.dataset.userId   ? parseInt(tr.dataset.userId,   10) : null,
        quantity:    qty,
        unit:        document.getElementById('ed-unit-'+id)?.value || 'lot',
        rate:        rate,
        amount:      Math.round(qty * rate * 100) / 100
      });
    }
    return items;
  }

  window.saveDraftEdits = async function() {
    if (!DRAFT_EDIT_ID) return;
    const items = edGatherItems();
    if (!items) { showAlert('ed-alert', 'Please fill in a description for all line items.'); return; }
    if (!items.length) { showAlert('ed-alert', 'Add at least one line item.'); return; }
    try {
      // 1. Save the line items + invoice header fields
      await api('/api/billing/invoices/'+DRAFT_EDIT_ID+'/items', { method:'PUT', body:{
        invoice_date: document.getElementById('ed-date').value,
        due_date:     document.getElementById('ed-due').value,
        notes:        document.getElementById('ed-notes').value,
        items
      }});
      // 2. Save the review workflow fields + any invoice_no change (PATCH /:id).
      //    Backend enforces draft-only for invoice_no change; we send it unconditionally
      //    if the user touched the field — server silently ignores unchanged values.
      const stageEl = document.getElementById('ed-review-stage');
      const invNoEl = document.getElementById('ed-inv-no');
      const invNoChanged = invNoEl && invNoEl.value.trim() !== (invNoEl.dataset.original || '');
      if (stageEl || invNoChanged) {
        const patch = {};
        if (stageEl) {
          patch.review_stage    = stageEl.value || null;
          patch.review_notes    = document.getElementById('ed-review-notes').value || null;
          patch.review_assignee = document.getElementById('ed-review-assignee').value || null;
        }
        if (invNoChanged) patch.invoice_no = invNoEl.value.trim();
        await api('/api/billing/invoices/'+DRAFT_EDIT_ID, { method:'PATCH', body: patch });
        if (invNoChanged) {
          invNoEl.dataset.original = invNoEl.value.trim();
          document.getElementById('ed-inv-no-display').textContent = invNoEl.value.trim();
        }
      }
      showAlert('ed-alert', '💾 Draft saved successfully.', 'success');
      loadInvoices();
    } catch(e) { showAlert('ed-alert', e.message); }
  };

  window.issueDraftInvoice = async function() {
    if (!DRAFT_EDIT_ID) return;
    // Save edits first
    const items = edGatherItems();
    if (!items) { showAlert('ed-alert', 'Please fill in a description for all line items.'); return; }
    if (!items.length) { showAlert('ed-alert', 'Add at least one line item.'); return; }
    if (!confirm('Issue this invoice? It will be locked and timesheet entries will be marked as invoiced.')) return;
    try {
      // Save latest edits then issue
      await api('/api/billing/invoices/'+DRAFT_EDIT_ID+'/items', { method:'PUT', body:{
        invoice_date: document.getElementById('ed-date').value,
        due_date:     document.getElementById('ed-due').value,
        notes:        document.getElementById('ed-notes').value,
        items
      }});
      // Persist any invoice_no change before locking the invoice.
      const invNoEl = document.getElementById('ed-inv-no');
      if (invNoEl && invNoEl.value.trim() !== (invNoEl.dataset.original || '')) {
        await api('/api/billing/invoices/'+DRAFT_EDIT_ID, { method:'PATCH', body:{ invoice_no: invNoEl.value.trim() } });
      }
      await api('/api/billing/invoices/'+DRAFT_EDIT_ID+'/issue', { method:'POST' });
      closeDraftEditor();
      showAlert('alert', '✅ Invoice issued successfully!', 'success');
      loadInvoices();
      if (document.getElementById('tab-outstanding').classList.contains('active')) loadOutstanding();
    } catch(e) { showAlert('ed-alert', e.message); }
  };

  window.issueDraftFromList = async function(id) {
    if (!confirm('Issue draft invoice? It will be locked and entries will be marked as invoiced.')) return;
    try {
      await api('/api/billing/invoices/'+id+'/issue', { method:'POST' });
      showAlert('alert', '✅ Invoice issued!', 'success');
      loadInvoices();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.emailInvoice = async function(id, clientName) {
    const recipientEl = prompt(`Send invoice PDF to email for ${clientName}:\n(Enter recipient email address)`, '');
    if (!recipientEl) return;
    try {
      await api('/api/billing/invoices/'+id+'/email', { method:'POST', body:{ to: recipientEl } });
      showAlert('alert', 'Invoice emailed to ' + recipientEl, 'success');
    } catch(e) { showAlert('alert', e.message); }
  };

  // ─── OUTSTANDING ─────────────────────────────────────────────────────
  async function loadOutstanding() {
    try {
      const r = await api('/api/billing/outstanding');
      // Summary cards
      const sumEl = document.getElementById('ost-summary'); if (!sumEl) return;
      sumEl.innerHTML = `
        <div class="outstanding-card">
          <h5>Total Outstanding</h5>
          <div class="oc-val">${fmtMoney(r.total_outstanding)}</div>
          <div class="oc-sub">${r.issued_count} open invoice${r.issued_count===1?'':'s'}</div>
        </div>
        <div class="outstanding-card" style="border-color:var(--danger)">
          <h5>Overdue Amount</h5>
          <div class="oc-val" style="color:var(--danger)">${fmtMoney(r.overdue_amount)}</div>
          <div class="oc-sub">${(r.overdue||[]).length} overdue invoice${(r.overdue||[]).length===1?'':'s'}</div>
        </div>
        <div class="outstanding-card" style="border-color:var(--success)">
          <h5>Collected This Month</h5>
          <div class="oc-val" style="color:var(--success)">${fmtMoney(r.paid_this_month)}</div>
          <div class="oc-sub">from ${r.paid_count_month||0} invoice${(r.paid_count_month||0)===1?'':'s'}</div>
        </div>
        <div class="outstanding-card">
          <h5>Total Billed (YTD)</h5>
          <div class="oc-val">${fmtMoney(r.total_billed_ytd)}</div>
          <div class="oc-sub">year to date</div>
        </div>`;

      // Client-wise table
      const ostEl = document.getElementById('ost-table');
      if (ostEl && r.by_client) {
        if (!r.by_client.length) { ostEl.innerHTML = '<div class="empty" style="padding:14px">No outstanding invoices.</div>'; }
        else ostEl.innerHTML = `<table class="data">
          <thead><tr><th>Client</th><th class="num">Open Invoices</th><th class="num">Amount Due</th><th class="num">Oldest Due</th></tr></thead>
          <tbody>${r.by_client.map(c => `<tr>
            <td><strong>${escapeHtml(c.client_name)}</strong></td>
            <td class="num">${c.count}</td>
            <td class="num"><strong>${fmtMoney(c.total)}</strong></td>
            <td class="num" style="${c.oldest_due && c.oldest_due < todayISO() ? 'color:var(--danger);font-weight:600' : ''}">${c.oldest_due ? fmtDate(c.oldest_due) : '—'}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td><strong>Total</strong></td><td class="num">${r.issued_count}</td><td class="num"><strong>${fmtMoney(r.total_outstanding)}</strong></td><td></td></tr></tfoot>
        </table>`;
      }

      // Overdue table
      const ovEl = document.getElementById('overdue-table');
      if (ovEl) {
        if (!r.overdue || !r.overdue.length) { ovEl.innerHTML = '<div class="empty" style="padding:14px;color:var(--success)">✓ No overdue invoices.</div>'; }
        else ovEl.innerHTML = `<table class="data">
          <thead><tr><th>Invoice</th><th>Client</th><th>Invoice Date</th><th>Due Date</th><th class="num">Amount</th><th>Days Overdue</th><th>Actions</th></tr></thead>
          <tbody>${r.overdue.map(i => {
            const days = Math.floor((new Date() - new Date(i.due_date)) / 86400000);
            return `<tr>
              <td><strong>${escapeHtml(i.invoice_no)}</strong></td>
              <td>${escapeHtml(i.client_name)}</td>
              <td>${fmtDate(i.invoice_date)}</td>
              <td style="color:var(--danger);font-weight:600">${fmtDate(i.due_date)}</td>
              <td class="num"><strong>${fmtMoney(i.total, i.currency)}</strong></td>
              <td><span style="color:var(--danger);font-weight:700">${days} day${days===1?'':'s'}</span></td>
              <td class="row-actions">
                <button class="btn btn-sm btn-ghost" onclick="downloadInvoicePDF(${i.id})">PDF</button>
                <button class="btn btn-sm btn-success" onclick="markPaid(${i.id})">✓ Paid</button>
                <button class="btn btn-sm btn-ghost" onclick="emailInvoice(${i.id},'${escapeHtml(i.client_name)}')">📧</button>
              </td>
            </tr>`;
          }).join('')}</tbody></table>`;
      }

      // Revenue chart
      await loadRevenueChart(r.monthly_revenue||[]);
    } catch(e) { console.error('loadOutstanding', e); }
  }

  window.exportOutstandingCSV = async function() {
    const r = await api('/api/billing/outstanding');
    const hdrs = ['Client','Open Invoices','Amount Due','Oldest Due'];
    const rows = (r.by_client||[]).map(c => [c.client_name, c.count, c.total, c.oldest_due||'']);
    downloadCSV('outstanding.csv', [hdrs,...rows]);
  };

  async function loadRevenueChart(monthly) {
    const canvas = document.getElementById('chart-revenue'); if (!canvas) return;
    if (revenueChart) revenueChart.destroy();
    const labels = monthly.map(m => m.month);
    const billed = monthly.map(m => Number(m.total_billed||0));
    const collected = monthly.map(m => Number(m.total_paid||0));
    revenueChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Billed', data: billed, backgroundColor: 'rgba(28,61,90,.65)', borderRadius: 4 },
          { label: 'Collected', data: collected, backgroundColor: 'rgba(22,163,74,.65)', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, font:{ size:11 } } } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => '₹'+Number(v).toLocaleString('en-IN'), font:{size:10} } },
          x: { ticks: { font:{size:10} } }
        }
      }
    });
  }

  // ─── REPORTS ─────────────────────────────────────────────────────────
  window.loadReport = async function () {
    const params = new URLSearchParams({
      from: document.getElementById('rp-from').value,
      to:   document.getElementById('rp-to').value,
      group_by: document.getElementById('rp-group').value
    });
    const r = await api('/api/reports/summary?' + params.toString());
    const out = document.getElementById('report-out'); if (!out) return;
    if (!r.rows.length) { out.innerHTML = '<div class="empty" style="padding:12px;color:var(--muted)">No data in this range.</div>'; return; }
    const totHrs  = r.rows.reduce((s,x)=>s+x.hours,0);
    const totBill = r.rows.reduce((s,x)=>s+x.billable_hours,0);
    out.innerHTML = `
      <div class="kpi-grid-2" style="margin-bottom:16px">
        <div class="kpi2"><div class="kpi2-label">Total hours</div><div class="kpi2-val">${totHrs.toFixed(2)}</div></div>
        <div class="kpi2 kpi-teal"><div class="kpi2-label">Billable hours</div><div class="kpi2-val">${totBill.toFixed(2)}</div></div>
        <div class="kpi2"><div class="kpi2-label">Utilization</div><div class="kpi2-val">${totHrs>0?(totBill/totHrs*100).toFixed(1)+'%':'—'}</div></div>
        <div class="kpi2"><div class="kpi2-label">Entries</div><div class="kpi2-val">${r.rows.reduce((s,x)=>s+x.entry_count,0)}</div></div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>${labelByGroup(r.group_by)}</th><th class="num">Entries</th><th class="num">Hours</th><th class="num">Billable</th><th class="num">Util %</th></tr></thead>
        <tbody>${r.rows.map(x => {
          const u = x.hours > 0 ? (x.billable_hours/x.hours*100).toFixed(1) : '0.0';
          return `<tr>
            <td>${escapeHtml(x.label||'—')}</td>
            <td class="num">${x.entry_count}</td>
            <td class="num">${Number(x.hours).toFixed(2)}</td>
            <td class="num">${Number(x.billable_hours).toFixed(2)}</td>
            <td class="num">${u}%</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick='downloadReportCSV(${JSON.stringify(r).replace(/'/g,"&#39;")})'>Export CSV</button></div>`;
  };

  function labelByGroup(g) { return ({ user:'Associate', client:'Client', matter:'Matter', activity:'Activity' })[g]||'Group'; }
  window.downloadReportCSV = function(r) {
    const hdrs = [labelByGroup(r.group_by),'Entries','Hours','Billable hours'];
    const rows = r.rows.map(x => [x.label, x.entry_count, x.hours, x.billable_hours]);
    downloadCSV('report-'+r.group_by+'.csv', [hdrs,...rows]);
  };

  // ─── UTILIZATION REPORT ──────────────────────────────────────────────
  window.loadUtilization = async function () {
    const ym = document.getElementById('util-month').value;
    if (!ym) return;
    const targetHrs = parseFloat(document.getElementById('util-target').value)||8;
    const [yr, mo] = ym.split('-').map(Number);
    // count working days in month (Mon-Fri)
    let workDays = 0;
    const days = new Date(yr, mo, 0).getDate();
    for (let d=1; d<=days; d++) { const wd = new Date(yr,mo-1,d).getDay(); if(wd>=1&&wd<=5) workDays++; }
    const target = workDays * targetHrs;

    const from = `${ym}-01`;
    const to = `${ym}-${String(days).padStart(2,'0')}`;
    const r = await api('/api/reports/summary?from='+from+'&to='+to+'&group_by=user');
    const out = document.getElementById('util-out'); if (!out) return;
    if (!r.rows.length) { out.innerHTML = '<div class="empty" style="padding:12px;color:var(--muted)">No data.</div>'; return; }
    out.innerHTML = `<p style="color:var(--muted);font-size:12px;margin-bottom:12px">Month: ${ym} · Working days: ${workDays} · Target: ${target}h per associate (${targetHrs}h/day)</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Associate</th><th class="num">Total hrs</th><th class="num">Billable hrs</th><th class="num">Target hrs</th><th class="num">Util %</th><th>Progress</th></tr></thead>
      <tbody>${r.rows.map(x => {
        const pct = target > 0 ? Math.min((x.hours / target)*100, 100) : 0;
        const bpct = x.hours > 0 ? (x.billable_hours/x.hours*100).toFixed(1) : '0.0';
        const barCls = pct >= 80 ? '' : pct >= 60 ? 'warn' : 'danger';
        return `<tr>
          <td>${escapeHtml(x.label||'')}</td>
          <td class="num">${Number(x.hours).toFixed(2)}</td>
          <td class="num">${Number(x.billable_hours).toFixed(2)}</td>
          <td class="num">${target.toFixed(0)}</td>
          <td class="num"><strong>${(x.hours/target*100).toFixed(1)}%</strong></td>
          <td style="min-width:120px">
            <div class="util-bar"><div class="util-bar-fill ${barCls}" style="width:${pct}%" title="${pct.toFixed(1)}%"></div></div>
            <small style="color:var(--muted);font-size:10px">${bpct}% billable</small>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="exportUtilCSV()">Export CSV</button></div>`;
  };
  window.exportUtilCSV = function() {
    const tbl = document.querySelector('#util-out table.data');
    if (!tbl) return;
    const rows = [...tbl.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].slice(0,5).map(c => c.textContent.trim()));
    downloadCSV('utilization.csv', rows);
  };

  // ─── PROFITABILITY REPORT ─────────────────────────────────────────────
  window.loadProfitability = async function() {
    const cid = document.getElementById('pr-client').value;
    const from = document.getElementById('pr-from').value;
    const to   = document.getElementById('pr-to').value;
    const params = new URLSearchParams({ from, to });
    if (cid) params.set('client_id', cid);
    const r = await api('/api/reports/profitability?' + params.toString());
    const out = document.getElementById('profit-out'); if (!out) return;
    if (!r.rows || !r.rows.length) { out.innerHTML = '<div class="empty" style="padding:12px;color:var(--muted)">No data. Make sure matters have been invoiced in this period.</div>'; return; }
    out.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Client</th><th>Matter</th><th class="num">Hours</th><th class="num">Billed (₹)</th><th class="num">Avg Rate</th></tr></thead>
      <tbody>${r.rows.map(x => `<tr>
        <td>${escapeHtml(x.client_name||'')}</td>
        <td>${escapeHtml(x.matter_title||'')} <small style="color:var(--muted)">${escapeHtml(x.file_no||'')}</small></td>
        <td class="num">${Number(x.hours).toFixed(2)}</td>
        <td class="num"><strong>${fmtMoney(x.billed_amount)}</strong></td>
        <td class="num">${x.hours>0 ? fmtMoney(x.billed_amount/x.hours)+'/hr' : '—'}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td colspan="2"><strong>Total</strong></td>
        <td class="num">${r.rows.reduce((s,x)=>s+Number(x.hours),0).toFixed(2)}</td>
        <td class="num"><strong>${fmtMoney(r.rows.reduce((s,x)=>s+Number(x.billed_amount),0))}</strong></td>
        <td></td>
      </tr></tfoot>
    </table></div>
    <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="exportProfitCSV()">Export CSV</button></div>`;
  };
  window.exportProfitCSV = function() {
    const tbl = document.querySelector('#profit-out table.data');
    if (!tbl) return;
    const rows = [...tbl.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].slice(0,5).map(c => c.textContent.trim()));
    downloadCSV('profitability.csv', rows);
  };

  // ─── MASTERS ─────────────────────────────────────────────────────────
  async function loadUsersTable() {
    const r = await api('/api/users'); USERS = r.users;
    document.getElementById('users-table').innerHTML = `<table class="data">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Designation</th><th>Code</th><th class="num">Rate (₹/hr)</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${USERS.map(u => `<tr>
        <td><strong>${escapeHtml(u.full_name)}</strong></td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.role}</td>
        <td>${escapeHtml(u.designation||'—')}</td>
        <td><code style="font-size:11px">${escapeHtml(u.lawyer_code||'—')}</code></td>
        <td class="num">${Number(u.default_rate||0).toFixed(2)}</td>
        <td><span class="pill ${u.is_active?'paid':'cancelled'}">${u.is_active?'Active':'Inactive'}</span></td>
        <td class="row-actions">
          <button class="btn btn-sm btn-ghost" onclick='editUser(${JSON.stringify(u).replace(/'/g,"&#39;")})'>✏ Edit</button>
          ${u.is_active ? `<button class="btn btn-sm btn-warning" onclick="deactivateUser(${u.id})">Deactivate</button>` : `<button class="btn btn-sm btn-success" onclick="reactivateUser(${u.id})">Activate</button>`}
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${escapeHtml(u.full_name)}')">🗑</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  window.newUser = function () { editUser(null); };
  window.editUser = function (u) {
    const isNew = !u;
    const html = `<div class="modal-backdrop" id="u-modal"><div class="modal">
      <div class="modal-head"><h3>${isNew?'New user':'Edit user'}</h3><button class="close" onclick="document.getElementById('u-modal').remove()">×</button></div>
      <div class="modal-body">
        <div id="u-alert" class="alert hidden"></div>
        <div class="form-grid cols-2">
          <div class="form-row"><label>Full name</label><input id="u-name" value="${escapeHtml(u?u.full_name:'')}"></div>
          <div class="form-row"><label>Email</label><input id="u-email" type="email" value="${escapeHtml(u?u.email:'')}" ${u?'disabled':''}></div>
          <div class="form-row"><label>Role</label><select id="u-role">
            <option value="associate" ${u&&u.role==='associate'?'selected':''}>Associate</option>
            <option value="billing"   ${u&&u.role==='billing'  ?'selected':''}>Billing</option>
            <option value="admin"     ${u&&u.role==='admin'    ?'selected':''}>Admin</option>
          </select></div>
          <div class="form-row"><label>Designation / Dept</label><input id="u-desig" value="${escapeHtml(u?(u.designation||''):'')}" placeholder="e.g. Corporate Law"></div>
          <div class="form-row"><label>Default rate (₹/hr)</label><input type="number" step="0.01" id="u-rate" value="${u?u.default_rate:0}"></div>
          <div class="form-row"><label>Lawyer Code (e.g. ANS)</label><input id="u-lcode" maxlength="10" value="${escapeHtml(u?(u.lawyer_code||''):'')}"></div>
          <div class="form-row"><label>${isNew?'Password':'New password (blank = keep)'}</label><input type="password" id="u-pwd"></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="document.getElementById('u-modal').remove()">Cancel</button>
        <button class="btn btn-accent" onclick="saveUser(${u?u.id:'null'})">Save</button>
      </div>
    </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveUser = async function(id) {
    const body = {
      full_name: document.getElementById('u-name').value,
      role: document.getElementById('u-role').value,
      designation: document.getElementById('u-desig').value,
      default_rate: parseFloat(document.getElementById('u-rate').value)||0,
      lawyer_code: (document.getElementById('u-lcode').value||'').trim().toUpperCase()||null
    };
    const pwd = document.getElementById('u-pwd').value;
    try {
      if (id) { if (pwd) body.password = pwd; await api('/api/users/'+id, {method:'PATCH', body}); }
      else { body.email = document.getElementById('u-email').value; if(!pwd){showAlert('u-alert','Password required');return;} body.password=pwd; await api('/api/users',{method:'POST',body}); }
      document.getElementById('u-modal').remove(); loadUsersTable();
    } catch(e) { showAlert('u-alert', e.message); }
  };
  window.deactivateUser = async function(id) {
    if (!confirm('Deactivate this user?')) return;
    await api('/api/users/'+id, {method:'PATCH', body:{is_active:0}}); loadUsersTable();
  };
  window.reactivateUser = async function(id) {
    await api('/api/users/'+id, {method:'PATCH', body:{is_active:1}}); loadUsersTable();
  };
  window.deleteUser = async function(id, name) {
    if (!confirm('PERMANENTLY delete "'+name+'"?\nThis deletes ALL their timesheet entries.\nCannot be undone!')) return;
    try { await api('/api/users/'+id, {method:'DELETE'}); showAlert('alert','"'+name+'" deleted.','success'); loadUsersTable(); }
    catch(e) { alert(e.message); }
  };

  async function loadClientsTable() {
    const r = await api('/api/clients'); CLIENTS = r.clients;
    document.getElementById('clients-table').innerHTML = `<table class="data">
      <thead><tr><th>Code</th><th>Name</th><th>Email</th><th>Phone</th><th>GSTIN</th><th>Currency</th><th class="num">Matters</th><th>Actions</th></tr></thead>
      <tbody>${CLIENTS.map(c => `<tr>
        <td>${escapeHtml(c.code||'')}</td>
        <td><strong>${escapeHtml(c.name)}</strong>${c.contact_person ? `<div style="font-size:11px;color:var(--muted);">${escapeHtml(c.contact_person)}</div>` : ''}</td>
        <td style="font-size:12px;">${escapeHtml(c.email||'—')}</td>
        <td style="font-size:12px;">${escapeHtml(c.phone||'—')}</td>
        <td style="font-size:11px;">${escapeHtml(c.gstin||'—')}</td>
        <td>${c.default_currency ? `<span style="font-size:11px;background:var(--bg-alt);padding:2px 7px;border-radius:4px;">${escapeHtml(c.default_currency)}</span>` : '<span style="color:var(--muted);font-size:11px;">INR</span>'}</td>
        <td class="num">${c.matter_count||0}</td>
        <td class="row-actions">
          <button class="btn btn-sm btn-ghost" onclick='editClient(${JSON.stringify(c).replace(/'/g,"&#39;")})'>✏ Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteClient(${c.id},'${escapeHtml(c.name)}')">🗑 Delete</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  window.newClient = function () { editClient(null); };
  window.editClient = function(c) {
    const isNew = !c;
    const html = `<div class="modal-backdrop" id="c-modal"><div class="modal">
      <div class="modal-head"><h3>${isNew?'New client':'Edit client'}</h3><button class="close" onclick="document.getElementById('c-modal').remove()">×</button></div>
      <div class="modal-body">
        <div id="c-alert" class="alert hidden"></div>
        <div class="form-grid cols-2">
          <div class="form-row"><label>Code</label><input id="c-code" value="${escapeHtml(c?(c.code||''):'')}" placeholder="e.g. TATA01"></div>
          <div class="form-row"><label>Name</label><input id="c-name" value="${escapeHtml(c?c.name:'')}"></div>
          <div class="form-row"><label>Contact person</label><input id="c-contact" value="${escapeHtml(c?(c.contact_person||''):'')}" placeholder="Kind Attn."></div>
          <div class="form-row"><label>Email</label><input id="c-email" value="${escapeHtml(c?(c.email||''):'')}" placeholder="billing@client.com"></div>
          <div class="form-row"><label>Phone</label><input id="c-phone" value="${escapeHtml(c?(c.phone||''):'')}" ></div>
          <div class="form-row"><label>GSTIN</label><input id="c-gstin" value="${escapeHtml(c?(c.gstin||''):'')}" ></div>
          <div class="form-row"><label>State</label><input id="c-state" value="${escapeHtml(c?(c.state_name||''):'')}" placeholder="Delhi"></div>
          <div class="form-row"><label>State Code</label><input id="c-statecode" value="${escapeHtml(c?(c.state_code||''):'')}" placeholder="07"></div>
          <div class="form-row"><label>Kind Attn. (override)</label><input id="c-kindattn" value="${escapeHtml(c?(c.kind_attn||''):'')}" ></div>
          <div class="form-row"><label>Invoice Ref text</label><input id="c-ref" value="${escapeHtml(c?(c.ref_text||'Legal Services'):'Legal Services')}"></div>
          <div class="form-row"><label>Default Currency</label>
            <select id="c-currency">
              <option value=""    ${!c||!c.default_currency?'selected':''}>INR (default)</option>
              <option value="INR" ${c&&c.default_currency==='INR'?'selected':''}>INR — Indian Rupee</option>
              <option value="USD" ${c&&c.default_currency==='USD'?'selected':''}>USD — US Dollar</option>
              <option value="EUR" ${c&&c.default_currency==='EUR'?'selected':''}>EUR — Euro</option>
              <option value="GBP" ${c&&c.default_currency==='GBP'?'selected':''}>GBP — British Pound</option>
              <option value="SGD" ${c&&c.default_currency==='SGD'?'selected':''}>SGD — Singapore Dollar</option>
              <option value="AED" ${c&&c.default_currency==='AED'?'selected':''}>AED — UAE Dirham</option>
            </select>
          </div>
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
  window.saveClient = async function(id) {
    const body = {
      code:document.getElementById('c-code').value,
      name:document.getElementById('c-name').value,
      contact_person:document.getElementById('c-contact').value,
      email:document.getElementById('c-email').value,
      phone:document.getElementById('c-phone').value,
      gstin:document.getElementById('c-gstin').value,
      address:document.getElementById('c-addr').value,
      state_name:document.getElementById('c-state').value,
      state_code:document.getElementById('c-statecode').value,
      kind_attn:document.getElementById('c-kindattn').value,
      ref_text:document.getElementById('c-ref').value,
      default_currency:document.getElementById('c-currency').value || null
    };
    try {
      if (id) await api('/api/clients/'+id, {method:'PATCH', body});
      else    await api('/api/clients',        {method:'POST', body});
      document.getElementById('c-modal').remove(); loadClientsTable(); loadMasters();
    } catch(e) { showAlert('c-alert', e.message); }
  };
  window.deleteClient = async function(id, name) {
    if (!confirm('PERMANENTLY delete client "'+name+'"?\nDeletes ALL related matters, entries and invoices.\nCannot be undone!')) return;
    try { await api('/api/clients/'+id, {method:'DELETE'}); showAlert('alert','Client deleted.','success'); loadClientsTable(); loadMasters(); }
    catch(e) { alert(e.message); }
  };

  async function loadMattersTable() {
    const r = await api('/api/matters'); MATTERS = r.matters;
    document.getElementById('matters-table').innerHTML = `<table class="data">
      <thead><tr><th>File No</th><th>Client</th><th>Title</th><th>Billing</th><th class="num">Rate / Fee</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${MATTERS.map(m => `<tr>
        <td><strong>${escapeHtml(m.file_no)}</strong></td>
        <td>${escapeHtml(m.client_name)}</td>
        <td>${escapeHtml(m.title)}</td>
        <td><span style="font-size:11px;background:var(--bg-alt);padding:2px 7px;border-radius:4px;">${escapeHtml(m.billing_type)}</span></td>
        <td class="num">${m.billing_type==='hourly_matter'?fmtMoney(m.matter_rate)+'/hr':m.billing_type==='flat'?fmtMoney(m.flat_fee):m.billing_type==='retainer'?fmtMoney(m.retainer_amount)+' ret.':'—'}</td>
        <td><span class="pill ${m.status}">${m.status}</span></td>
        <td class="row-actions">
          <button class="btn btn-sm btn-ghost" onclick='editMatter(${JSON.stringify(m).replace(/'/g,"&#39;")})'>✏ Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteMatter(${m.id},'${escapeHtml(m.title)}')">🗑</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
  }
  window.newMatter = function () { editMatter(null); };
  window.editMatter = function(m) {
    const isNew = !m;
    const html = `<div class="modal-backdrop" id="m-modal"><div class="modal">
      <div class="modal-head"><h3>${isNew?'New matter':'Edit matter'}</h3><button class="close" onclick="document.getElementById('m-modal').remove()">×</button></div>
      <div class="modal-body">
        <div id="m-alert" class="alert hidden"></div>
        <div class="form-grid cols-2">
          <div class="form-row"><label>Client</label><select id="m-client">${CLIENTS.map(c => `<option value="${c.id}" ${m&&m.client_id===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>File No.</label><input id="m-file" value="${escapeHtml(m?m.file_no:'')}"></div>
          <div class="form-row full"><label>Title</label><input id="m-title" value="${escapeHtml(m?m.title:'')}"></div>
          <div class="form-row full"><label>Description</label><textarea id="m-desc">${escapeHtml(m?(m.description||''):'')}</textarea></div>
          <div class="form-row"><label>Billing type</label>
            <select id="m-btype">
              <option value="hourly_user" ${m&&m.billing_type==='hourly_user'?'selected':''}>Hourly — per associate</option>
              <option value="hourly_matter" ${m&&m.billing_type==='hourly_matter'?'selected':''}>Hourly — matter rate</option>
              <option value="flat" ${m&&m.billing_type==='flat'?'selected':''}>Flat fee</option>
              <option value="retainer" ${m&&m.billing_type==='retainer'?'selected':''}>Retainer (advance)</option>
            </select>
          </div>
          <div class="form-row"><label>Status</label>
            <select id="m-status"><option value="open" ${m&&m.status==='open'?'selected':''}>Open</option><option value="closed" ${m&&m.status==='closed'?'selected':''}>Closed</option></select>
          </div>
          <div class="form-row"><label>Matter hourly rate (₹)</label><input type="number" step="0.01" id="m-rate" value="${m?m.matter_rate:0}"></div>
          <div class="form-row"><label>Flat fee (₹)</label><input type="number" step="0.01" id="m-flat" value="${m?m.flat_fee:0}"></div>
          <div class="form-row"><label>Retainer amount (₹)</label><input type="number" step="0.01" id="m-retainer" value="${m?m.retainer_amount:0}"></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="document.getElementById('m-modal').remove()">Cancel</button>
        <button class="btn btn-accent" onclick="saveMatter(${m?m.id:'null'})">Save</button>
      </div>
    </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  window.saveMatter = async function(id) {
    const body = {
      client_id:parseInt(document.getElementById('m-client').value,10),
      file_no:document.getElementById('m-file').value,
      title:document.getElementById('m-title').value,
      description:document.getElementById('m-desc').value,
      billing_type:document.getElementById('m-btype').value,
      matter_rate:parseFloat(document.getElementById('m-rate').value)||0,
      flat_fee:parseFloat(document.getElementById('m-flat').value)||0,
      retainer_amount:parseFloat(document.getElementById('m-retainer').value)||0,
      status:document.getElementById('m-status').value
    };
    try {
      if (id) await api('/api/matters/'+id, {method:'PATCH', body});
      else    await api('/api/matters',       {method:'POST', body});
      document.getElementById('m-modal').remove(); loadMattersTable(); loadMasters();
    } catch(e) { showAlert('m-alert', e.message); }
  };
  window.deleteMatter = async function(id, title) {
    if (!confirm('PERMANENTLY delete matter "'+title+'"?\nDeletes ALL its timesheet entries.\nCannot be undone!')) return;
    try { await api('/api/matters/'+id, {method:'DELETE'}); showAlert('alert','Matter deleted.','success'); loadMattersTable(); loadMasters(); }
    catch(e) { alert(e.message); }
  };

  async function loadRatesTable() {
    const r = await api('/api/rates');
    document.getElementById('rates-table').innerHTML = !r.rates.length
      ? '<div class="empty" style="padding:16px;color:var(--muted)">No rate overrides. Associate default rate is used.</div>'
      : `<table class="data">
          <thead><tr><th>Matter</th><th>Associate</th><th class="num">Rate (₹/hr)</th><th>Effective from</th><th>Actions</th></tr></thead>
          <tbody>${r.rates.map(rt => `<tr>
            <td><strong>${escapeHtml(rt.file_no)}</strong> — ${escapeHtml(rt.matter_title)}</td>
            <td>${escapeHtml(rt.full_name)}</td>
            <td class="num">${fmtMoney(rt.hourly_rate)}</td>
            <td>${rt.effective_from}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteRate(${rt.id})">Delete</button></td>
          </tr>`).join('')}</tbody></table>`;
  }
  window.newRate = function() {
    const html = `<div class="modal-backdrop" id="r-modal"><div class="modal">
      <div class="modal-head"><h3>Add rate override</h3><button class="close" onclick="document.getElementById('r-modal').remove()">×</button></div>
      <div class="modal-body">
        <div id="r-alert" class="alert hidden"></div>
        <div class="form-grid cols-2">
          <div class="form-row"><label>Matter</label><select id="r-matter">${MATTERS.map(m => `<option value="${m.id}">${escapeHtml(m.file_no+' — '+m.title)}</option>`).join('')}</select></div>
          <div class="form-row"><label>Associate</label><select id="r-user">${USERS.map(u => `<option value="${u.id}">${escapeHtml(u.full_name)}</option>`).join('')}</select></div>
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
  window.saveRate = async function() {
    const body = {
      matter_id:parseInt(document.getElementById('r-matter').value,10),
      user_id:parseInt(document.getElementById('r-user').value,10),
      hourly_rate:parseFloat(document.getElementById('r-rate').value)||0,
      effective_from:document.getElementById('r-eff').value
    };
    try { await api('/api/rates', {method:'POST', body}); document.getElementById('r-modal').remove(); loadRatesTable(); }
    catch(e) { showAlert('r-alert', e.message); }
  };
  window.deleteRate = async function(id) {
    if (!confirm('Delete this rate override?')) return;
    await api('/api/rates/'+id, {method:'DELETE'}); loadRatesTable();
  };

  // ─── ACTIVITY LOG ────────────────────────────────────────────────────
  let _actUsersLoaded = false;
  window.loadActivityLog = async function() {
    const sel = document.getElementById('act-filter-user');
    const userId = sel ? sel.value : '';
    const params = userId ? '?user_id=' + userId : '';
    try {
      const r = await api('/api/billing/activity' + params);
      const logs = r.log || [];

      // Populate user dropdown once from the users we already have
      if (!_actUsersLoaded && sel) {
        _actUsersLoaded = true;
        const billingUsers = USERS.filter(u => ['admin','billing'].includes(u.role));
        billingUsers.forEach(u => {
          const opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = u.full_name + ' (' + (u.designation || u.role) + ')';
          sel.appendChild(opt);
        });
      }

      const wrap = document.getElementById('activity-table');
      if (!wrap) return;
      if (!logs.length) {
        wrap.innerHTML = '<div style="padding:16px;color:var(--muted)">No activity recorded yet.</div>';
        return;
      }
      wrap.innerHTML = `<table class="data">
        <thead><tr>
          <th style="white-space:nowrap">Time</th>
          <th>User</th>
          <th>Role</th>
          <th>Action</th>
          <th>Details</th>
          <th></th>
        </tr></thead>
        <tbody>${logs.map(l => {
          const dt = l.at ? (l.at.slice(0,10) + ' ' + (l.at.slice(11,16)||'')) : '—';
          const roleClass = l.user_role === 'admin' ? 'pill-admin' : (l.user_role === 'billing' ? 'pill-billing' : '');
          const viewBtn = (l.entity === 'invoice' && l.entity_id)
            ? `<button class="btn btn-sm btn-ghost" onclick="switchTab('tab-billing');switchSubTab('stab-invoices');loadInvoices()">View</button>`
            : '';
          return `<tr>
            <td style="white-space:nowrap;font-size:11px;">${escapeHtml(dt)}</td>
            <td><strong>${escapeHtml(l.user_name || '—')}</strong></td>
            <td><span class="pill ${roleClass}" style="font-size:10px;padding:2px 7px;">${escapeHtml(l.user_role || '—')}</span></td>
            <td style="font-size:12px;">${escapeHtml(l.action || '')}</td>
            <td style="font-size:11px;color:var(--muted);max-width:320px;">${escapeHtml(l.detail || '')}</td>
            <td>${viewBtn}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    } catch(e) { console.error('Activity log error:', e); }
  };

  // ─── TABS ─────────────────────────────────────────────────────────────
  function switchTab(id) {
    document.querySelectorAll('main > section.tab-panel').forEach(p => p.classList.remove('active'));
    const el = document.getElementById(id); if (el) el.classList.add('active');
    setActiveTab(id);
    if (id==='tab-dashboard')   loadDashboard();
    if (id==='tab-entries')     loadAllEntries();
    if (id==='tab-billing')     { loadInvoices(); switchSubTab('stab-invoices'); }
    if (id==='tab-outstanding') loadOutstanding();
    if (id==='tab-masters')     { loadUsersTable(); loadClientsTable(); loadMattersTable(); loadRatesTable(); }
    if (id==='tab-leaves')      { loadLeavesDashboard(); loadLeaveTypesTable(); }
    if (id==='tab-activity')    loadActivityLog();
    if (id==='tab-superadmin')  { loadRecycleBin(); }
  }

  // Scope-aware subtab switcher. We deactivate only siblings inside the SAME
  // .subtabs strip / panel level — not descendants — so nested sub-tabs (like
  // WFH living inside Leaves) work without one accidentally hiding the other.
  window.switchSubTab = function(id) {
    const parent = document.getElementById(id); if (!parent) return;
    const container = parent.parentElement;          // immediate wrapper of this panel
    if (container) {
      // Only direct-child sibling panels lose 'active' — descendants stay put.
      Array.from(container.children).forEach(c => {
        if (c.classList && c.classList.contains('subtab-panel')) c.classList.remove('active');
      });
      // Find the .subtabs strip that is a direct child of this same container.
      const strip = container.querySelector(':scope > .subtabs');
      if (strip) {
        strip.querySelectorAll(':scope > .subtab-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.stab === id));
      }
    }
    parent.classList.add('active');
  };

  function switchMTab(id) {
    document.querySelectorAll('#tab-masters .subtab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('#tab-masters [data-mtab]').forEach(b => b.classList.toggle('active', b.dataset.mtab === id));
    const el = document.getElementById(id); if (el) el.classList.add('active');
    if (id === 'm-users')   loadUsersTable();
    if (id === 'm-clients') loadClientsTable();
    if (id === 'm-matters') loadMattersTable();
    if (id === 'm-rates')   loadRatesTable();
  }

  // ─── EVENT WIRING ────────────────────────────────────────────────────
  // Topnav tab buttons (rendered above, so use event delegation on topbar)
  document.getElementById('topbar').addEventListener('click', function(e) {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  });
  document.querySelectorAll('.subtab-btn[data-stab]').forEach(btn => {
    btn.addEventListener('click', () => switchSubTab(btn.dataset.stab));
  });
  document.querySelectorAll('[data-mtab]').forEach(btn => {
    btn.addEventListener('click', () => switchMTab(btn.dataset.mtab));
  });

  // ══ LEAVES ════════════════════════════════════════════════════════════
  let LEAVE_TYPES = [];

  function fillYearSelectAdmin(id) {
    const sel = document.getElementById(id); if (!sel || sel.options.length) return;
    const y = new Date().getFullYear();
    for (let i = y - 2; i <= y + 1; i++) {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = i; if (i === y) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  window.loadLeavesDashboard = async function() {
    try {
      const [d, types] = await Promise.all([
        api('/api/leaves/dashboard'),
        api('/api/leaves/types?all=1')
      ]);
      LEAVE_TYPES = types.types;
      // KPIs
      const onLeaveList = d.on_leave_today.map(x =>
        `<span class="leave-chip" style="display:inline-block;background:${x.color || '#3b82f6'}20;color:${x.color || '#3b82f6'};padding:2px 8px;border-radius:10px;font-size:11px;margin:2px;">${escapeHtml(x.full_name)} (${escapeHtml(x.type_code)})</span>`
      ).join('') || '<span class="muted" style="font-size:13px;">No one is on leave today.</span>';
      const upcomingList = d.upcoming_holidays.map(h =>
        `<div style="font-size:12px;padding:3px 0;"><strong>${fmtDate(h.holiday_date)}</strong> — ${escapeHtml(h.name)}</div>`
      ).join('') || '<span class="muted" style="font-size:13px;">No upcoming holidays scheduled.</span>';
      document.getElementById('lv-dash').innerHTML = `
        <div class="kpi"><h4>Pending approvals</h4><div class="val">${d.pending_count}</div></div>
        <div class="kpi" style="grid-column:span 2;"><h4>On leave today</h4><div style="margin-top:6px;">${onLeaveList}</div></div>
        <div class="kpi" style="grid-column:span 2;"><h4>Upcoming holidays</h4><div style="margin-top:6px;">${upcomingList}</div></div>
      `;
      // Pending count badge in subtab
      const badge = document.getElementById('lv-pending-count');
      if (badge) {
        if (d.pending_count > 0) { badge.style.display = 'inline-block'; badge.textContent = d.pending_count; }
        else                     { badge.style.display = 'none'; }
      }
      loadPendingLeaves();
    } catch(e) { console.error('Leave dashboard error', e); }
  };

  async function loadPendingLeaves() {
    try {
      const r = await api('/api/leaves/applications?status=submitted');
      renderApplicationsTable('lv-pending-table', r.applications, true);
    } catch(e) { console.error(e); }
  }

  window.loadAllLeaves = async function() {
    const q = [];
    const u = document.getElementById('lv-af-user').value; if (u) q.push('user_id=' + u);
    const s = document.getElementById('lv-af-status').value; if (s) q.push('status=' + s);
    const f = document.getElementById('lv-af-from').value; if (f) q.push('from=' + f);
    const t = document.getElementById('lv-af-to').value;   if (t) q.push('to=' + t);
    try {
      const r = await api('/api/leaves/applications' + (q.length ? '?' + q.join('&') : ''));
      renderApplicationsTable('lv-all-table', r.applications, true);
    } catch(e) { showAlert('alert', e.message); }
  };

  function renderApplicationsTable(elId, apps, withActions) {
    if (!apps.length) {
      document.getElementById(elId).innerHTML = '<p class="muted" style="padding:14px;font-size:13px;">No applications.</p>';
      return;
    }
    const rows = apps.map(a => {
      const range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
      const session = a.half_day_session === 'full' ? '' : ' (' + (a.half_day_session === 'first_half' ? '1st half' : '2nd half') + ')';
      const actions = (withActions && a.status === 'submitted')
        ? `<button class="btn btn-sm btn-accent" onclick="openDecideModal(${a.id}, 'approved')">✓ Approve</button>
           <button class="btn btn-sm btn-danger" onclick="openDecideModal(${a.id}, 'rejected')">✗ Reject</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(a.user_name)}<div style="font-size:10px;color:var(--muted);">${escapeHtml(a.designation || '')}</div></td>
        <td><span class="leave-chip" style="background:${(a.color||'#3b82f6')}20;color:${a.color||'#3b82f6'};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${escapeHtml(a.type_code)}</span></td>
        <td>${range}${session}</td>
        <td class="num">${a.days}</td>
        <td>${escapeHtml(a.reason)}${a.contact_during_leave ? '<div style="font-size:10px;color:var(--muted);">Contact: ' + escapeHtml(a.contact_during_leave) + '</div>' : ''}</td>
        <td>${(function(){const sc={submitted:'#f59e0b',approved:'#10b981',rejected:'#ef4444',cancelled:'#6b7280'}[a.status]||'#6b7280';return `<span style="background:${sc}20;color:${sc};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${a.status}</span>`;})()}${a.decided_by_name ? '<div style="font-size:10px;color:var(--muted);">by ' + escapeHtml(a.decided_by_name) + '</div>' : ''}${a.decision_note ? '<div style="font-size:10px;color:var(--muted);">"' + escapeHtml(a.decision_note) + '"</div>' : ''}</td>
        <td style="white-space:nowrap;">${actions}</td>
      </tr>`;
    }).join('');
    document.getElementById(elId).innerHTML = `
      <table class="data"><thead><tr>
        <th>Associate</th><th>Type</th><th>Dates</th><th class="num">Days</th><th>Reason</th><th>Status</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  }

  let _decideId = null, _decideAction = null;
  window.openDecideModal = function(id, action) {
    _decideId = id; _decideAction = action;
    document.getElementById('lv-decide-title').textContent = (action === 'approved' ? 'Approve' : 'Reject') + ' leave';
    document.getElementById('lv-decide-alert').className = 'alert hidden';
    document.getElementById('lv-decide-note').value = '';
    // Fetch application detail for the summary
    api('/api/leaves/applications/' + id).then(r => {
      const a = r.application;
      const range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
      document.getElementById('lv-decide-summary').innerHTML =
        '<strong>' + escapeHtml(a.user_name) + '</strong> · ' + escapeHtml(a.type_code) +
        '<br>' + range + ' · ' + a.days + ' day(s)' +
        '<br><span class="muted">Reason: ' + escapeHtml(a.reason) + '</span>';
    });
    const btn = document.getElementById('lv-decide-confirm');
    btn.className = 'btn ' + (action === 'approved' ? 'btn-accent' : 'btn-danger');
    btn.textContent = action === 'approved' ? '✓ Approve' : '✗ Reject';
    document.getElementById('lv-decide-modal').classList.remove('hidden');
  };
  window.closeDecideModal = function() { document.getElementById('lv-decide-modal').classList.add('hidden'); };
  document.getElementById('lv-decide-confirm').addEventListener('click', async () => {
    if (!_decideId) return;
    const note = document.getElementById('lv-decide-note').value.trim();
    try {
      await api('/api/leaves/applications/' + _decideId + '/' + (_decideAction === 'approved' ? 'approve' : 'reject'),
        { method: 'POST', body: { note: note || null } });
      closeDecideModal();
      loadLeavesDashboard();
      if (document.getElementById('stab-lv-all').classList.contains('active')) loadAllLeaves();
    } catch(e) { showAlert('lv-decide-alert', e.message); }
  });

  // ── Manual leave entry (admin/HR records leave on behalf of employee) ─
  window.openManualLeaveModal = function() {
    document.getElementById('lv-manual-alert').className = 'alert hidden';
    // Populate users
    const uSel = document.getElementById('lv-manual-user'); uSel.innerHTML = '';
    USERS.filter(u => u.is_active).forEach(u => {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.full_name + ' (' + (u.designation || u.role) + ')';
      uSel.appendChild(o);
    });
    // Populate leave types
    const tSel = document.getElementById('lv-manual-type'); tSel.innerHTML = '';
    LEAVE_TYPES.filter(t => t.is_active).forEach(t => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name + ' (' + t.code + ')';
      o.dataset.countMethod = t.count_method || 'working_days';
      tSel.appendChild(o);
    });
    tSel.addEventListener('change', updateManualLeaveDays, { once: false });
    setVal('lv-manual-from', todayISO());
    setVal('lv-manual-to',   todayISO());
    setVal('lv-manual-session', 'full');
    setVal('lv-manual-reason', '');
    setVal('lv-manual-note', '');
    document.getElementById('lv-manual-approve').checked = true;
    updateManualLeaveDays();
    document.getElementById('lv-manual-modal').classList.remove('hidden');
  };

  window.closeManualLeaveModal = function() {
    document.getElementById('lv-manual-modal').classList.add('hidden');
  };

  // Front-end day estimate. Server is authoritative (also skips holidays from DB).
  window.updateManualLeaveDays = function() {
    const from = document.getElementById('lv-manual-from').value;
    const to   = document.getElementById('lv-manual-to').value;
    const sess = document.getElementById('lv-manual-session').value;
    const tSel = document.getElementById('lv-manual-type');
    const method = tSel.selectedOptions[0] ? tSel.selectedOptions[0].dataset.countMethod : 'working_days';
    if (!from || !to) { setText('lv-manual-days', '—'); return; }
    if (sess !== 'full') {
      if (from !== to) { setVal('lv-manual-to', from); }
      setText('lv-manual-days', '0.5'); return;
    }
    const d1 = new Date(from + 'T00:00:00'), d2 = new Date(to + 'T00:00:00');
    if (d2 < d1) { setText('lv-manual-days', '0'); return; }
    let n = 0;
    if (method === 'calendar_days') {
      n = Math.round((d2 - d1) / 86400000) + 1;
    } else {
      for (let d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) n++;
      }
    }
    setText('lv-manual-days', String(n));
  };

  window.submitManualLeave = async function() {
    const body = {
      user_id: parseInt(document.getElementById('lv-manual-user').value, 10),
      leave_type_id: parseInt(document.getElementById('lv-manual-type').value, 10),
      from_date: document.getElementById('lv-manual-from').value,
      to_date:   document.getElementById('lv-manual-to').value,
      half_day_session: document.getElementById('lv-manual-session').value,
      reason: document.getElementById('lv-manual-reason').value.trim(),
      auto_approve: document.getElementById('lv-manual-approve').checked,
      decision_note: document.getElementById('lv-manual-note').value.trim() || null
    };
    if (!body.user_id || !body.leave_type_id || !body.from_date || !body.to_date || !body.reason) {
      showAlert('lv-manual-alert', 'Employee, type, dates and reason are required'); return;
    }
    try {
      const r = await api('/api/leaves/applications', { method: 'POST', body });
      closeManualLeaveModal();
      alert(`Recorded ${r.days} day(s) — status: ${r.status}`);
      loadLeavesDashboard();
      // Refresh whichever subtab is active so the new row shows immediately
      if (document.getElementById('stab-lv-all').classList.contains('active'))      loadAllLeaves();
      if (document.getElementById('stab-lv-balances').classList.contains('active')) loadLeaveBalances();
    } catch(e) { showAlert('lv-manual-alert', e.message); }
  };

  // ── Balances tab ───────────────────────────────────────────────────────
  window.loadLeaveBalances = async function() {
    fillYearSelectAdmin('lv-bal-year');
    const year = document.getElementById('lv-bal-year').value;
    try {
      const r = await api('/api/leaves/balances?year=' + year);
      const balances = r.balances;
      if (!balances.length) {
        document.getElementById('lv-balances-table').innerHTML = '<p class="muted" style="padding:14px;font-size:13px;">No balances yet for ' + year + '. Click "Bulk Allocate" to start.</p>';
        return;
      }
      // Group by user
      const byUser = {};
      balances.forEach(b => {
        if (!byUser[b.user_id]) byUser[b.user_id] = { name: b.user_name, email: b.user_email, rows: [] };
        byUser[b.user_id].rows.push(b);
      });
      const cards = Object.entries(byUser).map(([uid, u]) => {
        const chips = u.rows.map(b =>
          `<span style="display:inline-block;background:${(b.color||'#3b82f6')}15;color:${b.color||'#3b82f6'};padding:4px 10px;border-radius:14px;font-size:12px;margin:3px;font-weight:500;">
            <strong>${escapeHtml(b.type_code)}</strong>: ${b.available.toFixed(1)} / ${(b.allocated + b.carried_forward).toFixed(1)}
            ${b.pending > 0 ? `<span style="opacity:.7;">(${b.pending.toFixed(1)} pend)</span>` : ''}
          </span>`
        ).join('');
        return `<div class="card" style="margin-bottom:8px;padding:12px;">
          <strong>${escapeHtml(u.name)}</strong> <span class="muted" style="font-size:11px;">${escapeHtml(u.email)}</span>
          <div style="margin-top:6px;">${chips}</div>
        </div>`;
      }).join('');
      document.getElementById('lv-balances-table').innerHTML = cards;
    } catch(e) { showAlert('alert', e.message); }
  };

  window.openAllocateModal = function() {
    document.getElementById('lv-alloc-alert').className = 'alert hidden';
    setVal('lv-alloc-year', new Date().getFullYear());
    setVal('lv-alloc-days', '');
    const tSel = document.getElementById('lv-alloc-type'); tSel.innerHTML = '';
    LEAVE_TYPES.filter(t => t.is_active).forEach(t => {
      const o = document.createElement('option'); o.value = t.id;
      o.textContent = t.name + ' (' + t.code + ') — default ' + t.default_annual_quota;
      tSel.appendChild(o);
    });
    const uSel = document.getElementById('lv-alloc-users'); uSel.innerHTML = '';
    USERS.filter(u => u.is_active).forEach(u => {
      const o = document.createElement('option'); o.value = u.id;
      o.textContent = u.full_name + ' (' + (u.designation || u.role) + ')';
      uSel.appendChild(o);
    });
    document.getElementById('lv-alloc-scope').value = 'all';
    document.getElementById('lv-alloc-users-row').style.display = 'none';
    document.getElementById('lv-allocate-modal').classList.remove('hidden');
  };
  window.closeAllocateModal = function() { document.getElementById('lv-allocate-modal').classList.add('hidden'); };
  document.getElementById('lv-alloc-scope').addEventListener('change', e => {
    document.getElementById('lv-alloc-users-row').style.display = e.target.value === 'selected' ? '' : 'none';
  });
  window.submitAllocate = async function() {
    const body = {
      year: parseInt(document.getElementById('lv-alloc-year').value, 10),
      leave_type_id: parseInt(document.getElementById('lv-alloc-type').value, 10)
    };
    const daysVal = document.getElementById('lv-alloc-days').value;
    if (daysVal !== '') body.allocated = Number(daysVal);
    const scope = document.getElementById('lv-alloc-scope').value;
    if (scope === 'all') body.all_active = true;
    else {
      body.user_ids = Array.from(document.getElementById('lv-alloc-users').selectedOptions).map(o => parseInt(o.value, 10));
      if (!body.user_ids.length) { showAlert('lv-alloc-alert', 'Select at least one user'); return; }
    }
    try {
      const r = await api('/api/leaves/balances/allocate', { method: 'POST', body });
      closeAllocateModal();
      alert(`Allocated ${r.allocated} day(s) to ${r.count} user(s) for ${r.year}.`);
      loadLeaveBalances();
    } catch(e) { showAlert('lv-alloc-alert', e.message); }
  };

  // ── Holidays ──────────────────────────────────────────────────────────
  window.loadHolidaysAdmin = async function() {
    fillYearSelectAdmin('lv-hol-year');
    const year = document.getElementById('lv-hol-year').value;
    try {
      const r = await api('/api/leaves/holidays?year=' + year);
      if (!r.holidays.length) {
        document.getElementById('lv-holidays-table-admin').innerHTML = '<p class="muted" style="padding:14px;font-size:13px;">No holidays for ' + year + '.</p>';
        return;
      }
      const rows = r.holidays.map(h =>
        `<tr>
          <td>${fmtDate(h.holiday_date)}</td>
          <td>${escapeHtml(h.name)}</td>
          <td>${h.is_optional ? '<span class="muted">Optional</span>' : 'Public'}</td>
          <td>${escapeHtml(h.description || '')}</td>
          <td><button class="btn btn-sm btn-danger" onclick="deleteHoliday(${h.id})">Delete</button></td>
        </tr>`
      ).join('');
      document.getElementById('lv-holidays-table-admin').innerHTML =
        '<table class="data"><thead><tr><th>Date</th><th>Name</th><th>Type</th><th>Notes</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table>';
    } catch(e) { showAlert('alert', e.message); }
  };
  window.openHolidayModal = function() {
    document.getElementById('lv-hol-alert').className = 'alert hidden';
    setVal('lv-hol-date', todayISO()); setVal('lv-hol-name', ''); setVal('lv-hol-desc', '');
    document.getElementById('lv-hol-optional').checked = false;
    document.getElementById('lv-holiday-modal').classList.remove('hidden');
  };
  window.closeHolidayModal = function() { document.getElementById('lv-holiday-modal').classList.add('hidden'); };
  window.submitHoliday = async function() {
    const body = {
      holiday_date: document.getElementById('lv-hol-date').value,
      name: document.getElementById('lv-hol-name').value.trim(),
      is_optional: document.getElementById('lv-hol-optional').checked,
      description: document.getElementById('lv-hol-desc').value.trim() || null
    };
    if (!body.holiday_date || !body.name) { showAlert('lv-hol-alert', 'Date and name required'); return; }
    try {
      await api('/api/leaves/holidays', { method: 'POST', body });
      closeHolidayModal();
      loadHolidaysAdmin();
    } catch(e) { showAlert('lv-hol-alert', e.message); }
  };
  window.deleteHoliday = async function(id) {
    if (!confirm('Delete this holiday?')) return;
    try { await api('/api/leaves/holidays/' + id, { method: 'DELETE' }); loadHolidaysAdmin(); }
    catch(e) { showAlert('alert', e.message); }
  };

  // ── Leave types ───────────────────────────────────────────────────────
  window.loadLeaveTypesTable = async function() {
    try {
      const r = await api('/api/leaves/types?all=1');
      LEAVE_TYPES = r.types;
      if (!r.types.length) {
        document.getElementById('lv-types-table').innerHTML = '<p class="muted" style="padding:14px;font-size:13px;">No leave types yet.</p>';
        return;
      }
      const rows = r.types.map(t =>
        `<tr style="${t.is_active ? '' : 'opacity:.55;'}">
          <td><span style="display:inline-block;width:14px;height:14px;background:${t.color};border-radius:3px;margin-right:8px;vertical-align:middle;"></span>${escapeHtml(t.code)}</td>
          <td>${escapeHtml(t.name)}</td>
          <td class="num">${t.default_annual_quota}</td>
          <td>${t.is_paid ? 'Paid' : '<span class="muted">Unpaid</span>'}</td>
          <td>${t.count_method === 'calendar_days' ? '<span title="Counts every day incl. weekends/holidays">Calendar</span>' : 'Working'}</td>
          <td>${t.carry_forward ? 'Yes (max ' + t.max_carry_forward + ')' : '—'}</td>
          <td>${t.is_active ? 'Active' : '<span class="muted">Inactive</span>'}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-sm btn-ghost" onclick="editLeaveType(${t.id})">Edit</button>
            ${t.is_active ? `<button class="btn btn-sm btn-danger" onclick="deactivateLeaveType(${t.id})">Deactivate</button>` : ''}
          </td>
        </tr>`
      ).join('');
      document.getElementById('lv-types-table').innerHTML =
        '<table class="data"><thead><tr><th>Code</th><th>Name</th><th class="num">Default qty</th><th>Paid</th><th>Count</th><th>Carry-fwd</th><th>Status</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table>';
    } catch(e) { showAlert('alert', e.message); }
  };
  window.openLeaveTypeModal = function() {
    document.getElementById('lv-type-title').textContent = 'Add Leave Type';
    document.getElementById('lv-type-alert').className = 'alert hidden';
    setVal('lv-type-id', ''); setVal('lv-type-code', ''); setVal('lv-type-name', '');
    setVal('lv-type-quota', '0'); setVal('lv-type-color', '#3b82f6'); setVal('lv-type-maxcarry', '0');
    setVal('lv-type-count-method', 'working_days');
    document.getElementById('lv-type-paid').checked = true;
    document.getElementById('lv-type-carry').checked = false;
    document.getElementById('lv-type-modal').classList.remove('hidden');
  };
  window.editLeaveType = function(id) {
    const t = LEAVE_TYPES.find(x => x.id === id); if (!t) return;
    document.getElementById('lv-type-title').textContent = 'Edit Leave Type';
    document.getElementById('lv-type-alert').className = 'alert hidden';
    setVal('lv-type-id', t.id); setVal('lv-type-code', t.code); setVal('lv-type-name', t.name);
    setVal('lv-type-quota', t.default_annual_quota); setVal('lv-type-color', t.color);
    setVal('lv-type-maxcarry', t.max_carry_forward);
    setVal('lv-type-count-method', t.count_method || 'working_days');
    document.getElementById('lv-type-paid').checked  = !!t.is_paid;
    document.getElementById('lv-type-carry').checked = !!t.carry_forward;
    document.getElementById('lv-type-modal').classList.remove('hidden');
  };
  window.closeLeaveTypeModal = function() { document.getElementById('lv-type-modal').classList.add('hidden'); };
  window.submitLeaveType = async function() {
    const id = document.getElementById('lv-type-id').value;
    const body = {
      code: document.getElementById('lv-type-code').value.trim().toUpperCase(),
      name: document.getElementById('lv-type-name').value.trim(),
      default_annual_quota: Number(document.getElementById('lv-type-quota').value || 0),
      color: document.getElementById('lv-type-color').value,
      is_paid: document.getElementById('lv-type-paid').checked,
      carry_forward: document.getElementById('lv-type-carry').checked,
      max_carry_forward: Number(document.getElementById('lv-type-maxcarry').value || 0),
      count_method: document.getElementById('lv-type-count-method').value
    };
    if (!body.code || !body.name) { showAlert('lv-type-alert', 'Code and name required'); return; }
    try {
      if (id) await api('/api/leaves/types/' + id, { method: 'PATCH', body });
      else    await api('/api/leaves/types',        { method: 'POST',  body });
      closeLeaveTypeModal();
      loadLeaveTypesTable();
    } catch(e) { showAlert('lv-type-alert', e.message); }
  };
  window.deactivateLeaveType = async function(id) {
    if (!confirm('Deactivate this leave type? Historical data is preserved.')) return;
    try { await api('/api/leaves/types/' + id, { method: 'DELETE' }); loadLeaveTypesTable(); }
    catch(e) { showAlert('alert', e.message); }
  };

  window.exportLeavesCSV = async function() {
    const q = [];
    const u = document.getElementById('lv-af-user').value; if (u) q.push('user_id=' + u);
    const s = document.getElementById('lv-af-status').value; if (s) q.push('status=' + s);
    const f = document.getElementById('lv-af-from').value; if (f) q.push('from=' + f);
    const t = document.getElementById('lv-af-to').value;   if (t) q.push('to=' + t);
    try {
      const r = await api('/api/leaves/applications' + (q.length ? '?' + q.join('&') : ''));
      const header = ['Associate','Email','Type','From','To','Session','Days','Reason','Status','Decided By','Decision Note','Applied On'];
      const csv = [header.join(',')].concat(r.applications.map(a => [
        a.user_name, a.user_email, a.type_code, a.from_date, a.to_date,
        a.half_day_session, a.days, a.reason, a.status,
        a.decided_by_name || '', a.decision_note || '', a.created_at
      ].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','))).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'leaves.csv'; link.click();
      URL.revokeObjectURL(url);
    } catch(e) { showAlert('alert', e.message); }
  };

  // ── Reports subtab ─────────────────────────────────────────────────────
  let _lastReport = null; // for CSV export

  function initLeaveReportsUI() {
    fillYearSelectAdmin('lv-rp-year');
    const uSel = document.getElementById('lv-rp-user');
    if (uSel && uSel.options.length <= 1) {
      USERS.filter(u => u.is_active).forEach(u => {
        const o = document.createElement('option');
        o.value = u.id; o.textContent = u.full_name + ' (' + (u.designation || u.role) + ')';
        uSel.appendChild(o);
      });
    }
  }

  window.runLeaveReport = async function() {
    initLeaveReportsUI();
    const year  = document.getElementById('lv-rp-year').value;
    const month = document.getElementById('lv-rp-month').value;
    const userId = document.getElementById('lv-rp-user').value;
    try {
      if (userId) {
        const r = await api('/api/leaves/reports/user/' + userId + '?year=' + year);
        _lastReport = { kind: 'user', data: r };
        renderUserDeepDive(r);
      } else {
        const url = '/api/leaves/reports/summary?year=' + year + (month ? '&month=' + month : '');
        const r = await api(url);
        _lastReport = { kind: 'summary', data: r };
        renderSummaryPivot(r);
      }
    } catch(e) { showAlert('alert', e.message); }
  };

  function renderSummaryPivot(r) {
    const periodLabel = r.month
      ? new Date(r.year, r.month - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' })
      : 'Full year ' + r.year;
    const headerCells = r.types.map(t =>
      `<th class="num" title="${escapeHtml(t.name)}"><span style="display:inline-block;width:8px;height:8px;background:${t.color};border-radius:50%;margin-right:4px;"></span>${escapeHtml(t.code)}</th>`
    ).join('');

    const hasAny = r.rows.some(row => row.total > 0);
    const rows = r.rows.map(row => {
      const cells = r.types.map(t => {
        const v = row.counts[t.code] || 0;
        return `<td class="num" style="${v > 0 ? '' : 'color:#cbd5e1;'}">${v ? v.toFixed(1).replace(/\.0$/, '') : '—'}</td>`;
      }).join('');
      return `<tr>
        <td>${escapeHtml(row.full_name)}<div style="font-size:10px;color:var(--muted);">${escapeHtml(row.designation || '')}</div></td>
        ${cells}
        <td class="num"><strong>${row.total ? row.total.toFixed(1).replace(/\.0$/, '') : '—'}</strong></td>
      </tr>`;
    }).join('');

    // Footer: totals per leave type
    const typeTotals = {};
    r.rows.forEach(row => {
      Object.entries(row.counts).forEach(([code, v]) => { typeTotals[code] = (typeTotals[code] || 0) + v; });
    });
    const grandTotal = Object.values(typeTotals).reduce((s, v) => s + v, 0);
    const footerCells = r.types.map(t => {
      const v = typeTotals[t.code] || 0;
      return `<td class="num"><strong>${v ? v.toFixed(1).replace(/\.0$/, '') : '—'}</strong></td>`;
    }).join('');

    document.getElementById('lv-rp-out').innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(periodLabel)} — leave summary</div>
        ${hasAny ? '' : '<p class="muted" style="font-size:13px;">No approved leaves in this period.</p>'}
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Associate</th>${headerCells}<th class="num">Total</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="background:#f8fafc;font-weight:600;">
            <td>Total</td>${footerCells}
            <td class="num"><strong>${grandTotal ? grandTotal.toFixed(1).replace(/\.0$/, '') : '—'}</strong></td>
          </tr></tfoot>
        </table></div>
      </div>`;
  }

  function renderUserDeepDive(r) {
    const headerCells = r.types.map(t =>
      `<th class="num" title="${escapeHtml(t.name)}"><span style="display:inline-block;width:8px;height:8px;background:${t.color};border-radius:50%;margin-right:4px;"></span>${escapeHtml(t.code)}</th>`
    ).join('');
    const monthRows = r.months.map(mo => {
      const cells = r.types.map(t => {
        const v = mo.counts[t.code] || 0;
        return `<td class="num" style="${v > 0 ? '' : 'color:#cbd5e1;'}">${v ? v.toFixed(1).replace(/\.0$/, '') : '—'}</td>`;
      }).join('');
      return `<tr>
        <td>${mo.label} ${r.year}</td>
        ${cells}
        <td class="num"><strong>${mo.total ? mo.total.toFixed(1).replace(/\.0$/, '') : '—'}</strong></td>
      </tr>`;
    }).join('');
    const totalCells = r.types.map(t => {
      const v = r.year_totals[t.code] || 0;
      return `<td class="num"><strong>${v ? v.toFixed(1).replace(/\.0$/, '') : '—'}</strong></td>`;
    }).join('');

    // Current balances strip
    const balCards = r.balances.length
      ? r.balances.map(b => {
          const allocated = b.allocated + b.carried_forward;
          const avail = allocated - b.used - b.pending;
          return `<div class="kpi"><h4>${escapeHtml(b.type_code)}</h4>
            <div class="val">${avail.toFixed(1)}</div>
            <div class="sub">Used ${b.used.toFixed(1)} / Quota ${allocated.toFixed(1)}${b.pending > 0 ? ' · ' + b.pending.toFixed(1) + ' pending' : ''}</div>
          </div>`;
        }).join('')
      : '<p class="muted" style="font-size:13px;">No balance rows yet for this year.</p>';

    // Approved applications list
    const appList = r.applications.length
      ? r.applications.map(a => {
          const range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
          const session = a.half_day_session === 'full' ? '' : ' (' + (a.half_day_session === 'first_half' ? '1st half' : '2nd half') + ')';
          return `<tr>
            <td>${range}${session}</td>
            <td><span style="background:${(a.color||'#3b82f6')}20;color:${a.color||'#3b82f6'};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${escapeHtml(a.type_code)}</span></td>
            <td class="num">${a.days}</td>
            <td>${escapeHtml(a.reason || '')}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" class="muted" style="text-align:center;padding:14px;">No approved leaves in ' + r.year + '</td></tr>';

    document.getElementById('lv-rp-out').innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(r.user.full_name)} — ${r.year}</div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 10px;">${escapeHtml(r.user.designation || '')} · ${escapeHtml(r.user.email)}</p>
        <div class="kpi-grid" style="margin-top:8px;">${balCards}</div>
      </div>
      <div class="card" style="margin-top:14px;">
        <div class="card-title">Month-by-month breakdown</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Month</th>${headerCells}<th class="num">Total</th></tr></thead>
          <tbody>${monthRows}</tbody>
          <tfoot><tr style="background:#f8fafc;font-weight:600;">
            <td>Year total</td>${totalCells}
            <td class="num"><strong>${r.year_total ? r.year_total.toFixed(1) : '—'}</strong></td>
          </tr></tfoot>
        </table></div>
      </div>
      <div class="card" style="margin-top:14px;">
        <div class="card-title">All approved applications in ${r.year}</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Dates</th><th>Type</th><th class="num">Days</th><th>Reason</th></tr></thead>
          <tbody>${appList}</tbody>
        </table></div>
      </div>`;
  }

  window.exportLeaveReportCSV = function() {
    if (!_lastReport) { alert('Run a report first.'); return; }
    let csv = '';
    if (_lastReport.kind === 'summary') {
      const r = _lastReport.data;
      const periodLabel = r.month ? r.year + '-' + String(r.month).padStart(2, '0') : r.year + ' (full year)';
      const header = ['Associate','Email','Designation', ...r.types.map(t => t.code), 'Total'];
      csv = header.map(h => '"' + h.replace(/"/g,'""') + '"').join(',') + '\n';
      r.rows.forEach(row => {
        const cells = [row.full_name, row.email, row.designation || '',
          ...r.types.map(t => row.counts[t.code] || 0),
          row.total];
        csv += cells.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',') + '\n';
      });
      downloadCSV(csv, 'leave-summary-' + periodLabel.replace(/[^\w-]/g, '_') + '.csv');
    } else {
      const r = _lastReport.data;
      const header = ['Month', ...r.types.map(t => t.code), 'Total'];
      csv = header.map(h => '"' + h.replace(/"/g,'""') + '"').join(',') + '\n';
      r.months.forEach(mo => {
        const cells = [mo.label + ' ' + r.year,
          ...r.types.map(t => mo.counts[t.code] || 0),
          mo.total];
        csv += cells.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',') + '\n';
      });
      // Total row
      const totalRow = ['Year total',
        ...r.types.map(t => r.year_totals[t.code] || 0),
        r.year_total];
      csv += totalRow.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',') + '\n';
      downloadCSV(csv, 'leave-deepdive-' + r.user.full_name.replace(/[^\w]/g, '_') + '-' + r.year + '.csv');
    }
  };

  function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    URL.revokeObjectURL(url);
  }

  // Sub-tab hooks for the outer Leaves panel.
  // Scoped to the DIRECT child .subtabs so the click handler doesn't also fire
  // for the nested WFH sub-tab buttons that live inside stab-lv-wfh.
  document.querySelectorAll('#tab-leaves > .subtabs > .subtab-btn[data-stab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.stab;
      if (id === 'stab-lv-pending')  loadLeavesDashboard();
      if (id === 'stab-lv-all')      {
        // Populate user filter once
        const sel = document.getElementById('lv-af-user');
        if (sel && sel.options.length <= 1) {
          USERS.forEach(u => { const o = document.createElement('option'); o.value = u.id; o.textContent = u.full_name; sel.appendChild(o); });
        }
        if (!document.getElementById('lv-af-from').value) {
          setVal('lv-af-from', monthStartISO()); setVal('lv-af-to', todayISO());
        }
        loadAllLeaves();
      }
      if (id === 'stab-lv-balances') loadLeaveBalances();
      if (id === 'stab-lv-holidays') loadHolidaysAdmin();
      if (id === 'stab-lv-types')    loadLeaveTypesTable();
      if (id === 'stab-lv-reports')  { initLeaveReportsUI(); runLeaveReport(); }
      // WFH lives nested inside the Leaves panel. Loading the dashboard here
      // also refreshes the inner WFH default sub-tab (stab-wfh-pending).
      if (id === 'stab-lv-wfh')      loadWfhDashboard();
    });
  });

  // ══ SUPER ADMIN ══════════════════════════════════════════════════════
  let MY_PERMISSIONS = new Set();
  let MY_ROLE_CODE = null;
  let IMPERSONATOR = null;
  let ALL_ROLES = [];

  function can(perm) {
    if (MY_ROLE_CODE === 'super_admin') return true;
    return MY_PERMISSIONS.has(perm);
  }

  async function loadMe() {
    try {
      const r = await api('/api/admin-tools/me/permissions');
      MY_PERMISSIONS = new Set(r.permissions);
      MY_ROLE_CODE = r.user.role_code || r.user.legacy_role;
      IMPERSONATOR = r.impersonator || null;
      // Show super-admin tab only to super_admins
      const sBtn = document.getElementById('tab-superadmin-btn');
      if (sBtn && MY_ROLE_CODE === 'super_admin') sBtn.style.display = '';
      // Show impersonation banner if applicable
      renderImpersonationBanner();
    } catch (e) { console.error('Failed to load /me/permissions:', e); }
  }

  function renderImpersonationBanner() {
    let banner = document.getElementById('impersonation-banner');
    if (!IMPERSONATOR) { if (banner) banner.remove(); return; }
    if (banner) return; // already rendered
    banner = document.createElement('div');
    banner.id = 'impersonation-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ef4444;color:white;text-align:center;padding:8px 12px;z-index:9999;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
    banner.innerHTML = `🔴 IMPERSONATING — ${escapeHtml(IMPERSONATOR.full_name)} (${escapeHtml(IMPERSONATOR.email)}) is acting as you.
      <button onclick="stopImpersonation()" style="margin-left:14px;background:white;color:#ef4444;border:none;padding:4px 12px;border-radius:4px;font-weight:600;cursor:pointer;">Stop Impersonating</button>`;
    document.body.appendChild(banner);
    document.body.style.paddingTop = '40px';
  }

  window.stopImpersonation = async function() {
    try {
      await api('/api/admin-tools/impersonate/stop', { method:'POST', body:{} });
      // Restore the original super-admin's token from the backup slot.
      const orig = localStorage.getItem('ap_ts_token_original');
      const origUser = localStorage.getItem('ap_ts_user_original');
      if (orig && origUser) {
        localStorage.setItem('ap_ts_token', orig);
        localStorage.setItem('ap_ts_user', origUser);
        localStorage.removeItem('ap_ts_token_original');
        localStorage.removeItem('ap_ts_user_original');
      }
      window.location.reload();
    } catch (e) { alert(e.message); }
  };

  // ── Recycle Bin ───────────────────────────────────────────────────────
  window.loadRecycleBin = async function() {
    try {
      const rb = await api('/api/admin-tools/recycle-bin');
      const c = rb.users.length, cl = rb.clients.length, m = rb.matters.length, i = rb.invoices.length;
      document.getElementById('rb-summary').innerHTML = `
        <div class="kpi"><h4>Deleted Users</h4><div class="val">${c}</div></div>
        <div class="kpi"><h4>Deleted Clients</h4><div class="val">${cl}</div></div>
        <div class="kpi"><h4>Deleted Matters</h4><div class="val">${m}</div></div>
        <div class="kpi"><h4>Deleted Invoices</h4><div class="val">${i}</div></div>
      `;

      const renderBlock = (rows, fields, restorePath, emptyMsg) => {
        if (!rows.length) return `<p class="muted" style="padding:10px;font-size:13px;">${emptyMsg}</p>`;
        const head = '<tr>' + fields.map(f => `<th>${escapeHtml(f.label)}</th>`).join('') + '<th></th></tr>';
        const body = rows.map(r =>
          '<tr>' + fields.map(f => `<td>${escapeHtml(f.get(r) || '')}</td>`).join('') +
          `<td><button class="btn btn-sm btn-accent" onclick="restoreFromBin('${restorePath}', ${r.id})">↻ Restore</button></td></tr>`
        ).join('');
        return `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
      };

      document.getElementById('rb-users').innerHTML = renderBlock(rb.users,
        [{label:'Email', get:r=>r.email}, {label:'Name', get:r=>r.full_name}, {label:'Role', get:r=>r.role}, {label:'Deleted on', get:r=>fmtDate(r.deleted_at)}, {label:'Deleted by', get:r=>r.deleted_by_name}],
        'users', 'No deleted users.');
      document.getElementById('rb-clients').innerHTML = renderBlock(rb.clients,
        [{label:'Code', get:r=>r.code}, {label:'Name', get:r=>r.name}, {label:'Deleted on', get:r=>fmtDate(r.deleted_at)}, {label:'Deleted by', get:r=>r.deleted_by_name}],
        'clients', 'No deleted clients.');
      document.getElementById('rb-matters').innerHTML = renderBlock(rb.matters,
        [{label:'File No.', get:r=>r.file_no}, {label:'Title', get:r=>r.title}, {label:'Client', get:r=>r.client_name}, {label:'Deleted on', get:r=>fmtDate(r.deleted_at)}, {label:'Deleted by', get:r=>r.deleted_by_name}],
        'matters', 'No deleted matters.');
      document.getElementById('rb-invoices').innerHTML = renderBlock(rb.invoices,
        [{label:'No.', get:r=>r.invoice_no}, {label:'Client', get:r=>r.client_name}, {label:'Total', get:r=>fmtMoney(r.total, r.currency)}, {label:'Deleted on', get:r=>fmtDate(r.deleted_at)}, {label:'Deleted by', get:r=>r.deleted_by_name}],
        'invoices', 'No deleted invoices.');
    } catch (e) { showAlert('alert', e.message); }
  };

  window.restoreFromBin = async function(entityType, id) {
    if (!confirm(`Restore this ${entityType.slice(0,-1)}? It will be reactivated immediately.`)) return;
    try {
      await api(`/api/admin-tools/recycle-bin/${entityType}/${id}/restore`, { method:'POST', body:{} });
      loadRecycleBin();
      if (entityType === 'users') loadUsersTable();
    } catch (e) { alert(e.message); }
  };

  // ── Roles list (read-only view for now; full matrix editor in next phase) ──
  window.loadRolesTable = async function() {
    try {
      const r = await api('/api/admin-tools/roles');
      ALL_ROLES = r.roles;
      const rows = r.roles.map(rl =>
        `<tr>
          <td><strong>${escapeHtml(rl.code)}</strong>${rl.is_system ? ' <span class="muted" style="font-size:10px;">(system)</span>' : ''}</td>
          <td>${escapeHtml(rl.name)}</td>
          <td>${escapeHtml(rl.description || '')}</td>
          <td class="num">${rl.permission_count}</td>
          <td class="num">${rl.user_count}</td>
        </tr>`
      ).join('');
      document.getElementById('sa-roles-table').innerHTML =
        '<table class="data"><thead><tr><th>Code</th><th>Name</th><th>Description</th><th class="num">Permissions</th><th class="num">Users</th></tr></thead><tbody>' +
        rows + '</tbody></table>';
      loadSAUsersTable();
    } catch (e) { showAlert('alert', e.message); }
  };

  async function loadSAUsersTable() {
    try {
      const r = await api('/api/users');
      const rows = r.users.filter(u => !u.deleted_at).map(u => {
        const roleOpts = ALL_ROLES.map(rl =>
          `<option value="${rl.id}" ${u.role_id === rl.id ? 'selected' : ''}>${escapeHtml(rl.name)} (${escapeHtml(rl.code)})</option>`
        ).join('');
        return `<tr>
          <td>${escapeHtml(u.full_name)}<div style="font-size:10px;color:var(--muted);">${escapeHtml(u.email)}</div></td>
          <td>${escapeHtml(u.designation || '')}</td>
          <td><select onchange="changeUserRole(${u.id}, this.value)" style="padding:4px 8px;font-size:12px;">${roleOpts}</select></td>
          <td><span style="color:${u.is_active ? '#10b981' : '#9ca3af'};">${u.is_active ? 'Active' : 'Inactive'}</span></td>
          <td style="white-space:nowrap;">
            <button class="btn btn-sm btn-ghost" onclick="openForceResetModal(${u.id}, '${escapeHtml(u.email)}', '${escapeHtml(u.full_name)}')">🔑 Reset Password</button>
            <button class="btn btn-sm btn-ghost" onclick="impersonateUser(${u.id}, '${escapeHtml(u.full_name)}')">👤 Login as</button>
          </td>
        </tr>`;
      }).join('');
      document.getElementById('sa-users-table').innerHTML =
        '<table class="data"><thead><tr><th>User</th><th>Designation</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table>';
    } catch (e) { showAlert('alert', e.message); }
  }

  window.changeUserRole = async function(userId, roleId) {
    try {
      await api(`/api/admin-tools/users/${userId}/role`, { method:'POST', body:{ role_id: parseInt(roleId, 10) } });
      showAlert('alert', 'Role updated.', 'success');
      loadRolesTable();
    } catch (e) { showAlert('alert', e.message); }
  };

  // ── Force password reset ─────────────────────────────────────────────
  let SA_RESET_USER_ID = null;
  window.openForceResetModal = function(userId, email, fullName) {
    SA_RESET_USER_ID = userId;
    document.getElementById('sa-reset-user').textContent = `${fullName} (${email})`;
    document.getElementById('sa-reset-pw').value = '';
    document.getElementById('sa-reset-alert').className = 'alert hidden';
    document.getElementById('sa-reset-result').style.display = 'none';
    document.getElementById('sa-reset-submit-btn').style.display = '';
    document.getElementById('sa-reset-modal').classList.remove('hidden');
  };
  window.closeForceResetModal = function() { document.getElementById('sa-reset-modal').classList.add('hidden'); };
  window.submitForceReset = async function() {
    if (!SA_RESET_USER_ID) return;
    const pw = document.getElementById('sa-reset-pw').value.trim();
    const body = pw ? { new_password: pw } : {};
    try {
      const r = await api(`/api/admin-tools/users/${SA_RESET_USER_ID}/force-reset-password`, { method:'POST', body });
      document.getElementById('sa-reset-pw-out').textContent = r.temp_password;
      document.getElementById('sa-reset-result').style.display = '';
      document.getElementById('sa-reset-submit-btn').style.display = 'none';
    } catch (e) { showAlert('sa-reset-alert', e.message); }
  };

  // ── Impersonation ────────────────────────────────────────────────────
  window.impersonateUser = async function(userId, fullName) {
    if (!confirm(`Log in as "${fullName}"?\n\nYou'll see the system from their perspective. Every action gets audit-logged with your name as the impersonator. Click "Stop Impersonating" in the red banner to return to your own account.`)) return;
    try {
      const r = await api(`/api/admin-tools/users/${userId}/impersonate`, { method:'POST', body:{} });
      // Backup current super_admin session so we can restore on stop.
      localStorage.setItem('ap_ts_token_original', Auth.token());
      localStorage.setItem('ap_ts_user_original', JSON.stringify(Auth.user()));
      // Switch to impersonation token + user.
      Auth.setSession(r.token, r.user);
      window.location.href = r.user.role === 'associate' ? '/associate' : '/admin';
    } catch (e) { alert(e.message); }
  };

  // Wire sub-tab clicks for super-admin panel
  document.querySelectorAll('#tab-superadmin .subtab-btn[data-stab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.stab;
      if (id === 'stab-sa-recycle') loadRecycleBin();
      if (id === 'stab-sa-roles')   loadRolesTable();
      if (id === 'stab-sa-security') { loadLoginHistory(); loadActiveSessions(); loadLockedAccounts(); loadSecurityPosture(); }
      if (id === 'stab-sa-system')  { loadStorageStats(); loadBackupList(); }
    });
  });

  // ══ SYSTEM TAB ════════════════════════════════════════════════════════
  // Helpers shared by Backup / Storage / Scan cards.
  function fmtKB(kb) {
    if (kb == null) return '—';
    if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
    return Math.round(kb) + ' KB';
  }
  function fmtMB(mb) { return mb == null ? '—' : Number(mb).toFixed(2) + ' MB'; }

  window.runBackupNow = async function(btnRef) {
    const btn = btnRef || (typeof event !== 'undefined' ? event.target : null);
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Running...'; }
    try {
      const r = await api('/api/admin-tools/backup/run', { method:'POST', body:{} });
      document.getElementById('sa-backup-result').innerHTML =
        `<div style="background:#dcfce7;border:1px solid #16a34a;padding:10px 12px;border-radius:6px;font-size:13px;">
           ✅ Backup saved: <code style="background:#fff;padding:2px 6px;border-radius:4px;">${escapeHtml(r.file)}</code>
           · ${r.size_kb} KB · into <code style="font-size:11px;">${escapeHtml(r.dir)}</code>
         </div>`;
      loadBackupList();
    } catch(e) {
      document.getElementById('sa-backup-result').innerHTML =
        `<div style="background:#fee2e2;border:1px solid #ef4444;padding:10px 12px;border-radius:6px;font-size:13px;">❌ ${escapeHtml(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  };

  window.loadBackupList = async function() {
    try {
      const r = await api('/api/admin-tools/backup/list');
      const listEl   = document.getElementById('sa-backup-list');
      const hourlyEl = document.getElementById('sa-hourly-list');

      // Daily backups table
      if (!r.backups.length) {
        listEl.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:10px;">No daily backups in <code>${escapeHtml(r.dir)}</code> yet.</p>`;
      } else {
        listEl.innerHTML = `
          <p style="font-size:11px;color:var(--muted);margin:6px 0;">Location: <code>${escapeHtml(r.dir)}</code></p>
          <table class="data"><thead><tr><th>File</th><th class="num">Size</th><th>Created</th><th>Type</th></tr></thead><tbody>
          ${r.backups.map(b => `<tr>
            <td><code style="font-size:11px;">${escapeHtml(b.name)}</code></td>
            <td class="num">${b.size_kb} KB</td>
            <td>${fmtDate(b.mtime)} ${b.mtime.slice(11,19)}</td>
            <td>${b.name.includes('manual') ? '<span style="background:#3b82f620;color:#3b82f6;padding:2px 8px;border-radius:10px;font-size:11px;">Manual</span>' : b.name.includes('predeploy') ? '<span style="background:#f59e0b20;color:#f59e0b;padding:2px 8px;border-radius:10px;font-size:11px;">Pre-deploy</span>' : '<span style="background:#10b98120;color:#10b981;padding:2px 8px;border-radius:10px;font-size:11px;">Daily</span>'}</td>
          </tr>`).join('')}
          </tbody></table>`;
      }

      // Hourly snapshots table
      if (hourlyEl) {
        if (!r.hourly || !r.hourly.length) {
          hourlyEl.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:10px;">No hourly snapshots yet. The HourlyBackup task runs every hour after install-tasks.ps1 is registered.</p>`;
        } else {
          hourlyEl.innerHTML = `
            <table class="data"><thead><tr><th>File</th><th class="num">Size</th><th>Captured</th></tr></thead><tbody>
            ${r.hourly.map(b => `<tr>
              <td><code style="font-size:11px;">${escapeHtml(b.name)}</code></td>
              <td class="num">${b.size_kb} KB</td>
              <td>${fmtDate(b.mtime)} ${b.mtime.slice(11,19)}</td>
            </tr>`).join('')}
            </tbody></table>`;
        }
      }

      // Integrity status banner
      loadIntegrityStatus();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.loadIntegrityStatus = async function() {
    const el = document.getElementById('sa-integrity-status');
    if (!el) return;
    try {
      const r = await api('/api/admin-tools/backup/integrity-history');
      if (!r.entries.length) {
        el.innerHTML = `<div style="background:#f3f4f6;border:1px solid #d1d5db;padding:10px 12px;border-radius:6px;font-size:13px;">⏳ No integrity verification log yet — run a backup to populate.</div>`;
        return;
      }
      const latest = r.entries[0];
      const okEntry = r.latest_ok;
      const failEntry = r.latest_failure;

      const ts = new Date(latest.timestamp.replace(' ', 'T') + 'Z').getTime();
      const ageMin = Math.round((Date.now() - ts) / 60000);
      const ageStr = ageMin < 60 ? `${ageMin} min ago` : ageMin < 1440 ? `${Math.round(ageMin/60)} hr ago` : `${Math.round(ageMin/1440)} day ago`;

      const okBanner = latest.ok
        ? `<div style="background:#dcfce7;border:1px solid #16a34a;padding:10px 12px;border-radius:6px;font-size:13px;">
             ✅ <strong>Last verified OK:</strong> ${escapeHtml(latest.timestamp)} (${ageStr}) ·
             integrity=<code>${escapeHtml(latest.integrity || '—')}</code> ·
             FK violations=<code>${latest.fk_violations ?? '—'}</code> ·
             ${latest.counts ? `users=${latest.counts.users} · invoices=${latest.counts.invoices} · timesheet=${latest.counts.timesheet_entries}` : ''}
           </div>`
        : `<div style="background:#fee2e2;border:1px solid #ef4444;padding:10px 12px;border-radius:6px;font-size:13px;">
             ❌ <strong>Latest backup integrity FAILED</strong> at ${escapeHtml(latest.timestamp)} (${ageStr})<br>
             ${latest.error ? 'Error: <code>' + escapeHtml(latest.error) + '</code>' : 'integrity=' + escapeHtml(latest.integrity || '—') + ' FK=' + latest.fk_violations}
             ${okEntry ? `<br><span style="color:var(--muted);">Last successful: ${escapeHtml(okEntry.timestamp)}</span>` : ''}
           </div>`;
      el.innerHTML = okBanner;
    } catch(e) {
      el.innerHTML = `<div style="background:#fef3c7;border:1px solid #f59e0b;padding:10px 12px;border-radius:6px;font-size:13px;">⚠ Could not load integrity log: ${escapeHtml(e.message)}</div>`;
    }
  };

  window.loadStorageStats = async function() {
    try {
      const r = await api('/api/admin-tools/storage');
      const dbTotal = r.database.total_kb;
      const totalMB = (r.folders.uploads_mb + r.folders.logs_mb + r.folders.backups_mb + (dbTotal/1024));
      document.getElementById('sa-storage').innerHTML = `
        <div class="kpi"><h4>Database</h4><div class="val">${fmtKB(dbTotal)}</div><div class="sub">${r.database.main_kb} main · ${r.database.wal_kb} WAL · ${r.database.shm_kb} shm</div></div>
        <div class="kpi"><h4>Uploads</h4><div class="val">${fmtMB(r.folders.uploads_mb)}</div><div class="sub">timesheet attachments</div></div>
        <div class="kpi"><h4>Logs</h4><div class="val">${fmtMB(r.folders.logs_mb)}</div><div class="sub">app + PM2 output</div></div>
        <div class="kpi"><h4>Backups</h4><div class="val">${fmtMB(r.folders.backups_mb)}</div><div class="sub">${r.disk.free_gb != null ? r.disk.free_gb + ' GB disk free' : ''}</div></div>
      `;
      document.getElementById('sa-storage-paths').innerHTML = `
        <div><strong>Record counts:</strong>
          Users ${r.counts.users} · Clients ${r.counts.clients} · Matters ${r.counts.matters} ·
          Invoices ${r.counts.invoices} · Timesheet entries ${r.counts.timesheet_entries} ·
          Leave applications ${r.counts.leave_applications} · Audit log ${r.counts.audit_log}</div>
        <div style="margin-top:6px;"><strong>Disk:</strong>
          ${r.disk.free_gb != null ? r.disk.free_gb + ' GB free of ' + r.disk.total_gb + ' GB total' : '(stat unavailable)'}</div>
        <div style="margin-top:6px;"><strong>Paths:</strong></div>
        <ul style="margin:2px 0 0 18px;padding:0;">
          <li>DB: <code>${escapeHtml(r.paths.db)}</code></li>
          <li>Uploads: <code>${escapeHtml(r.paths.uploads)}</code></li>
          <li>Logs: <code>${escapeHtml(r.paths.logs)}</code></li>
          <li>Backups: <code>${escapeHtml(r.paths.backups)}</code></li>
        </ul>`;
    } catch(e) { showAlert('alert', e.message); }
  };

  window.runSystemScan = async function(btnRef) {
    // Always show IMMEDIATE feedback in result div before anything else, so
    // the user can confirm the click fired even if the API call hangs/fails.
    const out = document.getElementById('sa-scan-result');
    if (!out) {
      alert('Scan result panel missing from the page. Try Ctrl+Shift+R to hard-refresh.');
      return;
    }
    out.innerHTML = `<div style="background:#dbeafe;border:1px solid #3b82f6;padding:10px 12px;border-radius:6px;font-size:13px;">⏳ Running system checks… please wait (5-15 seconds).</div>`;

    // Best-effort: disable the button. Don't crash if btn missing.
    const btn = btnRef || document.querySelector('#stab-sa-system button[onclick*="runSystemScan"]');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }

    try {
      console.log('[scan] calling /api/admin-tools/scan');
      const r = await api('/api/admin-tools/scan', { method:'POST', body:{} });
      console.log('[scan] response:', r);

      if (!r || !Array.isArray(r.checks)) {
        out.innerHTML = `<div style="background:#fee2e2;border:1px solid #ef4444;padding:10px 12px;border-radius:6px;font-size:13px;">❌ Scan returned an unexpected response. Check console for details.</div>`;
        return;
      }

      const banner = r.ok
        ? `<div style="background:#dcfce7;border:1px solid #16a34a;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:10px;">✅ All checks passed. System healthy.</div>`
        : `<div style="background:#fee2e2;border:1px solid #ef4444;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:10px;">⚠ One or more checks failed — see details below.</div>`;
      const rows = r.checks.map(c =>
        `<tr><td style="width:34px;text-align:center;font-size:16px;">${c.ok ? '✅' : '❌'}</td>
             <td style="font-weight:600;width:200px;">${escapeHtml(c.name)}</td>
             <td style="font-size:13px;color:var(--muted);">${escapeHtml(c.detail)}</td></tr>`
      ).join('');
      out.innerHTML = banner + `<table class="data" style="width:100%;"><tbody>${rows}</tbody></table>`;
    } catch(e) {
      console.error('[scan] failed:', e);
      out.innerHTML = `<div style="background:#fee2e2;border:1px solid #ef4444;padding:10px 12px;border-radius:6px;font-size:13px;">❌ Scan failed: ${escapeHtml(e.message || String(e))}<br><small>Check the browser console (F12) for full details.</small></div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  };

  // ══ SECURITY TAB ══════════════════════════════════════════════════════
  window.loadLoginHistory = async function() {
    try {
      const email = (document.getElementById('sec-login-email') || {}).value || '';
      const q = email ? `?email=${encodeURIComponent(email)}&limit=200` : '?limit=200';
      const r = await api('/api/auth/login-history' + q);
      const el = document.getElementById('sa-login-history');
      if (!r.login_history.length) {
        el.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:10px;">No login attempts recorded yet.</p>';
        return;
      }
      el.innerHTML = `
        <table class="data" style="width:100%;font-size:12px;"><thead><tr>
          <th>Status</th><th>Email</th><th>Name</th><th>IP Address</th><th>Reason</th><th>Time</th>
        </tr></thead><tbody>
        ${r.login_history.map(a => `<tr style="${!a.success ? 'background:#fee2e220;' : ''}">
          <td>${a.success ? '<span style="color:#16a34a;font-weight:600;">✅ OK</span>' : '<span style="color:#ef4444;font-weight:600;">❌ FAIL</span>'}</td>
          <td>${escapeHtml(a.email)}</td>
          <td>${escapeHtml(a.full_name || '—')}</td>
          <td><code style="font-size:11px;">${escapeHtml(a.ip_address || '—')}</code></td>
          <td style="color:var(--muted);">${a.failure_reason ? escapeHtml(a.failure_reason) : '—'}</td>
          <td style="white-space:nowrap;">${fmtDate(a.attempted_at)} ${(a.attempted_at||'').slice(11,19)}</td>
        </tr>`).join('')}
        </tbody></table>`;
    } catch(e) { showAlert('alert', e.message); }
  };

  window.loadActiveSessions = async function() {
    try {
      const r = await api('/api/auth/active-sessions');
      const el = document.getElementById('sa-active-sessions');
      if (!r.sessions.length) {
        el.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:10px;">No active sessions.</p>';
        return;
      }
      el.innerHTML = `
        <table class="data" style="width:100%;font-size:12px;"><thead><tr>
          <th>User</th><th>Email</th><th>IP</th><th>Login Time</th><th>Expires</th><th>Action</th>
        </tr></thead><tbody>
        ${r.sessions.map(s => `<tr>
          <td><strong>${escapeHtml(s.full_name)}</strong></td>
          <td>${escapeHtml(s.email)}</td>
          <td><code style="font-size:11px;">${escapeHtml(s.ip_address || '—')}</code></td>
          <td style="white-space:nowrap;">${fmtDate(s.created_at)} ${(s.created_at||'').slice(11,19)}</td>
          <td style="white-space:nowrap;">${fmtDate(s.expires_at)} ${(s.expires_at||'').slice(11,19)}</td>
          <td><button class="btn btn-sm" style="background:#ef4444;color:#fff;font-size:11px;padding:3px 10px;" onclick="revokeSession(${s.id})">⛔ Force Logout</button></td>
        </tr>`).join('')}
        </tbody></table>`;
    } catch(e) { showAlert('alert', e.message); }
  };

  window.revokeSession = async function(id) {
    if (!confirm('Force logout this user? Their current session will be immediately terminated.')) return;
    try {
      await api(`/api/auth/sessions/${id}/revoke`, { method:'POST', body:{} });
      showAlert('alert', 'Session revoked — user has been force-logged out.', 'success');
      loadActiveSessions();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.loadLockedAccounts = async function() {
    try {
      const users = await api('/api/users');
      const locked = (users.users || users).filter(u => u.locked_until);
      const el = document.getElementById('sa-locked-accounts');
      if (!locked.length) {
        el.innerHTML = '<p style="color:#16a34a;font-size:13px;padding:10px;">✅ No accounts are currently locked.</p>';
        return;
      }
      el.innerHTML = `
        <table class="data" style="width:100%;font-size:12px;"><thead><tr>
          <th>User</th><th>Email</th><th>Failed Attempts</th><th>Locked Until</th><th>Action</th>
        </tr></thead><tbody>
        ${locked.map(u => `<tr style="background:#fee2e220;">
          <td><strong>${escapeHtml(u.full_name)}</strong></td>
          <td>${escapeHtml(u.email)}</td>
          <td class="num">${u.failed_login_count || 0}</td>
          <td style="white-space:nowrap;">${fmtDate(u.locked_until)} ${(u.locked_until||'').slice(11,19)}</td>
          <td><button class="btn btn-sm btn-accent" style="font-size:11px;padding:3px 10px;" onclick="unlockAccount(${u.id})">🔓 Unlock</button></td>
        </tr>`).join('')}
        </tbody></table>`;
    } catch(e) { showAlert('alert', e.message); }
  };

  window.unlockAccount = async function(userId) {
    if (!confirm('Unlock this account? The user will be able to try logging in again.')) return;
    try {
      const r = await api(`/api/auth/users/${userId}/unlock`, { method:'POST', body:{} });
      showAlert('alert', r.message || 'Account unlocked', 'success');
      loadLockedAccounts();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.loadSecurityPosture = async function() {
    try {
      const el = document.getElementById('sa-security-posture');
      // Count recent login failures (last 24h)
      let recentFails = 0, recentSuccess = 0, totalSessions = 0;
      try {
        const h = await api('/api/auth/login-history?limit=500');
        const cutoff = new Date(Date.now() - 24*3600000).toISOString();
        const recent = h.login_history.filter(a => a.attempted_at >= cutoff);
        recentFails   = recent.filter(a => !a.success).length;
        recentSuccess = recent.filter(a => a.success).length;
      } catch(_) {}
      try {
        const s = await api('/api/auth/active-sessions');
        totalSessions = s.sessions.length;
      } catch(_) {}
      el.innerHTML = `
        <div class="kpi"><h4>Active Sessions</h4><div class="val">${totalSessions}</div><div class="sub">Currently logged-in users</div></div>
        <div class="kpi"><h4>Failed Logins (24h)</h4><div class="val" style="${recentFails > 10 ? 'color:#ef4444;' : ''}">${recentFails}</div><div class="sub">${recentFails > 10 ? '⚠ Unusual activity' : 'Normal'}</div></div>
        <div class="kpi"><h4>Successful Logins (24h)</h4><div class="val">${recentSuccess}</div></div>
        <div class="kpi"><h4>Protection</h4><div class="val" style="font-size:14px;">🛡️ Active</div>
          <div class="sub" style="font-size:11px;line-height:1.6;">
            ✅ Rate Limiting (10/15min)<br>
            ✅ Account Lockout (5 fails)<br>
            ✅ Helmet Security Headers<br>
            ✅ HSTS + CSP + XSS Guard<br>
            ✅ Session Revocation<br>
            ✅ Audit Trail
          </div>
        </div>
      `;
    } catch(e) { console.error('Security posture error', e); }
  };

  // ══ WORK FROM HOME ════════════════════════════════════════════════════
  window.loadWfhDashboard = async function() {
    try {
      const d = await api('/api/wfh/dashboard');
      const onWfhList = d.on_wfh_today.length
        ? d.on_wfh_today.map(x =>
            `<span style="display:inline-block;background:#3b82f620;color:#3b82f6;padding:2px 8px;border-radius:10px;font-size:11px;margin:2px;font-weight:600;">🏠 ${escapeHtml(x.full_name)}${x.designation ? ' · ' + escapeHtml(x.designation) : ''}</span>`
          ).join('')
        : '<span class="muted" style="font-size:13px;">No one is working from home today.</span>';
      const upcomingList = d.upcoming_wfh.length
        ? d.upcoming_wfh.slice(0, 6).map(u =>
            `<div style="font-size:12px;padding:3px 0;"><strong>${escapeHtml(u.full_name)}</strong> · ${fmtDate(u.from_date)}${u.from_date !== u.to_date ? ' → ' + fmtDate(u.to_date) : ''} (${u.days}d)</div>`
          ).join('')
        : '<span class="muted" style="font-size:13px;">No upcoming WFH scheduled.</span>';
      document.getElementById('wfh-dash').innerHTML = `
        <div class="kpi"><h4>Pending approvals</h4><div class="val">${d.pending_count}</div></div>
        <div class="kpi" style="grid-column:span 2;"><h4>On WFH today</h4><div style="margin-top:6px;">${onWfhList}</div></div>
        <div class="kpi" style="grid-column:span 2;"><h4>Upcoming WFH</h4><div style="margin-top:6px;">${upcomingList}</div></div>
      `;
      // Sync both the inner sub-sub-tab badge AND the outer Leaves "🏠 WFH" badge.
      for (const bid of ['wfh-pending-count', 'wfh-outer-badge']) {
        const b = document.getElementById(bid);
        if (b) {
          if (d.pending_count > 0) { b.style.display = 'inline-block'; b.textContent = d.pending_count; }
          else b.style.display = 'none';
        }
      }
      loadPendingWfh();
    } catch(e) { console.error('WFH dashboard error', e); }
  };

  async function loadPendingWfh() {
    try {
      const r = await api('/api/wfh/applications?status=submitted');
      renderWfhTable('wfh-pending-table', r.applications, true);
    } catch(e) { console.error(e); }
  }

  window.loadAllWfh = async function() {
    const q = [];
    const u = document.getElementById('wfh-af-user').value; if (u) q.push('user_id=' + u);
    const s = document.getElementById('wfh-af-status').value; if (s) q.push('status=' + s);
    const f = document.getElementById('wfh-af-from').value; if (f) q.push('from=' + f);
    const t = document.getElementById('wfh-af-to').value;   if (t) q.push('to=' + t);
    try {
      const r = await api('/api/wfh/applications' + (q.length ? '?' + q.join('&') : ''));
      renderWfhTable('wfh-all-table', r.applications, true);
    } catch(e) { showAlert('alert', e.message); }
  };

  function renderWfhTable(elId, apps, withActions) {
    if (!apps.length) {
      document.getElementById(elId).innerHTML = '<p class="muted" style="padding:14px;font-size:13px;">No applications.</p>';
      return;
    }
    const statusColors = { submitted:'#f59e0b', approved:'#10b981', rejected:'#ef4444', cancelled:'#6b7280' };
    const rows = apps.map(a => {
      const range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
      const sc = statusColors[a.status] || '#6b7280';
      const badge = `<span style="background:${sc}20;color:${sc};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${a.status}</span>`;
      const actions = (withActions && a.status === 'submitted')
        ? `<button class="btn btn-sm btn-accent" onclick="openWfhDecideModal(${a.id}, 'approved')">✓ Approve</button>
           <button class="btn btn-sm btn-danger" onclick="openWfhDecideModal(${a.id}, 'rejected')">✗ Reject</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(a.user_name)}<div style="font-size:10px;color:var(--muted);">${escapeHtml(a.designation || '')}</div></td>
        <td>${range}</td>
        <td class="num">${a.days}</td>
        <td>${escapeHtml(a.reason)}${a.contact_during_wfh ? '<div style="font-size:10px;color:var(--muted);">Contact: ' + escapeHtml(a.contact_during_wfh) + '</div>' : ''}</td>
        <td>${badge}${a.decided_by_name ? '<div style="font-size:10px;color:var(--muted);">by ' + escapeHtml(a.decided_by_name) + '</div>' : ''}${a.decision_note ? '<div style="font-size:10px;color:var(--muted);">"' + escapeHtml(a.decision_note) + '"</div>' : ''}</td>
        <td style="white-space:nowrap;">${actions}</td>
      </tr>`;
    }).join('');
    document.getElementById(elId).innerHTML = `
      <table class="data"><thead><tr>
        <th>Associate</th><th>Dates</th><th class="num">Days</th><th>Reason</th><th>Status</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ── Decide (approve / reject) ──
  let _wfhDecideId = null, _wfhDecideAction = null;
  window.openWfhDecideModal = function(id, action) {
    _wfhDecideId = id; _wfhDecideAction = action;
    document.getElementById('wfh-decide-title').textContent = (action === 'approved' ? 'Approve' : 'Reject') + ' WFH';
    document.getElementById('wfh-decide-alert').className = 'alert hidden';
    document.getElementById('wfh-decide-note').value = '';
    api('/api/wfh/applications/' + id).then(r => {
      const a = r.application;
      const range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
      document.getElementById('wfh-decide-summary').innerHTML =
        '<strong>' + escapeHtml(a.user_name) + '</strong>' +
        '<br>' + range + ' · ' + a.days + ' day(s)' +
        '<br><span class="muted">Reason: ' + escapeHtml(a.reason) + '</span>';
    });
    const btn = document.getElementById('wfh-decide-confirm');
    btn.className = 'btn ' + (action === 'approved' ? 'btn-accent' : 'btn-danger');
    btn.textContent = action === 'approved' ? '✓ Approve' : '✗ Reject';
    document.getElementById('wfh-decide-modal').classList.remove('hidden');
  };
  window.closeWfhDecideModal = function() { document.getElementById('wfh-decide-modal').classList.add('hidden'); };
  document.getElementById('wfh-decide-confirm').addEventListener('click', async () => {
    if (!_wfhDecideId) return;
    const note = document.getElementById('wfh-decide-note').value.trim();
    try {
      await api('/api/wfh/applications/' + _wfhDecideId + '/' + (_wfhDecideAction === 'approved' ? 'approve' : 'reject'),
        { method: 'POST', body: { note: note || null } });
      closeWfhDecideModal();
      loadWfhDashboard();
      if (document.getElementById('stab-wfh-all').classList.contains('active')) loadAllWfh();
    } catch(e) { showAlert('wfh-decide-alert', e.message); }
  });

  // ── Manual WFH entry (admin filing on behalf) ──
  window.openManualWfhModal = function() {
    document.getElementById('wm-alert').className = 'alert hidden';
    const sel = document.getElementById('wm-user'); sel.innerHTML = '';
    USERS.filter(u => u.is_active && !u.deleted_at).forEach(u => {
      const o = document.createElement('option'); o.value = u.id;
      o.textContent = u.full_name + (u.designation ? ' (' + u.designation + ')' : '');
      sel.appendChild(o);
    });
    setVal('wm-from', todayISO()); setVal('wm-to', todayISO()); setVal('wm-reason', '');
    document.getElementById('wm-auto-approve').checked = true;
    document.getElementById('wfh-manual-modal').classList.remove('hidden');
  };
  window.closeManualWfhModal = function() { document.getElementById('wfh-manual-modal').classList.add('hidden'); };
  window.submitManualWfh = async function() {
    const body = {
      user_id:    parseInt(document.getElementById('wm-user').value, 10),
      from_date:  document.getElementById('wm-from').value,
      to_date:    document.getElementById('wm-to').value,
      reason:     document.getElementById('wm-reason').value.trim(),
      auto_approve: document.getElementById('wm-auto-approve').checked
    };
    if (!body.user_id || !body.from_date || !body.to_date || !body.reason) {
      showAlert('wm-alert', 'All fields required'); return;
    }
    try {
      await api('/api/wfh/applications', { method: 'POST', body });
      closeManualWfhModal();
      loadWfhDashboard();
      if (document.getElementById('stab-wfh-all').classList.contains('active')) loadAllWfh();
    } catch(e) { showAlert('wm-alert', e.message); }
  };

  // ── WFH Reports (pivot summary) ──
  function fillWfhYearSelect() {
    const sel = document.getElementById('wfh-rep-year'); if (!sel || sel.options.length) return;
    const y = new Date().getFullYear();
    for (let i = y - 2; i <= y + 1; i++) {
      const o = document.createElement('option'); o.value = i; o.textContent = i;
      if (i === y) o.selected = true;
      sel.appendChild(o);
    }
  }
  window.loadWfhReport = async function() {
    fillWfhYearSelect();
    const year  = document.getElementById('wfh-rep-year').value;
    const month = document.getElementById('wfh-rep-month').value;
    const q = ['year=' + year]; if (month) q.push('month=' + month);
    try {
      const r = await api('/api/wfh/reports/summary?' + q.join('&'));
      if (!r.rows.length) {
        document.getElementById('wfh-report-out').innerHTML = '<p class="muted" style="font-size:13px;padding:14px;">No data for this period.</p>';
        return;
      }
      const periodLabel = month
        ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month-1]} ${year}`
        : `Year ${year}`;
      const totalDays = r.rows.reduce((s, x) => s + Number(x.total_days), 0);
      const html = `
        <div class="kpi-grid-2" style="margin-bottom:14px;">
          <div class="kpi"><h4>${periodLabel}</h4><div class="val">${totalDays.toFixed(1)}</div><div class="sub">total WFH days across team</div></div>
          <div class="kpi"><h4>Employees with WFH</h4><div class="val">${r.rows.filter(x => x.total_days > 0).length}</div><div class="sub">of ${r.rows.length} active</div></div>
        </div>
        <table class="data"><thead><tr>
          <th>Employee</th><th>Designation</th><th class="num">Applications</th><th class="num">Total Days</th>
        </tr></thead><tbody>
        ${r.rows.map(row => `<tr>
          <td>${escapeHtml(row.full_name)}<div style="font-size:10px;color:var(--muted);">${escapeHtml(row.email)}</div></td>
          <td>${escapeHtml(row.designation || '')}</td>
          <td class="num">${row.application_count}</td>
          <td class="num"><strong>${Number(row.total_days).toFixed(1)}</strong></td>
        </tr>`).join('')}
        </tbody></table>`;
      document.getElementById('wfh-report-out').innerHTML = html;
    } catch(e) { showAlert('alert', e.message); }
  };

  window.exportWfhReportCSV = async function() {
    const year  = document.getElementById('wfh-rep-year').value;
    const month = document.getElementById('wfh-rep-month').value;
    const q = ['year=' + year]; if (month) q.push('month=' + month);
    try {
      const r = await api('/api/wfh/reports/summary?' + q.join('&'));
      const header = ['Employee','Email','Designation','Applications','Total Days'];
      const csv = [header.join(',')].concat(r.rows.map(x => [
        x.full_name, x.email, x.designation || '', x.application_count, Number(x.total_days).toFixed(1)
      ].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','))).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `wfh-report-${year}${month ? '-' + month : ''}.csv`; link.click();
      URL.revokeObjectURL(url);
    } catch(e) { showAlert('alert', e.message); }
  };

  window.exportWfhCSV = async function() {
    const q = [];
    const u = document.getElementById('wfh-af-user').value; if (u) q.push('user_id=' + u);
    const s = document.getElementById('wfh-af-status').value; if (s) q.push('status=' + s);
    const f = document.getElementById('wfh-af-from').value; if (f) q.push('from=' + f);
    const t = document.getElementById('wfh-af-to').value;   if (t) q.push('to=' + t);
    try {
      const r = await api('/api/wfh/applications' + (q.length ? '?' + q.join('&') : ''));
      const header = ['Associate','Email','From','To','Days','Reason','Status','Decided By','Decision Note','Applied On'];
      const csv = [header.join(',')].concat(r.applications.map(a => [
        a.user_name, a.user_email, a.from_date, a.to_date, a.days, a.reason,
        a.status, a.decided_by_name || '', a.decision_note || '', a.created_at
      ].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','))).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'wfh-applications.csv'; link.click();
      URL.revokeObjectURL(url);
    } catch(e) { showAlert('alert', e.message); }
  };

  // Inner WFH sub-sub-tab clicks (nested inside the Leaves > WFH sub-tab)
  document.querySelectorAll('#stab-lv-wfh > .subtabs > .subtab-btn[data-stab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.stab;
      if (id === 'stab-wfh-pending') loadWfhDashboard();
      if (id === 'stab-wfh-all') {
        const sel = document.getElementById('wfh-af-user');
        if (sel && sel.options.length <= 1) {
          USERS.forEach(u => { const o = document.createElement('option'); o.value = u.id; o.textContent = u.full_name; sel.appendChild(o); });
        }
        if (!document.getElementById('wfh-af-from').value) {
          setVal('wfh-af-from', monthStartISO()); setVal('wfh-af-to', todayISO());
        }
        loadAllWfh();
      }
      if (id === 'stab-wfh-reports') { fillWfhYearSelect(); }
    });
  });

  // Detect whether the topnav is overflowing and toggle a class on the wrap so
  // we can show a fade-out gradient at the right edge as a scroll cue.
  function updateTopnavOverflowIndicator() {
    const wrap = document.querySelector('.topnav-wrap');
    const nav  = wrap && wrap.querySelector('.topnav');
    if (!wrap || !nav) return;
    const overflowing = nav.scrollWidth - nav.clientWidth > 4;
    wrap.classList.toggle('is-scrollable', overflowing);
  }
  window.addEventListener('resize', updateTopnavOverflowIndicator);
  // Re-check after the topnav scrolls (fade disappears if user scrolled to the end)
  document.addEventListener('scroll', updateTopnavOverflowIndicator, true);

  // ─── INIT ─────────────────────────────────────────────────────────────
  (async function () {
    try {
      await loadMe();
      // Run the topnav fade check once topbar is in the DOM
      setTimeout(updateTopnavOverflowIndicator, 50);
      await Promise.all([loadDashboard(), loadMasters()]);
      // Fetch pending count once at boot so the topnav can show a badge later.
      try { const d = await api('/api/leaves/dashboard'); const badge = document.getElementById('lv-pending-count'); if (badge && d.pending_count > 0) { badge.style.display='inline-block'; badge.textContent = d.pending_count; } } catch(_) {}
      try {
        const w = await api('/api/wfh/dashboard');
        // Two badges to keep in sync: the inner sub-sub-tab "Pending Approvals"
        // (#wfh-pending-count) and the outer Leaves "🏠 WFH" sub-tab (#wfh-outer-badge).
        for (const bid of ['wfh-pending-count', 'wfh-outer-badge']) {
          const b = document.getElementById(bid);
          if (b) {
            if (w.pending_count > 0) { b.style.display = 'inline-block'; b.textContent = w.pending_count; }
            else b.style.display = 'none';
          }
        }
      } catch(_) {}
    } catch(e) { console.error('Init failed', e); }
  })();

})();
