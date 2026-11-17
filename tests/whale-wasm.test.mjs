import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onChatPrompt } from '../whale-plugin/reference.mjs';
import { decodeEnvelope } from '../src/envelope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', 'whale-plugin', 'dist', 'plugin.wasm');

/**
 * Runs the wasm exactly the way Whale-Girl does (src/services/messagePlugins.js 24-50):
 * a fresh instance, only the three whale.* imports, run() must return 0, output is
 * UTF-8 JSON collected byte by byte.
 */
async function runPlugin(wasm, input) {
  const bytes = Buffer.from(JSON.stringify(input));
  const output = [];
  const imports = {
    input_size: () => bytes.length,
    input_byte: (i) => (i >= 0 && i < bytes.length ? bytes[i] : -1),
    output_byte: (v) => {
      if (!Number.isInteger(v) || v < 0 || v > 255 || output.length >= 65536) throw new Error('output_limit');
      output.push(v);
    },
  };
  const module = await WebAssembly.compile(wasm);
  // Whale-Girl rejects any import outside whale/{input_size,input_byte,output_byte}.
  const bad = WebAssembly.Module.imports(module).filter((imp) => imp.module !== 'whale' || imp.kind !== 'function' || !(imp.name in imports));
  if (bad.length) throw new Error('invalid_import: ' + JSON.stringify(bad));
  const instance = await WebAssembly.instantiate(module, { whale: imports });
  if (instance.exports.run() !== 0) throw new Error('invalid_exit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(output)));
}

const wasm = await readFile(WASM);
const message = { platform: 'wechat', chatType: 'private', chatId: 'wxid_a', senderId: 'wxid_b' };
const base = { api: 3, hook: 'chat.prompt', message, system: '你是鲸鲸', state: {}, settings: {}, now: 1 };

test('wasm only imports whale.{input_size,input_byte,output_byte}', async () => {
  const module = await WebAssembly.compile(wasm);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}:${i.kind}`);
  assert.deepEqual(imports.sort(), ['whale.input_byte:function', 'whale.input_size:function', 'whale.output_byte:function']);
});

test('wasm produces the same envelope as the reference implementation', async () => {
  const expected = onChatPrompt(base);
  const actual = await runPlugin(wasm, base);
  assert.deepEqual(actual, expected);
  assert.equal(decodeEnvelope(actual.system).chatId, 'wxid_a');
  assert.equal(decodeEnvelope(actual.system).messageId, 's0');
});

test('wasm matches reference on every edge case', async () => {
  const cases = [
    { ...base, hook: 'chat.reply' },
    { ...base, message: { ...message, chatType: 'group' } },
    { ...base, message: { ...message, chatId: '' } },
    { ...base, message: { ...message, senderId: 'bad id with space' } },
    { ...base, message: { ...message, chatId: 'a\\"b' } },
    { ...base, system: '长'.repeat(20000) },
    { ...base, system: '引号"反斜杠\\换行\n结束' },
    { ...base, system: '' },
    { ...base, state: { seq: 41 } },
    { ...base, state: {} },
    { ...base, message: { ...message, chatId: 'wechat:123@open.im' } },
  ];
  for (const input of cases) {
    assert.deepEqual(await runPlugin(wasm, input), onChatPrompt(input), JSON.stringify(input).slice(0, 120));
  }
});

test('wasm keeps the system prompt within the host limit', async () => {
  // 15800 CJK chars ≈ 47 KB of JSON: under Whale-Girl's 64 KiB input cap, above the 16000-char system cap.
  const out = await runPlugin(wasm, { ...base, system: '长'.repeat(15800) });
  assert.ok(out.system.length <= 16000, String(out.system.length));
});

test('wasm stays a pass when the hook carries no identity', async () => {
  const out = await runPlugin(wasm, { ...base, message: { platform: 'wechat' } });
  assert.equal(out.system, undefined);
});
