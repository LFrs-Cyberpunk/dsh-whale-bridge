import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BridgeError, conversationKey } from '../core.mjs';
import { digest } from '../core.mjs';

/**
 * DSH backend built on ACP.
 *
 * Honest limits, all forced by the real `@deepseek-ai/dsh-acp`:
 * - `session/new` accepts only `{ cwd, mcpServers }` — there is no system-prompt
 *   parameter, so a persona cannot be installed as a system message.
 * - Therefore the persona is delivered as a leading block inside the FIRST prompt
 *   of a session, and never repeated (repeating it would bloat every turn and
 *   fight the session's own context).
 * - One ACP session per conversation key. Persona changes produce a new key
 *   (see core.mjs), so they start a fresh session instead of mutating an old one.
 *
 * MEMORY: anything sent through a prompt becomes history, and history is re-sent
 * every turn. So recall is injected only on turns that reach backwards (see
 * src/memory.mjs) — never as a routine per-turn prefix.
 */
export class AcpBackend {
  kind = 'acp';

  constructor({ client, workspaceRoot, maxSessions = 50, onSession, memory, statePath = null } = {}) {
    if (!client) throw new BridgeError('ACP_CLIENT_REQUIRED', '缺少 AcpClient');
    if (!workspaceRoot) throw new BridgeError('ACP_WORKSPACE_REQUIRED', '必须给出隔离工作目录');
    Object.assign(this, { client, workspaceRoot, maxSessions, onSession, memory: memory ?? null, statePath });
    this.backends = new Map(); // sessionKey -> { sessionId, personaSent }
    this.lastRecall = null;
    this.lastResume = null;    // what happened on the most recent attempt, for diagnostics
    this.loaded = false;
  }

  /**
   * Remember which conversation lives in which DSH session, across restarts.
   *
   * This is the answer to "every new conversation starts blank": the session id is
   * durable on the host, so keeping it is enough to pick the conversation back up.
   * Written best-effort — a failed save must never break a turn.
   */
  async load() {
    if (this.loaded || !this.statePath) return this;
    this.loaded = true;
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const saved = JSON.parse(raw);
      for (const [key, value] of Object.entries(saved?.sessions ?? {})) {
        // `attached:false` means "we remember the id, but this process has not
        // reattached to it yet" — that is what triggers a resume on first use.
        if (value?.sessionId) this.backends.set(key, { sessionId: value.sessionId, personaSent: true, attached: false });
      }
    } catch { /* first run, or unreadable state: start empty */ }
    return this;
  }

  async #save() {
    if (!this.statePath) return;
    try {
      const sessions = {};
      for (const [key, entry] of this.backends) sessions[key] = { sessionId: entry.sessionId };
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify({ sessions }, null, 2), 'utf8');
    } catch { /* state is an optimisation, not a requirement */ }
  }

  async generate({ sessionKey, message, persona, signal, policy }) {
    signal?.throwIfAborted();
    if (!Array.isArray(policy?.toolAllowlist) || policy.toolAllowlist.length !== 0) {
      throw new BridgeError('TOOL_POLICY_VIOLATION', '外部聊天上下文不允许任何工具', 500);
    }
    await this.load();

    let entry = this.backends.get(sessionKey);
    if (!entry) {
      if (this.backends.size >= this.maxSessions) throw new BridgeError('ACP_TOO_MANY_SESSIONS', '会话数超过上限', 503);
      const sessionId = await this.client.newSession({ cwd: this.workspaceRoot });
      // In native mode there is nothing to deliver: the host already has its own persona.
      entry = { sessionId, personaSent: persona.inject == null, attached: true };
      this.backends.set(sessionKey, entry);
      this.onSession?.(sessionKey, sessionId);
      await this.#save();
    } else if (entry.attached === false) {
      // Came back from disk: reattach to the same DSH session so the model still
      // has the conversation. Only if the host forgot it do we start blank.
      const resumed = await this.client.resumeSession({ sessionId: entry.sessionId, cwd: this.workspaceRoot, mcpServers: [] });
      this.lastResume = { sessionKey, sessionId: entry.sessionId, ok: Boolean(resumed), error: this.client.lastResumeError ?? null };
      entry.attached = true;
      if (!resumed) {
        entry.sessionId = await this.client.newSession({ cwd: this.workspaceRoot });
        entry.personaSent = persona.inject == null;
        await this.#save();
      }
    }

    signal?.throwIfAborted();

    // memoryChatId is the CONVERSATION, not the session. sessionKey folds in the
    // persona revision, so editing the persona would otherwise orphan every memory
    // recorded so far. A persona change should start a new ACP session; it must not
    // start a new memory.
    const memoryChatId = conversationKey(message);

    const blocks = [];
    if (!entry.personaSent) {
      // The grown persona layer rides along with the first prompt instead of being
      // injected every turn. Anything sent through a prompt becomes history and is
      // re-billed on every later turn, so the free slot is the first one.
      const grown = String(this.memory?.persona ?? '').trim();
      const parts = [persona.inject, grown].filter(Boolean);
      if (parts.length) {
        blocks.push(`【人格设定】\n${parts.join('\n\n')}\n【以上为背景设定，之后按此风格回话，不要复述本段】`);
      }
      // A resumed conversation is not a new relationship. Without this, coming back
      // three days later looks exactly like meeting a stranger.
      if (this.memory) {
        const recap = await this.memory.recentSummary(memoryChatId).catch(() => '');
        if (recap) blocks.push(`上次和这个人聊到（这是真的记录，不是你编的）：\n${recap}\n【别假装记得细节，不确定就别提。】`);
      }
    }
    // Recall only when the message reaches backwards; the lookup is local and free,
    // the injection is not. The persona layer already went out above, so pass none.
    if (this.memory) {
      const ctx = await this.memory.buildContext({ chatId: memoryChatId, query: message.text, persona: '' });
      this.lastRecall = ctx;
      if (ctx.text) blocks.push(ctx.text);
    }
    blocks.push(message.text);

    const result = await this.client.prompt({ sessionId: entry.sessionId, text: blocks.join('\n\n') });
    // Only mark the persona as delivered after a successful turn: a failed first
    // turn must be retried WITH the persona, not silently without it.
    entry.personaSent = true;
    // Record after success only — a failed turn is not something that happened.
    // sessionKey is the stable per-conversation bucket, so this is the same
    // identity the recall lookup uses.
    if (this.memory) {
      await this.memory.record(memoryChatId, { role: 'user', text: message.text }).catch(() => {});
      await this.memory.record(memoryChatId, { role: 'assistant', text: result.text }).catch(() => {});
    }
    return { text: result.text };
  }

  /** Stable, non-reversible reference to a session for diagnostics. */
  sessions() { return [...this.backends.values()].map((v) => digest(v.sessionId).slice(0, 12)); }

  async close() { this.backends.clear(); await this.client.close?.(); }
}
