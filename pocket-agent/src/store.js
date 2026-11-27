'use strict';
// Saves chat sessions as JSON files on your own disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = path.join(dir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(id) {
    if (!/^[a-z0-9]{6,40}$/.test(id)) throw new Error('Bad session id');
    return path.join(this.dir, `${id}.json`);
  }

  create({ model, workspace }) {
    const now = Date.now();
    const s = { id: crypto.randomBytes(8).toString('hex'), title: 'New chat', model, workspace, created: now, updated: now, messages: [] };
    this.save(s);
    return s;
  }

  get(id) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  save(s) {
    s.updated = Date.now();
    const tmp = this.file(s.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, this.file(s.id));
  }

  delete(id) {
    try { fs.unlinkSync(this.file(id)); } catch { /* gone */ }
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .filter(Boolean)
      .map(({ id, title, model, updated, workspace }) => ({ id, title, model, updated, workspace }))
      .sort((a, b) => b.updated - a.updated);
  }
}

module.exports = { Store };
