/**
 * The bridge should configure the plugin, not the user. These tests pin that:
 * it writes into the plugin's own data dir, preserves the user's own keys, and
 * does nothing when Whale-Girl is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPluginConfig } from '../scripts/wire-host.mjs';

async function fakeWhale() {
  const dir = await mkdtemp(join(tmpdir(), 'whale-data-'));
  await mkdir(join(dir, 'plugins'), { recursive: true });
  return dir;
}

const token = 'a'.repeat(48);
const url = 'http://127.0.0.1:57321';

test('it writes the address and token into the plugin data dir', async () => {
  const whale = await fakeWhale();
  try {
    const res = await syncPluginConfig({ url, token, whaleData: whale });
    assert.equal(res.written, true);
    const cfg = JSON.parse(await readFile(res.file, 'utf8'));
    assert.equal(cfg.url, url);
    assert.equal(cfg.token, token);
    assert.equal(cfg.enabled, true);
    assert.ok(res.file.includes('whale-dsh-bridge.data'), '必须写进插件自己的目录');
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('it keeps whatever the user already set', async () => {
  const whale = await fakeWhale();
  const dir = join(whale, 'plugins', 'whale-dsh-bridge.data');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ enabled: false, timeoutMs: 12345, note: '我自己的' }), 'utf8');
    await syncPluginConfig({ url, token, whaleData: whale });
    const cfg = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.enabled, false, '用户关掉了就保持关掉');
    assert.equal(cfg.timeoutMs, 12345, '用户改的超时不能被覆盖');
    assert.equal(cfg.note, '我自己的');
    assert.equal(cfg.url, url, '但地址要更新成这次实际端口');
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('a different port on restart updates the address', async () => {
  const whale = await fakeWhale();
  try {
    await syncPluginConfig({ url: 'http://127.0.0.1:11111', token, whaleData: whale });
    await syncPluginConfig({ url: 'http://127.0.0.1:22222', token, whaleData: whale });
    const cfg = JSON.parse(await readFile(join(whale, 'plugins', 'whale-dsh-bridge.data', 'config.json'), 'utf8'));
    assert.equal(cfg.url, 'http://127.0.0.1:22222', '端口变了要跟着变');
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('with no Whale install it writes nothing and says why', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'no-whale-'));
  try {
    const res = await syncPluginConfig({ url, token, whaleData: dir });
    assert.equal(res.written, false);
    assert.match(res.reason, /跳过/);
    assert.deepEqual(await readdir(dir), [], '不能凭空造目录');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
