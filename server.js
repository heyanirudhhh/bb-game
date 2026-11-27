// BetterBugs Bug Hunt - zero-dependency server (static files + leaderboard API)
// Run: node server.js   (PORT, DATA_DIR, ADMIN_KEY are optional env vars)
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'scores.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) console.warn('ADMIN_KEY not set: /api/export is disabled');
else if (ADMIN_KEY.length < 16) console.warn('ADMIN_KEY is short; use 16+ random chars');
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { entries: {} }; // key(lowercase name) -> { name, score, plays, at }
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

const sorted = () =>
  Object.values(db.entries).sort((a, b) => b.score - a.score || a.at - b.at);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// light per-IP rate limit on score submissions
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

// Game sessions: the server issues a one-time token when a run starts and measures
// the run's duration itself, so clients can't claim a score without a real, timed run.
const SESSION_TTL = 30 * 60 * 1000; // a run (plus offline sync delay) must finish within 30 min
const MIN_RUN_MS = 1000;
const MAX_OPEN_PER_IP = 20;
const sessions = new Map(); // token -> { ip, startedAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.startedAt > SESSION_TTL) sessions.delete(k);
}, 60000).unref();
const openFor = (ip) => { let n = 0; for (const s of sessions.values()) if (s.ip === ip) n++; return n; };

// Live leaderboard: Server-Sent Events. Clients hold /api/stream open and get the
// top 100 pushed whenever a score changes (debounced), plus a heartbeat for proxies.
const MAX_STREAMS = 1000;
const MAX_STREAMS_PER_IP = 6;
const streams = new Set(); // { res, ip }
const snapshot = () => {
  const all = sorted();
  return JSON.stringify({ total: all.length, top: all.slice(0, 100).map((e) => ({ name: e.name, score: e.score })) });
};
let pushTimer = null;
function broadcast() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const msg = `data: ${snapshot()}\n\n`;
    for (const s of streams) s.res.write(msg);
  }, 250);
}
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 25000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // only trust X-Forwarded-For when deployed behind a proxy that sets it (TRUST_PROXY=1)
  const ip = (process.env.TRUST_PROXY && req.headers['x-forwarded-for']?.split(',').pop().trim())
    || req.socket.remoteAddress;

  if (url.pathname === '/api/start' && req.method === 'POST') {
    if (limited(ip) || openFor(ip) >= MAX_OPEN_PER_IP) return send(res, 429, { error: 'slow down' });
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { ip, startedAt: Date.now() });
    return send(res, 200, { token });
  }

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const limit = Math.min(100, parseInt(url.searchParams.get('limit')) || 10);
    const all = sorted();
    return send(res, 200, {
      total: all.length,
      top: all.slice(0, limit).map((e) => ({ name: e.name, score: e.score })),
    });
  }

  if (url.pathname === '/api/stream' && req.method === 'GET') {
    let mine = 0; for (const s of streams) if (s.ip === ip) mine++;
    if (streams.size >= MAX_STREAMS || mine >= MAX_STREAMS_PER_IP) return send(res, 429, { error: 'too many streams' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no', // stop nginx from buffering
    });
    res.write(`retry: 3000\ndata: ${snapshot()}\n\n`);
    const s = { res, ip };
    streams.add(s);
    req.on('close', () => streams.delete(s));
    return;
  }

  if (url.pathname === '/api/score' && req.method === 'POST') {
    if (limited(ip)) return send(res, 429, { error: 'slow down' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch (_) { return send(res, 400, { error: 'bad json' }); }
      const name = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      const phone = String(p.phone || '').trim().slice(0, 20);
      const digits = phone.replace(/\D/g, '');
      const score = Math.floor(Number(p.score));
      if (!name || !Number.isFinite(score) || score < 0) return send(res, 400, { error: 'invalid' });
      if (digits.length < 10 || digits.length > 13) return send(res, 400, { error: 'invalid phone' });

      // require a valid, unused session token; duration is measured by the server
      const sess = sessions.get(String(p.token || ''));
      if (!sess) return send(res, 403, { error: 'no session' });
      sessions.delete(String(p.token)); // single use: one score per run
      const ms = Date.now() - sess.startedAt;
      if (ms < MIN_RUN_MS || ms > SESSION_TTL) return send(res, 400, { error: 'implausible' });
      // client-reported duration may only shorten the window (e.g. offline sync later)
      const clientMs = Number(p.duration);
      const secs = Math.min(ms, Number.isFinite(clientMs) && clientMs > 0 ? clientMs : ms) / 1000;
      // basic plausibility check (a perfect run earns well under 30 pts/sec)
      if (score > 20 + secs * 30) return send(res, 400, { error: 'implausible' });

      // one leaderboard entry per phone number (last 10 digits, so +91 / 0 prefixes match)
      const key = 'p:' + digits.slice(-10);
      const cur = db.entries[key] || { name, phone, score: 0, plays: 0, at: Date.now() };
      cur.plays++;
      cur.name = name; cur.phone = phone;
      if (score > cur.score) { cur.score = score; cur.at = Date.now(); }
      db.entries[key] = cur;
      save();
      broadcast();
      const rank = sorted().findIndex((e) => e === cur) + 1;
      send(res, 200, { rank, best: cur.score, total: Object.keys(db.entries).length });
    });
    return;
  }

  // CSV export for the raffle: /api/export?key=ADMIN_KEY (or header "x-admin-key").
  // Disabled entirely unless ADMIN_KEY is set — no localhost fallback, since behind a
  // reverse proxy every request looks like it comes from 127.0.0.1.
  if (url.pathname === '/api/export') {
    if (limited(ip)) return send(res, 429, { error: 'slow down' });
    if (!ADMIN_KEY) return send(res, 403, { error: 'export disabled: set ADMIN_KEY' });
    const given = Buffer.from(String(req.headers['x-admin-key'] || url.searchParams.get('key') || ''));
    const want = Buffer.from(ADMIN_KEY);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 403, { error: 'forbidden' });
    const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    const rows = sorted().map((e, i) => `${i + 1},${q(e.name)},${q(e.phone)},${e.score},${e.plays}`);
    return send(res, 200, 'rank,name,phone,best_score,plays\n' + rows.join('\n'), 'text/csv');
  }

  // static files
  let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Bug Hunt running on http://localhost:${PORT}`));
