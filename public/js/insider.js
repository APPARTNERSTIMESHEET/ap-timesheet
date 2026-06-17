/**
 * Insider Trading Policy — Frontend (SEBI compliance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wires the #tab-insider panel: status cards, Annexure 1/2/3 forms,
 * pre-clearance request, history, Compliance Officer queue, Restricted List,
 * UPSI log, DP roster, audit trail, and config.
 *
 * All API calls hit /api/insider/*. Permission gating is handled server-side;
 * here we just hide buttons the current user can't see.
 */
(function () {
  'use strict';

  // ─── Auth helpers (re-use the global Auth from common.js) ──────────────────
  // The app stores its JWT under the 'ap_ts_token' key and exposes Auth.token().
  // Use that so our Authorization header matches every other request.
  function token() {
    return (window.Auth && Auth.token) ? Auth.token() : localStorage.getItem('ap_ts_token');
  }
  async function api(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': 'Bearer ' + token(),
        'Content-Type': 'application/json'
      }
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch('/api/insider' + path, opts);
    let json = null;
    try { json = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((json && json.error) || `HTTP ${r.status}`);
    return json;
  }

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : 'Z'));
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDateOnly(iso) {
    if (!iso) return '—';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ─── Signature pad (canvas) ────────────────────────────────────────────────
  // A reusable draw-with-mouse/finger signature widget. Each pad is keyed by its
  // data-sig-for attribute so submit handlers can read the drawn image. Stored
  // as a base64 PNG data URL alongside the typed name (electronic signature,
  // valid under the IT Act 2000).
  const SIG_PADS = {};   // key → { canvas, getData(), clear() }

  function mountSignaturePad(host) {
    const key = host.getAttribute('data-sig-for');
    if (!key || host.getAttribute('data-mounted')) return;
    host.setAttribute('data-mounted', '1');
    host.innerHTML = `
      <label class="form-label" style="display:block;margin-bottom:4px;">Draw your signature</label>
      <div style="border:1px solid var(--border-strong,#cbd5e1);border-radius:8px;background:#fff;display:inline-block;box-shadow:inset 0 1px 2px rgba(0,0,0,.04);">
        <canvas width="380" height="120" style="touch-action:none;display:block;cursor:crosshair;border-radius:8px;"></canvas>
      </div>
      <div style="margin-top:4px;display:flex;align-items:center;gap:10px;">
        <button type="button" class="btn btn-sm btn-ghost ins-sig-clear">↺ Clear</button>
        <span class="ins-sig-hint" style="font-size:11px;color:var(--muted);">Sign with mouse or finger (optional but recommended)</span>
      </div>`;
    const canvas = host.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#16233a';
    let drawing = false, hasInk = false, last = null;
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const t = (e.touches && e.touches[0]) ? e.touches[0] : e;
      return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) };
    }
    function start(e) { drawing = true; last = pos(e); if (e.cancelable) e.preventDefault(); }
    function move(e) {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; hasInk = true;
      if (e.cancelable) e.preventDefault();
    }
    function end() { drawing = false; }
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    host.querySelector('.ins-sig-clear').addEventListener('click', () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false;
      const hint = host.querySelector('.ins-sig-hint');
      if (hint) { hint.textContent = 'Sign with mouse or finger (optional but recommended)'; hint.style.color = 'var(--muted)'; }
    });
    SIG_PADS[key] = {
      canvas,
      getData() { return hasInk ? canvas.toDataURL('image/png') : null; },
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; }
    };
  }

  function mountAllSignaturePads() {
    document.querySelectorAll('.ins-sig[data-sig-for]').forEach(mountSignaturePad);
  }

  function getSig(key) {
    return (SIG_PADS[key] && SIG_PADS[key].getData()) || null;
  }
  function clearSig(key) {
    if (SIG_PADS[key]) SIG_PADS[key].clear();
  }

  // ─── Live identity photo (webcam capture) ──────────────────────────────────
  // Optional. The camera is OFF until the user clicks "Enable Camera" (privacy).
  // On capture we grab a still JPEG, stop the stream immediately, and show a
  // thumbnail + Retake. Stored as a base64 JPEG for SEBI identity evidence.
  // Requires HTTPS (getUserMedia) — production is HTTPS via Cloudflare. ✅
  const CAM_WIDGETS = {};   // key → { getData(), clear(), stop() }

  function mountCameraWidget(host) {
    const key = host.getAttribute('data-cam-for');
    if (!key || host.getAttribute('data-cam-mounted')) return;
    host.setAttribute('data-cam-mounted', '1');

    let stream = null, captured = null;

    function stopStream() {
      if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (_) {} stream = null; }
    }
    function renderIdle() {
      host.innerHTML = `
        <label class="form-label" style="display:block;margin-bottom:4px;">📷 Live identity photo (optional)</label>
        <div class="ins-cam-stage" style="display:inline-block;">
          <button type="button" class="btn btn-sm btn-ghost ins-cam-enable">📷 Enable Camera</button>
          <span style="font-size:11px;color:var(--muted);margin-left:8px;">Capture a live selfie to verify identity</span>
        </div>`;
      host.querySelector('.ins-cam-enable').addEventListener('click', enableCamera);
    }
    async function enableCamera() {
      const stage = host.querySelector('.ins-cam-stage');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 }, audio: false });
      } catch (e) {
        alert('Camera access denied or unavailable.\n\n' + (e.message || e) +
              '\n\nTip: allow camera permission in the browser, and ensure you are on https://');
        return;
      }
      stage.innerHTML = `
        <div style="border:1px solid var(--border-strong,#cbd5e1);border-radius:8px;overflow:hidden;display:inline-block;background:#000;">
          <video autoplay playsinline muted style="width:320px;height:240px;object-fit:cover;display:block;"></video>
        </div>
        <div style="margin-top:4px;">
          <button type="button" class="btn btn-sm btn-primary ins-cam-snap">📸 Capture</button>
          <button type="button" class="btn btn-sm btn-ghost ins-cam-cancel">Cancel</button>
        </div>`;
      const video = stage.querySelector('video');
      video.srcObject = stream;
      stage.querySelector('.ins-cam-snap').addEventListener('click', () => {
        const c = document.createElement('canvas');
        c.width = video.videoWidth || 320; c.height = video.videoHeight || 240;
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        captured = c.toDataURL('image/jpeg', 0.82);
        stopStream();
        renderCaptured();
      });
      stage.querySelector('.ins-cam-cancel').addEventListener('click', () => { stopStream(); renderIdle(); });
    }
    function renderCaptured() {
      host.innerHTML = `
        <label class="form-label" style="display:block;margin-bottom:4px;">📷 Live identity photo ✅</label>
        <div class="ins-cam-stage" style="display:inline-block;">
          <div style="border:2px solid #16a34a;border-radius:8px;overflow:hidden;display:inline-block;">
            <img src="${captured}" style="width:320px;height:240px;object-fit:cover;display:block;">
          </div>
          <div style="margin-top:4px;">
            <button type="button" class="btn btn-sm btn-ghost ins-cam-retake">↺ Retake</button>
            <span style="font-size:11px;color:#166534;margin-left:8px;">✅ Photo captured</span>
          </div>
        </div>`;
      host.querySelector('.ins-cam-retake').addEventListener('click', () => {
        captured = null; renderIdle();
      });
    }

    renderIdle();
    CAM_WIDGETS[key] = {
      getData() { return captured; },
      clear() { captured = null; stopStream(); renderIdle(); },
      stop() { stopStream(); }
    };
  }

  function mountAllCameras() {
    document.querySelectorAll('.ins-cam[data-cam-for]').forEach(mountCameraWidget);
  }
  function getCam(key) { return (CAM_WIDGETS[key] && CAM_WIDGETS[key].getData()) || null; }
  function clearCam(key) { if (CAM_WIDGETS[key]) CAM_WIDGETS[key].clear(); }
  function stopAllCameras() { Object.values(CAM_WIDGETS).forEach(w => { try { w.stop(); } catch (_) {} }); }

  // Safety: stop any live camera when the user navigates away from the page.
  window.addEventListener('beforeunload', stopAllCameras);

  // ─── Permission visibility — toggle CO sub-tabs based on /api/auth/me ──────
  let MY_PERMS = new Set();

  async function loadMyPerms() {
    try {
      const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token() } });
      if (!r.ok) return;
      const j = await r.json();
      // Backend returns the permission set on /auth/me; fall back to empty.
      MY_PERMS = new Set((j.permissions || []));
      // Super-admin sees everything regardless of perms array
      const isSuper = (j.role_code || j.role) === 'super_admin';
      document.querySelectorAll('[data-perm]').forEach(b => {
        const p = b.getAttribute('data-perm');
        b.style.display = (isSuper || MY_PERMS.has(p)) ? '' : 'none';
      });
    } catch (_) { /* leave hidden */ }
  }

  // ─── Sub-tab switcher ──────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('#ins-subtab-nav button[data-ins-sub]');
    if (!btn) return;
    const target = btn.getAttribute('data-ins-sub');
    document.querySelectorAll('#ins-subtab-nav button').forEach(b =>
      b.classList.toggle('active', b === btn));
    document.querySelectorAll('#tab-insider .subtab-panel').forEach(p =>
      p.classList.toggle('active', p.id === target));

    // Lazy-load data when the user clicks each sub-tab.
    if (target === 'ins-history') insLoadHistory();
    else if (target === 'ins-queue') insLoadQueue();
    else if (target === 'ins-rl') insLoadRL();
    else if (target === 'ins-upsi') insLoadUPSI();
    else if (target === 'ins-dps') insLoadDPs();
    else if (target === 'ins-audit') insLoadAudit();
    else if (target === 'ins-config') insLoadConfig();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // STATUS CARDS + ANNEXURE 2 (Acknowledgment)
  // ═════════════════════════════════════════════════════════════════════════

  async function loadStatus() {
    let s;
    try { s = await api('GET', '/me/status'); }
    catch (e) {
      el('ins-status-cards').innerHTML =
        `<div style="grid-column:1/-1;padding:14px;background:#fee2e2;border-radius:8px;color:#991b1b;">Unable to load status: ${esc(e.message)}</div>`;
      return;
    }

    // Status cards
    const cards = [
      {
        label: 'DP Type',
        value: s.dp.dp_type.toUpperCase(),
        sub: 'Designated since ' + fmtDateOnly(s.dp.designated_on),
        color: '#1e40af'
      },
      {
        label: 'Code Acknowledged',
        value: s.code_acknowledged ? '✅ Signed' : '❌ Pending',
        sub: s.code_acknowledged
          ? fmtDate(s.code_acknowledged_at)
          : 'Active: ' + (s.active_code ? s.active_code.label : 'n/a'),
        color: s.code_acknowledged ? '#166534' : '#991b1b'
      },
      {
        label: 'Pre-Clearances',
        value: String(s.pending_preclearances + s.approved_awaiting_trade),
        sub: `${s.pending_preclearances} pending • ${s.approved_awaiting_trade} awaiting trade`,
        color: '#7c2d12'
      }
    ];
    el('ins-status-cards').innerHTML = cards.map(c => `
      <div class="kpi-card" style="border-left:4px solid ${c.color};">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value" style="color:${c.color};">${esc(c.value)}</div>
        <div class="kpi-sub">${esc(c.sub)}</div>
      </div>`).join('');

    // Show/hide ack form
    if (s.code_acknowledged) {
      el('ins-ack-box').classList.add('hidden');
      el('ins-ack-done').classList.remove('hidden');
      el('ins-ack-date').textContent = fmtDate(s.code_acknowledged_at);
    } else {
      el('ins-ack-box').classList.remove('hidden');
      el('ins-ack-done').classList.add('hidden');
    }

    // Annexure 1 status hint
    const an1 = el('ins-anx1-status');
    if (an1) {
      an1.textContent = s.annexure1_submitted_at
        ? 'Last submitted: ' + fmtDate(s.annexure1_submitted_at)
        : 'Not yet submitted';
    }
  }

  window.insSignAck = async function () {
    const name = el('ins-ack-name').value.trim();
    if (!name) { alert('Please type your full name as signature'); return; }
    try {
      await api('POST', '/me/acknowledge', {
        signature_name: name, signature_image: getSig('me'), photo_image: getCam('me')
      });
      alert('✅ Code acknowledged successfully (Annexure 2 signed)');
      loadStatus();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // ANNEXURE 1 — Relatives + Education + Past Employers
  // ═════════════════════════════════════════════════════════════════════════

  function relRowHTML(rel) {
    rel = rel || {};
    return `<tr>
      <td><input class="form-control" data-rel="full_name" value="${esc(rel.full_name || '')}"></td>
      <td><select class="form-control" data-rel="relation_status">
        <option value="immediate_relative" ${rel.relation_status === 'immediate_relative' ? 'selected' : ''}>Immediate Relative</option>
        <option value="pwmfr" ${rel.relation_status === 'pwmfr' ? 'selected' : ''}>PwMFR</option>
      </select></td>
      <td><select class="form-control" data-rel="relation_type">
        <option value="">—</option>
        <option value="spouse" ${rel.relation_type === 'spouse' ? 'selected' : ''}>Spouse</option>
        <option value="parent" ${rel.relation_type === 'parent' ? 'selected' : ''}>Parent</option>
        <option value="sibling" ${rel.relation_type === 'sibling' ? 'selected' : ''}>Sibling</option>
        <option value="child" ${rel.relation_type === 'child' ? 'selected' : ''}>Child</option>
        <option value="spouse_parent" ${rel.relation_type === 'spouse_parent' ? 'selected' : ''}>Spouse's Parent</option>
        <option value="spouse_sibling" ${rel.relation_type === 'spouse_sibling' ? 'selected' : ''}>Spouse's Sibling</option>
        <option value="spouse_child" ${rel.relation_type === 'spouse_child' ? 'selected' : ''}>Spouse's Child</option>
      </select></td>
      <td><input class="form-control" data-rel="pan" placeholder="ABCDE1234F" value="${esc(rel.pan || '')}"></td>
      <td><input class="form-control" data-rel="other_id_value" placeholder="Aadhaar/Passport" value="${esc(rel.other_id_value || '')}"></td>
      <td><input class="form-control" data-rel="contact_phone" placeholder="9999999999" value="${esc(rel.contact_phone || '')}"></td>
      <td style="text-align:center;"><input type="checkbox" data-rel="financial_dep" ${rel.financial_dep ? 'checked' : ''}></td>
      <td style="text-align:center;"><input type="checkbox" data-rel="consults_dp" ${rel.consults_dp ? 'checked' : ''}></td>
      <td><button class="btn btn-sm btn-ghost" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  }

  function eduRowHTML(e) {
    e = e || {};
    return `<tr>
      <td><input class="form-control" data-edu="institution" value="${esc(e.institution || '')}"></td>
      <td style="width:200px;"><input class="form-control" data-edu="years" placeholder="2015-2020" value="${esc(e.years || '')}"></td>
      <td style="width:50px;"><button class="btn btn-sm btn-ghost" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  }

  function empRowHTML(e) {
    e = e || {};
    return `<tr>
      <td><input class="form-control" data-emp="employer" value="${esc(e.employer || '')}"></td>
      <td style="width:200px;"><input class="form-control" data-emp="years" placeholder="2020-2024" value="${esc(e.years || '')}"></td>
      <td style="width:50px;"><button class="btn btn-sm btn-ghost" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  }

  window.insAnx1AddRel = function () {
    document.querySelector('#ins-anx1-rel-tbl tbody').insertAdjacentHTML('beforeend', relRowHTML());
  };
  window.insAnx1AddEdu = function () {
    document.querySelector('#ins-anx1-edu-tbl tbody').insertAdjacentHTML('beforeend', eduRowHTML());
  };
  window.insAnx1AddEmp = function () {
    document.querySelector('#ins-anx1-emp-tbl tbody').insertAdjacentHTML('beforeend', empRowHTML());
  };

  async function loadAnx1() {
    let d;
    try { d = await api('GET', '/me/annexure1'); }
    catch (_) { d = { statement: null }; }

    const relTbody = document.querySelector('#ins-anx1-rel-tbl tbody');
    const eduTbody = document.querySelector('#ins-anx1-edu-tbl tbody');
    const empTbody = document.querySelector('#ins-anx1-emp-tbl tbody');

    if (!d.statement) {
      // Start with one empty row of each
      relTbody.innerHTML = relRowHTML();
      eduTbody.innerHTML = eduRowHTML();
      empTbody.innerHTML = empRowHTML();
      return;
    }
    relTbody.innerHTML = (d.relatives || []).map(relRowHTML).join('') || relRowHTML();
    eduTbody.innerHTML = (d.education || []).map(eduRowHTML).join('') || eduRowHTML();
    empTbody.innerHTML = (d.past_employers || []).map(empRowHTML).join('') || empRowHTML();
  }

  window.insSubmitAnx1 = async function () {
    const name = el('ins-anx1-sign').value.trim();
    if (!name) { alert('Please type your full name as signature'); return; }
    const relatives = [];
    document.querySelectorAll('#ins-anx1-rel-tbl tbody tr').forEach(tr => {
      const row = {};
      tr.querySelectorAll('[data-rel]').forEach(inp => {
        const k = inp.getAttribute('data-rel');
        row[k] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      });
      if (row.full_name) relatives.push(row);
    });
    const education = [];
    document.querySelectorAll('#ins-anx1-edu-tbl tbody tr').forEach(tr => {
      const row = {};
      tr.querySelectorAll('[data-edu]').forEach(inp => { row[inp.getAttribute('data-edu')] = inp.value.trim(); });
      if (row.institution) education.push(row);
    });
    const past_employers = [];
    document.querySelectorAll('#ins-anx1-emp-tbl tbody tr').forEach(tr => {
      const row = {};
      tr.querySelectorAll('[data-emp]').forEach(inp => { row[inp.getAttribute('data-emp')] = inp.value.trim(); });
      if (row.employer) past_employers.push(row);
    });
    try {
      await api('POST', '/me/annexure1', {
        signature_name: name, signature_image: getSig('me'), photo_image: getCam('me'),
        relatives, education, past_employers
      });
      alert('✅ Annexure 1 submitted successfully');
      loadStatus(); loadAnx1();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // ANNEXURE 3 — Securities Holdings
  // ═════════════════════════════════════════════════════════════════════════

  function holdRowHTML(l) {
    l = l || {};
    return `<tr>
      <td>
        <input class="form-control" data-hl="security_name" placeholder="Security name" value="${esc(l.security_name || '')}">
        <input class="form-control" data-hl="isin" placeholder="ISIN" value="${esc(l.isin || '')}" style="margin-top:4px;">
      </td>
      <td><input class="form-control" type="number" data-hl="opening_balance" min="0" value="${l.opening_balance || 0}"></td>
      <td><input class="form-control" type="number" data-hl="increase_qty" min="0" value="${l.increase_qty || 0}"></td>
      <td><input class="form-control" type="number" data-hl="decrease_qty" min="0" value="${l.decrease_qty || 0}"></td>
      <td><input class="form-control" type="number" data-hl="closing_balance" min="0" value="${l.closing_balance || 0}"></td>
      <td>
        <input class="form-control" data-hl="dp_name_broker" placeholder="Broker" value="${esc(l.dp_name_broker || '')}">
        <input class="form-control" data-hl="dp_id_broker" placeholder="DP ID" value="${esc(l.dp_id_broker || '')}" style="margin-top:4px;">
      </td>
      <td><input class="form-control" data-hl="client_folio" placeholder="Client ID / Folio" value="${esc(l.client_folio || '')}"></td>
      <td>
        <select class="form-control" data-hl="held_by">
          <option value="self" ${l.held_by === 'self' || !l.held_by ? 'selected' : ''}>Self</option>
          <option value="immediate_relative" ${l.held_by === 'immediate_relative' ? 'selected' : ''}>Immediate Relative</option>
        </select>
        <input class="form-control" data-hl="relative_name" placeholder="Relative name" value="${esc(l.relative_name || '')}" style="margin-top:4px;">
      </td>
      <td><button class="btn btn-sm btn-ghost" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  }

  window.insHoldAddRow = function () {
    document.querySelector('#ins-hold-tbl tbody').insertAdjacentHTML('beforeend', holdRowHTML());
  };

  function initHoldings() {
    const tbody = document.querySelector('#ins-hold-tbl tbody');
    if (!tbody.children.length) tbody.innerHTML = holdRowHTML();
    // Default as_of_date: today for initial, Mar 31 for annual
    el('ins-hold-asof').value = new Date().toISOString().slice(0, 10);
    el('ins-hold-type').addEventListener('change', function () {
      if (this.value === 'annual') {
        const y = new Date().getFullYear();
        el('ins-hold-asof').value = `${y}-03-31`;
      } else {
        el('ins-hold-asof').value = new Date().toISOString().slice(0, 10);
      }
    });
  }

  window.insSubmitHoldings = async function () {
    const stype = el('ins-hold-type').value;
    const asof = el('ins-hold-asof').value;
    const name = el('ins-hold-sign').value.trim();
    if (!asof) { alert('Please pick the as-of date'); return; }
    if (!name) { alert('Please type your full name as signature'); return; }
    const lines = [];
    document.querySelectorAll('#ins-hold-tbl tbody tr').forEach(tr => {
      const row = {};
      tr.querySelectorAll('[data-hl]').forEach(inp => {
        const k = inp.getAttribute('data-hl');
        row[k] = inp.type === 'number' ? Number(inp.value) : inp.value.trim();
      });
      if (row.security_name) lines.push(row);
    });
    try {
      const r = await api('POST', '/me/holdings', {
        statement_type: stype, as_of_date: asof, signature_name: name,
        signature_image: getSig('me'), photo_image: getCam('me'), lines
      });
      alert(`✅ Annexure 3 submitted — ${lines.length} securit${lines.length === 1 ? 'y' : 'ies'} declared.`);
      loadStatus();
      // Clear form to a single blank row
      document.querySelector('#ins-hold-tbl tbody').innerHTML = holdRowHTML();
      el('ins-hold-sign').value = '';
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // PRE-CLEARANCE (Annexure 4 + 5)
  // ═════════════════════════════════════════════════════════════════════════

  function initPreclear() {
    const k = el('ins-pc-kind');
    const w = el('ins-pc-trader-name-wrap');
    k.addEventListener('change', () => {
      w.style.display = k.value === 'immediate_relative' ? '' : 'none';
    });
  }

  window.insSubmitPC = async function () {
    const k = el('ins-pc-kind').value;
    const body = {
      trader_kind: k,
      trader_name: k === 'immediate_relative' ? el('ins-pc-trader-name').value.trim() : null,
      security_name: el('ins-pc-security').value.trim(),
      isin: el('ins-pc-isin').value.trim(),
      txn_nature: el('ins-pc-txn').value,
      qty_proposed: Number(el('ins-pc-qty').value),
      qty_held_before: Number(el('ins-pc-qty-before').value) || 0,
      broker_dp_id: el('ins-pc-broker-dp').value.trim(),
      broker_client_id: el('ins-pc-broker-client').value.trim(),
      decl_no_upsi: el('ins-pc-d1').checked,
      decl_will_inform_if_upsi: el('ins-pc-d2').checked,
      decl_no_contravention: el('ins-pc-d3').checked,
      decl_full_disclosure: el('ins-pc-d4').checked,
      signature_name: el('ins-pc-sign').value.trim(),
      signature_image: getSig('me'),
      photo_image: getCam('me')
    };
    if (!body.security_name) { alert('Security name is required'); return; }
    if (!body.qty_proposed) { alert('Quantity is required'); return; }
    if (!body.signature_name) { alert('Signature is required'); return; }
    if (!body.decl_no_upsi || !body.decl_will_inform_if_upsi || !body.decl_no_contravention || !body.decl_full_disclosure) {
      alert('All 4 Annexure 5 declarations must be checked'); return;
    }
    try {
      const r = await api('POST', '/me/preclearance', body);
      alert(`✅ Pre-clearance request #${r.request_id} submitted.\nCompliance Officer will respond within 1 working day.`);
      // Reset
      ['ins-pc-security','ins-pc-isin','ins-pc-qty','ins-pc-broker-dp','ins-pc-broker-client','ins-pc-sign']
        .forEach(id => { const e = el(id); if (e) e.value = ''; });
      ['ins-pc-d1','ins-pc-d2','ins-pc-d3','ins-pc-d4'].forEach(id => el(id).checked = false);
      loadStatus();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // MY HISTORY
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadHistory = async function () {
    try {
      const pc = await api('GET', '/me/preclearance');
      const rows = pc.requests || [];
      el('ins-pc-history').innerHTML = rows.length ? `
        <table class="table" style="font-size:12px;">
          <thead><tr>
            <th>#</th><th>Submitted</th><th>Security</th><th>Type</th><th>Qty</th>
            <th>Status</th><th>Decision</th><th>Valid Until</th><th>Action</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${r.id}</td>
              <td>${fmtDate(r.submitted_at)}</td>
              <td>${esc(r.security_name)}<br><small style="color:var(--muted);">${esc(r.isin || '')}</small></td>
              <td>${esc(r.txn_nature)}</td>
              <td>${r.qty_proposed}</td>
              <td><span class="ins-badge ins-badge-${r.status}">${esc(r.status)}</span></td>
              <td>${r.decision ? esc(r.decision) + '<br><small>' + fmtDate(r.decision_at) + '</small>' : '—'}</td>
              <td>${r.valid_until ? fmtDateOnly(r.valid_until) : '—'}</td>
              <td>
                ${r.status === 'approved' ? `<button class="btn btn-sm btn-primary" onclick="insOpenPostTrade(${r.id})">📝 Post-Trade</button>
                <button class="btn btn-sm btn-ghost" onclick="insOpenNoTrade(${r.id})">No Trade</button>` : ''}
              </td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">No pre-clearance requests yet.</p>';
    } catch (e) {
      el('ins-pc-history').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
    try {
      const h = await api('GET', '/me/holdings');
      const hs = h.statements || [];
      el('ins-hold-history').innerHTML = hs.length ? `
        <table class="table" style="font-size:12px;">
          <thead><tr><th>#</th><th>Type</th><th>As Of</th><th>Submitted</th></tr></thead>
          <tbody>${hs.map(s => `
            <tr>
              <td>${s.id}</td>
              <td><span class="ins-badge ins-badge-${s.statement_type === 'initial' ? 'pending' : 'approved'}">${esc(s.statement_type)}</span></td>
              <td>${fmtDateOnly(s.as_of_date)}</td>
              <td>${fmtDate(s.submitted_at)}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">No holdings statements filed yet.</p>';
    } catch (e) {
      el('ins-hold-history').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  // Post-trade / no-trade dialogs (simple prompts to avoid building yet another modal)
  window.insOpenPostTrade = async function (rid) {
    const security_name = prompt('Confirm security name traded:');
    if (!security_name) return;
    const qty = Number(prompt('Quantity traded:'));
    if (!qty) return;
    const price = Number(prompt('Trade price per security (₹):'));
    if (!price) return;
    const broker = prompt('Broker name (optional):') || null;
    const traded_at = prompt('Date of trade (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
    if (!traded_at) return;
    const signature_name = prompt('Type your full name as signature:');
    if (!signature_name) return;
    try {
      const r = await api('POST', `/me/preclearance/${rid}/post-trade`, {
        security_name, qty_traded: qty, trade_price: price,
        broker_name: broker, traded_at, signature_name, holder_flag: 'F'
      });
      alert(`✅ Post-Trade Report submitted (Annexure 7).\n6-month contra-trade hold until: ${r.contra_locked_until}`);
      insLoadHistory();
    } catch (e) { alert('Error: ' + e.message); }
  };

  window.insOpenNoTrade = async function (rid) {
    const reason = prompt('Reason for not executing the approved trade:');
    if (!reason) return;
    const signature_name = prompt('Type your full name as signature:');
    if (!signature_name) return;
    try {
      await api('POST', `/me/preclearance/${rid}/no-trade`, { reason, signature_name });
      alert('✅ No-Trade Report submitted (Annexure 8).');
      insLoadHistory();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // COMPLIANCE OFFICER — Pre-clearance queue
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadQueue = async function () {
    try {
      const j = await api('GET', '/co/queue');
      const rows = j.queue || [];
      el('ins-queue-tbl').innerHTML = rows.length ? `
        <table class="table" style="font-size:12px;">
          <thead><tr>
            <th>#</th><th>Submitted</th><th>DP</th><th>Trader</th><th>Security</th>
            <th>Txn</th><th>Qty</th><th>RL?</th><th>Action</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${r.id}</td>
              <td>${fmtDate(r.submitted_at)}</td>
              <td>${esc(r.dp_name)}<br><small style="color:var(--muted);">${esc(r.dp_email)} • ${esc(r.dp_type)}</small></td>
              <td>${esc(r.trader_kind === 'self' ? 'Self' : ('IR: ' + (r.trader_name || '')))}</td>
              <td>${esc(r.security_name)}<br><small style="color:var(--muted);">${esc(r.isin || '')}</small></td>
              <td>${esc(r.txn_nature)}</td>
              <td>${r.qty_proposed}</td>
              <td>${r.on_restricted_list ? '<span class="ins-badge ins-badge-rl">🔒 YES</span>' : '<span class="ins-badge ins-badge-no-trade">No</span>'}</td>
              <td>
                <button class="btn btn-sm btn-success" onclick="insCODecide(${r.id}, 'approved')">✅ Approve</button>
                <button class="btn btn-sm btn-danger" onclick="insCODecide(${r.id}, 'rejected')">❌ Reject</button>
              </td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">No pending requests. ✨ Queue clear!</p>';
    } catch (e) {
      el('ins-queue-tbl').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  window.insCODecide = async function (rid, decision) {
    let note = '';
    if (decision === 'rejected') {
      note = prompt('Internal note (for CO records — NOT shared with DP):') || '';
    } else {
      note = prompt('Optional internal note:') || '';
    }
    if (!confirm(`Confirm ${decision.toUpperCase()} for request #${rid}?`)) return;
    try {
      const r = await api('POST', `/co/decide/${rid}`, { decision, internal_note: note });
      alert(`✅ Decision recorded. ${r.valid_until ? 'Valid until ' + r.valid_until : ''}`);
      insLoadQueue();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // RESTRICTED LIST
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadRL = async function () {
    const showHistory = el('ins-rl-history') && el('ins-rl-history').checked;
    try {
      const j = await api('GET', '/co/restricted-list' + (showHistory ? '?history=1' : ''));
      const rows = j.list || [];
      el('ins-rl-tbl').innerHTML = rows.length ? `
        <table class="table" style="font-size:12px;">
          <thead><tr>
            <th>Company</th><th>ISIN</th><th>Scrip</th><th>Reason</th>
            <th>Added</th><th>Removed</th><th>Action</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr style="${r.removed_at ? 'opacity:0.55;' : ''}">
              <td>${esc(r.company_name)}</td>
              <td>${esc(r.isin || '—')}</td>
              <td>${esc(r.scrip_code || '—')}</td>
              <td>${esc(r.added_reason || '—')}</td>
              <td>${fmtDate(r.added_at)}</td>
              <td>${r.removed_at ? fmtDate(r.removed_at) + '<br><small>' + esc(r.removal_reason || '') + '</small>' : '—'}</td>
              <td>${r.removed_at ? '' : `<button class="btn btn-sm btn-danger" onclick="insRLRemove(${r.id})">Remove</button>`}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">Restricted List is empty.</p>';
    } catch (e) {
      el('ins-rl-tbl').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  window.insRLAdd = async function () {
    const company_name = prompt('Company name to add to Restricted List:');
    if (!company_name) return;
    const isin = prompt('ISIN (optional):') || null;
    const scrip_code = prompt('Scrip code (BSE/NSE, optional):') || null;
    const added_reason = prompt('Reason / matter reference (internal):') || null;
    try {
      await api('POST', '/co/restricted-list', { company_name, isin, scrip_code, added_reason });
      alert('✅ Added to Restricted List');
      insLoadRL();
    } catch (e) { alert('Error: ' + e.message); }
  };

  window.insRLRemove = async function (id) {
    const removal_reason = prompt('Removal reason (e.g. "UPSI became public"):');
    if (!removal_reason) return;
    try {
      await fetch(`/api/insider/co/restricted-list/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ removal_reason })
      });
      insLoadRL();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // UPSI LOG
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadUPSI = async function () {
    try {
      const j = await api('GET', '/co/upsi-log');
      const rows = j.log || [];
      el('ins-upsi-tbl').innerHTML = rows.length ? `
        <table class="table" style="font-size:12px;">
          <thead><tr>
            <th>Company</th><th>Recipient</th><th>PAN</th><th>Type</th>
            <th>Purpose</th><th>Shared By</th><th>When</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${esc(r.company_name)}</td>
              <td>${esc(r.recipient_name)}</td>
              <td>${esc(r.recipient_pan || r.recipient_other_id || '—')}</td>
              <td>${esc(r.recipient_type || '—')}</td>
              <td>${esc(r.purpose)}</td>
              <td>${esc(r.shared_by_name || '?')}</td>
              <td>${fmtDate(r.shared_at)}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">No UPSI sharing events logged yet.</p>';
    } catch (e) {
      el('ins-upsi-tbl').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  window.insUPSIAdd = async function () {
    const company_name = prompt('Company name (UPSI subject):');
    if (!company_name) return;
    const recipient_name = prompt('Recipient name:');
    if (!recipient_name) return;
    const recipient_pan = prompt('Recipient PAN (or other ID):') || null;
    const recipient_type = prompt('Recipient type (dp_internal/third_party/client/counsel/other):', 'other') || 'other';
    const purpose = prompt('Purpose of sharing:');
    if (!purpose) return;
    try {
      await api('POST', '/co/upsi-log', { company_name, recipient_name, recipient_pan, recipient_type, purpose });
      alert('✅ Logged');
      insLoadUPSI();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // DP ROSTER
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadDPs = async function () {
    try {
      const j = await api('GET', '/admin/dps');
      const rows = j.dps || [];
      // ── Pending compliance: who hasn't signed the Code / filed Annexure 1 ──
      const active = rows.filter(d => !d.removed_on);
      const pending = active.filter(d => !(d.ack_count > 0) || !(d.anx1_count > 0));
      const pendingBlock = !rows.length ? '' : (pending.length ? `
        <div style="border:1px solid #fca5a5;background:#fef2f2;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
          <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:8px;">⚠️ Pending compliance — ${pending.length} of ${active.length} designated persons</div>
          <table class="table" style="font-size:12px;background:#fff;">
            <thead><tr><th>Name</th><th>Email</th><th>Code</th><th>Anx 1</th><th>Missing</th></tr></thead>
            <tbody>${pending.map(d => {
              const miss = [];
              if (!(d.ack_count > 0)) miss.push('Code acknowledgment');
              if (!(d.anx1_count > 0)) miss.push('Annexure 1');
              return `<tr>
                <td>${esc(d.full_name)}</td>
                <td>${esc(d.email)}</td>
                <td>${d.ack_count > 0 ? '✅' : '❌'}</td>
                <td>${d.anx1_count > 0 ? '✅' : '❌'}</td>
                <td style="color:#991b1b;">${miss.join(', ')}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>` : `
        <div style="border:1px solid #86efac;background:#f0fdf4;border-radius:8px;padding:10px 14px;margin-bottom:14px;color:#166534;font-weight:600;font-size:13px;">
          ✅ All ${active.length} designated persons ne Code sign kiya aur Annexure 1 file kiya.
        </div>`);
      el('ins-dps-tbl').innerHTML = pendingBlock + (rows.length ? `
        <table class="table" style="font-size:12px;">
          <thead><tr>
            <th>Name</th><th>Email</th><th>DP Type</th><th>Designated</th>
            <th>Ack</th><th>Anx 1</th><th>Holdings</th><th>Pre-clear</th><th>Status</th>
          </tr></thead>
          <tbody>${rows.map(d => `
            <tr style="${d.removed_on ? 'opacity:0.55;' : ''}">
              <td>${esc(d.full_name)}</td>
              <td>${esc(d.email)}</td>
              <td>${esc(d.dp_type)}</td>
              <td>${fmtDateOnly(d.designated_on)}</td>
              <td>${d.ack_count > 0 ? '✅' : '❌'}</td>
              <td>${d.anx1_count > 0 ? '✅' : '❌'}</td>
              <td>${d.holdings_count}</td>
              <td>${d.preclear_count}</td>
              <td>${d.removed_on ? '<span class="ins-badge ins-badge-no-trade">Removed</span>' : '<span class="ins-badge ins-badge-approved">Active</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">No designated persons yet.</p>');
    } catch (e) {
      el('ins-dps-tbl').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  window.insDPAdd = async function () {
    const user_id = Number(prompt('User ID to designate as DP:'));
    if (!user_id) return;
    const dp_type = prompt('DP type (partner / lawyer / intern / secretary / staff / other):', 'staff');
    if (!dp_type) return;
    try {
      await api('POST', '/admin/dps', { user_id, dp_type });
      alert('✅ Designated');
      insLoadDPs();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // AUDIT TRAIL
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadAudit = async function () {
    try {
      const j = await api('GET', '/audit?limit=200');
      const rows = j.rows || [];
      el('ins-audit-tbl').innerHTML = rows.length ? `
        <p style="font-size:11px;color:var(--muted);">Showing latest ${rows.length} of ${j.total} events.</p>
        <table class="table" style="font-size:12px;">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Payload</th><th>IP</th></tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td>${fmtDate(r.at)}</td>
              <td>${esc(r.user_name || r.user_email || '—')}</td>
              <td><code>${esc(r.action)}</code></td>
              <td>${esc(r.entity_type || '—')} ${r.entity_id ? '#' + r.entity_id : ''}</td>
              <td><small style="color:var(--muted);">${esc((r.payload_json || '').slice(0, 120))}</small></td>
              <td><small>${esc(r.ip || '—')}</small></td>
            </tr>`).join('')}</tbody>
        </table>` : '<p style="padding:20px;color:var(--muted);">No audit events yet.</p>';
    } catch (e) {
      el('ins-audit-tbl').innerHTML = `<p style="padding:20px;color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // CONFIG (Mgmt Committee)
  // ═════════════════════════════════════════════════════════════════════════

  window.insLoadConfig = async function () {
    try {
      const j = await api('GET', '/config');
      const c = j.config || {};
      el('ins-config-form').innerHTML = `
        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div>
            <label class="form-label">Pre-clearance threshold (₹)</label>
            <input class="form-control" type="number" id="ins-cfg-thr" value="${c.pre_clearance_threshold || 500000}">
          </div>
          <div>
            <label class="form-label">Trade window (days)</label>
            <input class="form-control" type="number" id="ins-cfg-win" value="${c.trade_window_days || 7}">
          </div>
          <div>
            <label class="form-label">Contra-trade hold (months)</label>
            <input class="form-control" type="number" id="ins-cfg-con" value="${c.contra_trade_months || 6}">
          </div>
          <div>
            <label class="form-label">Annual deadline (day / month)</label>
            <div style="display:flex;gap:8px;">
              <input class="form-control" type="number" id="ins-cfg-day" min="1" max="31" value="${c.annual_deadline_day || 30}">
              <input class="form-control" type="number" id="ins-cfg-mon" min="1" max="12" value="${c.annual_deadline_month || 4}">
            </div>
          </div>
        </div>
        <div style="margin-top:14px;">
          <button class="btn btn-primary" onclick="insSaveConfig()">💾 Save Config</button>
          <span style="font-size:11px;color:var(--muted);margin-left:10px;">Last updated: ${c.updated_at ? fmtDate(c.updated_at) : 'never'}</span>
        </div>`;
    } catch (e) {
      el('ins-config-form').innerHTML = `<p style="color:#991b1b;">Error: ${esc(e.message)}</p>`;
    }
  };

  window.insSaveConfig = async function () {
    const body = {
      pre_clearance_threshold: Number(el('ins-cfg-thr').value),
      trade_window_days: Number(el('ins-cfg-win').value),
      contra_trade_months: Number(el('ins-cfg-con').value),
      annual_deadline_day: Number(el('ins-cfg-day').value),
      annual_deadline_month: Number(el('ins-cfg-mon').value)
    };
    try {
      await api('PATCH', '/config', body);
      alert('✅ Config saved');
      insLoadConfig();
    } catch (e) { alert('Error: ' + e.message); }
  };

  // ─── Self-service markup injector (associate portal) ───────────────────────
  // The admin page hard-codes this markup inline. The associate portal instead
  // provides an empty <div id="ins-self-host"> and we inject the SAME element
  // IDs here, so all the loaders above drive it identically. Associates only get
  // self-service (My Compliance + My History) — never the CO sections.
  function selfServiceHTML() {
    return `
    <div class="subtab-nav" id="ins-subtab-nav" style="margin:14px 14px 0;display:flex;gap:8px;">
      <button class="subtab-btn active" data-ins-sub="ins-my" style="padding:8px 16px;border:1px solid var(--border);background:var(--surface);border-radius:8px;cursor:pointer;font-size:13px;">My Compliance</button>
      <button class="subtab-btn" data-ins-sub="ins-history" style="padding:8px 16px;border:1px solid var(--border);background:var(--surface);border-radius:8px;cursor:pointer;font-size:13px;">My History</button>
    </div>

    <div id="ins-my" class="subtab-panel active">
      <div class="card" style="margin:14px;">
        <div class="card-title">🛡️ Insider Trading Policy — Status</div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px;">
          AP &amp; Partners Code of Conduct for Prohibition of Insider Trading, per SEBI
          (Prohibition of Insider Trading) Regulations, 2015. As a Designated Person you
          must complete the 3 onboarding steps below and seek pre-clearance before any
          trade over ₹5,00,000.
        </p>
        <div id="ins-status-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;"></div>
      </div>

      <!-- ONE shared identity capture — signature + live photo, done once and
           attached to every form submitted in this session. -->
      <div class="card" style="margin:14px;border:2px solid #c7d2fe;">
        <div class="card-title">🪪 Your Signature &amp; Photo — capture once</div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px;">
          Draw your signature and (optionally) take a live photo <b>once</b> here. It is
          automatically attached to every form you submit below — Code acknowledgment,
          relatives, holdings, and pre-clearance. No need to repeat on each form.
        </p>
        <div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start;">
          <div class="ins-sig" data-sig-for="me"></div>
          <div class="ins-cam" data-cam-for="me"></div>
        </div>
      </div>

      <div class="card" style="margin:14px;">
        <div class="card-title">📜 Step 1 — Acknowledge the Code (Annexure 2)</div>
        <div id="ins-ack-box">
          <p style="font-size:13px;line-height:1.6;">
            I confirm that I have read, understood, and agree to comply with the
            <b>AP &amp; Partners Code of Conduct for Prohibition of Insider Trading</b>.
            I undertake to comply fully with the policies and procedures contained therein,
            and agree to be subject to sanctions (including suspension) for any violation.
          </p>
          <div style="display:flex;gap:10px;align-items:end;margin-top:12px;">
            <div style="flex:1;">
              <label class="form-label">Type your full name as signature</label>
              <input class="form-control" id="ins-ack-name" placeholder="Your full name">
            </div>
            <button class="btn btn-primary" onclick="insSignAck()">✍️ Sign &amp; Submit</button>
          </div>
        </div>
        <div id="ins-ack-done" class="hidden" style="background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:8px;padding:12px;margin-top:8px;">
          ✅ <b>Code acknowledged</b> on <span id="ins-ack-date"></span> — Annexure 2 signed.
        </div>
      </div>

      <div class="card" style="margin:14px;">
        <div class="card-title">👨‍👩‍👧 Step 2 — Immediate Relatives + Background (Annexure 1)
          <span class="actions"><span id="ins-anx1-status" style="font-size:11px;color:var(--muted);"></span></span>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px;">
          List your Immediate Relatives (spouse, parents, siblings, children) + persons with a
          material financial relationship, plus your education and previous employers.
        </p>
        <h4 style="font-size:13px;margin:14px 0 8px;">Relatives / PwMFR</h4>
        <div class="table-wrap"><table class="table" id="ins-anx1-rel-tbl" style="font-size:12px;">
          <thead><tr><th>Full Name</th><th>Status</th><th>Relation</th><th>PAN</th><th>Other ID</th><th>Contact</th><th>Fin.Dep?</th><th>Consults?</th><th></th></tr></thead>
          <tbody></tbody></table></div>
        <button class="btn btn-sm btn-ghost" onclick="insAnx1AddRel()">➕ Add Relative / PwMFR</button>

        <h4 style="font-size:13px;margin:18px 0 8px;">Educational Institutions</h4>
        <div class="table-wrap"><table class="table" id="ins-anx1-edu-tbl" style="font-size:12px;">
          <thead><tr><th>Institution</th><th>Years</th><th></th></tr></thead><tbody></tbody></table></div>
        <button class="btn btn-sm btn-ghost" onclick="insAnx1AddEdu()">➕ Add Institution</button>

        <h4 style="font-size:13px;margin:18px 0 8px;">Previous Employers</h4>
        <div class="table-wrap"><table class="table" id="ins-anx1-emp-tbl" style="font-size:12px;">
          <thead><tr><th>Employer</th><th>Years</th><th></th></tr></thead><tbody></tbody></table></div>
        <button class="btn btn-sm btn-ghost" onclick="insAnx1AddEmp()">➕ Add Employer</button>

        <div style="display:flex;gap:10px;align-items:end;margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">
          <div style="flex:1;"><label class="form-label">Type your full name as signature</label>
            <input class="form-control" id="ins-anx1-sign" placeholder="Your full name"></div>
          <button class="btn btn-primary" onclick="insSubmitAnx1()">📤 Submit Annexure 1</button>
        </div>
      </div>

      <div class="card" style="margin:14px;">
        <div class="card-title">📈 Step 3 — Securities Holdings (Annexure 3)
          <span class="actions"><select class="form-control" id="ins-hold-type" style="font-size:12px;padding:5px 10px;">
            <option value="initial">Initial (within 7 days of joining)</option>
            <option value="annual">Annual (as of Mar 31, due Apr 30)</option>
          </select></span>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px;">
          Declare securities held by you AND your Immediate Relatives (excludes mutual funds).
          Hold zero securities? Just submit empty.
        </p>
        <div class="table-wrap"><table class="table" id="ins-hold-tbl" style="font-size:12px;">
          <thead><tr><th>Security / ISIN</th><th>Opening</th><th>Increase</th><th>Decrease</th><th>Closing</th><th>Broker/DP ID</th><th>Client/Folio</th><th>Held By</th><th></th></tr></thead>
          <tbody></tbody></table></div>
        <button class="btn btn-sm btn-ghost" onclick="insHoldAddRow()">➕ Add Security</button>
        <div style="display:flex;gap:10px;align-items:end;margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">
          <div style="width:180px;"><label class="form-label">As of date</label><input class="form-control" type="date" id="ins-hold-asof"></div>
          <div style="flex:1;"><label class="form-label">Type your full name as signature</label><input class="form-control" id="ins-hold-sign" placeholder="Your full name"></div>
          <button class="btn btn-primary" onclick="insSubmitHoldings()">📤 Submit Statement</button>
        </div>
      </div>

      <div class="card" style="margin:14px;">
        <div class="card-title">💰 Pre-Clearance Request (Annexure 4 + 5)
          <span class="actions" style="font-size:11px;color:var(--muted);">Required for trades > ₹5,00,000</span></div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px;">
          Submit BEFORE executing any trade above ₹5 lakh per security per FY. Valid 7 trading days.
          Contra-trade restriction: 6 months.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <div><label class="form-label">Who's trading?</label>
            <select class="form-control" id="ins-pc-kind"><option value="self">Self</option><option value="immediate_relative">Immediate Relative</option></select></div>
          <div id="ins-pc-trader-name-wrap" style="display:none;"><label class="form-label">Relative's name</label><input class="form-control" id="ins-pc-trader-name"></div>
          <div><label class="form-label">Transaction</label>
            <select class="form-control" id="ins-pc-txn"><option value="buy">Buy</option><option value="sell">Sell</option><option value="subscribe">Subscribe</option><option value="pledge">Pledge</option><option value="other">Other</option></select></div>
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;margin-top:10px;">
          <div><label class="form-label">Security name *</label><input class="form-control" id="ins-pc-security" placeholder="e.g. Tata Consultancy Services Ltd"></div>
          <div><label class="form-label">ISIN</label><input class="form-control" id="ins-pc-isin" placeholder="INE467B01029"></div>
          <div><label class="form-label">Quantity *</label><input class="form-control" type="number" id="ins-pc-qty" min="1"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:10px;">
          <div><label class="form-label">Qty held before</label><input class="form-control" type="number" id="ins-pc-qty-before" min="0" value="0"></div>
          <div><label class="form-label">Broker DP ID</label><input class="form-control" id="ins-pc-broker-dp"></div>
          <div><label class="form-label">Broker Client ID</label><input class="form-control" id="ins-pc-broker-client"></div>
        </div>
        <h4 style="font-size:13px;margin:18px 0 8px;">Annexure 5 — UPSI Declaration (all required)</h4>
        <label class="ins-decl"><input type="checkbox" id="ins-pc-d1"> <span>I and my Immediate Relatives do not have access to, or have not received, any Unpublished Price Sensitive Information up to now.</span></label>
        <label class="ins-decl"><input type="checkbox" id="ins-pc-d2"> <span>If I gain UPSI before completing the trade, I will inform the Compliance Officer immediately and refrain from trading until it becomes Generally Available.</span></label>
        <label class="ins-decl"><input type="checkbox" id="ins-pc-d3"> <span>I and my Immediate Relatives have not contravened APP's Code of Conduct.</span></label>
        <label class="ins-decl"><input type="checkbox" id="ins-pc-d4"> <span>I have made a full and true disclosure, and I indemnify APP against penalties imposed by SEBI as a result of violations.</span></label>
        <div style="display:flex;gap:10px;align-items:end;margin-top:14px;border-top:1px solid var(--border);padding-top:14px;">
          <div style="flex:1;"><label class="form-label">Type your full name as signature</label><input class="form-control" id="ins-pc-sign"></div>
          <button class="btn btn-primary" onclick="insSubmitPC()">📤 Submit Request</button>
        </div>
      </div>
    </div>

    <div id="ins-history" class="subtab-panel">
      <div class="card" style="margin:14px;">
        <div class="card-title">📋 My Pre-Clearance History
          <span class="actions"><button class="btn btn-sm btn-ghost" onclick="insLoadHistory()">↻ Refresh</button></span></div>
        <div id="ins-pc-history" class="table-wrap"></div>
      </div>
      <div class="card" style="margin:14px;">
        <div class="card-title">📜 My Holdings Statements</div>
        <div id="ins-hold-history" class="table-wrap"></div>
      </div>
    </div>`;
  }

  // Public: render the self-service panel into a host element (associate portal).
  window.insRenderSelfService = function (hostId) {
    const host = el(hostId);
    if (!host) return;
    if (host.getAttribute('data-ins-rendered')) return;  // idempotent
    host.innerHTML = selfServiceHTML();
    host.setAttribute('data-ins-rendered', '1');
  };

  // ─── Bootstrap ─────────────────────────────────────────────────────────────
  // Works for BOTH the admin panel (#tab-insider) and the associate portal
  // (#as-tab-insider). The self-service forms use the same element IDs in both
  // pages, so the same loaders drive either one. CO-only loaders simply find no
  // matching elements on the associate page and no-op.
  let _insBooted = false;
  function doBoot() {
    if (_insBooted) return;
    _insBooted = true;
    loadMyPerms();      // hides CO sub-tabs if the markup is present; harmless otherwise
    loadStatus();
    loadAnx1();
    initHoldings();
    initPreclear();
    mountAllSignaturePads();   // draw-signature canvases on each form
    mountAllCameras();         // live identity photo widgets on each form
  }
  // Public entry point — the associate portal's switchAssocTab() calls this.
  window.insBoot = doBoot;

  function bootIfAdminVisible() {
    const panel = el('tab-insider');
    if (panel && panel.classList.contains('active')) doBoot();
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-tab="tab-insider"]')) setTimeout(bootIfAdminVisible, 50);
  });
  // Also boot if the Insider tab is the initial landing tab (admin) or if the
  // associate page already shows the panel.
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
    bootIfAdminVisible();
    const asPanel = el('as-tab-insider');
    if (asPanel && asPanel.classList.contains('active')) doBoot();
  }, 200));
})();
