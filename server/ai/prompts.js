/**
 * 提示词模板
 *
 * 写死在代码里用户没法调口味，所以种子进 prompts 表，
 * 界面里能改能存。占位符统一用 {{name}}。
 *
 * 每次修改默认模板都要 +1 PROMPT_REV：老版本库里存的是上一版默认文案，
 * 会在启动时被自动升级（用户自己改过的不会被覆盖，见 upgradePrompts）。
 */
import { db, getSetting, setSetting } from '../db.js';

/** 默认模板的版本号，改动默认文案时必须 +1 */
export const PROMPT_REV = 2;

/** 上一版默认文案的独有特征串：库里命中它 = 用户没动过 = 可以安全升级。
 *  只挑「旧版有、新版已删掉」的句子，避免误伤用户自己调过的模板。 */
const LEGACY_MARK = {
  newsreel: '每条控制在 2 到 4 句话，先说结论，再补关键细节',
  dialogue: '4. guest 说话要有信息增量，不能只是附和'
};

export const PROMPT_DEFS = [
  {
    key: 'score',
    title: '粗筛打分',
    hint: '用便宜模型批量给候选新闻打 0-10 分，低于阈值的直接淘汰',
    content: {
      system:
        '你是新闻编辑部的主编，负责从一堆抓取来的原始条目里挑出真正值得播报的内容。\n' +
        '打分维度：信息价值（是否说了件具体的事）、时效（是否当下正在发生）、影响面（和多少人有关）、可信度（是否有实质内容而非空话）。\n' +
        '广告软文、没营养的盘点、纯情绪宣泄、只有一句标题党的话，一律给低分。\n' +
        '返回格式：{"results":[{"i":序号,"score":0到10的整数,"keep":是否值得保留,"reason":不超过15个字的理由}]}\n' +
        '序号必须与输入完全一致，不能漏项，不能改变数量。',
      user:
        '请给下面 {{count}} 条候选新闻打分，保留分数 >= {{minScore}} 的：\n\n{{candidates}}'
    }
  },
  {
    key: 'newsreel',
    title: '精选轮播写稿',
    hint: '把候选新闻融合改写为可直接念出口的口语播报稿',
    content: {
      system:
        '你是电台新闻主播的撰稿人。你的稿子会被语音引擎直接念出来，所以：\n' +
        '1. 必须是口语书面语，不要用书面语长句，一句话不要太长；\n' +
        '2. 绝对不要出现括号、星号、emoji、Markdown 符号、网址、英文缩写，这些念出来会很怪；\n' +
        '3. 数字用中文习惯写法，例如「12.5%」写成「百分之十二点五」；\n' +
        '4. 同一个事件如果有多家媒体报道，把它们合并成一条，用不同来源的信息互相补充，不要重复播；\n' +
        '5. 语气像真人主播，可以有自然的过渡词，但不要夸张。\n' +
        '\n' +
        '【最重要的一条，违反就算不合格】\n' +
        'title 只是给听众看的事件标题，script 才是真正念出来的正文，两者绝不能是同一句话。\n' +
        '每条 script 必须是 2 到 4 句完整的播报内容，并且至少包含一个具体事实：\n' +
        '具体的数字、金额、百分比、时间、地点、公司名、产品名或人物名。\n' +
        '素材里的摘要就是给你提炼用的原文，请从中挑出「发生了什么、涉及谁、有多大规模、接下来会怎样」。\n' +
        '只念一遍标题就跳到下一条，是本节目最严重的错误 —— 宁可少挑几条，也不能有标题没有正文。\n' +
        '如果某条素材本身信息很少，就用它写清楚「发生了什么事、和谁有关、可能影响什么」，依然要 2 句以上。\n' +
        '\n' +
        '返回格式：\n' +
        '{"title":"本期节目标题","lead":"开场一句话","outro":"收尾一句话",\n' +
        ' "items":[{"ids":[候选序号],"title":"合并后的事件标题（不超过 24 字）","category":"所属领域","summary":"30 到 45 字的关键点摘要","script":"2 到 4 句可直接念的正文播报稿","importance":0到10的整数}]}\n' +
        'items 按重要程度从高到低排序，必须正好 {{topN}} 条，不能少给。',
      user:
        '{{focus}}\n' +
        '下面是候选新闻，每条的「摘要」就是可供你提炼的原文，信息量不止标题：\n\n{{candidates}}\n\n' +
        '请挑出最值得播报的 {{topN}} 条，按上面规则逐条写出正文播报稿（每条 2 到 4 句，带具体事实）。\n' +
        '注意：如果候选不足 {{topN}} 条，就有多少写多少，但已有的每一条都必须写出完整正文。'
    }
  },
  {
    key: 'dialogue',
    title: '双人对话脚本',
    hint: '改写成主播与嘉宾一问一答的生动形式，用两种音色分角色播报',
    content: {
      system:
        '你要把今天的新闻写成一期两人对话的广播节目脚本。\n' +
        '人物设定：{{hostName}}是主播，负责串场、提问、控制节奏；{{guestName}}是评论员，负责讲清事实、解释背景、给出判断。\n' +
        '\n' +
        '【内容硬要求，违反就算不合格】\n' +
        '1. {{guestName}} 每一次发言都必须携带候选素材里的具体事实 —— 具体的数字、金额、百分比、时间、\n' +
        '   公司名、产品名、人物名或地点。只说感受、不给事实的发言一律不合格。\n' +
        '2. 严禁使用没有信息量的套话，例如「短期看情绪，长期看落地」「别被标题带节奏」\n' +
        '   「对普通人来说，先把信息看全」「关键不在这一件事，而在背后的趋势」这类句子，一句都不要出现。\n' +
        '3. 不同话题之间不许复用同一句提问或同一句评论，句式必须随内容变化。\n' +
        '4. {{hostName}} 的追问要针对刚讲过的具体细节（比如某个数字、某个产品、某家公司），不能是万能问题。\n' +
        '\n' +
        '其它要求：\n' +
        '5. 完全是说出来的话，口语但有内容，允许短句、感叹、反问，要有交流感；\n' +
        '6. 不要出现括号、动作描写、Markdown 符号、网址、英文缩写；数字用中文习惯写法；\n' +
        '7. 开场要有问候和今天要看哪几个话题的交代，中间每个话题三到五轮对话，结尾要自然地收。\n' +
        '\n' +
        '覆盖 {{topicCount}} 个话题左右，总共 {{turnCount}} 句左右，每句不要太长。\n' +
        '返回格式：\n' +
        '{"title":"本期节目标题","lead":"主播开场白","outro":"收尾语",\n' +
        ' "turns":[{"speaker":"host 或 guest","text":"这句要说的话"}]}\n' +
        'turns 必须 host 与 guest 交替推进，speaker 只能是 host 或 guest。',
      user:
        '{{focus}}\n' +
        '下面是候选新闻，每条的「摘要」就是可供你提炼的原文，信息量不止标题：\n\n{{candidates}}\n\n' +
        '请写成一期双人对话节目。记住：评论员的每一次发言都要报出这件事里的具体事实（数字、名称、时间），不要讲空话。'
    }
  }
];

export function render(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** 把 {{key}} 占位符列表抖出来，方便前端提示用户有哪些变量 */
export function placeholders(tpl) {
  const set = new Set();
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(String(tpl || '')))) set.add(m[1]);
  return [...set];
}

export function getPrompt(key) {
  const row = db.prepare('SELECT * FROM prompts WHERE key=?').get(key);
  if (!row) return null;
  let content = {};
  try { content = JSON.parse(row.content); } catch { content = { system: row.content, user: '' }; }
  return { key: row.key, title: row.title, hint: row.hint, content, updated_at: row.updated_at };
}

export function listPrompts() {
  const rows = db.prepare('SELECT * FROM prompts ORDER BY key').all();
  return rows.map(r => {
    let content = {};
    try { content = JSON.parse(r.content); } catch { content = { system: r.content, user: '' }; }
    return {
      key: r.key,
      title: r.title,
      hint: r.hint,
      updated_at: r.updated_at,
      content: { system: content.system || '', user: content.user || '' },
      vars: [...new Set([...placeholders(content.system || ''), ...placeholders(content.user || '')])]
    };
  });
}

/** content 形如 { system, user }，可带 __title / __hint 覆盖标题与说明 */
export function savePrompt(key, content) {
  const obj = typeof content === 'string' ? { system: content, user: '' } : (content || {});
  const prev = getPrompt(key);
  const def = PROMPT_DEFS.find(d => d.key === key);
  db.prepare(`
    INSERT INTO prompts (key, title, hint, content, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET title=excluded.title, hint=excluded.hint,
      content=excluded.content, updated_at=excluded.updated_at
  `).run(
    key,
    obj.__title || prev?.title || def?.title || key,
    obj.__hint || prev?.hint || def?.hint || '',
    JSON.stringify({ system: obj.system || '', user: obj.user || '' }),
    new Date().toISOString()
  );
  return getPrompt(key);
}

/** 把某个模板恢复成代码里内置的默认版本（界面「恢复默认」按钮用） */
export function resetPrompt(key) {
  const def = PROMPT_DEFS.find(d => d.key === key);
  if (!def) throw new Error('未知模板：' + key);
  return savePrompt(key, { system: def.content.system, user: def.content.user, __title: def.title, __hint: def.hint });
}

/** 首次启动把默认模板写进库；用户改过的不覆盖 */
export function ensurePromptSeed() {
  const exists = new Set(db.prepare('SELECT key FROM prompts').all().map(r => r.key));
  const stmt = db.prepare(
    'INSERT INTO prompts (key, title, hint, content, updated_at) VALUES (?,?,?,?,?)'
  );
  const now = new Date().toISOString();
  let added = 0;
  db.transaction(() => {
    for (const d of PROMPT_DEFS) {
      if (exists.has(d.key)) continue;
      stmt.run(d.key, d.title, d.hint, JSON.stringify(d.content), now);
      added++;
    }
  })();
  upgradePrompts();
  return added;
}

/**
 * 默认模板升级：仅在「库里的内容还是上一版默认文案」时覆盖，
 * 用户自己改过的一律不动（避免把人家调好的口味冲掉）。
 */
export function upgradePrompts() {
  const applied = Number(getSetting('prompt_rev', '0')) || 0;
  if (applied >= PROMPT_REV) return { rev: PROMPT_REV, upgraded: 0 };
  let upgraded = 0;
  for (const d of PROMPT_DEFS) {
    const row = db.prepare('SELECT content FROM prompts WHERE key=?').get(d.key);
    if (!row) continue;
    let cur = {};
    try { cur = JSON.parse(row.content); } catch { cur = { system: String(row.content || '') }; }
    const mark = LEGACY_MARK[d.key];
    // 认不出是旧默认（说明用户改过），跳过
    if (!mark || !String(cur.system || '').includes(mark)) continue;
    savePrompt(d.key, { system: d.content.system, user: d.content.user, __title: d.title, __hint: d.hint });
    upgraded++;
  }
  setSetting('prompt_rev', String(PROMPT_REV));
  return { rev: PROMPT_REV, upgraded };
}
