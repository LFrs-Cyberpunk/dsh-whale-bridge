/**
 * Real DSH host entry for dsh-whale-bridge.
 *
 * `apply(ctx)` is what DeepSeek Harness calls when the plugin loads. It registers
 * the settings routes and owns the bridge process, so the user never opens a
 * terminal: one switch in the settings page starts or stops it.
 *
 * WHY THE BRIDGE STAYS A CHILD PROCESS: the listener, the ACP client and the
 * memory store all live in a separate node process. A bug there can be restarted
 * by the supervisor; the same bug inside DSH's own process could take the whole
 * app down, and the user's one hard rule is that the daily DSH must not die.
 *
 * WHAT IS IN THIS PROCESS: only the settings API, the engine that validates
 * config, and the supervisor handle. No port is bound here.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { jsonStore } from '../src/settings-store.mjs';
import { fileURLToPath } from 'node:url';
import { BridgeEngine, PersonaResolver, normalizeConfig } from '../src/core.mjs';
import { Diagnostics } from '../src/diagnostics.mjs';
import { MemoryStore } from '../src/memory.mjs';
import { BridgeSupervisor } from '../src/supervisor.mjs';
import { createHostAdapter } from './index.js';
import { runSelfcheck } from '../scripts/selfcheck-core.mjs';
import { migrateStateDir, stateDir } from '../src/state-dir.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = '/plugins/dsh-whale-bridge';
// State lives in the user's home, not inside the package: an update replaces
// node_modules and used to take the model settings and memory with it.
const STATE_DIR = stateDir(PROJECT_ROOT);
// The isolated home MUST live inside the "project" root: assertIsolatedHome
// refuses anything outside it, which is what keeps the daily profile untouchable.
// STATE_DIR is passed as that root, so the guard stays strict while the storage
// itself sits outside node_modules.
const DEFAULT_DSH_HOME = join(STATE_DIR, 'dsh');
const KEY_ENV = 'WHALE_BRIDGE_LLM_KEY';

export const name = 'dsh-whale-bridge';
export const inject = ['webServer'];

/**
 * Writes the model the user picked into the ISOLATED profile.
 *
 * Why not share the daily config: the bridge runs its own DSH process, and DSH
 * model selection is per-profile. A second process has no session to inherit a
 * model from, so "just reuse it" is not a thing that exists. Typing one key here
 * is the honest version of that.
 *
 * The key itself never lands in this file: it goes to the child through an env
 * var that src/isolation.mjs only passes because the name matches the KEY rule.
 */
async function writeModelConfig({ dshHome, baseUrl, model, reasoningEffort }) {
  const dir = join(dshHome, 'profiles', 'acp');
  await mkdir(dir, { recursive: true });
  const quote = (value) => JSON.stringify(String(value));
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
    // THIS BLOCK IS THE ONE THAT MATTERS FOR A BRIDGE TURN.
    // `@deepseek-ai/dsh-acp-app/cordis.patch.yml` inserts its own `id: acp` entry
    // pinned to provider `deepseek-official` / model `deepseek-v4-flash`, and
    // `dsh-acp/lib/index.js` reads the session model from THAT entry only:
    // `session/new` passes `agentOptions(config)` built from it, and the ACP
    // `Config` has no reasoningEffort at all.
    //
    // Leaving it out (which this file used to do) meant every setting on the
    // models page was decorative: turns really went to deepseek-official and only
    // worked because the launcher injected DEEPSEEK_API_KEY as well. Proof: with
    // no key in the environment the first turn failed with
    // `no API key for provider route "deepseek-official"`.
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
  await writeFile(join(dir, 'cordis.patch.yml'), yaml, 'utf8');
  return join(dir, 'cordis.patch.yml');
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > limit) raw = raw.slice(0, limit); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function apply(ctx) {
  // Bring old state across on first start after the folder moved out of the
  // package. Fire-and-forget: a failed copy must never stop the plugin from
  // loading, and the old folder stays readable either way.
  migrateStateDir(PROJECT_ROOT).then((result) => {
    if (result.moved) console.log('[whale-bridge] state moved out of the package: ' + result.from + ' -> ' + result.to);
    else if (result.reason === 'copy-failed') console.warn('[whale-bridge] state copy failed: ' + result.error);
  }).catch(() => {});
  const state = jsonStore(join(STATE_DIR, 'service.json'), {
    enabled: false, autoStart: false, timeoutMs: 40000,
    adapter: 'mock', model: 'deepseek-flash', reasoningEffort: 'low',
    baseUrl: 'https://api.deepseek.com', apiKey: '', dshHome: DEFAULT_DSH_HOME,
  });
  // Persona settings need their own file. They used to live in memory only, so a
  // DSH restart silently reset "follow Whale-Girl" back to the placeholder text and
  // the replies went generic — the exact symptom that looks like "the persona did
  // not take effect".
  const configStore = jsonStore(join(STATE_DIR, 'config.json'), {
    enabled: false,
    personaSource: 'whale',
    customPrompt: '',
  });
  // apply() is synchronous, so the saved settings are read synchronously here and
  // handed to both the store and the engine. The store keeps them in sync later.
  let savedConfig = null;
  try {
    savedConfig = JSON.parse(readFileSync(join(STATE_DIR, 'config.json'), 'utf8'));
  } catch { /* first run: defaults below */ }
  const diagnostics = new Diagnostics({ directory: join(STATE_DIR, 'logs') });
  const memory = new MemoryStore({ root: join(STATE_DIR, 'memory') });
  const engine = new BridgeEngine({
    adapter: { kind: 'delegated', async generate() { throw new Error('桥接在独立进程里，这里不直接生成'); } },
    personas: new PersonaResolver({
      readDshPersona: async () => { throw new Error('DSH 人格来源未接线'); },
      readWhalePersona: async () => { throw new Error('鲸鲸人格走请求内 system'); },
    }),
    // Start from whatever the user last saved; the placeholder only fills a gap on
    // a brand-new install. An empty prompt is rejected by normalizeConfig, and a
    // throw here would take the whole plugin down at load time.
    config: {
      enabled: false,
      personaSource: 'whale',
      customPrompt: '（还没设置人格来源，请到设置页选一项）',
      ...(savedConfig && typeof savedConfig === 'object' ? savedConfig : {}),
    },
  });
  const supervisor = new BridgeSupervisor({ projectRoot: PROJECT_ROOT, onEvent: () => {} });

  /** Build the child environment from the saved settings, every time it starts. */
  /**
   * Find the `dsh` launcher that starts the ACP child.
   *
   * Why this exists: the bridge spawns `cmd /c <launcher dir>\dsh.cmd --profile acp`.
   * With no launcher it just runs `dsh.cmd` and hopes PATH has it — which is false
   * on a normal install, so the child exits with code 1 and every message falls
   * back to the echo adapter. Deriving it from the running app is the only way that
   * works on someone else's machine.
   *
   * Order: explicit override → the app's own resources → a nearby node_modules/.bin
   * → nothing (let PATH decide).
   */
  function findLauncher() {
    const override = String(process.env.WHALE_BRIDGE_DSH_LAUNCHER || '').trim();
    if (override) return override;
    const candidates = [];
    const exe = process.execPath || '';
    if (exe) {
      const appDir = dirname(exe);
      // Packaged desktop app: <install>/resources/runtime/cli/bin/dsh.cmd
      candidates.push(join(appDir, 'resources', 'runtime', 'cli', 'bin'));
      // Dev checkout: <checkout>/node_modules/.bin/dsh.cmd
      candidates.push(join(appDir, 'node_modules', '.bin'));
      // One level up (app sits in a subfolder of the install root).
      candidates.push(join(appDir, '..', 'resources', 'runtime', 'cli', 'bin'));
    }
    for (const dir of candidates) {
      try { if (existsSync(join(dir, 'dsh.cmd'))) return dir; } catch { /* try next */ }
    }
    return '';
  }

  async function supervisorEnv() {
    const cfg = await state.load();
    const env = { WHALE_BRIDGE_ADAPTER: cfg.adapter || 'mock' };
    if (env.WHALE_BRIDGE_ADAPTER === 'acp') {
      env.WHALE_BRIDGE_DSH_HOME = cfg.dshHome || DEFAULT_DSH_HOME;
      env.WHALE_BRIDGE_MODEL = cfg.model || 'deepseek-flash';
      env.WHALE_BRIDGE_EFFORT = cfg.reasoningEffort || 'low';
      // The name MUST match what scripts/wire-host.mjs reads. It used to be written
      // as WHALE_BRIDGE_LAUNCHER and read as WHALE_BRIDGE_DSH_LAUNCHER, so the child
      // always got an empty value no matter what the settings page said.
      env.WHALE_BRIDGE_DSH_LAUNCHER = findLauncher();
      if (cfg.apiKey) env[KEY_ENV] = cfg.apiKey;
    }
    return env;
  }

  const adapter = createHostAdapter({
    bridge: engine,
    store: configStore,
    onConfigChanged: async (next, previous) => {
      const changed = ['personaSource', 'customPrompt', 'customPersona'].some((key) => JSON.stringify(next[key]) !== JSON.stringify(previous[key]));
      if (changed && supervisor.status().running) {
        await supervisor.stop();
        await supervisor.start({ env: await supervisorEnv() });
      }
    },
    diagnostics,
    memory,
    supervisor,
    serviceStore: state,
    // Written by the child on start-up; read here so the panel can show what the
    // plugin sync actually did without dressing it up as an error.
    readSync: async () => {
      try { return JSON.parse(await readFile(join(STATE_DIR, 'last-sync.json'), 'utf8')); } catch { return null; }
    },
    selfcheck: () => runSelfcheck({ projectRoot: PROJECT_ROOT }),
    // Called by the settings route whenever the model settings change, and again
    // right before the child starts, so the isolated profile always matches the UI.
    prepareModel: async (cfg) => {
      if ((cfg.adapter || 'mock') !== 'acp') return null;
      if (!cfg.apiKey) return { ok: false, reason: '还没有填 API Key' };
      return writeModelConfig({
        dshHome: cfg.dshHome || DEFAULT_DSH_HOME,
        baseUrl: cfg.baseUrl || 'https://api.deepseek.com',
        model: cfg.model || 'deepseek-flash',
        reasoningEffort: cfg.reasoningEffort || 'low',
      }).then((file) => ({ ok: true, file })).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    },
    resolveEnv: supervisorEnv,
  });

  const webServer = ctx?.webServer ?? ctx?.get?.('webServer');
  if (webServer) {
    // ctx.effect gives the host a disposer, so toggling the plugin off or hot
    // reloading does not collide with an already-registered route.
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = String(req.url || '');
        const pathname = url.split('?')[0];
        // adapter.handle matches FULL paths (ROUTES are absolute), so pass the
        // pathname through instead of stripping the prefix.
        const method = String(req.method || 'GET').toUpperCase();
        try {
          const body = method === 'GET' || method === 'HEAD' ? {} : await readBody(req);
          const result = await adapter.handle(method, pathname, body);
          send(res, 200, result);
        } catch (error) {
          send(res, error?.status ?? 500, { ok: false, code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });
        }
      },
    }));
  }

  // Honour the saved switch on startup, but never block plugin load on it.
  state.load().then(async (cfg) => {
    if (cfg.enabled && cfg.autoStart) await supervisor.start().catch(() => {});
  }).catch(() => {});

  ctx.effect?.(() => () => { supervisor.stop().catch(() => {}); });
}

export { createHostAdapter };
