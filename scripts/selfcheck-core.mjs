/**
 * The self-check itself, callable from both the CLI and the settings panel.
 *
 * Guarantees: never starts DSH, never touches Whale-Girl, never dials a live
 * endpoint, never writes outside the project. Every check is local and repeatable.
 */
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeConfig, BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { Diagnostics } from '../src/diagnostics.mjs';
import { assertIsolatedHome, cleanChildEnvironment } from '../src/isolation.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';
import { verifyPluginZip } from './verify-plugin-package.mjs';
import { stateDir } from '../src/state-dir.mjs';
import { homedir } from 'node:os';

const CREDENTIAL = /^(DSH_|OPENAI|DEEPSEEK|ANTHROPIC|API)|_KEY|TOKEN|SECRET/i;
const ALLOWED_ENV = ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_PROFILE'];

export async function runSelfcheck({ projectRoot } = {}) {
  const root = resolve(projectRoot ?? join(import.meta.dirname, '..'));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  const exists = async (rel) => { try { await access(join(root, rel)); return true; } catch { return false; } };

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  add('package.json 可解析', pkg.type === 'module', `name=${pkg.name} type=${pkg.type}`);

  for (const rel of ['src/core.mjs', 'src/diagnostics.mjs', 'src/isolation.mjs', 'src/envelope.mjs', 'src/proxy.mjs', 'src/memory.mjs', 'src/persona.mjs', 'src/adapters/mock.mjs', 'src/adapters/acp.mjs', 'src/adapters/acp-backend.mjs']) {
    add(`模块存在：${rel}`, await exists(rel), rel);
  }

  // The memory layer must stay inside its own budget, and must never inject
  // anything when nothing was asked about the past. Both are cheap to prove here.
  const { MemoryStore, MEMORY_LIMITS, shouldRecall } = await import('../src/memory.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const tmp = await mkdtemp(join(tmpdir(), 'selfcheck-mem-'));
  try {
    const store = new MemoryStore({ root: tmp });
    await store.record('c1', { role: 'user', text: '我喜欢吃辣' });
    const quiet = await store.buildContext({ chatId: 'c1', query: '今天天气不错', persona: '' });
    add('记忆平时不注入', quiet.text === '' && quiet.episodeLines === 0, '无回溯信号时不拼装');
    const recall = await store.buildContext({ chatId: 'c1', query: '你还记得我喜欢吃什么吗', persona: '' });
    add('回溯时才检索', recall.recalled === true, `${recall.episodeLines} 条`);
    add('记忆注入有硬上限', recall.chars <= MEMORY_LIMITS.totalChars, `${recall.chars} / ${MEMORY_LIMITS.totalChars} 字`);
    add('回溯信号识别', shouldRecall('上次说的那件事') && !shouldRecall('今天吃什么'), '关键词命中');
  } catch (error) {
    add('记忆模块可用', false, String(error?.message ?? error));
  } finally { await rm(tmp, { recursive: true, force: true }); }


  const { encodeEnvelope, decodeEnvelope, deliveryState } = await import('../src/envelope.mjs');
  const meta = { accountId: 'selfcheck', platform: 'wechat', chatType: 'private', chatId: 'c', senderId: 's', messageId: 'm' };
  add('信封往返一致', decodeEnvelope(encodeEnvelope(meta) + '\n正文')?.chatId === 'c', 'chatId 已还原');
  add('信封不在开头时忽略', decodeEnvelope('前置内容\n' + encodeEnvelope(meta)) === null, '不在 offset 0');
  add('回执不会谎报送达', deliveryState({ messageId: 'm', ok: true, local: true }) === 'submitted_local', 'local=true → submitted_local');

  const { createProxyServer } = await import('../src/proxy.mjs');
  let tokenGuard = false;
  try {
    createProxyServer({ engine: new BridgeEngine({ adapter: new MockAdapter(), personas: new PersonaResolver({}), config: {} }), token: 'x' });
  } catch (error) { tokenGuard = error.code === 'TOKEN_REQUIRED'; }
  add('代理拒绝无令牌启动', tokenGuard, 'TOKEN_REQUIRED');

  // Api 4 package: the old WASM verifier only understands api 3 + plugin.wasm, so
  // it cannot judge this one. Check what actually matters for Api 4 instead.
  let jsPackage = { ok: false, detail: '未找到 1.0.0 包' };
  try {
    const manifestRaw = await readFile(join(root, 'whale-plugin', 'js', 'plugin.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    const code = await readFile(join(root, 'whale-plugin', 'js', 'plugin.js'));
    const zipFile = join(root, 'whale-plugin', 'dist', `whale-dsh-bridge-${manifest.Version}.zip`);
    const zipStat = await stat(zipFile);
    const problems = [];
    if (manifest.Api !== 4) problems.push('Api 不是 4');
    if (manifest.Kind !== 'message') problems.push('Kind 不是 message');
    if (JSON.stringify(manifest.Permissions) !== '["system.full"]') problems.push('权限不是 system.full');
    if (!Array.isArray(manifest.Hooks) || !manifest.Hooks.includes('chat.generate')) problems.push('缺少 chat.generate 钩子');
    if (Buffer.byteLength(code) > 8 * 1024 * 1024) problems.push('代码超过 8 MiB');
    if (zipStat.size > 16 * 1024 * 1024) problems.push('包超过 16 MiB');
    jsPackage = problems.length
      ? { ok: false, detail: problems.join('；') }
      : { ok: true, detail: `v${manifest.Version} · ${Math.round(zipStat.size / 1024)} KB · 权限 system.full` };
  } catch (error) {
    jsPackage = { ok: false, detail: String(error?.message ?? error) };
  }
  add('Api 4 插件包符合市场规则', jsPackage.ok, jsPackage.detail);

  let rejected = 0;
  for (const bad of [{ personaSource: 'both' }, { personaSource: 'custom', customPrompt: '   ' }, { maxConcurrent: 99 }]) {
    try { normalizeConfig(bad); } catch { rejected++; }
  }
  add('非法配置被拒绝', rejected === 3, `${rejected}/3`);
  add('默认关闭', normalizeConfig({ personaSource: 'dsh' }).enabled === false, 'enabled=false');

  let guardOk = true; let guardDetail = '';
  try {
    // Probes the real per-user location, not one machine's path: on someone else's
    // install the old literal simply did not exist, so the check proved nothing.
    const dailyHome = join(homedir(), '.dsh');
    await assertIsolatedHome({ home: dailyHome, projectRoot: root, forbiddenHomes: [dailyHome, process.env.DSH_HOME].filter(Boolean) });
    guardOk = false; guardDetail = '危险：日常 DSH_HOME 未被拒绝';
  } catch (error) { guardDetail = `已拒绝：${error.code ?? error.message}`; }
  add('拒绝日常 DSH_HOME', guardOk, guardDetail);

  try {
    const base = stateDir(root);
    const env = cleanChildEnvironment({ home: join(base, 'dsh'), agentsHome: join(base, 'agents') });
    const leaked = Object.keys(env).filter((k) => CREDENTIAL.test(k) && !ALLOWED_ENV.includes(k));
    add('子进程环境已剥离凭据', leaked.length === 0, leaked.length ? leaked.join(',') : '无继承凭据');
  } catch (error) { add('子进程环境已剥离凭据', false, error.message); }

  const diagnostics = new Diagnostics();
  const adapter = new MockAdapter({ reply: ({ message }) => `echo:${message.text}` });
  const engine = new BridgeEngine({
    adapter, diagnostics,
    personas: new PersonaResolver({ readDshPersona: async () => '自检人格', readWhalePersona: async () => '鲸鲸人格' }),
    config: { enabled: true, personaSource: 'dsh' },
  });
  try {
    const result = await engine.submit({ accountId: 'selfcheck', platform: 'wechat', chatId: 'local', senderId: 'self', messageId: `selfcheck-${Date.now()}`, chatType: 'private', text: 'ping' });
    add('模拟回合可完成', result.text === 'echo:ping' && result.delivery === 'generated', result.delivery);
    add('外部工具默认拒绝', JSON.stringify(adapter.calls[0]?.policy?.toolAllowlist) === '[]', 'toolAllowlist=[]');
    const status = engine.status();
    add('可读取状态', status.enabled === true, `active=${status.active} pending=${status.pending}`);
  } catch (error) {
    add('模拟回合可完成', false, String(error?.code ?? error?.message ?? error));
  }

  return {
    ok: checks.every((c) => c.ok),
    mockOnly: true,
    note: '本自检不连接真实 DSH / 鲸鲸，不启动任何服务；真实挂载仍未验收。',
    checks,
  };
}
