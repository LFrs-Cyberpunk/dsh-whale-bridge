/**
 * "Why does the context reset every time?" — because a restarted bridge forgets
 * which DSH session belonged to which conversation. These tests pin the fix:
 * the id survives on disk, and a reloaded backend reattaches instead of starting
 * a blank session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AcpClient } from '../src/adapters/acp.mjs';
import { AcpBackend } from '../src/adapters/acp-backend.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fixtures', 'fake-acp-server.mjs');
const node = process.execPath;

const msg = (text, chat = 'c1') => ({ accountId: 'a', platform: 'wechat', chatId: chat, senderId: 'u', messageId: 'm1', chatType: 'private', text });
const persona = { source: 'custom', mode: 'inject', inject: '你说话很短。', revision: 'r1' };
const policy = { toolAllowlist: [] };

async function client() {
  return new AcpClient({ command: node, args: [fake], cwd: here, env: process.env, requestTimeoutMs: 5000 }).start();
}

test('the session id survives a restart and is resumed, not recreated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-state-'));
  const statePath = join(dir, 'sessions.json');
  const c1 = await client();
  try {
    const first = new AcpBackend({ client: c1, workspaceRoot: here, statePath });
    await first.generate({ sessionKey: 'conv-1', message: msg('在吗'), persona, policy });
    const savedId = first.backends.get('conv-1').sessionId;
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(raw.sessions['conv-1'].sessionId, savedId, '会话 id 必须落盘');

    // A brand-new backend = a restarted bridge.
    const second = new AcpBackend({ client: c1, workspaceRoot: here, statePath });
    await second.load();
    assert.equal(second.backends.get('conv-1').sessionId, savedId, '重启后应记得同一个会话');
    assert.equal(second.backends.get('conv-1').attached, false, '重启后尚未接回');

    await second.generate({ sessionKey: 'conv-1', message: msg('我回来了'), persona, policy });
    assert.equal(second.lastResume?.ok, true, '先尝试接回');
    assert.equal(second.backends.get('conv-1').sessionId, savedId, '接回成功就不能换新会话');
  } finally { await c1.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a conversation the host forgot falls back to a fresh session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-state2-'));
  const statePath = join(dir, 'sessions.json');
  // A stale id that no host remembers.
  await writeFile(statePath, JSON.stringify({ sessions: { 'conv-x': { sessionId: 'gone-forever' } } }), 'utf8');
  const c = await client();
  try {
    const backend = new AcpBackend({ client: c, workspaceRoot: here, statePath });
    await backend.generate({ sessionKey: 'conv-x', message: msg('还在吗'), persona, policy });
    assert.equal(backend.lastResume?.ok, false, '接不回来要如实记录');
    assert.notEqual(backend.backends.get('conv-x').sessionId, 'gone-forever', '接不回就换新会话，不能拿死 id 死磕');
  } finally { await c.close(); await rm(dir, { recursive: true, force: true }); }
});

test('no state path means no file, and everything still works', async () => {
  const c = await client();
  try {
    const backend = new AcpBackend({ client: c, workspaceRoot: here });
    await backend.generate({ sessionKey: 'conv-2', message: msg('在吗'), persona, policy });
    assert.ok(backend.backends.get('conv-2').sessionId);
  } finally { await c.close(); }
});

test('a corrupt state file is ignored instead of breaking the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-state3-'));
  const statePath = join(dir, 'sessions.json');
  await writeFile(statePath, '{ not json', 'utf8');
  const c = await client();
  try {
    const backend = new AcpBackend({ client: c, workspaceRoot: here, statePath });
    await backend.generate({ sessionKey: 'conv-3', message: msg('在吗'), persona, policy });
    assert.ok(backend.backends.get('conv-3').sessionId, '坏文件只当没存过');
  } finally { await c.close(); await rm(dir, { recursive: true, force: true }); }
});
