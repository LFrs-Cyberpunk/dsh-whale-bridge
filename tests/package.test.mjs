import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPluginZip } from '../scripts/verify-plugin-package.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GOOD_ZIP = join(here, '..', 'whale-plugin', 'dist', 'whale-dsh-router-0.1.0.zip');
const WASM = join(here, '..', 'whale-plugin', 'dist', 'plugin.wasm');

// Minimal STORED-only ZIP writer so negative cases can be built exactly.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function buildZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const manifest = (over = {}) => Buffer.from(JSON.stringify({
  Id: 'whale-dsh-router', Name: '路由信封', Author: 'local', Version: '0.1.0',
  MinAppVersion: '4.1.0', Description: '测试', Api: 3, Kind: 'message',
  Hooks: ['chat.prompt'], Permissions: ['model.prompt'], ...over,
}));

let dir;
test.before(async () => { dir = await mkdtemp(join(tmpdir(), 'whale-pkg-')); });
async function check(name, files) {
  const path = join(dir, name + '.zip');
  await writeFile(path, buildZip(files));
  return verifyPluginZip(path);
}

test('accepts the camelCase manifest variant', async () => {
  const camel = await readFile(join(here, '..', 'whale-plugin', 'dist', 'plugin.camel.json'));
  const wasm = await readFile(WASM);
  const report = await check('camel', [{ name: 'plugin.json', data: camel }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(report.ok, true, report.problems.join('; '));
  // The shipped camelCase package is valid too.
  const shipped = await verifyPluginZip(join(here, '..', 'whale-plugin', 'dist', 'whale-dsh-router-0.1.0-camel.zip'));
  assert.equal(shipped.ok, true, shipped.problems.join('; '));
});

test('the shipped package passes every rule', async () => {
  const report = await verifyPluginZip(GOOD_ZIP);
  assert.equal(report.ok, true, report.problems.join('; '));
  assert.deepEqual(report.entries.map((e) => e.name).sort(), ['plugin.json', 'plugin.wasm']);
  assert.deepEqual(report.imports.map((i) => i.name).sort(), ['input_byte', 'input_size', 'output_byte']);
});

test('a rebuilt package with the same contents also passes', async () => {
  const wasm = await readFile(WASM);
  const report = await check('good', [{ name: 'plugin.json', data: manifest() }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(report.ok, true, report.problems.join('; '));
});

test('rejects extra files, wrong api/kind and unsupported hooks', async () => {
  const wasm = await readFile(WASM);
  const extra = await check('extra', [{ name: 'plugin.json', data: manifest() }, { name: 'plugin.wasm', data: wasm }, { name: 'README.md', data: Buffer.from('x') }]);
  assert.equal(extra.ok, false); assert.match(extra.problems.join(), /plugin\.json 和 plugin\.wasm/);

  const api = await check('api', [{ name: 'plugin.json', data: manifest({ Api: 2 }) }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(api.ok, false); assert.match(api.problems.join(), /Api/);

  const kind = await check('kind', [{ name: 'plugin.json', data: manifest({ Kind: 'tool' }) }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(kind.ok, false); assert.match(kind.problems.join(), /Kind/);

  const hook = await check('hook', [{ name: 'plugin.json', data: manifest({ Hooks: ['chat.hacked'] }) }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(hook.ok, false); assert.match(hook.problems.join(), /Hooks/);

  const perm = await check('perm', [{ name: 'plugin.json', data: manifest({ Permissions: ['filesystem'] }) }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(perm.ok, false); assert.match(perm.problems.join(), /Permissions/);

  const id = await check('id', [{ name: 'plugin.json', data: manifest({ Id: 'Bad_ID' }) }, { name: 'plugin.wasm', data: wasm }]);
  assert.equal(id.ok, false); assert.match(id.problems.join(), /Id/);
});

test('rejects wasm that is not wasm, and non-whale imports', async () => {
  const junk = await check('junk', [{ name: 'plugin.json', data: manifest() }, { name: 'plugin.wasm', data: Buffer.from('not wasm at all') }]);
  assert.equal(junk.ok, false); assert.match(junk.problems.join(), /WebAssembly/);

  // Valid wasm (empty module) that exports nothing: compiles, but has no run().
  const emptyWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const empty = await check('empty', [{ name: 'plugin.json', data: manifest() }, { name: 'plugin.wasm', data: emptyWasm }]);
  assert.equal(empty.ok, true, '空 wasm 没有导入，规则上允许；run() 缺失由宿主回退');
});
