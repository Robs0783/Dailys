// Zero-dependency Node server: pure http/fs, nothing to npm install.
// Serves the two static apps (index.html, mapper.html) and a tiny
// shared JSON key/value API that both apps talk to instead of localStorage --
// that's what makes the data live and shared across every employee/device.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = __dirname; // index.html / mapper.html live next to server.js (flat repo, easy to upload)
const STATIC_ALLOW = new Set(['/index.html', '/mapper.html']);

// Admin/manager code: gates Setup, Meetings admin, and bulk Import so employees using the
// shared checklist can't restructure the roster or wipe the shared data. Set your own via
// the ADMIN_CODE environment variable in Railway - this fallback is only for local testing.
const ADMIN_CODE = process.env.ADMIN_CODE || 'dailys2026';
if (!process.env.ADMIN_CODE) {
  console.warn('WARNING: ADMIN_CODE env var not set - using insecure default. Set ADMIN_CODE in Railway variables.');
}
// Manager code: a second, lower tier. Managers get the same edit access as the owner admin
// code across Setup/Meetings/Metrics/Training/Team Targets, but never see or touch the
// owner's private Projects (work plan) data or the raw Export/Import bulk tools.
const MANAGER_CODE = process.env.MANAGER_CODE || 'dailysmgr2026';
if (!process.env.MANAGER_CODE) {
  console.warn('WARNING: MANAGER_CODE env var not set - using insecure default. Set MANAGER_CODE in Railway variables.');
}
// Returns 'owner' | 'manager' | 'builder' | null for a given submitted code.
// 'builder' (update-33) is Shreya's AI Builds code: Rob sets it from inside the app through
// /api/ai-builder-code; only an HMAC of it (keyed with the server's owner code, so the public
// store can't be brute-forced offline) is kept as 'ai-builder-codehash'. It unlocks the 'ai-*'
// keys and nothing else.
function builderHash(code) { return crypto.createHmac('sha256', 'dailys-builder:' + ADMIN_CODE).update(code).digest('hex'); }
function codeTier(code) {
  if (typeof code !== 'string' || !code) return null;
  if (code === ADMIN_CODE) return 'owner';
  if (code === MANAGER_CODE) return 'manager';
  const h = store['ai-builder-codehash'];
  if (typeof h === 'string' && h.length === 64 && builderHash(code) === h) return 'builder';
  return null;
}
// AI Builds keys: owner or builder only (not managers). The builder code hash itself: owner only.
function isAiKey(key) { return key.startsWith('ai-'); }
// Keys only ever written by staff actions (Setup / Meetings / Metrics / Training / Team
// Targets admin panels). Employees never legitimately write these, so they're safe to
// hard-gate server-side. Both the owner code and the manager code unlock these -- Projects
// (the owner's private work plan) is deliberately NOT in this set; it stays ungated the same
// way it always has (employees assigned to a step still need to update it), but is only ever
// shown in the UI to the owner, never to managers.
// 'owner-change-requests' is Rob's own private change-request list (separate from the
// employee-facing Suggestion Box, which is deliberately NOT in this set - any employee needs
// to write a suggestion without a code). It's owner-tier only in the UI (see isOwnerAdmin()/
// requireOwner() in index.html), but either code unlocks it here same as every other key in
// this set - the client is what keeps managers out of it.
const ADMIN_ONLY_KEYS = new Set(['roster', 'meetings', 'metrics', 'training', 'targets', 'metric-categories', 'departments', 'vendor-meetings', 'vendor-meeting-categories', 'social-media', 'other-properties', 'property-team', 'property-jobs', 'owner-change-requests', 'assigned-tasks', 'dailys-handoff', 'owner-week-plan', 'assigned-owner-seen', 'owner-schedule', 'owner-mytasks', 'owner-quicklinks', 'owner-worklists', 'training-assign', 'training-signoff', 'owner-notes']);

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store, starting fresh:', e);
  }
  return {};
}

let store = loadStore();

// ---- Update-36 safety net (after the 10/4 roster wipe) ----
// 1) Daily full snapshot of the store (DATA_DIR/backups/store-YYYY-MM-DD.json, 30 kept).
// 2) Every roster write keeps the PREVIOUS roster (DATA_DIR/roster-history/, 60 kept).
// 3) A roster made only of untouched starter tasks can never overwrite a customized one.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ROSTER_HIST_DIR = path.join(DATA_DIR, 'roster-history');
function dayStamp() { return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10); }
function pruneDir(dir, keep) {
  try { const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); files.slice(0, Math.max(0, files.length - keep)).forEach(f => fs.unlinkSync(path.join(dir, f))); } catch (e) {}
}
function dailySnapshot() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'store-' + dayStamp() + '.json');
    if (!fs.existsSync(f) && Object.keys(store).length) { fs.writeFileSync(f, JSON.stringify(store)); pruneDir(BACKUP_DIR, 30); }
  } catch (e) { console.error('Snapshot failed:', e); }
}
function saveRosterHistory(prev) {
  try {
    if (!prev) return;
    fs.mkdirSync(ROSTER_HIST_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROSTER_HIST_DIR, 'roster-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'), prev);
    pruneDir(ROSTER_HIST_DIR, 60);
  } catch (e) { console.error('Roster history failed:', e); }
}
function rosterIsUntouchedSeed(raw) {
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let n = 0, custom = false;
    Object.values(r || {}).forEach(loc => (loc.data || []).forEach(emp => {
      if (emp.name || emp.department || emp.archived) custom = true;
      (emp.tasks || []).forEach(t => { n++; if (!String(t.id || '').startsWith('seed-')) custom = true; });
    }));
    return n > 0 && !custom;
  } catch (e) { return false; }
}
dailySnapshot();
setInterval(dailySnapshot, 60 * 60 * 1000);
let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, DATA_FILE);
      if (typeof dailySnapshot === 'function') dailySnapshot();
    } catch (e) {
      console.error('Failed to persist store:', e);
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { // 20mb cap (one-time task photos / project attachments are data URLs)
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let route = pathname === '/' ? '/index.html' : pathname === '/mapper' ? '/mapper.html' : pathname;
  if (!STATIC_ALLOW.has(route)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const filePath = path.join(PUBLIC_DIR, route.slice(1));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (pathname === '/api/verify-access' && req.method === 'POST') {
      const body = await readBody(req);
      const code = body && body.code;
      const tier = codeTier(code);
      return sendJson(res, 200, { ok: tier !== null, tier });
    }

    // Owner-only backup tools: list snapshots / roster versions, fetch one, restore the roster.
    if (pathname === '/api/backups' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || codeTier(body.adminCode) !== 'owner') return sendJson(res, 403, { error: 'owner code required' });
      const list = (dir) => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse(); } catch (e) { return []; } };
      if (body.action === 'list') return sendJson(res, 200, { snapshots: list(BACKUP_DIR), rosters: list(ROSTER_HIST_DIR) });
      const safe = (f) => typeof f === 'string' && /^[\w.-]+\.json$/.test(f);
      if (body.action === 'get' && safe(body.file)) {
        const dir = body.file.startsWith('roster-') ? ROSTER_HIST_DIR : BACKUP_DIR;
        try { return sendJson(res, 200, { file: body.file, data: fs.readFileSync(path.join(dir, body.file), 'utf8') }); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
      }
      if (body.action === 'restoreRoster' && safe(body.file)) {
        try {
          let raw;
          if (body.file.startsWith('roster-')) raw = fs.readFileSync(path.join(ROSTER_HIST_DIR, body.file), 'utf8');
          else raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, body.file), 'utf8')).roster;
          if (!raw) return sendJson(res, 404, { error: 'no roster in that file' });
          saveRosterHistory(store.roster); store.roster = raw; persist();
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
      }
      return sendJson(res, 400, { error: 'unknown action' });
    }

    if (pathname === '/api/ai-builder-code' && req.method === 'POST') {
      // Owner sets or clears Shreya's AI Builds code.
      const body = await readBody(req);
      if (!body || codeTier(body.adminCode) !== 'owner') return sendJson(res, 403, { error: 'owner code required' });
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) { delete store['ai-builder-codehash']; persist(); return sendJson(res, 200, { ok: true, cleared: true }); }
      if (code.length < 6 || code === ADMIN_CODE || code === MANAGER_CODE) return sendJson(res, 400, { error: 'pick a different code (6+ characters)' });
      store['ai-builder-codehash'] = builderHash(code);
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, store);
    }

    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      const key = body && body.key;
      const value = body ? body.value : undefined;
      const adminCode = body && body.adminCode;
      if (typeof key !== 'string' || !key) {
        return sendJson(res, 400, { error: 'key is required' });
      }
      const tier = codeTier(adminCode);
      if (key === 'ai-builder-codehash') {
        return sendJson(res, 403, { error: 'use /api/ai-builder-code' });
      } else if (isAiKey(key)) {
        if (tier !== 'owner' && tier !== 'builder') return sendJson(res, 403, { error: 'AI Builds code required' });
      } else if (ADMIN_ONLY_KEYS.has(key) && tier !== 'owner' && tier !== 'manager') {
        return sendJson(res, 403, { error: 'admin or manager code required' });
      }
      if (key === 'roster') {
        if (value === null || value === undefined || value === '') return sendJson(res, 409, { error: 'the roster cannot be deleted' });
        if (store.roster && rosterIsUntouchedSeed(value) && !rosterIsUntouchedSeed(store.roster)) {
          console.warn('Refused to overwrite a customized roster with the starter roster');
          return sendJson(res, 409, { error: 'refused: would replace the real roster with the starter list - refresh the page' });
        }
        saveRosterHistory(store.roster);
      }
      if (value === null || value === undefined) {
        delete store[key];
      } else {
        store[key] = value;
      }
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/state/bulk' && req.method === 'POST') {
      // Only used by the owner-only Import/Export Data feature - gated entirely behind the
      // OWNER admin code (not the manager code) since a bulk import/export touches the whole
      // shared store, including the owner's private Projects data.
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: 'body must be an object' });
      }
      const { adminCode, data } = body;
      if (adminCode !== ADMIN_CODE) {
        return sendJson(res, 403, { error: 'admin code required' });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return sendJson(res, 400, { error: 'data object is required' });
      }
      let count = 0;
      Object.entries(data).forEach(([k, v]) => {
        store[k] = v;
        count++;
      });
      persist();
      return sendJson(res, 200, { ok: true, count });
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error('Request error:', e);
    sendJson(res, 500, { error: 'internal error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dailys app listening on port ${PORT}, data dir: ${DATA_DIR}`);
});
