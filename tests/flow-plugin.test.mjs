/**
 * The deliverable format, checked against the rules Whale-Girl actually applies.
 *
 * Context: the app scans `<dataDir>/plugins` for `<id>.flow.json` +
 * `<id>.flow-grant.json` (messagePlugins.js:121-136). A ZIP is not read by the
 * runtime at all. These tests pin that shape so a future edit cannot quietly
 * ship something the app would skip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildFlow, grantHash, validateFlow, ID, HOOKS, PERMISSIONS } from '../scripts/make-flow-plugin.mjs';

const dist = join(import.meta.dirname, '..', 'whale-plugin', 'dist');

test('the emitted flow and grant load cleanly by the runtime rules', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const grant = JSON.parse(await readFile(join(dist, `${ID}.flow-grant.json`), 'utf8'));
  assert.deepEqual(validateFlow(flow, grant), []);
  assert.equal(flow.id, ID);
  assert.equal(flow.api, 3);
});

test('the wasm field round-trips to the exact bytes we built', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const wasm = await readFile(join(dist, 'plugin.wasm'));
  assert.deepEqual(Buffer.from(flow.wasm, 'base64'), wasm);
  assert.equal(flow.wasm.length, wasm.toString('base64').length);
  assert.ok(flow.wasm.length <= 700000, '不得超过运行时上限');
});

test('the grant hash is derived from the same serialization the runtime rebuilds', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const grant = JSON.parse(await readFile(join(dist, `${ID}.flow-grant.json`), 'utf8'));
  assert.equal(grant.hash, grantHash(flow));
  assert.equal(grant.enabled, true);
});

test('a tampered flow no longer matches its grant', async () => {
  const flow = JSON.parse(await readFile(join(dist, `${ID}.flow.json`), 'utf8'));
  const grant = JSON.parse(await readFile(join(dist, `${ID}.flow-grant.json`), 'utf8'));
  const tampered = { ...flow, hooks: [...flow.hooks, 'chat.reply'] };
  assert.ok(validateFlow(tampered, grant).some((p) => p.includes('hash')), '改内容必须让授权失效');
});

test('we declare only the permissions we actually need', () => {
  assert.deepEqual([...PERMISSIONS], ['model.prompt']);
  const flow = buildFlow('AAAA');
  assert.deepEqual(validateFlow(flow, { hash: grantHash(flow), enabled: true }), []);
  assert.deepEqual([...HOOKS], ['chat.prompt', 'chat.dispatched']);
});

test('the validator rejects the mistakes that would silently disable the plugin', () => {
  const base = buildFlow('AAAA');
  const good = { hash: grantHash(base), enabled: true };
  assert.ok(validateFlow({ ...base, id: 'Bad_ID' }, good).length > 0, 'id 大小写错误');
  assert.ok(validateFlow({ ...base, api: 4 }, good).length > 0, 'api 版本错误');
  assert.ok(validateFlow({ ...base, hooks: [] }, good).length > 0, '空 hooks');
  assert.ok(validateFlow({ ...base, hooks: ['chat.prompt', 'chat.prompt'] }, good).length > 0, '重复钩子');
  assert.ok(validateFlow({ ...base, hooks: ['chat.unknown'] }, good).length > 0, '未知钩子');
  assert.ok(validateFlow({ ...base, permissions: ['system.full'] }, good).length > 0, 'WASM 不允许 system.full');
  assert.ok(validateFlow(base, { hash: 'x', enabled: true }).length > 0, 'hash 不匹配');
  assert.ok(validateFlow(base, { hash: grantHash(base), enabled: false }).length > 0, '未启用');
});
