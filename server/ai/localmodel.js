/**
 * 内置演示模型（不需要联网、不需要 API key）
 *
 * 存在的理由：
 * 这个系统的价值在「本地去重 → 打分筛选 → 融合写稿 → 逐句播报」这条流水线上。
 * 但没接真实大模型 key 的时候，用户点「生成」只会得到一个报错，完全看不到流水线跑通的样子。
 *
 * 所以这里内置一个**抽取式**的替代模型：它不做自由创作，而是老老实实从流水线喂进来的
 * 候选原文里，把「事实句」「背景/判断句」挑出来，按提示词的格式要求组装成播报稿。
 *
 * 三条设计原则（上一版演示模型就是在这三条上翻车的）：
 *   1. 内容必须来自真实素材 —— 不允许出现与候选无关的通用话术；
 *   2. 不允许复用同一句式 —— 选句靠内容哈希 + 期内轮换，不再用固定数组取模，
 *      否则每一轮都是「短期看情绪，长期还是看落地」；
 *   3. 每条都得有实质内容 —— 精选的正文是事实句拼出来的，不是把标题再念一遍。
 *
 * 它不是用来替代真实模型的，措辞肯定不如云端模型流畅；
 * 但它跑出来的结构、数据、去重结果与接入真实 key 后完全一致。
 */

export const LOCAL_DEMO_URL = 'internal://local-demo';

import { stripBodyNoise, clipSentences, isEchoTitle, hasAlienChars } from './preprocess.js';

/** 这个方案是不是内置演示模型 */
export function isLocalDemo(p) {
  return String(p?.base_url || '').trim().toLowerCase().startsWith(LOCAL_DEMO_URL);
}

const CJK = /[\u4e00-\u9fff]/;
const hasCJK = s => CJK.test(String(s || ''));

const D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function intToCN(n) {
  if (n === 0) return '零';
  if (n < 10) return D[n];
  if (n < 20) return '十' + (n % 10 ? D[n % 10] : '');
  if (n < 100) return D[Math.floor(n / 10)] + '十' + (n % 10 ? D[n % 10] : '');
  if (n < 1000) return D[Math.floor(n / 100)] + '百' + (n % 100 ? intToCN(n % 100) : '');
  return String(n);
}

/** 1234.5 → 一千二百三十四点五，让语音引擎念得自然 */
function toCN(num) {
  const neg = num < 0;
  const v = Math.abs(num);
  const [ip, dp] = String(v).split('.');
  let r = intToCN(Number(ip));
  if (dp) r += '点' + dp.split('').map(d => D[Number(d)] ?? d).join('');
  return (neg ? '负' : '') + r;
}

/** 清理成可直接念出口的样子：去网址、去括号、百分数转中文、去 Markdown */
function spoken(s) {
  return String(s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(\d+(?:\.\d+)?)\s*[-~—至]\s*(\d+(?:\.\d+)?)%/g,
      (m, a, b) => `百分之${toCN(Number(a))}至百分之${toCN(Number(b))}`)
    .replace(/(\d+(?:\.\d+)?)%/g, (m, p) => `百分之${toCN(Number(p))}`)
    .replace(/[（(][^）)]{0,40}[）)]/g, '，')
    .replace(/[【】[\]*_`#~>|]/g, ' ')
    .replace(/\.{3,}|…+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。、])/g, '$1')
    .replace(/([，。、])+/g, '$1')
    .replace(/^[，。、\s]+/, '')
    .trim();
}

/** 站点导语噪音，念出来毫无信息量 */
const NOISE = [
  /IT之家[^，。]{0,14}(?:消息|获悉|注|附)[，,：:]?/g,
  /据[^，。]{0,16}(?:报道|消息|悉)[，,]?/g,
  /^(?:快科技|新浪科技|网易科技|腾讯科技|澎湃新闻|界面新闻)\s*\d*\s*月?\s*\d*\s*日?[，,]?\s*/g,
  /原标题[：:]\s*/g
];

function denoise(s) {
  let t = stripBodyNoise(String(s || ''));
  for (const re of NOISE) t = t.replace(re, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** 切句：中文标点断句，过滤掉过短碎片、混了外文乱码的句子 */
function sentences(raw) {
  const t = denoise(raw);
  if (!t) return [];
  return t
    .split(/(?<=[。！？；])/)
    .map(s => s.trim())
    .filter(s => {
      if (hasAlienChars(s)) return false;
      const bare = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
      return bare.length >= 8 && hasCJK(bare);
    });
}

/* ---------------- 句子价值判定 ---------------- */

const NUM_RE = /\d|\b百分之|亿|万|千|元|美元|港币|倍/;
const ACT_RE = /(宣布|发布|推出|上市|开售|发售|收购|并购|签约|中标|获批|完成|突破|超过|达到|增长|下跌|上涨|创下|首发|上线|落地|投产|扩建|融资|上市|处罚|召回|裁员|离职|起诉|合作|投资)/;
const VIEW_RE = /(意味着|影响|原因|因为|由于|原因在于|分析师|认为|指出|预计|有望|可能|风险|挑战|机会|压力|关键|核心|预计|目标|计划|下一步)/;

/** 一句原文值不值钱：带数字 + 动词最值钱，带判断词次之；
 *  命中标题里的实体（型号/数字/专名）再加分，保证正文讲的是同一件事。 */
function rankSentence(s, titleTokens) {
  let v = 0;
  if (NUM_RE.test(s)) v += 4;
  if (ACT_RE.test(s)) v += 3;
  if (VIEW_RE.test(s)) v += 2;
  if (/[A-Za-z]{2,}/.test(s)) v += 1;
  if (s.length >= 20 && s.length <= 60) v += 1;
  if (s.length > 90) v -= 2;
  if (titleTokens && titleTokens.size) {
    const toks = String(s).match(/[A-Za-z][A-Za-z0-9.+\-]*|\d+(?:\.\d+)?/g) || [];
    for (const t of toks) {
      if (titleTokens.has(t.toLowerCase())) { v += 2; break; }
    }
  }
  return v;
}

/** 从候选素材里挑出「事实句 / 补充句 / 判断句」三类素材，按原文顺序排好 */
function mineMaterial(raw, title) {
  const t = denoise(raw);
  const titleTokens = new Set(
    (String(title || '').match(/[A-Za-z][A-Za-z0-9.+\-]*|\d+(?:\.\d+)?/g) || []).map(x => x.toLowerCase())
  );
  // 列表页摘要是拼接出来的，「需要注意的是…」这类段落经常整段出现两次，先去重
  const seenSentence = new Set();
  const scored = sentences(t).map(s => {
    const dedupKey = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 16);
    if (dedupKey && seenSentence.has(dedupKey)) return { s, v: -99 };
    seenSentence.add(dedupKey);
    // 与标题高度相似的句子直接丢掉，否则会出现「标题念两遍」
    const echo = isEchoTitle(s, title);
    return { s, v: echo ? -99 : rankSentence(s, titleTokens) };
  }).filter(x => x.v > -50);

  const facts = scored.filter(x => x.v >= 4).sort((a, b) => b.v - a.v).map(x => x.s);
  const views = scored.filter(x => x.v < 4 && VIEW_RE.test(x.s)).map(x => x.s);
  const rest = scored.filter(x => !facts.includes(x.s) && !views.includes(x.s)).map(x => x.s);
  return { facts, views, rest, all: scored.map(x => x.s) };
}

/* ---------------- 内容哈希（保证句式随内容变化） ---------------- */

function hashOf(s) {
  let h = 2166136261;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 期内轮换取词：以内容哈希为起点，每次调用向后走一格，用完才回头 */
function makeRotator(list, seed) {
  let i = list.length ? hashOf(seed) % list.length : 0;
  return () => {
    if (!list.length) return '';
    const v = list[i % list.length];
    i++;
    return v;
  };
}

/* ---------------- 解析流水线喂进来的候选清单 ---------------- */

function parseCandidates(user) {
  const out = [];
  for (const line of String(user || '').split('\n')) {
    const m = line.match(/^#(\d+)\s*\|/);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    let site = '', title = '', summary = '', hot = '';
    let mode = '';
    for (const seg of rest.split(' | ')) {
      if (seg.startsWith('来源')) { site = seg.replace(/^来源\d*家?：/, '').trim(); mode = 'site'; }
      else if (seg.startsWith('标题：')) { title = seg.slice(3).trim(); mode = 'title'; }
      else if (seg.startsWith('摘要：')) { summary = seg.slice(3).trim(); mode = 'summary'; }
      else if (seg.startsWith('热度：')) { hot = seg.slice(3).trim(); mode = 'hot'; }
      else if (mode === 'summary') summary += ' | ' + seg;
      else if (mode === 'title') title += ' | ' + seg;
    }
    if (title) out.push({ idx: Number(m[1]), site, title, summary, hot });
  }
  return out;
}

const numOf = (user, re, fb) => {
  const m = String(user || '').match(re);
  return m ? Number(m[1]) : fb;
};

/* ---------------- 从事实句里挑一个「可追问的抓手」 ---------------- */

/** 量词/单位：只有带单位的数字才值得追问，光一个「2025」问不出东西 */
const UNIT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(亿美元|万美元|亿元|万元|亿|万片|万台|万部|万辆|万个|万|个百分点|美元|元|片|台|辆|架|款|人|次|%|倍|GB|TB|MB\/s|mAh|nm|Gbps|Hz|W)/g;

function pickHandle(fact, title) {
  const pool = [String(fact || ''), String(title || '')];
  for (const s of pool) {
    // ① 带单位的数字最有信息量，优先取最长的那个
    const units = [...s.matchAll(UNIT_RE)].map(m => (m[1] + m[2]).trim());
    if (units.length) {
      const hit = units.sort((a, b) => b.length - a.length)[0];
      if (hit) return hit;
    }
  }
  for (const s of pool) {
    // ② 英文专名（产品名、公司名），跳过 iOS 这种人人皆知的缩写
    const SKIP = new Set(['iOS', 'iPadOS', 'watchOS', 'macOS', 'CEO', 'IPO', 'GPU', 'CPU', 'AND', 'THE']);
    const en = (s.match(/[A-Za-z][A-Za-z0-9.+]{2,}/g) || []).filter(x => !SKIP.has(x) && /[a-z]/.test(x));
    if (en.length) return en.sort((a, b) => b.length - a.length)[0];
  }
  for (const s of pool) {
    // ③ 书名号/引号里的名字，比如游戏名、代号
    const q = s.match(/[《“"]([^》”"]{2,12})[》”"]/);
    if (q) return q[1];
  }
  return '';
}

/** 对话里念全标题太拗口：优先在标点处收口，绝不切出半个英文单词或数字 */
function shortTitle(raw) {
  const full = spoken(String(raw || ''));
  const seg = full.split(/[：:（(【]/)[0];
  if (seg.length <= 24) return seg;
  for (const sep of ['，', ',', '、', '；', ';', '—', ' ']) {
    const head = seg.split(sep)[0];
    if (head && head.length >= 10) return head.trim();
  }
  let cut = seg.slice(0, 24);
  while (cut.length && /[A-Za-z0-9]$/.test(cut)) cut = cut.slice(0, -1);
  cut = cut.replace(/[\s，,、：:；;]+$/, '');
  return cut || seg.slice(0, 24);
}

/** 把素材压成 2-3 句正文：事实 → 补充 → 判断 */
function composeBody(material, title) {
  const picked = [];
  const push = s => { if (s && !picked.includes(s)) picked.push(s); };
  if (material.facts[0]) push(material.facts[0]);
  if (material.facts[1]) push(material.facts[1]);
  else if (material.rest[0]) push(material.rest[0]);
  if (material.views[0]) push(material.views[0]);
  else if (material.rest[1]) push(material.rest[1]);
  if (!picked.length && material.all[0]) push(material.all[0]);
  const body = picked.slice(0, 3).map(s => spoken(clipSentences(s, 96))).join('');
  return body || spoken(String(title || ''));
}

/* ---------------- 精选轮播 ---------------- */

function synthNewsreel(cands, user) {
  const topN = Math.min(30, numOf(user, /最值得播报的\s*(\d+)\s*条/, 12));
  const rotIntro = makeRotator(['这一条，', '接下来看，', '还有一条，', '再看一个，', '换个方向，', '另一件事，'], user.slice(0, 120));

  const items = [];
  const seen = new Set();
  for (const c of cands) {
    if (items.length >= topN) break;
    if (!hasCJK(c.title)) continue;                       // 英文趋势榜等直接跳过
    const material = mineMaterial(c.summary || c.title, c.title);
    const body = composeBody(material, c.title);
    if (!body || body.length < 20) continue;              // 没有实质内容的不要
    const key = spoken(c.title).slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      ids: [c.idx],
      title: spoken(c.title),
      category: '',
      summary: body.slice(0, 44),
      script: body,
      importance: 10 - Math.floor(items.length / 3)
    });
  }

  const lead = items.length
    ? `欢迎收听本期精选，今天给你梳理了 ${items.length} 件最值得关注的事，我们从最新的一条说起。`
    : '今天没有筛出值得播报的内容。';

  return JSON.stringify({
    title: items.length ? `今日精选 ${items.length} 条 · ${shortTitle(items[0].title)}` : '今日精选（没有合适内容）',
    lead,
    outro: '以上就是本期全部内容，每条后面都能点开看原文，我们下期再见。',
    items
  });
}

/* ---------------- 双人对话 ---------------- */

/** 追问模板：{} 会被替换成该条事实里的具体抓手，问句因此不可能重复 */
const ASK_TPL = [
  '你刚才提到 {}，这个量级在行业里算什么水平？',
  '{}这个变化，是短期波动还是趋势性的？',
  '为什么这次会出现 {} 这样的结果？',
  '{} 背后，主要是哪股力量在推动？',
  '如果 {} 的势头延续下去，谁最先受到冲击？',
  '{} 这一条，最值得盯的后续节点是什么？',
  '落到普通用户身上，{} 意味着什么？',
  '{} 会不会带动上下游一起变？'
];

/** 拿不到具体抓手时用的问法（不含占位符，不会露馅） */
const ASK_SAFE = [
  '这件事最值得盯的后续节点是什么？',
  '放到更大的盘子里看，它意味着什么？',
  '为什么偏偏是现在出现这个变化？',
  '它会牵动到哪些相关方？'
];

/** 原文里没有现成的判断句时，用带抓手的分析句兜底（不做空话） */
const VIEW_TPL = [
  '这一条真正的看点是 {} 后面还有没有第二波。',
  '关键变量是 {}，它决定了这件事能走多远。',
  '把它放到 {} 这个坐标里看，性质会清楚很多。',
  '{} 摆在这儿，已经不是小规模的动作了。',
  '往深一层看，{} 是结果不是原因，还得往前推一步。',
  '接下来要盯的，就是 {} 能不能稳得住。'
];

function synthDialogue(cands, user) {
  const topicCount = Math.min(8, numOf(user, /覆盖\s*(\d+)\s*个话题/, 5));
  const hostName = '主播';

  const topics = [];
  const seen = new Set();
  for (const c of cands) {
    if (topics.length >= topicCount) break;
    if (!hasCJK(c.title)) continue;
    const material = mineMaterial(c.summary || c.title, c.title);
    const fact = material.facts[0] || material.all[0];
    if (!fact) continue;
    const key = spoken(c.title).slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push({ c, material, fact });
  }

  // 用整段素材做种子决定句式起点：同一期内部不重复，不同期起始不同
  const seed = (user.match(/标题：([^\n|]{0,30})/)?.[1] || '') + topics.length + String(cands.length);
  const rotIntro = makeRotator([
    '先聊一个，', '接着看，', '再说一个，', '还有一个，', '顺便聊聊，', '最后看，', '换个话题，', '再补一条，'
  ], seed + 'i');
  const rotAsk = makeRotator(ASK_TPL, seed + 'a');
  const rotSafe = makeRotator(ASK_SAFE, seed + 's');
  const rotView = makeRotator(VIEW_TPL, seed + 'v');

  const turns = [];
  const push = (speaker, text) => {
    const t = spoken(text);
    if (t) turns.push({ speaker, text: t });
  };
  const used = new Set();   // 期内不重复使用同一句原文
  const keyOf = s => String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 16);
  /** 取一句没用过的原文（三档依次降级），并登记已用 */
  const take = (...lists) => {
    for (const list of lists) {
      for (const s of list || []) {
        const k = keyOf(s);
        if (!s || (k && used.has(k))) continue;
        if (k) used.add(k);
        return s;
      }
    }
    return '';
  };

  push('host', `今天我们从最新的一批消息里挑了 ${topics.length} 个话题，逐个说清楚。`);

  topics.forEach(t => {
    const material = t.material;
    const title = shortTitle(t.c.title);

    // 先把素材备齐再开口，避免「主播抛了话题没人接」
    const f1 = take(material.facts, material.all) || t.fact;
    if (!f1) return;
    used.add(keyOf(f1));
    const f2 = take(material.facts, material.rest, material.all);
    const view = take(material.views, material.rest, material.all);

    // 主播抛话题
    push('host', `${rotIntro()}${title}。`);

    // 评论员讲事实：正好带出这条新闻的具体数字/名称
    const parts = [f1];
    if (f2 && spoken(f1).length < 42) parts.push(f2);   // 事实句够长就别再堆，免得一口气讲四句
    push('guest', parts.map(s => spoken(clipSentences(s, 92))).join(''));

    // 主播针对事实里的具体抓手追问 —— 抓手不同，问题就不可能重复
    const handle = pickHandle(f1, title);
    push('host', handle ? rotAsk().replace('{}', handle) : rotSafe());

    // 评论员给判断：优先原文自带的判断句，没有才用带抓手的分析句；
    // 连抓手都没有就老实收口，不要硬凑一句空话
    push('guest', view
      ? spoken(clipSentences(view, 92))
      : (handle
        ? rotView().replace(/\{\}/g, handle)
        : '目前公开的信息就这些，后面有新进展我们接着说。'));
  });

  push('host', '好，今天就说到这，明天同一时间我们继续替你把信息筛一遍。');

  return JSON.stringify({
    title: topics.length ? `对谈 · ${shortTitle(topics[0].c.title)} 等 ${topics.length} 件事` : '对谈（没有合适话题）',
    lead: `大家好，欢迎收听今天的对谈节目，我是${hostName}。`,
    outro: '感谢收听，我们下期再会。',
    host_name: hostName,
    guest_name: '评论员',
    turns
  });
}

/* ---------------- 打分 ---------------- */

function synthScore(cands) {
  const results = cands.map(c => {
    const material = mineMaterial(c.summary || c.title, c.title);
    const bodyLen = spoken(c.summary || '').length;
    const noCN = !hasCJK(c.title) && !hasCJK(c.summary);
    const thin = bodyLen < 18;
    const rich = material.facts.length >= 2 || /(宣布|发布|推出|收购|突破|上市|开售|签约|完成)/.test(c.title);
    const weak = noCN || thin;
    return {
      i: c.idx,
      score: weak ? 3 : (rich ? 9 : 7),
      keep: !weak,
      reason: noCN ? '非中文，价值低' : (thin ? '内容偏空' : (rich ? '事实具体' : '信息一般'))
    };
  });
  return JSON.stringify({ results });
}

/* ---------------- 对外入口 ---------------- */

export function localDemoChat(system, user) {
  const sys = String(system || '');
  const cands = parseCandidates(user);
  let content;
  try {
    if (sys.includes('打分')) content = synthScore(cands);
    else if (sys.includes('两人对话')) content = synthDialogue(cands, user);
    else content = synthNewsreel(cands, user);
  } catch (e) {
    content = JSON.stringify({ error: '演示模型内部错误：' + String(e.message || e) });
  }
  return {
    content,
    usage: {
      prompt: Math.round(String(user || '').length / 2),
      completion: Math.round(content.length / 2)
    }
  };
}
