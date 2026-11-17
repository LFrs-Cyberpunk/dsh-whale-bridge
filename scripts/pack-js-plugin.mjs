#!/usr/bin/env node
/**
 * Packs the Api 4 plugin: a ZIP whose root holds exactly `plugin.json` and
 * `plugin.js` — nothing else, no nested folder. Whale rejects the package
 * otherwise ("ZIP 根目录仅两个文件").
 *
 * Written by hand (stored entries, no compression) so the archive layout is
 * explicit and does not depend on any zip library being installed.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'whale-plugin', 'js');
const dist = join(root, 'whale-plugin', 'dist');

export const MAX_PACKAGE = 16 * 1024 * 1024;
export const MAX_CODE = 8 * 1024 * 1024;

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Stored-mode ZIP: local header + data per file, then the central directory. */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 name flag
    local.writeUInt16LE(0, 8);             // stored
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0, 12);            // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Reads back entry names from a stored-mode ZIP, so the check is independent. */
export function zipEntries(buf) {
  const names = [];
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    names.push(buf.slice(i + 46, i + 46 + nameLen).toString('utf8'));
  }
  return names;
}

async function main() {
  const manifestRaw = await readFile(join(src, 'plugin.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const code = await readFile(join(src, 'plugin.js'));

  if (Buffer.byteLength(code) > MAX_CODE) throw new Error('plugin.js 超过 8 MiB');
  if (manifest.Api !== 4) throw new Error('Api 必须是 4');
  if (manifest.Kind !== 'message') throw new Error('Kind 必须是 message');
  if (JSON.stringify(manifest.Permissions) !== '["system.full"]') throw new Error('Api 4 权限必须是 system.full');

  const files = [
    { name: 'plugin.json', data: Buffer.from(manifestRaw, 'utf8') },
    { name: 'plugin.js', data: code },
  ];
  const archive = zip(files);
  if (archive.length > MAX_PACKAGE) throw new Error('ZIP 超过 16 MiB');

  const names = zipEntries(archive);
  if (names.length !== 2 || !names.includes('plugin.json') || !names.includes('plugin.js')) {
    throw new Error('ZIP 根目录必须只有 plugin.json 和 plugin.js，实际：' + names.join(', '));
  }

  const out = join(dist, `whale-dsh-bridge-${manifest.Version}.zip`);
  await mkdir(dist, { recursive: true });
  await writeFile(out, archive);
  process.stdout.write(JSON.stringify({
    ok: true,
    file: out,
    bytes: archive.length,
    entries: names,
    sha256: createHash('sha256').update(archive).digest('hex'),
    permissions: manifest.Permissions,
    note: '这是 Api 4 插件包。装完要在市场里开启 JavaScript 实验总开关并逐个确认 system.full 权限。',
  }, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
}
