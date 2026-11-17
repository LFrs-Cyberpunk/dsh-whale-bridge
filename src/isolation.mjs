import { resolve, relative, sep } from 'node:path';
import { realpath, lstat, mkdir } from 'node:fs/promises';
import { BridgeError } from './core.mjs';

const within = (child, parent) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..'+sep) && rel !== '..' && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)); };
export async function assertIsolatedHome({ home, projectRoot, forbiddenHomes = [] }) {
  if (!home || !projectRoot) throw new BridgeError('ISOLATION_REQUIRED', '必须明确独立DSH_HOME和项目根目录');
  const project = await realpath(resolve(projectRoot)); const target = resolve(home);
  if (!within(target,project) || target === project) throw new BridgeError('UNSAFE_HOME', '测试DSH_HOME必须在独立项目内的专用子目录');
  await mkdir(target,{recursive:true}); const canonical = await realpath(target);
  if (!within(canonical,project) || canonical === project) throw new BridgeError('UNSAFE_HOME', '测试目录通过链接指向项目外部');
  for (const path of forbiddenHomes) {
    if (!path) continue;
    const forbidden = await realpath(resolve(path)).catch(()=>resolve(path));
    if (within(canonical,forbidden) || within(forbidden,canonical)) throw new BridgeError('LIVE_HOME_FORBIDDEN','拒绝使用日常DSH数据目录');
  }
  // Reject a home that is itself a junction/symlink even when pointing inside project.
  if ((await lstat(target)).isSymbolicLink()) throw new BridgeError('LINKED_HOME_FORBIDDEN','隔离数据目录不可为符号链接');
  return canonical;
}
/**
 * Minimal child environment.
 *
 * Credentials are stripped BY DEFAULT. Two narrow, explicit exceptions keep
 * "the user typed their own key into the settings page" working without turning
 * this into "inherit every secret in the parent process":
 *   - allowEnvNames: names copied from process.env, and only `*_KEY` / `*_TOKEN`
 *   - inject: values handed over directly by the caller (already user-supplied)
 */
export function cleanChildEnvironment({home, agentsHome, extra = {}, allowEnvNames = [], inject = {}} = {}) {
  const env = {};
  // No inherited DSH_*, API credentials, NODE_OPTIONS or profile; minimum process environment.
  for (const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT']) if (process.env[name]) env[name]=process.env[name];
  env.DSH_HOME=home; env.DSH_AGENTS_HOME=agentsHome;
  // No DSH_PROFILE here on purpose: the launcher is invoked with an explicit
  // --profile acp. A second, conflicting profile name in the environment only
  // makes the child resolve the wrong root; it was a leftover from the days when
  // the bridge ran its own throwaway profile.

  for (const [key,value] of Object.entries(extra)) {
    if (!['LANG','TZ'].includes(key)) throw new BridgeError('UNSAFE_CHILD_ENV','不允许透传凭据或DSH覆盖变量');
    env[key]=String(value);
  }
  for (const name of allowEnvNames) {
    if (!/^[A-Z][A-Z0-9_]*_(API_)?(KEY|TOKEN)$/.test(String(name))) continue;
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  for (const [name, value] of Object.entries(inject)) {
    // Same naming rule: a key the user typed is still just a key.
    if (!/^[A-Z][A-Z0-9_]*_(API_)?(KEY|TOKEN)$/.test(String(name))) continue;
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}
