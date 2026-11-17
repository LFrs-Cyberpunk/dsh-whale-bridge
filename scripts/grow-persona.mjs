#!/usr/bin/env node
/**
 * Grow the persona layer from everything said so far, then print what it became.
 *
 * Meant to run occasionally (once a day, or after a batch of conversations) — NOT
 * per turn. The growth is rule-based and free: it picks first-person statements
 * out of the episode store, collapses near-duplicates, and hard-caps the result.
 *
 *   node scripts/grow-persona.mjs [--root <memory dir>]
 *
 * Defaults to the isolated store. It refuses any path that is not inside the
 * project, so a typo can never touch the daily DSH data.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { MemoryStore, growPersona, MEMORY_LIMITS } from '../src/memory.mjs';

const root = resolve(import.meta.dirname, '..');
const argRoot = process.argv.indexOf('--root');
const memoryRoot = argRoot > -1 ? resolve(process.argv[argRoot + 1]) : join(root, '.test-home', 'memory');

if (!memoryRoot.startsWith(root + sep)) {
  process.stderr.write(`拒绝：记忆目录必须在项目内，收到 ${memoryRoot}\n`);
  process.exit(2);
}

const store = new MemoryStore({ root: memoryRoot });
const personaPath = join(memoryRoot, 'persona.md');

// Seed from the previous run so growth is cumulative, not from scratch.
try { store.persona = (await readFile(personaPath, 'utf8')).trim(); } catch { /* first run */ }

const grown = await growPersona(store);
if (!grown) {
  process.stdout.write(JSON.stringify({ ok: true, grown: '', note: '还没有可成长的第一人称陈述' }, null, 2) + '\n');
  process.exit(0);
}

await mkdir(memoryRoot, { recursive: true });
await writeFile(personaPath, grown + '\n', 'utf8');
process.stdout.write(JSON.stringify({
  ok: true,
  path: personaPath,
  lines: grown.split('\n').length,
  chars: grown.length,
  limit: MEMORY_LIMITS.personaChars,
  persona: grown,
}, null, 2) + '\n');
