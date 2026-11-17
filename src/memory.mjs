/**
 * Layered memory for the Whale→DSH bridge.
 *
 * WHY THIS EXISTS: Whale-Girl's own memory enforces `card.chatId === source.chatId`
 * as a hard red line (a cross-chat write throws MEMORY_CHAT_MISMATCH). That keeps
 * sessions clean but makes every private chat its own person — the personality
 * never accumulates across contacts. We want one personality that grows from all
 * conversations, while each conversation still keeps its own facts.
 *
 * THE SPLIT THAT FIXES IT: separate what was conflated.
 *
 *   persona layer  — global, tiny, injected every turn. Traits only, never events.
 *   episode layer  — per conversation, append-only, NOT injected unless retrieved.
 *   cross-chat     — other conversations' episodes, only when a lookup matches,
 *                    and only for entries marked shareable.
 *
 * BUDGET IS THE POINT. The user's first requirement is that injection stays
 * small: long context makes the model slower, more expensive, and dumber. So the
 * context builder has a hard ceiling and returns what it dropped, instead of
 * quietly growing. Nothing here is "inject everything and hope".
 *
 * WHAT THIS CANNOT DO: learn a speaking style. That needs fine-tuning. What it
 * does instead is measure style (sentence length, punctuation habits, filler
 * words) and inject a two-line summary — never another person's sentences, so it
 * cannot turn into an impersonation.
 */
import { createHash } from 'node:crypto';
import { mkdir, appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MEMORY_LIMITS = Object.freeze({
  /** Characters of persona text allowed every turn (traits, not events). */
  personaChars: 320,
  /** Characters of retrieved episode lines allowed every turn. */
  episodeChars: 420,
  /** Hard ceiling for the whole injected memory block. */
  totalChars: 700,
  /** Episodes returned per lookup. */
  topK: 4,
  /** Stored per conversation before the oldest are dropped on read. */
  keepPerChat: 400,
});

/**
 * Recall is an EVENT, not a per-turn habit.
 *
 * Anything injected through a prompt becomes part of the conversation history,
 * and history is re-sent every turn. Injecting memory on every turn would make
 * cost grow faster than the conversation itself — exactly the failure the user
 * is trying to avoid. So memory is injected only when the message looks like it
 * reaches backwards, and the lookup itself runs locally (free) on every turn.
 */
const RECALL_SIGNALS = /(你还记得|记得吗|记不记得|之前|上次|那次|以前|我说过|你说过|我跟你说过|前几|那天|那时候)/u;

export function shouldRecall(text) {
  return RECALL_SIGNALS.test(String(text ?? ''));
}

const PRIVATE = 'private';
const SHAREABLE = 'shareable';

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }

/** Filesystem-safe, collision-free conversation bucket. */
export function chatBucket(chatId) { return digest(chatId).slice(0, 24); }

/**
 * Who is allowed to hear this later?
 *
 * Rule of thumb, and it is deliberately conservative: facts ABOUT MYSELF (what I
 * like, what happened to me) may travel; anything someone told me in a private
 * chat may not. That mirrors the human instinct the user described — remembering
 * what A said without repeating it to B.
 */
export function visibilityOf(text) {
  const s = String(text || '');
  // Second-person facts about someone else's disclosure stay put.
  if (/(我告诉你|别告诉|只跟你说|秘密|不要跟别人说)/u.test(s)) return PRIVATE;
  // Statements about a third party stay put.
  if (/(他|她|那个|有人)(说|跟我讲|告诉我)/u.test(s)) return PRIVATE;
  // First-person facts about me may be mentioned elsewhere.
  if (/^我|我觉得|我喜欢|我不喜欢|我怕|我讨厌/u.test(s.trim())) return SHAREABLE;
  return PRIVATE;
}

function grams(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    for (const ch of seg) out.add(ch);
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** Cheap, no-network relevance: character-bigram overlap. Good enough to gate injection. */
export function relevance(query, text) {
  const a = grams(query);
  const b = new Set(grams(text));
  if (!a.length || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / Math.min(a.length, b.size);
}

export class MemoryStore {
  constructor({ root, limits = MEMORY_LIMITS } = {}) {
    if (!root) throw new Error('MemoryStore 需要 root 目录');
    this.root = root;
    this.limits = { ...MEMORY_LIMITS, ...limits };
    this.persona = '';
  }

  #dir(chatId) { return join(this.root, 'chats', chatBucket(chatId)); }
  #file(chatId) { return join(this.#dir(chatId), 'episodes.jsonl'); }

  /** Append one episode. Never rewrites history, never compacts silently. */
  async record(chatId, { role, text, at = Date.now() }) {
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    const episode = {
      at,
      role: role === 'assistant' ? 'assistant' : 'user',
      text: clean.slice(0, 2000),
      visibility: visibilityOf(clean),
    };
    await mkdir(this.#dir(chatId), { recursive: true });
    await appendFile(this.#file(chatId), JSON.stringify(episode) + '\n', 'utf8');
    return episode;
  }

  async episodes(chatId, limit = this.limits.keepPerChat) {
    try {
      const raw = await readFile(this.#file(chatId), 'utf8');
      const rows = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return rows.slice(-limit);
    } catch { return []; }
  }

  /** Every conversation this store knows about, excluding one. */
  async otherChats(excludeBucket) {
    try {
      const entries = await readdir(join(this.root, 'chats'), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && e.name !== excludeBucket).map((e) => e.name);
    } catch { return []; }
  }

  async setPersona(text) { this.persona = String(text ?? '').trim().slice(0, this.limits.personaChars * 4); return this.persona; }

  /** Counts for the settings page. Cheap: reads names and line counts only. */
  async stats() {
    const dir = join(this.root, 'chats');
    let buckets = [];
    try { buckets = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()); } catch { /* none yet */ }
    let episodes = 0;
    let shareable = 0;
    for (const b of buckets) {
      let raw = '';
      try { raw = await readFile(join(dir, b.name, 'episodes.jsonl'), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        episodes += 1;
        try { if (JSON.parse(line).visibility === SHAREABLE) shareable += 1; } catch { /* skip */ }
      }
    }
    return { chats: buckets.length, episodes, shareable, personaChars: this.persona.length };
  }

  /** Manual growth trigger for the settings button; same rules as scripts/grow-persona.mjs. */
  async grow() {
    const grown = await growPersona(this);
    return grown;
  }

  /**
   * "Last time we talked about…" — the one thing a human always has when a
   * conversation resumes after days, and the thing a bare recall lookup misses.
   *
   * Only user lines, only the tail, hard-capped. This is injected ONCE when a new
   * session opens, never per turn, because anything sent becomes history.
   */
  async recentSummary(chatId, { n = 3, cap = 200 } = {}) {
    const rows = (await this.episodes(chatId)).filter((e) => e.role === 'user');
    if (!rows.length) return '';
    const picked = rows.slice(-n).map((e) => e.text.trim()).filter(Boolean);
    if (!picked.length) return '';
    let out = '';
    for (const line of picked) {
      const clipped = line.length > 60 ? line.slice(0, 60) + '…' : line;
      const next = out ? out + '\n· ' + clipped : '· ' + clipped;
      if (next.length > cap) break;
      out = next;
    }
    return out;
  }

  /**
   * Topics that were left open: a question never answered, or a promise never
   * followed up. Used when reaching out instead of sending a canned line.
   */
  async openTopics(chatId, { n = 3, cap = 160 } = {}) {
    const rows = await this.episodes(chatId);
    const open = [];
    for (const e of rows) {
      const t = e.text.trim();
      if (e.role === 'user' && /[?？]$/.test(t)) open.push(t);
      else if (/我(会|要|改天|下次)|答应|回头/.test(t)) open.push(t);
    }
    const picked = open.slice(-n).filter(Boolean);
    let out = '';
    for (const line of picked) {
      const clipped = line.length > 50 ? line.slice(0, 50) + '…' : line;
      const next = out ? out + '\n· ' + clipped : '· ' + clipped;
      if (next.length > cap) break;
      out = next;
    }
    return out;
  }

  /**
   * Build the block to inject this turn.
   *
   * Returns `text` (possibly empty), the budget accounting, and `dropped` — what
   * was left out and why. Reporting the drop is how the UI can stay honest
   * instead of silently exceeding the budget.
   */
  async buildContext({ chatId, query = '', persona = this.persona, crossChat = true, force = false } = {}) {
    const parts = [];
    let used = 0;
    const dropped = [];

    const personaText = String(persona ?? '').trim();
    if (personaText) {
      const clipped = personaText.slice(0, this.limits.personaChars);
      if (clipped.length < personaText.length) dropped.push({ kind: 'persona', reason: 'over-persona-budget' });
      parts.push(clipped);
      used += clipped.length;
    }

    // No backward reference and nothing forced: keep the turn cheap. Retrieval is
    // local and free, so we still run it — we just do not pay tokens for it.
    const wantsEpisodes = force || shouldRecall(query);

    // Local episodes first: same conversation outranks anything else.
    const local = wantsEpisodes ? await this.episodes(chatId) : [];
    const candidates = [];
    for (const ep of local) candidates.push({ ep, scope: 'local' });
    if (wantsEpisodes && crossChat) {
      for (const bucket of await this.otherChats(chatBucket(chatId))) {
        let raw;
        try { raw = await readFile(join(this.root, 'chats', bucket, 'episodes.jsonl'), 'utf8'); } catch { continue; }
        for (const line of raw.split('\n').slice(-this.limits.keepPerChat)) {
          if (!line) continue;
          let ep; try { ep = JSON.parse(line); } catch { continue; }
          // Cross-chat only ever sees entries cleared as shareable.
          if (ep.visibility !== SHAREABLE) continue;
          candidates.push({ ep, scope: 'cross' });
        }
      }
    }

    const scored = candidates
      .map((c) => ({ ...c, score: relevance(query, c.ep.text) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || b.ep.at - a.ep.at);

    const picked = [];
    const seen = new Set();
    for (const cand of scored) {
      if (picked.length >= this.limits.topK) { dropped.push({ kind: 'episode', reason: 'top-k' }); break; }
      const key = digest(cand.ep.text);
      if (seen.has(key)) continue;
      seen.add(key);
      const line = (cand.scope === 'cross' ? '（别处）' : '') + cand.ep.text.slice(0, 160);
      if (used + line.length + 1 > this.limits.totalChars) { dropped.push({ kind: 'episode', reason: 'over-total-budget' }); break; }
      picked.push(line);
      used += line.length + 1;
    }

    if (picked.length) parts.push('你记得的事（不是这轮新说的，别当成本轮对话）：\n' + picked.join('\n'));
    const text = parts.join('\n\n');
    return {
      text,
      chars: text.length,
      approxTokens: Math.round(text.length * 1.1),
      personaChars: personaText ? Math.min(personaText.length, this.limits.personaChars) : 0,
      episodeLines: picked.length,
      recalled: picked.length > 0,
      dropped,
      budget: { ...this.limits },
    };
  }
}

/**
 * Grow the persona layer from what was actually said about itself.
 *
 * This is the "a WeChat chat can also raise it" requirement, without an extra
 * model call per turn. It is a rule-based distillation:
 *
 *   collect every `shareable` episode across all conversations  (facts about me)
 *   drop near-duplicates, keep the most recent and the most concrete
 *   render at most `personaChars` — a hard cap, not a suggestion
 *
 * Deliberately NOT done: asking a model to summarise. That would add a call per
 * growth step, and the whole point of this module is that injection stays small
 * and predictable. Rules are enough for "who am I" statements.
 *
 * Returns the grown persona text. The caller decides when to run it (this is
 * meant to be occasional, e.g. once a day or every N turns — never per turn).
 */
export async function growPersona(store, { maxSamplesPerChat = 200 } = {}) {
  const dir = join(store.root, 'chats');
  let buckets;
  try { buckets = await readdir(dir, { withFileTypes: true }); } catch { return ''; }
  const statements = [];
  for (const entry of buckets) {
    if (!entry.isDirectory()) continue;
    let raw;
    try { raw = await readFile(join(dir, entry.name, 'episodes.jsonl'), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n').slice(-maxSamplesPerChat)) {
      if (!line) continue;
      let ep; try { ep = JSON.parse(line); } catch { continue; }
      // Only first-person facts may become part of who I am.
      if (ep.visibility !== SHAREABLE) continue;
      if (ep.role !== 'user') continue;
      statements.push({ text: ep.text.trim(), at: ep.at });
    }
  }
  if (!statements.length) return '';

  // Most recent first; a later statement about me supersedes an older one.
  statements.sort((a, b) => b.at - a.at);
  const kept = [];
  const seen = [];
  for (const s of statements) {
    if (s.text.length > 120) continue;             // a paragraph is not a trait
    if (seen.some((prev) => overlapRatio(prev, s.text) >= 0.6)) continue;
    seen.push(s.text);
    kept.push(s.text);
    if (kept.length >= 12) break;
  }

  let out = '';
  for (const line of kept) {
    const next = out ? out + '\n· ' + line : '· ' + line;
    if (next.length > store.limits.personaChars) break;
    out = next;
  }
  store.persona = out;
  return out;
}

/** Shared-character ratio, used to collapse "我喜欢辣" / "我喜欢吃辣". */
function overlapRatio(a, b) {
  const sa = new Set(String(a)); const sb = new Set(String(b));
  let hit = 0;
  for (const ch of sa) if (sb.has(ch)) hit += 1;
  return hit / Math.max(1, Math.min(sa.size, sb.size));
}

/**
 * Style measurement, not style imitation.
 * We never inject someone else's sentences. We count how real people in this chat
 * actually write and hand back two lines of statistics, so the model adapts
 * rhythm without learning to parody a specific person.
 */
export function styleProfile(samples) {
  const texts = (samples || []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!texts.length) return null;
  const lengths = texts.map((t) => t.length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const noPunct = texts.filter((t) => !/[。！？!?，,；;]$/u.test(t)).length / texts.length;
  const short = lengths.filter((n) => n <= 12).length / texts.length;
  const emoji = texts.filter((t) => /[\u{1F300}-\u{1FAFF}]/u.test(t)).length / texts.length;
  return {
    samples: texts.length,
    avgLength: Math.round(avg),
    shortShare: Math.round(short * 100),
    noPunctShare: Math.round(noPunct * 100),
    emojiShare: Math.round(emoji * 100),
  };
}

/** Two lines, hard-capped: this is the entire style injection. */
export function styleLine(profile) {
  if (!profile || profile.samples < 5) return '';
  const bits = [`平均 ${profile.avgLength} 字`];
  if (profile.shortShare >= 60) bits.push(`${profile.shortShare}% 是短句`);
  if (profile.noPunctShare >= 50) bits.push(`过半不带句末标点`);
  if (profile.emojiShare >= 30) bits.push(`常用表情`);
  if (profile.emojiShare <= 5) bits.push(`基本不用表情`);
  return '这个聊天里真人说话的习惯：' + bits.join('，') + '。';
}
