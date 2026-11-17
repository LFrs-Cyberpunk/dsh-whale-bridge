#!/usr/bin/env node
/**
 * Regenerate the isolated profile's model patch with the `id: acp` override and
 * report what changed — WITHOUT starting anything.
 *
 * Why a separate script: writeModelConfig() lives inside plugin/apply.mjs and is
 * only reachable from the DSH host half, so verifying it used to require a DSH
 * restart. This mirrors its exact output so the route can be checked today.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const STATE = join(homedir(), '.whale-dsh-bridge');
const service = JSON.parse(await readFile(join(STATE, 'service.json'), 'utf8'));
const home = String(service.dshHome || join(STATE, 'dsh'));
const file = join(home, 'profiles', 'acp', 'cordis.patch.yml');

const KEY_ENV = 'WHALE_BRIDGE_LLM_KEY';
const quote = (v) => JSON.stringify(String(v));
const model = service.model || 'deepseek-flash';
const baseUrl = service.baseUrl || 'https://api.deepseek.com';
const reasoningEffort = service.reasoningEffort || 'low';

// Keep any persona overlay this run already wrote; only the model block is ours.
let existing = '';
try { existing = await readFile(file, 'utf8'); } catch { /* first run */ }
const overlayAt = existing.indexOf('# BEGIN whale-bridge persona overlay');
const tail = overlayAt >= 0 ? existing.slice(overlayAt) : '';

const yaml = [
  '# 由 dsh-whale-bridge 生成：隔离宿主的模型配置。改设置页会重写这个文件。',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      whale-bridge:',
  '        displayName: 鲸鲸桥接',
  `        apiKeyEnv: ${KEY_ENV}`,
  '        api: openai-completions',
  `        baseURL: ${quote(baseUrl)}`,
  '        models:',
  `          - id: ${quote(model)}`,
  `            name: ${quote(model)}`,
  // The block that decides which route a bridge turn actually takes.
  '- id: acp',
  '  name: "@deepseek-ai/dsh-acp"',
  '  config:',
  '    provider: whale-bridge',
  `    model: ${quote(model)}`,
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: whale-bridge',
  `    model: ${quote(model)}`,
  `    reasoningEffort: ${quote(reasoningEffort)}`,
  '',
].join('\n');

await mkdir(dirname(file), { recursive: true });
await writeFile(file, yaml + tail, 'utf8');
console.log(JSON.stringify({
  file,
  model,
  baseUrlHost: new URL(baseUrl).host,
  hasAcpBlock: true,
  keptPersonaOverlay: Boolean(tail),
  keyPresent: Boolean(service.apiKey),
}, null, 2));
