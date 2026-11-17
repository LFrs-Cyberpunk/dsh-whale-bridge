/**
 * Proves the shipped .flow.json is not just well-formed but *executable*: pull the
 * base64 out of the file the app would read, run it the way the app would run it,
 * and compare against the reference implementation.
 *
 * Without this, "format valid" could still mean "the plugin does nothing".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { onChatPrompt } from '../whale-plugin/reference.mjs';
import { decodeEnvelope } from '../src/envelope.mjs';
import { ID } from '../scripts/make-flow-plugin.mjs';

const dist = join(import.meta.dirname, '..', 'whale-plugin', 'dist');

/** Same executor contract as Whale-Girl: three imports, run() must return 0. */
async function run(wasm, input) {
  const bytes = Buffer.from(JSON.stringify(input));
  const out = [];
  const imports = {
    input_size: () => bytes.length,
    input_byte: (i) => (i >= 0 && i < bytes.length ? bytes[i] : -1),
    output_byte: (v) => { if (!Number.isInteger(v) || v < 0 || v > 255 || out.length >= 65536) throw new Error('output_limit'); out.push(v); },
  };
  const module = await WebAssembly.compile(wasm);
  const bad = WebAssembly.Module.imports(module).filter((imp) => imp.module !== 'whale' || !(imp.name in imports));
  if (bad.length) throw new Error('invalid_import');
  const instance = await WebAssembly.instantiate(module, { whale: imports });
  if (instance.exports.run() !== 0) throw new Error('invalid_exit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(out)));
}

const message = { platform: 'wechat', chatType: 'private', chatId: 'wxid_a', senderId: 'wxid_b' };
const input = { api: 3, hook: 'chat.prompt', message, system: '你是鲸鲸', state: {}, settings: {}, now: 1 };

test('the wasm inside the delivered .flow.json actually runs', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const output = await run(Buffer.from(flow.wasm, 'base64'), input);
  assert.equal(typeof output.system, 'string');
  const meta = decodeEnvelope(output.system);
  assert.equal(meta?.chatId, 'wxid_a', '信封里的 chatId 必须来自消息');
  assert.ok(output.system.includes('你是鲸鲸'), '原 system 必须保留');
});

test('the delivered file and the reference implementation agree', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const fromWasm = await run(Buffer.from(flow.wasm, 'base64'), input);
  const expected = onChatPrompt(input);
  assert.equal(fromWasm.system, expected.system);
  assert.deepEqual(fromWasm.state, expected.state);
});

test('a run with no identity still passes the system through untouched', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const blind = { ...input, message: { platform: 'wechat', chatType: 'private' } };
  const output = await run(Buffer.from(flow.wasm, 'base64'), blind);
  assert.equal(output.system, undefined, '没有身份就不改写 system');
  assert.equal(decodeEnvelope(blind.system ?? ''), null);
});
