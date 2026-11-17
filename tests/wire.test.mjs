import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStack } from '../scripts/wire-host.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';

const meta = { accountId: 'wx', platform: 'wechat', chatType: 'private', chatId: 'c-1', senderId: 's-1', messageId: 'm-1' };

test('stack composes engine + proxy + settings host without touching real software', async () => {
  const stack = buildStack({ config: { enabled: true, personaSource: 'custom', customPrompt: '测试人格' } });
  const info = await stack.proxy.listen();
  try {
    const res = await fetch(info.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + stack.token },
      body: JSON.stringify({ messages: [{ role: 'system', content: encodeEnvelope(meta) + '\n人设' }, { role: 'user', content: '你好' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.choices[0].message.content, /你好/);

    const status = await stack.host.handle('GET', stack.host.routes.status);
    assert.equal(status.status.adapter, 'mock');

    const patched = await stack.host.handle('PATCH', stack.host.routes.config, { personaSource: 'custom', customPrompt: '换一份' });
    assert.equal(patched.config.personaSource, 'custom');
  } finally { await stack.proxy.close(); }
});
