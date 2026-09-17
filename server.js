/**
 * arm-admin-dashboard — the admin UI for arm-worker-v2.
 *
 * Auth model (per PROJECT_CONTEXT.md decision, 2026-09-17): a single shared
 * username/password, not per-admin accounts, not Cloudflare Access. On
 * success this server sets a signed, httpOnly session cookie; the browser
 * never sees ADMIN_UI_PASSWORD again after login, and never sees
 * ARM_ADMIN_TOKEN at all — that's held server-side only and attached to
 * every call this server proxies through to arm-worker-v2's /admin/* API.
 * The logged-in username is threaded through as `admin_id` on every
 * mutating call, so kol_audit_log/kol_notifications_log rows trace back to
 * who did what, without needing real per-user accounts yet.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ADMIN_UI_USERNAME,
  ADMIN_UI_PASSWORD,
  SESSION_SECRET,
  ARM_WORKER_BASE_URL,
  ARM_ADMIN_TOKEN,
  PORT = '3000',
  NODE_ENV,
} = process.env;

const REQUIRED_ENV = { ADMIN_UI_USERNAME, ADMIN_UI_PASSWORD, SESSION_SECRET, ARM_WORKER_BASE_URL, ARM_ADMIN_TOKEN };
for (const [name, val] of Object.entries(REQUIRED_ENV)) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const WORKER_BASE = ARM_WORKER_BASE_URL.replace(/\/$/, '');
const IS_PROD = NODE_ENV === 'production';
const SESSION_COOKIE = 'arm_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

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
  const userOk = timingSafeStringEqual(username || '', ADMIN_UI_USERNAME);
  const passOk = timingSafeStringEqual(password || '', ADMIN_UI_PASSWORD);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.cookie(SESSION_COOKIE, createSessionValue(username), {
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

api.get('/profiles', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const { status, json } = await callWorker(`/admin/profiles${qs ? `?${qs}` : ''}`);
  res.status(status).json(json);
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
    body: { dry_run: (req.body || {}).dry_run === true },
  });
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
  const { internal_id, dry_run } = req.body || {};
  const { status, json } = await callWorker('/admin-notify', {
    method: 'POST',
    body: { internal_id, admin_id: req.adminUsername, dry_run: dry_run === true },
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
