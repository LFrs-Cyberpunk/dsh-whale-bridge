// Diagnostic only. Loads Whale-Girl's own JavaScriptPlugins service against the
// real data dir and asks it which plugins it considers installed. This answers
// "is the plugin being filtered out?" without guessing from logs.
const path = require('node:path');
const root = 'I:\\Whale-Girl\\WhaleGirl';
const { JavaScriptPlugins } = require(path.join(root, 'src', 'services', 'javascriptPlugins.js'));

const svc = new JavaScriptPlugins({
  dataDir: path.join(root, 'data'),
  enabled: () => true,
  logger: { info() {}, warn() {}, error() {} },
});

const installed = svc.installed();
console.log(JSON.stringify({
  count: installed.length,
  plugins: installed.map((p) => ({ id: p.id, api: p.api, kind: p.kind, hooks: p.hooks, permissions: p.permissions })),
}, null, 2));

// eslint-disable-next-line no-unused-expressions
const probe = installed.find((p) => p.id === 'whale-dsh-bridge');
console.log('bridge-approved=' + Boolean(probe && svc.isApproved(probe.id, probe.hash)));
