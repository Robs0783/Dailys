// Zero-dependency Node server: pure http/fs, nothing to npm install.
// Serves the two static apps (public/index.html, public/mapper.html) and a tiny
// shared JSON key/value API that both apps talk to instead of localStorage --
// that's what makes the data live and shared across every employee/device.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = __dirname; // index.html / mapper.html live next to server.js (flat repo, easy to upload)
const STATIC_ALLOW = new Set(['/index.html', '/mapper.html']);

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
      if (size > 20 * 1024 * 1024) { // 20mb cap (one-time task photos are data URLs)
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

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, store);
    }

    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      const key = body && body.key;
      const value = body ? body.value : undefined;
      if (typeof key !== 'string' || !key) {
        return sendJson(res, 400, { error: 'key is required' });
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
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: 'body must be an object of key/value pairs' });
      }
      let count = 0;
      Object.entries(body).forEach(([k, v]) => {
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
