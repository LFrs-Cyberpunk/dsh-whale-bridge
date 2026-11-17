import { mkdir, appendFile, stat, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function redact(value) {
  return String(value ?? '').replace(/\b(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[REDACTED]');
}
export class Diagnostics {
  constructor({ directory, maxBytes = 1048576, notify } = {}) {
    this.directory = directory ? resolve(directory) : null; this.maxBytes = maxBytes; this.notify = notify;
    this.errors = []; this.lastNotification = new Map(); this.chain = Promise.resolve();
  }
  async record(error, context = {}) {
    const code = /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'INTERNAL_ERROR';
    // Do not log arbitrary exception messages: upstream may include chat content or secrets.
    const entry = { id: randomUUID(), at: new Date().toISOString(), code,
      phase: String(context.phase ?? 'unknown').slice(0,64),
      conversation: /^[a-f0-9]{64}$/.test(context.conversation ?? '') ? context.conversation : undefined,
      messageRef: /^[a-f0-9]{64}$/.test(context.messageRef ?? '') ? context.messageRef : undefined,
      stack: redact(String(error?.stack ?? '').split('\n').slice(1, 7).join('\n')) };
    this.errors.push(entry); if (this.errors.length > 100) this.errors.shift();
    const write = async () => {
      if (!this.directory) return;
      await mkdir(this.directory, { recursive: true }); const file = join(this.directory,'errors.jsonl');
      const current = await stat(file).catch(()=>null);
      if (current?.size >= this.maxBytes) await rename(file, join(this.directory,`errors-${randomUUID()}.jsonl`));
      await appendFile(file, JSON.stringify(entry)+'\n', { mode: 0o600 });
    };
    this.chain = this.chain.then(write).catch(()=>{}); await this.chain;
    const last = this.lastNotification.get(code) ?? 0;
    if (Date.now() - last > 30000) { this.lastNotification.set(code, Date.now()); try { this.notify?.({ id: entry.id, code, phase: entry.phase }); } catch {} }
    return entry.id;
  }
  list() { return this.errors.map(({stack,...entry})=>entry); }
}
