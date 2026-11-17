/**
 * The user should not configure a second API key for the same machine. These
 * tests pin the sharing rules: read the daily profile, never write it, copy only
 * the model blocks, and let the settings page override model/effort.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitBlocks, requiredEnvNames, mergeModelBlocks, withModelChoice, shareModelConfig } from '../scripts/share-model-config.mjs';

const LIVE = `- id: dsh-meme
  name: dsh-meme
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://example.invalid/v1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek
    model: deepseek-flash
    reasoningEffort: low
`;

test('blocks split on top-level ids and keep their own text', () => {
  const { blocks, order } = splitBlocks(LIVE);
  assert.deepEqual(order, ['dsh-meme', 'llm-pi-ai', 'agent-default-model']);
  assert.match(blocks.get('agent-default-model').lines.join('\n'), /model: deepseek-flash/);
  assert.doesNotMatch(blocks.get('llm-pi-ai').lines.join('\n'), /agent-default-model/);
});

test('it finds the env var names the providers need', () => {
  assert.deepEqual(requiredEnvNames(LIVE), ['DEEPSEEK_API_KEY']);
});

test('merging keeps other isolated blocks and adopts the model ones', () => {
  const isolated = `- id: acp
  name: "@deepseek-ai/dsh-acp"
  config:
    provider: local-fake
`;
  const merged = mergeModelBlocks(LIVE, isolated);
  assert.equal(merged.ok, true);
  assert.match(merged.text, /- id: acp/, '隔离侧自己的块要留着');
  assert.match(merged.text, /- id: llm-pi-ai/);
  assert.match(merged.text, /- id: agent-default-model/);
  assert.doesNotMatch(merged.text, /dsh-meme/, '无关插件不该被搬过去');
});

test('a same-id block on the isolated side is replaced, not duplicated', () => {
  const isolated = `- id: agent-default-model
  config:
    model: stale-model
`;
  const merged = mergeModelBlocks(LIVE, isolated);
  assert.equal(merged.text.match(/- id: agent-default-model/g).length, 1, '不能出现两份');
  assert.doesNotMatch(merged.text, /stale-model/);
});

test('the settings page can override model and reasoning effort', () => {
  const merged = mergeModelBlocks(LIVE, '');
  const chosen = withModelChoice(merged.text, { model: 'deepseek-pro', reasoningEffort: 'high' });
  assert.match(chosen, /model: deepseek-pro/);
  assert.match(chosen, /reasoningEffort: high/);
  assert.doesNotMatch(chosen, /deepseek-flash/, '旧值要被换掉');
});

test('sharing writes the isolated profile and never touches the daily one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'share-'));
  const live = join(dir, 'live');
  const iso = join(dir, 'iso');
  await mkdir(live, { recursive: true });
  await mkdir(iso, { recursive: true });
  await writeFile(join(live, 'cordis.patch.yml'), LIVE, 'utf8');
  await writeFile(join(iso, 'cordis.patch.yml'), '[]\n', 'utf8');
  try {
    const res = await shareModelConfig({ liveProfile: live, isolatedProfile: iso });
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(res.envNames, ['DEEPSEEK_API_KEY']);
    const after = await readFile(join(iso, 'cordis.patch.yml'), 'utf8');
    assert.match(after, /llm-pi-ai/);
    const liveAfter = await readFile(join(live, 'cordis.patch.yml'), 'utf8');
    assert.equal(liveAfter, LIVE, '日常配置一个字节都不能变');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing daily profile is reported, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'share2-'));
  try {
    const res = await shareModelConfig({ liveProfile: join(dir, 'nope'), isolatedProfile: join(dir, 'iso') });
    assert.equal(res.ok, false);
    assert.match(res.reason, /没有 cordis.patch.yml/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the chosen model survives the real share path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'share3-'));
  const live = join(dir, 'live');
  const iso = join(dir, 'iso');
  await mkdir(live, { recursive: true });
  await mkdir(iso, { recursive: true });
  await writeFile(join(live, 'cordis.patch.yml'), LIVE, 'utf8');
  try {
    await shareModelConfig({ liveProfile: live, isolatedProfile: iso, model: 'deepseek-pro', reasoningEffort: 'medium' });
    const text = await readFile(join(iso, 'cordis.patch.yml'), 'utf8');
    assert.match(text, /model: deepseek-pro/);
    assert.match(text, /reasoningEffort: medium/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
