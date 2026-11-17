import test from 'node:test';
import assert from 'node:assert/strict';
import { onChatPrompt, OPEN, CLOSE } from '../whale-plugin/reference.mjs';
import { decodeEnvelope } from '../src/envelope.mjs';

const message = { accountId: 'bot', platform: 'wechat', chatType: 'private', chatId: 'wxid_a', senderId: 'wxid_b' };
const base = { api: 3, hook: 'chat.prompt', message, system: '你是鲸鲸', state: {} };

test('injects an envelope the bridge can decode', () => {
  const out = onChatPrompt(base);
  const meta = decodeEnvelope(out.system);
  assert.equal(meta.chatId, 'wxid_a');
  assert.equal(meta.messageId, 's0');
  assert.ok(out.system.endsWith('你是鲸鲸'));
});

test('message ids increase per conversation and are stable in shape', () => {
  const a = onChatPrompt(base);
  const b = onChatPrompt({ ...base, state: a.state });
  assert.equal(decodeEnvelope(b.system).messageId, 's1');
  assert.equal(a.state.seq, 1);
});

test('passes through when identity is missing instead of guessing', () => {
  for (const broken of [{ chatId: '' }, { senderId: null }, { chatType: 'group' }, { chatId: 'a\nb' }]) {
    const out = onChatPrompt({ ...base, message: { ...message, ...broken } });
    assert.equal(out.system, undefined, JSON.stringify(broken));
  }
});

test('never exceeds the host system limit', () => {
  const out = onChatPrompt({ ...base, system: '长'.repeat(20000) });
  assert.ok(out.system.length <= 16000, String(out.system.length));
  assert.ok(out.system.startsWith(OPEN) && out.system.includes(CLOSE));
});

test('ignores hooks other than chat.prompt', () => {
  assert.deepEqual(onChatPrompt({ ...base, hook: 'chat.reply' }), { state: { seq: 0 } });
});
