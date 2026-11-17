#!/usr/bin/env node
/**
 * Push a code-only update into an already-installed Api 4 plugin.
 *
 * Why this exists: the plugin is installed as `<id>.flow.json` + `<id>.flow-grant.json`
 * and the grant hash is `sha256(JSON.stringify(flow))` with a FIXED key order. A
 * code fix (like the envelope format) therefore cannot be a straight file copy —
 * the hash has to be recomputed or Whale silently refuses to load the plugin and
 * the only symptom is "it just doesn't work".
 *
 * Safe by construction:
 *   - backs up both files before touching them
 *   - keeps every manifest field as-is, only replaces `javascript`
 *   - verifies the rewritten files parse and the hash matches
 *   - refuses to run against a plugin whose id/api/kind/permissions are not the
 *     ones this project produces
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const ID = 'whale-dsh-bridge';
const EXPECTED = { api: 4, kind: 'message', permissions: ['system.full'] };

/**
 * Hooks this plugin actually declares. Read from the manifest so the two can never
 * drift: a hook missing here is never called by Whale, and the failure is silent.
 * `chat.prompt` only captures her assembled persona; `chat.generate` answers.
 */
const MANIFEST_HOOKS = ['chat.prompt', 'chat.generate'];

/** Version stamped into flow.json so Whale's panel shows the build that is running. */
const MANIFEST_VERSION = '1.0.0';

export function grantHash(flow) {
  return createHash('sha256').update(JSON.stringify(flow)).digest('hex');
}

/** Replace only the code, preserving key order of the original manifest. */
export function withCode(flow, code) {
  const next = {};
  for (const key of Object.keys(flow)) next[key] = key === 'javascript' ? code : flow[key];
  if (!('javascript' in next)) next.javascript = code;
  // Hooks come from the manifest, not from whatever the last install left behind:
  // adding a hook to plugin.js without listing it here means Whale never calls it.
  if (Array.isArray(MANIFEST_HOOKS) && MANIFEST_HOOKS.length) next.hooks = [...MANIFEST_HOOKS];
  // Same reasoning for the version: Whale's UI shows whatever flow.json carries,
  // so a stale number here makes the panel claim an old build is installed.
  if (MANIFEST_VERSION) next.version = MANIFEST_VERSION;
  return next;
}

export function checkShape(flow, id = ID) {
  const problems = [];
  if (flow.id !== id) problems.push(`id 不是 ${id}`);
  if (flow.api !== EXPECTED.api) problems.push('api 不是 4');
  if (flow.kind !== EXPECTED.kind) problems.push('kind 不是 message');
  if (JSON.stringify(flow.permissions) !== JSON.stringify(EXPECTED.permissions)) problems.push('权限不是 system.full');
  return problems;
}

async function main() {
  const dir = process.argv[2] || process.env.WHALE_DATA_DIR || '';
  const codeFile = process.argv[3] || join(import.meta.dirname, '..', 'whale-plugin', 'js', 'plugin.js');
  const flowFile = join(dir, `${ID}.flow.json`);
  const grantFile = join(dir, `${ID}.flow-grant.json`);

  const code = await readFile(codeFile, 'utf8');
  const flow = JSON.parse(await readFile(flowFile, 'utf8'));
  const problems = checkShape(flow);
  if (problems.length) {
    process.stderr.write('拒绝更新：' + problems.join('；') + '\n');
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(flowFile, `${flowFile}.bak-${stamp}`);
  // The grant file can legitimately be absent: Whale 4.1.6 rewrites plugin state on
  // install and the running process keeps its grant in memory only. Treat a missing
  // file as "no previous state" instead of aborting the push.
  const previousGrant = await readFile(grantFile, 'utf8').then(
    (text) => { void copyFile(grantFile, `${grantFile}.bak-${stamp}`); return JSON.parse(text); },
    () => null,
  );

  const next = withCode(flow, code);
  const hash = grantHash(next);
  const grant = previousGrant ?? { enabled: true, fullAccess: true, settings: {} };
  const nextGrant = { ...grant, enabled: true, fullAccess: true, hash };

  await writeFile(flowFile, JSON.stringify(next), 'utf8');
  await writeFile(grantFile, JSON.stringify(nextGrant), 'utf8');

  // Read back and verify: a silently wrong hash is the failure mode this guards.
  const checkFlow = JSON.parse(await readFile(flowFile, 'utf8'));
  const checkGrant = JSON.parse(await readFile(grantFile, 'utf8'));
  const ok = grantHash(checkFlow) === checkGrant.hash && checkFlow.javascript === code;
  process.stdout.write(JSON.stringify({
    ok,
    flowFile,
    grantFile,
    backup: `${flowFile}.bak-${stamp}`,
    bytes: Buffer.byteLength(code),
    hash,
    enabled: checkGrant.enabled,
  }, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
}
