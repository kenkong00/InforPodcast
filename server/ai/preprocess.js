/**
 * 本地预处理：零成本地把几千条原始稿砍到几百条
 *
 * 这一层必须放在大模型前面。直接把 3000 条原文丢给 API，光 input token 就能烧掉
 * 几十万，而且延迟不可接受。这里的规则全是本地计算，毫秒级，
 * 负责干两件脏活：① 把「同一件事、十家媒体报道」合成一簇；② 把标题党和空壳稿扔掉。
 */

/* ---------------- 标题归一化 ---------------- */

/** 站点常见后缀，去掉后再比对相似度，否则“- 新浪财经”会干扰 */
const SITE_SUFFIX = [
  '_百度知道', '-知乎', '_知乎', '-简书', '_bilibili', '-哔哩哔哩', '-哔哩哔哩弹幕网',
  '-今日头条', '-腾讯新闻', '-新浪财经', '-网易财经', '-搜狐网', '-澎湃新闻', '-微博',
  '-新浪网', '-观察者网', '-界面新闻', '-36氪', '-虎嗅网', '-豆瓣', '-什么值得买'
];

const CLICKBAIT = [
  '震惊', '惊呆', '炸了', '炸锅', '速看', '紧急通知', '千万别', '不看后悔', '后悔一辈子',
  '赶紧看', '火了', '疯了', '惊现', '奇葩', '刚刚传来', '出大事', '即将暴涨', '必看',
  '通知：', '重要提醒', '限时', '最后的机会', '秘密', '真相竟然', '居然这样', '删前速看',
  '快讯！', '紧急！', '刚刚！', '独家！', '突发！'
];

const JUNK_TITLE = [
  '相关推荐', '更多精彩', '点击查看', '阅读全文', '更多内容', '猜你喜欢', '推荐阅读',
  '广告', '免责声明', '友情链接', '版权声明', '上一篇', '下一篇'
];

export const DEFAULT_FILTER = {
  minTitleLen: 6,
  minBodyChars: 80,
  dropNoBody: true,
  dropClickbait: true,
  maxAgeHours: 0,
  similarity: 0.62
};

function fullToHalf(s) {
  return String(s).replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

export function normalizeTitle(raw) {
  let s = String(raw || '');
  s = fullToHalf(s);
  s = s.replace(/^【[^】]{0,20}】/, '').replace(/^\[[^\]]{0,20}\]/, '');
  s = s.replace(/^《[^》]{0,40}》/, '');
  for (const suf of SITE_SUFFIX) {
    if (s.endsWith(suf)) s = s.slice(0, -suf.length);
  }
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // 只保留中英日数字，其余全部当分隔符 —— 标点写法不同不该影响相似度
  s = s.replace(/[^一-龥a-zA-Z0-9]/g, '');
  if (/^[a-zA-Z]/.test(s)) s = s.toLowerCase();
  return s;
}

/* ---------------- 相似度 ---------------- */

/** 字符 2-gram 集合。中文没有空格分词，按字切比按词切稳得多 */
function bigrams(s) {
  const t = '^' + s + '$';
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (set.size === 0 && t.length) set.add(t);
  return set;
}

/** Dice 系数：交集越大、长度越接近，分越高 */
export function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/* ---------------- 关键实体令牌守卫 ----------------
 * 「苹果 watchOS 27.0.1 发布」和「苹果 visionOS 27.0.1 发布」字符重合度极高，
 * 纯 Dice 会误判成同一条 —— 但它们明明是三件事。
 * 解决办法：再比对一次英文/数字令牌。两边各有对方没有的关键令牌，
 * 且这些令牌互相又都不像，就认定是不同事件，禁止合并。 */

const KEY_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*|[0-9]+(?:\.[0-9]+)*/g;

export function keyTokens(title) {
  const raw = String(title || '').replace(/[（(][^）)]*[）)]/g, ' ');
  const out = new Set();
  for (const m of raw.match(KEY_TOKEN_RE) || []) out.add(m.toLowerCase());
  return out;
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1).fill(0);
  const cur = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/** true = 可以合并；false = 有冲突的关键令牌，判定为不同事件 */
export function tokensCompatible(ta, tb) {
  const ua = [...ta].filter(x => !tb.has(x));
  const ub = [...tb].filter(x => !ta.has(x));
  // 只有一方多出令牌 = 同一件事的详略两种写法（带副标题 vs 不带），可以合并
  if (!ua.length || !ub.length) return true;
  for (const x of ua) {
    for (const y of ub) {
      if (x === y) return true;
      if (Math.abs(x.length - y.length) <= 2 && editDistance(x, y) <= 2) return true;
    }
  }
  return false;
}

/**
 * 贪心聚类。
 * 顺序很重要：先按「优先级」排好，簇的代表条目永远是最优质那条，
 * 后面重复稿只能当 members，不会抢掉优质那条的代表资格。
 */
export function clusterArticles(rows, threshold = 0.62) {
  const index = new Map();   // bigram -> [clusterIdx]
  const clusters = [];

  for (const row of rows) {
    const norm = normalizeTitle(row.title);
    const grams = bigrams(norm);

    // 借倒排索引找候选簇，避免 O(n²) 全量比对
    const hits = new Map();
    for (const g of grams) {
      const list = index.get(g);
      if (!list) continue;
      for (const ci of list) hits.set(ci, (hits.get(ci) || 0) + 1);
    }
    const rowTokens = keyTokens(row.title);
    let best = -1;
    let bestScore = 0;
    const candidates = [...hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(e => e[0]);
    for (const ci of candidates) {
      const c = clusters[ci];
      const score = dice(grams, c.grams);
      if (score < threshold || score <= bestScore) continue;
      // 字符够像还不够：关键实体令牌对不上就是两件事
      if (!tokensCompatible(c.tokens, rowTokens)) continue;
      bestScore = score;
      best = ci;
    }

    if (best >= 0) {
      const c = clusters[best];
      c.members.push(row);
      // 若后来者明显更完整（有正文 / 字数更多），换它当代表，但保留原 lead 为 member
      if (leadScore(row) > leadScore(c.lead)) {
        c.members.push(c.lead);
        c.lead = row;
        c.grams = grams;
        c.tokens = rowTokens;
      }
      continue;
    }

    const ci = clusters.length;
    clusters.push({ lead: row, members: [row], grams, tokens: rowTokens });
    for (const g of grams) {
      const list = index.get(g);
      if (list) list.push(ci); else index.set(g, [ci]);
    }
  }
  return clusters;
}

/** 谁更有资格当这一簇的代表：有正文 > rank 靠前 > 字数多 > 时间新 */
function leadScore(a) {
  let s = 0;
  if (a.content && String(a.content).length > 200) s += 1000;
  if (a.summary && String(a.summary).length > 60) s += 200;
  if (a.rank != null) s += Math.max(0, 200 - Number(a.rank));
  s += Math.min(300, Number(a.word_count) || 0);
  if (a.crawled_at) s += Math.min(100, Date.parse(a.crawled_at) / 1e10 || 0);
  return s;
}

/* ---------------- 垃圾过滤 ---------------- */

function plainLen(a) {
  const parts = [a.title || '', a.summary || '', a.content || ''];
  return Math.max(...parts.map(p => String(p).replace(/\s/g, '').length));
}

/**
 * @returns {{pass:boolean, reason:string}}
 */
export function judgeCluster(cluster, filter = {}) {
  const f = { ...DEFAULT_FILTER, ...filter };
  const a = cluster.lead;

  if (JUNK_TITLE.some(w => String(a.title || '').includes(w))) {
    return { pass: false, reason: '导航栏/推荐位残留' };
  }
  if (String(a.title || '').trim().length < f.minTitleLen) {
    return { pass: false, reason: '标题过短' };
  }
  if (f.dropClickbait) {
    const t = String(a.title || '');
    if (CLICKBAIT.some(w => t.includes(w))) return { pass: false, reason: '标题党' };
  }
  if (f.dropNoBody && (a.no_body || 0)) {
    return { pass: false, reason: '视频/音频站无文字正文' };
  }
  if (plainLen(a) < f.minBodyChars) {
    return { pass: false, reason: '正文/摘要内容过少' };
  }
  if (f.maxAgeHours > 0 && a.crawled_at) {
    const age = (Date.now() - Date.parse(a.crawled_at)) / 3600000;
    if (age > f.maxAgeHours) return { pass: false, reason: '超出时间窗口' };
  }
  return { pass: true, reason: '' };
}

/**
 * 完整预处理流程
 * @param {Array} rows articles 表的行
 * @param {object} filter
 * @returns {{total, clusters, kept, report}}
 *   kept[i] = { lead, members, sources:[{site,title,articleId}] , size }
 */
export function preprocess(rows, filter = {}) {
  const f = { ...DEFAULT_FILTER, ...filter };
  const clusters = clusterArticles(rows, f.similarity);

  const kept = [];
  const dropTally = new Map();
  let dupCount = 0;

  for (const c of clusters) {
    const v = judgeCluster(c, f);
    if (!v.pass) {
      dropTally.set(v.reason, (dropTally.get(v.reason) || 0) + c.members.length);
      continue;
    }
    dupCount += c.members.length - 1;
    kept.push({
      lead: c.lead,
      members: c.members,
      size: c.members.length,
      sources: c.members.map(m => ({
        articleId: m.id, site: m.site || '', title: m.title || '', url: m.url || ''
      }))
    });
  }

  // 排序：重复报道多的排前面（多家都报 = 大概率是真大事），再看热度和时间
  kept.sort((x, y) => {
    if (y.size !== x.size) return y.size - x.size;
    const rx = x.lead.rank ?? 999, ry = y.lead.rank ?? 999;
    if (rx !== ry) return rx - ry;
    return String(y.lead.crawled_at || '').localeCompare(String(x.lead.crawled_at || ''));
  });

  const report = {
    total: rows.length,
    clusterCount: clusters.length,
    deduped: dupCount,
    dropped: clusters.length - kept.length,
    kept: kept.length,
    dropReasons: [...dropTally.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
  };
  return { total: rows.length, clusters, kept, report };
}

/* ---------------- 喂给大模型的压缩文本 ---------------- */

/**
 * 列表页/详情页残留噪音。这些内容一旦念出来就是事故：
 * 「相关文章 A B C」会把七八个标题连成一串播出去。
 */
const BODY_NOISE = [
  /相关(?:文章|阅读|推荐|内容)[：:]?[\s\S]*$/g,
  /(?:上|下)一篇[：:][\s\S]*$/g,
  /责任编辑[：:][\s\S]*$/g,
  /查看全文[\s\S]*$/g,
  /点击(?:查看|阅读)更多?[\s\S]*$/g,
  /(?:发布|更新)历史[：:][\s\S]*$/g,
  /IT之家附[\s\S]*$/g,
  /(?:浏览量|阅读量|评论数|点赞)[：:]\s*\d+/g,
  /广告声明[：:][\s\S]*$/g,
  /本文(?:由|系)[^\n]{0,30}(?:授权)?(?:转载|发布)[\s\S]*$/g
];

/** 非中文、非英文的字符（谚文/假名/西里尔）：这类句子念出来是乱码，整句丢掉 */
const ALIEN_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3040-\u30FF\u0400-\u04FF]/;

export function hasAlienChars(s) {
  return ALIEN_RE.test(String(s || ''));
}

/** 去掉站点残留噪音，并压空白 */
export function stripBodyNoise(s) {
  let t = String(s || '');
  for (const re of BODY_NOISE) t = t.replace(re, ' ');
  return t.replace(/\s{2,}/g, ' ').trim();
}

/**
 * 按句子边界截断，而不是按字数硬切 ——
 * 硬切会把「512GB 的 PCIe 3.0 固」这种半句话喂给模型，最后原样念出来。
 */
export function clipSentences(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const hard = head.match(/^[\s\S]*[。！？；!?;]/);
  if (hard && hard[0].length >= Math.min(50, max * 0.4)) return hard[0];
  const soft = head.match(/^[\s\S]*[，,、]/);
  if (soft && soft[0].length >= Math.min(36, max * 0.3)) return soft[0];
  return head;
}

/** 句子与标题的相似度：用来识别「正文就是把标题又说了一遍」 */
export function titleSimilarity(sentence, title) {
  const a = normalizeTitle(sentence);
  const b = normalizeTitle(title);
  if (!a || !b) return 0;
  return dice(bigrams(a), bigrams(b));
}

/** 这句正文是不是在复述标题（复述就丢掉，否则等于标题念两遍） */
export function isEchoTitle(sentence, title, threshold = 0.66) {
  const a = normalizeTitle(sentence);
  const b = normalizeTitle(title);
  if (!a || !b) return false;
  const ga = bigrams(a);
  const gb = bigrams(b);
  const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
  let inter = 0;
  for (const g of small) if (big.has(g)) inter++;
  // 覆盖率判据：短的那个（通常是标题）几乎被长句整段包住了 ——
  // 纯 Dice 会被长句稀释，判不出来，这里必须用覆盖率。
  if (small.size && inter / small.size >= 0.8) return true;
  if (dice(ga, gb) >= threshold) return true;
  const bare = String(sentence || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const head = b.slice(0, 9);
  return !!head && bare.startsWith(head);
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/**
 * 把候选簇压成一机可读的紧凑清单。
 * 每条控制在 ~120 字以内，token 用量是这里的十倍级差异。
 * 写稿阶段可以调大 summaryLen / textLen 给足原文（否则模型只能靠标题瞎编）。
 */
export function renderCandidateList(items, opts = {}) {
  const summaryLen = opts.summaryLen || 120;
  const textLen = opts.textLen || 0;
  return items.map((it, i) => {
    const a = it.lead;
    const raw = a.content && textLen > 0 ? stripBodyNoise(a.content) : stripBodyNoise(a.summary);
    const lim = a.content && textLen > 0 ? textLen : summaryLen;
    const head = clipSentences(raw, lim);
    return [
      `#${i + 1}`,
      `来源${it.size > 1 ? it.size + '家' : ''}：${a.site || '未知'}`,
      `标题：${clip(a.title, 80)}`,
      `摘要：${head}`,
      a.hot_value ? `热度：${a.hot_value}` : ''
    ].filter(Boolean).join(' | ');
  }).join('\n');
}
