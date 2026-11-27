'use strict';
// The tools the AI can use. Every path is kept inside the workspace folder.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', '__pycache__', '.pocket-agent']);
const MAX_OUTPUT = 30000;

function clip(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [cut: ${text.length - max} more characters]`;
}

function inside(workspace, p) {
  const full = path.resolve(workspace, p || '.');
  const rel = path.relative(workspace, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace`);
  }
  return full;
}

const definitions = [
  {
    name: 'list_dir',
    description: 'List files and folders in a directory of the workspace. Folders end with "/".',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the workspace. Default "."' } },
    },
    approval: false,
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace' },
        offset: { type: 'number', description: 'First line to read (1-based). Optional' },
        limit: { type: 'number', description: 'How many lines to read. Optional, default 400' },
      },
      required: ['path'],
    },
    approval: false,
  },
  {
    name: 'search',
    description: 'Search file contents in the workspace with a regular expression. Returns file:line: text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (JavaScript syntax)' },
        path: { type: 'string', description: 'Folder to search in. Default "."' },
      },
      required: ['pattern'],
    },
    approval: false,
  },
  {
    name: 'write_file',
    description: 'Create a file or replace its whole content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace' },
        content: { type: 'string', description: 'The full new content' },
      },
      required: ['path', 'content'],
    },
    approval: true,
  },
  {
    name: 'edit_file',
    description: 'Replace one exact piece of text in a file. old_text must appear exactly once. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    approval: true,
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace folder (tests, git, npm, builds...). Returns output and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command' },
        timeout_seconds: { type: 'number', description: 'Optional, default 120, max 600' },
      },
      required: ['command'],
    },
    approval: true,
  },
];

const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));

function walk(dir, out, limit) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out, limit);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

const impl = {
  list_dir({ path: p = '.' }, ws) {
    const dir = inside(ws, p);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => e.name + (e.isDirectory() ? '/' : ''));
    return entries.length ? entries.join('\n') : '(empty folder)';
  },

  read_file({ path: p, offset = 1, limit = 400 }, ws) {
    const file = inside(ws, p);
    const stat = fs.statSync(file);
    if (stat.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const count = Math.min(2000, Math.max(1, Number(limit) || 400));
    const slice = lines.slice(start - 1, start - 1 + count);
    let text = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
    if (start - 1 + count < lines.length) {
      text += `\n... (${lines.length} lines total; use offset ${start + count} to read more)`;
    }
    return clip(text || '(empty file)');
  },

  search({ pattern, path: p = '.' }, ws) {
    const re = new RegExp(pattern);
    const files = [];
    walk(inside(ws, p), files, 20000);
    const hits = [];
    for (const f of files) {
      let text;
      try {
        if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
        text = fs.readFileSync(f, 'utf8');
      } catch { continue; }
      if (text.includes('\u0000')) continue; // binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(ws, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= 200) return hits.join('\n') + '\n... (stopped at 200 matches)';
        }
      }
    }
    return hits.length ? hits.join('\n') : 'No matches';
  },

  write_file({ path: p, content = '' }, ws) {
    const file = inside(ws, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return `Wrote ${content.split('\n').length} lines to ${p}`;
  },

  edit_file({ path: p, old_text, new_text }, ws) {
    const file = inside(ws, p);
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(old_text).length - 1;
    if (!old_text) throw new Error('old_text is empty');
    if (count === 0) throw new Error('old_text was not found in the file. Read the file and copy the text exactly.');
    if (count > 1) throw new Error(`old_text appears ${count} times; include more surrounding text so it is unique.`);
    fs.writeFileSync(file, text.replace(old_text, () => new_text));
    return `Edited ${p}`;
  },

  run_command({ command, timeout_seconds = 120 }, ws, signal) {
    const timeout = Math.min(600, Math.max(1, Number(timeout_seconds) || 120)) * 1000;
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', command] : ['-lc', command], {
        cwd: ws,
        env: process.env,
        detached: !isWin,
      });
      let out = '';
      const add = (d) => { out += d.toString(); if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const kill = () => {
        try { isWin ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      };
      const timer = setTimeout(() => { out += `\n[stopped after ${timeout / 1000}s]`; kill(); }, timeout);
      const onAbort = () => { out += '\n[stopped by you]'; kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => { out += `\n${err.message}`; });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(clip(`${out.trim() || '(no output)'}\n[exit code ${code}]`));
      });
    });
  },
};

async function runTool(name, args, workspace, signal) {
  if (!impl[name]) throw new Error(`Unknown tool "${name}"`);
  return String(await impl[name](args || {}, workspace, signal));
}

function ollamaToolList() {
  return definitions.map(({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
}

module.exports = { definitions, byName, runTool, ollamaToolList, inside };
