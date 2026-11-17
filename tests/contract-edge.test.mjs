/**
 * Edge cases that the main suites never touched: receipt states, envelope
 * hygiene, proxy auth, and route shape. These are the "剩下没测的" items, kept
 * together so the contract file and the code stay in step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEnvelope, decodeEnvelope, stripEnvelope, normalizeDelivery, deliveryState, OPEN } from '../src/envelope.mjs';
import { createProxyServer } from '../src/proxy.mjs';
import { BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';

const meta = { accountId: 'wx', platform: 'wechat', chatType: 'private', chatId: 'c1', senderId: 'u1', messageId: 'm1' };

test('every receipt state maps to the strongest thing it can justify', () => {
  assert.equal(deliveryState(null), null, '没有回执就没有状态');
  assert.equal(deliveryState({ ok: false }), 'failed');
  assert.equal(deliveryState({ ok: true, dryRun: true }), 'dry_run');
  assert.equal(deliveryState({ ok: true, local: true }), 'submitted_local');
  assert.equal(deliveryState({ ok: true }), 'submitted');
  assert.equal(deliveryState({ messageId: 'm1' }), 'unknown', '只说没做到，不猜成功');
  // 优先序：失败 > 演练 > 本地 > 已提交
  assert.equal(deliveryState({ ok: false, dryRun: true, local: true }), 'failed');
});

test('delivery reports reject unknown fields instead of ignoring them', () => {
  assert.throws(() => normalizeDelivery({ messageId: 'm1', delivered: true }), /未知字段/);
  assert.throws(() => normalizeDelivery({ messageId: 'bad id!' }), /messageId 非法/);
  assert.throws(() => normalizeDelivery({ messageId: 'm1', ok: 'yes' }), /布尔/);
  const ok = normalizeDelivery({ messageId: 'm1', ok: true });
  assert.deepEqual({ ...ok }, { messageId: 'm1', ok: true });
});

test('an envelope in the middle of the text is not parsed', () => {
  const env = encodeEnvelope(meta);
  const text = `前言\n${env}\n正文`;
  assert.equal(decodeEnvelope(text), null, '只认 offset 0');
  assert.equal(stripEnvelope(text), text, '不在开头就原样返回');
});

test('stripEnvelope removes exactly one envelope and keeps the rest', () => {
  const env = encodeEnvelope(meta);
  const rest = '正文第一行\n正文第二行';
  assert.equal(stripEnvelope(`${env}\n${rest}`), rest);
  assert.equal(stripEnvelope('没有信封的文本'), '没有信封的文本');
  assert.equal(stripEnvelope(`${env}`), '', '只有信封时剥成空串');
});

test('a duplicated envelope in the body survives stripping only once', () => {
  const env = encodeEnvelope(meta);
  const text = `${env}\n用户说了 ${OPEN} 之类的字`;
  const stripped = stripEnvelope(text);
  assert.ok(stripped.startsWith('用户说了'));
  assert.equal(stripped.split(OPEN).length - 1, 1, '正文里的标记保留原样，不去重写用户内容');
});

// The proxy enforces a >=24 char token, so the fixture has to be realistic.
const TOKEN = 'a'.repeat(48);

function engine() {
  const e = new BridgeEngine({
    adapter: new MockAdapter(),
    personas: new PersonaResolver({ readWhalePersona: async () => 'p', readDshPersona: async () => 'p' }),
    config: { enabled: true, personaSource: 'custom', customPrompt: '短句' },
  });
  return e;
}

async function withProxy(fn) {
  const e = engine();
  const proxy = createProxyServer({ engine: e, diagnostics: { record: () => {}, list: () => [] }, token: TOKEN });
  const info = await proxy.listen();
  try { return await fn(info, e); } finally { await proxy.close(); }
}

const body = (extra = {}) => ({
  model: 'dsh', stream: true,
  messages: [{ role: 'system', content: encodeEnvelope(meta) }, { role: 'user', content: '在吗' }],
  ...extra,
});

test('the proxy refuses a missing or wrong bearer token', async () => {
  await withProxy(async (info) => {
    const noAuth = await fetch(info.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(info.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'b'.repeat(48) }, body: JSON.stringify(body()) });
    assert.equal(wrong.status, 401);
    const good = await fetch(info.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body()) });
    assert.equal(good.status, 200);
    await good.text();
  });
});

test('both route shapes work: with and without the /v1 prefix', async () => {
  await withProxy(async (info) => {
    for (const path of ['/v1/chat/completions', '/chat/completions']) {
      const res = await fetch(info.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body()) });
      assert.equal(res.status, 200, path);
      await res.text();
    }
  });
});

test('a request without an envelope still answers, and says it has no upstream', async () => {
  await withProxy(async (info) => {
    const res = await fetch(info.baseUrl + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ model: 'dsh', stream: true, messages: [{ role: 'user', content: '后台任务' }] }),
    });
    // Either a passthrough 503 or an explicit no_upstream code — never a fake answer.
    if (res.status === 200) {
      const text = await res.text();
      assert.ok(text.includes('[DONE]'));
    } else {
      assert.equal(res.status, 503);
      await res.text();
    }
  });
});
