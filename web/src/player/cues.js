/**
 * 把一篇新闻切成「歌词」
 *
 * 每一句 = 一个 cue = 一段独立合成的音频。
 * 之所以按句切：语音引擎只能整段合成，合成完没法告诉你"现在念到第几个字"，
 * 但只要一句一段、依次播放，「现在播到第几句」就是精确的 —— 这就是字幕同步的地基。
 */

const SENT_END = '。！？!?；;…';
const SOFT_END = '，,、：:）)】」』"';

/** 洗掉不适合念出来的东西 */
export function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

/**
 * 切句
 * @param {string} raw
 * @param {{max?:number, min?:number}} opts max 单句上限（字），min 低于此长度与邻句合并
 */
export function splitCues(raw, opts = {}) {
  const max = opts.max || 48;
  const min = opts.min || 9;
  const text = cleanText(raw);
  if (!text) return [];

  const out = [];
  for (const para of text.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    let buf = '';
    const flush = () => {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
    };
    for (const ch of p) {
      buf += ch;
      if (SENT_END.includes(ch)) { flush(); continue; }
      // 句子太长就在逗号处断，避免一句念十几秒
      if (SOFT_END.includes(ch) && buf.length >= max - 6) flush();
      if (buf.length >= max * 1.6) flush();
    }
    flush();
  }

  // 合并过短碎片（避免"据报道。"这种两三个字单独占一行）
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && (last.length < min || s.length < min) && last.length + s.length <= max) {
      merged[merged.length - 1] = last + s;
    } else {
      merged.push(s);
    }
  }
  return merged.filter(Boolean);
}

/**
 * 语速估算。实测本机 16kHz 引擎：27 字 ≈ 7.15s、11 字 ≈ 3.7s、3 字 ≈ 1.4s，
 * 也就是每个句子有一段固定的起停开销，再按字数线性增长。
 * 估算值只用于「还没合成时先把总时长画出来」，真正播放到那一句会被实测值替换。
 */
export const CHARS_PER_SEC = 3.8;
export const CUE_OVERHEAD = 0.4;

export function estimateDuration(text) {
  const n = String(text || '').replace(/\s/g, '').length;
  return Math.max(0.8, n / CHARS_PER_SEC + CUE_OVERHEAD);
}

let trackSeq = 0;

/**
 * 把一条数据库记录变成「曲目」
 * @param {object} a articles 表的一行
 * @param {{fullText?:boolean}} opts
 */
export function makeTrack(a, opts = {}) {
  const fullText = opts.fullText !== false;
  const title = cleanText(a.title || '');
  const body = fullText ? cleanText(a.content || a.summary || '') : cleanText(a.summary || '');

  const cues = [];
  if (title) cues.push({ text: title, kind: 'title' });

  if (body) {
    const sentences = splitCues(body);
    // 正文第一句往往就是标题本身（或者截断版），再念一遍很傻，去掉
    const norm = s => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    const head = norm(title).slice(0, 12);
    if (sentences.length && head.length >= 6) {
      const first = norm(sentences[0]);
      if (first.startsWith(head) || (first.length >= 6 && norm(title).includes(first))) sentences.shift();
    }
    for (const t of sentences) cues.push({ text: t, kind: 'body' });
  }

  for (const c of cues) {
    c.key = c.text;
    c.url = '';
    c.dur = estimateDuration(c.text);   // 合成后会被实测值覆盖
    c.ready = false;
    c.error = '';
  }

  return {
    uid: 't' + (++trackSeq) + '_' + (a.id ?? 'x'),
    id: a.id ?? null,
    title: title || '(无标题)',
    site: a.site || a.source_name || '未知来源',
    category: a.category || '综合',
    url: a.url || '',
    summary: cleanText(a.summary || ''),
    wordCount: a.word_count || 0,
    isVideo: !!a.no_body,
    publishedAt: a.published_at || a.crawled_at || '',
    cues,
    cueSource: fullText && a.content ? 'full' : 'summary'
  };
}

/** 从任意文本/网页抓取记录构造一个临时曲目 */
export function makeTrackFromDoc(doc) {
  return makeTrack({
    id: doc.articleId ?? null,
    title: doc.title,
    site: doc.site || '网页抓取',
    category: doc.category || '网页抓取',
    url: doc.url || '',
    summary: '',
    content: doc.content,
    crawled_at: doc.crawled_at
  }, { fullText: true });
}

/** 曲目总时长（秒） */
export function trackDuration(track) {
  if (!track) return 0;
  return track.cues.reduce((s, c) => s + (c.dur || 0), 0);
}

/** 第 i 句开始时已经播了多少秒 */
export function cueOffset(track, i) {
  if (!track) return 0;
  let s = 0;
  for (let k = 0; k < i && k < track.cues.length; k++) s += track.cues[k].dur || 0;
  return s;
}
