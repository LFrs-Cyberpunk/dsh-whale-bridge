#!/usr/bin/env node
/**
 * Wires engine + local proxy + settings host adapter into one process.
 *
 * Defaults to the INERT mock adapter. It only binds a loopback port when you run
 * this script explicitly; importing it does nothing. There is no code path here
 * that attaches to the daily DSH, and the ACP adapter is opt-in via
 * WHALE_BRIDGE_ADAPTER=acp plus an explicit isolated DSH_HOME.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { BridgeEngine, PersonaResolver, normalizeConfig } from '../src/core.mjs';
import { Diagnostics } from '../src/diagnostics.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';
import { createProxyServer } from '../src/proxy.mjs';
import { createHostAdapter } from '../plugin/index.js';
import { assertIsolatedHome, cleanChildEnvironment } from '../src/isolation.mjs';
import { BridgeError } from '../src/core.mjs';
import { runSelfcheck } from './selfcheck-core.mjs';
import { shareModelConfig } from './share-model-config.mjs';
import { stateDir } from '../src/state-dir.mjs';
import { loadBridgeConfig } from '../src/settings-store.mjs';
import { preparePersonaProfile } from '../src/persona-profile.mjs';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the user's own DSH profile lives.
 *
 * Never hard-coded: the old literal path only existed on the author's machine, so
 * on anyone else's install the plugin sync and the model-config share silently did
 * nothing. DSH_HOME wins when set; otherwise the standard per-user location.
 */
function liveProfilePath() {
  const override = String(process.env.WHALE_BRIDGE_LIVE_PROFILE || '').trim();
  if (override) return override;
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
  return join(home, 'profiles', 'desktop');
}

/**
 * Stable token: env var wins, else the saved file, else a fresh one that is saved.
 * The user configures Whale-Girl ONCE; restarts keep working.
 */
export async function bridgeToken(projectRoot = root) {
  const fromEnv = String(process.env.WHALE_BRIDGE_TOKEN ?? '').trim();
  if (fromEnv.length >= 24) return fromEnv;
  const file = join(stateDir(projectRoot), 'bridge-token.txt');
  try {
    const saved = (await readFile(file, 'utf8')).trim();
    if (saved.length >= 24) return saved;
  } catch { /* first run */ }
  const made = randomBytes(24).toString('hex');
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, made + '\n', 'utf8');
  } catch { /* still usable for this run */ }
  return made;
}

export function buildStack({ adapter, config = {}, logDir = null, notify = null, memory = null, token = null, refreshConfig = null } = {}) {
  const diagnostics = new Diagnostics({ directory: logDir, notify });
  const engine = new BridgeEngine({
    adapter: adapter ?? new MockAdapter(),
    diagnostics,
    personas: new PersonaResolver({
      // Reading the DSH persona is the host's job; this scaffold refuses to guess.
      readDshPersona: async () => { throw new Error('DSH 人格来源未接线'); },
      readWhalePersona: async () => { throw new Error('鲸鲸人格走请求内 system，不需要读文件'); },
    }),
    config: { enabled: false, ...config },
  });
  /**
   * The token must survive a restart, or the user has to re-enter it in Whale-Girl
   * every single time — which is exactly the kind of thing that makes people stop
   * using a tool. Order: explicit env var > saved file > new one (saved).
   */
  const finalToken = token ?? randomBytes(24).toString('hex');
  const proxy = createProxyServer({ engine, diagnostics, token: finalToken, refreshConfig });
  const host = createHostAdapter({
    bridge: engine,
    diagnostics,
    // Without this the settings page's memory block would report "未启用" forever,
    // even though the store is live. Easy seam to miss.
    memory,
    // Real self-check: same code the CLI runs, still local-only.
    selfcheck: () => runSelfcheck({ projectRoot: root }),
  });
  return { engine, diagnostics, proxy, host, token: finalToken, memory };
}

/**
 * Write the bridge address and token into the plugin's own data directory, so the
 * user never has to hand-edit JSON. This only ever touches
 * `<whale>/data/plugins/<id>.data/config.json` — the directory the plugin owns —
 * and it preserves any other keys the user already set (like `enabled`).
 *
 * Best effort: if Whale-Girl is not installed here, it writes nothing.
 */
/**
 * Where Whale-Girl keeps its data.
 *
 * Never hard-coded: Whale-Girl can be installed on any drive, so the old literal
 * path meant the address and token were never written on anyone else's machine and
 * the user had to type them in by hand. Order: explicit env → remembered path →
 * a shallow drive scan → give up (the bridge still runs, only the auto-fill fails).
 */
export async function whaleDataDir() {
  const explicit = String(process.env.WHALE_DATA_DIR || '').trim();
  if (explicit) return explicit;
  const cacheFile = join(stateDir(root), 'whale-path.json');
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (cached?.dataDir) {
      await access(join(cached.dataDir, 'plugins'));
      return cached.dataDir;
    }
  } catch { /* not cached yet */ }
  // Shallow scan: <drive>:\<folder>\WhaleGirl\data and <drive>:\<folder>\<folder>\WhaleGirl\data
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const driveRoot = letter + ':\\';
    let entries = [];
    try { entries = readdirSync(driveRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidates = [
        join(driveRoot, entry.name, 'WhaleGirl', 'data'),
        join(driveRoot, entry.name, 'Whale-Girl', 'WhaleGirl', 'data'),
      ];
      for (const dir of candidates) {
        try {
          await access(join(dir, 'plugins'));
          try {
            await mkdir(stateDir(root), { recursive: true });
            await writeFile(cacheFile, JSON.stringify({ dataDir: dir }, null, 2) + '\n', 'utf8');
          } catch { /* cache is optional */ }
          return dir;
        } catch { /* try next */ }
      }
    }
  }
  return '';
}

export async function syncPluginConfig({ url, token, whaleData = null, personaSource = null } = {}) {
  const dir0 = whaleData || (await whaleDataDir());
  if (!dir0) return { file: null, written: false, reason: '没找到鲸鲸的安装位置，跳过（不影响桥接运行）' };
  const whaleDataResolved = dir0;
  const dir = join(whaleDataResolved, 'plugins', 'whale-dsh-bridge.data');
  const file = join(dir, 'config.json');
  const result = { file, written: false, reason: '' };
  try {
    await access(join(whaleDataResolved, 'plugins'));
  } catch {
    result.reason = '找不到鲸鲸插件目录，跳过（不影响桥接运行）';
    return result;
  }
  let current = {};
  try { current = JSON.parse(await readFile(file, 'utf8')); } catch { /* first time */ }
  const next = { enabled: true, timeoutMs: 40000, ...current, url, token,
    ...(personaSource ? { personaSource } : {}) };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    result.written = true;
  } catch (error) {
    result.reason = String(error?.message ?? error);
  }
  return result;
}

/**
 * Read the saved service settings straight from disk.
 *
 * WHY: the parent process is supposed to pass the adapter through the environment,
 * but a stale parent (older plugin build still loaded in DSH) sends nothing useful
 * and every message silently comes back from the echo adapter. Reading the config
 * here makes the child correct on its own, without depending on what the parent
 * build happens to export. Environment values still win when present.
 */
async function savedService() {
  try {
    const raw = await readFile(join(stateDir(root), 'service.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/**
 * Locate the directory holding `dsh.cmd`.
 *
 * The child's own execPath is node, not the desktop app, so it cannot be derived
 * from there. The desktop app is normally installed under a folder whose name
 * starts with "DeepSeek Harness", so every drive root is checked one level deep —
 * a shallow scan, not a full walk. An empty result is reported loudly instead of
 * letting the bridge pose as the echo adapter.
 */
function findLauncher() {
  const override = String(process.env.WHALE_BRIDGE_DSH_LAUNCHER || '').trim();
  if (override) return override;
  const tails = [
    ['resources', 'runtime', 'cli', 'bin'],
    ['app', 'resources', 'runtime', 'cli', 'bin'],
  ];
  const tryDir = (base) => {
    for (const tail of tails) {
      const dir = join(base, ...tail);
      try { if (existsSync(join(dir, 'dsh.cmd'))) return dir; } catch { /* next */ }
    }
    return '';
  };
  // 1) Folders the environment already names.
  const seeded = [
    process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
  ].filter(Boolean).flatMap((base) => [
    join(base, 'DeepSeek Harness桌面端', 'DeepSeek Harness 官方端'),
    join(base, 'DeepSeek Harness', 'DeepSeek Harness 官方端'),
    join(base, 'Programs', 'DeepSeek Harness'),
  ]);
  for (const dir of seeded) { const hit = tryDir(dir); if (hit) return hit; }
  // 2) One level under every drive root.
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const letter of letters) {
    const driveRoot = letter + ':\\';
    let entries = [];
    try { entries = readdirSync(driveRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^deepseek\s*harness/i.test(entry.name)) continue;
      const top = join(driveRoot, entry.name);
      const direct = tryDir(top);
      if (direct) return direct;
      // <install>/<官方端 or EAC 等子目录>
      let subs = [];
      try { subs = readdirSync(top, { withFileTypes: true }); } catch { continue; }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const hit = tryDir(join(top, sub.name));
        if (hit) return hit;
      }
    }
  }
  return '';
}

async function main() {
  const saved = await savedService();
  const configFile = join(stateDir(root), 'config.json');
  const initialConfig = await loadBridgeConfig(configFile, {
    enabled: Boolean(saved.enabled), timeoutMs: saved.timeoutMs ?? 40000,
  });
  // The settings file is the source of truth: the user picked the adapter there.
  // The parent process only supplies it for convenience, and a stale parent build
  // can send "mock" long after the user chose "acp" — which is exactly how the
  // panel showed real thinking while every reply still came from the echo adapter.
  const fromFile = String(saved.adapter || '').trim();
  const fromEnv = String(process.env.WHALE_BRIDGE_ADAPTER || '').trim();
  const mode = fromFile || fromEnv || 'mock';
  let adapter;
  let extra = null;
  let memory = null;
  if (mode === 'mock') adapter = new MockAdapter();
  else if (mode === 'acp') {
    const home = String(saved.dshHome || '').trim() || process.env.WHALE_BRIDGE_DSH_HOME;
    // Refuses the daily homes outright: this adapter only ever talks to a child
    // it starts itself, under a throwaway DSH_HOME.
    //
    // projectRoot is the STATE dir, not the package: state moved out of
    // node_modules so a plugin update cannot delete it. The guard still enforces
    // "inside the root, never the root itself", which keeps the daily profile
    // untouchable. Forbidden homes are computed, never hard-coded — the old
    // literal only ever made sense on the machine that wrote it.
    await assertIsolatedHome({
      home,
      projectRoot: stateDir(root),
      forbiddenHomes: [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean),
    });
    // Give the isolated host the same tools the daily DSH has: no tools means the
    // bridge is only a more expensive model, which defeats its purpose. Runs on
    // every start so newly installed plugins show up without touching anything.
    try {
      const { syncPlugins } = await import('../src/profile-sync.mjs');
      const synced = await syncPlugins({
        isolatedProfile: join(home, 'profiles', 'acp'),
        mainProfile: liveProfilePath(),
        personaSource: initialConfig.personaSource,
      });
      // Written to a file, never to stderr: the supervisor treats every stderr byte
      // as a failure, so a normal progress line would show up on the settings page
      // as a red error. Only real failures go to stderr below.
      await writeFile(
        join(stateDir(root), 'last-sync.json'),
        JSON.stringify({ at: new Date().toISOString(), ...synced }, null, 2) + '\n',
        'utf8',
      );
    } catch (error) {
      // A failed sync must not take the bridge down: fewer tools beats no reply.
      process.stderr.write(`插件同步失败：${String(error?.message || error)}\n`);
    }
    const { AcpClient } = await import('../src/adapters/acp.mjs');
    const { AcpBackend } = await import('../src/adapters/acp-backend.mjs');
    // Memory lives beside the isolated home, never inside the daily profile.
    const { MemoryStore } = await import('../src/memory.mjs');
    memory = new MemoryStore({ root: join(stateDir(root), 'memory') });
    // The settings page writes a self-contained model block into the isolated
    // profile when the user supplies a key. Only fall back to copying the daily
    // profile when nothing has been written yet — otherwise we would overwrite
    // the model the user just chose.
    // Resolve the launcher once; an empty value means the child cannot start, and
    // that must be visible instead of turning into a silent echo fallback.
    const launcherDir = findLauncher();
    if (!launcherDir) throw new BridgeError('ACP_LAUNCHER_MISSING', '找不到 dsh.cmd：隔离 DSH 无法启动。请把 DSH 安装目录写到环境变量 WHALE_BRIDGE_DSH_LAUNCHER（指向包含 dsh.cmd 的文件夹）');
    const isolatedPatch = join(home, 'profiles', 'acp', 'cordis.patch.yml');
    let shared = { ok: false, reason: '使用设置页写入的模型配置', envNames: [] };
    let hasOwnConfig = false;
    try { await access(isolatedPatch); hasOwnConfig = true; } catch { /* not written yet */ }
    if (!hasOwnConfig) {
      const liveProfile = liveProfilePath();
      shared = await shareModelConfig({
        liveProfile,
        isolatedProfile: join(home, 'profiles', 'acp'),
        model: process.env.WHALE_BRIDGE_MODEL || undefined,
        reasoningEffort: process.env.WHALE_BRIDGE_EFFORT || undefined,
      }).catch((error) => ({ ok: false, reason: String(error?.message ?? error), envNames: [] }));
    }
    // The exclusion list is the ONLY thing the bridge decides about plugins: a
    // GUI bundle cannot render in a headless ACP host and this bridge must not
    // load itself. Everything else rides along, so whichever plugin the user
    // grew their persona with — today's, tomorrow's, or one nobody has written
    // yet — arrives in the isolated host with its config intact.
    //
    // `web-server` is deliberately NOT excluded: it is a service, not a shell, and
    // plugins such as dsh-agent-md inject it. Dropping it is what made AGENT.md
    // unreachable before, so it must stay.
    const { GUI_ONLY } = await import('../src/profile-sync.mjs');
    const personaProfile = await preparePersonaProfile({
      home,
      mainProfile: liveProfilePath(),
      source: initialConfig.personaSource,
      excludeIds: [...GUI_ONLY, 'web-app'],
    });
    // Strip inherited credentials first; then re-add ONLY the names the model
    // config actually needs, plus the key the user typed into the settings page.
    const childEnv = cleanChildEnvironment({
      home,
      agentsHome: home + '-agents',
      allowEnvNames: shared.envNames ?? [],
      // Only the name OUR provider block references. DEEPSEEK_API_KEY used to be
      // injected as well, which made turns succeed while silently going to the
      // built-in deepseek-official route — the models page looked configured and
      // was in fact ignored. Now that the isolated patch pins `id: acp` to
      // `whale-bridge`, a wrong route fails loudly instead of working by accident.
      inject: process.env.WHALE_BRIDGE_LLM_KEY
        ? { WHALE_BRIDGE_LLM_KEY: process.env.WHALE_BRIDGE_LLM_KEY }
        : {},
    });
    if (process.env.LOCAL_FAKE_KEY) childEnv.LOCAL_FAKE_KEY = process.env.LOCAL_FAKE_KEY;
    const client = await new AcpClient({
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/c', join(launcherDir, 'dsh.cmd'), '--profile', 'acp'],
      cwd: home,
      env: childEnv,
      requestTimeoutMs: 90000,
    }).start();
    adapter = new AcpBackend({
      client,
      workspaceRoot: home,
      memory,
      // Session ids go to disk so a restarted bridge reattaches to the same DSH
      // conversation instead of starting a blank one.
      statePath: join(stateDir(root), 'bridge-sessions.json'),
    });
    extra = { personaProfile, acpAgent: client.agentInfo?.name ?? null, shutdown: () => client.close() };
  } else throw new Error('未知 WHALE_BRIDGE_ADAPTER');

  const refreshConfig = async (engine) => {
    const config = await loadBridgeConfig(configFile, {
      enabled: Boolean(saved.enabled), timeoutMs: saved.timeoutMs ?? 40000,
    });
    if (config.personaSource !== initialConfig.personaSource) {
      throw new BridgeError('PERSONA_RESTART_REQUIRED', '人格来源已变更，需要重启桥接子进程；不会使用旧人格', 503);
    }
    if (JSON.stringify(config) !== JSON.stringify(engine.config)) engine.configure(config);
  };
  const stack = buildStack({ adapter, memory, token: await bridgeToken(root), config: initialConfig,
    refreshConfig, logDir: join(stateDir(root), 'logs') });
  const info = await stack.proxy.listen();
  const tokenFile = join(stateDir(root), 'bridge-token.txt');
  // Point the Whale plugin at this run automatically. Without it the user has to
  // find and hand-edit a JSON file inside Whale's data directory.
  const plugin = await syncPluginConfig({ url: info.baseUrl, token: stack.token, personaSource: initialConfig.personaSource });
  process.stdout.write(JSON.stringify({
    listening: info.baseUrl,
    // This token is stable across restarts (env var or .test-home/bridge-token.txt),
    // so Whale-Girl only has to be configured once.
    token: stack.token,
    tokenFile,
    pluginConfig: plugin.written ? plugin.file : null,
    pluginConfigNote: plugin.written
      ? '已把地址和令牌写进鲸鲸插件配置，插件装好后不用手填'
      : plugin.reason,
    usage: '鲸鲸的模型服务：地址填 listening，Key 填 token（必须填，否则她不发 Authorization 头）',
    adapter: mode,
    enabled: stack.engine.status().enabled,
    note: mode === 'acp'
      ? '已连到隔离 DSH（ACP）。回复来自那个隔离宿主，不是 mock。'
      : '当前是 mock 后端：能验证鲸鲸→代理→engine 的链路，不代表 DSH 已接通。',
    ...(extra?.acpAgent ? { acpAgent: extra.acpAgent } : {}),
  }, null, 2) + '\n');
  const shutdown = async () => {
    await stack.proxy.close();
    await extra?.shutdown?.().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exit(1); });
}
