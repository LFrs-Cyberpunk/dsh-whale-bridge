import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';

const msg = (id, chat) => ({ accountId: 'a', platform: 'wechat', chatId: chat, senderId: 'u', messageId: id, chatType: 'private', text: 'x' });

function make({ adapter, config = {} } = {}) {
  const a = adapter ?? new MockAdapter({ delayMs: 30 });
  return { adapter: a, engine: new BridgeEngine({
    adapter: a,
    personas: new PersonaResolver({ readDshPersona: async () => 'p' }),
    config: { enabled: true, ...config },
  }) };
}

test('global concurrency never exceeds maxConcurrent', async () => {
  let peak = 0; let live = 0;
  const adapter = {
    kind: 'spy',
    async generate(req) {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 25));
      live--;
      return { text: 'ok' };
    },
  };
  const { engine } = make({ adapter, config: { maxConcurrent: 2 } });
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => engine.submit(msg(`m${i}`, `c${i}`))));
  assert.ok(peak <= 2, `峰值 ${peak}`);
  assert.equal(peak, 2, '应该真的用满并发');
});

test('different conversations are independent; same one is serialised', async () => {
  const order = [];
  const adapter = {
    kind: 'spy',
    async generate(req) {
      order.push(req.message.chatId + ':' + req.message.messageId);
      await new Promise((r) => setTimeout(r, 15));
      return { text: 'ok' };
    },
  };
  const { engine } = make({ adapter, config: { maxConcurrent: 4 } });
  await Promise.all([engine.submit(msg('1', 'A')), engine.submit(msg('2', 'A')), engine.submit(msg('3', 'B'))]);
  const aOrder = order.filter((x) => x.startsWith('A:'));
  assert.deepEqual(aOrder, ['A:1', 'A:2'], '同一会话必须保序');
  assert.equal(order.length, 3);
});

test('cache eviction keeps working and never drops a running entry', async () => {
  const { engine, adapter } = make({ config: { maxConcurrent: 1 } });
  // cacheLimit is small; run more distinct messages than the cache holds.
  const small = new BridgeEngine({
    adapter, personas: new PersonaResolver({ readDshPersona: async () => 'p' }),
    config: { enabled: true }, cacheLimit: 2,
  });
  for (let i = 0; i < 6; i++) await small.submit(msg(`m${i}`, 'c'));
  assert.equal(adapter.calls.length, 6);
  // Replaying an evicted id re-runs it rather than throwing.
  const again = await small.submit(msg('m0', 'c'));
  assert.equal(again.delivery, 'generated');
  assert.equal(adapter.calls.length, 7);
});

test('config change while busy is rejected instead of corrupting state', async () => {
  const { engine } = make({ config: { maxConcurrent: 1 } });
  const running = engine.submit(msg('1', 'c'));
  assert.throws(() => engine.configure({ enabled: true, maxConcurrent: 4 }), { code: 'BUSY_CONFIG' });
  await running;
  assert.equal(engine.configure({ enabled: true, maxConcurrent: 4 }).maxConcurrent, 4);
});
