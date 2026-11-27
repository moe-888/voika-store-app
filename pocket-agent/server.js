#!/usr/bin/env node
'use strict';
// Pocket Agent — your own private coding agent.
// Usage: node server.js [workspace-folder]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { Agent } = require('./src/agent');

// ---------- settings ----------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), '.pocket-agent'));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.MODEL || 'qwen2.5-coder:7b';
const WORKSPACE = path.resolve(process.argv[2] || process.env.WORKSPACE || process.cwd());

fs.mkdirSync(DATA_DIR, { recursive: true });
const configFile = path.join(DATA_DIR, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* first run */ }
if (!config.secret) config.secret = crypto.randomBytes(32).toString('hex');
if (!config.password) config.password = crypto.randomBytes(9).toString('base64url');
if (config.autoApprove === undefined) config.autoApprove = false;
const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
saveConfig();
const PASSWORD = process.env.AGENT_PASSWORD || config.password;
const TOKEN = crypto.createHmac('sha256', config.secret).update(PASSWORD).digest('hex');

if (!fs.existsSync(WORKSPACE) || !fs.statSync(WORKSPACE).isDirectory()) {
  console.error(`Workspace folder not found: ${WORKSPACE}`);
  process.exit(1);
}

// ---------- live events (Server-Sent Events) ----------
const clients = new Set();
function emit(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

const store = new Store(DATA_DIR);
const settings = { get autoApprove() { return config.autoApprove; } };
const agent = new Agent({ ollamaUrl: OLLAMA_URL, store, emit, settings });

// ---------- helpers ----------
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('Expected JSON'));
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
}

function authed(req) {
  const t = cookies(req).pa_token || '';
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

const attempts = new Map(); // ip -> { count, since }
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, since: now };
  if (now - a.since > 60000) { a.count = 0; a.since = now; }
  a.count++;
  attempts.set(ip, a);
  return a.count > 10;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PUBLIC = path.join(__dirname, 'public');
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    if (tooManyAttempts(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many tries. Wait a minute.' });
    const { password = '' } = await readJson(req);
    const a = crypto.createHash('sha256').update(String(password)).digest();
    const b = crypto.createHash('sha256').update(PASSWORD).digest();
    if (!crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'Wrong password' });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `pa_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
    return send(res, 200, { ok: true });
  }

  if (!authed(req)) return send(res, 401, { error: 'Please log in' });

  if (p === '/api/logout' && m === 'POST') {
    res.setHeader('set-cookie', 'pa_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'hello', approvals: agent.pendingApprovals() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/info' && m === 'GET') {
    return send(res, 200, { workspace: WORKSPACE, defaultModel: DEFAULT_MODEL, autoApprove: config.autoApprove, host: os.hostname(), ollama: OLLAMA_URL });
  }

  if (p === '/api/models' && m === 'GET') {
    try { return send(res, 200, { models: await agent.models() }); } catch (e) {
      return send(res, 502, { error: `Can't reach Ollama at ${OLLAMA_URL} (${e.message}). Start it with: ollama serve`, models: [] });
    }
  }

  if (p === '/api/settings' && m === 'POST') {
    const body = await readJson(req);
    if (typeof body.autoApprove === 'boolean') config.autoApprove = body.autoApprove;
    saveConfig();
    emit({ type: 'settings', autoApprove: config.autoApprove });
    return send(res, 200, { autoApprove: config.autoApprove });
  }

  if (p === '/api/sessions' && m === 'GET') {
    return send(res, 200, { sessions: store.list().map((s) => ({ ...s, running: agent.isRunning(s.id) })) });
  }

  if (p === '/api/sessions' && m === 'POST') {
    const body = await readJson(req);
    let ws = WORKSPACE;
    if (body.workspace) {
      ws = path.resolve(WORKSPACE, String(body.workspace).replace(/^~(?=$|[\\/])/, os.homedir()));
      if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) return send(res, 400, { error: `Folder not found: ${ws}` });
    }
    return send(res, 200, store.create({ model: body.model || DEFAULT_MODEL, workspace: ws }));
  }

  const sm = p.match(/^\/api\/sessions\/([a-z0-9]+)(\/(message|stop))?$/);
  if (sm) {
    const id = sm[1];
    const action = sm[3];
    const session = store.get(id);
    if (!session) return send(res, 404, { error: 'Chat not found' });

    if (!action && m === 'GET') return send(res, 200, { ...session, running: agent.isRunning(id) });
    if (!action && m === 'DELETE') { agent.stop(id); store.delete(id); return send(res, 200, { ok: true }); }
    if (!action && m === 'PATCH') {
      const body = await readJson(req);
      if (body.model) session.model = String(body.model);
      if (body.title) session.title = String(body.title).slice(0, 100);
      store.save(session);
      return send(res, 200, session);
    }
    if (action === 'message' && m === 'POST') {
      const { text, model } = await readJson(req);
      if (!text || !String(text).trim()) return send(res, 400, { error: 'Empty message' });
      if (agent.isRunning(id)) return send(res, 409, { error: 'Still working on the last message' });
      if (model && model !== session.model) { session.model = String(model); store.save(session); }
      agent.run(id, String(text)).catch((e) => emit({ type: 'error', sessionId: id, error: e.message }));
      return send(res, 202, { ok: true });
    }
    if (action === 'stop' && m === 'POST') { agent.stop(id); return send(res, 200, { ok: true }); }
  }

  if (p === '/api/approve' && m === 'POST') {
    const { id, allow } = await readJson(req);
    return send(res, agent.answerApproval(id, allow) ? 200 : 404, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, url.pathname);
    else { res.writeHead(405); res.end(); }
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  Pocket Agent is running');
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log(`  Model:     ${DEFAULT_MODEL} (via Ollama at ${OLLAMA_URL})`);
  console.log(`\n  On this computer:  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') for (const ip of ips) console.log(`  On your phone:     http://${ip}:${PORT}   (same Wi-Fi or Tailscale)`);
  console.log(`\n  Password: ${process.env.AGENT_PASSWORD ? '(from AGENT_PASSWORD)' : PASSWORD}`);
  console.log(`  (saved in ${configFile})\n`);
});

module.exports = server;
