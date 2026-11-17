import test from 'node:test';
import assert from 'node:assert/strict';
import { runSelfcheck } from '../scripts/selfcheck-core.mjs';
import { buildStack } from '../scripts/wire-host.mjs';

test('the self-check is real, local and complete', async () => {
  const report = await runSelfcheck();
  assert.equal(report.ok, true, report.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
  assert.equal(report.mockOnly, true);
  assert.ok(report.checks.length >= 15, String(report.checks.length));
  for (const check of report.checks) {
    assert.equal(typeof check.name, 'string');
    assert.equal(typeof check.ok, 'boolean');
    assert.equal(typeof check.detail, 'string');
  }
});

test('the settings panel self-check button runs the same checks', async () => {
  const stack = buildStack();
  const result = await stack.host.handle('POST', stack.host.routes.selfcheck);
  assert.equal(result.ok, true);
  assert.ok(result.checks.some((c) => c.name.includes('插件包')));
  assert.ok(result.checks.some((c) => c.name.includes('DSH_HOME')));
});
