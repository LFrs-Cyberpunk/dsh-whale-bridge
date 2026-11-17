import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore, MEMORY_LIMITS, visibilityOf, relevance, styleProfile, styleLine, chatBucket, growPersona,
} from '../src/memory.mjs';

async function store(limits) {
  const dir = await mkdtemp(join(tmpdir(), 'whale-mem-'));
  return { dir, mem: new MemoryStore({ root: dir, limits }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('episodes are stored per conversation and never leak into another bucket', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我养了一只猫，叫团子' });
    await mem.record('chatB', { role: 'user', text: '今天加班到十点' });
    const a = await mem.episodes('chatA');
    const b = await mem.episodes('chatB');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.match(a[0].text, /团子/);
    assert.doesNotMatch(JSON.stringify(b), /团子/);
    assert.notEqual(chatBucket('chatA'), chatBucket('chatB'));
  } finally { await cleanup(); }
});

test('privacy: what someone told me stays private, facts about me may travel', () => {
  assert.equal(visibilityOf('我告诉你一个秘密，别告诉别人'), 'private');
  assert.equal(visibilityOf('他说他最近很难受'), 'private');
  assert.equal(visibilityOf('我喜欢吃辣'), 'shareable');
  assert.equal(visibilityOf('今天下雨了'), 'private', '默认保守：不确定就不外传');
});

test('cross-chat lookup only ever returns shareable entries', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢吃辣，火锅要特辣' });          // shareable
    await mem.record('chatA', { role: 'user', text: '我告诉你一个秘密，我欠了钱' });       // private
    const ctx = await mem.buildContext({ chatId: 'chatB', query: '上次说的辣 火锅 秘密 欠钱', persona: '' });
    assert.match(ctx.text, /火锅/);
    assert.doesNotMatch(ctx.text, /欠了钱/, '私密内容不得跨会话出现');
    assert.match(ctx.text, /（别处）/);
  } finally { await cleanup(); }
});

test('memory is only injected when the message reaches backwards', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢听老歌' });
    const plain = await mem.buildContext({ chatId: 'chatA', query: '今天天气怎么样', persona: '' });
    assert.equal(plain.text, '', '普通闲聊不注入记忆');
    const recall = await mem.buildContext({ chatId: 'chatA', query: '你还记得我喜欢听什么吗', persona: '' });
    assert.match(recall.text, /老歌/);
    assert.equal(recall.recalled, true);
  } finally { await cleanup(); }
});

test('no match means no injection at all', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢吃辣' });
    const ctx = await mem.buildContext({ chatId: 'chatB', query: '今天股票怎么样', persona: '' });
    assert.equal(ctx.text, '');
    assert.equal(ctx.episodeLines, 0);
    assert.equal(ctx.chars, 0);
  } finally { await cleanup(); }
});

test('the whole injected block stays under the hard ceiling', async () => {
  const { mem, cleanup } = await store();
  try {
    for (let i = 0; i < 40; i++) await mem.record('chatA', { role: 'user', text: `我喜欢火锅第${i}次，辣度和第${i}次的记忆` });
    const ctx = await mem.buildContext({ chatId: 'chatA', query: '你还记得火锅辣度那次的记忆吗', persona: '我'.repeat(1000) });
    assert.ok(ctx.chars <= MEMORY_LIMITS.totalChars, `实际 ${ctx.chars}`);
    assert.ok(ctx.approxTokens <= 800, `token 估算 ${ctx.approxTokens}`);
    assert.ok(ctx.episodeLines <= MEMORY_LIMITS.topK);
  } finally { await cleanup(); }
});

test('persona oversize is clipped and reported, not silently swallowed', async () => {
  const { mem, cleanup } = await store();
  try {
    const ctx = await mem.buildContext({ chatId: 'x', query: '', persona: '人'.repeat(900) });
    assert.equal(ctx.personaChars, MEMORY_LIMITS.personaChars);
    assert.ok(ctx.dropped.some((d) => d.kind === 'persona'));
  } finally { await cleanup(); }
});

test('local memory outranks other people\'s memory on equal relevance', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢听老歌' });      // shareable
    await mem.record('chatB', { role: 'user', text: '我喜欢听老歌' });      // same text, local to B
    const ctx = await mem.buildContext({ chatId: 'chatB', query: '上次说的老歌', persona: '' });
    assert.match(ctx.text, /我喜欢听老歌/);
    assert.doesNotMatch(ctx.text, /（别处）/);
  } finally { await cleanup(); }
});

test('style profile is statistics, never quoted sentences', () => {
  const samples = ['在吗', '睡了', '？？', '好', '行吧', '哈哈哈哈哈'];
  const p = styleProfile(samples);
  assert.equal(p.samples, 6);
  const line = styleLine(p);
  assert.match(line, /真人说话的习惯/);
  for (const s of samples) assert.ok(!line.includes(s), `不得复述原句：${s}`);
  assert.equal(styleLine({ samples: 2, avgLength: 5, shortShare: 100, noPunctShare: 100, emojiShare: 0 }), '', '样本太少就不下结论');
});

test('relevance is deterministic and 0..1', () => {
  assert.equal(relevance('火锅', '今天吃火锅'), 1);
  assert.equal(relevance('完全不相关', '今天吃火锅'), 0);
  const r = relevance('火锅辣度', '我喜欢火锅，特辣');
  assert.ok(r > 0 && r < 1);
});

test('persona grows only from first-person facts across all conversations', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢吃辣' });
    await mem.record('chatB', { role: 'user', text: '我怕黑' });
    await mem.record('chatB', { role: 'user', text: '他说他最近很难受' });      // 别人说的，不该成人格
    await mem.record('chatB', { role: 'assistant', text: '我喜欢装可爱' });     // 助手说的，不算
    const grown = await growPersona(mem);
    assert.match(grown, /我喜欢吃辣/);
    assert.match(grown, /我怕黑/);
    assert.doesNotMatch(grown, /他说他/);
    assert.doesNotMatch(grown, /装可爱/);
  } finally { await cleanup(); }
});

test('grown persona respects the same hard cap', async () => {
  const { mem, cleanup } = await store({ personaChars: 80 });
  try {
    for (let i = 0; i < 12; i++) await mem.record('chatA', { role: 'user', text: `我喜欢第${i}件事物` });
    const grown = await growPersona(mem);
    assert.ok(grown.length <= 80, `实际 ${grown.length}`);
  } finally { await cleanup(); }
});

test('near-duplicate self statements collapse instead of repeating', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'user', text: '我喜欢吃辣' });
    await mem.record('chatB', { role: 'user', text: '我喜欢吃辣椒' });
    const grown = await growPersona(mem);
    assert.equal(grown.split('\n').filter((l) => l.includes('辣')).length, 1);
  } finally { await cleanup(); }
});

test('no first-person facts means no persona invention', async () => {
  const { mem, cleanup } = await store();
  try {
    await mem.record('chatA', { role: 'assistant', text: '今天天气不错' });
    const grown = await growPersona(mem);
    assert.equal(grown, '');
  } finally { await cleanup(); }
});
