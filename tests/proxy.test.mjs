import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProxyServer } from '../src/proxy.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';
import { BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';

const TOKEN = 'local-test-token-0123456789abcdef';
const meta = { accountId: 'wx-bot', platform: 'wechat', chatType: 'private', chatId: 'wxid_abc', senderId: 'wxid_me', messageId: 'm-1' };

function engine() {
  return new BridgeEngine({
    adapter: new MockAdapter({ reply: ({ message }) => `DSH回答:${message.text}` }),
    personas: new PersonaResolver({ readDshPersona: async () => 'DSH人设', readWhalePersona: async () => '鲸鲸人设' }),
    config: { enabled: true, personaSource: 'dsh' },
  });
}

async function startProxy(extra = {}) {
  const p = createProxyServer({ engine: extra.engine ?? engine(), token: TOKEN, upstream: extra.upstream });
  const info = await p.listen();
  return { p, ...info };
}

async function post(baseUrl, body, token = TOKEN) {
  const res = await fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('enveloped chat is answered by the engine', async () => {
  const { p, baseUrl } = await startProxy();
  try {
    const system = encodeEnvelope(meta) + '\n你是鲸鲸';
    const { status, json } = await post(baseUrl, { model: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: '在吗' }] });
    assert.equal(status, 200);
    assert.equal(json.choices[0].message.content, 'DSH回答:在吗');
    assert.equal(json.object, 'chat.completion');
  } finally { await p.close(); }
});

test('whale persona comes from the request system prompt', async () => {
  const e = new BridgeEngine({
    adapter: new MockAdapter(),
    personas: new PersonaResolver({ readDshPersona: async () => 'DSH人设', readWhalePersona: async () => { throw new Error('不该被调用'); } }),
    config: { enabled: true, personaSource: 'whale' },
  });
  const { p, baseUrl } = await startProxy({ engine: e });
  try {
    const system = encodeEnvelope(meta) + '\n鲸鲸自己的系统提示词';
    const { status } = await post(baseUrl, { messages: [{ role: 'system', content: system }, { role: 'user', content: 'x' }] });
    assert.equal(status, 200);
  } finally { await p.close(); }
});

test('background request without envelope passes through untouched', async () => {
  let seen = null;
  const upstream = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { seen = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'upstream-ok' } }] })); });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
  const { p, baseUrl } = await startProxy({ upstream: { url } });
  try {
    const { status, json } = await post(baseUrl, { model: 'x', messages: [{ role: 'user', content: '抽取记忆' }] });
    assert.equal(status, 200);
    assert.equal(json.choices[0].message.content, 'upstream-ok');
    assert.equal(seen.messages[0].content, '抽取记忆');
  } finally { await p.close(); await new Promise(r => upstream.close(r)); }
});

test('no envelope and no upstream fails loudly', async () => {
  const { p, baseUrl } = await startProxy();
  try {
    const { status, json } = await post(baseUrl, { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(status, 503);
    assert.equal(json.error.code, 'no_upstream');
  } finally { await p.close(); }
});

test('rejects bad token, malformed envelope and empty messages', async () => {
  const { p, baseUrl } = await startProxy();
  try {
    assert.equal((await post(baseUrl, { messages: [] }, 'wrong-token-wrong-token-0000')).status, 401);
    assert.equal((await post(baseUrl, { messages: [] }, null)).status, 401);
    const bad = await post(baseUrl, { messages: [{ role: 'system', content: '[[WHALE-BRIDGE v1]]{bad}' }, { role: 'user', content: 'x' }] });
    assert.equal(bad.json.error.code, 'bad_envelope');
    // Enveloped but no user text: rejected as a bad chat request, not passed upstream.
    const noUser = await post(baseUrl, { messages: [{ role: 'system', content: encodeEnvelope(meta) }] });
    assert.equal(noUser.status, 400);
    assert.equal(noUser.json.error.code, 'bad_messages');
  } finally { await p.close(); }
});

test('refuses to start without a token', () => {
  assert.throws(() => createProxyServer({ engine: engine(), token: 'short' }), { code: 'TOKEN_REQUIRED' });
  assert.throws(() => createProxyServer({ token: TOKEN }), { code: 'NO_ENGINE' });
});
