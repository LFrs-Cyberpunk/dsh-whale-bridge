/**
 * Give the isolated ACP host the same plugins the daily DSH uses.
 *
 * WHY THIS EXISTS: the bridge runs its own DSH process so a chat message can never
 * touch the user's own sessions. But a bare profile means the answering model has
 * no tools — no meme wiki, no web search, no image generation — so "real thinking"
 * was just a more expensive model with less to work with. That defeats the point.
 *
 * WHAT IT DOES: copies the daily profile's plugin list and points the isolated
 * profile at the same node_modules (a junction, not a copy — the code stays in one
 * place and updates once). Both steps are idempotent, so it can run on every start.
 *
 * WHAT IT SKIPS: plugins that only exist to draw the GUI. Loading them in a
 * headless ACP host ranges from useless to fatal, and one bad plugin takes the
 * whole host down.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Bundles that must NOT be loaded in the ACP host.
 *
 * Two reasons only: it is a GUI shell (nothing to render, may crash on a missing
 * DOM), or it is this bridge itself (loading it inside its own child would be a
 * loop). Everything absent from this list is passed through — that keeps the list
 * short and means new tool plugins work without touching this file.
 */
export const GUI_ONLY = [
  '@deepseek-ai/dsh-web-app',
  'dsh-whale-bridge',
  '@vlln/dsh-navbar',
  'dsh-composer-dynamic-island',
  'dsh-cot-peek',
  'dsh-dock-settings',
  'dsh-message-rewind',
  'dsh-navbar',
  'dsh-pet',
  'dsh-phone',
  'dsh-raw-html',
  'dsh-raw-html-v2',
  'dsh-session-manager',
  'dsh-settings-scroll-fix',
  'dsh-think-zh-expand-eac',
  'dsh-unified-market',
  'dsh-web-mobile-fix',
  'dsh-webui-prompt-optimizer',
  'dsh-whale-widget',
  'dsh-better-sidebar',
  'dsh-skin-market',
  '@nagi-ovo/dsh-visualize',
  'dsh-dafeiyu',
  'dsh-compact',
  'meow-smooth',
];

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function isDir(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/**
 * Point `<isolated>/node_modules` at the daily profile's node_modules.
 * A junction keeps one copy of every plugin: the child loads exactly the code the
 * user already has, including local `link:` plugins outside the profile.
 */
async function linkNodeModules(isolatedProfile, mainProfile) {
  const link = join(isolatedProfile, 'node_modules');
  const source = join(mainProfile, 'node_modules');
  if (!(await isDir(source))) return { linked: false, reason: 'no-source' };
  if (await isDir(link)) return { linked: true, reason: 'already' };
  try {
    // /J is a directory junction: no admin rights, and it survives drive letters.
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', 'mklink', '/J', link, source], { stdio: 'ignore' });
    return { linked: true, reason: 'created' };
  } catch (error) {
    return { linked: false, reason: String(error?.message || error) };
  }
}

/**
 * Rewrite the isolated profile's manifest so it loads the daily plugin set.
 *
 * Written without a BOM on purpose: DSH parses this file with JSON.parse and a
 * BOM makes every start fail with "Unexpected token" — silent from the outside,
 * because the symptom is just "bridge exited, code 1".
 */
async function writeManifest(isolatedProfile, bundles, dependencies) {
  const manifest = {
    name: 'dsh-profile-acp',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  };
  await mkdir(isolatedProfile, { recursive: true });
  await writeFile(join(isolatedProfile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Sync the isolated profile with the daily one.
 * Returns a short report so callers can log what actually happened.
 */
export async function syncPlugins({ isolatedProfile, mainProfile, personaSource = 'dsh' }) {
  const mainManifest = await readJson(join(mainProfile, 'package.json'));
  if (!mainManifest?.dsh?.profile?.bundles) return { synced: false, reason: 'main-profile-unreadable' };

  const daily = mainManifest.dsh.profile.bundles;
  const personaBundles = ['dsh-agent-md', 'dsh-soul-md', 'dsh-soul'];
  const keep = daily.filter((name) => !GUI_ONLY.includes(name)
    && (personaSource === 'dsh' || !personaBundles.includes(name)));
  if (keep.length === 0) return { synced: false, reason: 'nothing-to-copy' };

  const link = await linkNodeModules(isolatedProfile, mainProfile);
  const dependencies = {};
  const dailyDeps = mainManifest.dependencies || {};
  for (const name of keep) if (dailyDeps[name]) dependencies[name] = dailyDeps[name];

  // The ACP app entry is required to speak ACP at all; never drop it.
  const bundles = Array.from(new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', ...keep]));

  const before = await readJson(join(isolatedProfile, 'package.json'));
  const same = before
    && JSON.stringify(before.dsh?.profile?.bundles) === JSON.stringify(bundles);
  await writeManifest(isolatedProfile, bundles, dependencies);

  return {
    synced: true,
    changed: !same || link.reason === 'created',
    linked: link.linked,
    linkReason: link.reason,
    bundles: bundles.length,
    skipped: daily.length - keep.length,
  };
}
