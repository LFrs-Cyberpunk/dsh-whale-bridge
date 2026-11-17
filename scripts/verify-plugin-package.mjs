#!/usr/bin/env node
/**
 * Verifies a Whale-Girl plugin ZIP against the market's packing rules, without
 * running Whale-Girl:
 *   - archive ≤ 1 MiB, plugin.wasm ≤ 512 KiB
 *   - root contains only plugin.json and plugin.wasm
 *   - manifest fields are valid for Api 3 / Kind message
 *   - the wasm imports nothing except whale.{input_size,input_byte,output_byte}
 *
 * ZIP is read from its central directory; no extraction, no execution.
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const MAX_ZIP = 1024 * 1024;
const MAX_WASM = 512 * 1024;
const HOOKS = ['chat.received', 'chat.pre_reply', 'chat.prompt', 'chat.generate', 'chat.reply', 'chat.before_send', 'chat.dispatched'];
const PERMISSIONS = ['chat.history', 'model.prompt'];

export function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录损坏');
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, size, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

export function extractStoredOrDeflated(buffer, entry) {
  const at = entry.localOffset;
  if (buffer.readUInt32LE(at) !== 0x04034b50) throw new Error('本地文件头损坏：' + entry.name);
  const nameLen = buffer.readUInt16LE(at + 26);
  const extraLen = buffer.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLen + extraLen;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressedSize === entry.size) return Buffer.from(data);
  return inflateRawSync(data);
}

export async function verifyPluginZip(zipPath) {
  const problems = [];
  const buffer = await readFile(zipPath);
  if (buffer.length > MAX_ZIP) problems.push(`ZIP 超过 1 MiB（${buffer.length}）`);

  let entries;
  try { entries = readZipEntries(buffer); } catch (error) { return { ok: false, problems: [error.message], entries: [] }; }

  const names = entries.map((e) => e.name).sort();
  const expected = ['plugin.json', 'plugin.wasm'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) problems.push(`根目录只应有 plugin.json 和 plugin.wasm，实际：${names.join(', ')}`);

  const wasmEntry = entries.find((e) => e.name === 'plugin.wasm');
  if (wasmEntry && wasmEntry.size > MAX_WASM) problems.push(`plugin.wasm 超过 512 KiB（${wasmEntry.size}）`);

  const jsonEntry = entries.find((e) => e.name === 'plugin.json');
  let manifest = null;
  if (jsonEntry) {
    try { manifest = JSON.parse(extractStoredOrDeflated(buffer, jsonEntry).toString('utf8')); }
    catch (error) { problems.push('plugin.json 无法解析：' + error.message); }
  }

  if (manifest) {
    // Key casing is not observable from Whale-Girl's kernel (the installer lives in
    // the launcher), so accept either PascalCase (docs) or camelCase (internal flow).
    const m = manifest;
    const pick = (name) => m[name] ?? m[name.charAt(0).toLowerCase() + name.slice(1)] ?? m[name.charAt(0).toUpperCase() + name.slice(1)];
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(String(pick('Id') ?? ''))) problems.push('Id 必须小写字母开头、仅小写字母数字短横线');
    for (const key of ['Name', 'Author', 'Version', 'Description']) if (typeof pick(key) !== 'string' || !pick(key).trim()) problems.push(`缺少 ${key}`);
    if (pick('Api') !== 3) problems.push(`Api 必须为 3，实际 ${JSON.stringify(pick('Api'))}`);
    if (pick('Kind') !== 'message') problems.push(`Kind 必须为 message，实际 ${JSON.stringify(pick('Kind'))}`);
    const hooks = pick('Hooks');
    if (!Array.isArray(hooks) || hooks.length === 0 || hooks.some((h) => !HOOKS.includes(h))) problems.push('Hooks 含未声明的扩展点');
    const permissions = pick('Permissions');
    if (!Array.isArray(permissions) || permissions.some((p) => !PERMISSIONS.includes(p))) problems.push('Permissions 含未支持的能力');
    if (!/^\d+\.\d+\.\d+$/.test(String(pick('Version') ?? ''))) problems.push('Version 应为 x.y.z');
  }

  let imports = [];
  if (wasmEntry) {
    try {
      const wasm = extractStoredOrDeflated(buffer, wasmEntry);
      // Dynamic import keeps this script usable from tests without global setup.
      const { readWasmImports } = await import('./wasm-imports.mjs');
      imports = await readWasmImports(wasm);
      const bad = imports.filter((i) => i.module !== 'whale' || i.kind !== 'function' || !['input_size', 'input_byte', 'output_byte'].includes(i.name));
      if (bad.length) problems.push('wasm 含鲸鲸不允许的导入：' + bad.map((b) => `${b.module}.${b.name}`).join(', '));
    } catch (error) { problems.push('plugin.wasm 无法编译为 WebAssembly：' + error.message); }
  }

  return { ok: problems.length === 0, problems, entries: entries.map(({ name, size }) => ({ name, size })), manifest, imports };
}

if (process.argv[1] && process.argv[1].endsWith('verify-plugin-package.mjs')) {
  const target = process.argv[2];
  if (!target) { process.stderr.write('用法：node scripts/verify-plugin-package.mjs <plugin.zip>\n'); process.exit(2); }
  const report = await verifyPluginZip(target);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
}
