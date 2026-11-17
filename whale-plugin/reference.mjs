/**
 * Reference logic for the Whale-Girl Api 3 plugin (hooks: chat.prompt + chat.dispatched).
 *
 * This file is the reviewed oracle. The shipped artefact is `build/as/index.ts`,
 * compiled to `dist/plugin.wasm`. Both must agree on every case (tests enforce it).
 *
 * Contract (src/services/messagePlugins.js 177-206):
 *   input  { api:3, hook, message, system, delivery, state, settings, ... }
 *   output { system, state }  |  { state }
 */

export const OPEN = '[[WHALE-BRIDGE v1]]';
export const CLOSE = '[[/WHALE-BRIDGE]]';
const MAX_SYSTEM = 16000;
const ID = /^[\w.:@-]{1,200}$/u;

/** Mirrors Whale-Girl's UNSAFE_TEXT (src/services/messagePlugins.js 20). */
const unsafeCode = (c) =>
  (c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 127 && c <= 159) || c === 0x061c
  || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

function scrub(text) {
  let out = '';
  for (const ch of String(text)) out += unsafeCode(ch.codePointAt(0)) ? ' ' : ch;
  return out;
}

function readSeq(state) {
  const v = state?.seq;
  return Number.isInteger(v) && v >= 0 && v <= 100000000 ? v : 0;
}

/** Keeps only the four known fields, so a stale/odd `last` cannot poison the envelope. */
function readLast(last) {
  if (!last || typeof last !== 'object') return null;
  if (typeof last.messageId !== 'string' || !ID.test(last.messageId)) return null;
  const out = { messageId: last.messageId };
  for (const key of ['ok', 'local', 'dryRun']) if (typeof last[key] === 'boolean') out[key] = last[key];
  return out;
}

export function onHook(input) {
  const { message = {}, system = '', state = {}, delivery } = input ?? {};
  const seq = readSeq(state);

  // ── chat.dispatched: remember what the transport said, for the NEXT turn ──
  if (input?.hook === 'chat.dispatched') {
    if (seq <= 0 || !delivery || typeof delivery !== 'object') return { state: { seq } };
    const last = { messageId: `s${seq - 1}` };
    if (typeof delivery.ok === 'boolean') last.ok = delivery.ok;
    if (typeof delivery.local === 'boolean') last.local = delivery.local;
    if (typeof delivery.dryRun === 'boolean') last.dryRun = delivery.dryRun;
    return { state: { seq, last } };
  }

  const pass = { state: { seq } };
  if (input?.hook !== 'chat.prompt') return pass;

  // Never fabricate an identity: missing fields means "pass", not "guess".
  const fields = { platform: message.platform, chatType: message.chatType, chatId: message.chatId, senderId: message.senderId };
  for (const key of ['platform', 'chatType', 'chatId', 'senderId']) {
    if (typeof fields[key] !== 'string' || !ID.test(fields[key])) return pass;
  }
  if (fields.chatType !== 'private') return pass; // v1: private chat only

  // accountId identifies the bot account serving the chat. pluginContext has no
  // real account id, so the plugin states the source as "whale".
  const env = { accountId: 'whale', ...fields, messageId: `s${seq}` };
  const last = readLast(state.last);
  if (last) env.lastDelivery = last;
  const envelope = OPEN + JSON.stringify(env) + CLOSE;

  // Keep the caller's own system prompt verbatim; only truncate to the host limit.
  let body = String(system ?? '');
  const room = MAX_SYSTEM - envelope.length - 1;
  if (room <= 0) return pass; // refuse rather than send a broken envelope
  if (body.length > room) body = body.slice(0, room);
  // Any envelope marker inside the caller's own prompt is stripped, so exactly one
  // envelope (ours, at offset 0) can ever be present.
  body = body.split(OPEN).join('').split(CLOSE).join('');
  // `last` is consumed: it must not be reported twice.
  return { system: envelope + '\n' + scrub(body), state: { seq: seq + 1 } };
}

/** Back-compat alias used by older tests. */
export const onChatPrompt = onHook;
