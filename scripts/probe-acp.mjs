#!/usr/bin/env node
/**
 * Probe one isolated DSH ACP host. NEVER touches the daily profile.
 *
 * What it does:
 *   1. starts a local OpenAI-compatible stub on 127.0.0.1 (no credentials, no
 *      external calls) and points the isolated profile at it
 *   2. builds a throwaway DSH_HOME / DSH_AGENTS_HOME under .test-home/
 *   3. spawns `dsh.cmd --profile acp` (the launcher resolves the asar-embedded CLI)
 *   4. performs the ACP handshake, opens one session, sends one prompt
 *   5. prints a JSON report, then kills every child it started
 *
 * A credential failure is a valid, reportable outcome — but it must never be
 * reported as success.
 */
import { mkdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { AcpClient } from '../src/adapters/acp.mjs';

const root = resolve(import.meta.dirname, '..');
const INSTALL = 'I:\\DeepSeek Harness桌面端\\DeepSeek Harness 官方端';
// The CLI entry lives INSIDE app.asar, which plain Node cannot stat. Only the
// launcher can resolve it, because Electron understands asar paths.
const DSH_CMD = join(INSTALL, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const FAKE_LLM = join(root, 'tests', 'fixtures', 'fake-llm-server.mjs');
const FAKE_PORT = 18080;

const home = join(root, '.test-home', 'dsh');
const agentsHome = join(root, '.test-home', 'agents');
const workdir = join(root, '.test-home', 'cwd');

function report(entries) { process.stdout.write(JSON.stringify({ probe: 'acp-isolated', entries }, null, 2) + '\n'); }

function portOpen(port) {
  return new Promise((res) => {
    const sock = new Socket();
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('error', () => { sock.destroy(); res(false); });
    sock.connect(port, '127.0.0.1');
  });
}

async function waitPort(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  const entries = [];
  const add = (step, ok, detail) => entries.push({ step, ok: Boolean(ok), detail: String(detail ?? '') });
  let stub = null;
  let client = null;

  try {
    add('启动器存在', existsSync(DSH_CMD), DSH_CMD);
    if (!existsSync(DSH_CMD)) return 1;

    // Local stub model: proves the transport without any real credential.
    stub = spawn(process.execPath, [FAKE_LLM, String(FAKE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stubOk = await waitPort(FAKE_PORT);
    add('本地桩模型就绪', stubOk, `127.0.0.1:${FAKE_PORT}`);
    if (!stubOk) return 1;

    // Fresh home by default, but never delete a profile patch we placed on
    // purpose (that patch is how the isolated host reaches the stub model).
    const patchPath = join(home, 'profiles', 'acp', 'cordis.patch.yml');
    if (existsSync(patchPath)) {
      await rm(join(home, 'sessions'), { recursive: true, force: true });
      await rm(join(home, 'storages'), { recursive: true, force: true });
      add('保留已准备好的隔离 profile', true, patchPath);
    } else {
      await rm(home, { recursive: true, force: true });
    }
    await rm(agentsHome, { recursive: true, force: true });
    for (const dir of [home, agentsHome, workdir]) await mkdir(dir, { recursive: true });
    add('隔离目录已建', true, home);

    // First run: create the profile and drop our patch template into it.
    if (!existsSync(patchPath)) {
      await mkdir(join(home, 'profiles', 'acp'), { recursive: true });
      await copyFile(join(root, 'tests', 'fixtures', 'isolated-acp.patch.yml'), patchPath);
      add('写入隔离 profile 补丁', true, patchPath);
    }

    client = new AcpClient({
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/c', DSH_CMD, '--profile', 'acp'],
      cwd: workdir,
      // LOCAL_FAKE_KEY is a throwaway value for the stub provider; it never
      // reaches a real service because baseURL is 127.0.0.1.
      env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, LOCAL_FAKE_KEY: 'isolated-test-only' },
      requestTimeoutMs: 90000,
    });

    try {
      await client.start();
      add('ACP 握手', client.protocolVersion === 1, `agent=${client.agentInfo?.name ?? '?'} v=${client.agentInfo?.version ?? '?'}`);
    } catch (error) {
      add('ACP 握手', false, error.code || error.message);
      add('stderr', false, (client.lastStderr || '').slice(-800));
      return 1;
    }

    let sessionId = null;
    try {
      sessionId = await client.newSession({ cwd: workdir });
      add('建立会话', true, sessionId);
    } catch (error) {
      add('建立会话', false, `${error.code || error.message}: ${String(error.message).slice(0, 200)}`);
      add('stderr', false, (client.lastStderr || '').slice(-800));
      return 1;
    }

    try {
      const result = await client.prompt({ sessionId, text: '用一句话回答：你是什么模型？' });
      add('回合完成', true, `stopReason=${result.stopReason} chars=${result.text.length}`);
      add('回复文本', true, result.text.slice(0, 300));
    } catch (error) {
      // Expected without credentials: transport proven, model unreachable.
      add('回合完成', false, `${error.code || error.message}: ${String(error.message).slice(0, 200)}`);
      add('stderr', false, (client.lastStderr || '').slice(-800));
    }

    add('工具调用次数', true, String(client.toolCalls));
    add('思考片段数', true, String(client.thoughts));
    return 0;
  } finally {
    if (client) {
      await client.close().catch(() => {});
      // The client kills cmd.exe, but the Electron child it launched can survive.
      // Kill the tree so no stray DSH keeps the isolated home locked.
      if (client.childPid) {
        try { spawn('taskkill', ['/F', '/T', '/PID', String(client.childPid)], { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ }
      }
    }
    if (stub && !stub.killed) stub.kill();
    // Give the stub a moment to release the port before reporting.
    for (let i = 0; i < 20; i++) { if (!(await portOpen(FAKE_PORT))) break; await new Promise((r) => setTimeout(r, 100)); }
    report(entries);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stdout.write(JSON.stringify({ probe: 'acp-isolated', fatal: String(error?.stack ?? error) }, null, 2) + '\n');
    process.exit(1);
  });
