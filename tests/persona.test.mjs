import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblePersona, normalizePersona, personaFilled, personaBudget, PERSONA_FIELDS, PERSONA_GROUPS, PERSONA_LIMITS,
} from '../src/persona.mjs';

const full = {
  identity: '想知道那个每晚听节目却从不留言的人是谁。',
  voice: '句子短，很少用感叹号。',
  habits: '常回"嗯""行"。',
  angry: '不提高音量，改口叫"你"。',
  low: '话变少，只回"没事"。',
  happy: '被夸先否认一句"哪有"。',
  offended: '先沉默，回"行吧"。',
  aboutUser: '把每晚来听的人当成习惯。',
  hardNo: '绝不主动说爱你\n绝不替对方做决定',
  scenes: '有旁人在时只说短句。',
};

test('only one field is required, and it is the want', () => {
  const empty = personaFilled({});
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.fields.filter((f) => f.required).map((f) => f.key), ['identity']);
  assert.equal(personaFilled({ identity: 'x' }).ready, true);
  assert.equal(personaFilled({ voice: 'y' }).ready, false, '只填说话方式不算可用');
});

test('there is no example-dialogue field: the live session supplies the rhythm', () => {
  assert.ok(!PERSONA_FIELDS.some((f) => f.key === 'examples'), '示例对话栏必须已移除');
  assert.equal(PERSONA_LIMITS.examples, undefined);
  const text = assemblePersona(full);
  assert.ok(!text.includes('示例开始'), '不得再拼装人造示例围栏');
});

test('every field carries a placeholder so no box is a blank wall', () => {
  for (const f of PERSONA_FIELDS) {
    assert.ok(typeof f.placeholder === 'string' && f.placeholder.trim().length > 0, `${f.key} 缺示例铺底`);
    assert.ok(typeof f.bad === 'string', `${f.key} 缺反例`);
    assert.ok(f.cap > 0, `${f.key} 缺上限`);
  }
});

test('fields are grouped and every group is declared', () => {
  const ids = new Set(PERSONA_GROUPS.map((g) => g.id));
  for (const f of PERSONA_FIELDS) assert.ok(ids.has(f.group), `${f.key} 的分组未声明`);
  assert.equal(PERSONA_FIELDS.length, 10);
});

test('assembly puts the want first and keeps section order stable', () => {
  const text = assemblePersona(full);
  const order = ['【我在渴望什么】', '【我怎么说话】', '【口头习惯】', '【情绪上来时】', '【我怎么看对方】', '【我绝不做的】', '【换场景】'];
  const positions = order.map((h) => text.indexOf(h));
  assert.ok(positions.every((p) => p >= 0), '每块都要出现');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '顺序必须固定');
  assert.match(text, /不要复述这些文字/);
});

test('the four moods land in one section, in a fixed order', () => {
  const text = assemblePersona(full);
  const mood = text.slice(text.indexOf('【情绪上来时】'), text.indexOf('【我怎么看对方】'));
  assert.match(mood, /生气时：[^]*难过或低落时：[^]*高兴或被夸时：[^]*被冒犯或被挑衅时：/);
});

test('hard no is capped at five short rules', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `规则${i + 1}`).join('\n');
  const p = normalizePersona({ identity: 'x', hardNo: lines });
  assert.equal(p.hardNo.split('\n').length, 5);
  assert.match(assemblePersona({ identity: 'x', hardNo: '- 绝不主动说爱你\n* 绝不替对方做决定' }), /- 绝不主动说爱你\n- 绝不替对方做决定/);
});

test('each field is clamped so one long paste cannot eat the budget', () => {
  const huge = '很'.repeat(5000);
  const src = {};
  for (const f of PERSONA_FIELDS) src[f.key] = huge;
  const p = normalizePersona(src);
  for (const f of PERSONA_FIELDS) {
    const cap = f.key === 'hardNo' ? PERSONA_LIMITS.hardNo : f.cap;
    assert.ok(p[f.key].length <= cap, `${f.key} 超上限`);
  }
});

test('empty profile assembles to nothing, never to a bare instruction', () => {
  assert.equal(assemblePersona({}), '');
  assert.equal(assemblePersona({ voice: '   ' }), '');
});

test('budget reports size tiers honestly', () => {
  assert.equal(personaBudget({}).status, 'empty');
  assert.equal(personaBudget({ identity: '短' }).status, 'thin');
  const good = personaBudget(full);
  assert.ok(['good', 'ok'].includes(good.status), good.status);
  const heavy = personaBudget({ identity: '很'.repeat(300), voice: '长'.repeat(200), habits: '习'.repeat(200), angry: '气'.repeat(150), low: '难'.repeat(150), happy: '高'.repeat(150), offended: '冒'.repeat(150) });
  assert.equal(heavy.status, 'heavy');
  assert.ok(heavy.rawChars > 1200);
});

test('the whole persona is capped near 1200 characters', () => {
  const src = {};
  for (const f of PERSONA_FIELDS) src[f.key] = '字'.repeat(1000);
  const b = personaBudget(src);
  assert.ok(b.chars <= PERSONA_LIMITS.total, `实际 ${b.chars}`);
  assert.ok(b.rawChars > 1200, '填写量应当远大于上限');
  assert.equal(b.trimmed, true, '超长时必须标出被裁剪');
});

test('over-budget input keeps the want and the red lines, drops the rest', () => {
  const src = { identity: '想见他', hardNo: '绝不说爱你', voice: '字'.repeat(200), habits: '习'.repeat(200), scenes: '场'.repeat(200) };
  const src2 = { ...src, voice: '话'.repeat(250) };
  const text = assemblePersona(src2);
  assert.match(text, /【我在渴望什么】/);
  assert.match(text, /【我绝不做的】/);
  assert.ok(text.length <= PERSONA_LIMITS.total);
});

test('budget surfaces the per-turn cost, because it is re-sent every turn', () => {
  const b = personaBudget(full);
  assert.equal(b.perTurnTokens, Math.round(b.chars * 1.1));
  assert.equal(b.longChatTokens, b.perTurnTokens * 100);
  assert.equal(b.turns, 100);
  assert.ok(b.longChatTokens > b.perTurnTokens, '必须体现长会话累计成本');
});
