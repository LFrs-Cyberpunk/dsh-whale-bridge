import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyServer } from '../src/proxy.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';
import { BridgeEngine, PersonaResolver } from '../src/core.mjs';
import { MockAdapter } from '../src/adapters/mock.mjs';

/**
 * Whale-Girl's main chat path is `llm.stream()`: it sends `stream: true` and parses
 * `data:` frames, ignoring anything that is not a chunk. A plain JSON body would
 * look like "empty response" to her. These tests replay her exact parsing rules.
 */
const TOKEN = 'stream-test-token-0123456789abcdef';
const meta = { accountId: 'wx-bot', platform: 'wechat', chatType: 'private', chatId: 'wxid_abc', senderId: 'wxid_me', messageId: 'm-1' };

// Copied from src/llm/client.js:248 parseSseLines — the real parser.
function parseSseLines(bufferText) {
  const events = [];
  const chunks = bufferText.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const dataLines = [];
    for (const line of chunk.split(/\r?\n/)) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    if (!dataLines.length) continue;
    events.push(dataLines.join('\n'));
  }
  return events;
}

// Copied from src/llm/client.js:116 pickText — only `content` counts.
function pickText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('');
  return '';
}

/** Replays her stream() consumption to produce what she would actually send. */
function consumeStream(raw) {
  let sent = '';
  let lastFinish = '';
  for (const data of parseSseLines(raw)) {
    if (data === '[DONE]') break;
    let json; try { json = JSON.parse(data); } catch { continue; }
    if (json?.error) throw new Error('stream_error');
    const finish = json?.choices?.[0]?.finish_reason;
    if (finish) lastFinish = finish;
    const piece = pickText(json?.choices?.[0]?.delta);
    if (piece) sent += piece;
  }
  return { sent, lastFinish };
}

async function stack(reply) {
  const engine = new BridgeEngine({
    adapter: new MockAdapter({ reply: ({ message }) => reply ?? `回声:${message.text}` }),
    personas: new PersonaResolver({ readDshPersona: async () => 'DSH人设' }),
    config: { enabled: true, personaSource: 'dsh' },
  });
  const p = createProxyServer({ engine, token: TOKEN });
  const info = await p.listen();
  return { p, info };
}

async function postStream(baseUrl, system, text) {
  const res = await fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }),
  });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', raw: await res.text() };
}

test('stream:true answers with a real SSE body Whale-Girl can parse', async () => {
  const { p, info } = await stack();
  try {
    const system = encodeEnvelope(meta) + '\n你是鲸鲸';
    const { status, contentType, raw } = await postStream(info.baseUrl, system, '在吗');
    assert.equal(status, 200);
    assert.match(contentType, /text\/event-stream/);
    const { sent, lastFinish } = consumeStream(raw);
    assert.equal(sent, '回声:在吗');
    assert.equal(lastFinish, 'stop');
  } finally { await p.close(); }
});

test('long replies are chunked but reassemble byte-for-byte', async () => {
  const long = '长'.repeat(500);
  const { p, info } = await stack(long);
  try {
    const { raw } = await postStream(info.baseUrl, encodeEnvelope(meta), 'x');
    const frames = parseSseLines(raw).filter((d) => d !== '[DONE]');
    assert.ok(frames.length > 2, '应该被切成多帧');
    assert.equal(consumeStream(raw).sent, long);
  } finally { await p.close(); }
});

test('no reasoning field is ever emitted', async () => {
  const { p, info } = await stack();
  try {
    const { raw } = await postStream(info.baseUrl, encodeEnvelope(meta), 'x');
    assert.ok(!/"reasoning/.test(raw), '不得混入思考字段');
    for (const data of parseSseLines(raw)) {
      if (data === '[DONE]') continue;
      const delta = JSON.parse(data).choices[0].delta;
      assert.deepEqual(Object.keys(delta).filter((k) => !['role', 'content'].includes(k)), []);
    }
  } finally { await p.close(); }
});

test('non-streaming requests still get a plain JSON body', async () => {
  const { p, info } = await stack();
  try {
    const res = await fetch(info.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ messages: [{ role: 'system', content: encodeEnvelope(meta) }, { role: 'user', content: '在吗' }] }),
    });
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await res.json()).choices[0].message.content, '回声:在吗');
  } finally { await p.close(); }
});

test('a failing turn produces an SSE-less error, not a half stream', async () => {
  const engine = new BridgeEngine({
    adapter: { kind: 'boom', async generate() { const e = new Error('x'); e.code = 'UPSTREAM_DOWN'; e.status = 503; throw e; } },
    personas: new PersonaResolver({ readDshPersona: async () => 'p' }),
    config: { enabled: true, personaSource: 'dsh' },
  });
  const p = createProxyServer({ engine, token: TOKEN });
  const info = await p.listen();
  try {
    const { status, raw } = await postStream(info.baseUrl, encodeEnvelope(meta), 'x');
    assert.equal(status, 503);
    assert.equal(JSON.parse(raw).error.code, 'UPSTREAM_DOWN');
  } finally { await p.close(); }
});
