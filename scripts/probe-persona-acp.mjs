#!/usr/bin/env node
// A NEW throwaway HOME for every run. Local stub only; never uses a real key.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AcpClient } from '../src/adapters/acp.mjs';
import { AcpBackend } from '../src/adapters/acp-backend.mjs';
import { cleanChildEnvironment } from '../src/isolation.mjs';
import { preparePersonaProfile } from '../src/persona-profile.mjs';
import { buildStack } from './wire-host.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';

const [launcher, moduleProfile] = process.argv.slice(2);
if (!launcher || !moduleProfile) throw new Error('usage: probe-persona-acp.mjs <dsh.cmd> <module-profile>');
const root = resolve(import.meta.dirname, '..', '.maintenance');
await mkdir(root, { recursive: true });
const run = await mkdtemp(join(root, 'persona-probe-'));
const daily = join(run, 'source', 'profiles', 'desktop');
await mkdir(daily, { recursive: true });
const link = (target, source) => execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', 'mklink', '/J', target, source], { stdio: 'ignore' });
link(join(daily, 'node_modules'), join(moduleProfile, 'node_modules'));
await writeFile(join(run, 'source', 'AGENT.md'), '测试专用全局人格_NATIVE_AGENT_MARKER');
await writeFile(join(daily, 'cordis.patch.yml'), JSON.stringify([{ id: 'soul-md', config: {
  cards: { Test: '测试专用原生人设_NATIVE_SOUL_MARKER' }, active: 'Test',
} }]));
const evidence = [];
for (const source of ['dsh', 'whale', 'custom']) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (part) => { raw += part; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, model: body.model, messages: body.messages });
      const base = { id: 'local-test', object: 'chat.completion.chunk', created: 1, model: 'fake-1' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ content: '本地链路已验' }, null], [{}, 'stop']]) {
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  const home = join(run, source, 'home');
  const profile = join(home, 'profiles', 'acp');
  await mkdir(profile, { recursive: true });
  link(join(profile, 'node_modules'), join(moduleProfile, 'node_modules'));
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', ...(source === 'dsh' ? ['dsh-agent-md', 'dsh-soul-md'] : [])];
  // Declared, not just listed: DSH resolves bundle names through `dependencies`.
  // Omitting them here silently loads no persona plugin at all.
  const dependencies = source === 'dsh' ? { 'dsh-agent-md': 'link:' + join(moduleProfile, 'node_modules', 'dsh-agent-md'),
    'dsh-soul-md': 'link:' + join(moduleProfile, 'node_modules', 'dsh-soul-md') } : {};
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'persona-probe', private: true, dependencies, dsh: { profile: { bundles } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      local-fake:\n        apiKeyEnv: LOCAL_FAKE_KEY\n        api: openai-completions\n        baseURL: http://127.0.0.1:${server.address().port}/v1\n        models:\n          - id: fake-1\n            name: fake-1\n            input: [text]\n- id: acp\n  name: '@deepseek-ai/dsh-acp'\n  config:\n    provider: local-fake\n    model: fake-1\n`);
  const persona = await preparePersonaProfile({ home, mainProfile: daily, source });
  const env = cleanChildEnvironment({ home, agentsHome: join(run, source, 'agents'), inject: { LOCAL_FAKE_KEY: 'local-fake-only-no-real-key' } });
  env.ELECTRON_RUN_AS_NODE = '1';
  let client, stack;
  try {
    client = await new AcpClient({ command: process.env.ComSpec || 'cmd.exe', args: ['/c', launcher, '--profile', 'acp'], cwd: home, env, requestTimeoutMs: 45000 }).start();
    const adapter = new AcpBackend({ client, workspaceRoot: home });
    stack = buildStack({ adapter, config: { enabled: true, personaSource: source, customPrompt: '自定义角色_CUSTOM_MARKER' } });
    const info = await stack.proxy.listen();
    const response = await fetch(info.baseUrl + '/v1/chat/completions', { method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + stack.token,
    }, body: JSON.stringify({ messages: [{ role: 'system', content: encodeEnvelope({ accountId: 'local', platform: 'wechat', chatType: 'private', chatId: 'probe', senderId: 'probe', messageId: source }) + '\n鲸鲸角色_WHALE_MARKER' }, { role: 'user', content: '本地链路验证' }] }) });
    const body = await response.json();
    const prompt = JSON.stringify(seen.flatMap((entry) => entry.messages));
    const observed = { source, http: response.status, llmCalls: seen.length,
      nativeAgent: prompt.includes('NATIVE_AGENT_MARKER'),
      nativeSoul: prompt.includes('NATIVE_SOUL_MARKER'),
      whale: prompt.includes('WHALE_MARKER'),
      custom: prompt.includes('CUSTOM_MARKER'),
      testPersona: prompt.includes('联调自检用最小人格'),
      personaRevision: persona.revision };
    evidence.push(observed);
    // dsh mode must carry BOTH halves of the real persona (AGENT.md + the active
    // soul card). Which plugin transports them is an implementation detail; what
    // the model actually receives is the contract.
    const nativeBoth = source === 'dsh' ? observed.nativeAgent && observed.nativeSoul : true;
    if ((source === 'dsh' && !nativeBoth) || observed.testPersona
      || (source !== 'dsh' && (observed.nativeAgent || observed.nativeSoul))
      || (source === 'whale' && !observed.whale) || (source === 'custom' && !observed.custom)) {
      const detail = { run, home, bundles, observed, nativeBoth,
        stderr: String(client.lastStderr ?? '').slice(-1500),
        llmFirstMessage: seen[0]?.messages?.[0]?.content?.slice?.(0, 500) ?? null };
      await writeFile(join(run, 'failure.json'), JSON.stringify(detail, null, 2));
      console.error('PERSONA_PROBE_FAILED\n' + JSON.stringify(detail, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await stack?.proxy.close();
    await client?.close();
    server.closeAllConnections?.();
    await new Promise((yes) => server.close(yes));
  }
}
await writeFile(join(run, 'evidence.json'), JSON.stringify({ localOnly: true, run, evidence }, null, 2));
console.log(JSON.stringify({ localOnly: true, run, evidence }, null, 2));
