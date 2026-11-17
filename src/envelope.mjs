/**
 * Routing envelope carried at the very top of the system prompt.
 *
 * Why a text block instead of HTTP headers or body fields: Whale-Girl's LLM client
 * only sends model/messages/stream/params (src/llm/client.js buildPayload 547-598).
 * The only channel a pure-WASM Api 3 plugin can write to is `chat.prompt`'s `system`.
 *
 * Trust model (important):
 * - Only the FIRST block at offset 0 is honoured; anything later is ignored.
 * - User text arrives as a `user` message, so it cannot reach the system head.
 * - There is deliberately no signature: the plugin ZIP is public, so any embedded
 *   key would be public too. A signature here would be theatre, not security.
 * - Therefore the proxy must still treat the envelope as "which conversation",
 *   never as "which permissions".
 */
import { BridgeError } from './core.mjs';

export const OPEN = '[[WHALE-BRIDGE v1]]';
export const CLOSE = '[[/WHALE-BRIDGE]]';
const MAX_BLOCK = 4096;
const ID = /^[\w.:@-]{1,200}$/u;

export function encodeEnvelope(meta) {
  const fields = { accountId: meta.accountId, platform: meta.platform, chatType: meta.chatType,
    chatId: meta.chatId, senderId: meta.senderId, messageId: meta.messageId };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !ID.test(value)) throw new BridgeError('BAD_ENVELOPE', `信封字段非法：${key}`);
  }
  // JSON.stringify keeps IDs unambiguous; no leading/trailing whitespace inside the block.
  return OPEN + JSON.stringify(fields) + CLOSE;
}

/** Returns parsed meta, or null when the head carries no envelope. Throws on a malformed one. */
export function decodeEnvelope(system) {
  if (typeof system !== 'string' || !system.startsWith(OPEN)) return null;
  const end = system.indexOf(CLOSE, OPEN.length);
  if (end < 0) throw new BridgeError('BAD_ENVELOPE', '信封未闭合');
  const body = system.slice(OPEN.length, end);
  if (Buffer.byteLength(body, 'utf8') > MAX_BLOCK) throw new BridgeError('BAD_ENVELOPE', '信封过大');
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new BridgeError('BAD_ENVELOPE', '信封不是合法 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BridgeError('BAD_ENVELOPE', '信封必须是对象');
  const allowed = ['accountId', 'platform', 'chatType', 'chatId', 'senderId', 'messageId', 'lastDelivery'];
  for (const key of Object.keys(parsed)) if (!allowed.includes(key)) throw new BridgeError('BAD_ENVELOPE', `信封含未知字段：${key}`);
  for (const key of allowed) {
    if (key === 'lastDelivery') continue;
    if (typeof parsed[key] !== 'string' || !ID.test(parsed[key])) throw new BridgeError('BAD_ENVELOPE', `信封字段非法：${key}`);
  }
  if (parsed.lastDelivery !== undefined) parsed.lastDelivery = normalizeDelivery(parsed.lastDelivery);
  return Object.freeze(parsed);
}

/**
 * A delivery report for a PREVIOUS turn. It never upgrades the current message:
 * it only says what the transport reported last time. `local`/`dryRun` stay
 * distinct from "sent", because Whale-Girl itself says they cannot prove delivery.
 */
export function normalizeDelivery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('BAD_ENVELOPE', 'lastDelivery 必须是对象');
  const allowed = ['messageId', 'ok', 'local', 'dryRun'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new BridgeError('BAD_ENVELOPE', `lastDelivery 含未知字段：${key}`);
  if (typeof value.messageId !== 'string' || !ID.test(value.messageId)) throw new BridgeError('BAD_ENVELOPE', 'lastDelivery.messageId 非法');
  const out = { messageId: value.messageId };
  if (value.ok !== undefined) {
    if (typeof value.ok !== 'boolean') throw new BridgeError('BAD_ENVELOPE', 'lastDelivery.ok 必须是布尔值');
    out.ok = value.ok;
  }
  for (const key of ['local', 'dryRun']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') throw new BridgeError('BAD_ENVELOPE', `lastDelivery.${key} 必须是布尔值`);
    out[key] = value[key];
  }
  return Object.freeze(out);
}

/** Maps a transport report to the strongest state it can actually justify. */
export function deliveryState(report) {
  if (!report) return null;
  if (report.ok === false) return 'failed';
  if (report.dryRun === true) return 'dry_run';
  if (report.local === true) return 'submitted_local';
  if (report.ok === true) return 'submitted';
  return 'unknown';
}

/** System prompt with the envelope removed: this is what DSH actually receives. */
export function stripEnvelope(system) {
  if (typeof system !== 'string' || !system.startsWith(OPEN)) return system;
  const end = system.indexOf(CLOSE, OPEN.length);
  return end < 0 ? system : system.slice(end + CLOSE.length).replace(/^\s*\n?/, '');
}
