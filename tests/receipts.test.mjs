import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onHook } from '../whale-plugin/reference.mjs';
import { decodeEnvelope, deliveryState } from '../src/envelope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wasm = await readFile(join(here, '..', 'whale-plugin', 'dist', 'plugin.wasm'));

async function run(input) {
  const bytes = Buffer.from(JSON.stringify(input));
  const out = [];
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm), {
    whale: {
      input_size: () => bytes.length,
      input_byte: (i) => (i >= 0 && i < bytes.length ? bytes[i] : -1),
      output_byte: (v) => { out.push(v); },
    },
  });
  assert.equal(instance.exports.run(), 0);
  return JSON.parse(Buffer.from(out).toString('utf8'));
}

const message = { platform: 'wechat', chatType: 'private', chatId: 'wxid_a', senderId: 'wxid_b' };
const base = { api: 3, hook: 'chat.prompt', message, system: '你是鲸鲸', state: {}, settings: {}, now: 1 };

test('dispatched records the transport result for the next turn', async () => {
  const input = { ...base, hook: 'chat.dispatched', state: { seq: 3 }, delivery: { ok: true, local: true, dryRun: false } };
  const out = await run(input);
  assert.deepEqual(out, { state: { seq: 3, last: { messageId: 's2', ok: true, local: true, dryRun: false } } });
  assert.deepEqual(out, onHook(input));
});

test('the next prompt carries the receipt in the envelope', async () => {
  const input = { ...base, state: { seq: 3, last: { messageId: 's2', ok: true, local: true } } };
  const out = await run(input);
  assert.deepEqual(out, onHook(input));
  const meta = decodeEnvelope(out.system);
  assert.deepEqual(meta.lastDelivery, { messageId: 's2', ok: true, local: true });
  assert.equal(meta.messageId, 's3');
  // Consumed: state has no `last` afterwards.
  assert.deepEqual(out.state, { seq: 4 });
});

test('a failed send is reported as failed, not as delivered', async () => {
  const dispatched = await run({ ...base, hook: 'chat.dispatched', state: { seq: 1 }, delivery: { ok: false } });
  const prompt = await run({ ...base, state: dispatched.state });
  const meta = decodeEnvelope(prompt.system);
  assert.equal(meta.lastDelivery.ok, false);
  assert.equal(deliveryState(meta.lastDelivery), 'failed');
});

test('local handoff is not treated as delivery', () => {
  assert.equal(deliveryState({ messageId: 's1', ok: true, local: true }), 'submitted_local');
  assert.equal(deliveryState({ messageId: 's1', ok: true, dryRun: true }), 'dry_run');
  assert.equal(deliveryState({ messageId: 's1', ok: true }), 'submitted');
  assert.equal(deliveryState(null), null);
});

test('dispatched with no delivery or no seq changes nothing', async () => {
  assert.deepEqual(await run({ ...base, hook: 'chat.dispatched', state: { seq: 0 }, delivery: { ok: true } }), { state: { seq: 0 } });
  assert.deepEqual(await run({ ...base, hook: 'chat.dispatched', state: { seq: 5 } }), { state: { seq: 5 } });
  assert.deepEqual(await run({ ...base, hook: 'chat.dispatched', state: { seq: 5 }, delivery: {} }), { state: { seq: 5 } });
});

test('a malformed stored receipt is dropped instead of poisoning the envelope', async () => {
  const input = { ...base, state: { seq: 2, last: { messageId: 'bad id!', ok: true } } };
  const out = await run(input);
  assert.equal(decodeEnvelope(out.system).lastDelivery, undefined);
  assert.deepEqual(out, onHook(input));
});

test('wasm and reference agree across receipt edge cases', async () => {
  const cases = [
    { ...base, state: { seq: 1, last: { messageId: 's0' } } },
    { ...base, state: { seq: 1, last: { messageId: 's0', dryRun: true } } },
    { ...base, state: { seq: 1, last: { messageId: 's0', ok: false, local: false, dryRun: false } } },
    { ...base, hook: 'chat.dispatched', state: { seq: 9 }, delivery: { dryRun: true } },
    { ...base, hook: 'chat.dispatched', state: { seq: 9 }, delivery: { ok: false, local: true } },
  ];
  for (const input of cases) assert.deepEqual(await run(input), onHook(input), JSON.stringify(input).slice(0, 100));
});
