// Diagnostic only: execute ONLY whale-dsh-bridge through Whale-Girl's runtime so a
// neighbouring plugin cannot mask the result. Prints the raw output or the error.
const path = require('node:path');
const root = 'I:\\Whale-Girl\\WhaleGirl';
const { JavaScriptPlugins } = require(path.join(root, 'src', 'services', 'javascriptPlugins.js'));

const svc = new JavaScriptPlugins({
  dataDir: path.join(root, 'data'),
  enabled: () => true,
  logger: { info() {}, warn() {}, error() {} },
});

const ctx = {
  key: 'wechat:private:diag',
  now: Date.now(),
  message: { platform: 'wechat', chatId: 'diag_chat', chatType: 'private', senderId: 'diag_user', text: '在吗', atMe: false, replyToBot: false, mentionedNames: [] },
  history: [],
  lastBot: null,
  search: null,
  webText: '',
};

(async () => {
  const flow = svc.installed().find((p) => p.id === 'whale-dsh-bridge');
  if (!flow) { console.log('NOT_INSTALLED'); return; }
  const input = svc.input(flow, 'chat.generate', ctx);
  console.log('INPUT_KEYS=' + JSON.stringify(Object.keys(input.value || {})));
  try {
    const out = await svc.execute(flow, input.value);
    console.log('OUTPUT=' + JSON.stringify(out));
  } catch (e) {
    console.log('EXEC_ERROR=' + JSON.stringify({ code: e && e.code, message: String(e && e.message || e).slice(0, 300) }));
  }
})().then(() => process.exit(0), (e) => { console.log('THROW=' + String(e && e.message || e)); process.exit(1); });
