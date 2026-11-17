import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { BridgeError, digest } from './core.mjs';

const BEGIN = '# BEGIN whale-bridge profile overlay';
const END = '# END whale-bridge profile overlay';
const require = createRequire(import.meta.url);

/** Config fields whose VALUES are credentials. `apiKeyEnv` is a name, not a value. */
const SECRET_FIELD = /^(apiKey|api_key|token|secret|password|accessToken|refreshToken|botToken)$/i;

/**
 * Remove credential VALUES before a plugin config is copied into the isolated
 * profile. The name of the env var is kept: it is a reference, not a secret, and
 * dropping it would break the plugin's own lookup.
 */
export function scrubSecrets(value, depth = 0) {
  if (depth > 10) return null;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_FIELD.test(key) && typeof inner === 'string' && inner.trim() !== '') continue;
      out[key] = scrubSecrets(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * EVERY plugin entry the daily profile loads, minus the ones that cannot exist in
 * a headless ACP host.
 *
 * This is the whole point of "follow DSH": the bridge must not know which plugin
 * holds the persona. dsh-soul-md, dsh-agent-md, some future plugin, or a hand
 * written one all work the same way — their config rides along and the isolated
 * DSH assembles the persona itself.
 *
 * A bridge that hard-codes two plugin names is only following ONE machine, which
 * is exactly the mistake this replaces.
 */
export function profileBlocksFromYaml(yaml, parse, { excludeIds = [], excludeNames = [] } = {}) {
  const rows = parse(yaml);
  if (!Array.isArray(rows)) throw new BridgeError('DSH_CONFIG_INVALID', 'DSH 插件配置不是补丁列表', 503);
  return rows
    .filter((row) => row && typeof row.id === 'string' && row.id !== '')
    .filter((row) => !excludeIds.includes(row.id) && !excludeNames.includes(row.name))
    .map((row) => scrubSecrets(row));
}

/**
 * Give the isolated DSH the same plugin configuration the daily one has.
 *
 * Order matters: the daily blocks come first, then OUR model block overrides
 * whatever the daily profile said about providers. That keeps the bridge's own
 * key/route authoritative while everything else is inherited verbatim.
 */
export async function preparePersonaProfile({ home, mainProfile, source, excludeIds = [], excludeNames = [] }) {
  if (!['dsh', 'whale', 'custom'].includes(source)) throw new BridgeError('BAD_PERSONA_SOURCE', '人格来源无效');
  const mainHome = resolve(mainProfile, '..', '..');
  if (resolve(home) === mainHome) throw new BridgeError('UNSAFE_DSH_HOME', '不能向日常 DSH 写配置');
  await mkdir(home, { recursive: true });
  const profileDir = join(home, 'profiles', 'acp');
  await mkdir(profileDir, { recursive: true });
  const patchFile = join(profileDir, 'cordis.patch.yml');

  // Keep whatever the model writer put there (route + key env), drop only our own
  // previous overlay. Never reserialize the model block: it is not ours to guess.
  let patch = await readFile(patchFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const start = patch.indexOf(BEGIN);
  if (start >= 0) {
    const end = patch.indexOf(END, start);
    if (end < 0) throw new BridgeError('PROFILE_OVERLAY_INVALID', '人格补丁未闭合', 503);
    patch = patch.slice(0, start) + patch.slice(end + END.length).replace(/^\r?\n/, '');
  }

  let parser = null;
  let stringify = null;
  try {
    const yamlModule = require(require.resolve('yaml', { paths: [mainProfile, profileDir] }));
    parser = yamlModule.parse;
    stringify = yamlModule.stringify;
  } catch {
    throw new BridgeError('DSH_YAML_PARSER_UNAVAILABLE', 'DSH YAML 解析器不可用；不伪造人格', 503);
  }

  let inherited = [];
  let agentLink = 'none';
  let revision = digest('none');
  if (source === 'dsh') {
    const mainYaml = await readFile(join(mainProfile, 'cordis.patch.yml'), 'utf8');
    // Our own model ids are excluded: the route must stay what the settings page
    // wrote, not what the daily profile happens to use.
    const blocks = profileBlocksFromYaml(mainYaml, parser, {
      excludeIds: [...excludeIds, 'llm-pi-ai', 'agent-default-model', 'acp'],
      excludeNames: excludeNames,
    });
    inherited = blocks;
    revision = digest(JSON.stringify(blocks));
    // Persona FILES are not copied — they are linked, so the isolated host reads
    // the very same file you edit. A copy goes stale the moment you change your
    // persona; a hardlink cannot. Hardlinks keep that without exposing the daily
    // HOME to writes: the child only ever reads this one file, and the daily
    // settings page edits it in place, so both sides see the same bytes.
    const agentSource = join(mainHome, 'AGENT.md');
    const agentTarget = join(home, 'AGENT.md');
    let linked = 'copied';
    try {
      const { link: hardlink, unlink, copyFile } = await import('node:fs/promises');
      await unlink(agentTarget).catch(() => {});
      await hardlink(agentSource, agentTarget);
      linked = 'hardlink';
    } catch {
      // Different volume (hardlinks cannot cross drives) — fall back to a copy.
      try { await writeFile(agentTarget, await readFile(agentSource, 'utf8'), 'utf8'); linked = 'copied'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    inherited.push({ id: '__agent_md__', link: linked, path: agentTarget });
    agentLink = linked;
    revision = digest(revision + agentTarget + linked);
  }
  const agentFile = agentLink;

  const overlayText = inherited.length ? stringify(inherited.filter((row) => row.id !== '__agent_md__')) : '';
  await writeFile(patchFile, patch.trimEnd() + '\n' + BEGIN + '\n' + overlayText + END + '\n', 'utf8');
  return {
    source,
    native: source === 'dsh',
    inheritedPlugins: inherited.filter((row) => row.id !== '__agent_md__').map((row) => row.id),
    inheritedCount: inherited.filter((row) => row.id !== '__agent_md__').length,
    agentFile,
    revision,
    memoryShared: false,
  };
}
