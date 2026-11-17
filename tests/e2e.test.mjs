import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildStack } from '../scripts/wire-host.mjs';
import { decodeEnvelope, deliveryState } from '../src/envelope.mjs';

/**
 * Shadow run: replays one full turn the way Whale-Girl would do it, but with the
 * mock DSH backend and no real WeChat. Nothing leaves 127.0.0.1.
 */
const here = dirname(fileURLToPath(import.meta.url));
const wasm = await readFile(join(here, '..', 'whale-plugin', 'dist', 'plugin.wasm'));

async function runPlugin(input) {
  const bytes = Buffer.from(JSON.stringify(input));
  const out = [];
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(wasm), {
    whale: {
      input_size: () => bytes.length,
      input_byte: (i) => (i >= 0 && i < bytes.length ? bytes[i] : -1),
      output_byte: (v) => { out.push(v); },
    },
  });
  assert.equal(inst.exports.run(), 0);
  return JSON.parse(Buffer.from(out).toString('utf8'));
}

const phone = { platform: 'wechat', chatType: 'private', chatId: 'wxid_friend', senderId: 'wxid_friend' };
const other = { platform: 'wechat', chatType: 'private', chatId: 'wxid_other', senderId: 'wxid_other' };

function promptInput(message, system, state, text) {
  // Mirrors messagePlugins.js dispatch(): input assembled from pluginContext + hook text.
  return { api: 3, hook: 'chat.prompt', message, now: Date.now(), lastBot: null,
    state, settings: {}, decision: 'reply', text, system };
}

test('one full shadow turn: envelope → proxy → engine → reply → receipt', async () => {
  const stack = buildStack({ config: { enabled: true, personaSource: 'whale' } });
  const info = await stack.proxy.listen();
  try {
    // 1. Whale-Girl runs the plugin on her own system prompt.
    const pluginOut = await runPlugin(promptInput(phone, '你是鲸鲸，说话简短。', {}, '在吗'));
    let state = pluginOut.state;
    assert.ok(pluginOut.system.startsWith('[[WHALE-BRIDGE v1]]'));
    assert.equal(decodeEnvelope(pluginOut.system).chatId, 'wxid_friend');

    // 2. Her LLM client posts system + user text (buildPayload shape).
    const res = await fetch(info.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + stack.token },
      body: JSON.stringify({
        model: 'whale-model', stream: false, temperature: 0.9,
        messages: [{ role: 'system', content: pluginOut.system }, { role: 'user', content: '在吗' }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    const reply = body.choices?.[0]?.message?.content;
    assert.ok(typeof reply === 'string' && reply.length > 0);

    // 3. Transport reports success; plugin stores it for the next turn.
    const dispatched = await runPlugin({ api: 3, hook: 'chat.dispatched', message: phone, state, delivery: { ok: true, local: true } });
    state = dispatched.state;
    assert.equal(dispatched.state.last.messageId, 's0');

    // 4. Next turn carries the receipt back to the bridge.
    const next = await runPlugin(promptInput(phone, '你是鲸鲸', state, '再来一句'));
    const meta = decodeEnvelope(next.system);
    assert.equal(meta.messageId, 's1');
    assert.equal(deliveryState(meta.lastDelivery), 'submitted_local');
    assert.notEqual(deliveryState(meta.lastDelivery), 'delivered');

    // 5. The receipt is gone from state after being reported once.
    assert.equal(next.state.last, undefined);
  } finally { await stack.proxy.close(); }
});

test('two contacts never share a session', async () => {
  const stack = buildStack({ config: { enabled: true, personaSource: 'custom', customPrompt: '测试人格' } });
  const info = await stack.proxy.listen();
  try {
    const send = async (message, text) => {
      const out = await runPlugin(promptInput(message, '人设', {}, text));
      const res = await fetch(info.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + stack.token },
        body: JSON.stringify({ messages: [{ role: 'system', content: out.system }, { role: 'user', content: text }] }),
      });
      return (await res.json()).choices[0].message.content;
    };
    const a = await send(phone, '我是甲');
    const b = await send(other, '我是乙');
    assert.ok(a.includes('我是甲') && b.includes('我是乙'));
    // Distinct conversation keys mean the engine treated them separately.
    assert.equal(stack.engine.status().pending, 0);
  } finally { await stack.proxy.close(); }
});

test('a background memory job bypasses the bridge entirely', async () => {
  // Whale-Girl's background calls never run chat.prompt, so no envelope is present.
  const stack = buildStack({ config: { enabled: true, personaSource: 'whale' } });
  const info = await stack.proxy.listen();
  try {
    const res = await fetch(info.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + stack.token },
      body: JSON.stringify({ messages: [{ role: 'system', content: '抽取记忆' }, { role: 'user', content: '...' }] }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'no_upstream');
  } finally { await stack.proxy.close(); }
});
