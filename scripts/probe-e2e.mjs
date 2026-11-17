#!/usr/bin/env node
/**
 * Full isolated end-to-end probe: Whale-Girl's real request shape → bridge proxy →
 * engine → real DSH over ACP → reply back.
 *
 * Everything is throwaway and local:
 *   - fake model stub on 127.0.0.1 (no credentials, no external calls)
 *   - isolated DSH_HOME under .test-home/
 *   - the daily profile is never read or written
 *
 * The request body mirrors what src/llm/client.js actually sends: `stream: true`
 * and a system message carrying the bridge envelope.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, copyFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Socket } from 'node:net';
import { decodeEnvelope } from '../src/envelope.mjs';

const root = resolve(import.meta.dirname, '..');
const INSTALL = 'I:\\DeepSeek Harness桌面端\\DeepSeek Harness 官方端';
const DSH_CMD_DIR = join(INSTALL, 'resources', 'runtime', 'cli', 'bin');
const FAKE_LLM = join(root, 'tests', 'fixtures', 'fake-llm-server.mjs');
const FAKE_PORT = 18080;
const home = join(root, '.test-home', 'dsh');
const workdir = join(root, '.test-home', 'cwd');

const entries = [];
const add = (step, ok, detail) => entries.push({ step, ok: Boolean(ok), detail: String(detail ?? '') });
const report = () => process.stdout.write(JSON.stringify({ probe: 'e2e-isolated', entries }, null, 2) + '\n');

const portOpen = (port) => new Promise((res) => {
  const s = new Socket();
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => { s.destroy(); res(false); });
  s.connect(port, '127.0.0.1');
});

async function waitPort(port, tries = 80) {
  for (let i = 0; i < tries; i++) { if (await portOpen(port)) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}

async function main() {
  const children = [];
  try {
    // 1. stub model
    const stub = spawn(process.execPath, [FAKE_LLM, String(FAKE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(stub);
    add('本地桩模型就绪', await waitPort(FAKE_PORT), `127.0.0.1:${FAKE_PORT}`);

    // 2. isolated profile with the stub patch
    const patchPath = join(home, 'profiles', 'acp', 'cordis.patch.yml');
    if (!existsSync(patchPath)) {
      await rm(home, { recursive: true, force: true });
      await mkdir(join(home, 'profiles', 'acp'), { recursive: true });
      await copyFile(join(root, 'tests', 'fixtures', 'isolated-acp.patch.yml'), patchPath);
    }
    await mkdir(workdir, { recursive: true });
    add('隔离 profile 就绪', true, patchPath);

    // 3. bridge in acp mode, as its own process (same entry users run)
    const bridge = spawn(process.execPath, [join(root, 'scripts', 'wire-host.mjs')], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        WHALE_BRIDGE_ADAPTER: 'acp',
        WHALE_BRIDGE_DSH_HOME: home,
        WHALE_BRIDGE_DSH_LAUNCHER: DSH_CMD_DIR,
        LOCAL_FAKE_KEY: 'isolated-test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(bridge);

    let out = '';
    let err = '';
    bridge.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
    bridge.stderr.setEncoding('utf8').on('data', (c) => { err += c; });

    const ready = await (async () => {
      for (let i = 0; i < 600; i++) {
        const brace = out.indexOf('{');
        if (brace >= 0) { try { const j = JSON.parse(out.slice(brace)); if (j.listening && j.token) return j; } catch { /* partial */ } }
        if (bridge.exitCode !== null) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();
    add('桥接启动', Boolean(ready), ready ? ready.listening : (err || out).slice(-600));
    if (!ready) return 1;
    add('后端类型', ready.adapter === 'acp', `${ready.adapter} agent=${ready.acpAgent ?? '?'}`);

    // 4. replay Whale-Girl's exact request shape
    const meta = { accountId: 'wx-bot', platform: 'wechat', chatType: 'private', chatId: 'wxid_e2e', senderId: 'wxid_e2e', messageId: 'e2e-1' };
    const envelope = await (await import('../src/envelope.mjs')).encodeEnvelope(meta);
    const res = await fetch(ready.listening + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ready.token },
      body: JSON.stringify({
        model: 'dsh', stream: true,
        messages: [{ role: 'system', content: envelope + '\n你说话很短。' }, { role: 'user', content: '在吗' }],
      }),
    });
    add('代理响应', res.status === 200, `status=${res.status} type=${res.headers.get('content-type')}`);
    const raw = await res.text();

    // Parse exactly like Whale-Girl does (client.js parseSseLines + pickText).
    let text = '';
    for (const chunk of raw.split(/\r?\n\r?\n/)) {
      const line = chunk.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      try {
        const j = JSON.parse(data);
        const piece = j?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string') text += piece;
      } catch { /* skip */ }
    }
    add('回复非空', text.length > 0, `${text.length} 字`);
    add('回复来自隔离 DSH', text.includes('本地假模型'), text.slice(0, 200));
    add('信封可解', Boolean(decodeEnvelope(envelope)?.chatId), decodeEnvelope(envelope)?.chatId ?? '');

    // The reply must have been recorded into the isolated memory store.
    const memRoot = join(root, '.test-home', 'memory', 'chats');
    let recorded = 0;
    try {
      for (const d of await readdir(memRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const raw = await readFile(join(memRoot, d.name, 'episodes.jsonl'), 'utf8').catch(() => '');
        recorded += raw.split('\n').filter(Boolean).length;
      }
    } catch { /* no memory yet */ }
    add('记忆已落盘', recorded >= 2, `${recorded} 条（用户 + 回复）`);
    return 0;
  } finally {
    // cmd.exe is the launcher; killing it does NOT stop the Electron child it
    // spawned. Kill the whole tree or a stray DSH keeps the isolated home locked.
    for (const c of children) {
      if (!c.pid) continue;
      try { spawn('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ }
      try { c.kill(); } catch { /* ignore */ }
    }
    for (let i = 0; i < 30; i++) { if (!(await portOpen(FAKE_PORT))) break; await new Promise((r) => setTimeout(r, 100)); }
    report();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stdout.write(JSON.stringify({ probe: 'e2e-isolated', fatal: String(e?.stack ?? e) }, null, 2) + '\n');
  process.exit(1);
});
