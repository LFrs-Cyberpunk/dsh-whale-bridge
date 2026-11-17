import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, normalizeConfig } from './core.mjs';

/** Atomic, durable settings. A failed write is an error, never a pretend save. */
export function jsonStore(file, initial = {}) {
  let cache = null;
  let chain = Promise.resolve();
  const load = async () => {
    if (cache) return cache;
    try { cache = { ...initial, ...JSON.parse(await readFile(file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; cache = { ...initial }; }
    return cache;
  };
  const save = (value) => {
    const task = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = file + '.tmp-' + randomUUID();
      await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(temp, file);
      cache = { ...value };
      return cache;
    });
    chain = task.catch(() => {});
    return task;
  };
  return { load, save, get: (key) => cache?.[key],
    async patch(change) { return save({ ...await load(), ...change }); } };
}

/** Both processes use the same file and defaults; no production test persona. */
export async function loadBridgeConfig(file, { enabled = false, timeoutMs = 40000 } = {}) {
  let saved = {};
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new BridgeError('BRIDGE_CONFIG_UNREADABLE', '人格配置无法读取；不会切换到测试人格', 503);
  }
  return normalizeConfig({ enabled, timeoutMs, personaSource: 'whale', ...saved });
}
