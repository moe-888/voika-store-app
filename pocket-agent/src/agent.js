'use strict';
// The agent loop: ask the local model, run the tools it asks for, repeat.
const os = require('os');
const crypto = require('crypto');
const { byName, runTool, ollamaToolList } = require('./tools');

const MAX_STEPS = 30;

function systemPrompt(workspace) {
  return [
    'You are Pocket Agent, a coding assistant running on the user\'s own computer.',
    `Workspace folder: ${workspace}`,
    `Operating system: ${os.platform()} (${os.arch()})`,
    '',
    'You can use tools to look at and change files and to run commands.',
    'Rules:',
    '- Look before you act: use list_dir, search and read_file to understand the project first.',
    '- Read a file before you edit it, and use edit_file for small changes.',
    '- After changing code, run the tests or the build if the project has them.',
    '- Paths are relative to the workspace folder.',
    '- When you are done, answer in a short, clear message. Use Markdown code blocks for code.',
  ].join('\n');
}

// Some small models write the tool call as JSON text instead of a real tool call.
function toolCallsFromText(text) {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/) || [null, text.trim()];
  try {
    const obj = JSON.parse(m[1]);
    const list = Array.isArray(obj) ? obj : [obj];
    const calls = list
      .filter((c) => c && typeof c.name === 'string' && byName[c.name])
      .map((c) => ({ function: { name: c.name, arguments: c.arguments || c.parameters || {} } }));
    return calls.length === list.length && calls.length ? calls : null;
  } catch {
    return null;
  }
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a || '{}'); } catch { return {}; }
}

class Agent {
  constructor({ ollamaUrl, store, emit, settings }) {
    this.ollamaUrl = ollamaUrl.replace(/\/$/, '');
    this.store = store;
    this.emit = emit; // (event) => void
    this.settings = settings; // { autoApprove }
    this.running = new Map(); // sessionId -> AbortController
    this.approvals = new Map(); // approvalId -> { resolve, sessionId, tool, args }
  }

  async models() {
    const res = await fetch(`${this.ollamaUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  stop(id) {
    const ctrl = this.running.get(id);
    if (ctrl) ctrl.abort();
    for (const [aid, a] of this.approvals) {
      if (a.sessionId === id) { a.resolve(false); this.approvals.delete(aid); }
    }
  }

  pendingApprovals() {
    return [...this.approvals].map(([id, a]) => ({ id, sessionId: a.sessionId, tool: a.tool, args: a.args }));
  }

  answerApproval(id, allow) {
    const a = this.approvals.get(id);
    if (!a) return false;
    this.approvals.delete(id);
    a.resolve(!!allow);
    this.emit({ type: 'approval_done', sessionId: a.sessionId, id, allow: !!allow });
    return true;
  }

  askApproval(sessionId, tool, args, signal) {
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      this.approvals.set(id, { resolve, sessionId, tool, args });
      this.emit({ type: 'approval', sessionId, id, tool, args });
    });
  }

  // Calls Ollama with streaming. Returns the full assistant message.
  async chat(session, signal) {
    const res = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: session.model,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt(session.workspace) }, ...session.messages],
        tools: ollamaToolList(),
        options: { num_ctx: Number(process.env.NUM_CTX) || 16384 },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* plain text */ }
      if (/does not support tools/i.test(msg)) {
        msg += ' — pick a model that supports tools, e.g. qwen2.5-coder, qwen3, llama3.1 or mistral-nemo.';
      }
      throw new Error(msg);
    }
    let content = '';
    let thinking = '';
    const toolCalls = [];
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const data = JSON.parse(line);
        if (data.error) throw new Error(data.error);
        const m = data.message || {};
        if (m.thinking) {
          thinking += m.thinking;
          this.emit({ type: 'thinking', sessionId: session.id, text: m.thinking });
        }
        if (m.content) {
          content += m.content;
          this.emit({ type: 'token', sessionId: session.id, text: m.content });
        }
        if (m.tool_calls) toolCalls.push(...m.tool_calls);
      }
    }
    const msg = { role: 'assistant', content };
    if (thinking) msg.thinking = thinking;
    if (!toolCalls.length) {
      const fromText = toolCallsFromText(content);
      if (fromText) { toolCalls.push(...fromText); msg.content = ''; }
    }
    if (toolCalls.length) {
      msg.tool_calls = toolCalls.map((c) => ({ function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } }));
    }
    return msg;
  }

  async run(sessionId, text) {
    if (this.running.has(sessionId)) throw new Error('This chat is already working');
    const session = this.store.get(sessionId);
    if (!session) throw new Error('Chat not found');
    const ctrl = new AbortController();
    this.running.set(sessionId, ctrl);
    const signal = ctrl.signal;

    session.messages.push({ role: 'user', content: text });
    if (session.title === 'New chat') session.title = text.slice(0, 60);
    this.store.save(session);
    this.emit({ type: 'start', sessionId });

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const msg = await this.chat(session, signal);
        session.messages.push(msg);
        this.store.save(session);
        this.emit({ type: 'assistant', sessionId, message: msg });
        if (!msg.tool_calls) break;

        for (const call of msg.tool_calls) {
          const name = call.function.name;
          const args = call.function.arguments;
          const def = byName[name];
          let result;
          if (signal.aborted) {
            result = 'Stopped by the user.';
          } else if (!def) {
            result = `Error: there is no tool named "${name}".`;
          } else {
            const allowed = !def.approval || this.settings.autoApprove || (await this.askApproval(sessionId, name, args, signal));
            if (!allowed) {
              result = 'The user denied this action. Ask them what to do instead, or try a different approach.';
            } else {
              this.emit({ type: 'tool_start', sessionId, tool: name, args });
              try {
                result = await runTool(name, args, session.workspace, signal);
              } catch (err) {
                result = `Error: ${err.message}`;
              }
            }
          }
          const toolMsg = { role: 'tool', tool_name: name, content: result };
          session.messages.push(toolMsg);
          this.store.save(session);
          this.emit({ type: 'tool_result', sessionId, message: toolMsg });
        }
        if (signal.aborted) break;
        if (step === MAX_STEPS - 1) {
          this.emit({ type: 'error', sessionId, error: `Stopped after ${MAX_STEPS} steps. Send "continue" to keep going.` });
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        const error = /fetch failed|ECONNREFUSED/.test(err.message)
          ? `Can't reach Ollama at ${this.ollamaUrl}. Is it running? (run: ollama serve)`
          : err.message;
        this.emit({ type: 'error', sessionId, error });
      }
    } finally {
      this.running.delete(sessionId);
      this.emit({ type: 'done', sessionId, stopped: signal.aborted });
    }
  }
}

module.exports = { Agent, toolCallsFromText };
