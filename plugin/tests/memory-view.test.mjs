import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory.mjs';
import { createHostAdapter } from '../index.js';

function bridgeStub(config = {}) {
  return {
    config: { enabled: true, personaSource: 'dsh', ...config },
    configure(next) { this.config = next; },
    status() { return { enabled: !!this.config.enabled, active: 0, pending: 0, adapter: 'mock' }; },
  };
}

async function host({ memory } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whale-host-'));
  const mem = memory === undefined ? new MemoryStore({ root: dir }) : memory;
  const adapter = createHostAdapter({ bridge: bridgeStub(), diagnostics: { list: () => [] }, memory: mem });
  return { adapter, mem, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('memory view reports counts and the cost rule', async () => {
  const { adapter, mem, cleanup } = await host();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢吃辣' });
    await mem.record('chatA', { role: 'user', text: '我告诉你一个秘密' });
    const view = await adapter.handle('GET', adapter.routes.memory);
    assert.equal(view.available, true);
    assert.equal(view.stats.episodes, 2);
    assert.equal(view.stats.shareable, 1, '只有第一人称事实算可外传');
    assert.match(view.note, /回溯信号|还记得/);
  } finally { await cleanup(); }
});

test('grow endpoint only adopts first-person facts', async () => {
  const { adapter, mem, cleanup } = await host();
  try {
    await mem.record('chatA', { role: 'user', text: '我怕黑' });
    await mem.record('chatB', { role: 'user', text: '他说他很难受' });
    const res = await adapter.handle('POST', adapter.routes.grow);
    assert.equal(res.ok, true);
    assert.match(res.grown, /我怕黑/);
    assert.doesNotMatch(res.grown, /他说他/);
    assert.equal(res.memory.persona, res.grown, '成长结果要回填到视图');
  } finally { await cleanup(); }
});

test('grow endpoint degrades honestly when memory was never injected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-nomem-'));
  try {
    const adapter = createHostAdapter({ bridge: bridgeStub(), diagnostics: { list: () => [] } });
    const view = await adapter.handle('GET', adapter.routes.memory);
    assert.equal(view.available, false);
    assert.match(view.note, /未启用/);
    const grown = await adapter.handle('POST', adapter.routes.grow);
    assert.equal(grown.code, 'MEMORY_UNAVAILABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
