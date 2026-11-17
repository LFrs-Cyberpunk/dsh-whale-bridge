/**
 * Host half of dsh-whale-bridge.
 *
 * Deliberately inert: `apply()` wires nothing. A real host must pass its own
 * bridge instance through `createHostAdapter` and register the returned routes.
 * This module never starts DSH, never dials a live endpoint, never reads the
 * user's profile, and holds no defaults that could enable the bridge on load.
 */
import { normalizeConfig } from '../src/core.mjs';
import { assemblePersona, normalizePersona, personaBudget, personaFilled, PERSONA_FIELDS, PERSONA_GROUPS, PERSONA_LIMITS } from '../src/persona.mjs';

export const name = 'whale-bridge-settings';
export const inject = [];
export function apply() {
  // no-op by design: no service, no route, no mount side effect.
}

const ROUTES = Object.freeze({
  config: '/plugins/dsh-whale-bridge/config',
  status: '/plugins/dsh-whale-bridge/status',
  selfcheck: '/plugins/dsh-whale-bridge/selfcheck',
  errors: '/plugins/dsh-whale-bridge/errors',
  persona: '/plugins/dsh-whale-bridge/persona',
  memory: '/plugins/dsh-whale-bridge/memory',
  grow: '/plugins/dsh-whale-bridge/grow',
  service: '/plugins/dsh-whale-bridge/service',
});

// Which service fields the settings page may change. Address and token are NOT
// here: they are produced by the running bridge and written into the Whale plugin
// itself, so exposing them as editable would just invite a mismatch.
const SERVICE_KEYS = ['autoStart', 'enabled', 'timeoutMs', 'model', 'reasoningEffort', 'adapter', 'apiKey', 'baseUrl', 'dshHome'];
const ADAPTERS = ['mock', 'acp'];
// The API key is write-only: the settings page never gets it echoed back.
// Model choices come from the daily DSH config; these are the two the user asked
// for, plus the effort levels DSH itself exposes.
const EFFORTS = ['off', 'low', 'medium', 'high'];

const CONFIG_KEYS = ['enabled', 'personaSource', 'customPrompt', 'customPersona', 'timeoutMs', 'maxPendingPerChat', 'maxConcurrent'];

class RouteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * @param {{ bridge: {configure:Function,status:Function,config?:object},
 *           diagnostics: {list:Function},
 *           selfcheck?: () => Promise<object>,
 *           store?: {save?: (cfg:object)=>Promise<void>} }} deps
 */
export function createHostAdapter(deps) {
  if (!deps?.bridge || typeof deps.bridge.configure !== 'function' || typeof deps.bridge.status !== 'function') {
    throw new Error('createHostAdapter: bridge 缺少 configure/status');
  }
  const { bridge, diagnostics, selfcheck, store, memory, supervisor, serviceStore, prepareModel, resolveEnv, readSync, onConfigChanged } = deps;

  /**
   * Everything the settings page needs about the bridge process, plus the Whale
   * plugin config it keeps in sync. Address and token are shown read-only because
   * the bridge owns them.
   */
  async function serviceView() {
    const svc = supervisor?.status?.() ?? { running: false, desired: false };
    let whale = { available: false, path: null };
    try {
      const info = await syncInfo?.();
      if (info) whale = info;
    } catch { /* shown as unavailable */ }
    // Last plugin-sync result. Reported separately from lastError on purpose: a
    // successful sync is good news, and good news must not look like a failure.
    let sync = null;
    try { sync = (await readSync?.()) ?? null; } catch { /* first run */ }
    return {
      ok: true,
      running: Boolean(svc.running),
      desired: Boolean(svc.desired),
      autoStart: Boolean(serviceStore?.get?.('autoStart') ?? false),
      enabled: Boolean(serviceStore?.get?.('enabled') ?? true),
      timeoutMs: Number(serviceStore?.get?.('timeoutMs') ?? 40000),
      model: serviceStore?.get?.('model') ?? '',
      reasoningEffort: serviceStore?.get?.('reasoningEffort') ?? '',
      efforts: EFFORTS,
      adapters: ADAPTERS,
      adapter: serviceStore?.get?.('adapter') ?? 'mock',
      baseUrl: serviceStore?.get?.('baseUrl') ?? 'https://api.deepseek.com',
      // Never echo the key. Only whether one exists, so the form can say "already set".
      hasApiKey: Boolean(serviceStore?.get?.('apiKey')),
      dshHome: serviceStore?.get?.('dshHome') ?? '',
      address: svc.listening ?? null,
      hasToken: Boolean(svc.hasToken),
      pid: svc.pid ?? null,
      restarts: svc.restarts ?? 0,
      lastError: svc.lastError ?? null,
      tail: svc.tail ?? '',
      sync,
      whale,
      note: '地址和令牌由桥接自动写入鲸鲸插件，不用手填。这里改了超时会同步过去。',
    };
  }

  let syncInfo = null;

  async function patchService(patch = {}) {
    if (!supervisor) throw new RouteError(501, 'NO_SUPERVISOR', '此环境没有桥接进程管理器');
    const clean = {};
    for (const key of SERVICE_KEYS) if (patch[key] !== undefined) clean[key] = patch[key];
    if (clean.timeoutMs !== undefined) {
      const ms = Number(clean.timeoutMs);
      if (!Number.isInteger(ms) || ms < 3000 || ms > 300000) throw new RouteError(400, 'BAD_TIMEOUT', '超时必须在 3000–300000 毫秒之间');
      clean.timeoutMs = ms;
    }
    for (const key of ['autoStart', 'enabled']) if (clean[key] !== undefined) clean[key] = Boolean(clean[key]);
    if (clean.reasoningEffort !== undefined && !EFFORTS.includes(clean.reasoningEffort)) {
      throw new RouteError(400, 'BAD_EFFORT', '推理等级只能是 ' + EFFORTS.join(' / '));
    }
    if (clean.model !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(String(clean.model))) {
      throw new RouteError(400, 'BAD_MODEL', '模型名不合法');
    }
    if (clean.adapter !== undefined && !ADAPTERS.includes(clean.adapter)) {
      throw new RouteError(400, 'BAD_ADAPTER', '后端只能是 ' + ADAPTERS.join(' / '));
    }
    if (clean.baseUrl !== undefined) {
      let parsed = null;
      try { parsed = new URL(String(clean.baseUrl)); } catch { /* rejected below */ }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new RouteError(400, 'BAD_BASE_URL', '地址必须是 http/https 开头');
    }
    if (clean.apiKey !== undefined) {
      const key = String(clean.apiKey).trim();
      // Empty means "leave whatever is stored alone", so the form can be re-saved
      // without retyping the key.
      if (key === '') delete clean.apiKey;
      else if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw new RouteError(400, 'BAD_API_KEY', 'API Key 看起来不对（不能有空格）');
      else clean.apiKey = key;
    }
    await serviceStore?.patch?.(clean);

    // Turning on the real backend needs a model config written into the isolated
    // profile first, otherwise the child starts and immediately has no model.
    let modelNote = null;
    if (clean.enabled === true) {
      const cfg = await Promise.resolve(serviceStore?.get?.('adapter') === 'acp' ? serviceStore : null);
      modelNote = await prepareModel?.({
        adapter: clean.adapter ?? cfg?.adapter ?? 'mock',
        apiKey: clean.apiKey ?? cfg?.apiKey ?? '',
        baseUrl: clean.baseUrl ?? cfg?.baseUrl,
        model: clean.model ?? cfg?.model,
        reasoningEffort: clean.reasoningEffort ?? cfg?.reasoningEffort,
        dshHome: clean.dshHome ?? cfg?.dshHome,
      });
    }

    // "enabled" is the user's switch: it starts or stops the child.
    //
    // Model settings are read by the child process at spawn time, so saving them
    // while it runs changes nothing until a restart — that is exactly how a user
    // ends up selecting "real thinking" and still getting echo replies. So when
    // only model settings changed and the child is up, restart it here.
    const RESTART_KEYS = ['adapter', 'model', 'reasoningEffort', 'apiKey', 'baseUrl'];
    const modelOnly = clean.enabled === undefined && RESTART_KEYS.some((k) => clean[k] !== undefined);
    if (modelOnly && supervisor.status?.().running) {
      await prepareModel?.({
        adapter: serviceStore?.get?.('adapter') ?? 'mock',
        apiKey: serviceStore?.get?.('apiKey') ?? '',
        baseUrl: serviceStore?.get?.('baseUrl'),
        model: serviceStore?.get?.('model'),
        reasoningEffort: serviceStore?.get?.('reasoningEffort'),
        dshHome: serviceStore?.get?.('dshHome'),
      });
      await supervisor.stop();
      await supervisor.start({ env: await resolveEnv?.() ?? undefined });
    } else if (clean.enabled !== undefined) {
      await (clean.enabled ? supervisor.start({ env: await resolveEnv?.() ?? undefined }) : supervisor.stop());
    }
    // Push timeout into the Whale plugin so it matches what the bridge enforces.
    if (clean.timeoutMs !== undefined && supervisor.listening) {
      await syncInfo?.({ timeoutMs: clean.timeoutMs });
    }
    const view = await serviceView();
    return modelNote ? { ...view, modelConfig: modelNote } : view;
  }

  /** Memory view: counts and the grown persona, with the cost rule attached. */
  async function memoryView() {
    if (!memory) return { ok: true, available: false, note: '记忆未启用：未注入 MemoryStore' };
    const stats = await memory.stats?.();
    return {
      ok: true,
      available: true,
      persona: memory.persona || '',
      limits: { ...memory.limits },
      stats: stats ?? null,
      note: '情节记忆按会话分桶、不压缩。只有消息里出现「还记得 / 上次 / 之前」这类回溯信号时才注入，整块上限 700 字。',
    };
  }

  /** Lets the host inject the function that writes into Whale's plugin config. */
  function setSync(fn) { syncInfo = fn; return api(); }

  /** Persona schema + live preview, computed from the SAME code the engine uses. */
  function personaView(config) {
    const raw = config?.customPersona ?? {};
    const assembled = assemblePersona(raw);
    return {
      ok: true,
      fields: PERSONA_FIELDS.map((f) => ({ ...f })),
      groups: PERSONA_GROUPS.map((g) => ({ ...g })),
      limits: { ...PERSONA_LIMITS },
      value: normalizePersona(raw),
      progress: personaFilled(raw),
      budget: personaBudget(raw),
      preview: assembled,
      // Tell the truth about what this text can and cannot override.
      scope: config?.personaSource === 'custom' ? 'injected-first-message' : 'inactive',
      note: '这段文字只是背景说明，不会替换 DSH 自己的人格设置。想让它成为唯一的设定，就别在 DSH 那边再挂一份人设，否则两边会同时说话。',
    };
  }

  async function getConfig() { return { ok: true, config: sanitizeConfig(bridge.config ?? bridge.status()?.config ?? {}) }; }

  async function patchConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RouteError(400, 'BAD_REQUEST', '配置必须是对象');
    const current = bridge.config ?? {};
    // Only known keys are accepted; anything else is rejected rather than ignored.
    for (const key of Object.keys(patch)) if (!CONFIG_KEYS.includes(key)) throw new RouteError(400, 'UNKNOWN_FIELD', `未知字段：${key}`);
    const next = normalizeConfig({ ...current, ...patch });
    if (store && typeof store.save !== 'function') throw new RouteError(500, 'CONFIG_STORE_INVALID', '人格配置存储缺少 save 接口');
    if (store) await store.save(next);
    bridge.configure(next);
    await onConfigChanged?.(next, current);
    const config = sanitizeConfig(bridge.config ?? next);
    return { ok: true, config, persona: personaView(bridge.config ?? next) };
  }

  const api = {
    routes: ROUTES,
    setSync,
    async handle(method, path, body) {
      if (method === 'GET' && path === ROUTES.status) {
      const local = bridge.status();
      const live = await supervisor?.liveStatus?.().catch(() => null);
      return { ok: true, status: live ? { ...local, ...live } : local };
    }
      if (method === 'GET' && path === ROUTES.config) return getConfig();
      if (method === 'PATCH' && path === ROUTES.config) return patchConfig(body);
      if (method === 'GET' && path === ROUTES.persona) return personaView(bridge.config ?? {});
      if (method === 'GET' && path === ROUTES.memory) return memoryView();
      if (method === 'GET' && path === ROUTES.service) return serviceView();
      if (method === 'PATCH' && path === ROUTES.service) return patchService(body);
      if (method === 'POST' && path === ROUTES.grow) {
        if (!memory?.grow) return { ok: false, code: 'MEMORY_UNAVAILABLE' };
        // Growth is occasional by design; the button is the manual trigger.
        const grown = await memory.grow();
        return { ok: true, grown, memory: await memoryView() };
      }
      if (method === 'GET' && path === ROUTES.errors) return { ok: true, errors: diagnostics?.list?.() ?? [] };
      if (method === 'POST' && path === ROUTES.selfcheck) {
        if (typeof selfcheck !== 'function') return { ok: false, code: 'SELFCHECK_UNAVAILABLE' };
        return await selfcheck();
      }
      throw new RouteError(404, 'NOT_FOUND', '未知路由');
    },
  };
  return api;
}

// Never echo the persona body in status lists; the settings form loads it separately.
function sanitizeConfig(config) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}
