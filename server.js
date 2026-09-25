/**
 * arm-admin-dashboard — the admin UI for arm-worker-v2.
 *
 * Auth model (per PROJECT_CONTEXT.md decision, 2026-09-17, extended to
 * multi-user 2026-09-18): a fixed roster of username/password accounts
 * defined by the ADMIN_UI_USERS env var — still not per-admin *accounts* in
 * the sense of self-service signup or a users table, just more than one
 * fixed pair now, and still not Cloudflare Access. On success this server
 * sets a signed, httpOnly session cookie; the browser never sees a password
 * again after login, and never sees ARM_ADMIN_TOKEN at all — that's held
 * server-side only and attached to every call this server proxies through to
 * arm-worker-v2's /admin/* API. The logged-in username is threaded through
 * as `admin_id` on every mutating call, so kol_audit_log/kol_notifications_log
 * rows now trace back to the actual person who did it, not a shared "admin".
 *
 * Every mutating /api/* route accepts `{ dry_run: true }` in its body and
 * passes it straight through to the worker (see arm-worker-v2's PROJECT_CONTEXT.md
 * §7) — the frontend's "Dry run" toggle is what sets this.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildProfilesWorkbook } from './profiles-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ADMIN_UI_USERS,
  SESSION_SECRET,
  ARM_WORKER_BASE_URL,
  ARM_ADMIN_TOKEN,
  // Optional — not a secret, just the store handle used to build "open in
  // Shopify admin" links on the Profiles tab. Unset just hides that button.
  SHOPIFY_STORE_DOMAIN,
  PORT = '3000',
  NODE_ENV,
} = process.env;

const REQUIRED_ENV = { ADMIN_UI_USERS, SESSION_SECRET, ARM_WORKER_BASE_URL, ARM_ADMIN_TOKEN };
for (const [name, val] of Object.entries(REQUIRED_ENV)) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

// ADMIN_UI_USERS is a JSON object: { "username": "password", ... } — at
// least one entry required. Plaintext in an env var, same trust boundary as
// ARM_ADMIN_TOKEN/SESSION_SECRET already relied on (Railway variables are
// only visible to project members) — add bcrypt hashing here later if that
// boundary ever stops being good enough.
let USERS;
try {
  USERS = JSON.parse(ADMIN_UI_USERS);
} catch {
  USERS = null;
}
if (!USERS || typeof USERS !== 'object' || Array.isArray(USERS) || Object.keys(USERS).length === 0) {
  console.error('ADMIN_UI_USERS must be a JSON object of {"username":"password",...} with at least one entry');
  process.exit(1);
}
for (const [username, password] of Object.entries(USERS)) {
  if (typeof password !== 'string' || !password) {
    console.error(`ADMIN_UI_USERS: user "${username}" has an empty/invalid password`);
    process.exit(1);
  }
}

const WORKER_BASE = ARM_WORKER_BASE_URL.replace(/\/$/, '');
const IS_PROD = NODE_ENV === 'production';
const SESSION_COOKIE = 'arm_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
// Compared against when the submitted username isn't in USERS at all, so a
// bad username takes the same code path (and roughly the same time) as a
// bad password for a real username — doesn't reveal which one was wrong.
const DUMMY_PASSWORD = crypto.randomBytes(24).toString('hex');

const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// ---------- auth ----------

// Constant-time compare, padded so a length mismatch doesn't short-circuit
// early and leak timing info about the correct length.
function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);
  const aPadded = Buffer.concat([aBuf, Buffer.alloc(maxLen - aBuf.length)]);
  const bPadded = Buffer.concat([bBuf, Buffer.alloc(maxLen - bBuf.length)]);
  return crypto.timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

function createSessionValue(username) {
  return JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS });
}

function readSession(req) {
  const raw = req.signedCookies[SESSION_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.exp || parsed.exp < Date.now() || !parsed.u) return null;
    return parsed;
  } catch {
    return null;
  }
}

function requireAuthPage(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect('/login');
  req.adminUsername = session.u;
  next();
}

function requireAuthApi(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.adminUsername = session.u;
  next();
}

app.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '');
  const userExists = Object.prototype.hasOwnProperty.call(USERS, uname);
  const expectedPassword = userExists ? USERS[uname] : DUMMY_PASSWORD;
  const passOk = timingSafeStringEqual(password || '', expectedPassword);
  if (!userExists || !passOk) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.cookie(SESSION_COOKIE, createSessionValue(uname), {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    signed: true,
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/me', requireAuthApi, (req, res) => {
  res.json({ username: req.adminUsername });
});

app.use('/assets', express.static(path.join(__dirname, 'public')));

// ---------- proxy to arm-worker-v2's /admin/* API ----------

async function callWorker(pathAndQuery, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${WORKER_BASE}${pathAndQuery}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-Admin-Token': ARM_ADMIN_TOKEN,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network failure reaching arm-worker-v2 (DNS, timeout, connection
    // refused, ...) — surface as a clean 502 to the browser instead of an
    // unhandled rejection that would take the whole server down.
    return { status: 502, json: { code: 'WORKER_UNREACHABLE', message: `Could not reach arm-worker-v2: ${err.message}` } };
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const api = express.Router();
api.use(requireAuthApi);

api.get('/config', (req, res) => {
  // worker_base_url isn't a secret (it's the worker's public deployed URL) —
  // the Survey Keys tab uses it to build the copiable /decrypt-surveycake
  // endpoint link. ARM_ADMIN_TOKEN stays server-side only, same as ever.
  res.json({ shopify_store_domain: SHOPIFY_STORE_DOMAIN || null, worker_base_url: WORKER_BASE });
});

api.get('/profiles', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await callWorker(`/admin/profiles${qs ? `?${qs}` : ''}`);
  res.status(status).json(json);
});

api.get('/stats/overview', async (req, res) => {
  const { status, json } = await callWorker('/admin/stats/overview');
  res.status(status).json(json);
});

api.get('/stats/timeseries', async (req, res) => {
  const { status, json } = await callWorker('/admin/stats/timeseries');
  res.status(status).json(json);
});

api.get('/stats/demographics', async (req, res) => {
  const { status, json } = await callWorker('/admin/stats/demographics');
  res.status(status).json(json);
});

// Registered before /profiles/:id so "export" isn't swallowed as an :id.
// Streams an .xlsx straight to the browser — the worker only ever returns
// JSON (arm-worker-v2/src/index.js's exportProfiles), this is where that
// gets turned into the actual file.
api.get('/profiles/export', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await callWorker(`/admin/profiles/export${qs ? `?${qs}` : ''}`);
  if (status !== 200) return res.status(status).json(json);

  const workbook = buildProfilesWorkbook(json.profiles || []);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15); // YYYYMMDDTHHmmss
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="arm-profiles-export-${stamp}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

api.get('/profiles/:id', async (req, res) => {
  const { status, json } = await callWorker(`/admin/profiles/${encodeURIComponent(req.params.id)}`);
  res.status(status).json(json);
});

api.get('/errors', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await callWorker(`/admin/errors${qs ? `?${qs}` : ''}`);
  res.status(status).json(json);
});

api.post('/errors/:id/retry', async (req, res) => {
  const { status, json } = await callWorker(`/admin/errors/${encodeURIComponent(req.params.id)}/retry`, {
    method: 'POST',
    body: { admin_id: req.adminUsername, dry_run: (req.body || {}).dry_run === true },
  });
  res.status(status).json(json);
});

api.post('/errors/:id/dismiss', async (req, res) => {
  const { status, json } = await callWorker(`/admin/errors/${encodeURIComponent(req.params.id)}/dismiss`, {
    method: 'POST',
    body: { admin_id: req.adminUsername, dry_run: (req.body || {}).dry_run === true },
  });
  res.status(status).json(json);
});

api.get('/sync-tasks', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await callWorker(`/admin/sync-tasks${qs ? `?${qs}` : ''}`);
  res.status(status).json(json);
});

api.post('/sync-tasks/:id/retry', async (req, res) => {
  const { status, json } = await callWorker(`/admin/sync-tasks/${encodeURIComponent(req.params.id)}/retry`, {
    method: 'POST',
    body: { admin_id: req.adminUsername, dry_run: (req.body || {}).dry_run === true },
  });
  res.status(status).json(json);
});

api.post('/handles/:id', async (req, res) => {
  const { new_value, dry_run } = req.body || {};
  const { status, json } = await callWorker(`/admin/handles/${encodeURIComponent(req.params.id)}`, {
    method: 'POST',
    body: { new_value, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.delete('/handles/:id', async (req, res) => {
  const { dry_run } = req.body || {};
  const { status, json } = await callWorker(`/admin/handles/${encodeURIComponent(req.params.id)}`, {
    method: 'DELETE',
    body: { admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

// Admin-initiated account creation — same worker route n8n uses
// (/create-account), just with admin_id set so kol_audit_log attributes it
// correctly and the Shopify-sync notify decision follows the "is this a
// brand new profile" rule in index.js, not a blanket yes/no.
api.post('/create-account', async (req, res) => {
  const { dry_run, ...fields } = req.body || {};
  const { status, json } = await callWorker('/create-account', {
    method: 'POST',
    body: { ...fields, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

// Admin-initiated "add handle to an existing profile" — same worker route
// as the self-service flow (/add-handle), keyed by line_uid (the dashboard
// already has the profile loaded, so it passes it through rather than
// exposing a separate internal_id-keyed route on the worker).
api.post('/add-handle', async (req, res) => {
  const { dry_run, ...fields } = req.body || {};
  const { status, json } = await callWorker('/add-handle', {
    method: 'POST',
    body: { ...fields, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.get('/settings', async (req, res) => {
  const { status, json } = await callWorker('/admin/settings');
  res.status(status).json(json);
});

api.post('/settings', async (req, res) => {
  const { settings, dry_run } = req.body || {};
  const { status, json } = await callWorker('/admin/settings', {
    method: 'POST',
    body: { settings, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.get('/shopify-mapping', async (req, res) => {
  const { status, json } = await callWorker('/admin/shopify-mapping');
  res.status(status).json(json);
});

api.post('/shopify-mapping', async (req, res) => {
  const { status, json } = await callWorker('/admin/shopify-mapping', {
    method: 'POST',
    body: { ...(req.body || {}), admin_id: req.adminUsername },
  });
  res.status(status).json(json);
});

api.put('/shopify-mapping/:id', async (req, res) => {
  const { status, json } = await callWorker(`/admin/shopify-mapping/${encodeURIComponent(req.params.id)}`, {
    method: 'PUT',
    body: { ...(req.body || {}), admin_id: req.adminUsername },
  });
  res.status(status).json(json);
});

api.delete('/shopify-mapping/:id', async (req, res) => {
  const { status, json } = await callWorker(`/admin/shopify-mapping/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
  res.status(status).json(json);
});

api.post('/shopify-mapping/test', async (req, res) => {
  const { status, json } = await callWorker('/admin/shopify-mapping/test', {
    method: 'POST',
    body: req.body || {},
  });
  res.status(status).json(json);
});

// ---------- Survey Keys tab (kol_survey_credentials) ----------

api.get('/survey-credentials', async (req, res) => {
  const { status, json } = await callWorker('/admin/survey-credentials');
  res.status(status).json(json);
});

api.post('/survey-credentials', async (req, res) => {
  const { dry_run, ...fields } = req.body || {};
  const { status, json } = await callWorker('/admin/survey-credentials', {
    method: 'POST',
    body: { ...fields, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.put('/survey-credentials/:svid', async (req, res) => {
  const { dry_run, ...fields } = req.body || {};
  const { status, json } = await callWorker(`/admin/survey-credentials/${encodeURIComponent(req.params.svid)}`, {
    method: 'PUT',
    body: { ...fields, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.delete('/survey-credentials/:svid', async (req, res) => {
  const { status, json } = await callWorker(`/admin/survey-credentials/${encodeURIComponent(req.params.svid)}`, { method: 'DELETE' });
  res.status(status).json(json);
});

// ---------- Campaign Participants tab (kol_campaign_log) ----------

api.get('/campaign-log', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await callWorker(`/admin/campaign-log${qs ? `?${qs}` : ''}`);
  res.status(status).json(json);
});

api.post('/update-profile', async (req, res) => {
  const { internal_id, field, new_value, dry_run } = req.body || {};
  const { status, json } = await callWorker('/admin-update-profile', {
    method: 'POST',
    body: { internal_id, field, new_value, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.post('/relink-line-uid', async (req, res) => {
  const { internal_id, new_line_uid, dry_run } = req.body || {};
  const { status, json } = await callWorker('/admin-relink-line-uid', {
    method: 'POST',
    body: { internal_id, new_line_uid, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

api.post('/notify', async (req, res) => {
  const { internal_id, notification_type, dry_run } = req.body || {};
  const { status, json } = await callWorker('/admin-notify', {
    method: 'POST',
    body: { internal_id, notification_type, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

// ---------- Reconcile tab (D1 <-> Shopify identity cross-check) ----------

api.post('/reconcile/search', async (req, res) => {
  const { identifier_type, identifier_value, candidate_email, candidate_phone } = req.body || {};
  const { status, json } = await callWorker('/admin-reconcile/search', {
    method: 'POST',
    body: { identifier_type, identifier_value, candidate_email, candidate_phone },
  });
  res.status(status).json(json);
});

api.post('/reconcile/apply', async (req, res) => {
  const { dry_run, ...fields } = req.body || {};
  const { status, json } = await callWorker('/admin-reconcile/apply', {
    method: 'POST',
    body: { ...fields, admin_id: req.adminUsername, dry_run: dry_run === true },
  });
  res.status(status).json(json);
});

app.use('/api', api);

// Anything else under an authenticated page load falls back to the app
// shell (single-page client-side routing isn't used yet, but this keeps a
// stray deep link from 404ing instead of bouncing to /login cleanly).
app.get('*', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(Number(PORT), () => {
  console.log(`arm-admin-dashboard listening on :${PORT} (worker: ${WORKER_BASE})`);
});
