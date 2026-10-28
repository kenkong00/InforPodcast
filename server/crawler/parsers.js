import * as cheerio from 'cheerio';

/* ============ 通用工具 ============ */

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s = '') {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = /^[xX]/.test(code.slice(1)) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? m;
  });
}

/** HTML -> 纯文本（只保留文字信息） */
export function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clip(text = '', max = 300) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function toISO(str) {
  if (!str) return null;
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

function getPath(obj, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    const arrMatch = key.match(/^([^[]+)(\[\d+\])?$/);
    if (!arrMatch) return undefined;
    let v = acc[arrMatch[1]];
    if (arrMatch[2] && Array.isArray(v)) v = v[Number(arrMatch[2].slice(1, -1))];
    return v;
  }, obj);
}

function absUrl(href, base) {
  if (!href) return '';
  href = String(href).trim();
  if (/^(https?:)?\/\//i.test(href)) {
    return href.startsWith('//') ? 'https:' + href : href;
  }
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/* ============ RSS / Atom ============ */

function pickTag(block, tags) {
  for (const t of tags) {
    const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i');
    const m = block.match(re);
    if (m) {
      let v = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
      return decodeEntities(v);
    }
  }
  return '';
}

function pickLink(block) {
  const hrefs = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  let fallback = '';
  for (const m of hrefs) {
    const attrs = m[1] || '';
    const href = (attrs.match(/href=["']([^"']+)["']/) || [])[1] || '';
    const rel = (attrs.match(/rel=["']([^"']+)["']/) || [])[1] || '';
    if (rel === 'alternate' || (!rel && !/type=["']application\/rss/.test(attrs))) {
      if (rel === 'alternate') return href;
      if (!fallback) fallback = href;
    }
  }
  if (fallback) return fallback;
  return pickTag(block, ['link']);
}

export function parseRSS(xml = '') {
  const items = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  for (const b of blocks) {
    const title = stripHtml(pickTag(b, ['title']));
    const link = pickLink(b);
    const rawSummary = pickTag(b, ['description', 'summary', 'content:encoded', 'content', 'subtitle']);
    const summary = stripHtml(rawSummary);
    const author = stripHtml(pickTag(b, ['dc:creator', 'author', 'name']));
    const pub = pickTag(b, ['pubDate', 'published', 'updated', 'dc:date', 'pubdate']);
    if (!title) continue;
    items.push({
      title: clip(title, 200),
      url: link,
      summary: clip(summary, 400),
      author: clip(author, 40),
      published_at: toISO(pub),
      rank: null,
      hot: ''
    });
  }
  return items;
}

/* ============ 通用 JSON / HTML ============ */

/** 剥离 JSONP 外壳：data_callback([...]) -> [...] */
function unwrapJSONP(text) {
  const t = text.trim();
  const m = t.match(/^[A-Za-z_$][\w$]*\s*\((\[[\s\S]*\]|\{[\s\S]*\})\)\s*;?$/);
  return m ? m[1] : t;
}

export function parseJSONGeneric(raw, cfg = {}) {
  const j = JSON.parse(unwrapJSONP(raw));
  let list;
  if (cfg.listPath) list = getPath(j, cfg.listPath);
  else list = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
  if (!Array.isArray(list)) throw new Error('JSON 列表路径未命中: ' + (cfg.listPath || '(根数组)'));
  return list.map((it, i) => {
    const title = cfg.title ? getPath(it, cfg.title) : (it.title || it.name || it.word || it.query || '');
    const url = cfg.url ? getPath(it, cfg.url) : (it.url || it.link || '');
    const summary = cfg.summary ? getPath(it, cfg.summary) : (it.desc || it.summary || it.description || it.content || '');
    const hot = cfg.hot ? getPath(it, cfg.hot) : (it.hot || it.hot_value || it.view || '');
    const author = cfg.author ? getPath(it, cfg.author) : (it.author || it.username || '');
    const pub = cfg.published ? getPath(it, cfg.published) : (it.published_at || it.created_at || it.pubDate || '');
    return {
      title: clip(stripHtml(title), 200),
      url: (cfg.urlPrefix || '') + (url || ''),
      summary: clip(stripHtml(summary), 400),
      author: clip(String(author || ''), 40),
      published_at: toISO(pub),
      rank: i + 1,
      hot: hot == null ? '' : String(hot)
    };
  }).filter(x => x.title);
}

export function parseHTMLGeneric(html, cfg = {}, baseUrl = '') {
  const $ = cheerio.load(html);
  const items = [];
  const itemSel = cfg.itemSelector || 'a';
  $(itemSel).each((i, el) => {
    const $el = $(el);
    let title = '', url = '', summary = '';
    if (cfg.titleSelector) title = $el.find(cfg.titleSelector).first().text();
    else title = $el.attr('title') || $el.text();
    const linkEl = cfg.linkSelector ? $el.find(cfg.linkSelector).first() : $el;
    url = linkEl.attr(cfg.linkAttr || 'href') || '';
    if (cfg.summarySelector) summary = $el.find(cfg.summarySelector).first().text();
    title = stripHtml(title);
    if (!title || title.length < 2) return;
    items.push({
      title: clip(title, 200),
      url: absUrl((cfg.linkPrefix || '') + url, baseUrl || cfg.baseUrl || ''),
      summary: clip(stripHtml(summary), 400),
      author: '',
      published_at: null,
      rank: items.length + 1,
      hot: ''
    });
  });
  return items;
}

/* ============ 内置站点解析器 ============ */

function j(raw) { return JSON.parse(raw); }

export const BUILTIN_PARSERS = {
  /** 微博热搜 */
  weibo(raw) {
    const data = j(raw)?.data || {};
    const list = data.realtime || data.list || data.hotgov?.list || [];
    return list.map((it, i) => ({
      title: it.word || it.note || it.title || '',
      url: it.rawUrl || ('https://s.weibo.com/weibo?q=' + encodeURIComponent(it.word || '') + '&t=31&band_rank=' + (i + 1)),
      summary: [it.note, it.label_name ? '#' + it.label_name : '', it.category ? '分类:' + it.category : ''].filter(Boolean).join(' · '),
      rank: it.realpos ?? (i + 1),
      hot: it.num != null ? String(it.num) : (it.raw_hot != null ? String(it.raw_hot) : ''),
      published_at: null,
      author: ''
    })).filter(x => x.title);
  },

  /** 百度热搜（接口为多层嵌套结构，递归展开） */
  baidu(raw) {
    const d = j(raw);
    const cards = d?.data?.cards || [];
    const out = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.content)) { node.content.forEach(visit); return; }
      const word = node.word || node.query || node.show;
      if (!word) return;
      out.push({
        title: word,
        url: node.url || node.rawUrl || node.link || ('https://www.baidu.com/s?wd=' + encodeURIComponent(word)),
        summary: node.desc || node.show_desc || '',
        rank: out.length + 1,
        hot: node.hotScore != null ? String(node.hotScore) : (node.hot_score != null ? String(node.hot_score) : (node.hotTags || '')),
        published_at: null,
        author: ''
      });
    };
    for (const card of cards) (card.content || []).forEach(visit);
    if (!out.length) (d?.data?.list || []).forEach(visit);
    return out.filter(x => x.title);
  },

  /** 今日头条热榜 */
  toutiao(raw) {
    const list = j(raw)?.data || [];
    return list.map((it, i) => ({
      title: it.Title || it.title || '',
      url: it.Url || it.url || ('https://www.toutiao.com/trending/' + (it.ClusterId || '')),
      summary: it.Label || it.label || '',
      rank: it.SerialNo ?? (i + 1),
      hot: it.HotValue != null ? String(it.HotValue) : (it.hot != null ? String(it.hot) : ''),
      published_at: null,
      author: ''
    })).filter(x => x.title);
  },

  /** B站热门视频 */
  bilibili(raw) {
    const list = j(raw)?.data?.list || [];
    return list.map((it, i) => ({
      title: it.title || '',
      url: it.short_link_v2 || (it.bvid ? 'https://www.bilibili.com/video/' + it.bvid : ''),
      summary: [it.owner?.name ? 'UP:' + it.owner.name : '', it.stat?.view != null ? '播放 ' + it.stat.view : '', it.desc ? clip(it.desc, 80) : ''].filter(Boolean).join(' · '),
      rank: i + 1,
      hot: it.stat?.view != null ? String(it.stat.view) : '',
      published_at: null,
      author: it.owner?.name || ''
    })).filter(x => x.title);
  },

  /** V2EX 热门主题 */
  v2ex(raw) {
    const list = j(raw);
    return (Array.isArray(list) ? list : []).map((it, i) => ({
      title: it.title || '',
      url: it.url || '',
      summary: clip(it.content || '', 300) + (it.replies != null ? ' （' + it.replies + ' 回复）' : ''),
      rank: i + 1,
      hot: it.replies != null ? String(it.replies) : '',
      published_at: it.created ? new Date(it.created * 1000).toISOString() : null,
      author: it.member?.username || ''
    })).filter(x => x.title);
  },

  /** 知乎热搜 */
  zhihu(raw) {
    const words = j(raw)?.top_search?.words || j(raw)?.data || [];
    return words.map((w, i) => ({
      title: w.display_query || w.query || '',
      url: 'https://www.zhihu.com/search?type=content&q=' + encodeURIComponent(w.query || w.display_query || ''),
      summary: w.query || '',
      rank: i + 1,
      hot: w.hot != null ? String(w.hot) : '',
      published_at: null,
      author: ''
    })).filter(x => x.title);
  },

  /** 掘金热榜 */
  juejin(raw) {
    const list = j(raw)?.data || [];
    return list.map((it, i) => {
      const c = it.content || it.article || it;
      return {
        title: c.title || it.title || '',
        url: 'https://juejin.cn/post/' + (c.article_id || c.content_id || c.id || ''),
        summary: clip(c.brief_content || c.summary || c.content || '', 300),
        rank: i + 1,
        hot: (c.view_count ?? c.hot_score ?? '') + '',
        published_at: null,
        author: it.author?.name || c.author?.name || ''
      };
    }).filter(x => x.title);
  },

  /** GitHub Trending */
  github(raw) {
    const $ = cheerio.load(raw);
    const out = [];
    $('article.Box-row').each((i, el) => {
      const $el = $(el);
      const title = stripHtml($el.find('h2').text()).replace(/\s+/g, ' ').trim();
      const href = $el.find('h2 a').attr('href') || '';
      const desc = clip(stripHtml($el.find('p').text()), 200);
      const stars = stripHtml($el.find('.d-inline-block.float-sm-right').text() || $el.find('span.d-inline-block.float-sm-right').text());
      out.push({
        title,
        url: 'https://github.com' + href,
        summary: [desc, stars ? '⭐ ' + stars : ''].filter(Boolean).join(' · '),
        rank: out.length + 1,
        hot: '',
        published_at: null,
        author: ''
      });
    });
    return out.filter(x => x.title);
  },

  /** vvhan 热榜聚合（通用兜底，返回 {data:[{title, url, desc, hot}]}） */
  vvhan(raw) {
    const d = j(raw);
    const list = d?.data || [];
    return list.map((it, i) => ({
      title: it.title || '',
      url: it.url || it.mobil_url || it.link || '',
      summary: clip(it.desc || it.desc_info || '', 300),
      rank: i + 1,
      hot: (it.hot ?? it.hot_value ?? '') + '',
      published_at: null,
      author: ''
    })).filter(x => x.title);
  }
};

/* ============ 正文抽取（单 URL 抓取用） ============ */

const MAIN_SELECTORS = [
  'article', 'main', '[role="main"]', '#content', '.content', '.article-content',
  '.post-content', '.entry-content', '.rich_media_content', '.article-body', '.detail-content'
];

export function extractArticle(html, baseUrl = '') {
  const $ = cheerio.load(html);
  $('script,style,noscript,iframe,svg,video,audio,img,figure,form,aside,nav,header,footer').remove();
  const title = stripHtml(
    ($('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('h1').first().text() ||
      $('title').text() || '')
  );
  let main = null;
  for (const sel of MAIN_SELECTORS) {
    const el = $(sel).first();
    if (el.length && stripHtml(el.html() || '').length > 200) { main = el; break; }
  }
  if (!main) {
    let best = null, bestScore = 0;
    $('div').each((i, el) => {
      const $el = $(el);
      const pCount = $el.children('p').length + $el.find('p').length * 0.2;
      const score = stripHtml($el.html() || '').length + pCount * 100;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    main = best ? $(best) : $('body');
  }
  const lines = [];
  main.find('h1,h2,h3,h4,p,li,blockquote').each((i, el) => {
    const t = stripHtml($(el).html() || '');
    if (t.length >= 2) lines.push(t);
  });
  let content = lines.join('\n');
  if (content.replace(/\s/g, '').length < 120) {
    content = stripHtml(main.html() || $('body').html() || '');
  }
  content = content.split('\n').map(s => s.trim()).filter(Boolean).join('\n');
  return { title: clip(title, 200), content };
}
