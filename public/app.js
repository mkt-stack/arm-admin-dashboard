// ---------- tiny helpers ----------

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function isDryRun() { return $('#dry-run-toggle').checked; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTs(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }

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
  for (const p of json.profiles || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><a href="#" class="profile-link" data-id="${esc(p.internal_id)}">${esc(p.internal_id)}</a></td>
      <td>${esc(p.line_uid)}</td><td>${esc(p.email)}</td><td>${esc(p.phone)}</td>
      <td>${esc(p.shopify_customer_id) || '—'}</td><td>${fmtTs(p.updated_at)}</td>`;
    tbody.appendChild(tr);
  }
  profilesCursor = json.next_cursor || null;
  $('#profiles-load-more').hidden = !profilesCursor;
}

$('#profile-search-btn').addEventListener('click', () => searchProfiles(true));
$('#profile-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchProfiles(true); });
$('#profiles-load-more').addEventListener('click', () => searchProfiles(false));

$('#profiles-tbody').addEventListener('click', (e) => {
  const link = e.target.closest('.profile-link');
  if (!link) return;
  e.preventDefault();
  openProfileDetail(link.dataset.id);
});

async function openProfileDetail(internalId) {
  const { status, json } = await api(`/profiles/${encodeURIComponent(internalId)}`);
  if (status !== 200) {
    alert(json.message || 'Failed to load profile');
    return;
  }
  const { profile, handles, audit_log, sync_tasks, line_uid_history } = json;

  $('#pd-internal-id').textContent = profile.internal_id;
  $('#pd-fields').innerHTML = ['line_uid', 'email', 'phone', 'nick_name', 'full_name', 'gender', 'dob', 'shopify_customer_id', 'shopify_synced_at', 'created_at', 'updated_at']
    .map((f) => {
      const v = f.endsWith('_at') ? fmtTs(profile[f]) : (profile[f] ?? '—');
      return `<dt>${f}</dt><dd>${esc(v)}</dd>`;
    })
    .join('');

  $('#pd-handles').innerHTML = handles.length
    ? handles.map((h) => `<li>${esc(h.channel)}: ${esc(h.value)} ${h.is_active ? '' : '(inactive)'} — registered ${fmtTs(h.registered_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pd-line-history').innerHTML = line_uid_history.length
    ? line_uid_history.map((h) => `<li>${esc(h.old_line_uid)} → changed by ${esc(h.changed_by)} at ${fmtTs(h.changed_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pd-sync-tasks').innerHTML = sync_tasks.length
    ? sync_tasks.map((t) => `<li>#${t.id} ${esc(t.status)} (${t.attempts} attempts)${t.last_error ? ` — ${esc(t.last_error)}` : ''} — ${fmtTs(t.updated_at)}
        ${t.status !== 'success' ? `<button class="link-btn retry-sync-task" data-id="${t.id}">retry</button>` : ''}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pd-audit-log').innerHTML = audit_log.length
    ? audit_log.map((a) => `<li>[${esc(a.actor_type)}${a.actor_id ? `:${esc(a.actor_id)}` : ''}] ${esc(a.field)}: ${esc(a.old_value)} → ${esc(a.new_value)} — ${fmtTs(a.occurred_at)}</li>`).join('')
    : '<li class="muted">none</li>';

  $('#pd-edit-form').dataset.internalId = profile.internal_id;
  $('#pd-relink-form').dataset.internalId = profile.internal_id;
  $('#pd-notify-form').dataset.internalId = profile.internal_id;
  $('#pd-edit-result').textContent = '';
  $('#pd-relink-result').textContent = '';
  $('#pd-notify-result').textContent = '';

  $('#profile-detail').hidden = false;
}

$('#profile-detail-close').addEventListener('click', () => { $('#profile-detail').hidden = true; });

$('#pd-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const internal_id = form.dataset.internalId;
  const field = form.field.value;
  const new_value = form.new_value.value;
  const { status, json } = await api('/update-profile', { method: 'POST', body: { internal_id, field, new_value, dry_run: isDryRun() } });
  resultLine($('#pd-edit-result'), status, json);
  if (status === 200 && !isDryRun()) openProfileDetail(internal_id);
});

$('#pd-relink-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const internal_id = form.dataset.internalId;
  const new_line_uid = form.new_line_uid.value;
  const { status, json } = await api('/relink-line-uid', { method: 'POST', body: { internal_id, new_line_uid, dry_run: isDryRun() } });
  resultLine($('#pd-relink-result'), status, json);
  if (status === 200 && !isDryRun()) openProfileDetail(internal_id);
});

$('#pd-notify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const internal_id = e.target.dataset.internalId;
  const { status, json } = await api('/notify', { method: 'POST', body: { internal_id, dry_run: isDryRun() } });
  resultLine($('#pd-notify-result'), status, json);
});

$('#pd-sync-tasks').addEventListener('click', async (e) => {
  const btn = e.target.closest('.retry-sync-task');
  if (!btn) return;
  const { status, json } = await api(`/sync-tasks/${btn.dataset.id}/retry`, { method: 'POST', body: { dry_run: isDryRun() } });
  alert(status === 200 ? `Retried${json.dry_run ? ' (dry run)' : ''}` : json.message || 'Failed');
  if (status === 200 && !isDryRun()) openProfileDetail($('#pd-edit-form').dataset.internalId);
});

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
searchProfiles(true);
loadErrors();
loadSyncTasks();
