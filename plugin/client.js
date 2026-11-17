console.log('[whale-bridge] FILE EXECUTED (outermost)');
// dsh-whale-bridge — 左侧栏「鲸鲸桥接」入口 + 整页配置（classic-script bundle）
// 取得方式：宿主注入 handle 优先，否则直接走同名 HTTP 路由（/plugins/dsh-whale-bridge/*）。不自动启用桥接。
// 人格编辑器：四块必知 + 一块可选，只有「身份与动机」必填。
// 拼装逻辑只在宿主半边（src/persona.mjs）实现一份，这里只做展示与提交。
//
// THE ID MUST EQUAL THE PACKAGE NAME. dsh-meme spells this out in its own header:
// register under a different id and the loader reports "loaded without registering
// <package>" — and the bundle gets treated as an unclaimed registration, which is
// how we ended up with a duplicate-factory boot failure. Package name is
// both the package name and this id are `dsh-whale-bridge`.
window.__ModuleLoader__.load({
  id: 'dsh-whale-bridge',
  factory: function (require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { useEffect, useState } = React;

    const ROUTES = {
      config: '/plugins/dsh-whale-bridge/config',
      status: '/plugins/dsh-whale-bridge/status',
      selfcheck: '/plugins/dsh-whale-bridge/selfcheck',
      errors: '/plugins/dsh-whale-bridge/errors',
      persona: '/plugins/dsh-whale-bridge/persona',
      memory: '/plugins/dsh-whale-bridge/memory',
      grow: '/plugins/dsh-whale-bridge/grow',
      service: '/plugins/dsh-whale-bridge/service',
    };
    const SOURCES = [
      { id: 'dsh', label: '跟随 DSH' },
      { id: 'whale', label: '跟随鲸鲸的人格页' },
      { id: 'custom', label: '自己写一份' },
    ];
    const SOURCE_HINT = {
      dsh: '不额外注入人格，由 DSH 那边按自己的设定说话。你在鲸鲸人设页写的内容对这里无效。',
      whale: '把鲸鲸人设页里的内容交给 DSH 当背景，微信上回的还是那个她。你改人设，这边跟着变，不用重装、不用复制粘贴。',
      custom: '用下面这几块自己写一份，只对这边生效。',
    };
    const CARD = { listStyle: 'none', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12, padding: 16, display: 'grid', gap: 14 };
    const ROW = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20 };
    const FIELD = { display: 'grid', gap: 4 };
    const AREA = { width: '100%', padding: 8, borderRadius: 6, fontFamily: 'inherit', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.6 };
    const CODE = { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', background: 'rgba(127,127,127,0.08)', padding: 10, borderRadius: 6, maxHeight: 240, overflow: 'auto' };
    const TONE = {
      empty: { text: '还没写。至少写「身份与动机」才有意义。', color: 'inherit' },
      thin: { text: '太薄了：只填了一块，角色会像个只会接话的空壳。', color: '#c98a00' },
      good: { text: '长度合适。这段会在每轮请求里重复发送，短一点就是快一点。', color: '#3f8f6b' },
      ok: { text: '已经到上限附近了。再长不会更聪明，只会更慢、更贵。', color: '#c98a00' },
      heavy: { text: '超预算：多了的部分会被整块丢掉（先丢场景、再看对方）。删掉你要的，不是删掉能留的。', color: '#e5484d' },
    };

    let bridge = null;
    function setBridge(impl) { bridge = impl || null; }

    async function call(method, path, body) {
      // Preferred: the host hands us its own handle.
      if (bridge) return bridge.handle(method, path, body);
      // Fallback: the SAME routes are served over HTTP by the host half. This is
      // what makes the panel work without any injection — before this, a page that
      // loaded fine still said "未连接" because nothing ever called setBridge.
      const res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await res.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      if (!res.ok) {
        const detail = (data && (data.message || data.error)) || ('HTTP ' + res.status);
        throw new Error(String(detail));
      }
      return data;
    }

    function Status({ kind, text }) {
      if (!text) return null;
      const color = kind === 'ok' ? '#7fd6a0' : kind === 'err' ? '#e5484d' : 'inherit';
      return React.createElement('div', { role: 'status', style: { fontSize: 12, color, opacity: 0.9 } }, text);
    }

    function FieldRow({ field, value, disabled, onChange }) {
      const used = String(value || '').length;
      const cap = field.cap || 300;
      const over = used > cap;
      const head = React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } },
        React.createElement('strong', { style: { fontSize: 13 } },
          field.label,
          field.required ? React.createElement('span', { style: { color: '#e5484d', marginLeft: 4 } }, '*') : null),
        React.createElement('small', { style: { opacity: 0.55, color: over ? '#e5484d' : 'inherit' } }, used + ' / ' + cap));
      const hint = React.createElement('small', { style: { opacity: 0.7 } }, field.hint);
      const warn = React.createElement('small', { style: { opacity: 0.6 } }, '别写成「' + (field.bad || '…') + '」');
      const area = React.createElement('textarea', {
        // Grey example text inside the box: an empty field is a prompt, not a wall.
        placeholder: field.placeholder || '',
        style: Object.assign({}, AREA, { minHeight: field.key === 'hardNo' ? 84 : 56 }),
        value: value || '',
        disabled,
        onChange: (e) => onChange(field.key, e.target.value),
      });
      return React.createElement('div', { style: FIELD }, head, hint, warn, area);
    }

    function PersonaEditor({ view, draft, onDraft, disabled }) {
      if (!view) return null;
      const budget = view.budget || {};
      const tone = TONE[budget.status] || TONE.empty;
      const progress = view.progress || { filled: 0, total: 0 };
      const groups = view.groups || [{ id: 'core', label: '设定' }];
      return React.createElement('div', { style: { display: 'grid', gap: 14 } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          React.createElement('strong', null, '自定义人格'),
          React.createElement('small', { style: { opacity: 0.7 } },
            '完成度 ' + progress.filled + '/' + progress.total + ' · ' + (budget.chars || 0) + ' / ' + (budget.limit || 1200) + ' 字')),
        React.createElement('div', { style: { height: 4, borderRadius: 2, background: 'rgba(127,127,127,0.2)' } },
          React.createElement('div', { style: {
            height: 4, borderRadius: 2, width: Math.min(100, Math.round(((budget.chars || 0) / (budget.limit || 1200)) * 100)) + '%',
            background: budget.status === 'heavy' ? '#e5484d' : budget.status === 'thin' ? '#c98a00' : '#3f8f6b',
          } })),
        React.createElement('small', { style: { opacity: 0.75 } },
          '每轮约 ' + (budget.perTurnTokens || 0) + ' token；聊 ' + (budget.turns || 100) + ' 轮，这段累计约 ' + (budget.longChatTokens || 0) + ' token（模型每轮都要重发整段历史，所以这段是按轮计费的）'),
        React.createElement('small', { style: { color: tone.color } }, tone.text),
        groups.map((g) => React.createElement('div', { key: g.id, style: { display: 'grid', gap: 10 } },
          React.createElement('small', { style: { opacity: 0.55, letterSpacing: 0.5, borderTop: '1px solid rgba(127,127,127,0.16)', paddingTop: 8 } }, g.label),
          (view.fields || []).filter((f) => f.group === g.id).map((f) => React.createElement(FieldRow, {
            key: f.key, field: f, value: draft[f.key], disabled, onChange: onDraft,
          })))),
        React.createElement('small', { style: { opacity: 0.7, borderTop: '1px solid rgba(127,127,127,0.2)', paddingTop: 8 } }, view.note),
        view.preview
          ? React.createElement('details', null,
              React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12.5 } }, '看看最终发出去的是什么样'),
              React.createElement('div', { style: CODE }, view.preview))
          : null);
    }

    function MemoryBlock({ view, busy, onGrow }) {
      if (!view) return null;
      if (!view.available) {
        return React.createElement('div', { style: FIELD },
          React.createElement('strong', { style: { fontSize: 13 } }, '记忆'),
          React.createElement('small', { style: { opacity: 0.7 } }, view.note));
      }
      const s = view.stats || {};
      return React.createElement('div', { style: FIELD },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          React.createElement('strong', { style: { fontSize: 13 } }, '记忆'),
          React.createElement('small', { style: { opacity: 0.7 } },
            (s.chats || 0) + ' 个会话 · ' + (s.episodes || 0) + ' 条 · 可外传 ' + (s.shareable || 0) + ' 条')),
        view.persona
          ? React.createElement('div', { style: CODE }, view.persona)
          : React.createElement('small', { style: { opacity: 0.6 } }, '人格层还是空的：先聊出几句「我喜欢 / 我怕」这类关于自己的话，再点下面的按钮。'),
        React.createElement('div', { style: ROW },
          React.createElement('small', { style: { opacity: 0.7, maxWidth: '70%' } }, view.note),
          React.createElement('button', { type: 'button', disabled: busy, onClick: onGrow }, '整理人格层')));
    }

    /**
      * One switch, plus the model the bridge should use.
      *
      * The bridge runs its own DSH process, and DSH model choice is per-profile —
      * a second process has no session to inherit a model from. So "reuse my API"
      * is not available; this form is the honest version: one key, one model.
      * The key is write-only, the page only learns whether one is already saved.
      */
    function ServiceBlock({ view, busy, onTimeout, onSave }) {
      if (!view) return null;
      const [draftMs, setDraftMs] = useState(String(view.timeoutMs ?? 40000));
      const [adapter, setAdapter] = useState(view.adapter || 'mock');
      const [apiKey, setApiKey] = useState('');
      const [baseUrl, setBaseUrl] = useState(view.baseUrl || 'https://api.deepseek.com');
      const [model, setModel] = useState(view.model || 'deepseek-flash');
      const [effort, setEffort] = useState(view.reasoningEffort || 'low');
      useEffect(() => { setDraftMs(String(view.timeoutMs ?? 40000)); }, [view.timeoutMs]);
      useEffect(() => { setAdapter(view.adapter || 'mock'); }, [view.adapter]);
      const running = Boolean(view.running);
      const dot = { display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6,
        background: running ? '#3f9c5a' : (view.desired ? '#c8873a' : '#9a9a9a') };
      const input = { padding: '5px 8px', borderRadius: 6, border: '1px solid #cfc6b8', background: '#fff' };
      return React.createElement('div', { style: FIELD },
        // No on/off button here any more: the switch lives on the first row and
        // drives BOTH sides. Two separate controls made it possible to leave the
        // plugin on while the process was down, which only produced fetch failures.
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          React.createElement('strong', { style: { fontSize: 13 } },
            React.createElement('span', { style: dot }),
            '桥接服务'),
          React.createElement('small', { style: { opacity: 0.7 } },
            running ? (view.address || '运行中') : (view.desired ? '正在启动…' : '已停止'))),
        React.createElement('small', { style: { opacity: 0.75 } },
          running ? '运行中 · ' + (view.address || '等待端口') : (view.desired ? '正在启动…' : '已停止 · 停下时微信那边收不到回复')),

        React.createElement('div', { style: ROW },
          React.createElement('label', { style: { fontSize: 12, opacity: 0.8, minWidth: 88 } }, '回答用哪个'),
          React.createElement('select', { value: adapter, disabled: busy, style: input, onChange: (e) => setAdapter(e.target.value) },
            React.createElement('option', { value: 'mock' }, '回声（测试用，不思考）'),
            React.createElement('option', { value: 'acp' }, '本机 DSH（真思考）'))),

        adapter === 'acp' ? React.createElement('div', { style: { display: 'grid', gap: 8, paddingLeft: 8, borderLeft: '2px solid #e5ddcf' } },
          React.createElement('div', { style: ROW },
            React.createElement('label', { style: { fontSize: 12, opacity: 0.8, minWidth: 88 } }, 'API Key'),
            React.createElement('input', {
              type: 'password', value: apiKey, disabled: busy, style: { ...input, flex: 1 },
              placeholder: view.hasApiKey ? '已保存（留空则不修改）' : '粘贴你的 Key',
              onChange: (e) => setApiKey(e.target.value),
            })),
          React.createElement('div', { style: ROW },
            React.createElement('label', { style: { fontSize: 12, opacity: 0.8, minWidth: 88 } }, '接口地址'),
            React.createElement('input', { value: baseUrl, disabled: busy, style: { ...input, flex: 1 }, onChange: (e) => setBaseUrl(e.target.value) })),
          React.createElement('div', { style: ROW },
            React.createElement('label', { style: { fontSize: 12, opacity: 0.8, minWidth: 88 } }, '模型'),
            React.createElement('select', { value: model, disabled: busy, style: input, onChange: (e) => setModel(e.target.value) },
              React.createElement('option', { value: 'deepseek-flash' }, 'deepseek-flash（快）'),
              React.createElement('option', { value: 'deepseek-pro' }, 'deepseek-pro（强）')),
            React.createElement('label', { style: { fontSize: 12, opacity: 0.8, marginLeft: 8 } }, '推理'),
            React.createElement('select', { value: effort, disabled: busy, style: input, onChange: (e) => setEffort(e.target.value) },
              (view.efforts || ['off', 'low', 'medium', 'high']).map((k) => React.createElement('option', { key: k, value: k }, k)))),
          React.createElement('small', { style: { opacity: 0.7 } },
            '这条 Key 存在本机，只给隔离的那个 DSH 用。它和你日常 DSH 的模型配置是两套。')) : null,

        React.createElement('div', { style: ROW },
          React.createElement('button', {
            type: 'button', disabled: busy,
            onClick: () => onSave({ adapter, apiKey: apiKey || undefined, baseUrl, model, reasoningEffort: effort }),
          }, '保存设置')),

        view.sync
          ? React.createElement('div', { style: { ...CODE, color: '#3f7d54' } },
            '插件已同步：' + view.sync.bundles + ' 个可用，' + view.sync.skipped + ' 个界面插件跳过')
          : null,
        view.lastError
          ? React.createElement('div', { style: { ...CODE, color: '#b04a3a' } }, String(view.lastError).slice(0, 400))
          : null,
        view.modelConfig && view.modelConfig.ok === false
          ? React.createElement('div', { style: { ...CODE, color: '#b04a3a' } }, '模型配置没写成：' + String(view.modelConfig.reason || '').slice(0, 200))
          : null,
        view.modelConfig && view.modelConfig.ok
          ? React.createElement('small', { style: { opacity: 0.7 } }, '回答用的模型已保存')
          : null,

        React.createElement('div', { style: ROW },
          React.createElement('label', { style: { fontSize: 12, opacity: 0.8 } }, '超时（毫秒）'),
          React.createElement('input', {
            type: 'number', min: 3000, max: 300000, step: 1000,
            value: draftMs, disabled: busy, style: { ...input, width: 120 },
            onChange: (e) => setDraftMs(e.target.value),
          }),
          React.createElement('button', { type: 'button', disabled: busy, onClick: () => onTimeout(draftMs) }, '保存超时')),
        React.createElement('small', { style: { opacity: 0.7 } }, view.note),
        view.whale && view.whale.path
          ? React.createElement('small', { style: { opacity: 0.7 } }, '鲸鲸插件配置：' + view.whale.path)
          : null);
    }

    function BridgeSection() {
      const [cfg, setCfg] = useState(null);
      const [status, setStatus] = useState(null);
      const [errors, setErrors] = useState([]);
      const [persona, setPersona] = useState(null);
      const [memory, setMemory] = useState(null);
      const [service, setService] = useState(null);
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState({ kind: 'info', text: '' });

      useEffect(() => {
        // No `if (!bridge) return` guard here: without an injected handle the call()
        // helper falls back to the host's HTTP routes, which serve the same data.
        // The guard was why the panel sat on "正在连接宿主…" forever.
        let alive = true;
        Promise.all([call('GET', ROUTES.config), call('GET', ROUTES.status), call('GET', ROUTES.errors), call('GET', ROUTES.persona), call('GET', ROUTES.memory), call('GET', ROUTES.service)])
          .then(([c, s, e, p, m, svc]) => {
            if (!alive) return;
            setCfg(c.config); setStatus(s.status); setErrors(e.errors || []);
            setPersona(p); setDraft(p.value || {}); setMemory(m); setService(svc);
          })
          .catch((err) => { if (alive) setNotice({ kind: 'err', text: '读取失败：' + String(err.message || err) }); });
        return () => { alive = false; };
      }, []);

      /**
        * One switch, both halves. Starting: bring the bridge process up first, then
        * let the plugin take messages over. Stopping: hand messages back first, then
        * stop the process. That order means no window where the plugin asks a dead
        * port — the old two-button layout produced exactly that, as `fetch failed`.
        */
      const toggleBridge = async (on) => {
        setBusy(true);
        try {
          if (on) {
            const svc = await call('PATCH', ROUTES.service, { enabled: true });
            if (svc && svc.ok === false) throw new Error(String(svc.code || '桥接服务没起来'));
            setService(svc);
            const res = await call('PATCH', ROUTES.config, { enabled: true });
            if (res && res.config) setCfg(res.config);
          } else {
            const res = await call('PATCH', ROUTES.config, { enabled: false });
            if (res && res.config) setCfg(res.config);
            const svc = await call('PATCH', ROUTES.service, { enabled: false });
            setService(svc);
          }
          setNotice({ kind: 'ok', text: on ? '已开启：桥接接管微信消息' : '已关闭：微信消息回到鲸鲸自己处理' });
        } catch (err) {
          setNotice({ kind: 'err', text: '操作失败：' + String(err.message || err) });
        } finally { setBusy(false); }
      };

      const saveTimeout = async (ms) => {
        setBusy(true);
        try {
          const value = Number(ms);
          if (!Number.isFinite(value) || value < 3000 || value > 300000) {
            setNotice({ kind: 'err', text: '超时要在 3000 到 300000 毫秒之间' });
            return;
          }
          const res = await call('PATCH', ROUTES.service, { timeoutMs: value });
          if (res && res.ok !== false) { setService(res); setNotice({ kind: 'ok', text: '超时已保存为 ' + value + ' 毫秒' }); }
          else setNotice({ kind: 'err', text: '保存失败：' + String(res && res.code || '未知') });
        } catch (err) {
          setNotice({ kind: 'err', text: '保存失败：' + String(err.message || err) });
        } finally { setBusy(false); }
      };

      const saveService = async (patch) => {
        setBusy(true);
        try {
          const res = await call('PATCH', ROUTES.service, patch);
          if (!res || res.ok === false) {
            setNotice({ kind: 'err', text: '保存失败：' + String(res && res.code || '未知') });
            return;
          }
          setService(res);
          if (res.modelConfig && res.modelConfig.ok === false) {
            setNotice({ kind: 'err', text: '设置已存，但模型配置没写成：' + String(res.modelConfig.reason || '') });
            return;
          }
          // The host restarts the bridge itself when model settings change, so the
          // panel only has to report the outcome — doing it here too would restart
          // twice in a row.
          const wasUp = Boolean(res.running || res.desired);
          if (wasUp) {
            setNotice({ kind: 'ok', text: '已保存并重启，新设置已经生效。' });
            // Give the child a moment, then re-read its real state.
            setTimeout(() => { call('GET', ROUTES.service).then(setService).catch(() => {}); }, 1500);
          } else {
            setNotice({ kind: 'ok', text: '已保存。下次开启桥接时生效。' });
          }
        } catch (err) {
          setNotice({ kind: 'err', text: '保存失败：' + String(err.message || err) });
        } finally { setBusy(false); }
      };

      const grow = async () => {
        setBusy(true);
        try {
          const res = await call('POST', ROUTES.grow);
          if (res.memory) setMemory(res.memory);
          setNotice({ kind: 'ok', text: res.grown ? '人格层已更新（' + res.grown.split('\n').length + ' 条）' : '还没有可成长的第一人称陈述' });
        } catch (err) {
          setNotice({ kind: 'err', text: '整理失败：' + String(err.message || err) });
        } finally { setBusy(false); }
      };

      const patch = async (changes) => {
        setBusy(true); setNotice({ kind: 'info', text: '' });
        try {
          const res = await call('PATCH', ROUTES.config, changes);
          setCfg(res.config);
          if (res.persona) { setPersona(res.persona); setDraft(res.persona.value || {}); }
          const s = await call('GET', ROUTES.status); setStatus(s.status);
          setNotice({ kind: 'ok', text: '已保存' });
        } catch (err) {
          setNotice({ kind: 'err', text: '保存失败（未生效）：' + String(err.message || err) });
        } finally { setBusy(false); }
      };

      const savePersona = () => patch({ customPersona: draft });
      const onDraft = (key, value) => setDraft((prev) => Object.assign({}, prev, { [key]: value }));

      const runSelfcheck = async () => {
        setBusy(true);
        try {
          const res = await call('POST', ROUTES.selfcheck);
          const failed = (res.checks || []).filter((c) => !c.ok);
          setNotice({ kind: res.ok ? 'ok' : 'err', text: res.ok ? ('自检通过（' + (res.checks || []).length + ' 项）') : ('自检失败 ' + failed.length + ' 项：' + failed.map((c) => c.name).join('、')) });
        } catch (err) {
          setNotice({ kind: 'err', text: '自检无法执行：' + String(err.message || err) });
        } finally { setBusy(false); }
      };

      if (!cfg) return React.createElement('ul', null, React.createElement('li', { style: CARD }, '读取中…'));

      return React.createElement('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 } },
        React.createElement('li', { style: CARD },
          React.createElement('div', { style: ROW },
            React.createElement('span', null,
              React.createElement('strong', { style: { display: 'block' } }, '启用桥接'),
              React.createElement('small', { style: { opacity: 0.7 } }, '一个开关管全部：开启后微信消息由 DSH 回答。关掉立刻交还给鲸鲸，正在排队的那几条会被取消')),
            React.createElement('input', { type: 'checkbox', checked: !!cfg.enabled, disabled: busy,
              onChange: (e) => toggleBridge(e.target.checked) })),
          React.createElement('div', { style: FIELD },
            React.createElement('strong', { style: { fontSize: 13 } }, '人格来源'),
            React.createElement('select', { value: cfg.personaSource, disabled: busy, style: { padding: '6px 10px', borderRadius: 6 },
              onChange: (e) => patch({ personaSource: e.target.value }) },
              SOURCES.map((s) => React.createElement('option', { key: s.id, value: s.id }, s.label))),
            React.createElement('small', { style: { opacity: 0.7 } }, SOURCE_HINT[cfg.personaSource] || '')),
          cfg.personaSource === 'custom' ? React.createElement('div', { style: { display: 'grid', gap: 10 } },
            React.createElement(PersonaEditor, { view: persona, draft, onDraft, disabled: busy }),
            React.createElement('div', { style: ROW },
              React.createElement('small', { style: { opacity: 0.7 } }, '改完点保存才会生效'),
              React.createElement('button', { type: 'button', disabled: busy, onClick: savePersona }, '保存人格'))) : null,
          React.createElement(ServiceBlock, { view: service, busy, onTimeout: saveTimeout, onSave: saveService }),
          React.createElement(MemoryBlock, { view: memory, busy, onGrow: grow }),
          React.createElement('div', { style: ROW },
            React.createElement('span', null,
              React.createElement('strong', { style: { display: 'block' } }, '自检'),
              React.createElement('small', { style: { opacity: 0.7 } }, '只在本地跑结构与隔离检查，不连接真实软件')),
            React.createElement('button', { type: 'button', disabled: busy, onClick: runSelfcheck }, '运行自检')),
          React.createElement(Status, { kind: notice.kind, text: notice.text }),
          errors.length ? React.createElement('details', null,
            React.createElement('summary', null, '最近错误 ' + errors.length + ' 条'),
            React.createElement('ul', { style: { fontSize: 12, opacity: 0.85 } },
              errors.slice(-10).map((e) => React.createElement('li', { key: e.id }, e.at + ' ' + e.code + ' @' + e.phase)))) : null));
    }

    /**
      * Sidebar icon for the left rail, drawn with the current text colour like the
      * other entries (dsh-phone does exactly this).
      */
    function BridgeIcon({ size }) {
      const s = size || 18;
      return React.createElement('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        React.createElement('path', { d: 'M3 15v-3a9 9 0 0 1 18 0v3' }),
        React.createElement('path', { d: 'M3 15h3v5H4a1 1 0 0 1-1-1z' }),
        React.createElement('path', { d: 'M21 15h-3v5h2a1 1 0 0 0 1-1z' }));
    }

    /** Full-page wrapper: the sidebar entry opens this, not a settings row. */
    function BridgePage() {
      return React.createElement('div', {
        style: { padding: '24px 28px', maxWidth: 820, boxSizing: 'border-box', height: '100%', overflowY: 'auto' },
      }, React.createElement(BridgeSection));
    }

    function apply(ctx) {
      // Say out loud that we ran. Without this line a load failure and a
      // never-loaded bundle look identical from the outside, which is exactly the
      // hole that cost several restarts.
      console.log('[whale-bridge] client bundle loaded, registering slots');

      // Three independent registrations, each in its own try: on this DSH build the
      // sidebar slot is the goal, but a rejected slot must not take the rest down.
      const trySlot = (name, register) => {
        try { ctx.slots.inject(name, register); console.log('[whale-bridge] registered ' + name); }
        catch (error) { console.error('[whale-bridge] ' + name + ' FAILED', error); }
      };

      // Settings page entry intentionally NOT registered: the owner asked for the
      // left-rail entry only, not an extra settings section.

      // The left rail: icon + the page it opens, sharing one key.
      trySlot('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'whale-bridge', order: 60, label: () => '鲸鲸桥接',
      }, BridgeIcon));

      trySlot('main', () => ctx.slots.register({
        name: 'main', key: 'whale-bridge', inject: () => ({}),
      }, BridgePage));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.setBridge = setBridge;
    return module.exports;
  },
});
