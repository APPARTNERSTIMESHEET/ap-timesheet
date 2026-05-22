/**
 * Associate panel — weekly grid timesheet (redesigned)
 */
(function () {
  var me = Auth.requireAuth(); if (!me) return;
  if (me.role === 'admin') { location.href = '/admin'; return; }

  // ── Greeting & user name ────────────────────────────────────────────
  var hr = new Date().getHours();
  var greet = hr < 12 ? 'Good Morning,' : hr < 17 ? 'Good Afternoon,' : 'Good Evening,';
  var gEl = document.getElementById('as-greeting-word');
  var uEl = document.getElementById('as-username');
  if (gEl) gEl.textContent = greet;
  if (uEl) uEl.textContent = me.full_name || me.email;

  // ── State ────────────────────────────────────────────────────────────
  var CLIENTS = [], MATTERS = [];
  var currentWeekStart = getWeekStart(new Date());
  var weekEntries = [];
  var rowCounter = 0;

  // Per-cell extra data: [rowId][dayIdx] → {narration, expense, billable}
  var cellData = {};

  // Context menu state
  var _ctxRow = null, _ctxDay = null;

  // ── Tab switching ────────────────────────────────────────────────────
  window.switchAssocTab = function(tab) {
    document.querySelectorAll('.as-panel').forEach(function(p){ p.classList.remove('active'); });
    document.querySelectorAll('.as-nav-btn').forEach(function(b){ b.classList.remove('active'); });
    var panel = document.getElementById('as-tab-' + tab);
    var btn   = document.getElementById('nav-' + tab);
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    if (tab === 'summary') loadMonthly();
    if (tab === 'leaves')  loadMyLeaves();
    if (tab === 'wfh')     loadMyWfh();
  };

  // ── Week helpers ─────────────────────────────────────────────────────
  function getWeekStart(date) {
    var d = new Date(date); var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff); d.setHours(0,0,0,0); return d;
  }
  function getWeekDays(ws) {
    var arr = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(ws); d.setDate(d.getDate() + i); arr.push(d);
    }
    return arr;
  }
  function toISO(date) { return date.toISOString().split('T')[0]; }

  // ── Week navigation ──────────────────────────────────────────────────
  window.prevWeek = function () {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    renderWeek();
  };
  window.nextWeek = function () {
    currentWeekStart = new Date(currentWeekStart);
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    renderWeek();
  };
  window.goCurrentWeek = function () {
    currentWeekStart = getWeekStart(new Date()); renderWeek();
  };

  // ── Render week ──────────────────────────────────────────────────────
  async function renderWeek() {
    var days = getWeekDays(currentWeekStart);
    var todayStr = toISO(new Date());

    // Update week label
    var DAY_SHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    var d0 = days[0], d6 = days[6];
    var fmt = function(d){ return d.getDate() + '/' + (d.getMonth()+1) + '/' + d.getFullYear(); };
    document.getElementById('week-label').textContent = fmt(d0) + ' - ' + fmt(d6);

    // Update column headers
    for (var i = 0; i < 7; i++) {
      var th = document.getElementById('th-' + i);
      var d = days[i];
      var isWknd = (i >= 5);
      var isToday = toISO(d) === todayStr;
      th.querySelector('.th-day').textContent = DAY_SHORT[i];
      th.querySelector('.th-date').textContent = d.getDate();
      th.className = 'as-col-day' + (isWknd ? ' as-col-wknd' : '') + (isToday ? ' as-col-today' : '');
    }

    // Fetch entries for this week
    try {
      var res = await api('/api/timesheet?from=' + toISO(days[0]) + '&to=' + toISO(days[6]));
      weekEntries = res.entries || [];
    } catch(e) { weekEntries = []; }

    // Update stats
    var actual = 0, worked = 0;
    for (var e of weekEntries) {
      if (e.status === 'approved' || e.status === 'invoiced') actual += Number(e.hours);
      else worked += Number(e.hours);
    }
    var statA = document.getElementById('stat-actual');
    var statW = document.getElementById('stat-worked');
    if (statA) statA.textContent = toHHMM(actual);
    if (statW) statW.textContent = toHHMM(worked);
    var totalHrs = actual + worked;
    var pct = Math.min(100, Math.round(totalHrs / 40 * 100));
    var arc = document.getElementById('efficiency-arc');
    var txt = document.getElementById('efficiency-text');
    if (arc) arc.setAttribute('stroke-dasharray', pct + ',100');
    if (txt) txt.textContent = pct + '%';

    // Group entries by client+matter+activity
    var groups = new Map();
    for (var e2 of weekEntries) {
      var key = e2.client_id + '|' + e2.matter_id + '|' + e2.activity_type;
      if (!groups.has(key)) {
        groups.set(key, {
          client_id: e2.client_id, matter_id: e2.matter_id,
          activity_type: e2.activity_type,
          days: {}
        });
      }
      groups.get(key).days[e2.entry_date] = {
        hours: e2.hours, id: e2.id, status: e2.status,
        description: e2.description || '', is_billable: e2.is_billable
      };
    }

    // Reset
    var tbody = document.getElementById('week-grid-body');
    tbody.innerHTML = '';
    rowCounter = 0;
    cellData = {};

    // Existing rows
    for (var g of groups.values()) { buildRow(g, days); }
    // Empty filler rows (min 5 total)
    var empties = Math.max(0, 5 - groups.size);
    for (var j = 0; j < empties; j++) { buildRow(null, days); }

    updateTotals();
  }

  // ── Build a grid row ─────────────────────────────────────────────────
  function buildRow(data, days) {
    if (!days) days = getWeekDays(currentWeekStart);
    var rId = rowCounter++;
    cellData[rId] = {};

    var tr = document.createElement('tr');
    tr.dataset.rowId = rId;
    tr.className = 'as-grid-row';

    // Client dropdown
    var cOpts = '<option value="">— Client —</option>';
    for (var c of CLIENTS) {
      cOpts += '<option value="' + c.id + '"' + (data && data.client_id === c.id ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    }

    // Matter dropdown (filtered by client)
    var cid = data ? data.client_id : null;
    var mList = cid ? MATTERS.filter(function(m){ return m.client_id === cid; }) : MATTERS;
    var mOpts = '<option value="">— Project —</option>';
    for (var m of mList) {
      mOpts += '<option value="' + m.id + '"' + (data && data.matter_id === m.id ? ' selected' : '') + '>' + escapeHtml(m.file_no + ' – ' + m.title) + '</option>';
    }

    // Activity dropdown
    var ACTS = ['Appearing','Applying','Attending','Briefing','Call','Closing','Collection',
      'Conferencing','Drafting','Filing','Hearing','Meeting','Negotiation',
      'Other','Perusal','Research','Reviewing','Service','Travel','Vetting'];
    var aOpts = '<option value="">— Activity —</option>';
    for (var a of ACTS) {
      aOpts += '<option value="' + a + '"' + (data && data.activity_type === a ? ' selected' : '') + '>' + a + '</option>';
    }

    // Day cells
    var dayCells = '';
    for (var di = 0; di < 7; di++) {
      var dd = days[di];
      var iso = toISO(dd);
      var dayD = data && data.days[iso];
      var hrsRaw = dayD ? Number(dayD.hours) : 0;
      var hrsDisplay = hrsRaw > 0 ? toHHMM(hrsRaw) : '';
      var st = dayD ? dayD.status : '';
      var locked = (st === 'approved' || st === 'invoiced');
      var isWknd = di >= 5;
      var isToday = iso === toISO(new Date());
      var cls = 'as-day-cell' + (isWknd ? ' as-col-wknd' : '') + (isToday ? ' as-col-today' : '') + (locked ? ' as-locked' : '');

      // Store cell narration/billable from loaded data
      if (!cellData[rId][di]) cellData[rId][di] = {};
      if (dayD) {
        cellData[rId][di].narration = dayD.description || '';
        cellData[rId][di].billable  = dayD.is_billable !== 0;
      } else {
        cellData[rId][di].narration = '';
        cellData[rId][di].billable  = true;
      }

      dayCells += '<td class="' + cls + '" data-date="' + iso + '">';
      dayCells += '<div class="as-cell-inner">';
      dayCells += '<input type="text" class="as-hrs-inp' + (locked ? ' as-locked-inp' : '') + '"';
      dayCells += ' placeholder="" maxlength="5" value="' + hrsDisplay + '"';
      dayCells += ' data-row="' + rId + '" data-day="' + di + '"';
      if (locked) dayCells += ' disabled title="' + st + '"';
      dayCells += ' oninput="fmtHrsInput(this)" onblur="fmtHrsBlur(this)">';
      if (!locked) {
        dayCells += '<button class="as-dots-btn" data-row="' + rId + '" data-day="' + di + '"';
        dayCells += ' onclick="openCtxMenu(event,' + rId + ',' + di + ')">&#8942;</button>';
      }
      if (st && st !== 'draft') dayCells += '<span class="as-status-dot as-dot-' + st + '" title="' + st + '"></span>';
      dayCells += '</div></td>';
    }

    tr.innerHTML =
      '<td class="as-col-client"><select class="as-sel" data-row="' + rId + '" onchange="onClientChange(this,' + rId + ')">' + cOpts + '</select></td>' +
      '<td class="as-col-project"><select class="as-sel" data-row="' + rId + '">' + mOpts + '</select></td>' +
      '<td class="as-col-act"><select class="as-sel" data-row="' + rId + '">' + aOpts + '</select></td>' +
      dayCells;

    document.getElementById('week-grid-body').appendChild(tr);
  }

  window.addEmptyRow = function() { buildRow(null, getWeekDays(currentWeekStart)); updateTotals(); };

  window.onClientChange = function(sel, rId) {
    var cid = sel.value;
    var tr = document.querySelector('tr[data-row-id="' + rId + '"]');
    var ms = cid ? MATTERS.filter(function(m){ return String(m.client_id) === String(cid); }) : MATTERS;
    var html = '<option value="">— Project —</option>';
    for (var m of ms) { html += '<option value="' + m.id + '">' + escapeHtml(m.file_no + ' – ' + m.title) + '</option>'; }
    tr.querySelector('.as-col-project .as-sel').innerHTML = html;
  };

  // ── HH:MM helpers ────────────────────────────────────────────────────
  function toHHMM(h) {
    if (!h || isNaN(h)) return '00:00';
    var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh++; mm = 0; }
    return String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
  }
  function parseHHMM(val) {
    var s = String(val || '').trim();
    if (!s || s === '-') return 0;
    if (s.indexOf(':') >= 0) {
      var p = s.split(':');
      return (parseInt(p[0],10)||0) + (parseInt(p[1],10)||0)/60;
    }
    return parseFloat(s) || 0;
  }

  window.fmtHrsInput = function(inp) {
    var v = inp.value.replace(/[^0-9:.]/g, '');
    // auto-insert colon after 2 digits
    if (/^\d{2}$/.test(v) && inp._prevLen < 2) v = v + ':';
    inp._prevLen = v.length;
    inp.value = v;
    updateTotals();
  };
  window.fmtHrsBlur = function(inp) {
    var h = parseHHMM(inp.value);
    inp.value = h > 0 ? toHHMM(h) : '';
    inp._prevLen = inp.value.length;
    updateTotals();
  };

  // ── Totals ───────────────────────────────────────────────────────────
  window.updateTotals = function() {
    var dt = [0,0,0,0,0,0,0];
    document.querySelectorAll('#week-grid-body tr').forEach(function(tr) {
      for (var d = 0; d < 7; d++) {
        var inp = tr.querySelector('input[data-day="' + d + '"]');
        dt[d] += inp ? parseHHMM(inp.value) : 0;
      }
    });
    var grand = 0;
    for (var d2 = 0; d2 < 7; d2++) {
      grand += dt[d2];
      var el = document.getElementById('day-total-' + d2);
      if (el) el.textContent = toHHMM(dt[d2]);
      // Available Time / OT: working day = 8h
      var avEl = document.getElementById('avail-' + d2);
      if (avEl) {
        var isWknd = d2 >= 5;
        var target = isWknd ? 0 : 8;
        var rem = target - dt[d2];
        if (rem > 0) avEl.textContent = toHHMM(rem);
        else if (rem < 0) avEl.textContent = 'OT ' + toHHMM(-rem);
        else avEl.textContent = '00:00';
      }
    }
    // Update week stats
    var statW = document.getElementById('stat-worked');
    if (statW) statW.textContent = toHHMM(grand);
    var pct = Math.min(100, Math.round(grand / 40 * 100));
    var arc = document.getElementById('efficiency-arc');
    var txt = document.getElementById('efficiency-text');
    if (arc) arc.setAttribute('stroke-dasharray', pct + ',100');
    if (txt) txt.textContent = pct + '%';
  };

  // ── Context menu ─────────────────────────────────────────────────────
  window.openCtxMenu = function(e, rId, di) {
    e.stopPropagation();
    _ctxRow = rId; _ctxDay = di;
    var menu = document.getElementById('as-ctx-menu'); if (!menu) return;
    var cd = (cellData[rId] && cellData[rId][di]) ? cellData[rId][di] : {};
    var chk = document.getElementById('ctx-bill-chk');
    if (chk) chk.checked = cd.billable !== false;
    // Position near button
    var rect = e.currentTarget.getBoundingClientRect();
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.top  = (rect.bottom + window.scrollY + 2) + 'px';
    menu.classList.add('open');
  };

  // Close context menu on outside click
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('as-ctx-menu');
    if (menu && !menu.contains(e.target)) menu.classList.remove('open');
  });

  window.toggleCtxBillable = function() {
    if (_ctxRow === null || _ctxDay === null) return;
    if (!cellData[_ctxRow]) cellData[_ctxRow] = {};
    if (!cellData[_ctxRow][_ctxDay]) cellData[_ctxRow][_ctxDay] = {};
    var chk = document.getElementById('ctx-bill-chk');
    cellData[_ctxRow][_ctxDay].billable = chk ? chk.checked : true;
  };

  // ── Narration popup ──────────────────────────────────────────────────
  window.openNarrPopup = function() {
    var menu = document.getElementById('as-ctx-menu'); if (menu) menu.classList.remove('open');
    if (_ctxRow === null || _ctxDay === null) return;
    var days = getWeekDays(currentWeekStart);
    var DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    var lbl = document.getElementById('narr-cell-label');
    if (lbl && days[_ctxDay]) lbl.textContent = '— ' + DAY_NAMES[_ctxDay] + ' ' + days[_ctxDay].getDate();
    var ta = document.getElementById('narr-text');
    var cd = (cellData[_ctxRow] && cellData[_ctxRow][_ctxDay]) ? cellData[_ctxRow][_ctxDay] : {};
    if (ta) ta.value = cd.narration || '';
    var overlay = document.getElementById('as-narr-overlay');
    if (overlay) overlay.classList.add('open');
    if (ta) setTimeout(function(){ ta.focus(); }, 50);
  };
  window.openExpPopup = function() {
    var menu = document.getElementById('as-ctx-menu'); if (menu) menu.classList.remove('open');
    var exp = prompt('Enter expense amount (₹):', (cellData[_ctxRow] && cellData[_ctxRow][_ctxDay] && cellData[_ctxRow][_ctxDay].expense) || '');
    if (exp !== null) {
      if (!cellData[_ctxRow]) cellData[_ctxRow] = {};
      if (!cellData[_ctxRow][_ctxDay]) cellData[_ctxRow][_ctxDay] = {};
      cellData[_ctxRow][_ctxDay].expense = exp;
    }
  };
  window.closeNarrPopup = function() {
    var overlay = document.getElementById('as-narr-overlay');
    if (overlay) overlay.classList.remove('open');
  };
  window.saveNarrPopup = function() {
    if (_ctxRow === null || _ctxDay === null) { closeNarrPopup(); return; }
    if (!cellData[_ctxRow]) cellData[_ctxRow] = {};
    if (!cellData[_ctxRow][_ctxDay]) cellData[_ctxRow][_ctxDay] = {};
    var ta = document.getElementById('narr-text');
    cellData[_ctxRow][_ctxDay].narration = ta ? ta.value.trim() : '';
    // Show indicator dot on cell
    var inp = document.querySelector('input[data-row="' + _ctxRow + '"][data-day="' + _ctxDay + '"]');
    if (inp && cellData[_ctxRow][_ctxDay].narration) inp.title = cellData[_ctxRow][_ctxDay].narration;
    closeNarrPopup();
  };

  // ── Save week ────────────────────────────────────────────────────────
  window.saveWeek = async function(status) {
    var days = getWeekDays(currentWeekStart);
    var existMap = new Map();
    for (var e of weekEntries) {
      existMap.set(e.client_id + '|' + e.matter_id + '|' + e.activity_type + '|' + e.entry_date, {
        id: e.id, status: e.status
      });
    }

    var ops = [];
    document.querySelectorAll('#week-grid-body tr').forEach(function(tr) {
      var rId = parseInt(tr.dataset.rowId);
      var cSel = tr.querySelector('.as-col-client .as-sel');
      var mSel = tr.querySelector('.as-col-project .as-sel');
      var aSel = tr.querySelector('.as-col-act .as-sel');
      if (!cSel || !cSel.value || !mSel || !mSel.value) return;
      var cid = cSel.value, mid = mSel.value, act = aSel ? aSel.value : 'Other';

      for (var d = 0; d < 7; d++) {
        var inp = tr.querySelector('input[data-day="' + d + '"]');
        if (!inp || inp.disabled) continue;
        var hrs = parseHHMM(inp.value);
        if (hrs <= 0) continue;
        var dateISO = toISO(days[d]);
        var cd = (cellData[rId] && cellData[rId][d]) ? cellData[rId][d] : {};
        var narr = cd.narration || (act + ' – ' + (mSel.options[mSel.selectedIndex] ? mSel.options[mSel.selectedIndex].text : ''));
        var billable = cd.billable !== false ? 1 : 0;
        var key = cid + '|' + mid + '|' + act + '|' + dateISO;
        var existing = existMap.get(key);
        if (existing && existing.status === 'invoiced') continue;
        if (existing) {
          ops.push(api('/api/timesheet/' + existing.id, { method:'PATCH', body:{
            hours: hrs, status: status, description: narr, is_billable: billable
          }}));
        } else {
          ops.push(api('/api/timesheet', { method:'POST', body:{
            entry_date: dateISO, client_id: cid, matter_id: mid,
            activity_type: act, hours: hrs, description: narr,
            is_billable: billable, status: status
          }}));
        }
      }
    });

    if (!ops.length) { showAlert('alert', 'No hours entered. Fill in the grid first.', 'warning'); return; }
    try {
      await Promise.all(ops);
      showAlert('alert', status === 'submitted' ? '✓ ' + ops.length + ' entries submitted for approval!' : '✓ Saved as draft.', 'success');
      await renderWeek();
      loadMyEntries();
    } catch(err) { showAlert('alert', 'Save failed: ' + err.message); }
  };

  // ── Entry history table ──────────────────────────────────────────────
  window.loadMyEntries = async function() {
    var from = document.getElementById('ff-from').value;
    var to   = document.getElementById('ff-to').value;
    var st   = document.getElementById('ff-status').value;
    var p = new URLSearchParams();
    if (from) p.set('from', from); if (to) p.set('to', to); if (st) p.set('status', st);
    try {
      var res = await api('/api/timesheet?' + p.toString());
      renderHistory(res.entries || []);
    } catch(e) {}
  };

  function renderHistory(entries) {
    var wrap = document.getElementById('my-entries-table');
    if (!entries.length) {
      wrap.innerHTML = '<div class="empty" style="padding:16px;color:var(--muted)">No entries in this range.</div>';
      return;
    }
    var rows = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var canEdit = (e.status === 'draft' || e.status === 'submitted' || e.status === 'rejected');
      var canDel  = canEdit;
      rows += '<tr>' +
        '<td><input type="checkbox"></td>' +
        '<td class="muted" style="text-align:center">' + (i+1) + '</td>' +
        '<td style="white-space:nowrap">' + fmtDate(e.entry_date) + '</td>' +
        '<td><strong>' + escapeHtml(e.client_name || '') + '</strong></td>' +
        '<td>' + escapeHtml((e.file_no ? e.file_no + ' ' : '') + (e.matter_title || '')) + '</td>' +
        '<td>' + escapeHtml(e.activity_type || '') + '</td>' +
        '<td class="num">' + toHHMM(Number(e.hours)) + '</td>' +
        '<td><span class="pill ' + e.status + '">' + e.status + '</span>' +
          (e.rejection_note ? '<br><small style="color:var(--danger)">' + escapeHtml(e.rejection_note) + '</small>' : '') +
        '</td>' +
        '<td style="text-align:center">' + (e.is_billable ? '✓' : '—') + '</td>' +
        '<td style="text-align:center">' +
          (canEdit ? '<button class="btn btn-sm btn-ghost" onclick=\'editHistEntry(' + JSON.stringify(e).replace(/'/g,"&#39;") + ')\' title="Edit">&#9998;</button>' : '—') +
        '</td>' +
        '<td style="text-align:center">' +
          (canDel ? '<button class="btn btn-sm btn-danger" onclick="deleteEntry(' + e.id + ')" title="Delete">&#128465;</button>' : '—') +
        '</td>' +
      '</tr>';
    }
    wrap.innerHTML = '<table class="data"><thead><tr>' +
      '<th style="width:30px"><input type="checkbox" onchange="document.querySelectorAll(\'#my-entries-table .data tbody input[type=checkbox]\').forEach(c=>c.checked=this.checked)"></th>' +
      '<th>Sr.</th><th>Date</th><th>Client Name</th><th>Project Name</th><th>Activity</th>' +
      '<th class="num">Total Time</th><th>Status</th><th>Billable</th><th>Time Edit</th><th>Delete</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  window.editHistEntry = function(e) {
    var html = '<div class="modal-backdrop" id="he-modal"><div class="modal">' +
      '<div class="modal-head"><h3>Edit entry</h3><button class="close" onclick="document.getElementById(\'he-modal\').remove()">×</button></div>' +
      '<div class="modal-body">' +
      '<div id="he-alert" class="alert hidden"></div>' +
      '<div class="form-grid cols-2">' +
      '<div class="form-row"><label>Date</label><input type="date" id="he-date" value="' + e.entry_date + '"></div>' +
      '<div class="form-row"><label>Hours (HH:MM)</label><input id="he-hrs" value="' + toHHMM(Number(e.hours)) + '"></div>' +
      '<div class="form-row full"><label>Narration</label><textarea id="he-desc">' + escapeHtml(e.description || '') + '</textarea></div>' +
      '<div class="form-row"><label>Activity</label><select id="he-act">' +
      ['Appearing','Applying','Attending','Briefing','Call','Closing','Collection','Conferencing','Drafting','Filing','Hearing','Meeting','Negotiation','Other','Perusal','Research','Reviewing','Service','Travel','Vetting'].map(function(a){ return '<option value="'+a+'"'+(e.activity_type===a?' selected':'')+'>'+a+'</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-row"><label>Billable?</label><select id="he-bill"><option value="1"'+(e.is_billable?' selected':'')+'>Yes</option><option value="0"'+(!e.is_billable?' selected':'')+'>No</option></select></div>' +
      '</div></div>' +
      '<div class="modal-foot"><button class="btn btn-ghost" onclick="document.getElementById(\'he-modal\').remove()">Cancel</button>' +
      '<button class="btn btn-accent" onclick="saveHistEntry(' + e.id + ')">Save</button></div>' +
      '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.saveHistEntry = async function(id) {
    var hrsVal = parseHHMM(document.getElementById('he-hrs').value);
    try {
      await api('/api/timesheet/' + id, { method:'PATCH', body:{
        entry_date: document.getElementById('he-date').value,
        hours: hrsVal,
        description: document.getElementById('he-desc').value,
        activity_type: document.getElementById('he-act').value,
        is_billable: parseInt(document.getElementById('he-bill').value)
      }});
      document.getElementById('he-modal').remove();
      renderWeek(); loadMyEntries();
    } catch(e2) { showAlert('he-alert', e2.message); }
  };

  window.deleteEntry = async function(id) {
    if (!confirm('Delete this entry?')) return;
    try { await api('/api/timesheet/' + id, {method:'DELETE'}); renderWeek(); loadMyEntries(); }
    catch(e) { alert(e.message); }
  };

  // ── Monthly summary ───────────────────────────────────────────────────
  async function loadMonthly() {
    var from = monthStartISO(), to = todayISO();
    var res = await api('/api/timesheet?from=' + from + '&to=' + to);
    var entries = res.entries || [];
    var total=0, bill=0, pending=0, approved=0;
    for (var e of entries) {
      total += Number(e.hours); if (e.is_billable) bill += Number(e.hours);
      if (e.status==='submitted') pending++;
      if (e.status==='approved'||e.status==='invoiced') approved++;
    }
    document.getElementById('month-kpis').innerHTML =
      '<div class="kpi"><h4>Total hours</h4><div class="val">' + toHHMM(total) + '</div><div class="sub">' + from + ' to ' + to + '</div></div>' +
      '<div class="kpi"><h4>Billable hours</h4><div class="val">' + toHHMM(bill) + '</div><div class="sub">' + (total ? Math.round(bill/total*100) : 0) + '% of total</div></div>' +
      '<div class="kpi"><h4>Awaiting approval</h4><div class="val">' + pending + '</div></div>' +
      '<div class="kpi"><h4>Approved</h4><div class="val">' + approved + '</div></div>';

    var byClient = new Map();
    for (var e2 of entries) {
      if (!byClient.has(e2.client_id)) byClient.set(e2.client_id, {name:e2.client_name,hours:0,bill:0,count:0});
      var r = byClient.get(e2.client_id);
      r.hours += Number(e2.hours); if (e2.is_billable) r.bill += Number(e2.hours); r.count++;
    }
    var rows = Array.from(byClient.values()).sort(function(a,b){ return b.hours-a.hours; });
    document.getElementById('month-table').innerHTML = '<table class="data"><thead><tr><th>Client</th><th class="num">Entries</th><th class="num">Total Hrs</th><th class="num">Billable Hrs</th></tr></thead><tbody>' +
      rows.map(function(cr){ return '<tr><td>'+escapeHtml(cr.name)+'</td><td class="num">'+cr.count+'</td><td class="num">'+toHHMM(cr.hours)+'</td><td class="num">'+toHHMM(cr.bill)+'</td></tr>'; }).join('') +
      '</tbody></table>';
  }

  // ══ LEAVES ═══════════════════════════════════════════════════════════
  var LEAVE_TYPES = [];

  function fillYearSelect() {
    var sel = document.getElementById('lv-year'); if (!sel || sel.options.length) return;
    var y = new Date().getFullYear();
    for (var i = y - 2; i <= y + 1; i++) {
      var opt = document.createElement('option');
      opt.value = i; opt.textContent = i; if (i === y) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  window.loadMyLeaves = async function() {
    fillYearSelect();
    var year = document.getElementById('lv-year').value || new Date().getFullYear();
    try {
      var r = await Promise.all([
        api('/api/leaves/types'),
        api('/api/leaves/balances?year=' + year),
        api('/api/leaves/holidays?year=' + year)
      ]);
      LEAVE_TYPES = r[0].types;
      renderBalances(r[1].balances);
      renderHolidays(r[2].holidays);
      loadMyApplications();
    } catch(e) { showAlert('alert', e.message); }
  };

  function renderBalances(balances) {
    var byType = {};
    for (var i = 0; i < LEAVE_TYPES.length; i++) {
      byType[LEAVE_TYPES[i].id] = { type: LEAVE_TYPES[i], bal: null };
    }
    for (var j = 0; j < balances.length; j++) {
      var b = balances[j]; if (byType[b.leave_type_id]) byType[b.leave_type_id].bal = b;
    }
    var html = '';
    Object.keys(byType).forEach(function(k) {
      var t = byType[k].type, b = byType[k].bal;
      var allocated = b ? (b.allocated + b.carried_forward) : t.default_annual_quota;
      var used = b ? b.used : 0;
      var pending = b ? b.pending : 0;
      var avail = allocated - used - pending;
      html += '<div class="kpi" style="border-left:4px solid ' + (t.color || '#3b82f6') + ';">' +
              '<h4>' + escapeHtml(t.name) + ' (' + escapeHtml(t.code) + ')</h4>' +
              '<div class="val">' + avail.toFixed(1) + '</div>' +
              '<div class="sub">' +
                'Allocated: ' + allocated.toFixed(1) + ' · Used: ' + used.toFixed(1) +
                (pending > 0 ? ' · Pending: ' + pending.toFixed(1) : '') +
              '</div></div>';
    });
    document.getElementById('lv-balances').innerHTML = html || '<p style="color:var(--muted);font-size:13px;">No leave types configured. Ask admin to set them up.</p>';
  }

  function renderHolidays(holidays) {
    if (!holidays.length) {
      document.getElementById('lv-holidays-table').innerHTML = '<p style="color:var(--muted);padding:14px;font-size:13px;">No holidays defined for this year.</p>';
      return;
    }
    var today = todayISO();
    var rows = holidays.map(function(h) {
      var past = h.holiday_date < today;
      return '<tr style="' + (past ? 'opacity:.55;' : '') + '">' +
        '<td>' + fmtDate(h.holiday_date) + '</td>' +
        '<td>' + escapeHtml(h.name) + '</td>' +
        '<td>' + (h.is_optional ? '<span class="muted">Optional</span>' : 'Public') + '</td>' +
        '<td>' + escapeHtml(h.description || '') + '</td></tr>';
    }).join('');
    document.getElementById('lv-holidays-table').innerHTML =
      '<table class="data"><thead><tr><th>Date</th><th>Name</th><th>Type</th><th>Notes</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  window.loadMyApplications = async function() {
    var status = document.getElementById('lv-filter-status').value;
    try {
      var r = await api('/api/leaves/applications' + (status ? '?status=' + status : ''));
      var apps = r.applications;
      if (!apps.length) {
        document.getElementById('lv-apps-table').innerHTML = '<p style="color:var(--muted);padding:14px;font-size:13px;">No leave applications yet.</p>';
        return;
      }
      var rows = apps.map(function(a) {
        var range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
        if (a.half_day_session !== 'full') range += ' (' + (a.half_day_session === 'first_half' ? '1st half' : '2nd half') + ')';
        var statusColors = { submitted:'#f59e0b', approved:'#10b981', rejected:'#ef4444', cancelled:'#6b7280' };
        var sc = statusColors[a.status] || '#6b7280';
        var statusBadge = '<span style="background:' + sc + '20;color:' + sc + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">' + a.status + '</span>';
        var canCancel = a.status === 'submitted';
        return '<tr>' +
          '<td>' + range + '</td>' +
          '<td><span class="leave-chip" style="background:' + (a.color || '#3b82f6') + '20;color:' + (a.color || '#3b82f6') + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">' + escapeHtml(a.type_code) + '</span></td>' +
          '<td class="num">' + a.days + '</td>' +
          '<td>' + escapeHtml(a.reason) + '</td>' +
          '<td>' + statusBadge + (a.decided_by_name ? '<div style="font-size:10px;color:var(--muted);">by ' + escapeHtml(a.decided_by_name) + '</div>' : '') + '</td>' +
          '<td>' + (canCancel ? '<button class="btn btn-sm btn-ghost" onclick="cancelMyLeave(' + a.id + ')">Cancel</button>' : '') + '</td>' +
        '</tr>';
      }).join('');
      document.getElementById('lv-apps-table').innerHTML =
        '<table class="data"><thead><tr><th>Dates</th><th>Type</th><th class="num">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table>';
    } catch(e) { showAlert('alert', e.message); }
  };

  window.cancelMyLeave = async function(id) {
    if (!confirm('Cancel this leave application?')) return;
    try {
      await api('/api/leaves/applications/' + id + '/cancel', { method: 'POST', body: {} });
      loadMyLeaves();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.openApplyLeaveModal = function() {
    var modal = document.getElementById('apply-leave-modal');
    modal.classList.remove('hidden');
    // Populate types
    var sel = document.getElementById('al-type'); sel.innerHTML = '';
    for (var i = 0; i < LEAVE_TYPES.length; i++) {
      var o = document.createElement('option');
      o.value = LEAVE_TYPES[i].id;
      o.textContent = LEAVE_TYPES[i].name + ' (' + LEAVE_TYPES[i].code + ')';
      sel.appendChild(o);
    }
    setVal('al-from', todayISO()); setVal('al-to', todayISO());
    setVal('al-session', 'full'); setVal('al-reason', ''); setVal('al-contact', '');
    setText('al-days', '—');
    document.getElementById('al-alert').className = 'alert hidden';
  };

  window.closeApplyLeaveModal = function() {
    document.getElementById('apply-leave-modal').classList.add('hidden');
  };

  // Lightweight working-day estimate (front-end only — server is authoritative).
  // Skips weekends but does NOT skip holidays, so the on-screen hint may be a
  // touch higher than the server-computed total. Final count is shown on save.
  window.updateLeaveDays = function() {
    var from = document.getElementById('al-from').value;
    var to   = document.getElementById('al-to').value;
    var sess = document.getElementById('al-session').value;
    if (!from || !to) { setText('al-days', '—'); return; }
    if (sess !== 'full') {
      if (from !== to) {
        // Auto-correct: force same day for half-day requests.
        setVal('al-to', from); to = from;
      }
      setText('al-days', '0.5'); return;
    }
    var d1 = new Date(from + 'T00:00:00'), d2 = new Date(to + 'T00:00:00');
    if (d2 < d1) { setText('al-days', '0'); return; }
    var n = 0;
    for (var d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) n++;
    }
    setText('al-days', String(n));
  };

  window.submitLeaveApplication = async function() {
    var body = {
      leave_type_id: parseInt(document.getElementById('al-type').value, 10),
      from_date: document.getElementById('al-from').value,
      to_date:   document.getElementById('al-to').value,
      half_day_session: document.getElementById('al-session').value,
      reason: document.getElementById('al-reason').value.trim(),
      contact_during_leave: document.getElementById('al-contact').value.trim() || null
    };
    if (!body.leave_type_id || !body.from_date || !body.to_date || !body.reason) {
      showAlert('al-alert', 'Type, dates and reason are required'); return;
    }
    try {
      await api('/api/leaves/applications', { method: 'POST', body: body });
      closeApplyLeaveModal();
      loadMyLeaves();
    } catch(e) { showAlert('al-alert', e.message); }
  };

  // ══ WORK FROM HOME ════════════════════════════════════════════════════
  window.loadMyWfh = async function() {
    try {
      var r = await api('/api/wfh/applications' + (document.getElementById('wfh-filter-status').value
        ? '?status=' + document.getElementById('wfh-filter-status').value : ''));
      var apps = r.applications;

      // Summary tiles: approved this year, pending count, total days this year
      var thisYear = new Date().getFullYear();
      var approved = 0, pending = 0;
      for (var i = 0; i < apps.length; i++) {
        if (apps[i].from_date.indexOf(String(thisYear)) === 0) {
          if (apps[i].status === 'approved')  approved += Number(apps[i].days);
          if (apps[i].status === 'submitted') pending  += Number(apps[i].days);
        }
      }
      document.getElementById('wfh-summary').innerHTML =
        '<div class="kpi" style="border-left:4px solid #3b82f6;"><h4>Approved this year</h4><div class="val">' + approved.toFixed(1) + '</div><div class="sub">days working from home</div></div>' +
        '<div class="kpi" style="border-left:4px solid #f59e0b;"><h4>Pending approval</h4><div class="val">' + pending.toFixed(1) + '</div><div class="sub">days awaiting decision</div></div>' +
        '<div class="kpi" style="border-left:4px solid #10b981;"><h4>Total applications</h4><div class="val">' + apps.length + '</div><div class="sub">all-time</div></div>';

      if (!apps.length) {
        document.getElementById('wfh-apps-table').innerHTML = '<p style="color:var(--muted);padding:14px;font-size:13px;">No WFH applications yet.</p>';
        return;
      }
      var statusColors = { submitted:'#f59e0b', approved:'#10b981', rejected:'#ef4444', cancelled:'#6b7280' };
      var rows = apps.map(function(a) {
        var range = a.from_date === a.to_date ? fmtDate(a.from_date) : (fmtDate(a.from_date) + ' → ' + fmtDate(a.to_date));
        var sc = statusColors[a.status] || '#6b7280';
        var badge = '<span style="background:' + sc + '20;color:' + sc + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">' + a.status + '</span>';
        var canCancel = a.status === 'submitted';
        return '<tr>' +
          '<td>' + range + '</td>' +
          '<td class="num">' + a.days + '</td>' +
          '<td>' + escapeHtml(a.reason) + '</td>' +
          '<td>' + badge + (a.decided_by_name ? '<div style="font-size:10px;color:var(--muted);">by ' + escapeHtml(a.decided_by_name) + '</div>' : '') + '</td>' +
          '<td>' + (canCancel ? '<button class="btn btn-sm btn-ghost" onclick="cancelMyWfh(' + a.id + ')">Cancel</button>' : '') + '</td>' +
        '</tr>';
      }).join('');
      document.getElementById('wfh-apps-table').innerHTML =
        '<table class="data"><thead><tr><th>Dates</th><th class="num">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>' +
        rows + '</tbody></table>';
    } catch(e) { showAlert('alert', e.message); }
  };

  window.cancelMyWfh = async function(id) {
    if (!confirm('Cancel this WFH application?')) return;
    try {
      await api('/api/wfh/applications/' + id + '/cancel', { method: 'POST', body: {} });
      loadMyWfh();
    } catch(e) { showAlert('alert', e.message); }
  };

  window.openApplyWfhModal = function() {
    document.getElementById('apply-wfh-modal').classList.remove('hidden');
    setVal('aw-from', todayISO()); setVal('aw-to', todayISO());
    setVal('aw-reason', ''); setVal('aw-contact', '');
    setText('aw-days', '—');
    document.getElementById('aw-alert').className = 'alert hidden';
  };

  window.closeApplyWfhModal = function() {
    document.getElementById('apply-wfh-modal').classList.add('hidden');
  };

  // Front-end estimate (skips weekends only — server is authoritative and also
  // skips holidays). On-screen number may be 1-2 higher than the final count.
  window.updateWfhDays = function() {
    var from = document.getElementById('aw-from').value;
    var to   = document.getElementById('aw-to').value;
    if (!from || !to) { setText('aw-days', '—'); return; }
    var d1 = new Date(from + 'T00:00:00'), d2 = new Date(to + 'T00:00:00');
    if (d2 < d1) { setText('aw-days', '0'); return; }
    var n = 0;
    for (var d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) n++;
    }
    setText('aw-days', String(n));
  };

  window.submitWfhApplication = async function() {
    var body = {
      from_date: document.getElementById('aw-from').value,
      to_date:   document.getElementById('aw-to').value,
      reason:    document.getElementById('aw-reason').value.trim(),
      contact_during_wfh: document.getElementById('aw-contact').value.trim() || null
    };
    if (!body.from_date || !body.to_date || !body.reason) {
      showAlert('aw-alert', 'Dates and reason are required'); return;
    }
    try {
      await api('/api/wfh/applications', { method: 'POST', body: body });
      closeApplyWfhModal();
      loadMyWfh();
    } catch(e) { showAlert('aw-alert', e.message); }
  };

  // ── Init ──────────────────────────────────────────────────────────────
  (async function () {
    try {
      var r = await Promise.all([api('/api/clients'), api('/api/matters')]);
      CLIENTS = r[0].clients; MATTERS = r[1].matters;
      await renderWeek();
      setVal('ff-from', monthStartISO());
      setVal('ff-to', todayISO());
      loadMyEntries();
    } catch(e) { console.error('Init failed', e); }
  })();

})();
