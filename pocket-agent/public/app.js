'use strict';
const $ = (id) => document.getElementById(id);
const state = { info: null, sessions: [], current: null, running: false, live: null, liveThink: null, approvals: new Map(), events: null };

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Please log in'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { data });
  return data;
}

// ---------- tiny, safe Markdown ----------
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}
function markdown(text) {
  const out = document.createElement('div');
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/\n$/, '');
      pre.append(code);
      out.append(pre);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      const p = document.createElement('p');
      p.innerHTML = block.split('\n').map((line) => {
        const h = line.match(/^#{1,6}\s+(.*)/);
        if (h) return `<strong>${inline(h[1])}</strong>`;
        return inline(line.replace(/^(\s*)[-*]\s+/, '$1• '));
      }).join('<br>');
      out.append(p);
    }
  });
  return out;
}

// ---------- rendering ----------
const box = $('messages');
function atBottom() { return box.scrollHeight - box.scrollTop - box.clientHeight < 80; }
function scrollDown(force) { if (force || atBottom()) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function mainArg(args = {}) {
  return args.command || args.path || args.pattern || Object.values(args)[0] || '';
}

function toolCard(name, args) {
  const d = el('details', 'tool');
  const s = el('summary');
  s.append(el('span', 'name', name), el('span', 'arg', String(mainArg(args))));
  d.append(s);
  const extra = { ...args };
  if (Object.keys(extra).length > 1 || name === 'write_file' || name === 'edit_file') {
    d.append(el('pre', null, JSON.stringify(extra, null, 2)));
  }
  return d;
}

function renderMessage(m, cards) {
  if (m.role === 'user') return box.append(el('div', 'msg user', m.content));
  if (m.role === 'assistant') {
    if (m.thinking) {
      const t = el('details', 'thinking msg');
      t.append(el('summary', null, 'Thinking'), el('div', null, m.thinking));
      box.append(t);
    }
    if (m.content && m.content.trim()) {
      const div = el('div', 'msg assistant');
      div.append(markdown(m.content));
      box.append(div);
    }
    for (const c of m.tool_calls || []) {
      const card = toolCard(c.function.name, c.function.arguments);
      cards.push(card);
      box.append(card);
    }
    return;
  }
  if (m.role === 'tool') {
    const card = cards.shift();
    const pre = el('pre', null, m.content);
    if (card) {
      card.append(pre);
      if (/^Error:|denied/.test(m.content)) card.querySelector('.name').style.color = 'var(--danger)';
    } else {
      const d = toolCard(m.tool_name || 'tool', {}); d.append(pre); box.append(d);
    }
  }
}

function renderSession() {
  box.innerHTML = '';
  const s = state.current;
  if (!s || !s.messages.length) {
    const e = el('div', 'empty');
    e.append(el('h2', null, 'What should we work on?'));
    e.append(el('p', null, 'I can read your files, edit code, and run commands on your computer. I ask before changing anything.'));
    box.append(e);
  } else {
    const cards = [];
    for (const m of s.messages) renderMessage(m, cards);
  }
  for (const a of state.approvals.values()) if (s && a.sessionId === s.id) renderApproval(a);
  if (state.running) showWorking();
  scrollDown(true);
}

function showWorking() {
  if (box.querySelector('.working')) return;
  const w = el('div', 'working');
  w.append(el('span', 'dot'), el('span', 'dot'), el('span', 'dot'), el('span', null, 'Working…'));
  box.append(w);
}
function hideWorking() { box.querySelector('.working')?.remove(); }
function keepWorkingLast() { const w = box.querySelector('.working'); if (w) box.append(w); }

function renderApproval(a) {
  if (document.getElementById(`ap-${a.id}`)) return;
  const card = el('div', 'approval');
  card.id = `ap-${a.id}`;
  const labels = { run_command: 'Run this command?', write_file: `Write file ${a.args.path}?`, edit_file: `Edit file ${a.args.path}?` };
  card.append(el('strong', null, labels[a.tool] || `Use ${a.tool}?`));
  let preview = '';
  if (a.tool === 'run_command') preview = a.args.command;
  else if (a.tool === 'write_file') preview = a.args.content;
  else if (a.tool === 'edit_file') preview = `- ${String(a.args.old_text).split('\n').join('\n- ')}\n+ ${String(a.args.new_text).split('\n').join('\n+ ')}`;
  else preview = JSON.stringify(a.args, null, 2);
  card.append(el('pre', null, preview));
  const row = el('div', 'row');
  const yes = el('button', 'ok', 'Allow');
  const no = el('button', 'danger', 'Deny');
  const all = el('button', null, 'Allow all');
  yes.type = no.type = all.type = 'button';
  yes.onclick = () => answer(a.id, true);
  no.onclick = () => answer(a.id, false);
  all.onclick = async () => { await setAutoApprove(true); answer(a.id, true); };
  row.append(yes, no, all);
  card.append(row);
  box.append(card);
  keepWorkingLast();
  scrollDown(true);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Pocket Agent needs your OK', { body: labels[a.tool] || a.tool });
  }
}

async function answer(id, allow) {
  document.getElementById(`ap-${id}`)?.remove();
  state.approvals.delete(id);
  await api('/api/approve', { method: 'POST', body: { id, allow } }).catch(() => {});
}

// ---------- live events ----------
function connectEvents() {
  if (state.events) state.events.close();
  const es = new EventSource('/api/events');
  state.events = es;
  es.onopen = () => setBanner('');
  es.onerror = () => setBanner('Connection lost — reconnecting…');
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
}

function onEvent(ev) {
  if (ev.type === 'hello') {
    state.approvals = new Map(ev.approvals.map((a) => [a.id, a]));
    if (state.current) openSession(state.current.id);
    return;
  }
  if (ev.type === 'settings') { $('autoApprove').checked = ev.autoApprove; return; }
  if (ev.type === 'approval') state.approvals.set(ev.id, ev);
  if (ev.type === 'approval_done') { state.approvals.delete(ev.id); document.getElementById(`ap-${ev.id}`)?.remove(); }
  if (ev.type === 'done' || ev.type === 'start') loadSessions();

  const mine = state.current && ev.sessionId === state.current.id;
  if (!mine) return;
  const s = state.current;

  switch (ev.type) {
    case 'start':
      setRunning(true); showWorking(); break;
    case 'thinking':
      if (!state.liveThink) {
        state.liveThink = el('details', 'thinking msg');
        state.liveThink.append(el('summary', null, 'Thinking…'), el('div'));
        box.append(state.liveThink); keepWorkingLast();
      }
      state.liveThink.lastChild.textContent += ev.text; scrollDown(); break;
    case 'token':
      if (!state.live) { state.live = el('div', 'msg assistant'); state.live.dataset.raw = ''; box.append(state.live); keepWorkingLast(); }
      state.live.dataset.raw += ev.text;
      state.live.replaceChildren(markdown(state.live.dataset.raw));
      scrollDown(); break;
    case 'assistant':
    case 'tool_result':
      s.messages.push(ev.message);
      state.live?.remove(); state.liveThink?.remove(); state.live = state.liveThink = null;
      renderSession(); break;
    case 'approval':
      renderApproval(ev); break;
    case 'error': {
      const e = el('div', 'msg error', ev.error); box.append(e); keepWorkingLast(); scrollDown(true); break;
    }
    case 'done':
      state.live?.remove(); state.liveThink?.remove(); state.live = state.liveThink = null;
      setRunning(false); hideWorking();
      if (ev.stopped) { box.append(el('div', 'msg error', 'Stopped.')); scrollDown(true); }
      break;
  }
}

function setRunning(on) {
  state.running = on;
  $('sendBtn').classList.toggle('hidden', on);
  $('stopBtn').classList.toggle('hidden', !on);
}

function setBanner(text) {
  $('banner').textContent = text;
  $('banner').classList.toggle('hidden', !text);
}

// ---------- sessions ----------
async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  const cur = state.current && sessions.find((s) => s.id === state.current.id);
  if (cur) { state.current.title = cur.title; $('chatTitle').textContent = cur.title; }
  const ul = $('sessionList');
  ul.innerHTML = '';
  for (const s of sessions) {
    const li = el('li', state.current && s.id === state.current.id ? 'active' : '');
    const open = el('button', 'open');
    open.type = 'button';
    open.append(el('span', 'ellipsis', (s.running ? '● ' : '') + s.title), el('span', 'muted small ellipsis', `${s.workspace} · ${new Date(s.updated).toLocaleString()}`));
    open.onclick = () => { openSession(s.id); closeDrawer(); };
    const del = el('button', 'del', '🗑');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete chat');
    del.onclick = async () => {
      if (!confirm(`Delete "${s.title}"?`)) return;
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      if (state.current?.id === s.id) { state.current = null; localStorageSet('lastChat', ''); }
      await loadSessions();
      if (!state.current) startFresh();
    };
    li.append(open, del);
    ul.append(li);
  }
}

async function openSession(id) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.current = s;
    state.live = state.liveThink = null;
    localStorageSet('lastChat', id);
    $('chatTitle').textContent = s.title;
    $('chatFolder').textContent = s.workspace;
    selectModel(s.model);
    setRunning(s.running);
    renderSession();
    loadSessions();
  } catch {
    startFresh();
  }
}

function startFresh() {
  state.current = null;
  $('chatTitle').textContent = 'New chat';
  $('chatFolder').textContent = state.info?.workspace || '';
  setRunning(false);
  renderSession();
}

async function createSession(folder) {
  const s = await api('/api/sessions', { method: 'POST', body: { model: $('model').value, workspace: folder || undefined } });
  await openSession(s.id);
  return s;
}

// ---------- models ----------
async function loadModels() {
  const sel = $('model');
  try {
    const { models } = await api('/api/models');
    sel.innerHTML = '';
    if (!models.length) {
      setBanner(`No models installed yet. On your computer run: ollama pull ${state.info.defaultModel}`);
    }
    for (const m of models) sel.append(new Option(m, m));
    selectModel(state.current?.model || localStorageGet('model') || state.info.defaultModel);
  } catch (e) {
    setBanner(e.message);
    sel.innerHTML = '';
    sel.append(new Option(state.info.defaultModel, state.info.defaultModel));
  }
}
function selectModel(name) {
  const sel = $('model');
  if (!name) return;
  if (![...sel.options].some((o) => o.value === name)) sel.append(new Option(name, name));
  sel.value = name;
}

async function setAutoApprove(on) {
  const r = await api('/api/settings', { method: 'POST', body: { autoApprove: on } });
  $('autoApprove').checked = r.autoApprove;
}

// ---------- storage (optional) ----------
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------- UI wiring ----------
function openDrawer() { $('drawer').classList.add('open'); $('scrim').classList.add('open'); }
function closeDrawer() { $('drawer').classList.remove('open'); $('scrim').classList.remove('open'); }
$('openDrawer').onclick = openDrawer;
$('closeDrawer').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;

$('newChatForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await createSession($('newFolder').value.trim()); $('newFolder').value = ''; closeDrawer(); } catch (err) { alert(err.message); }
};

$('model').onchange = async () => {
  localStorageSet('model', $('model').value);
  if (state.current) await api(`/api/sessions/${state.current.id}`, { method: 'PATCH', body: { model: $('model').value } });
};

$('autoApprove').onchange = (e) => {
  if (e.target.checked && !confirm('Let the agent write files and run commands without asking?')) { e.target.checked = false; return; }
  setAutoApprove(e.target.checked);
};

$('logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: {} }); location.reload(); };

const input = $('input');
function grow() { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; }
input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.running) return;
  try {
    if (!state.current) await createSession();
    input.value = ''; grow();
    state.current.messages.push({ role: 'user', content: text });
    renderSession();
    setRunning(true); showWorking(); scrollDown(true);
    await api(`/api/sessions/${state.current.id}/message`, { method: 'POST', body: { text, model: $('model').value } });
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (err) {
    setRunning(false); hideWorking();
    box.append(el('div', 'msg error', err.message));
  }
};

$('stopBtn').onclick = () => state.current && api(`/api/sessions/${state.current.id}/stop`, { method: 'POST', body: {} });

// ---------- start ----------
function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('password').focus();
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { password: $('password').value } });
    $('loginError').textContent = '';
    start();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
};

async function start() {
  try { state.info = await api('/api/info'); } catch { return; }
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('autoApprove').checked = state.info.autoApprove;
  $('infoLine').textContent = `${state.info.host} · ${state.info.workspace}`;
  await loadModels();
  await loadSessions();
  const last = localStorageGet('lastChat');
  if (last && state.sessions.some((s) => s.id === last)) await openSession(last);
  else startFresh();
  connectEvents();
}

start();
