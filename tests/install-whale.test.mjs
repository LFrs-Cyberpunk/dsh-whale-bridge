/**
 * The install script is the only thing that writes into Whale-Girl, so its safety
 * rules need tests of their own: dry-run must write nothing, a non-Whale target
 * must be refused, and uninstall must remove exactly the two files it owns.
 *
 * A fake Whale tree is built in a temp dir, so no real install is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ID } from '../scripts/make-flow-plugin.mjs';

const script = join(import.meta.dirname, '..', 'scripts', 'install-whale-plugin.mjs');

async function fakeWhale(withMarker = true) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-whale-'));
  if (withMarker) {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'whale-girl-bot', version: '4.1.2' }), 'utf8');
    await mkdir(join(dir, 'src', 'services'), { recursive: true });
    await writeFile(join(dir, 'src', 'services', 'messagePlugins.js'), '// marker', 'utf8');
  }
  await mkdir(join(dir, 'data', 'plugins'), { recursive: true });
  return dir;
}

const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('dry run writes nothing', async () => {
  const whale = await fakeWhale();
  try {
    const res = run(['--whale', whale]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /预演/);
    assert.equal((await readdir(join(whale, 'data', 'plugins'))).length, 0, '预演不得写文件');
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('a directory that is not Whale-Girl is refused', async () => {
  const notWhale = await fakeWhale(false);
  try {
    const res = run(['--whale', notWhale, '--apply']);
    assert.equal(res.status, 2, '必须拒绝');
    assert.match(res.stdout + res.stderr, /拒绝/);
  } finally { await rm(notWhale, { recursive: true, force: true }); }
});

test('apply writes exactly the two files and uninstall removes them', async () => {
  const whale = await fakeWhale();
  try {
    const plugins = join(whale, 'data', 'plugins');
    const put = run(['--whale', whale, '--apply']);
    assert.equal(put.status, 0, put.stderr);
    const names = (await readdir(plugins)).sort();
    assert.deepEqual(names, [`${ID}.flow-grant.json`, `${ID}.flow.json`].sort());
    const flow = JSON.parse(await readFile(join(plugins, `${ID}.flow.json`), 'utf8'));
    const grant = JSON.parse(await readFile(join(plugins, `${ID}.flow-grant.json`), 'utf8'));
    assert.equal(flow.id, ID);
    assert.equal(grant.enabled, true);

    const del = run(['--whale', whale, '--uninstall', '--apply']);
    assert.equal(del.status, 0, del.stderr);
    assert.equal((await readdir(plugins)).length, 0, '卸载后目录应为空');
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('apply leaves every other file in the directory alone', async () => {
  const whale = await fakeWhale();
  try {
    const plugins = join(whale, 'data', 'plugins');
    await writeFile(join(plugins, 'someone-else.flow.json'), '{}', 'utf8');
    await writeFile(join(plugins, 'notes.txt'), 'x', 'utf8');
    const put = run(['--whale', whale, '--apply']);
    assert.equal(put.status, 0, put.stderr);
    const names = (await readdir(plugins)).sort();
    assert.ok(names.includes('someone-else.flow.json'), '不得删除别人的插件');
    assert.ok(names.includes('notes.txt'), '不得删除无关文件');
    run(['--whale', whale, '--uninstall', '--apply']);
    const after = (await readdir(plugins)).sort();
    assert.deepEqual(after, ['notes.txt', 'someone-else.flow.json']);
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('overwriting an existing plugin backs it up first', async () => {
  const whale = await fakeWhale();
  try {
    const plugins = join(whale, 'data', 'plugins');
    const oldFlow = join(plugins, `${ID}.flow.json`);
    await writeFile(oldFlow, '{"old":true}', 'utf8');
    const put = run(['--whale', whale, '--apply']);
    assert.equal(put.status, 0, put.stderr);
    const dirs = (await readdir(plugins)).filter((n) => n.startsWith('.backup-'));
    assert.equal(dirs.length, 1, '覆盖前必须留一份备份');
    const kept = JSON.parse(await readFile(join(plugins, dirs[0], `${ID}.flow.json`), 'utf8'));
    assert.deepEqual(kept, { old: true }, '备份的必须是旧内容');
  } finally { await rm(whale, { recursive: true, force: true }); }
});

test('a first install creates no backup directory', async () => {
  const whale = await fakeWhale();
  try {
    const plugins = join(whale, 'data', 'plugins');
    const put = run(['--whale', whale, '--apply']);
    assert.equal(put.status, 0, put.stderr);
    assert.equal((await readdir(plugins)).filter((n) => n.startsWith('.backup-')).length, 0);
  } finally { await rm(whale, { recursive: true, force: true }); }
});
