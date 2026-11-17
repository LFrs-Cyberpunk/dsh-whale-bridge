import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter, apply, inject, name } from '../index.js';

function fakeBridge(initial = { enabled: false, personaSource: 'dsh' }) {
  const bridge = {
    config: { ...initial },
    configure(next) { this.config = { ...next }; this.calls = (this.calls || 0) + 1; },
    status() { return { enabled: !!this.config.enabled, personaSource: this.config.personaSource, active: 0, pending: 0, adapter: 'mock' }; },
  };
  return bridge;
}

test('host half is inert on load', async () => {
  assert.equal(name, 'whale-bridge-settings');
  assert.deepEqual(inject, []);
  assert.equal(apply(), undefined); // no boot side effect
});

test('requires a bridge with configure/status', () => {
  assert.throws(() => createHostAdapter({}), /bridge/);
  assert.throws(() => createHostAdapter({ bridge: { configure() {} } }), /bridge/);
});

test('reads config and status', async () => {
  const host = createHostAdapter({ bridge: fakeBridge(), diagnostics: { list: () => [] } });
  assert.equal((await host.handle('GET', host.routes.status)).status.adapter, 'mock');
  const cfg = await host.handle('GET', host.routes.config);
  assert.equal(cfg.ok, true);
  assert.equal(cfg.config.enabled, false);
});

test('patches only known fields', async () => {
  const mock = fakeBridge();
  const host = createHostAdapter({ bridge: mock, diagnostics: { list: () => [] } });
  const res = await host.handle('PATCH', host.routes.config, { personaSource: 'whale' });
  assert.equal(res.config.personaSource, 'whale');
  assert.equal(mock.calls, 1);
  await assert.rejects(host.handle('PATCH', host.routes.config, { nope: 1 }), /未知字段/);
});

test('failed save never mutates the live config', async () => {
  const mock = fakeBridge();
  const host = createHostAdapter({
    bridge: mock, diagnostics: { list: () => [] },
    store: { save: async () => { throw new Error('disk full'); } },
  });
  await assert.rejects(host.handle('PATCH', host.routes.config, { enabled: true }), /disk full/);
  assert.equal(mock.config.enabled, false);
  assert.equal(mock.calls ?? 0, 0);
});

test('unknown route and disabled selfcheck report codes', async () => {
  const host = createHostAdapter({ bridge: fakeBridge(), diagnostics: { list: () => [] } });
  await assert.rejects(host.handle('GET', '/nope'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  const sc = await host.handle('POST', host.routes.selfcheck);
  assert.equal(sc.code, 'SELFCHECK_UNAVAILABLE');
});
