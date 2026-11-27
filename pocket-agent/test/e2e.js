'use strict';
// End-to-end test with a fake Ollama: login, chat, tool calls, approval, stop.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello world\n');

// Fake Ollama: scripted replies, streamed as NDJSON.
let step = 0;
const script = [
  { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }] },
  { tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'hello.txt', old_text: 'world', new_text: 'pocket' } } }] },
  { content: '```json\n{"name": "run_command", "arguments": {"command": "cat hello.txt"}}\n```' },
  { content: 'All **done**.' },
];
const fake = http.createServer((req, res) => {
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'fake:1b' }] })); return; }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const reqBody = JSON.parse(body);
    assert.ok(reqBody.tools.length >= 6, 'tools are sent');
    const r = script[step++] || { content: 'extra' };
    res.write(JSON.stringify({ message: { role: 'assistant', content: '' } }) + '\n');
    if (r.content) for (const part of r.content.match(/.{1,5}/gs)) res.write(JSON.stringify({ message: { role: 'assistant', content: part } }) + '\n');
    if (r.tool_calls) res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: r.tool_calls } }) + '\n');
    res.end(JSON.stringify({ done: true, message: { role: 'assistant', content: '' } }) + '\n');
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const ollama = `http://127.0.0.1:${fake.address().port}`;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ws], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(tmp, 'data'), OLLAMA_URL: ollama, AGENT_PASSWORD: 'secret123', MODEL: 'fake:1b' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !out.includes('running'); i++) await sleep(100);

  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (p, method = 'GET', body) => {
    const r = await fetch(base + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  };

  try {
    assert.strictEqual((await call('/api/info')).status, 401, 'needs login');
    assert.strictEqual((await call('/api/login', 'POST', { password: 'nope' })).status, 401, 'wrong password refused');
    const login = await call('/api/login', 'POST', { password: 'secret123' });
    assert.strictEqual(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];

    assert.deepStrictEqual((await call('/api/models')).data.models, ['fake:1b']);
    assert.strictEqual((await call('/api/sessions', 'POST', { workspace: '/definitely/not/here' })).status, 400);

    // Collect live events.
    const events = [];
    const ctrl = new AbortController();
    fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal }).then(async (r) => {
      const dec = new TextDecoder();
      for await (const chunk of r.body) for (const line of dec.decode(chunk).split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }).catch(() => {});
    await sleep(200);

    const s = (await call('/api/sessions', 'POST', {})).data;
    assert.strictEqual((await call(`/api/sessions/${s.id}/message`, 'POST', { text: 'change world to pocket' })).status, 202);

    // edit_file needs approval
    let ap;
    for (let i = 0; i < 50 && !(ap = events.find((e) => e.type === 'approval')); i++) await sleep(100);
    assert.ok(ap, 'approval requested');
    assert.strictEqual(ap.tool, 'edit_file');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'hello world\n', 'not changed before approval');
    await call('/api/approve', 'POST', { id: ap.id, allow: true });

    // run_command (parsed from JSON text) needs approval
    let ap2;
    for (let i = 0; i < 50 && !(ap2 = events.find((e) => e.type === 'approval' && e.id !== ap.id)); i++) await sleep(100);
    assert.ok(ap2, 'second approval');
    assert.strictEqual(ap2.tool, 'run_command');
    await call('/api/approve', 'POST', { id: ap2.id, allow: true });

    for (let i = 0; i < 50 && !events.find((e) => e.type === 'done'); i++) await sleep(100);
    const full = (await call(`/api/sessions/${s.id}`)).data;
    const tools = full.messages.filter((m) => m.role === 'tool');
    assert.match(tools[0].content, /hello world/);
    assert.match(tools[1].content, /Edited/);
    assert.match(tools[2].content, /hello pocket[\s\S]*exit code 0/);
    assert.strictEqual(full.messages.at(-1).content, 'All **done**.');
    assert.ok(events.some((e) => e.type === 'token'), 'streamed tokens');
    assert.strictEqual(full.title, 'change world to pocket');

    // Path escape is blocked
    const { runTool } = require('../src/tools');
    await assert.rejects(runTool('read_file', { path: '../../etc/passwd' }, ws), /outside the workspace/);

    // Static UI is served
    const html = await fetch(base + '/').then((r) => r.text());
    assert.match(html, /Pocket Agent/);
    assert.strictEqual((await fetch(base + '/../server.js')).status, 404);

    ctrl.abort();
    console.log('All tests passed');
  } finally {
    server.kill();
    fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
