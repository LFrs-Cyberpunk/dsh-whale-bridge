/**
 * Where the bridge keeps its own state.
 *
 * WHY NOT INSIDE THE PLUGIN: it used to live at `<plugin>/.test-home`. That folder
 * sits under node_modules, so updating or reinstalling the plugin deleted the
 * model settings, the memory store and every isolated session — a silent data loss
 * the user only notices after the fact. The state has to outlive the package.
 *
 * WHY THE CALLER STILL PASSES projectRoot: the isolation guard refuses a DSH_HOME
 * outside the project root, which is the rule that keeps the daily profile
 * untouchable. Callers therefore pass the state dir as their project root; that
 * keeps the guard strict while moving the storage out of node_modules.
 */
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';

/** Directory name used under the user's home. */
const DIR_NAME = '.whale-dsh-bridge';
/** The old in-package location, kept only so existing installs can migrate. */
const LEGACY_DIR_NAME = '.test-home';

/**
 * Resolve the state directory.
 * Order: explicit env override → user home → legacy in-package folder.
 * The last fallback matters on locked-down machines with no home directory: it is
 * worse (data can be wiped by an update) but still better than refusing to start.
 */
export function stateDir(projectRoot) {
  const override = String(process.env.WHALE_BRIDGE_HOME || '').trim();
  if (override) return resolve(override);
  const home = homedir();
  if (home) return join(home, DIR_NAME);
  return join(projectRoot, LEGACY_DIR_NAME);
}

/** Where older versions kept everything. */
export function legacyStateDir(projectRoot) {
  return join(projectRoot, LEGACY_DIR_NAME);
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/**
 * One-time move from the in-package folder to the new location.
 *
 * Copies rather than moves: if the copy fails halfway the original is still there,
 * and a plugin update will clear the leftover later anyway. Returns a short note so
 * callers can log what happened instead of guessing.
 */
export async function migrateStateDir(projectRoot) {
  const target = stateDir(projectRoot);
  const legacy = legacyStateDir(projectRoot);
  if (resolve(target) === resolve(legacy)) return { moved: false, reason: 'same-dir' };
  if (await isDirectory(target)) {
    await repointDshHome(target, legacy);
    return { moved: false, reason: 'already-there' };
  }
  if (!(await isDirectory(legacy))) return { moved: false, reason: 'nothing-to-move' };
  try {
    await mkdir(target, { recursive: true });
    await cp(legacy, target, { recursive: true, force: false, errorOnExist: false });
    // Copying the files is not enough: service.json still records the OLD dshHome,
    // and the isolation guard now measures against the new root, so the two no
    // longer match and the bridge silently falls back to the echo adapter.
    await repointDshHome(target, legacy);
    return { moved: true, from: legacy, to: target };
  } catch (error) {
    return { moved: false, reason: 'copy-failed', error: String(error?.message || error) };
  }
}

/**
 * Rewrite a stale dshHome inside service.json so it points under the new state dir.
 * Only the recorded path changes; every other setting is left exactly as it was.
 */
async function repointDshHome(dir, legacyRoot) {
  const file = join(dir, 'service.json');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const current = typeof parsed.dshHome === 'string' ? parsed.dshHome : '';
    const prefix = resolve(legacyRoot);
    if (!current) return;
    if (resolve(current) !== prefix && !resolve(current).startsWith(prefix + sep)) return;
    const tail = resolve(current).slice(prefix.length);
    parsed.dshHome = resolve(join(dir, tail || 'dsh'));
    await writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  } catch { /* missing or unreadable config is fine: defaults take over */ }
}
