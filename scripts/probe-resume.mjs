#!/usr/bin/env node
/**
 * Does a restarted bridge get its conversation back?
 *
 * The user's complaint is that every new conversation starts blank. Two things
 * have to be true for the fix to work:
 *   1. `session/resume` accepts an id we kept from a previous run
 *   2. the resumed session still carries its history
 *
 * This probe proves both, against an isolated host, without touching the daily DSH.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Socket } from 'node:net';
import { AcpClient } from '../src/adapters/acp.mjs';

const root = resolve(import.meta.dirname, '..');
const INSTALL = 'I:\\DeepSeek Harness桌面端\\DeepSeek Harness 官方端';
const DSH_CMD = join(INSTALL, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const FAKE_LLM = join(root, 'tests', 'fixtures', 'fake-llm-server.mjs');
const FAKE_PORT = 18080;
const home = join(root, '.test-home', 'dsh');
const workdir = join(root, '.test-home', 'cwd');
const idFile = join(root, '.test-home', 'resume-id.txt');

const entries = [];
const add = (step, ok, detail) => entries.push({ step, ok: Boolean(ok), detail: String(detail ?? '') });
const report = () => process.stdout.write(JSON.stringify({ probe: 'acp-resume', entries }, null, 2) + '\n');

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

function client() {
  return new AcpClient({
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/c', DSH_CMD, '--profile', 'acp'],
    cwd: workdir,
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: home + '-agents', LOCAL_FAKE_KEY: 'isolated-test-only' },
    requestTimeoutMs: 90000,
  });
}

async function main() {
  const children = [];
  let c = null;
  try {
    const stub = spawn(process.execPath, [FAKE_LLM, String(FAKE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(stub);
    add('本地桩模型就绪', await waitPort(FAKE_PORT), `127.0.0.1:${FAKE_PORT}`);

    const patchPath = join(home, 'profiles', 'acp', 'cordis.patch.yml');
    if (!existsSync(patchPath)) {
      await rm(home, { recursive: true, force: true });
      await mkdir(join(home, 'profiles', 'acp'), { recursive: true });
      await copyFile(join(root, 'tests', 'fixtures', 'isolated-acp.patch.yml'), patchPath);
    }
    await mkdir(workdir, { recursive: true });

    // --- first run: talk, remember the id, then shut the host down entirely ---
    c = await client().start();
    const sid = await c.newSession({ cwd: workdir });
    add('第一次会话建立', Boolean(sid), String(sid).slice(0, 12) + '…');
    const first = await c.prompt({ sessionId: sid, text: '我养了一只猫，叫团子。你只要回答"记住了"。' });
    add('第一次回合完成', first.stopReason === 'end_turn', `chars=${first.text.length}`);
    const listed = await c.listSessions({ cwd: workdir, raw: true });
    add('session/list 可用', Boolean(listed), JSON.stringify(listed).slice(0, 400));
    await writeFile(idFile, sid, 'utf8');
    await c.close(); c = null;

    // --- second run: a completely new process, same DSH_HOME ---
    c = await client().start();
    const kept = await readFile(idFile, 'utf8');
    // Try the plausible parameter shapes; the host tells us which one it accepts.
    const shapes = [
      ['sessionId+cwd+mcpServers', { sessionId: kept, cwd: workdir, mcpServers: [] }],
      ['sessionId+cwd', { sessionId: kept, cwd: workdir }],
      ['sessionId only', { sessionId: kept }],
      ['session_id', { session_id: kept }],
    ];
    let resumed = null;
    for (const [label, params] of shapes) {
      const fn = c.resumeSession.bind(c);
      const got = await fn({ ...params }).catch(() => null);
      if (got) { resumed = got; add('resume 参数形状', true, label); break; }
      add('resume 尝试失败', false, label + ' → ' + (c.lastResumeError || '无错误信息'));
    }
    add('session/resume 接受旧 id', Boolean(resumed), resumed ? String(resumed).slice(0, 12) + '…' : '全部形状都失败');

    if (resumed) {
      const second = await c.prompt({ sessionId: resumed, text: '我的猫叫什么？只回答名字。' });
      add('接回后仍有上下文', /团子/.test(second.text), second.text.slice(0, 60));
    } else {
      add('接回后仍有上下文', false, 'resume 不可用，只能靠记忆兜底');
    }
    return 0;
  } finally {
    if (c) {
      await c.close().catch(() => {});
      if (c.childPid) { try { spawn('taskkill', ['/F', '/T', '/PID', String(c.childPid)], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ } }
    }
    for (const ch of children) { if (!ch.pid) continue; try { spawn('taskkill', ['/F', '/T', '/PID', String(ch.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ } try { ch.kill(); } catch { /* ignore */ } }
    for (let i = 0; i < 30; i++) { if (!(await portOpen(FAKE_PORT))) break; await new Promise((r) => setTimeout(r, 100)); }
    report();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stdout.write(JSON.stringify({ probe: 'acp-resume', fatal: String(e?.stack ?? e) }, null, 2) + '\n');
  process.exit(1);
});
