/**
 * The alerting rules matter more than the dialog: a self-check that never fires
 * is useless, and one that fires on success trains the user to ignore it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertFailure, failureSummary, writeFailureLog, showPopup } from '../scripts/selfcheck-alert.mjs';

const pass = { ok: true, mockOnly: true, checks: [{ name: 'a', ok: true }, { name: 'b', ok: true }] };
const fail = {
  ok: false, mockOnly: true,
  checks: [{ name: '隔离目录', ok: true }, { name: '信封编码', ok: false, detail: 'BAD_ENVELOPE' }],
};

test('a passing run never pops and never logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alert-pass-'));
  try {
    const res = await alertFailure({ projectRoot: dir, report: pass, env: process.env });
    assert.equal(res.popped, false);
    assert.equal(res.logged, null);
    const logs = await readdir(dir).catch(() => []);
    assert.ok(!logs.includes('logs'), '通过时不写错误日志');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failing run writes a log that names the failed check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alert-fail-'));
  try {
    const res = await alertFailure({ projectRoot: dir, report: fail, env: { ...process.env, WHALE_SELFCHECK_NO_POPUP: '1' } });
    assert.ok(res.logged, '必须写日志');
    assert.equal(res.popped, false, 'NO_POPUP 时不弹窗');
    const text = await readFile(res.logged, 'utf8');
    assert.match(text, /信封编码/);
    assert.match(text, /BAD_ENVELOPE/);
    assert.match(text, /--- failed checks ---/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a thrown error still produces a readable log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alert-crash-'));
  try {
    const res = await alertFailure({ projectRoot: dir, error: new Error('磁盘只读'), env: { ...process.env, WHALE_SELFCHECK_NO_POPUP: '1' } });
    assert.ok(res.logged);
    const text = await readFile(res.logged, 'utf8');
    assert.match(text, /磁盘只读/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('error logs are capped so a debug loop cannot fill the disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alert-rotate-'));
  try {
    for (let i = 0; i < 25; i++) await writeFailureLog({ projectRoot: dir, report: fail });
    const logs = (await readdir(join(dir, 'logs'))).filter((n) => n.startsWith('selfcheck-'));
    assert.ok(logs.length <= 20, `实际 ${logs.length} 个`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the summary is short and names every failure', () => {
  const s = failureSummary(fail);
  assert.match(s, /信封编码/);
  assert.doesNotMatch(s, /隔离目录/, '通过的检查不进摘要');
  assert.equal(failureSummary(pass), '');
});

test('popup is skipped explicitly and on non-Windows', () => {
  assert.equal(showPopup({ title: 't', message: 'm', env: { WHALE_SELFCHECK_NO_POPUP: '1' } }), false);
  if (process.platform !== 'win32') {
    assert.equal(showPopup({ title: 't', message: 'm', env: {} }), false);
  }
});
