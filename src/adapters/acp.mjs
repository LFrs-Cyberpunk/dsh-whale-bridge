import { spawn } from 'node:child_process';
import { BridgeError } from '../core.mjs';

/**
 * ACP (Agent Client Protocol) JSON-RPC over stdio — verified against the real
 * implementation in app.asar (`@deepseek-ai/dsh-acp/lib/index.js`):
 *
 *   session/new   params { cwd, mcpServers? }        -> { sessionId, configOptions }
 *   session/prompt params { sessionId, prompt: ContentBlock[] } -> { stopReason }
 *   session/close params { sessionId }
 *
 * IMPORTANT: `session/prompt` does NOT return the assistant text. It arrives as
 * `session/update` notifications:
 *   { sessionId, update: { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'
 *                          | 'tool_call' | 'tool_call_update' | 'usage_update'
 *                          | 'config_option_update', content: { type: 'text', text } } }
 * Only `agent_message_chunk` is assistant output; thoughts and tool traffic are not.
 *
 * There is also no way to pass a system prompt to session/new, so a persona can
 * only travel inside the prompt text (see adapters/acp-backend.mjs).
 *
 * Safety: this client only ever talks to the child it started itself. There is
 * deliberately no API to attach to an already-running DSH. Every permission
 * request is rejected.
 */
export class AcpClient {
  constructor({ command, args = [], env, cwd, requestTimeoutMs = 60000 }) {
    if (!command) throw new BridgeError('ACP_COMMAND_REQUIRED', '必须显式给出隔离 DSH 可执行文件');
    Object.assign(this, { command, args, env, cwd, requestTimeoutMs });
    this.child = null; this.buffer = ''; this.nextId = 1; this.pending = new Map();
    this.sessions = new Set(); this.chunks = new Map(); this.toolCalls = 0; this.thoughts = 0;
  }

  async start() {
    if (this.child) throw new BridgeError('ACP_ALREADY_STARTED', '客户端只能启动一次');
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.childPid = this.child.pid;
    this.child.stdout.setEncoding('utf8').on('data', (chunk) => this.#feed(chunk));
    this.child.stderr.setEncoding('utf8').on('data', (chunk) => { this.lastStderr = String(chunk).slice(-4000); });
    this.child.once('exit', (code) => this.#failAll(new BridgeError('ACP_EXITED', `隔离 DSH 进程退出（code=${code}）`, 503)));
    await this.initialize();
    return this;
  }

  /**
   * Standard ACP handshake. The agent advertises capabilities here; we advertise
   * none (no fs, no terminal), because this bridge must never hand the agent new
   * powers on behalf of an external chat.
   */
  async initialize() {
    const result = await this.#rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.agentInfo = result?.agentInfo ?? null;
    this.protocolVersion = result?.protocolVersion ?? null;
    return result;
  }

  #feed(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }

      // Server -> client request (permission etc.): always deny.
      if (message.method && message.id !== undefined) { this.#reply(message.id, { outcome: 'reject' }); continue; }

      // Server -> client notification.
      if (message.method === 'session/update') { this.#consumeUpdate(message.params); continue; }
      if (message.method) continue;

      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new BridgeError('ACP_RPC_ERROR', String(message.error.message ?? 'rpc error'), 502));
      else entry.resolve(message.result);
    }
  }

  /** Keeps only assistant text; thoughts and tool traffic are counted, never merged. */
  #consumeUpdate(params) {
    const sessionId = params?.sessionId;
    const update = params?.update;
    if (typeof sessionId !== 'string' || !update) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? update.content.text : '';
      if (typeof text === 'string' && text) this.chunks.set(sessionId, (this.chunks.get(sessionId) ?? '') + text);
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk') { this.thoughts++; return; }
    if (update.sessionUpdate === 'tool_call') this.toolCalls++;
  }

  #reply(id, result) { try { this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch {} }
  #failAll(error) { for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); }

  async #rpc(method, params) {
    if (!this.child) throw new BridgeError('ACP_NOT_STARTED', 'ACP 未启动', 503);
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('ACP_TIMEOUT', `${method} 超时`, 504)); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }

  async newSession({ cwd, mcpServers = [] }) {
    const result = await this.#rpc('session/new', { cwd, mcpServers });
    if (!result?.sessionId) throw new BridgeError('ACP_BAD_SESSION', 'session/new 未返回 sessionId', 502);
    this.sessions.add(result.sessionId);
    return result.sessionId;
  }

  /**
   * Reattach to an existing DSH session instead of starting a blank one.
   *
   * This is the whole answer to "why does the context keep resetting": a session id
   * is durable on the host side, so as long as we remember it, a restarted bridge
   * can pick the conversation back up. Without this, every bridge restart means the
   * model wakes up with no idea who it was talking to.
   *
   * Returns null when the host does not know that id any more — the caller then
   * starts fresh and leans on memory for continuity.
   */
  async resumeSession({ sessionId, cwd, mcpServers = [] }) {
    if (!sessionId) return null;
    this.lastResumeError = null;
    try {
      // Verified against a real host: on success this returns ONLY
      // `{ configOptions }` — no sessionId. Requiring result.sessionId made a
      // working resume look like a failure. The id we kept stays the id it uses.
      // `cwd` and `mcpServers` are both required; without them the host answers
      // "Invalid params", and resuming an active session answers
      // "session is already active".
      await this.#rpc('session/resume', { sessionId, cwd, mcpServers });
      this.sessions.add(sessionId);
      return sessionId;
    } catch (e) {
      this.lastResumeError = String(e?.code ?? '') + ' ' + String(e?.message ?? e);
      return null;
    }
  }

  /** Whatever the host still remembers. Used to prune stale ids on startup. */
  async listSessions({ cwd, raw = false } = {}) {
    try {
      const result = await this.#rpc('session/list', cwd ? { cwd } : {});
      if (raw) return result;
      const list = Array.isArray(result?.sessions) ? result.sessions : [];
      return list.map((s) => (typeof s === 'string' ? s : s?.sessionId)).filter(Boolean);
    } catch (e) {
      if (raw) return { error: String(e?.code ?? e?.message ?? e) };
      return [];
    }
  }

  /** Returns the assistant text assembled from agent_message_chunk notifications. */
  async prompt({ sessionId, text }) {
    if (!this.sessions.has(sessionId)) throw new BridgeError('ACP_UNKNOWN_SESSION', '未知会话', 400);
    if (typeof text !== 'string' || !text) throw new BridgeError('ACP_BAD_PROMPT', 'prompt 文本为空', 400);
    this.chunks.set(sessionId, '');
    const result = await this.#rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    const reply = this.chunks.get(sessionId) ?? '';
    this.chunks.delete(sessionId);
    if (!reply.trim()) throw new BridgeError('ACP_EMPTY_REPLY', 'DSH 本回合没有产生可发送的文本', 502);
    return { text: reply, stopReason: result?.stopReason ?? 'unknown' };
  }

  async close() {
    if (!this.child) return;
    // A hung host never answers session/close, so bound each call. Close must always
    // finish; otherwise the bridge process cannot be shut down or restarted.
    for (const sessionId of this.sessions) {
      try {
        await Promise.race([
          this.#rpc('session/close', { sessionId }),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
      } catch { /* best effort */ }
    }
    this.sessions.clear();
    const child = this.child; this.child = null;
    await new Promise((resolve) => { const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
  }
}
