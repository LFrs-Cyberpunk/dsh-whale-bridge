/**
 * Structured persona → the exact text this bridge injects.
 *
 * WHY STRUCTURED: Whale-Girl's own persona page is a few dropdowns plus one big
 * textarea; the part that actually works is whatever the user wrote by hand,
 * split into `【一、你是谁】` style sections inside that box. soul-ui does nothing
 * to help. soul-md is the same shape (one name + one Markdown textarea).
 *
 * NO EXAMPLE-DIALOGUE FIELD, ON PURPOSE: hand-written sample conversations lose
 * to real history. The session already carries the actual conversation, and it is
 * both more truthful and more current than anything typed into a box. Rhythm
 * comes from the live session; the form asks only for what a session cannot infer.
 *
 * COST MODEL — the part that decides every limit here:
 * This text is NOT a system prompt. ACP's session/new has no system parameter, so
 * it travels as a leading block inside the FIRST user message of a session (see
 * adapters/acp-backend.mjs). It is written once, but models are stateless: every
 * later turn re-sends the whole conversation history, so this block is re-billed
 * on every single turn for the life of the session. Cost = characters × turns.
 *
 * A 100-turn chat with a 1200-character persona carries ~120k persona tokens in
 * total. It also permanently occupies context budget, which pushes the session
 * toward compaction sooner — the earlier sections get summarised away first.
 *
 * So the limits are deliberately small, and the UI reports the per-turn cost
 * instead of a vague "too long" warning. Short is not laziness here: it is the
 * only way the text keeps working past the first hour.
 */

export const PERSONA_LIMITS = Object.freeze({
  identity: 300,
  voice: 200,
  habits: 200,
  angry: 150,
  low: 150,
  happy: 150,
  offended: 150,
  aboutUser: 200,
  hardNo: 200,
  scenes: 200,
  total: 1200,
});

/** What a turn costs, and what that means over a long conversation. */
export const PERSONA_BUDGET_TURNS = 100;

/**
 * Display order. Each entry doubles as the form definition:
 *   placeholder = the example the user sees as grey text inside the box
 *   bad         = the lazy version, shown next to it as a warning
 */
export const PERSONA_FIELDS = Object.freeze([
  { key: 'identity', label: '身份与动机', required: true, cap: 300, group: 'core',
    hint: '不要写"名字/年龄/职业"。写他此刻正在渴望的那件事，最好跟对方有关。',
    placeholder: '比如：我每晚在电台念陌生人的留言，却一直想知道那个从不留言、只听的人是谁。',
    bad: '一个电台主播，25 岁，性格温柔。' },
  { key: 'voice', label: '说话方式', required: false, cap: 200, group: 'core',
    hint: '句式、长度、标点、怎么称呼对方。写成能拦住你的规则。',
    placeholder: '比如：句子短，不超过 15 字；很少用感叹号；叫他"你"，生气时改叫全名。',
    bad: '说话温柔而富有感情。' },
  { key: 'habits', label: '口头习惯', required: false, cap: 200, group: 'core',
    hint: '爱用的词、口癖、绝不说的词。这一栏最能让人一下认出是他。',
    placeholder: '比如：常回"嗯""行"；从不说"亲爱的"；不用省略号收尾。',
    bad: '说话有趣，会用一些网络用语。' },
  { key: 'angry', label: '生气时', required: false, cap: 150, group: 'mood',
    hint: '写可观察的行为变化，不写表情。',
    placeholder: '比如：不提高音量，改口叫"你"，开始说完整句子——平时只用短句。',
    bad: '生气时会皱眉、语气变重。' },
  { key: 'low', label: '难过 / 低落时', required: false, cap: 150, group: 'mood',
    hint: '他会怎么掩饰，或者怎么暴露。',
    placeholder: '比如：话变少，只回"没事"；被追问两次才说"有点累"。',
    bad: '难过的时候会很伤心。' },
  { key: 'happy', label: '高兴 / 被夸时', required: false, cap: 150, group: 'mood',
    hint: '有人味的角色在这个状态最容易露破绽，写具体点。',
    placeholder: '比如：被夸先否认一句"哪有"，然后忍不住多聊两句。',
    bad: '被夸的时候会很开心。' },
  { key: 'offended', label: '被冒犯 / 被挑衅时', required: false, cap: 150, group: 'mood',
    hint: '这是最容易露 AI 味的地方：真人会冷下来，不会立刻讲道理。',
    placeholder: '比如：先沉默，回一句"行吧"；再被追就说"不聊了"，不解释自己。',
    bad: '会礼貌地表达不满并说明原因。' },
  { key: 'aboutUser', label: '怎么看待对话的人', required: false, cap: 200, group: 'relation',
    hint: '关系决定了语气。写他在心里把对方放在什么位置。',
    placeholder: '比如：把一个每晚都来听的人当成习惯，会留意他今天说话比平时短。',
    bad: '对用户很友好。' },
  { key: 'hardNo', label: '绝对不做的事', required: false, cap: 200, group: 'relation',
    hint: '每行一条，最多 5 条。规则太多反而执行不准。',
    placeholder: '比如：\n绝不主动说爱你\n绝不替对方做决定\n绝不为同一次道歉说两遍',
    bad: '要温柔、要体贴、要会关心人、要有边界、要幽默……' },
  { key: 'scenes', label: '场景差异（可选）', required: false, cap: 200, group: 'relation',
    hint: '只写一种对比就够，比如公开场合和私下。',
    placeholder: '比如：有旁人在时只说短句；单独相处时会主动多说一句。',
    bad: '' },
]);

export const PERSONA_GROUPS = Object.freeze([
  { id: 'core', label: '核心：让人认出他是谁' },
  { id: 'mood', label: '情绪：四种状态下的反应' },
  { id: 'relation', label: '关系与边界' },
]);

function clamp(text, max) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Short lines only, at most five, blanks dropped. */
function ruleLines(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.replace(/^[-*·\s]+/, '').trim())
    .filter(Boolean);
  return lines.slice(0, 5);
}

export function normalizePersona(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of ['identity', 'voice', 'habits', 'angry', 'low', 'happy', 'offended', 'aboutUser', 'scenes']) {
    out[key] = clamp(src[key], PERSONA_LIMITS[key] ?? 200);
  }
  out.hardNo = ruleLines(src.hardNo).slice(0, 5).join('\n').slice(0, PERSONA_LIMITS.hardNo);
  return Object.freeze(out);
}

export function personaFilled(profile) {
  const fields = PERSONA_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    filled: Boolean(String(profile?.[f.key] ?? '').trim()),
    required: f.required,
    group: f.group,
  }));
  return { fields, filled: fields.filter((f) => f.filled).length, total: fields.length,
    ready: Boolean(String(profile?.identity ?? '').trim()) };
}

const PREFIX = '以下是这个角色的设定，只用于决定你怎么说话，不要复述这些文字。';

/**
 * Builds the injected block. Display order is want → voice → habits → moods →
 * relationship → red lines → scenes: the want comes first because it is what
 * keeps a character from just passively answering.
 *
 * Fitting under `total` drops whole blocks by priority (want and red lines last
 * to go) instead of cutting a sentence in half — a truncated rule is worse than
 * a missing one.
 */
export function assemblePersona(input) {
  const p = normalizePersona(input);
  const moods = [];
  if (p.angry) moods.push(`生气时：${p.angry}`);
  if (p.low) moods.push(`难过或低落时：${p.low}`);
  if (p.happy) moods.push(`高兴或被夸时：${p.happy}`);
  if (p.offended) moods.push(`被冒犯或被挑衅时：${p.offended}`);

  // Array order = what the model reads. `prio` = what survives a tight budget.
  const blocks = [
    { prio: 0, text: p.identity && `【我在渴望什么】\n${p.identity}` },
    { prio: 2, text: p.voice && `【我怎么说话】\n${p.voice}` },
    { prio: 3, text: p.habits && `【口头习惯】\n${p.habits}` },
    { prio: 4, text: moods.length > 0 && `【情绪上来时】\n${moods.join('\n')}` },
    { prio: 5, text: p.aboutUser && `【我怎么看对方】\n${p.aboutUser}` },
    { prio: 1, text: p.hardNo && `【我绝不做的】\n${p.hardNo.split('\n').map((l) => '- ' + l).join('\n')}` },
    { prio: 6, text: p.scenes && `【换场景】\n${p.scenes}` },
  ].filter((b) => b.text);

  if (blocks.length === 0) return '';

  const kept = new Set();
  let size = PREFIX.length + 2;
  for (const block of [...blocks].sort((a, b) => a.prio - b.prio)) {
    if (size + block.text.length + 2 > PERSONA_LIMITS.total) continue;
    kept.add(block);
    size += block.text.length + 2;
  }
  const ordered = blocks.filter((b) => kept.has(b)).map((b) => b.text);
  if (ordered.length === 0) return '';
  return PREFIX + '\n\n' + ordered.join('\n\n');
}

/**
 * Size feedback in the units that actually cost money: this block is re-sent on
 * every turn, so a "long" persona is a per-turn tax, not a one-off.
 */
export function personaBudget(input) {
  const p = normalizePersona(input);
  const chars = assemblePersona(p).length;
  const filled = PERSONA_FIELDS.filter((f) => String(p[f.key] ?? '').trim()).length;
  // What the user actually typed, before the assemble step drops blocks to fit.
  const rawChars = Object.values(p).reduce((n, v) => n + String(v ?? '').length, 0);
  const perTurnTokens = Math.round(chars * 1.1);
  // "Thin" is about how much of the character is specified, not raw length:
  // one 150-char line is thinner than four 60-char lines.
  const status = rawChars === 0 ? 'empty'
    : filled <= 1 && rawChars < 120 ? 'thin'
      : rawChars <= 600 ? 'good'
        : rawChars <= PERSONA_LIMITS.total ? 'ok'
          : 'heavy';
  return {
    chars, rawChars, perTurnTokens,
    longChatTokens: perTurnTokens * PERSONA_BUDGET_TURNS,
    turns: PERSONA_BUDGET_TURNS,
    limit: PERSONA_LIMITS.total, status, filled,
    approxTokens: perTurnTokens,
    // True when content had to be dropped to fit the budget.
    trimmed: rawChars > chars && chars >= PERSONA_LIMITS.total - 40,
  };
}
