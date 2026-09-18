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

// ---------- shared: profile row rendering (parent + nested handle rows) ----------

const CHANNEL_META = {
  tiktok: { label: 'TikTok', logo: 'https://img.icons8.com/?size=100&id=118640&format=png&color=000000' },
  shopee: { label: 'Shopee', logo: 'https://img.icons8.com/?size=100&id=mBkyWceUPlkM&format=png&color=000000' },
  lazada: { label: 'Lazada', logo: 'https://img.icons8.com/?size=100&id=MIG1bB2e9EAh&format=png&color=000000' },
  affiliate_plus: { label: 'Affiliate+', logo: 'https://cdn.shopify.com/s/files/1/0631/7755/6173/files/gq-red-logo-reg-long.png?v=1784103580' },
};

function channelLogo(channel, cls = 'handle-logo') {
  const meta = CHANNEL_META[channel];
  const label = meta ? meta.label : channel;
  return meta
    ? `<img class="${cls}" src="${esc(meta.logo)}" alt="${esc(label)}" title="${esc(label)}" loading="lazy" />`
    : `<span class="${cls} handle-logo-fallback" title="${esc(label)}">${esc(String(channel || '?').slice(0, 2).toUpperCase())}</span>`;
}

// Profiles table has 12 columns (a leading expand/collapse toggle + the 11
// columns in index.html's thead); handle rows span all but a leading indent
// cell that lines up under the toggle column.
const PROFILE_TOTAL_COLS = 12;

// Whether newly-rendered handle rows start expanded — kept in sync with the
// "Expand all" toolbar button so paging in more rows (or a fresh search)
// matches whatever state the admin last chose.
let allHandlesExpanded = false;

function profileRowHtml(p) {
  const handles = p.handles || [];
  const expanded = allHandlesExpanded;
  const parentRow = `<tr class="profile-row" data-id="${esc(p.internal_id)}">
    <td class="row-toggle-cell">
      <button class="row-toggle-btn${expanded ? ' expanded' : ''}" type="button" data-id="${esc(p.internal_id)}" aria-expanded="${expanded}" title="${expanded ? 'Hide handles' : 'Show handles'}">&#9656;</button>
    </td>
    <td>${esc(p.internal_id)}</td>
    <td>${esc(p.line_uid)}</td>
    <td>${esc(p.email)}</td>
    <td>${esc(p.phone)}</td>
    <td>${esc(p.nick_name) || '—'}</td>
    <td>${esc(p.full_name) || '—'}</td>
    <td>${esc(p.gender) || '—'}</td>
    <td>${p.age ?? '—'}</td>
    <td>${esc(p.shopify_customer_id) || '—'}</td>
    <td>${fmtTs(p.updated_at)}</td>
    <td class="row-actions">
      <button class="icon-btn view-btn" data-id="${esc(p.internal_id)}" title="View">&#128065;</button>
      <button class="icon-btn edit-btn" data-id="${esc(p.internal_id)}" title="Edit">&#9998;</button>
    </td>
  </tr>`;

  const hiddenAttr = expanded ? '' : ' hidden';

  const handleRows = handles.length
    ? handles
        .map(
          (h) => `<tr class="handle-row" data-handle-id="${h.id}" data-parent="${esc(p.internal_id)}"${hiddenAttr}>
        <td class="handle-indent"></td>
        <td colspan="${PROFILE_TOTAL_COLS - 1}" class="handle-cell">
          ${channelLogo(h.channel)}
          <span class="handle-value-view">${esc(h.value)}</span>
          <input class="handle-value-edit" type="text" value="${esc(h.value)}" />
          <span class="handle-status ${h.is_active ? 'is-connected' : 'is-inactive'}">
            <span class="handle-status-dot"></span>${h.is_active ? 'Connected' : 'Inactive'}
          </span>
          <span class="handle-date muted">${fmtTs(h.registered_at)}</span>
          <span class="handle-row-actions">
            <button class="icon-btn handle-edit-btn" title="Edit handle">&#9998;</button>
            <button class="icon-btn handle-save-btn" hidden title="Save">&#10003;</button>
            <button class="icon-btn handle-cancel-btn" hidden title="Cancel">&times;</button>
          </span>
          <span class="handle-result result-msg"></span>
        </td>
      </tr>`
        )
        .join('')
    : `<tr class="handle-row handle-row-empty" data-parent="${esc(p.internal_id)}"${hiddenAttr}><td class="handle-indent"></td><td colspan="${PROFILE_TOTAL_COLS - 1}" class="muted handle-cell">No handles linked</td></tr>`;

  return parentRow + handleRows;
}

function setRowsExpanded(internalId, expand) {
  const tbody = $('#profiles-tbody');
  const btn = tbody.querySelector(`.row-toggle-btn[data-id="${CSS.escape(internalId)}"]`);
  if (btn) {
    btn.classList.toggle('expanded', expand);
    btn.setAttribute('aria-expanded', String(expand));
    btn.title = expand ? 'Hide handles' : 'Show handles';
  }
  tbody.querySelectorAll(`tr.handle-row[data-parent="${CSS.escape(internalId)}"]`).forEach((tr) => { tr.hidden = !expand; });
}

function bindRowActions(tbodyEl) {
  tbodyEl.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.row-toggle-btn');
    const viewBtn = e.target.closest('.view-btn');
    const editBtn = e.target.closest('.edit-btn');
    const handleEditBtn = e.target.closest('.handle-edit-btn');
    const handleSaveBtn = e.target.closest('.handle-save-btn');
    const handleCancelBtn = e.target.closest('.handle-cancel-btn');

    if (toggleBtn) return setRowsExpanded(toggleBtn.dataset.id, !toggleBtn.classList.contains('expanded'));
    if (viewBtn) return openProfileModal(viewBtn.dataset.id, false);
    if (editBtn) return openProfileModal(editBtn.dataset.id, true);
    if (handleEditBtn) return setHandleRowEditing(handleEditBtn.closest('tr'), true);
    if (handleCancelBtn) return setHandleRowEditing(handleCancelBtn.closest('tr'), false);
    if (handleSaveBtn) return saveHandleEdit(handleSaveBtn.closest('tr'));
  });
}

$('#profiles-toggle-all-btn').addEventListener('click', () => {
  allHandlesExpanded = !allHandlesExpanded;
  const tbody = $('#profiles-tbody');
  tbody.querySelectorAll('.row-toggle-btn').forEach((btn) => {
    btn.classList.toggle('expanded', allHandlesExpanded);
    btn.setAttribute('aria-expanded', String(allHandlesExpanded));
    btn.title = allHandlesExpanded ? 'Hide handles' : 'Show handles';
  });
  tbody.querySelectorAll('.handle-row').forEach((tr) => { tr.hidden = !allHandlesExpanded; });
  $('#profiles-toggle-all-btn').textContent = allHandlesExpanded ? 'Collapse all' : 'Expand all';
});

function setHandleRowEditing(tr, editing) {
  tr.classList.toggle('editing', editing);
  tr.querySelector('.handle-edit-btn').hidden = editing;
  tr.querySelector('.handle-save-btn').hidden = !editing;
  tr.querySelector('.handle-cancel-btn').hidden = !editing;
  const resultEl = tr.querySelector('.handle-result');
  if (!editing) {
    resultEl.textContent = '';
    resultEl.className = 'handle-result result-msg';
    tr.querySelector('.handle-value-edit').value = tr.querySelector('.handle-value-view').textContent;
  }
}

async function saveHandleEdit(tr) {
  const id = tr.dataset.handleId;
  const input = tr.querySelector('.handle-value-edit');
  const viewEl = tr.querySelector('.handle-value-view');
  const resultEl = tr.querySelector('.handle-result');
  const newValue = input.value.trim();

  if (!newValue || newValue === viewEl.textContent) {
    return setHandleRowEditing(tr, false);
  }

  const { status, json } = await api(`/handles/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: { new_value: newValue, dry_run: isDryRun() },
  });

  if (status === 200) {
    const dryTag = json.dry_run ? ' [DRY RUN]' : '';
    resultEl.textContent = `Saved${dryTag}`;
    resultEl.className = 'handle-result result-msg ok';
    if (!json.dry_run) {
      viewEl.textContent = json.new_value;
      setHandleRowEditing(tr, false);
    }
  } else {
    resultEl.textContent = json.message || json.error || 'Failed to save';
    resultEl.className = 'handle-result result-msg err';
  }
}

// ---------- shared: unified view/edit profile modal ----------

const EDIT_FIELDS = ['email', 'phone', 'nick_name', 'full_name', 'gender', 'dob'];
const READONLY_FIELDS = ['line_uid', 'shopify_customer_id', 'shopify_synced_at', 'created_at', 'updated_at'];

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

$('#profile-modal').addEventListener('click', (e) => { if (e.target === $('#profile-modal')) closeModal($('#profile-modal')); });
$('#profile-modal-close').addEventListener('click', () => closeModal($('#profile-modal')));
$('#pm-close-btn').addEventListener('click', () => closeModal($('#profile-modal')));

async function openProfileModal(internalId, editing) {
  const detail = await fetchProfileDetail(internalId);
  if (!detail) return;
  renderProfileModal(detail);
  setModalEditing(editing);
  $('#profile-modal').hidden = false;
}

function renderProfileModal(detail) {
  const { profile, handles, audit_log, sync_tasks, line_uid_history } = detail;

  $('#pm-internal-id').textContent = profile.internal_id;

  const form = $('#pm-form');
  form.dataset.internalId = profile.internal_id;

  const editableRows = EDIT_FIELDS.map((f) => {
    const v = profile[f] || '';
    return `<dt>${f}</dt><dd>
      <span class="pm-view" data-field="${f}">${esc(v) || '—'}</span>
      <input class="pm-input" name="${f}" type="text" value="${esc(v)}" />
    </dd>`;
  }).join('');

  const readonlyRows = READONLY_FIELDS.map((f) => {
    const v = f.endsWith('_at') ? fmtTs(profile[f]) : (profile[f] ?? '—');
    return `<dt>${f}</dt><dd><span class="pm-view">${esc(v)}</span></dd>`;
  }).join('');

  $('#pm-fields').innerHTML = editableRows + readonlyRows;

  const original = {};
  for (const f of EDIT_FIELDS) original[f] = profile[f] || '';
  form.dataset.original = JSON.stringify(original);

  $('#pm-handles').innerHTML = handles.length
    ? handles.map((h) => `<li>${channelLogo(h.channel, 'handle-logo-sm')} <strong>${esc(h.value)}</strong> ${h.is_active ? '' : '(inactive)'} — registered ${fmtTs(h.registered_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pm-line-history').innerHTML = line_uid_history.length
    ? line_uid_history.map((h) => `<li>${esc(h.old_line_uid)} → changed by ${esc(h.changed_by)} at ${fmtTs(h.changed_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pm-sync-tasks').innerHTML = sync_tasks.length
    ? sync_tasks.map((t) => `<li>#${t.id} ${esc(t.status)} (${t.attempts} attempts)${t.last_error ? ` — ${esc(t.last_error)}` : ''} — ${fmtTs(t.updated_at)}
        ${t.status !== 'success' ? `<button class="link-btn retry-sync-task" data-id="${t.id}">retry</button>` : ''}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pm-audit-log').innerHTML = audit_log.length
    ? audit_log.map((a) => `<li>[${esc(a.actor_type)}${a.actor_id ? `:${esc(a.actor_id)}` : ''}] ${esc(a.field)}: ${esc(a.old_value)} → ${esc(a.new_value)} — ${fmtTs(a.occurred_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pm-relink-form').dataset.internalId = profile.internal_id;
  $('#pm-notify-btn').dataset.internalId = profile.internal_id;
  $('#pm-save-result').textContent = '';
  $('#pm-relink-result').textContent = '';
  $('#pm-notify-result').textContent = '';
}

function setModalEditing(editing) {
  const modal = $('#profile-modal');
  modal.classList.toggle('editing', editing);
  $('#pm-edit-btn').hidden = editing;
  $('#pm-save-btn').hidden = !editing;
  $('#pm-cancel-btn').hidden = !editing;
  $('#pm-relink-section').hidden = !editing;
  $('#pm-notify-section').hidden = !editing;
}

$('#pm-edit-btn').addEventListener('click', () => setModalEditing(true));

$('#pm-cancel-btn').addEventListener('click', () => {
  const form = $('#pm-form');
  const original = JSON.parse(form.dataset.original || '{}');
  for (const f of EDIT_FIELDS) { if (form.elements[f]) form.elements[f].value = original[f] || ''; }
  $('#pm-save-result').textContent = '';
  setModalEditing(false);
});

$('#pm-sync-tasks').addEventListener('click', async (e) => {
  const btn = e.target.closest('.retry-sync-task');
  if (!btn) return;
  const { status, json } = await api(`/sync-tasks/${btn.dataset.id}/retry`, { method: 'POST', body: { dry_run: isDryRun() } });
  alert(status === 200 ? `Retried${json.dry_run ? ' (dry run)' : ''}` : json.message || 'Failed');
  if (status === 200 && !isDryRun()) {
    const detail = await fetchProfileDetail($('#pm-internal-id').textContent);
    if (detail) renderProfileModal(detail);
  }
});

$('#pm-save-btn').addEventListener('click', async () => {
  const form = $('#pm-form');
  const internal_id = form.dataset.internalId;
  const original = JSON.parse(form.dataset.original || '{}');
  const changed = EDIT_FIELDS.filter((f) => (form.elements[f].value || '') !== (original[f] || ''));

  if (changed.length === 0) {
    $('#pm-save-result').textContent = 'Nothing changed';
    $('#pm-save-result').className = 'result-msg';
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

  if (allOk && !isDryRun()) {
    const detail = await fetchProfileDetail(internal_id);
    if (detail) renderProfileModal(detail); // clears #pm-save-result — set the message after
    setModalEditing(false);
    refreshTables();
  }

  $('#pm-save-result').textContent = `${allOk ? 'Saved' : 'Some fields failed'}${dryTag} — ${summary}`;
  $('#pm-save-result').className = `result-msg ${allOk ? 'ok' : 'err'}`;
});

$('#pm-relink-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const internal_id = form.dataset.internalId;
  const new_line_uid = form.new_line_uid.value;
  const { status, json } = await api('/relink-line-uid', { method: 'POST', body: { internal_id, new_line_uid, dry_run: isDryRun() } });
  if (status === 200 && !isDryRun()) {
    form.reset();
    const detail = await fetchProfileDetail(internal_id);
    if (detail) renderProfileModal(detail); // clears #pm-relink-result — set the message after
    refreshTables();
  }
  resultLine($('#pm-relink-result'), status, json);
});

$('#pm-notify-btn').addEventListener('click', async () => {
  const internal_id = $('#pm-notify-btn').dataset.internalId;
  const { status, json } = await api('/notify', { method: 'POST', body: { internal_id, dry_run: isDryRun() } });
  resultLine($('#pm-notify-result'), status, json);
});

function refreshTables() {
  loadStatsOverview();
  loadTimeseries();
  loadDemographics();
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

  $('#stat-handles').textContent = fmtNum(json.handles_linked);
  $('#stat-open-errors').textContent = fmtNum(json.open_errors);
}

function goToErrorsTab() {
  $all('.tab-btn').forEach((b) => b.classList.remove('active'));
  $all('.tab-panel').forEach((p) => p.classList.remove('active'));
  $('.tab-btn[data-tab="errors"]').classList.add('active');
  $('#tab-errors').classList.add('active');
  $('#errors-status').value = 'open';
  loadErrors();
}

$('#stat-card-errors').addEventListener('click', goToErrorsTab);
$('#stat-card-errors').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToErrorsTab(); }
});

async function refreshDashboard() {
  const btn = $('#dashboard-refresh-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await Promise.all([loadStatsOverview(), loadTimeseries(), loadDemographics()]);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$('#dashboard-refresh-btn').addEventListener('click', refreshDashboard);

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
  tbody.insertAdjacentHTML('beforeend', (json.profiles || []).map((p) => profileRowHtml(p)).join(''));
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
searchProfiles(true);
loadErrors();
loadSyncTasks();
