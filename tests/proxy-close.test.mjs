import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyServer } from '../src/proxy.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';
import { BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';

const TOKEN = 'close-test-token-0123456789abcdef';
const meta = { accountId: 'a', platform: 'wechat', chatType: 'private', chatId: 'c', senderId: 's', messageId: 'm' };

function server() {
  const engine = new BridgeEngine({
    adapter: new MockAdapter(),
    personas: new PersonaResolver({ readDshPersona: async () => 'p' }),
    config: { enabled: true, personaSource: 'dsh' },
  });
  return createProxyServer({ engine, token: TOKEN });
}

test('close() resolves even with an idle keep-alive connection open', async () => {
  const p = server();
  const info = await p.listen();
  // Leave a live keep-alive connection: a plain server.close() would wait on it.
  const res = await fetch(info.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ messages: [{ role: 'system', content: encodeEnvelope(meta) }, { role: 'user', content: 'x' }] }),
  });
  await res.json();
  const started = Date.now();
  await p.close();
  assert.ok(Date.now() - started < 2000, `关闭耗时 ${Date.now() - started}ms，疑似在等连接`);
});

test('close() is idempotent and safe before listen', async () => {
  const p = server();
  await p.close(); // never listened
  const info = await p.listen();
  await p.close();
  await p.close();
  assert.ok(!info.baseUrl.endsWith(':0'));
});
