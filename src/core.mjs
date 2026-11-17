import { createHash } from 'node:crypto';
import { assemblePersona, normalizePersona } from './persona.mjs';

export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'BridgeError'; this.code = code; this.status = status; }
}
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function validateMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('BAD_MESSAGE', '消息必须是对象');
  const out = {};
  for (const key of ['accountId', 'platform', 'chatId', 'senderId', 'messageId']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 256 || /[\u0000-\u001f\u007f]/u.test(input[key])) throw new BridgeError('MISSING_IDENTITY', `缺少或非法身份字段：${key}`);
    out[key] = input[key];
  }
  if (input.chatType !== 'private') throw new BridgeError('UNSUPPORTED_CHAT_TYPE', '首版只处理文字私聊');
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > 16000) throw new BridgeError('BAD_TEXT', '正文为空或超限');
  out.chatType = input.chatType;
  out.text = input.text;
  // Optional: the caller's own system prompt. Used only when personaSource is
  // 'whale', so "use the Whale-Girl persona" needs no read access to her files.
  if (input.systemHint !== undefined) {
    if (typeof input.systemHint !== 'string' || Buffer.byteLength(input.systemHint, 'utf8') > 32000) throw new BridgeError('BAD_SYSTEM_HINT', 'systemHint 非法或超限');
    out.systemHint = input.systemHint;
  }
  return Object.freeze(out);
}
export function conversationKey(message) {
  // JSON tuple, never delimiter concatenation: user-controlled IDs cannot collide.
  return digest(JSON.stringify([message.accountId, message.platform, message.chatType, message.chatId]));
}
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('BAD_CONFIG', '配置必须是对象');
  const source = input.personaSource ?? 'dsh';
  if (!['dsh', 'whale', 'custom'].includes(source)) throw new BridgeError('BAD_PERSONA_SOURCE', '人格来源必须三选一');
  const customPrompt = input.customPrompt ?? '';
  if (typeof customPrompt !== 'string' || Buffer.byteLength(customPrompt, 'utf8') > 24000) throw new BridgeError('BAD_CUSTOM_PERSONA', '自定义人格超限');
  // Structured persona (see src/persona.mjs). When it has an "identity", it wins
  // over the free-form customPrompt; otherwise the old plain-text field is used.
  const customPersona = input.customPersona === undefined ? null : normalizePersona(input.customPersona);
  if (source === 'custom' && !customPrompt.trim() && !String(customPersona?.identity ?? '').trim()) throw new BridgeError('EMPTY_CUSTOM_PERSONA', '请填写自定义人格');
  const integer = (key, fallback, min, max) => {
    const v = input[key] ?? fallback;
    if (!Number.isInteger(v) || v < min || v > max) throw new BridgeError('BAD_CONFIG', `${key}超出范围`);
    return v;
  };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new BridgeError('BAD_CONFIG', 'enabled 必须是布尔值');
  return Object.freeze({ enabled: input.enabled ?? false, personaSource: source, customPrompt, customPersona,
    timeoutMs: integer('timeoutMs', 45000, 20, 300000), maxPendingPerChat: integer('maxPendingPerChat', 8, 1, 32),
    maxConcurrent: integer('maxConcurrent', 2, 1, 4) });
}

/**
 * Three persona modes. The difference that matters is whether we INJECT text.
 *
 * - `dsh`    : inject nothing. The isolated DSH loads its own persona plugins
 *              (agent-md / soul-md / whatever the user runs), so we "follow DSH"
 *              by staying out of the way. Injecting a copy of their text here is
 *              exactly what causes persona fights.
 * - `whale`  : inject the system prompt Whale-Girl already built and sent.
 *              Requires the isolated host to NOT load a DSH persona, otherwise
 *              two personas are present at once.
 * - `custom` : inject our own text. Same host requirement as `whale`.
 *
 * `revision` feeds the conversation key: changing the injected text starts a
 * fresh session instead of mutating an existing one.
 */
export class PersonaResolver {
  constructor({ readDshPersona, readWhalePersona } = {}) { this.readDshPersona = readDshPersona; this.readWhalePersona = readWhalePersona; }
  async resolve(config, context = {}) {
    if (config.personaSource === 'dsh') {
      // Native mode: no text, no injection, no reading of anything. The host owns it.
      return Object.freeze({ source: 'dsh', mode: 'native', inject: null, revision: digest('native') });
    }
    let text;
    if (config.personaSource === 'whale') {
      // Prefer the system prompt the caller already assembled: no file access,
      // no duplicating her persona config, and it stays in sync with her settings.
      if (typeof context.whaleSystem === 'string' && context.whaleSystem.trim()) text = context.whaleSystem;
      else text = await this.readWhalePersona?.();
    } else {
      // Structured fields win when present; the free-form box stays as an escape hatch.
      const structured = assemblePersona(config.customPersona ?? {});
      text = structured || config.customPrompt;
    }
    if (typeof text !== 'string' || !text.trim()) throw new BridgeError('PERSONA_UNAVAILABLE', '所选人格无法读取；不会偷偷切换来源', 503);
    if (Buffer.byteLength(text, 'utf8') > 64000) throw new BridgeError('PERSONA_TOO_LARGE', '人格正文超限');
    return Object.freeze({ source: config.personaSource, mode: 'inject', inject: text, revision: digest(JSON.stringify([config.personaSource, text])) });
  }
}

class Gate {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return () => this.release(); }
    await new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, abort: null };
      item.abort = () => { this.waiters = this.waiters.filter(x => x !== item); reject(signal.reason); };
      signal.addEventListener('abort', item.abort, { once: true }); this.waiters.push(item);
    });
    return () => this.release();
  }
  release() {
    const next = this.waiters.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else this.active--;
  }
}

export class BridgeEngine {
  constructor({ adapter, personas, config = {}, diagnostics, cacheLimit = 500, cacheTtlMs = 600000 }) {
    this.adapter = adapter; this.personas = personas; this.config = normalizeConfig(config); this.diagnostics = diagnostics;
    this.gate = new Gate(this.config.maxConcurrent); this.cacheLimit = cacheLimit; this.cacheTtlMs = cacheTtlMs;
    this.entries = new Map(); this.queues = new Map(); this.pending = new Map(); this.activeControllers = new Set(); this.epoch = 0;
  }
  configure(input) {
    const next = normalizeConfig(input);
    const pendingNow = [...this.pending.values()].reduce((a, b) => a + b, 0);
    if (next.maxConcurrent !== this.config.maxConcurrent && (this.gate.active > 0 || pendingNow > 0)) {
      throw new BridgeError('BUSY_CONFIG', '有消息正在处理或排队时不能改变并发上限', 409);
    }
    const personaChanged = next.personaSource !== this.config.personaSource || next.customPrompt !== this.config.customPrompt;
    if (personaChanged || !next.enabled) {
      this.epoch++;
      for (const controller of this.activeControllers) controller.abort(new BridgeError('BRIDGE_PAUSED', '桥接已暂停或人格已切换', 503));
    }
    if (next.maxConcurrent !== this.config.maxConcurrent) this.gate = new Gate(next.maxConcurrent);
    this.config = next; return next;
  }
  status() { return { enabled: this.config.enabled, personaSource: this.config.personaSource, active: this.gate.active, pending: [...this.pending.values()].reduce((a,b)=>a+b,0), adapter: this.adapter.kind ?? 'unknown' }; }
  submit(raw) {
    try {
      if (!this.config.enabled) throw new BridgeError('BRIDGE_PAUSED', '桥接未启用', 503);
      const message = validateMessage(raw), key = conversationKey(message), id = `${key}:${digest(message.messageId)}`;
      const fingerprint = digest(JSON.stringify(message)); const now = Date.now();
      for (const [k,v] of this.entries) if (v.finished && v.expires <= now) this.entries.delete(k);
      const existing = this.entries.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new BridgeError('MESSAGE_ID_CONFLICT', '同一消息 ID 携带不同内容', 409);
        return existing.promise;
      }
      if ((this.pending.get(key) ?? 0) >= this.config.maxPendingPerChat) throw new BridgeError('CHAT_QUEUE_FULL', '本聊天待处理消息过多', 429);
      while (this.entries.size >= this.cacheLimit) {
        const finished = [...this.entries].find(([,v]) => v.finished);
        if (!finished) throw new BridgeError('GLOBAL_QUEUE_FULL', '全局待处理消息过多', 429);
        this.entries.delete(finished[0]);
      }
      const config = this.config, epoch = this.epoch;
      this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
      const previous = this.queues.get(key) ?? Promise.resolve();
      const entry = { fingerprint, finished: false, expires: Infinity, promise: null };
      let failed = false;
      const operation = previous.catch(()=>{}).then(() => this.run(message, key, config, epoch))
        .catch((error) => { failed = true; throw error; });
      const cleanup = operation.finally(() => {
        const count = this.pending.get(key) - 1; if (count) this.pending.set(key, count); else this.pending.delete(key);
        if (failed) {
          // A failed turn must be retryable. Caching the rejection would make every
          // retry of the same message id return the same error until it expires —
          // which is exactly what happens when the transport retries after a timeout.
          this.entries.delete(id);
        } else {
          entry.finished = true; entry.expires = Date.now() + this.cacheTtlMs;
        }
        if (this.queues.get(key) === tail) this.queues.delete(key);
      });
      const tail = cleanup.catch(()=>{}); this.queues.set(key, tail);
      entry.promise = cleanup; this.entries.set(id, entry); return cleanup;
    } catch (error) { return Promise.reject(error); }
  }
  async run(message, key, config, epoch) {
    if (epoch !== this.epoch || !this.config.enabled) throw new BridgeError('STALE_REQUEST', '配置已变化，旧排队消息已取消', 409);
    const controller = new AbortController(); this.activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(new BridgeError('TURN_TIMEOUT', '处理超时；不会切回其他人格', 504)), config.timeoutMs);
    let release;
    try {
      release = await this.gate.acquire(controller.signal);
      const persona = await this.personas.resolve(config, { whaleSystem: message.systemHint }); controller.signal.throwIfAborted();
      const sessionKey = digest(JSON.stringify([key, persona.revision]));
      // Hard policy independent from persona text. Adapter MUST enforce deny-by-default tools.
      const result = await this.adapter.generate({ sessionKey, message, persona, signal: controller.signal,
        policy: Object.freeze({ toolAllowlist: Object.freeze([]), externalChat: true }) });
      controller.signal.throwIfAborted();
      if (epoch !== this.epoch) throw new BridgeError('STALE_RESULT', '人格或启停状态变化，旧结果已丢弃', 409);
      if (typeof result?.text !== 'string' || !result.text.trim() || Buffer.byteLength(result.text, 'utf8') > 16000) throw new BridgeError('INVALID_RESULT', '后端未返回有效最终文字', 502);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(result.text) || /[@＠][\s\u200b-\u200d]*(?:所有人|全体成员|all)(?![\p{L}\p{N}])/iu.test(result.text)) throw new BridgeError('UNSAFE_RESULT', '回复含禁止内容', 502);
      // Generated is not delivered. Transport layer must provide independently verified receipts.
      return { requestId: digest(JSON.stringify([key,message.messageId])), conversation: key, text: result.text, delivery: 'generated', personaSource: persona.source };
    } catch (error) {
      await this.diagnostics?.record(error, { phase: 'turn', conversation: key, messageRef: digest(message.messageId) });
      throw error;
    } finally { clearTimeout(timer); this.activeControllers.delete(controller); release?.(); }
  }
}
