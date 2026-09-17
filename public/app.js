// ---------- tiny helpers ----------

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function isDryRun() { return $('#dry-run-toggle').checked; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTs(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }
function fmtNum(n) { return (n ?? 0).toLocaleString(); }

function pctSpan(pct) {
  if (pct === null || pct === undefined) return '<span class="neutral">—</span>';
  const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
  const sign = pct > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${pct.toFixed(1)}%</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function resultLine(el, status, json) {
  const dryTag = json.dry_run ? ' [DRY RUN — nothing written]' : '';
  if (status >= 200 && status < 300) {
    el.textContent = `OK${dryTag}: ${JSON.stringify(json)}`;
    el.className = 'result-msg ok';
  } else {
    el.textContent = `Error ${status}${dryTag}: ${json.message || json.error || JSON.stringify(json)}`;
    el.className = 'result-msg err';
  }
}

// ---------- auth / shell ----------

async function loadWhoami() {
  const res = await fetch('/me');
  if (res.status === 401) { window.location.href = '/login'; return; }
  const json = await res.json().catch(() => ({}));
  if (json.username) $('#whoami').textContent = `Signed in as ${json.username}`;
}

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
});

$all('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $all('.tab-btn').forEach((b) => b.classList.remove('active'));
    $all('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- shared: profile row rendering + view/edit modals ----------

function profileRowHtml(p, dateField) {
  return `<tr>
    <td>${esc(p.internal_id)}</td>
    <td>${esc(p.line_uid)}</td>
    <td>${esc(p.email)}</td>
    <td>${esc(p.phone)}</td>
    <td>${esc(p.shopify_customer_id) || '—'}</td>
    <td>${fmtTs(dateField === 'created' ? p.created_at : p.updated_at)}</td>
    <td class="row-actions">
      <button class="icon-btn view-btn" data-id="${esc(p.internal_id)}" title="View">&#128065;</button>
      <button class="icon-btn edit-btn" data-id="${esc(p.internal_id)}" title="Edit">&#9998;</button>
    </td>
  </tr>`;
}

function bindRowActions(tbodyEl) {
  tbodyEl.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('.view-btn');
    const editBtn = e.target.closest('.edit-btn');
    if (viewBtn) openView(viewBtn.dataset.id);
    else if (editBtn) openEdit(editBtn.dataset.id);
  });
}

let currentDetail = null;

async function fetchProfileDetail(internalId) {
  const { status, json } = await api(`/profiles/${encodeURIComponent(internalId)}`);
  if (status !== 200) {
    alert(json.message || 'Failed to load profile');
    return null;
  }
  currentDetail = json;
  return json;
}

function closeModal(el) { el.hidden = true; }

[$('#view-modal'), $('#edit-modal')].forEach((overlay) => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay); });
});
$('#view-modal-close').addEventListener('click', () => closeModal($('#view-modal')));
$('#view-close-btn').addEventListener('click', () => closeModal($('#view-modal')));
$('#edit-modal-close').addEventListener('click', () => closeModal($('#edit-modal')));
$('#edit-close-btn').addEventListener('click', () => closeModal($('#edit-modal')));

async function openView(internalId) {
  const detail = await fetchProfileDetail(internalId);
  if (!detail) return;
  renderView(detail);
  $('#view-modal').hidden = false;
}

function renderView(detail) {
  const { profile, handles, audit_log, sync_tasks, line_uid_history } = detail;

  $('#view-internal-id').textContent = profile.internal_id;
  $('#view-fields').innerHTML = ['line_uid', 'email', 'phone', 'nick_name', 'full_name', 'gender', 'dob', 'shopify_customer_id', 'shopify_synced_at', 'created_at', 'updated_at']
    .map((f) => {
      const v = f.endsWith('_at') ? fmtTs(profile[f]) : (profile[f] ?? '—');
      return `<dt>${f}</dt><dd>${esc(v)}</dd>`;
    })
    .join('');

  $('#view-handles').innerHTML = handles.length
    ? handles.map((h) => `<li>${esc(h.channel)}: ${esc(h.value)} ${h.is_active ? '' : '(inactive)'} — registered ${fmtTs(h.registered_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#view-line-history').innerHTML = line_uid_history.length
    ? line_uid_history.map((h) => `<li>${esc(h.old_line_uid)} → changed by ${esc(h.changed_by)} at ${fmtTs(h.changed_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#view-sync-tasks').innerHTML = sync_tasks.length
    ? sync_tasks.map((t) => `<li>#${t.id} ${esc(t.status)} (${t.attempts} attempts)${t.last_error ? ` — ${esc(t.last_error)}` : ''} — ${fmtTs(t.updated_at)}
        ${t.status !== 'success' ? `<button class="link-btn retry-sync-task" data-id="${t.id}">retry</button>` : ''}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#view-audit-log').innerHTML = audit_log.length
    ? audit_log.map((a) => `<li>[${esc(a.actor_type)}${a.actor_id ? `:${esc(a.actor_id)}` : ''}] ${esc(a.field)}: ${esc(a.old_value)} → ${esc(a.new_value)} — ${fmtTs(a.occurred_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#view-edit-btn').dataset.internalId = profile.internal_id;
}

$('#view-edit-btn').addEventListener('click', () => {
  const id = $('#view-edit-btn').dataset.internalId;
  closeModal($('#view-modal'));
  openEdit(id);
});

$('#view-sync-tasks').addEventListener('click', async (e) => {
  const btn = e.target.closest('.retry-sync-task');
  if (!btn) return;
  const { status, json } = await api(`/sync-tasks/${btn.dataset.id}/retry`, { method: 'POST', body: { dry_run: isDryRun() } });
  alert(status === 200 ? `Retried${json.dry_run ? ' (dry run)' : ''}` : json.message || 'Failed');
  if (status === 200 && !isDryRun()) {
    const detail = await fetchProfileDetail($('#view-internal-id').textContent);
    if (detail) renderView(detail);
  }
});

const EDIT_FIELDS = ['email', 'phone', 'nick_name', 'full_name', 'gender', 'dob'];

async function openEdit(internalId) {
  const detail = currentDetail && currentDetail.profile.internal_id === internalId ? currentDetail : await fetchProfileDetail(internalId);
  if (!detail) return;
  const { profile } = detail;

  $('#edit-internal-id').textContent = profile.internal_id;
  const form = $('#edit-form');
  form.dataset.internalId = profile.internal_id;
  const original = {};
  for (const f of EDIT_FIELDS) {
    form.elements[f].value = profile[f] || '';
    original[f] = profile[f] || '';
  }
  form.dataset.original = JSON.stringify(original);

  $('#edit-relink-form').dataset.internalId = profile.internal_id;
  $('#edit-notify-btn').dataset.internalId = profile.internal_id;
  $('#edit-save-result').textContent = '';
  $('#edit-relink-result').textContent = '';
  $('#edit-notify-result').textContent = '';

  $('#edit-modal').hidden = false;
}

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const internal_id = form.dataset.internalId;
  const original = JSON.parse(form.dataset.original || '{}');
  const changed = EDIT_FIELDS.filter((f) => (form.elements[f].value || '') !== (original[f] || ''));

  if (changed.length === 0) {
    $('#edit-save-result').textContent = 'Nothing changed';
    $('#edit-save-result').className = 'result-msg';
    return;
  }

  const results = [];
  for (const field of changed) {
    const { status, json } = await api('/update-profile', {
      method: 'POST',
      body: { internal_id, field, new_value: form.elements[field].value, dry_run: isDryRun() },
    });
    results.push({ field, status, json });
  }

  const allOk = results.every((r) => r.status === 200);
  const dryTag = isDryRun() ? ' [DRY RUN — nothing written]' : '';
  const summary = results.map((r) => `${r.field}: ${r.status === 200 ? 'OK' : r.json.message || r.json.error || 'failed'}`).join(' | ');
  $('#edit-save-result').textContent = `${allOk ? 'Saved' : 'Some fields failed'}${dryTag} — ${summary}`;
  $('#edit-save-result').className = `result-msg ${allOk ? 'ok' : 'err'}`;

  if (allOk && !isDryRun()) {
    const detail = await fetchProfileDetail(internal_id);
    if (detail) {
      const fresh = {};
      for (const f of EDIT_FIELDS) fresh[f] = detail.profile[f] || '';
      form.dataset.original = JSON.stringify(fresh);
    }
    refreshTables();
  }
});

$('#edit-relink-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const internal_id = form.dataset.internalId;
  const new_line_uid = form.new_line_uid.value;
  const { status, json } = await api('/relink-line-uid', { method: 'POST', body: { internal_id, new_line_uid, dry_run: isDryRun() } });
  resultLine($('#edit-relink-result'), status, json);
  if (status === 200 && !isDryRun()) {
    form.reset();
    await fetchProfileDetail(internal_id);
    refreshTables();
  }
});

$('#edit-notify-btn').addEventListener('click', async () => {
  const internal_id = $('#edit-notify-btn').dataset.internalId;
  const { status, json } = await api('/notify', { method: 'POST', body: { internal_id, dry_run: isDryRun() } });
  resultLine($('#edit-notify-result'), status, json);
});

function refreshTables() {
  loadDashboardTable(true);
  searchProfiles(true);
}

// ---------- Dashboard tab ----------

let statCharts = { cumulative: null, daily: null, gender: null, age: null, funnel: null };

const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#64748b', '#db2777'];

async function loadStatsOverview() {
  const { json } = await api('/stats/overview');
  if (!json || json.total_affiliates === undefined) return;

  $('#stat-total').textContent = fmtNum(json.total_affiliates);
  $('#stat-total-sub').innerHTML = `${json.net_increase_30d >= 0 ? '+' : ''}${fmtNum(json.net_increase_30d)} last 30 days (${pctSpan(json.pct_change_30d)})`;

  $('#stat-mtd').textContent = fmtNum(json.mtd_signups);
  $('#stat-mtd-sub').innerHTML = `${fmtNum(json.prev_month_signups)} last month (${pctSpan(json.pct_change_mom)} MoM)`;

  $('#stat-today').textContent = fmtNum(json.today_signups);
  $('#stat-today-sub').innerHTML = `${fmtNum(json.yesterday_signups)} yesterday (${pctSpan(json.pct_change_dod)} DoD)`;
}

function chartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 }, grid: { display: false } },
      y: { beginAtZero: true, grid: { color: '#eef0f3' }, ticks: { precision: 0 } },
    },
  };
}

async function loadTimeseries() {
  const { json } = await api('/stats/timeseries');
  if (!json) return;

  const cumulative = json.cumulative || [];
  const daily = json.daily_new_90d || [];

  if (statCharts.cumulative) statCharts.cumulative.destroy();
  statCharts.cumulative = new Chart($('#chart-cumulative'), {
    type: 'line',
    data: {
      labels: cumulative.map((d) => d.date),
      datasets: [{ label: 'Total affiliates', data: cumulative.map((d) => d.total), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', fill: true, tension: 0.15, pointRadius: 0, borderWidth: 2 }],
    },
    options: chartOptions(),
  });

  if (statCharts.daily) statCharts.daily.destroy();
  statCharts.daily = new Chart($('#chart-daily'), {
    type: 'line',
    data: {
      labels: daily.map((d) => d.date),
      datasets: [{ label: 'New signups', data: daily.map((d) => d.count), borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', fill: true, tension: 0.15, pointRadius: 0, borderWidth: 2 }],
    },
    options: chartOptions(),
  });
}

async function loadDemographics() {
  const { json } = await api('/stats/demographics');
  if (!json) return;

  renderGenderChart(json.gender || []);
  renderAgeChart(json.age || { average_age: null, sample_size: 0, buckets: [] });
  renderFunnelChart(json.channel_funnel || { total: 0, has_tiktok: 0, has_shopee: 0, has_both: 0 });
}

function renderGenderChart(gender) {
  if (statCharts.gender) statCharts.gender.destroy();
  statCharts.gender = new Chart($('#chart-gender'), {
    type: 'doughnut',
    data: {
      labels: gender.map((g) => `${g.label} (${g.count})`),
      datasets: [{ data: gender.map((g) => g.count), backgroundColor: gender.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 1, borderColor: '#fff' }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
    },
  });
}

function renderAgeChart(age) {
  const buckets = age.buckets || [];
  $('#age-subtitle').textContent = age.sample_size > 0 ? `avg ${age.average_age} yrs (n=${fmtNum(age.sample_size)})` : '(no DOB data yet)';

  if (statCharts.age) statCharts.age.destroy();
  statCharts.age = new Chart($('#chart-age'), {
    type: 'bar',
    data: {
      labels: buckets.map((b) => b.range),
      datasets: [{ label: 'Affiliates', data: buckets.map((b) => b.count), backgroundColor: '#7c3aed', borderRadius: 4, maxBarThickness: 40 }],
    },
    options: chartOptions(),
  });
}

function renderFunnelChart(funnel) {
  const stages = [
    { label: 'Total Affiliates', value: funnel.total },
    { label: 'Has TikTok', value: funnel.has_tiktok },
    { label: 'Has Shopee', value: funnel.has_shopee },
    { label: 'Has Both', value: funnel.has_both },
  ];

  if (statCharts.funnel) statCharts.funnel.destroy();
  statCharts.funnel = new Chart($('#chart-funnel'), {
    type: 'bar',
    data: {
      labels: stages.map((s) => s.label),
      datasets: [{ data: stages.map((s) => s.value), backgroundColor: '#2563eb', borderRadius: 4, maxBarThickness: 28 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, grid: { color: '#eef0f3' }, ticks: { precision: 0 } },
        y: { grid: { display: false } },
      },
    },
  });

  const total = funnel.total || 0;
  $('#funnel-legend').innerHTML = stages
    .map((s) => {
      const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : '0.0';
      return `<li><span>${esc(s.label)}</span><span class="funnel-count">${fmtNum(s.value)} (${pct}%)</span></li>`;
    })
    .join('');
}

let dashboardCursor = null;

async function loadDashboardTable(reset = true) {
  if (reset) dashboardCursor = null;
  const params = new URLSearchParams({ sort: 'desc', limit: '25' });
  if (dashboardCursor) params.set('cursor', dashboardCursor);
  const { json } = await api(`/profiles?${params.toString()}`);
  const tbody = $('#dashboard-tbody');
  if (reset) tbody.innerHTML = '';
  tbody.insertAdjacentHTML('beforeend', (json.profiles || []).map((p) => profileRowHtml(p, 'created')).join(''));
  dashboardCursor = json.next_cursor || null;
  $('#dashboard-load-more').hidden = !dashboardCursor;
}

$('#dashboard-load-more').addEventListener('click', () => loadDashboardTable(false));
bindRowActions($('#dashboard-tbody'));

// ---------- Profiles tab ----------

let profilesCursor = null;

async function searchProfiles(reset = true) {
  if (reset) profilesCursor = null;
  const q = $('#profile-search').value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (profilesCursor) params.set('cursor', profilesCursor);
  const { json } = await api(`/profiles?${params.toString()}`);
  const tbody = $('#profiles-tbody');
  if (reset) tbody.innerHTML = '';
  tbody.insertAdjacentHTML('beforeend', (json.profiles || []).map((p) => profileRowHtml(p, 'updated')).join(''));
  profilesCursor = json.next_cursor || null;
  $('#profiles-load-more').hidden = !profilesCursor;
}

$('#profile-search-btn').addEventListener('click', () => searchProfiles(true));
$('#profile-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchProfiles(true); });
$('#profiles-load-more').addEventListener('click', () => searchProfiles(false));
bindRowActions($('#profiles-tbody'));

// ---------- Errors tab ----------

async function loadErrors() {
  const status = $('#errors-status').value;
  const { json } = await api(`/errors?status=${encodeURIComponent(status)}`);
  const tbody = $('#errors-tbody');
  tbody.innerHTML = (json.errors || []).map((err) => `
    <tr>
      <td>${err.id}</td>
      <td>${fmtTs(err.occurred_at)}</td>
      <td>${esc(err.source_flow)}</td>
      <td>${esc(err.line_uid)}</td>
      <td>${esc(err.error_category)}</td>
      <td><pre class="field-errors">${esc(err.field_errors)}</pre></td>
      <td>
        <button class="retry-error" data-id="${err.id}">Retry</button>
        <button class="dismiss-error" data-id="${err.id}">Dismiss</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No errors</td></tr>';
}

$('#errors-load-btn').addEventListener('click', loadErrors);

$('#errors-tbody').addEventListener('click', async (e) => {
  const retryBtn = e.target.closest('.retry-error');
  const dismissBtn = e.target.closest('.dismiss-error');
  if (retryBtn) {
    const { status, json } = await api(`/errors/${retryBtn.dataset.id}/retry`, { method: 'POST', body: { dry_run: isDryRun() } });
    alert(status === 200 ? `Reopened${json.dry_run ? ' (dry run)' : ''}` : json.message || 'Failed');
    if (!isDryRun()) loadErrors();
  } else if (dismissBtn) {
    const { status, json } = await api(`/errors/${dismissBtn.dataset.id}/dismiss`, { method: 'POST', body: { dry_run: isDryRun() } });
    alert(status === 200 ? `Dismissed${json.dry_run ? ' (dry run)' : ''}` : json.message || 'Failed');
    if (!isDryRun()) loadErrors();
  }
});

// ---------- Sync Tasks tab ----------

async function loadSyncTasks() {
  const status = $('#sync-tasks-status').value;
  const { json } = await api(`/sync-tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  const tbody = $('#sync-tasks-tbody');
  tbody.innerHTML = (json.sync_tasks || []).map((t) => `
    <tr>
      <td>${t.id}</td>
      <td>${esc(t.internal_id)}</td>
      <td>${esc(t.status)}</td>
      <td>${t.attempts}</td>
      <td>${esc(t.last_error) || '—'}</td>
      <td>${fmtTs(t.updated_at)}</td>
      <td>${t.status !== 'success' ? `<button class="retry-task" data-id="${t.id}">Retry</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No sync tasks</td></tr>';
}

$('#sync-tasks-load-btn').addEventListener('click', loadSyncTasks);

$('#sync-tasks-tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.retry-task');
  if (!btn) return;
  const { status, json } = await api(`/sync-tasks/${btn.dataset.id}/retry`, { method: 'POST', body: { dry_run: isDryRun() } });
  alert(status === 200 ? `Retried${json.dry_run ? ' (dry run)' : ''}` : json.message || 'Failed');
  if (!isDryRun()) loadSyncTasks();
});

// ---------- init ----------

loadWhoami();
loadStatsOverview();
loadTimeseries();
loadDemographics();
loadDashboardTable(true);
searchProfiles(true);
loadErrors();
loadSyncTasks();
