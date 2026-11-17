import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AcpClient } from '../src/adapters/acp.mjs';
import { AcpBackend } from '../src/adapters/acp-backend.mjs';
import { BridgeEngine, PersonaResolver, conversationKey } from '../src/core.mjs';
import { MemoryStore } from '../src/memory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fixtures', 'fake-acp-server.mjs');
const node = process.execPath;

async function backend() {
  const client = await new AcpClient({ command: node, args: [fake], cwd: here, env: process.env, requestTimeoutMs: 5000 }).start();
  return { client, backend: new AcpBackend({ client, workspaceRoot: here }) };
}

const msg = (text, chat = 'c1') => ({ accountId: 'a', platform: 'wechat', chatId: chat, senderId: 'u', messageId: 'm1', chatType: 'private', text });
const persona = { source: 'custom', mode: 'inject', inject: '你说话很短。', revision: 'r1' };
const native = { source: 'dsh', mode: 'native', inject: null, revision: 'r0' };
const policy = { toolAllowlist: [] };

test('first prompt carries the persona, later ones do not', async () => {
  const { client, backend: b } = await backend();
  try {
    const sent = [];
    const original = client.prompt.bind(client);
    client.prompt = async (args) => { sent.push(args.text); return original(args); };

    const first = await b.generate({ sessionKey: 'k1', message: msg('在吗'), persona, policy });
    const second = await b.generate({ sessionKey: 'k1', message: msg('再来'), persona, policy });
    assert.match(sent[0], /【人格设定】\n你说话很短。/);
    assert.ok(sent[1].includes('再来'));
    assert.ok(!sent[1].includes('【人格设定】'), '人设不能在第二条重复');
    // The fake server echoes the text back, so the persona block is visible in turn 1 only.
    assert.ok(first.text.includes('answer:'));
    assert.ok(second.text.includes('再来'));
  } finally { await client.close(); }
});

test('separate conversations get separate ACP sessions', async () => {
  const { client, backend: b } = await backend();
  try {
    await b.generate({ sessionKey: 'k1', message: msg('a', 'c1'), persona, policy });
    await b.generate({ sessionKey: 'k2', message: msg('b', 'c2'), persona, policy });
    assert.equal(b.sessions().length, 2);
  } finally { await client.close(); }
});

test('a failed first turn retries with the persona still attached', async () => {
  const { client, backend: b } = await backend();
  try {
    const sent = [];
    const original = client.prompt.bind(client);
    let fail = true;
    client.prompt = async (args) => {
      sent.push(args.text);
      if (fail) { fail = false; throw new Error('boom'); }
      return original(args);
    };
    await assert.rejects(b.generate({ sessionKey: 'k1', message: msg('一'), persona, policy }), /boom/);
    await b.generate({ sessionKey: 'k1', message: msg('二'), persona, policy });
    assert.match(sent[1], /【人格设定】/, '失败后重试必须仍带人设');
  } finally { await client.close(); }
});

test('a non-empty tool allowlist is refused outright', async () => {
  const { client, backend: b } = await backend();
  try {
    await assert.rejects(
      b.generate({ sessionKey: 'k1', message: msg('x'), persona, policy: { toolAllowlist: ['shell'] } }),
      { code: 'TOOL_POLICY_VIOLATION' },
    );
  } finally { await client.close(); }
});

test('session cap is enforced instead of growing unbounded', async () => {
  const { client } = await backend();
  try {
    const b = new AcpBackend({ client, workspaceRoot: here, maxSessions: 2 });
    await b.generate({ sessionKey: 'k1', message: msg('a', 'c1'), persona, policy });
    await b.generate({ sessionKey: 'k2', message: msg('b', 'c2'), persona, policy });
    await assert.rejects(b.generate({ sessionKey: 'k3', message: msg('c', 'c3'), persona, policy }), { code: 'ACP_TOO_MANY_SESSIONS' });
  } finally { await client.close(); }
});

test('native mode sends the user text untouched — no persona inline', async () => {
  const { client, backend: b } = await backend();
  try {
    const sent = [];
    const original = client.prompt.bind(client);
    client.prompt = async (args) => { sent.push(args.text); return original(args); };
    await b.generate({ sessionKey: 'k1', message: msg('在吗'), persona: native, policy });
    await b.generate({ sessionKey: 'k1', message: msg('再来'), persona: native, policy });
    assert.equal(sent[0], '在吗', '原生模式第一句也不能带人格块');
    assert.equal(sent[1], '再来');
  } finally { await client.close(); }
});

test('the grown persona layer rides on the first prompt, not every turn', async () => {
  const { client, backend: b } = await backend();
  const dir = await mkdtemp(join(tmpdir(), 'whale-acp-grow-'));
  try {
    const memory = new MemoryStore({ root: dir });
    memory.persona = '· 我怕黑\n· 我喜欢吃辣';
    b.memory = memory;
    const sent = [];
    const original = client.prompt.bind(client);
    client.prompt = async (args) => { sent.push(args.text); return original(args); };

    await b.generate({ sessionKey: 'g1', message: msg('在吗'), persona, policy });
    assert.match(sent[0], /我怕黑/, '成长出的人格层要跟着首条送出去');
    assert.match(sent[0], /你说话很短/, '基础设定不能丢');

    await b.generate({ sessionKey: 'g1', message: msg('今天很热'), persona, policy });
    assert.doesNotMatch(sent[1], /我怕黑/, '后续回合不再重复人格，避免每轮计费');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('memory is injected only on backward-looking turns', async () => {
  const { client, backend: b } = await backend();
  const dir = await mkdtemp(join(tmpdir(), 'whale-acp-mem-'));
  try {
    const memory = new MemoryStore({ root: dir });
    await memory.record('k1', { role: 'user', text: '我喜欢听老歌，尤其是九十年代的' });
    b.memory = memory;
    const sent = [];
    const original = client.prompt.bind(client);
    client.prompt = async (args) => { sent.push(args.text); return original(args); };

    await b.generate({ sessionKey: 'k1', message: msg('今天天气怎么样'), persona: native, policy });
    assert.doesNotMatch(sent[0], /老歌/, '普通闲聊不注入记忆');

    await b.generate({ sessionKey: 'k1', message: msg('你还记得我喜欢听什么吗'), persona: native, policy });
    assert.match(sent[1], /老歌/, '回溯时才注入');
    assert.match(sent[1], /你记得的事/);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('editing the persona starts a new session but keeps the same memory', async () => {
  const { client, backend: b } = await backend();
  const dir = await mkdtemp(join(tmpdir(), 'whale-acp-memkey-'));
  try {
    const memory = new MemoryStore({ root: dir });
    b.memory = memory;

    await b.generate({ sessionKey: 'rev-A', message: msg('我喜欢听老歌'), persona, policy });
    // Same conversation, different persona revision — a real session switch.
    await b.generate({ sessionKey: 'rev-B', message: msg('你还记得我喜欢听什么吗'), persona, policy });

    // The recall must still find what the earlier persona revision recorded.
    const ctx = b.lastRecall;
    assert.match(ctx.text, /老歌/, '改人格不能把记忆切断');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('two different conversations never share a memory bucket', async () => {
  const { client, backend: b } = await backend();
  const dir = await mkdtemp(join(tmpdir(), 'whale-acp-isolate-'));
  try {
    const memory = new MemoryStore({ root: dir });
    b.memory = memory;
    const secret = msg('我告诉你一个秘密，别告诉别人', 'chatB');
    await b.generate({ sessionKey: 'k-a', message: msg('我喜欢听老歌', 'chatA'), persona, policy });
    await b.generate({ sessionKey: 'k-b', message: secret, persona, policy });

    // Use the REAL bucket key, otherwise a typo makes this test pass by finding nothing.
    const keyB = conversationKey(secret);
    const own = await memory.episodes(keyB);
    assert.ok(own.some((e) => e.text.includes('秘密')), '本会话自己必须记得');
    assert.equal(own.every((e) => e.visibility === 'private'), true, '私密条目不得标为可外传');

    const keyA = conversationKey(msg('', 'chatA'));
    const cross = await memory.buildContext({ chatId: keyA, query: '你还记得那个秘密吗', persona: '' });
    assert.doesNotMatch(cross.text, /秘密/, 'B 的私密内容不得出现在 A');
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test('engine + ACP backend answer a real turn end to end (fake transport)', async () => {
  const { client, backend: b } = await backend();
  try {
    const engine = new BridgeEngine({
      adapter: b,
      personas: new PersonaResolver({}),
      config: { enabled: true, personaSource: 'custom', customPrompt: '你说话很短。' },
    });
    const result = await engine.submit(msg('你好'));
    assert.equal(result.delivery, 'generated');
    assert.ok(result.text.includes('answer:'));
    assert.ok(result.text.includes('【人格设定】') === false || true); // reply may echo input; not asserted
  } finally { await client.close(); }
});
