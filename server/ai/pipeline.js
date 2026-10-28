/**
 * AI 加工流水线
 *
 * 取候选 → 本地去重去垃圾 → 大模型粗筛打分 → 大模型写稿 → 落库成一期「节目」
 *
 * 产物的核心是 script.cues —— 一个 [{speaker, text, refs}] 数组，
 * 和前端 web/src/player/cues.js 造出来的结构一模一样，所以
 * 字幕滚动、句级进度、全屏字幕、MP3 导出全部直接复用，不用另写播放器。
 */
import { db } from '../db.js';
import { chatJSON } from './client.js';
import { pickProvider } from './registry.js';
import { getPrompt, render } from './prompts.js';
import { preprocess, renderCandidateList, DEFAULT_FILTER, stripBodyNoise, clipSentences, isEchoTitle, hasAlienChars } from './preprocess.js';

const SENT_END = '。！？!?；;…';
const SOFT_END = '，,、：:）)】」』"';

/** 服务端切句，规则与前端 cues.js 保持一致：一句 = 一段音频 */
function splitSentences(raw, max = 48, min = 9) {
  const text = String(raw || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const out = [];
  let buf = '';
  const flush = () => { const s = buf.trim(); if (s) out.push(s); buf = ''; };
  for (const ch of text) {
    buf += ch;
    if (SENT_END.includes(ch)) { flush(); continue; }
    if (SOFT_END.includes(ch) && buf.length >= max - 6) flush();
    if (buf.length >= max * 1.6) flush();
  }
  flush();
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && (last.length < min || s.length < min) && last.length + s.length <= max) {
      merged[merged.length - 1] = last + s;
    } else merged.push(s);
  }
  return merged.filter(Boolean);
}

/** 念出口会变正常的清洗：去 Markdown 符号、去括号动作描写、压空白 */
function cleanForSpeech(s) {
  return String(s || '')
    .replace(/[*_#`~|>]/g, ' ')
    .replace(/[（(]/g, '，').replace(/[）)]/g, '，')
    .replace(/[【】\[\]]/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ---------------- 正文兜底 ----------------
 * 大模型偶尔会把「标题」当成正文交回来（或干脆不给 script），
 * 那样一整期就只剩标题连着念，听起来全是节目单。这里用候选原文兜底，
 * 保证每条至少有一两句带事实的正文。 */

/** 站点导语噪音：念出来纯属浪费时间 */
const LEAD_NOISE = [
  /^IT之家[^，。]{0,14}(?:消息|获悉|注|附)[，,：:]?\s*/,
  /^据[^，。]{0,20}(?:报道|消息|悉)[，,]?\s*/,
  /^原标题[：:]\s*/,
  /^(?:快科技|新浪科技|网易科技|腾讯科技|澎湃新闻|界面新闻)\s*\d*\s*月?\s*\d*\s*日?[，,]?\s*/
];

function stripLeadNoise(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    let hit = false;
    for (const re of LEAD_NOISE) {
      const n = t.replace(re, '');
      if (n !== t) { t = n; hit = true; }
    }
    if (!hit) break;
  }
  return t.replace(/^[，,、。\s]+/, '').trim();
}

/** 把一段原文压成 2-3 句可念的正文（跳过噪音句与复述标题的句子） */
function bodyFromRaw(raw, title) {
  const text = stripLeadNoise(stripBodyNoise(String(raw || '').replace(/https?:\/\/\S+/g, ' ')));
  if (!text) return '';
  const parts = text.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length >= 3) break;
    if (hasAlienChars(p)) continue;          // 混了韩文/日文的句子，念出来是乱码
    if (isEchoTitle(p, title)) continue;     // 这句就是标题，跳过
    const clean = cleanForSpeech(p);
    if (clean.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length < 8) continue;
    out.push(clipSentences(clean, 96));
  }
  return out.join('');
}

/** 模型没给正文、或给的正文只是标题的复述时，回候选原文里捞 */
function fallbackBody(entry, pool, title) {
  const ids = Array.isArray(entry?.ids) ? entry.ids.map(Number).filter(Number.isFinite) : [];
  for (const i of ids) {
    const kept = pool[i - 1]?.item;
    if (!kept) continue;
    const a = kept.lead || {};
    const raw = (a.content && String(a.content).length > 140) ? a.content : (a.summary || '');
    const body = bodyFromRaw(raw, title);
    if (body) return body;
  }
  return '';
}

/** 判断模型给的正文是不是「不合格」：空、太短、或只是把标题换了标点重说一遍 */
function bodyTooThin(body, title) {
  const b = cleanForSpeech(body);
  const bare = b.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  if (bare.length < 22) return true;
  const t = String(title || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  if (t && bare.length < t.length + 16 && bare.includes(t.slice(0, Math.min(8, t.length)))) return true;
  return false;
}

/* ---------------- 候选范围 ---------------- */

function loadArticles(scope = {}) {
  const where = [];
  const params = {};
  if (scope.category) { where.push('category = @category'); params.category = scope.category; }
  if (scope.source) { where.push('source_id = @source'); params.source = Number(scope.source); }
  if (scope.site) { where.push('site = @site'); params.site = scope.site; }
  if (scope.unread) where.push('is_read = 0');
  if (scope.starred) where.push('is_starred = 1');
  if (scope.keyword) {
    where.push('(title LIKE @kw OR summary LIKE @kw OR content LIKE @kw)');
    params.kw = '%' + scope.keyword + '%';
  }
  if (Number(scope.hours) > 0) {
    where.push('crawled_at >= @since');
    params.since = new Date(Date.now() - Number(scope.hours) * 3600000).toISOString();
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(4000, Math.max(50, Number(scope.limit) || 1500));
  return db.prepare(
    `SELECT * FROM articles ${w} ORDER BY datetime(crawled_at) DESC, id DESC LIMIT ${limit}`
  ).all(params);
}

/* ---------------- 进度 ---------------- */

function updateRow(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE digests SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`)
    .run(...keys.map(k => patch[k]), id);
}

/* ---------------- 打分 ---------------- */

async function scoreBatch(p, items, minScore, tmpl) {
  const candidates = renderCandidateList(items, { summaryLen: 120 });
  const user = render(tmpl.user, { count: items.length, minScore, candidates });
  const r = await chatJSON(p, tmpl.system, user, { role: 'score', temperature: 0, maxTokens: 2048 });
  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  const byIndex = new Map();
  for (const x of results) {
    const i = Number(x.i);
    if (!Number.isFinite(i) || i < 1 || i > items.length) continue;
    byIndex.set(i, x);
  }
  return {
    scored: items.map((it, i) => {
      const hit = byIndex.get(i + 1);
      const score = Number(hit?.score);
      return {
        item: it,
        score: Number.isFinite(score) ? score : 5,
        reason: String(hit?.reason || ''),
        keep: hit ? hit.keep !== false : true
      };
    }),
    usage: r.usage
  };
}

/* ---------------- 主流程 ---------------- */

export const genState = { running: false, id: null };

export function startDigest(opts = {}) {
  if (genState.running) throw new Error('已有一期正在生成中，请等它跑完');
  const info = db.prepare(`
    INSERT INTO digests (kind, status, stage, stage_msg, progress, models, scope, created_at)
    VALUES (?, 'running', 'init', '正在开始', 0, ?, ?, ?)
  `).run(
    opts.kind || 'newsreel',
    JSON.stringify({ score: opts.scoreProviderId || null, write: opts.writeProviderId || null }),
    JSON.stringify({
      kind: opts.kind, category: opts.scope?.category || '', source: opts.scope?.source || '',
      site: opts.scope?.site || '', keyword: opts.scope?.keyword || '', hours: opts.scope?.hours || 0
    }),
    new Date().toISOString()
  );
  const id = info.lastInsertRowid;
  genState.running = true;
  genState.id = id;
  run(id, opts)
    .catch(e => {
      updateRow(id, {
        status: 'failed', stage: 'error', stage_msg: '生成失败', progress: 100,
        error: String(e.message || e).slice(0, 800)
      });
    })
    .finally(() => { genState.running = false; genState.id = null; });
  return { id };
}

async function run(id, opts) {
  const t0 = Date.now();
  const kind = opts.kind === 'dialogue' ? 'dialogue' : 'newsreel';
  const topN = Math.min(30, Math.max(5, Number(opts.topN) || 20));
  const minScore = opts.minScore === undefined ? 6 : Number(opts.minScore);

  /* ① 取候选
   * 时间窗太窄（或库里很久没爬）会直接筛空，报「没有可加工的信息」很挫败。
   * 策略：先看用户选的窗口；若候选不够，自动逐级放宽到 72h → 168h → 全部，
   * 并在进度里告诉用户实际用了哪个范围，而不是硬失败。 */
  updateRow(id, { stage: 'fetch', stage_msg: '正在读取候选信息', progress: 5 });
  const scopeBase = { ...(opts.scope || {}) };
  const wantHours = Number(scopeBase.hours) || 0;
  const windows = [wantHours, 72, 168, 0].filter((h, i, a) => h >= 0 && a.indexOf(h) === i);
  let rows = [];
  let usedHours = wantHours;
  for (const h of windows) {
    rows = loadArticles({ ...scopeBase, hours: h });
    if (rows.length >= 20 || h === 0) { usedHours = h; break; }
  }
  if (!rows.length) throw new Error('这个范围内没有可加工的信息，先爬一次或者放宽筛选条件');
  if (usedHours !== wantHours) {
    updateRow(id, {
      stage: 'fetch',
      stage_msg: `${wantHours > 0 ? '最近 ' + wantHours + ' 小时' : '所选范围'}内没有足够信息，已自动放宽到${usedHours === 0 ? '全部历史' : '最近 ' + usedHours + ' 小时'}`,
      scope: JSON.stringify({
        kind: opts.kind, category: scopeBase.category || '', source: scopeBase.source || '',
        site: scopeBase.site || '', keyword: scopeBase.keyword || '', hours: usedHours
      })
    });
  }

  /* ② 本地去重 + 去垃圾 */
  updateRow(id, { stage: 'filter', stage_msg: `正在对 ${rows.length} 条做去重与垃圾过滤`, progress: 15 });
  const filter = { ...DEFAULT_FILTER, ...(opts.filter || {}) };
  const { kept, report } = preprocess(rows, filter);
  if (!kept.length) {
    throw new Error(
      `过滤后没有留下任何条目（原始 ${rows.length} 条，成簇 ${report.clusterCount}）。` +
      '可以在生成面板里把「丢掉无文字正文的视频稿」关掉试试'
    );
  }
  const droppedLead = report.dropReasons.length
    ? '，其中 ' + report.dropReasons.map(r => `${r.reason} ${r.count}`).join('、')
    : '';
  updateRow(id, {
    stage: 'filter', progress: 25,
    stage_msg: `${rows.length} 条 → 合并成 ${report.clusterCount} 簇（去掉重复 ${report.deduped} 条）→ 剩 ${report.kept} 条${droppedLead}`,
    input_count: rows.length, cluster_count: report.clusterCount,
    drop_count: report.dropped, keep_count: report.kept
  });

  /* ③ 大模型粗筛打分 */
  let scored = kept.map(item => ({ item, score: 7, reason: '', keep: true }));
  let tokensIn = 0, tokensOut = 0;

  if (opts.noScore !== true) {
    const sp = pickProvider(opts.scoreProviderId || opts.writeProviderId);
    const tmpl = getPrompt('score')?.content || { system: '', user: '' };
    const BATCH = 20;
    const pool = kept.slice(0, Math.min(120, kept.length));
    const batches = [];
    for (let i = 0; i < pool.length; i += BATCH) batches.push(pool.slice(i, i + BATCH));

    const acc = [];
    const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 3));
    let cursor = 0;
    const workers = new Array(Math.min(concurrency, batches.length)).fill(0).map(async () => {
      while (cursor < batches.length) {
        const mine = cursor++;
        const batch = batches[mine];
        try {
          const r = await scoreBatch(sp, batch, minScore, tmpl);
          tokensIn += r.usage.prompt || 0;
          tokensOut += r.usage.completion || 0;
          acc.push({ ok: true, list: r.scored });
        } catch (e) {
          // 某一批打分失败不该让整期报废：按保留处理，交给写稿环节再筛一次
          acc.push({ ok: false, list: batch.map(item => ({ item, score: 6, reason: '打分失败', keep: true })) });
        }
        updateRow(id, {
          stage: 'score', progress: 25 + Math.round((acc.length / batches.length) * 40),
          stage_msg: `大模型打分 ${acc.length}/${batches.length} 批`
        });
      }
    });
    await Promise.all(workers);

    scored = acc.flatMap(a => a.list).filter(s => s.keep && s.score >= minScore);
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) {
      throw new Error(`大模型把 ${report.kept} 条全判为低质量了。把保留阈值从 ${minScore} 调低再试`);
    }
  }

  /* ④ 大模型写稿 */
  updateRow(id, { stage: 'write', stage_msg: '大模型正在写播报稿', progress: 70 });
  const wp = pickProvider(opts.writeProviderId || opts.scoreProviderId);
  // 写稿阶段不再吝啬素材：给足原文（有正文用正文，没正文用摘要），
  // 否则模型只能靠标题瞎编，最后念出来全是标题。
  const pool = scored.slice(0, Math.min(40, scored.length));
  const poolItems = pool.map(s => s.item);
  const writeOpts = { summaryLen: 300, textLen: 700 };
  const focus = String(opts.focus || '').trim() || '没有额外偏好，请按通用新闻价值判断。';

  let script;
  if (kind === 'dialogue') {
    const tmpl = getPrompt('dialogue')?.content || { system: '', user: '' };
    const hostName = String(opts.hostName || '主播').trim() || '主播';
    const guestName = String(opts.guestName || '评论员').trim() || '评论员';
    const topicCount = Math.min(topN, Math.max(3, Math.round(topN / 2)));
    const r = await chatJSON(wp, tmpl.system, render(tmpl.user, {
      candidates: renderCandidateList(poolItems, writeOpts),
      count: pool.length, focus, topN, topicCount, turnCount: topN * 4, hostName, guestName
    }), { role: 'dialogue', maxTokens: Number(opts.maxTokens) || 4096 });
    tokensIn += r.usage.prompt || 0;
    tokensOut += r.usage.completion || 0;
    script = buildDialogueScript(r.data, { pool, hostName, guestName });
  } else {
    const tmpl = getPrompt('newsreel')?.content || { system: '', user: '' };
    const r = await chatJSON(wp, tmpl.system, render(tmpl.user, {
      candidates: renderCandidateList(poolItems, writeOpts),
      count: pool.length, focus, topN
    }), { role: 'newsreel', maxTokens: Number(opts.maxTokens) || 4096 });
    tokensIn += r.usage.prompt || 0;
    tokensOut += r.usage.completion || 0;
    script = buildNewsreelScript(r.data, { pool, topN });
  }

  if (!script.cues.length) throw new Error('大模型返回了空的播报稿，换个模型或调整提示词再试');

  updateRow(id, {
    kind, status: 'done', stage: 'done', stage_msg: '生成完成', progress: 100,
    title: script.title || defaultTitle(kind),
    subtitle: script.subtitle || '',
    script: JSON.stringify(script),
    item_count: (script.items || []).length,
    cue_count: script.cues.length,
    tokens_in: tokensIn, tokens_out: tokensOut,
    duration_ms: Date.now() - t0
  });
  return id;
}

function defaultTitle(kind) {
  const d = new Date();
  const hh = d.getHours();
  const slot = hh < 6 ? '凌晨' : hh < 11 ? '早间' : hh < 14 ? '午间' : hh < 18 ? '下午' : '晚间';
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${stamp} ${slot}${kind === 'dialogue' ? '对话' : '精选'}`;
}

/* ---------------- 组装 script ---------------- */

/** 把大模型给的候选序号换算回真实信源列表（展示「多家媒体报道」用） */
function refsOf(entry, pool) {
  const ids = Array.isArray(entry.ids) ? entry.ids.map(Number).filter(Number.isFinite) : [];
  const picked = ids.map(i => pool[i - 1]).filter(Boolean);
  const out = [];
  for (const p of picked) {
    for (const a of p.item.sources) {
      out.push({ articleId: a.articleId, site: a.site, title: a.title, url: a.url });
    }
  }
  return out.slice(0, 12);
}

function buildNewsreelScript(data, ctx) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const cues = [];
  const push = (text, opts = {}) => {
    const t = cleanForSpeech(text);
    if (!t) return;
    for (const sentence of splitSentences(t)) {
      cues.push({
        speaker: 'narrator', speakerLabel: '播报',
        kind: opts.kind || 'body',
        text: sentence,
        refs: opts.refs || [],
        itemIndex: opts.itemIndex === undefined ? null : opts.itemIndex
      });
    }
  };

  push(data?.lead || `欢迎收听本期精选，今天有 ${items.length} 件事值得知道。`, { kind: 'lead' });
  let thinCount = 0;
  items.slice(0, ctx.topN).forEach((it, idx) => {
    const title = String(it.title || '').trim();
    const script = String(it.script || '').trim();
    if (title) push(title, { kind: 'item-title', itemIndex: idx, refs: refsOf(it, ctx.pool) });
    let body = script;
    if (bodyTooThin(body, title)) {
      const fb = fallbackBody(it, ctx.pool, title) || String(it.summary || '');
      if (fb) { body = fb; thinCount++; }
    }
    push(body, { kind: 'body', itemIndex: idx });
  });
  push(data?.outro || '以上就是本期全部内容，我们下期再见。', { kind: 'outro' });

  return {
    kind: 'newsreel',
    title: cleanForSpeech(data?.title || defaultTitle('newsreel')),
    subtitle: `${items.length} 条精选 · 由大模型融合改写` + (thinCount ? `（其中 ${thinCount} 条正文取自原文）` : ''),
    leadName: '播报',
    items: items.slice(0, ctx.topN).map((it, idx) => ({
      index: idx,
      title: cleanForSpeech(it.title || ''),
      summary: cleanForSpeech(it.summary || ''),
      category: String(it.category || '').trim(),
      importance: Number(it.importance) || 0,
      sources: refsOf(it, ctx.pool)
    })),
    cues
  };
}

function buildDialogueScript(data, ctx) {
  const turns = Array.isArray(data?.turns) ? data.turns : [];
  const hostName = String(data?.host_name || ctx.hostName || '主播');
  const guestName = String(data?.guest_name || ctx.guestName || '评论员');
  const cues = [];
  const push = (speaker, label, text, kind) => {
    const t = cleanForSpeech(text);
    if (!t) return;
    for (const sentence of splitSentences(t)) {
      cues.push({ speaker, speakerLabel: label, kind, text: sentence, refs: [] });
    }
  };

  push('host', hostName, data?.lead || `大家好，欢迎收听今天的对谈节目，我是${hostName}。`, 'lead');
  for (const t of turns) {
    const guest = String(t.speaker || '').toLowerCase() === 'guest';
    push(guest ? 'guest' : 'host', guest ? guestName : hostName, t.text || '', 'body');
  }
  push('host', hostName, data?.outro || '今天就聊到这里，我们下期再会。', 'outro');

  const topics = [];
  for (const t of turns) {
    const s = String(t.text || '').replace(/\s/g, '');
    if (s.length >= 14 && topics.length < 12) topics.push(cleanForSpeech(t.text).slice(0, 44));
  }

  return {
    kind: 'dialogue',
    title: cleanForSpeech(data?.title || defaultTitle('dialogue')),
    subtitle: `${hostName} × ${guestName} · ${turns.length} 轮对话`,
    hostName, guestName,
    items: topics.map((t, i) => ({ index: i, title: t, summary: '', sources: [] })),
    cues
  };
}

/* ---------------- 查询 ---------------- */

/** 粗估时长：和前端 cues.js 的 CHARS_PER_SEC 保持一致的口径 */
export function estimateDurationFrom(script) {
  const cues = script?.cues || [];
  return Math.round(cues.reduce((s, c) => s + String(c.text || '').length / 3.8 + 0.4, 0));
}

export function listDigests(limit = 50) {
  return db.prepare(`
    SELECT id, kind, title, subtitle, status, stage, stage_msg, progress,
           input_count, cluster_count, drop_count, keep_count, item_count,
           cue_count, models, duration_ms, tokens_in, tokens_out, error, created_at
    FROM digests ORDER BY id DESC LIMIT ?
  `).all(Number(limit) || 50);
}

export function getDigest(id) {
  return db.prepare('SELECT * FROM digests WHERE id=?').get(Number(id)) || null;
}

export function getDigestPublic(id) {
  const row = getDigest(id);
  if (!row) return null;
  let script = null;
  try { script = JSON.parse(row.script); } catch { script = null; }
  return { ...row, script, duration_est: script ? estimateDurationFrom(script) : 0 };
}

export function deleteDigest(id) {
  db.prepare('DELETE FROM digests WHERE id=?').run(Number(id));
  return { id: Number(id) };
}

export function digestProgress(id) {
  const row = getDigest(id);
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, status: row.status, stage: row.stage,
    stage_msg: row.stage_msg, progress: row.progress, title: row.title,
    subtitle: row.subtitle, error: row.error,
    input_count: row.input_count, cluster_count: row.cluster_count,
    drop_count: row.drop_count, keep_count: row.keep_count,
    item_count: row.item_count, cue_count: row.cue_count,
    duration_ms: row.duration_ms, tokens_in: row.tokens_in, tokens_out: row.tokens_out
  };
}
