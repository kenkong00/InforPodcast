import crypto from 'crypto';
import { db } from '../db.js';
import { fetchWithRetry } from './fetcher.js';
import {
  parseRSS, parseJSONGeneric, parseHTMLGeneric,
  BUILTIN_PARSERS, extractArticle, clip, stripHtml
} from './parsers.js';
import { isMediaUrl, MEDIA_TIP } from '../media.js';

export function md5(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

export const crawlState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  newTotal: 0,
  current: '',
  results: [],
  scope: '全部',
  message: ''
};

const insertArticle = db.prepare(`
  INSERT INTO articles (source_id, source_name, site, category, title, url, hash, summary, content, author, rank, hot_value, published_at, crawled_at, word_count, no_body)
  VALUES (@source_id, @source_name, @site, @category, @title, @url, @hash, @summary, @content, @author, @rank, @hot_value, @published_at, @crawled_at, @word_count, @no_body)
`);

const updateArticle = db.prepare(`
  UPDATE articles SET rank=@rank, hot_value=@hot_value, crawled_at=@crawled_at,
    summary = CASE WHEN @summary <> '' THEN @summary ELSE summary END,
    published_at = COALESCE(@published_at, published_at)
  WHERE hash=@hash
`);

const findArticle = db.prepare('SELECT id FROM articles WHERE hash = ?');

const insertLog = db.prepare(`
  INSERT INTO crawl_logs (source_id, source_name, started_at, status) VALUES (?,?,?,'running')
`);
const finishLog = db.prepare(`
  UPDATE crawl_logs SET finished_at=?, status=?, new_count=?, total_count=?, duration_ms=?, message=? WHERE id=?
`);

const upsertPage = db.prepare(`
  INSERT INTO pages (url, url_hash, title, site, category, content, word_count, crawled_at)
  VALUES (@url, @url_hash, @title, @site, @category, @content, @word_count, @crawled_at)
  ON CONFLICT(url_hash) DO UPDATE SET title=@title, content=@content, word_count=@word_count, crawled_at=@crawled_at
`);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 根据源类型解析抓取到的原始文本 */
function parseBySource(source, raw, contentType, finalUrl) {
  const cfg = safeJSON(source.config);
  if (source.parser && BUILTIN_PARSERS[source.parser]) {
    return BUILTIN_PARSERS[source.parser](raw);
  }
  const type = source.type || 'auto';
  const looksXML = /^\s*<(\?xml|rss|feed|rdf)/i.test(raw) || /<(item|entry)[\s>]/.test(raw);

  if (type === 'rss' || (type === 'auto' && looksXML)) {
    const items = parseRSS(raw);
    if (items.length) return items;
    if (type === 'rss') throw new Error('RSS 解析出 0 条（源可能已改版）');
  }
  if (type === 'json' || type === 'auto') {
    try {
      const items = parseJSONGeneric(raw, cfg);
      if (items.length) return items;
      if (type === 'json') throw new Error('JSON 解析出 0 条');
    } catch (e) {
      if (type === 'json') throw e;
    }
  }
  if (type === 'html' || type === 'auto') {
    const items = parseHTMLGeneric(raw, cfg, finalUrl || source.url);
    if (items.length) return items;
    throw new Error('未能解析出条目（请检查类型或配置选择器）');
  }
  throw new Error('不支持的源类型: ' + type);
}

function safeJSON(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function saveItem(source, it) {
  const url = (it.url || '').trim();
  const title = clip(it.title || '', 300);
  if (!title) return false;
  const hash = md5((source.id || 0) + '|' + (url || title));
  const summary = clip(it.summary || '', 600);
  const params = {
    source_id: source.id,
    source_name: source.name,
    site: source.site || hostOf(source.url),
    category: source.category || '综合',
    title,
    url,
    hash,
    summary,
    content: '',
    author: clip(it.author || '', 60),
    rank: it.rank ?? null,
    hot_value: String(it.hot ?? ''),
    published_at: it.published_at || null,
    crawled_at: new Date().toISOString(),
    word_count: (title + summary).length,
    no_body: (source.no_body || isMediaUrl(url)) ? 1 : 0
  };
  const exist = findArticle.get(hash);
  if (exist) {
    updateArticle.run(params);
    return false;
  }
  insertArticle.run(params);
  return true;
}

export async function crawlSource(source, opts = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const logId = insertLog.run(source.id, source.name, startedAt).lastInsertRowid;
  try {
    const { text, finalUrl, contentType } = await fetchWithRetry(source.url, {
      timeout: opts.timeout || 15000,
      headers: safeJSON(source.config).headers || {}
    });
    const items = parseBySource(source, text, contentType, finalUrl);
    const limited = items.slice(0, source.limit_count || 50);
    let newCount = 0;
    for (const it of limited) {
      if (saveItem(source, it)) newCount++;
    }
    const msg = `抓取 ${limited.length} 条，新增 ${newCount} 条`;
    finishLog.run(new Date().toISOString(), 'ok', newCount, limited.length, Date.now() - t0, msg, logId);
    db.prepare(`UPDATE sources SET last_crawled_at=?, last_status='ok', last_message=?, total_items=total_items+?, fail_count=0 WHERE id=?`)
      .run(new Date().toISOString(), msg, newCount, source.id);
    return { ok: true, sourceId: source.id, name: source.name, total: limited.length, newCount, message: msg };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    finishLog.run(new Date().toISOString(), 'fail', 0, 0, Date.now() - t0, msg, logId);
    db.prepare(`UPDATE sources SET last_crawled_at=?, last_status='fail', last_message=?, fail_count=fail_count+1 WHERE id=?`)
      .run(new Date().toISOString(), msg, source.id);
    return { ok: false, sourceId: source.id, name: source.name, total: 0, newCount: 0, message: msg };
  }
}

async function pool(tasks, limit) {
  const res = [];
  let idx = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (idx < tasks.length) {
      const i = idx++;
      res[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return res;
}

/**
 * 一键爬取
 * opts 为空            -> 爬取全部启用的源
 * opts.category='科技'  -> 只爬该分类下的源
 * opts.site='哔哩哔哩'  -> 只爬该站点的源
 * opts.sourceId=5      -> 只爬指定源（不受启用状态限制）
 */
export async function crawlAll(opts = {}) {
  if (crawlState.running) {
    return { started: false, message: '已有爬取任务在运行中' };
  }
  let sql = 'SELECT * FROM sources WHERE 1=1';
  const params = [];
  if (opts.sourceId) {
    sql += ' AND id = ?';
    params.push(Number(opts.sourceId));
  } else {
    sql += ' AND enabled = 1';
    if (opts.category) { sql += ' AND category = ?'; params.push(String(opts.category)); }
    if (opts.site) { sql += ' AND site = ?'; params.push(String(opts.site)); }
  }
  sql += ' ORDER BY category, id';
  const sources = db.prepare(sql).all(...params);
  if (!sources.length) {
    return { started: false, message: '当前范围没有可爬取的数据源' };
  }
  const scopeLabel = opts.sourceId
    ? sources[0].name
    : (opts.category || opts.site || '全部');
  crawlState.scope = scopeLabel;
  crawlState.running = true;
  crawlState.startedAt = new Date().toISOString();
  crawlState.finishedAt = null;
  crawlState.total = sources.length;
  crawlState.done = 0;
  crawlState.newTotal = 0;
  crawlState.current = '';
  crawlState.results = [];
  crawlState.message = '';

  const tasks = sources.map(s => async () => {
    crawlState.current = s.name;
    const r = await crawlSource(s, opts);
    crawlState.done++;
    crawlState.newTotal += r.newCount || 0;
    crawlState.results.push(r);
    return r;
  });

  pool(tasks, opts.concurrency || 5).then(() => {
    crawlState.running = false;
    crawlState.finishedAt = new Date().toISOString();
    crawlState.current = '';
    crawlState.message = `【${crawlState.scope}】完成 ${crawlState.done}/${crawlState.total} 个源，新增 ${crawlState.newTotal} 条`;
  }).catch(e => {
    crawlState.running = false;
    crawlState.finishedAt = new Date().toISOString();
    crawlState.message = '爬取异常: ' + e.message;
  });

  return { started: true, total: sources.length };
}

/** 抓取某条信息的正文，存回 articles.content（供站内阅读与语音播报） */
export async function fetchArticleContent(articleId) {
  const a = db.prepare('SELECT * FROM articles WHERE id=?').get(articleId);
  if (!a) throw new Error('条目不存在');
  if (!a.url) throw new Error('该条目没有可抓取的网址');
  // 视频/音频站点：不浪费一次网络请求，直接告诉前端"没有正文"
  if (a.no_body || isMediaUrl(a.url)) {
    if (!a.no_body) db.prepare('UPDATE articles SET no_body=1 WHERE id=?').run(articleId);
    throw new Error(MEDIA_TIP);
  }
  const { text, finalUrl } = await fetchWithRetry(a.url, { timeout: 20000 });
  const { content } = extractArticle(text, finalUrl);
  const pure = (content || '').replace(/\s/g, '');
  if (pure.length < 30) {
    // 跳到视频站点的（如短链 b23.tv → bilibili.com）也标记为无正文
    if (isMediaUrl(finalUrl)) db.prepare('UPDATE articles SET no_body=1 WHERE id=?').run(articleId);
    throw new Error('未能提取到正文（可能是 JS 渲染页或需要登录）');
  }
  db.prepare('UPDATE articles SET content=?, word_count=? WHERE id=?').run(content, pure.length, articleId);
  return db.prepare('SELECT id, title, content, word_count FROM articles WHERE id=?').get(articleId);
}

/** 批量抓取正文 */
export async function fetchContentBatch(ids = [], concurrency = 3) {
  const results = [];
  let idx = 0;
  const workers = new Array(Math.min(concurrency, ids.length)).fill(0).map(async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      try {
        const r = await fetchArticleContent(id);
        results.push({ id, ok: true, word_count: r.word_count });
      } catch (e) {
        results.push({ id, ok: false, message: e.message });
      }
    }
  });
  await Promise.all(workers);
  return {
    total: ids.length,
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
    results
  };
}

/** 单 URL 抓取：输入网址，扒取纯文字信息 */
export async function fetchOneUrl(url, category = '网页抓取') {
  if (!/^https?:\/\//i.test(url)) throw new Error('请输入以 http:// 或 https:// 开头的完整网址');
  const { text, finalUrl } = await fetchWithRetry(url, { timeout: 20000 });
  const { title, content } = extractArticle(text, finalUrl);
  if (!content || content.replace(/\s/g, '').length < 30) {
    throw new Error('未能提取到有效文字内容（可能是 JS 渲染页面或需要登录）');
  }
  const site = hostOf(finalUrl);
  const crawled_at = new Date().toISOString();
  const url_hash = md5('page:' + finalUrl);
  const word_count = content.replace(/\s/g, '').length;
  upsertPage.run({ url: finalUrl, url_hash, title, site, category, content, word_count, crawled_at });
  const page = db.prepare('SELECT * FROM pages WHERE url_hash=?').get(url_hash);

  // 同时进入信息流，便于检索与分类
  const hash = md5('page:' + finalUrl);
  const params = {
    source_id: null,
    source_name: '手动抓取',
    site,
    category,
    title: title || finalUrl,
    url: finalUrl,
    hash,
    summary: clip(content, 600),
    content,
    author: '',
    rank: null,
    hot_value: '',
    published_at: null,
    crawled_at,
    word_count
  };
  if (!findArticle.get(hash)) insertArticle.run(params);
  else {
    db.prepare('UPDATE articles SET content=@content, summary=@summary, word_count=@word_count, crawled_at=@crawled_at, category=@category WHERE hash=@hash').run(params);
  }
  return page;
}
