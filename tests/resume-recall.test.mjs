/**
 * "Do you actually remember me?" — the promise this module exists to keep.
 *
 * Two separate guarantees, tested separately because they fail differently:
 *   1. resumed conversation: a new session recalls what the last one discussed
 *   2. recall on demand: an explicit "remember when…" finds the original words
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'whale-recall-'));
  return { dir, mem: new MemoryStore({ root: dir }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a resumed conversation gets a recap of what was actually said', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatX', { role: 'user', text: '我最近在准备一场很重要的面试' });
    await mem.record('chatX', { role: 'assistant', text: '祝你好运' });
    await mem.record('chatX', { role: 'user', text: '面试在下周三' });
    const recap = await mem.recentSummary('chatX');
    assert.match(recap, /面试/);
    assert.doesNotMatch(recap, /祝你好运/, '只要用户说的，不要助手的');
    assert.ok(recap.length <= 200, `摘要必须短：${recap.length}`);
  } finally { await cleanup(); }
});

test('a brand-new conversation gets no invented recap', async () => {
  const { mem, cleanup } = await store();
  try {
    assert.equal(await mem.recentSummary('never-met'), '', '没聊过就不要编');
  } finally { await cleanup(); }
});

test('the recap only takes the tail, so old small talk does not dominate', async () => {
  const { mem, cleanup } = await store();
  try {
    for (let i = 0; i < 12; i++) await mem.record('chatY', { role: 'user', text: `第${i}件小事` });
    const recap = await mem.recentSummary('chatY', { n: 3 });
    assert.match(recap, /第11件/);
    assert.doesNotMatch(recap, /第0件/, '不能把最早那句也带上');
    assert.ok(recap.split('\n').length <= 3);
  } finally { await cleanup(); }
});

test('an explicit "remember when" finds the original line, not a paraphrase', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatZ', { role: 'user', text: '我家猫叫团子，特别怕打雷' });
    const ctx = await mem.buildContext({ chatId: 'chatZ', query: '你还记得我跟你说的打雷那件事吗', persona: '' });
    assert.match(ctx.text, /团子/);
    assert.match(ctx.text, /打雷/);
    assert.match(ctx.text, /你记得的事/, '必须标明这是回忆，不是本轮新说的');
  } finally { await cleanup(); }
});

test('open topics are the things left hanging, not random chatter', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatT', { role: 'user', text: '今天天气不错' });
    await mem.record('chatT', { role: 'user', text: '你说我该不该换工作？' });
    await mem.record('chatT', { role: 'user', text: '我改天再跟你细说' });
    const topics = await mem.openTopics('chatT');
    assert.match(topics, /换工作/);
    assert.match(topics, /细说/);
    assert.doesNotMatch(topics, /天气不错/, '闲聊不是未完成话题');
  } finally { await cleanup(); }
});

test('open topics stay small enough to be a hint, not a script', async () => {
  const { mem, cleanup } = await store();
  try {
    for (let i = 0; i < 10; i++) await mem.record('chatU', { role: 'user', text: `要不要试试第${i}个方案？` });
    const topics = await mem.openTopics('chatU', { n: 3, cap: 160 });
    assert.ok(topics.length <= 160, `必须收得住：${topics.length}`);
  } finally { await cleanup(); }
});
