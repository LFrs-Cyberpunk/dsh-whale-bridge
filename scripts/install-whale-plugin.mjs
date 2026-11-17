#!/usr/bin/env node
/**
 * Install / uninstall the bridge plugin into a Whale-Girl instance.
 *
 * Default is a DRY RUN: it prints what it would write and touches nothing. The
 * user has to pass --apply, and even then it only ever touches the two files it
 * owns (plus a backup of any same-named file it replaces). It never edits Whale's
 * code, config, or other plugins.
 *
 *   node scripts/install-whale-plugin.mjs                 # 看一下要做什么
 *   node scripts/install-whale-plugin.mjs --apply         # 真装
 *   node scripts/install-whale-plugin.mjs --uninstall     # 卸（同样先 dry run）
 *   node scripts/install-whale-plugin.mjs --uninstall --apply
 *
 * Exit codes: 0 ok, 2 refused (bad target / not a Whale dir), 3 missing artifact.
 */
import { copyFile, mkdir, readFile, readdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { ID } from './make-flow-plugin.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'whale-plugin', 'dist');
const DEFAULT_WHALE = process.env.WHALE_ROOT || '';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const uninstall = argv.includes('--uninstall');
const targetArg = argv.find((a, i) => argv[i - 1] === '--whale');

function say(line) { process.stdout.write(line + '\n'); }

async function exists(p) { try { await access(p, constants.F_OK); return true; } catch { return false; } }

async function main() {
  const whale = resolve(targetArg || DEFAULT_WHALE);
  const plugins = join(whale, 'data', 'plugins');

  // Refuse anything that does not look like a Whale install. Guarding on a marker
  // file rather than a hard-coded path keeps this safe if the user moved it.
  const marker = join(whale, 'package.json');
  if (!(await exists(marker)) || !(await exists(join(whale, 'src', 'services', 'messagePlugins.js')))) {
    say(`拒绝：${whale} 不像鲸鲸目录（缺 package.json 或 src/services/messagePlugins.js）`);
    process.exit(2);
  }

  const flowSrc = join(dist, `${ID}.flow.json`);
  const grantSrc = join(dist, `${ID}.flow-grant.json`);
  const flowDst = join(plugins, `${ID}.flow.json`);
  const grantDst = join(plugins, `${ID}.flow-grant.json`);

  if (uninstall) {
    say(`目标：${plugins}`);
    for (const [label, p] of [['flow', flowDst], ['grant', grantDst]]) {
      say(`  ${(await exists(p)) ? '将删除' : '本来就没有'}  ${label}: ${p}`);
    }
    if (!apply) { say('\n这是预演。加 --apply 才会真删。'); return 0; }
    for (const p of [flowDst, grantDst]) await rm(p, { force: true });
    say('\n已删除。鲸鲸重启后该插件不再加载。');
    return 0;
  }

  if (!(await exists(flowSrc)) || !(await exists(grantSrc))) {
    say(`缺少产物，先跑 npm run make:flow（找的是 ${flowSrc}）`);
    process.exit(3);
  }

  const flow = JSON.parse(await readFile(flowSrc, 'utf8'));
  const grant = JSON.parse(await readFile(grantSrc, 'utf8'));
  say(`来源：${dist}`);
  say(`目标：${plugins}`);
  say(`权限：${flow.permissions.join(',')}  钩子：${flow.hooks.join(',')}  wasm：${flow.wasm.length} 字符`);
  say(`授权：${grant.hash.slice(0, 16)}… enabled=${grant.enabled}`);

  const existing = (await readdir(plugins).catch(() => [])).filter((n) => n.includes(ID));
  if (existing.length) say(`注意：目标目录已有同名文件，将被覆盖 —— ${existing.join(', ')}`);

  if (!apply) { say('\n这是预演，什么都没写。加 --apply 才会真装。'); return 0; }

  await mkdir(plugins, { recursive: true });
  // Overwriting is reversible: keep the old pair before replacing it. The doc
  // comment promised this, so it has to actually happen.
  if (existing.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(plugins, `.backup-${stamp}`);
    await mkdir(backupDir, { recursive: true });
    for (const name of existing) await copyFile(join(plugins, name), join(backupDir, name));
    say(`已备份旧文件 → ${backupDir}`);
  }
  await copyFile(flowSrc, flowDst);
  await copyFile(grantSrc, grantDst);
  say('\n已写入两个文件。重启鲸鲸后生效。');
  say('撤回：node scripts/install-whale-plugin.mjs --uninstall --apply');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
