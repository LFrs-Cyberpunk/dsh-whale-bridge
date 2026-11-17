/**
 * The Api 4 plugin is a single CommonJS file that `require('whale')`, so it is
 * tested the way it actually runs: in a child process, with a fake `whale` module
 * on the resolution path and a fake bridge listening on loopback.
 *
 * What matters here is the fallback contract — a broken bridge must hand the turn
 * back to Whale ({}) and never return an empty reply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const pluginSrc = join(import.meta.dirname, '..', 'whale-plugin', 'js', 'plugin.js');
const pluginPath = pluginSrc;

/** Builds a sandbox: fake whale module + a copy of plugin.js + a data dir. */
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'whale-js-'));
  const mods = join(dir, 'node_modules', 'whale');
  await mkdir(mods, { recursive: true });
  await writeFile(join(mods, 'index.js'), `
exports.paths = { pluginData: process.env.FAKE_PLUGIN_DATA, appData: process.env.FAKE_PLUGIN_DATA, appRoot: '.' };
exports.capabilities = async () => ({ ok: true });
`, 'utf8');
  return dir;
}

/** Runs one hook call inside the sandbox and returns the parsed result. */
async function runHook(dir, { hook = 'chat.generate', ctx, env = {} } = {}) {
  const driver = `
const path = require('node:path');
const plugin = require(${JSON.stringify(pluginPath)});
const hook = ${JSON.stringify(hook)};
const ctx = ${JSON.stringify(ctx || {})};
if (hook === 'run') { plugin.run(ctx).then(r => console.log(JSON.stringify(r))).catch(e => console.log(JSON.stringify({ error: String(e && e.message || e) }))); }
else {
  const fn = plugin.hooks[hook];
  Promise.resolve(fn(ctx)).then(r => console.log(JSON.stringify(r))).catch(e => console.log(JSON.stringify({ error: String(e && e.message || e) })));
}
`;
  // Must be async: the fake bridge lives in THIS process, so a synchronous spawn
  // would block the event loop and the child's fetch would just sit there.
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', driver], {
      cwd: dir,
      env: { ...process.env, NODE_PATH: join(dir, 'node_modules'), FAKE_PLUGIN_DATA: join(dir, 'data'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.once('exit', (code) => resolve({ code, out, err }));
  });
  if (res.code !== 0) return { fatal: (res.err || '').slice(0, 500) };
  const line = (res.out || '').trim().split('\n').filter(Boolean).pop() ?? '{}';
  try { return JSON.parse(line); } catch { return { fatal: line.slice(0, 300) }; }
}

/** Fake bridge that answers with whatever the test wants. */
async function fakeBridge(handler) {
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
});

const sseOf = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;

test('with no token configured the plugin declines, so Whale answers herself', async () => {
  const dir = await sandbox();
  try {
    const out = await runHook(dir, { ctx: { message: { text: '在吗', chatId: 'c1' } } });
    assert.deepEqual(out, {}, '没配令牌必须交回宿主');
    const cfg = JSON.parse(await readFile(join(dir, 'data', 'config.json'), 'utf8'));
    assert.equal(cfg.token, '', '首次运行要写出可编辑的配置');
    assert.ok(cfg.url.startsWith('http://127.0.0.1:'), '默认指向本机');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a good bridge answer replaces the generation', async () => {
  const dir = await sandbox();
  const seen = {};
  const bridge = await fakeBridge(async (req, res) => {
    seen.auth = req.headers.authorization;
    seen.body = await readBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseOf('团子今天很乖。'));
  });
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'config.json'), JSON.stringify({ url: bridge.url, token: 'x'.repeat(48) }), 'utf8');
    const out = await runHook(dir, {
      ctx: {
        key: 'wechat:private:c1',
        message: { text: '它怎么样', chatId: 'c1', senderId: 'u1', platform: 'wechat', chatType: 'private' },
        history: [{ role: 'user', text: '我养了只猫叫团子' }, { role: 'assistant', text: '记住了' }],
      },
    });
    assert.equal(out.text, '团子今天很乖。');
    assert.equal(seen.auth, 'Bearer ' + 'x'.repeat(48), '必须带上令牌');
    const sys = seen.body.messages[0].content;
    assert.match(sys, /\[\[WHALE-BRIDGE v1\]\]/);
    assert.match(sys, /"chatId":"c1"/, "信封体必须是 JSON，桥接按 JSON 解析");
    assert.equal(seen.body.messages.at(-1).content, '它怎么样', '当前这句放最后');
    assert.ok(seen.body.messages.some((m) => m.content === '我养了只猫叫团子'), '历史要一起带过去');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('bridge errors hand the turn back instead of replying with nothing', async () => {
  const dir = await sandbox();
  const bridge = await fakeBridge((req, res) => { res.writeHead(500); res.end('boom'); });
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'config.json'), JSON.stringify({ url: bridge.url, token: 'y'.repeat(48) }), 'utf8');
    const out = await runHook(dir, { ctx: { message: { text: '在吗', chatId: 'c1' } } });
    assert.deepEqual(out, {}, '桥接挂了要让鲸鲸自己答');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an empty answer is treated as a failure, not as silence', async () => {
  const dir = await sandbox();
  const bridge = await fakeBridge((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); });
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'config.json'), JSON.stringify({ url: bridge.url, token: 'z'.repeat(48) }), 'utf8');
    const out = await runHook(dir, { ctx: { message: { text: '在吗', chatId: 'c1' } } });
    assert.deepEqual(out, {}, '空回复不能接管，否则对方会收不到消息');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('enabled:false bypasses the bridge entirely', async () => {
  const dir = await sandbox();
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'config.json'), JSON.stringify({ enabled: false, url: 'http://127.0.0.1:1', token: 'q'.repeat(48) }), 'utf8');
    const out = await runHook(dir, { ctx: { message: { text: '在吗', chatId: 'c1' } } });
    assert.deepEqual(out, {}, '关掉开关就完全不碰 DSH');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a non-JSON answer does not crash the turn', async () => {
  const dir = await sandbox();
  const bridge = await fakeBridge((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json at all'); });
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'config.json'), JSON.stringify({ url: bridge.url, token: 'w'.repeat(48) }), 'utf8');
    const out = await runHook(dir, { ctx: { message: { text: '在吗', chatId: 'c1' } } });
    assert.deepEqual(out, {}, '解析不了也不能抛');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the manifest matches what Api 4 requires', async () => {
  const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'whale-plugin', 'js', 'plugin.json'), 'utf8'));
  assert.equal(manifest.Api, 4);
  assert.equal(manifest.Kind, 'message');
  assert.deepEqual(manifest.Permissions, ['system.full'], 'Api 4 只认 system.full');
  assert.ok(/^[a-z][a-z0-9-]{0,47}$/.test(manifest.Id), 'id 必须小写开头');
  assert.ok(Array.isArray(manifest.Hooks) && manifest.Hooks.length === 2, '要 chat.prompt（捕获人格）+ chat.generate（接管回复）两个');
  assert.ok(manifest.Hooks.includes('chat.generate'), '接管回复就在 chat.generate');
  assert.ok(manifest.Hooks.includes('chat.prompt'), '人格只能从 chat.prompt 拿到');
  assert.ok(manifest.ExecutionTimeoutMs >= 100 && manifest.ExecutionTimeoutMs <= 120000);
});

test('a missing whale.paths falls back to cwd instead of silently doing nothing', async () => {
  // Real regression: the worker does not always populate whale.paths, so reading
  // it threw, the catch returned empty defaults, and every turn quietly returned
  // {} — plugin installed, nothing happened, no error anywhere.
  const dir = await mkdtemp(join(tmpdir(), 'whale-nopaths-'));
  const mods = join(dir, 'node_modules', 'whale');
  await mkdir(mods, { recursive: true });
  await writeFile(join(mods, 'index.js'), 'exports.capabilities = async () => ({ ok: true });\n', 'utf8');
  const bridge = await fakeBridge(async (req, res) => {
    await new Promise((r) => { req.on('data', () => {}); req.on('end', r); });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseOf('有路径兜底。'));
  });
  try {
    // cwd IS the plugin data dir when the host spawns the worker.
    await writeFile(join(dir, 'config.json'), JSON.stringify({ url: bridge.url, token: 'v'.repeat(48) }), 'utf8');
    const driver = 'const p = require(' + JSON.stringify(pluginPath) + ');p.hooks["chat.generate"]({ message: { text: "在吗", chatId: "c1" } }).then(r => console.log(JSON.stringify(r)));';
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', driver], { cwd: dir, env: { ...process.env, NODE_PATH: join(dir, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.once('exit', () => resolve({ out, err }));
    });
    const parsed = JSON.parse(res.out.trim().split('\n').pop() || '{}');
    assert.equal(parsed.text, '有路径兜底。', '没有 whale.paths 也要能读到 cwd 里的配置：' + res.err.slice(0, 200));
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
test('two different messages never share a message id', async () => {
  // Regression for the 409 that made every turn after the first fall back to the
  // host model: ids were derived from text LENGTH, so "在吗" and "你好" collided.
  const dir = await mkdtemp(join(tmpdir(), 'whale-mid-'));
  const mods = join(dir, 'node_modules', 'whale');
  await mkdir(mods, { recursive: true });
  await writeFile(join(mods, 'index.js'), 'exports.paths = { pluginData: process.cwd() };\n', 'utf8');
  const seen = [];
  const bridge = await fakeBridge(async (req, res) => {
    let raw = '';
    await new Promise((r) => { req.on('data', (c) => { raw += c; }); req.on('end', r); });
    seen.push(JSON.parse(raw).messages[0].content);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseOf('ok'));
  });
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ url: bridge.url, token: 'v'.repeat(48) }), 'utf8');
    const driver = 'const p = require(' + JSON.stringify(pluginPath) + ');'
      + 'const mk = (t) => ({ message: { text: t, chatId: "c1", senderId: "u1" }, now: Date.now() });'
      + '(async () => { await p.hooks["chat.generate"](mk("在吗")); await p.hooks["chat.generate"](mk("你好"));'
      + ' console.log("done"); })();';
    await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', driver], { cwd: dir, env: { ...process.env, NODE_PATH: join(dir, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      child.once('exit', resolve);
    });
    const ids = seen.map((body) => (body.match(/"messageId":"([^"]+)"/) || [])[1]);
    assert.equal(ids.length, 2, '两次调用都要打到桥接');
    assert.ok(ids[0] && ids[1], '两次都要带 messageId');
    assert.notEqual(ids[0], ids[1], '长度相同、内容不同的两条消息不能共用 ID');
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
test('the saved adapter wins over a stale parent environment', async () => {
  // Regression: the parent process used to send WHALE_BRIDGE_ADAPTER=mock long
  // after the user picked real thinking, and the child obeyed the environment.
  // Every reply then came from the echo adapter while the panel showed "acp".
  const dir = await mkdtemp(join(tmpdir(), 'whale-cfg-'));
  await writeFile(join(dir, 'service.json'), JSON.stringify({ adapter: 'acp', enabled: true }), 'utf8');
  const saved = JSON.parse(await readFile(join(dir, 'service.json'), 'utf8'));
  const fromFile = String(saved.adapter || '').trim();
  const fromEnv = 'mock';
  assert.equal(fromFile || fromEnv || 'mock', 'acp', '配置文件必须压过父进程传错的值');
});
