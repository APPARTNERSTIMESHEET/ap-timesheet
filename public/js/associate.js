/**
 * Associate page logic.
 */
(function () {
  const me = Auth.requireAuth(); if (!me) return;
  if (me.role === 'admin') { location.href = '/admin'; return; }

  document.getElementById('topbar').innerHTML = renderTopBar('tab-new');
  // tab switch
  document.querySelectorAll('.topnav button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const monthStart = monthStartISO();
  setVal('f-date', todayISO());
  setVal('ff-from', monthStart);
  setVal('ff-to', todayISO());

  let CLIENTS = [], MATTERS = [];

  async function loadMasters() {
    const [c, m] = await Promise.all([
      api('/api/clients'),
      api('/api/matters')
    ]);
    CLIENTS = c.clients;
    MATTERS = m.matters;
    const cSel = document.getElementById('f-client');
    cSel.innerHTML = '<option value="">— Select client —</option>' +
      CLIENTS.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    populateMatterDropdown('');
  }

  function populateMatterDropdown(clientId) {
    const sel = document.getElementById('f-matter');
    const filtered = clientId ? MATTERS.filter(m => String(m.client_id) === String(clientId)) : MATTERS;
    sel.innerHTML = '<option value="">— Select matter —</option>' +
      filtered.map(m => `<option value="${m.id}">${escapeHtml(m.file_no + ' — ' + m.title)}</option>`).join('');
  }

  document.getElementById('f-client').addEventListener('change', e => {
    populateMatterDropdown(e.target.value);
  });

  // auto compute hours from start/end
  function autoHours() {
    const s = document.getElementById('f-start').value;
    const e = document.getElementById('f-end').value;
    if (!s || !e) return;
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60;
    document.getElementById('f-hours').value = (Math.round((mins / 60) * 100) / 100).toString();
  }
  document.getElementById('f-start').addEventListener('change', autoHours);
  document.getElementById('f-end').addEventListener('change', autoHours);

  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('is_billable')) fd.set('is_billable', '0'); else fd.set('is_billable', '1');
    try {
      await api('/api/timesheet', { method: 'POST', body: fd });
      showAlert('alert', 'Entry saved.', 'success');
      e.target.reset();
      setVal('f-date', todayISO());
      document.getElementById('f-billable').checked = true;
      loadMyEntries();
    } catch (err) { showAlert('alert', err.message); }
  });

  window.loadMyEntries = async function () {
    const from = document.getElementById('ff-from').value;
    const to   = document.getElementById('ff-to').value;
    const status = document.getElementById('ff-status').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to)   params.set('to', to);
    if (status) params.set('status', status);
    const res = await api('/api/timesheet?' + params.toString());
    renderEntriesTable(res.entries);
  };

  function renderEntriesTable(entries) {
    const wrap = document.getElementById('my-entries-table');
    if (!entries.length) { wrap.innerHTML = '<div class="empty">No entries in this range.</div>'; return; }
    wrap.innerHTML = `
      <table class="data">
        <thead><tr>
          <th>Date</th><th>Client / Matter</th><th>Activity</th><th>Description</th>
          <th class="num">Hours</th><th>Bill?</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${entries.map(e => `
            <tr>
              <td class="nowrap">${fmtDate(e.entry_date)}</td>
              <td>
                <strong>${escapeHtml(e.client_name)}</strong><br>
                <span class="muted">${escapeHtml(e.file_no)} — ${escapeHtml(e.matter_title)}</span>
              </td>
              <td>${escapeHtml(e.activity_type)}</td>
              <td>${escapeHtml(e.description)}${e.attachment_count ? ' 📎' : ''}</td>
              <td class="num">${Number(e.hours).toFixed(2)}</td>
              <td>${e.is_billable ? '✓' : '—'}</td>
              <td><span class="pill ${e.status}">${e.status}</span>${e.rejection_note ? `<br><small class="muted">${escapeHtml(e.rejection_note)}</small>` : ''}</td>
              <td class="row-actions">
                ${['draft','submitted','rejected'].includes(e.status) ? `<button class="btn btn-sm btn-ghost" onclick="editEntry(${e.id})">Edit</button>` : ''}
                ${['draft','submitted','rejected'].includes(e.status) ? `<button class="btn btn-sm btn-danger" onclick="deleteEntry(${e.id})">Delete</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  window.deleteEntry = async function (id) {
    if (!confirm('Delete this entry?')) return;
    try { await api('/api/timesheet/' + id, { method: 'DELETE' }); loadMyEntries(); }
    catch (e) { alert(e.message); }
  };

  window.editEntry = async function (id) {
    const r = await api('/api/timesheet/' + id);
    const e = r.entry;
    const html = `
      <div class="modal-backdrop" id="edit-modal">
        <div class="modal">
          <div class="modal-head">
            <h3>Edit entry · ${fmtDate(e.entry_date)}</h3>
            <button class="close" onclick="document.getElementById('edit-modal').remove()">×</button>
          </div>
          <div class="modal-body">
            <div id="edit-alert" class="alert hidden"></div>
            <div class="form-grid cols-3">
              <div class="form-row"><label>Date</label><input type="date" id="e-date" value="${e.entry_date}"></div>
              <div class="form-row"><label>Client</label><select id="e-client">${CLIENTS.map(c=>`<option value="${c.id}" ${c.id===e.client_id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
              <div class="form-row"><label>Matter</label><select id="e-matter"></select></div>
              <div class="form-row"><label>Activity</label>
                <select id="e-activity">
                  ${['drafting','court','research','meeting','call','travel','admin','other'].map(a => `<option ${a===e.activity_type?'selected':''}>${a}</option>`).join('')}
                </select>
              </div>
              <div class="form-row"><label>Start</label><input type="time" id="e-start" value="${e.start_time||''}"></div>
              <div class="form-row"><label>End</label><input type="time" id="e-end" value="${e.end_time||''}"></div>
              <div class="form-row"><label>Hours</label><input type="number" step="0.25" id="e-hours" value="${e.hours}"></div>
              <div class="form-row checkbox-row">
                <input type="checkbox" id="e-bill" ${e.is_billable?'checked':''}><label for="e-bill" style="text-transform:none;font-weight:500;font-size:13px;color:var(--text);">Billable</label>
              </div>
              <div class="form-row"><label>Status</label>
                <select id="e-status">
                  <option value="draft" ${e.status==='draft'?'selected':''}>Draft</option>
                  <option value="submitted" ${e.status==='submitted'?'selected':''}>Submitted</option>
                </select>
              </div>
              <div class="form-row full"><label>Description</label><input id="e-desc" value="${escapeHtml(e.description)}"></div>
              <div class="form-row full"><label>Notes</label><textarea id="e-notes">${escapeHtml(e.notes||'')}</textarea></div>
              <div class="form-row full"><label>Add another attachment</label><input type="file" id="e-file"></div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" onclick="document.getElementById('edit-modal').remove()">Cancel</button>
            <button class="btn btn-accent" onclick="submitEdit(${id})">Save changes</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    // populate matter dropdown
    const eMatter = document.getElementById('e-matter');
    const ms = MATTERS.filter(m => m.client_id === e.client_id);
    eMatter.innerHTML = ms.map(m => `<option value="${m.id}" ${m.id===e.matter_id?'selected':''}>${escapeHtml(m.file_no+' — '+m.title)}</option>`).join('');
    document.getElementById('e-client').addEventListener('change', ev => {
      const ms = MATTERS.filter(m => String(m.client_id) === String(ev.target.value));
      eMatter.innerHTML = ms.map(m => `<option value="${m.id}">${escapeHtml(m.file_no+' — '+m.title)}</option>`).join('');
    });
  };

  window.submitEdit = async function (id) {
    const fd = new FormData();
    fd.append('entry_date', document.getElementById('e-date').value);
    fd.append('client_id', document.getElementById('e-client').value);
    fd.append('matter_id', document.getElementById('e-matter').value);
    fd.append('activity_type', document.getElementById('e-activity').value);
    fd.append('start_time', document.getElementById('e-start').value);
    fd.append('end_time', document.getElementById('e-end').value);
    fd.append('hours', document.getElementById('e-hours').value);
    fd.append('is_billable', document.getElementById('e-bill').checked ? '1' : '0');
    fd.append('status', document.getElementById('e-status').value);
    fd.append('description', document.getElementById('e-desc').value);
    fd.append('notes', document.getElementById('e-notes').value);
    const file = document.getElementById('e-file').files[0];
    if (file) fd.append('file', file);
    try {
      await api('/api/timesheet/' + id, { method: 'PATCH', body: fd });
      document.getElementById('edit-modal').remove();
      loadMyEntries();
    } catch (e) { showAlert('edit-alert', e.message); }
  };

  async function loadMonthly() {
    const from = monthStartISO();
    const to   = todayISO();
    const res = await api('/api/timesheet?from=' + from + '&to=' + to);
    const entries = res.entries;
    const totalHours    = entries.reduce((s,e) => s + e.hours, 0);
    const billableHours = entries.filter(e => e.is_billable).reduce((s,e) => s + e.hours, 0);
    const submittedC = entries.filter(e => e.status === 'submitted').length;
    const approvedC  = entries.filter(e => ['approved','invoiced'].includes(e.status)).length;
    const kpiHtml = `
      <div class="kpi"><h4>Total hours</h4><div class="val">${totalHours.toFixed(2)}</div><div class="sub">${from} → ${to}</div></div>
      <div class="kpi"><h4>Billable hours</h4><div class="val">${billableHours.toFixed(2)}</div><div class="sub">${(totalHours?(billableHours/totalHours*100):0).toFixed(0)}% of total</div></div>
      <div class="kpi"><h4>Awaiting approval</h4><div class="val">${submittedC}</div><div class="sub">entries</div></div>
      <div class="kpi"><h4>Approved</h4><div class="val">${approvedC}</div><div class="sub">entries</div></div>`;
    document.getElementById('month-kpis').innerHTML = kpiHtml;

    // by client breakdown
    const byClient = new Map();
    for (const e of entries) {
      if (!byClient.has(e.client_id)) byClient.set(e.client_id, { name: e.client_name, hours: 0, billable: 0, count: 0 });
      const r = byClient.get(e.client_id);
      r.hours += e.hours; if (e.is_billable) r.billable += e.hours; r.count += 1;
    }
    const rows = [...byClient.values()].sort((a,b) => b.hours - a.hours);
    document.getElementById('month-table').innerHTML = rows.length ? `
      <table class="data">
        <thead><tr><th>Client</th><th class="num">Entries</th><th class="num">Hours</th><th class="num">Billable hours</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="num">${r.count}</td>
          <td class="num">${r.hours.toFixed(2)}</td>
          <td class="num">${r.billable.toFixed(2)}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty">No entries this month yet.</div>';
  }

  function switchTab(tabId) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.topnav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.getElementById(tabId).classList.add('active');
    if (tabId === 'tab-mine')  loadMyEntries();
    if (tabId === 'tab-month') loadMonthly();
  }

  loadMasters();
})();
