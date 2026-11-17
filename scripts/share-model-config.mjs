/**
 * Share the model configuration the user already has in their daily DSH.
 *
 * The user's objection was fair: making them configure a second API key for a
 * second DSH is silly. The isolated host exists to protect their daily data, not
 * to make them re-enter credentials.
 *
 * What this does, without parsing YAML as a library (the file is a top-level list
 * of `- id:` blocks, so block text can be copied verbatim):
 *   1. read the daily profile's cordis.patch.yml (READ ONLY, never written)
 *   2. lift the `llm-pi-ai` and `agent-default-model` blocks
 *   3. write them into the isolated profile's patch file, replacing same-id blocks
 *   4. report which env vars those providers need so the child can inherit exactly
 *      those credentials — not every secret in the parent process
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SHARED_IDS = ['llm-pi-ai', 'agent-default-model'];

/** Split a top-level YAML list into blocks keyed by `- id: <name>`. */
export function splitBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = new Map();
  const order = [];
  let current = null;
  for (const line of lines) {
    const header = /^-\s+id:\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (header) {
      current = { id: header[1], lines: [line] };
      blocks.set(header[1], current);
      order.push(header[1]);
      continue;
    }
    if (current) current.lines.push(line);
  }
  for (const block of blocks.values()) {
    // Trim the blank tail that belongs to the next block.
    while (block.lines.length > 1 && block.lines[block.lines.length - 1].trim() === '') block.lines.pop();
  }
  return { blocks, order };
}

/** Environment variables the shared providers need, e.g. DEEPSEEK_API_KEY. */
export function requiredEnvNames(text) {
  const names = new Set();
  for (const match of String(text ?? '').matchAll(/apiKeyEnv:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
  return [...names];
}

/** Copy the model blocks from the daily profile into the isolated patch text. */
export function mergeModelBlocks(liveText, isolatedText) {
  const live = splitBlocks(liveText);
  const missing = SHARED_IDS.filter((id) => !live.blocks.has(id));
  if (missing.length) return { ok: false, missing, text: isolatedText };

  const isolated = splitBlocks(isolatedText);
  const kept = [];
  for (const id of isolated.order) {
    if (SHARED_IDS.includes(id)) continue;
    kept.push(isolated.blocks.get(id).lines.join('\n'));
  }
  const adopted = SHARED_IDS.map((id) => live.blocks.get(id).lines.join('\n'));
  const out = [...kept, ...adopted].join('\n');
  return { ok: true, missing: [], text: out.endsWith('\n') ? out : out + '\n' };
}

/** Kept for callers that want to override just the model / effort. */
export function withModelChoice(text, { model, reasoningEffort } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s+id:\s*agent-default-model\s*$/.test(lines[i])) { inside = true; continue; }
    if (inside && /^-\s+id:/.test(lines[i])) break;
    if (!inside) continue;
    if (model && /^\s+model:/.test(lines[i])) lines[i] = '    model: ' + model;
    if (reasoningEffort && /^\s+reasoningEffort:/.test(lines[i])) lines[i] = '    reasoningEffort: ' + reasoningEffort;
  }
  return lines.join('\n');
}

/**
 * Read the daily profile and write the shared blocks into the isolated one.
 * Never writes to the daily profile; a missing daily file is not an error (the
 * caller can fall back to a self-contained config).
 */
export async function shareModelConfig({ liveProfile, isolatedProfile, model, reasoningEffort } = {}) {
  const result = { ok: false, reason: '', envNames: [], liveFile: '', isolatedFile: '' };
  if (!liveProfile || !isolatedProfile) { result.reason = '缺少 profile 路径'; return result; }
  const liveFile = join2(liveProfile, 'cordis.patch.yml');
  const isolatedFile = join2(isolatedProfile, 'cordis.patch.yml');
  result.liveFile = liveFile;
  result.isolatedFile = isolatedFile;

  let liveText;
  try { liveText = await readFile(liveFile, 'utf8'); } catch { result.reason = '日常 profile 里没有 cordis.patch.yml'; return result; }

  let isolatedText = '[]\n';
  try { isolatedText = await readFile(isolatedFile, 'utf8'); } catch { /* first run */ }

  const merged = mergeModelBlocks(liveText, isolatedText);
  if (!merged.ok) { result.reason = '日常配置里缺少：' + merged.missing.join(', '); return result; }

  const finalText = withModelChoice(merged.text, { model, reasoningEffort });
  await mkdir(dirname(isolatedFile), { recursive: true });
  await writeFile(isolatedFile, finalText, 'utf8');
  result.ok = true;
  result.envNames = requiredEnvNames(liveText);
  return result;
}

// Small helper so this module stays dependency-free.
function join2(a, b) {
  return String(a).replace(/[\\/]+$/, '') + (String(a).includes('\\') ? '\\' : '/') + b;
}
