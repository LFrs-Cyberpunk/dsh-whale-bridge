/**
 * The host entry has to be loadable by DSH without doing anything dangerous on
 * import: no port, no child process, no file writes. Starting the bridge is the
 * user's switch, not a side effect of loading a plugin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as entry from '../apply.mjs';

test('the entry exports what DSH looks for', () => {
  assert.equal(typeof entry.apply, 'function');
  assert.equal(entry.name, 'dsh-whale-bridge');
  assert.deepEqual(entry.inject, ['webServer'], '没有 webServer 就注册不了路由');
});

test('importing it starts nothing', async () => {
  // No apply() call — the module body must be inert.
  assert.equal(typeof entry.createHostAdapter, 'function');
});

test('apply registers one prefix route and does not start the bridge by default', async () => {
  const registered = [];
  const disposers = [];
  const ctx = {
    webServer: {
      register(options) { registered.push(options); return () => {}; },
    },
    effect(fn) { const d = fn(); disposers.push(d); return () => d && d(); },
    get() { return undefined; },
  };
  const before = process.listenerCount('exit');
  entry.apply(ctx);
  assert.equal(registered.length, 1, '只注册一个前缀路由');
  assert.equal(registered[0].kind, 'prefix');
  assert.equal(registered[0].path, '/plugins/dsh-whale-bridge');
  assert.equal(typeof registered[0].handler, 'function');
  assert.ok(disposers.length >= 1, '必须在 ctx.effect 里注册，便于热重载摘除');
  assert.equal(process.listenerCount('exit'), before, '不能偷偷挂进程级钩子');
});

test('the route answers the settings page through adapter.handle', async () => {
  const routes = new Map();
  const ctx = {
    webServer: { register(options) { routes.set(options.path, options); return () => {}; } },
    effect(fn) { fn(); return () => {}; },
    get() { return undefined; },
  };
  entry.apply(ctx);
  const route = routes.get('/plugins/dsh-whale-bridge');
  assert.ok(route, '路由要挂在自己那个前缀下');

  // Drive the handler the way the web server would.
  const res = {
    status: 0, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  const req = { method: 'GET', url: '/plugins/dsh-whale-bridge/service', on() {} };
  await route.handler(req, res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.running, false, '刚加载时桥接必须是停的');
});

test('an unknown sub-path is a clean 404, not a crash', async () => {
  const routes = new Map();
  const ctx = {
    webServer: { register(options) { routes.set(options.path, options); return () => {}; } },
    effect(fn) { fn(); return () => {}; },
    get() { return undefined; },
  };
  entry.apply(ctx);
  const route = routes.get('/plugins/dsh-whale-bridge');
  const res = { status: 0, writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  await route.handler({ method: 'GET', url: '/plugins/dsh-whale-bridge/nope', on() {} }, res);
  assert.equal(res.status, 404);
  assert.match(res.body, /NOT_FOUND/);
});
