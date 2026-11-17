import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', '..', 'client.js');

// Minimal React stand-in: the bundle only needs createElement/useEffect/useState.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
};

/** Loads the package-root client.js the way DSH does: via __ModuleLoader__.load. */
async function loadBundle({ requireReact = true } = {}) {
  const source = await readFile(CLIENT, 'utf8');
  const registered = [];
  const context = {
    window: { __ModuleLoader__: { load: (def) => registered.push(def) } },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'client.js' });
  assert.equal(registered.length, 1, '必须恰好注册一个模块');
  const def = registered[0];
  const mod = def.factory((id) => {
    if (id === 'react' && requireReact) return React;
    throw new Error('unexpected require: ' + id);
  });
  return { id: def.id, mod };
}

function textOf(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  if (node.children) for (const child of node.children) textOf(child, out);
  return out;
}

test('bundle registers the whale-bridge settings section', async () => {
  const { id, mod } = await loadBundle();
  assert.equal(id, 'dsh-whale-bridge', '注册 id 必须等于包名，否则加载器认为没注册');
  assert.deepEqual([...mod.inject], ['slots']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.setBridge, 'function');

  const injected = []; const registered = [];
  const ctx = { slots: {
    inject: (name, factory) => { injected.push(name); factory(); },
    register: (meta, component) => { registered.push({ meta, component }); },
  } };
  mod.apply(ctx);
  // Left rail entry + its page. The settings section was deliberately REMOVED:
  // the user asked for the config to live in the sidebar, not in Settings.
  assert.deepEqual(injected, ['sidebar.panellist', 'main']);
  
  const page = registered.find((r) => r.meta.name === 'main');
  assert.ok(page, '必须注册面板内容');
  assert.equal(page.meta.key, 'whale-bridge');
  assert.equal(typeof page.component, 'function');
  const entry = registered.find((r) => r.meta.name === 'sidebar.panellist');
  assert.ok(entry, '必须注册左侧栏条目');
  assert.equal(entry.meta.id, 'whale-bridge');
  assert.equal(entry.meta.key, undefined, '左侧栏用 id 关联，不用 key');
  assert.equal(entry.meta.label(), '鲸鲸桥接');
  assert.equal(typeof entry.component, 'function');
});

test('without an injected bridge the panel still renders and falls back to HTTP', async () => {
  const { mod } = await loadBundle();
  const all = [];
  mod.apply({ slots: { inject: (n, f) => f(), register: (meta, component) => { all.push({ meta, component }); } } });
  mod.setBridge(null);

  // The page lives in the main panel; the rail entry is just an icon.
  const page = all.find((r) => r.meta.name === 'main').component({});
  const text = textOf(page.children[0].type({})).join(' ');
  // No injection must NOT mean a dead page: call() falls back to the host's HTTP
  // routes, so the panel renders its loading state and then real data.
  assert.match(text, /读取中/);
});

test('setBridge accepts an adapter object', async () => {
  const { mod } = await loadBundle();
  const all = [];
  mod.apply({ slots: { inject: (n, f) => f(), register: (meta, component) => { all.push({ meta, component }); } } });
  mod.setBridge({ handle: async () => ({ ok: true }) });
  const page = all.find((r) => r.meta.name === 'main').component({});
  // Rendering now goes through the loading state (useEffect is stubbed out).
  const text = textOf(page.children[0].type({})).join(' ');
  assert.match(text, /读取中|鲸鲸桥接/);
});
