import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';

/**
 * Whale-Girl retries a failed request with the SAME message id (her client re-sends
 * after a timeout). If the bridge cached the rejection, every retry would fail
 * forever until the cache entry expired — the user would see a dead chat.
 */
const msg = (id = 'm1', text = 'x') => ({ accountId: 'a', platform: 'wechat', chatId: 'c1', senderId: 'u', messageId: id, chatType: 'private', text });

function engineWith(adapter, config = {}) {
  return new BridgeEngine({
    adapter,
    personas: new PersonaResolver({ readDshPersona: async () => 'p' }),
    config: { enabled: true, ...config },
  });
}

test('a failed turn can be retried with the same message id', async () => {
  let attempts = 0;
  const adapter = {
    kind: 'flaky',
    async generate() {
      attempts++;
      if (attempts === 1) { const e = new Error('upstream'); e.code = 'UPSTREAM_DOWN'; e.status = 503; throw e; }
      return { text: '第二次成功' };
    },
  };
  const engine = engineWith(adapter);
  await assert.rejects(engine.submit(msg()), { code: 'UPSTREAM_DOWN' });
  const retry = await engine.submit(msg());
  assert.equal(retry.text, '第二次成功');
  assert.equal(attempts, 2);
});

test('a successful turn is still deduplicated, not re-run', async () => {
  const adapter = new MockAdapter();
  const engine = engineWith(adapter);
  const a = await engine.submit(msg());
  const b = await engine.submit(msg());
  assert.deepEqual(a, b);
  assert.equal(adapter.calls.length, 1);
});

test('cache does not grow on failures', async () => {
  let attempts = 0;
  const adapter = { kind: 'always-fails', async generate() { attempts++; throw Object.assign(new Error('x'), { code: 'BOOM', status: 502 }); } };
  const engine = engineWith(adapter);
  for (let i = 0; i < 5; i++) await assert.rejects(engine.submit(msg()), { code: 'BOOM' });
  assert.equal(attempts, 5, '每次都应真的重试');
  assert.equal(engine.status().pending, 0);
});

test('timeouts are retryable too', async () => {
  let attempts = 0;
  const adapter = {
    kind: 'slow-once',
    async generate(req) {
      attempts++;
      if (attempts === 1) await new Promise((r) => setTimeout(r, 200));
      req.signal.throwIfAborted();
      return { text: 'ok' };
    },
  };
  const engine = engineWith(adapter, { timeoutMs: 50 });
  await assert.rejects(engine.submit(msg()), { code: 'TURN_TIMEOUT' });
  assert.equal((await engine.submit(msg())).text, 'ok');
});
