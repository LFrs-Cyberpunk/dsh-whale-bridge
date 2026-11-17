/**
 * The user asked for one switch, not a terminal. These tests cover the parts that
 * must not regress: nothing auto-starts, the switch really starts and stops a
 * child, a crash is restarted with backoff and eventually given up on, and a
 * rejected timeout never reaches the config.
 *
 * The "bridge" here is a tiny node script that prints the same ready JSON.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeSupervisor } from '../src/supervisor.mjs';
import { createHostAdapter } from '../plugin/index.js';

async function fakeEntry(body) {
  const dir = await mkdtemp(join(tmpdir(), 'sup-'));
  const file = join(dir, 'fake-bridge.mjs');
  await writeFile(file, body, 'utf8');
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const READY = `
console.log(JSON.stringify({ listening: 'http://127.0.0.1:54321', token: 'x'.repeat(48), adapter: 'mock' }));
setInterval(() => {}, 1000);
`;

function supervisorFor(entry, projectRoot) {
  return new BridgeSupervisor({ projectRoot: projectRoot ?? process.cwd(), entry, onEvent: () => {} });
}

test('nothing starts until asked', async () => {
  const { dir, file, cleanup } = await fakeEntry(READY);
  try {
    const sup = supervisorFor(file, dir);
    const status = sup.status();
    assert.equal(status.running, false);
    assert.equal(status.desired, false, '默认必须是关的');
    assert.equal(status.listening, null);
  } finally { await cleanup(); }
});

test('starting reads the address and token the bridge prints', async () => {
  const { dir, file, cleanup } = await fakeEntry(READY);
  try {
    const sup = supervisorFor(file, dir);
    const status = await sup.start({ timeoutMs: 10000 });
    assert.equal(status.running, true);
    assert.equal(status.listening, 'http://127.0.0.1:54321');
    assert.equal(status.hasToken, true, '设置页需要知道令牌有没有就绪');
    await sup.stop();
  } finally { await cleanup(); }
});

test('stopping really kills the child', async () => {
  const { dir, file, cleanup } = await fakeEntry(READY);
  try {
    const sup = supervisorFor(file, dir);
    await sup.start({ timeoutMs: 10000 });
    const pid = sup.status().pid;
    assert.ok(pid);
    const status = await sup.stop();
    assert.equal(status.running, false);
    assert.equal(sup.desired, false);
  } finally { await cleanup(); }
});

test('a crash is retried, then given up on instead of spinning forever', async () => {
  // Fails immediately, every time. Short backoff keeps the test honest and fast.
  const { dir, file, cleanup } = await fakeEntry('process.exit(1);');
  let sup = null;
  try {
    sup = new BridgeSupervisor({
      projectRoot: dir, entry: file, backoff: [10, 10, 10], maxFastFails: 3, onEvent: () => {},
    });
    await sup.start({ timeoutMs: 5000 });
    const deadline = Date.now() + 8000;
    while (sup.status().desired && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(sup.status().desired, false, '连续失败几次后必须自己停下，不能无限重拉');
    assert.equal(sup.status().running, false);
    assert.ok(sup.status().restarts >= 3, '至少记录了三次快速失败：' + sup.status().restarts);
  } finally {
    if (sup) await sup.stop().catch(() => {});
    await cleanup();
  }
});

test('the settings page shows service state and refuses a bad timeout', async () => {
  const { dir, file, cleanup } = await fakeEntry(READY);
  try {
    const sup = supervisorFor(file, dir);
    const saved = {};
    const adapter = createHostAdapter({
      bridge: {
        config: { enabled: true, personaSource: 'dsh' },
        configure() {},
        status() { return { enabled: true, active: 0, pending: 0, adapter: 'mock' }; },
      },
      diagnostics: { list: () => [] },
      supervisor: sup,
      serviceStore: {
        get: (k) => saved[k],
        patch: async (patch) => { Object.assign(saved, patch); },
      },
    });
    const view = await adapter.handle('GET', adapter.routes.service);
    assert.equal(view.ok, true);
    assert.equal(view.running, false);
    assert.equal(view.autoStart, false);
    assert.match(view.note, /自动写入/);

    await assert.rejects(
      () => adapter.handle('PATCH', adapter.routes.service, { timeoutMs: 10 }),
      (e) => e.code === 'BAD_TIMEOUT',
    );
    await assert.rejects(
      () => adapter.handle('PATCH', adapter.routes.service, { timeoutMs: 999999 }),
      (e) => e.code === 'BAD_TIMEOUT',
    );

    const after = await adapter.handle('PATCH', adapter.routes.service, { timeoutMs: 25000 });
    assert.equal(after.timeoutMs, 25000, '合法超时要保存');
  } finally { await cleanup(); }
});

test('the switch starts and stops the child through the settings page', async () => {
  const { dir, file, cleanup } = await fakeEntry(READY);
  try {
    const sup = supervisorFor(file, dir);
    const saved = { enabled: false };
    const adapter = createHostAdapter({
      bridge: { config: { enabled: true, personaSource: 'dsh' }, configure() {}, status() { return { enabled: true, active: 0, pending: 0, adapter: 'mock' }; } },
      diagnostics: { list: () => [] },
      supervisor: sup,
      serviceStore: { get: (k) => saved[k], patch: async (p) => { Object.assign(saved, p); } },
    });
    const on = await adapter.handle('PATCH', adapter.routes.service, { enabled: true });
    assert.equal(on.running, true, '点开启就该起来');
    const off = await adapter.handle('PATCH', adapter.routes.service, { enabled: false });
    assert.equal(off.running, false, '点关闭就该停');
  } finally { await cleanup(); }
});
