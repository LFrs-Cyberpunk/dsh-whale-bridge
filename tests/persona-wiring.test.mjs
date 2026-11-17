import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonStore, loadBridgeConfig } from '../src/settings-store.mjs';
import { createHostAdapter } from '../plugin/index.js';
import { buildStack, syncPluginConfig } from '../scripts/wire-host.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';
import { profileBlocksFromYaml } from '../src/persona-profile.mjs';

const meta = { accountId: 'test', platform: 'wechat', chatType: 'private', chatId: 'c', senderId: 'u', messageId: 'm' };
const fake = () => ({ config: { enabled: true, personaSource: 'dsh' }, configure(cfg) { this.config = cfg; }, status() { return {}; } });

test('persona save reaches disk and a fresh process loader, not just the UI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-persona-'));
  try {
    const file = join(dir, 'config.json');
    const bridge = fake();
    let notification = null;
    const host = createHostAdapter({ bridge, store: jsonStore(file), onConfigChanged: async (next) => { notification = next; } });
    await host.handle('PATCH', host.routes.config, { personaSource: 'custom', customPrompt: '自定义角色测试' });
    const cold = await loadBridgeConfig(file);
    assert.equal(cold.personaSource, 'custom');
    assert.equal(cold.customPrompt, '自定义角色测试');
    assert.equal(notification.personaSource, 'custom');
    assert.equal((await readFile(file))[0], 123);
    await assert.rejects(host.handle('PATCH', host.routes.config, { personaSource: 'invalid' }));
    assert.equal((await loadBridgeConfig(file)).personaSource, 'custom', '非法设置不能污染磁盘');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing file uses explicit source defaults, corrupt file never silently uses test persona', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-persona-'));
  try {
    const file = join(dir, 'config.json');
    assert.equal((await loadBridgeConfig(file, { enabled: true })).personaSource, 'whale');
    await writeFile(file, '{invalid');
    await assert.rejects(loadBridgeConfig(file), (e) => e.code === 'BRIDGE_CONFIG_UNREADABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all three production persona modes reach the actual proxy generation call', async () => {
  for (const source of ['dsh', 'whale', 'custom']) {
    let received;
    const adapter = { kind: 'probe', async generate(request) { received = request.persona; return { text: '收到' }; } };
    const stack = buildStack({ adapter, config: { enabled: true, personaSource: source, customPrompt: '自定义唯一角色' } });
    const info = await stack.proxy.listen();
    try {
      const response = await fetch(info.baseUrl + '/v1/chat/completions', { method: 'POST',
        headers: { authorization: 'Bearer ' + stack.token, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'system', content: encodeEnvelope(meta) + '\n鲸鲸唯一角色' }, { role: 'user', content: '你好' }] }) });
      assert.equal(response.status, 200);
      await response.json();
      assert.equal(received.source, source);
      assert.equal(received.inject, source === 'dsh' ? null : source === 'whale' ? '鲸鲸唯一角色' : '自定义唯一角色');
      assert.notEqual(received.inject, '联调自检用最小人格');
    } finally { await stack.proxy.close(); }
  }
});

test('native mode copies EVERY plugin config, keeps secrets out, and drops GUI shells', () => {
  const rows = [
    { id: 'soul-md', name: 'dsh-soul-md', config: { active: '测试卡', cards: { 测试卡: '原生人格' }, memory: { inject: true } } },
    { id: 'some-future-persona-plugin', name: 'whatever-they-write', config: { enabled: true, style: '自定义' } },
    { id: 'provider-thing', name: 'x', config: { apiKey: 'do-not-copy', token: 'do-not-copy', apiKeyEnv: 'KEEP_ME' } },
    { id: 'dsh-phone', name: 'dsh-phone', config: { foo: 1 } },
  ];
  const blocks = profileBlocksFromYaml(JSON.stringify(rows), JSON.parse, { excludeIds: ['dsh-phone'] });
  const ids = blocks.map((row) => row.id);
  // The point of this test: an unknown plugin is inherited too. Hard-coding
  // dsh-soul-md / dsh-agent-md is exactly the bug this replaced.
  assert.ok(ids.includes('some-future-persona-plugin'), '未知的人格插件也必须跟过去');
  assert.ok(!ids.includes('dsh-phone'), 'GUI 插件要排除');
  const provider = blocks.find((row) => row.id === 'provider-thing');
  assert.equal(provider.config.apiKey, undefined);
  assert.equal(provider.config.token, undefined);
  assert.equal(provider.config.apiKeyEnv, 'KEEP_ME', 'env 变量名不是秘密，必须保留');
  assert.equal(JSON.stringify(blocks).includes('do-not-copy'), false);
});

test('the overlay never guesses the model route', async () => {
  const src = await readFile(new URL('../src/persona-profile.mjs', import.meta.url), 'utf8');
  assert.match(src, /'llm-pi-ai', 'agent-default-model', 'acp'/, '模型块由设置页写，人格同步不能覆盖它');
});

test('the Whale plugin receives personaSource while unrelated config survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-persona-'));
  try {
    const data = join(dir, 'plugins', 'whale-dsh-bridge.data');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'config.json'), JSON.stringify({ enabled: false, timeoutMs: 12345 }));
    const result = await syncPluginConfig({ whaleData: dir, url: 'http://127.0.0.1:1', token: 'test-only-token', personaSource: 'whale' });
    assert.equal(result.written, true);
    const cfg = JSON.parse(await readFile(result.file));
    assert.equal(cfg.personaSource, 'whale');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.timeoutMs, 12345);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('production wire host has no hard-coded test persona and bridge cannot sync itself', async () => {
  const wire = await readFile(new URL('../scripts/wire-host.mjs', import.meta.url), 'utf8');
  const sync = await readFile(new URL('../src/profile-sync.mjs', import.meta.url), 'utf8');
  assert.equal(wire.includes("customPrompt: '联调自检用最小人格'"), false);
  assert.match(wire, /config: initialConfig/);
  // profile-sync must exclude THIS package by its real name, else the child host
  // loads the bridge inside itself and loops.
  assert.match(sync, /'dsh-whale-bridge'/);
  assert.match(sync, /personaSource === 'dsh'/);
});
