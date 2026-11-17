#!/usr/bin/env node
/**
 * Produce the files Whale-Girl 4.1.2 actually reads.
 *
 * IMPORTANT CORRECTION: the runtime does NOT load `plugin.json`. It scans
 * `$dataDir/plugins` for `<id>.flow.json` and pairs each with `<id>.flow-grant.json`
 * (see src/services/messagePlugins.js:121-136). Both JavaScriptPlugins and
 * MessagePlugins agree on that shape. There is no ZIP installer anywhere in the
 * Whale source tree, so a ZIP is at best a market artifact — it is not something
 * the app consumes.
 *
 * What this script emits:
 *   <id>.flow.json         { id, api:3, hooks, permissions, wasm(base64) }
 *   <id>.flow-grant.json   { hash: sha256(JSON.stringify(flow)), enabled:true }
 *
 * The hash must be computed over the SAME serialization the runtime will rebuild
 * from the file, so the key order here is the contract. Do not reorder keys.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const ID = 'whale-dsh-router';
export const HOOKS = ['chat.prompt', 'chat.dispatched'];
export const PERMISSIONS = ['model.prompt'];
export const MAX_WASM = 700000;

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'whale-plugin', 'dist');

/** Build the exact object the runtime will see, in a fixed key order. */
export function buildFlow(wasmBase64) {
  return {
    id: ID,
    api: 3,
    hooks: [...HOOKS],
    permissions: [...PERMISSIONS],
    wasm: wasmBase64,
  };
}

export function grantHash(flow) {
  return createHash('sha256').update(JSON.stringify(flow)).digest('hex');
}

/**
 * Mirror of the checks the runtime applies before it will load a flow.
 * Kept here so the build fails loudly instead of shipping a file that is silently
 * skipped (messagePlugins.js:124-134).
 */
export function validateFlow(flow, grant) {
  const problems = [];
  const idOk = /^[a-z][a-z0-9-]{0,47}$/.test(String(flow?.id ?? ''));
  if (!idOk) problems.push('id 不符合 [a-z][a-z0-9-]{0,47}');
  if (flow?.id !== ID) problems.push('id 与文件名不一致');
  if (flow?.api !== 3) problems.push('api 必须是 3');
  if (!Array.isArray(flow?.hooks) || flow.hooks.length === 0) problems.push('hooks 不能为空');
  if (new Set(flow?.hooks ?? []).size !== (flow?.hooks ?? []).length) problems.push('hooks 有重复');
  const legal = ['chat.received', 'chat.pre_reply', 'chat.prompt', 'chat.generate', 'chat.reply', 'chat.before_send', 'chat.dispatched', 'chat.search', 'chat.search_result', 'app.start', 'app.stop', 'timer.tick', 'tool.run'];
  for (const h of flow?.hooks ?? []) if (!legal.includes(h)) problems.push(`未知钩子 ${h}`);
  for (const p of flow?.permissions ?? []) if (p !== 'chat.history' && p !== 'model.prompt') problems.push(`越权权限 ${p}`);
  if (typeof flow?.wasm !== 'string') problems.push('wasm 必须是 base64 字符串');
  if (String(flow?.wasm ?? '').length > MAX_WASM) problems.push('wasm 超过 700000 字符');
  if (!grant || typeof grant !== 'object') problems.push('缺少授权文件');
  else {
    if (grant.hash !== grantHash(flow)) problems.push('授权 hash 与 flow 不匹配');
    if (grant.enabled !== true) problems.push('授权未启用');
  }
  return problems;
}

async function main() {
  const wasm = await readFile(join(dist, 'plugin.wasm'));
  const flow = buildFlow(wasm.toString('base64'));
  const grant = { hash: grantHash(flow), enabled: true };
  const problems = validateFlow(flow, grant);
  if (problems.length) {
    process.stderr.write('产物不合规：\n' + problems.map((p) => '· ' + p).join('\n') + '\n');
    process.exit(1);
  }
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, `${ID}.flow.json`), JSON.stringify(flow), 'utf8');
  await writeFile(join(dist, `${ID}.flow-grant.json`), JSON.stringify(grant), 'utf8');
  process.stdout.write(JSON.stringify({
    ok: true,
    files: [`${ID}.flow.json`, `${ID}.flow-grant.json`],
    dir: dist,
    target: '<鲸鲸 dataDir>/plugins/',
    hash: grant.hash,
    wasmBytes: wasm.length,
    wasmBase64Chars: flow.wasm.length,
  }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
}
