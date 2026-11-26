// BetterBugs Bug Hunt - zero-dependency server (static files + leaderboard API)
// Run: node server.js   (PORT, DATA_DIR, ADMIN_KEY are optional env vars)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'scores.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const limit = Math.min(100, parseInt(url.searchParams.get('limit')) || 10);
    const all = sorted();
    return send(res, 200, {
      total: all.length,
      top: all.slice(0, limit).map((e) => ({ name: e.name, score: e.score })),
    });
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
      const secs = Number(p.duration) / 1000;
      if (!name || !Number.isFinite(score) || score < 0) return send(res, 400, { error: 'invalid' });
      if (digits.length < 10 || digits.length > 13) return send(res, 400, { error: 'invalid phone' });
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
      const rank = sorted().findIndex((e) => e === cur) + 1;
      send(res, 200, { rank, best: cur.score, total: Object.keys(db.entries).length });
    });
    return;
  }

  // CSV export for the raffle: /api/export?key=ADMIN_KEY (localhost only if no key is set)
  if (url.pathname === '/api/export') {
    const local = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (ADMIN_KEY ? url.searchParams.get('key') !== ADMIN_KEY : !local) return send(res, 403, { error: 'forbidden' });
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
