/**
 * 播报引擎 —— 整个应用的「心脏」
 *
 * 一句话概括：把一条新闻切成若干句，一句一段音频依次播放。
 * 于是「现在念到第几句」永远是精确的，字幕（歌词）就能跟语音严丝合缝地对上。
 *
 * 两套发音引擎：
 *   svr —— 本机 Windows 语音，服务端合成 MP3，浏览器用 <audio> 播。可暂停、可拖动、离线可用。
 *   web —— 浏览器内置在线神经语音（晓晓等），音质最好，还能拿到逐字 boundary 事件。
 */
import { reactive, computed, markRaw } from 'vue';
import { api } from '../api.js';
import { makeTrack, makeTrackFromDoc, trackDuration, cueOffset, estimateDuration } from './cues.js';

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
const STORAGE = {
  voice: 'wavecast.voice',
  rate: 'wavecast.rate',
  volume: 'wavecast.volume',
  mode: 'wavecast.mode',
  full: 'wavecast.full'
};

export const player = reactive({
  queue: [],            // 曲目（新闻）数组
  idx: -1,              // 当前曲目在队列中的下标
  cueIdx: -1,           // 当前句下标
  playing: false,
  buffering: false,     // 正在合成当前句
  fetchingContent: false,
  cueElapsed: 0,        // 当前句已播秒数
  webChar: 0,           // 在线语音的逐字进度
  mode: 'order',        // order | loop | single | shuffle
  fullText: true,       // 播全文还是只播标题+摘要
  rate: 1,
  volume: 1,
  voice: '',            // 'svr:xxx' | 'web:xxx'
  message: '',
  wakeLockOn: false,
  voices: { svr: [], web: [] },
  engineReady: false
});

export const current = computed(() => player.queue[player.idx] || null);
export const currentCues = computed(() => current.value?.cues || []);
export const currentCue = computed(() => currentCues.value[player.cueIdx] || null);
export const elapsed = computed(() => cueOffset(current.value, player.cueIdx) + (player.cueIdx >= 0 ? player.cueElapsed : 0));
export const duration = computed(() => trackDuration(current.value));
export const isWeb = computed(() => String(player.voice).startsWith('web:'));

/* ------------------------------------------------------------------ */
/* 音频缓存                                                            */
/* ------------------------------------------------------------------ */
const cache = new Map();      // voice|text -> { url, dur }
const inflight = new Map();   // voice|text -> Promise
const failed = new Set();

/* 逐句确定「用哪把嗓子」和「走哪套引擎」。
 * 以前引擎是按全局 player.voice 定的，导致双人对话里只要有一句是浏览器在线音色，
 * 另一句的本机音色就会被无视 —— 现在按 cue 自己带的前缀走：
 *   web:xxx → 浏览器 speechSynthesis；svr:xxx / 空 → 服务端合成 MP3。
 * 于是同一期节目里混搭两种引擎也是可以的（虽然一般没必要）。 */
const cueIsWeb = (cue) => String(cue?.voice || player.voice).startsWith('web:');
const stripPrefix = v => String(v || '').replace(/^svr:/, '').replace(/^web:/, '');
const voiceOf = (cue) => stripPrefix(cue?.voice) || player.voice.replace(/^svr:/, '') || 'Microsoft Huihui';
const keyOf = (cue) => (cue?.voice || '') + '\u0001' + cue.text;
const svrVoice = () => String(player.voice).replace(/^svr:/, '') || 'Microsoft Huihui';

function applyCache(cue, hit) {
  cue.url = hit.url;
  if (hit.dur) cue.dur = hit.dur;
  cue.ready = true;
}

/** 合成单句（当前要播的那句走这里，拿到就播） */
function ensureCue(cue) {
  if (cue.url) return Promise.resolve(cue.url);
  const key = keyOf(cue);
  const hit = cache.get(key);
  if (hit) { applyCache(cue, hit); return Promise.resolve(cue.url); }
  if (inflight.has(key)) return inflight.get(key);

  const p = api.ttsSynth({ text: cue.text, voice: voiceOf(cue) })
    .then(r => {
      inflight.delete(key);
      if (!r.url) { cue.error = '合成失败'; cue.ready = true; return ''; }
      const rec = { url: r.url, dur: r.duration || cue.dur };
      cache.set(key, rec);
      applyCache(cue, rec);
      return cue.url;
    })
    .catch(e => {
      inflight.delete(key);
      cue.error = e.message || '合成失败';
      cue.ready = true;
      throw e;
    });
  inflight.set(key, p);
  return p;
}

/** 后台预取后面几句：一次请求合成多句，省掉大量 HTTP 往返 */
function prefetch(track, from, n = 5) {
  if (!track) return;
  const todo = [];
  for (let i = from; i < Math.min(track.cues.length, from + n); i++) {
    const cue = track.cues[i];
    if (cue.url || cue.ready) continue;
    if (cueIsWeb(cue)) continue;      // 在线音色由浏览器自己读，不用后端合成
    const key = keyOf(cue);
    if (cache.has(key) || inflight.has(key)) {
      const hit = cache.get(key);
      if (hit) applyCache(cue, hit);
      continue;
    }
    todo.push({ cue, key });
    if (todo.length >= 30) break;
  }
  if (!todo.length) return;

  let settle;
  const gate = new Promise(r => { settle = r; });
  for (const t of todo) inflight.set(t.key, gate);

  api.ttsSynthBatch({
    items: todo.map((t, i) => ({ key: i, text: t.cue.text, voice: voiceOf(t.cue) })),
    voice: voiceOf(todo[0].cue)
  })
    .then(r => {
      const list = r.list || [];
      for (const t of todo) {
        const row = list[t.key];
        inflight.delete(t.key);
        if (!row || row.error || !row.url) {
          t.cue.error = (row && row.error) || '合成失败';
          t.cue.ready = true;
          continue;
        }
        const rec = { url: row.url, dur: row.duration || t.cue.dur };
        cache.set(t.key, rec);
        applyCache(t.cue, rec);
      }
    })
    .catch(() => {
      for (const t of todo) inflight.delete(t.key);
    })
    .finally(() => settle());
}

/* ------------------------------------------------------------------ */
/* 播放核心                                                            */
/* ------------------------------------------------------------------ */
const audio = typeof Audio !== 'undefined' ? new Audio() : null;
let utter = null;
let msgTimer = null;
let navigating = false;   // 正在切句，忽略旧音频的回调

function flash(text) {
  player.message = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { if (player.message === text) player.message = ''; }, 3600);
}
export function notify(text) { flash(text); }

function curTrack() { return player.queue[player.idx] || null; }
function curCue() { return curTrack()?.cues?.[player.cueIdx] || null; }

if (audio) {
  audio.preload = 'auto';
  audio.addEventListener('timeupdate', () => {
    if (navigating) return;
    player.cueElapsed = audio.currentTime || 0;
    const cue = curCue();
    // 用实测时长回填估算值，让总时长越来越准。
    // 阈值给 1.5s：浏览器对 MP3 时长的估计本身就有误差，小差异不值得改，
    // 否则进度条会在播放中来回跳。
    if (cue && isFinite(audio.duration) && audio.duration > 0) {
      if (Math.abs((cue.dur || 0) - audio.duration) > 1.5) cue.dur = audio.duration;
    }
  });
  audio.addEventListener('ended', () => {
    if (navigating || !player.playing) return;
    nextCue();
  });
  audio.addEventListener('error', () => {
    if (navigating || !player.playing || isWeb.value) return;
    flash('当前句播放失败，跳过');
    nextCue();
  });
}

/** 播放第 i 句 */
async function playCue(i) {
  const track = curTrack();
  if (!track) return stop();
  if (i >= track.cues.length) return nextTrack();
  if (i < 0) i = 0;

  navigating = true;
  player.cueIdx = i;
  player.cueElapsed = 0;
  player.webChar = 0;
  const cue = track.cues[i];
  syncMediaSession();

  const finish = () => { navigating = false; };

  if (cueIsWeb(cue)) {
    player.buffering = false;
    player.playing = true;
    speakCue(cue);
    finish();
    return;
  }

  try {
    player.buffering = !cue.url;
    await ensureCue(cue);
    // 合成期间用户可能已经切走了
    if (player.cueIdx !== i || !curTrack() || curTrack() !== track) { finish(); return; }
    if (!cue.url) throw new Error('这一句没有生成音频');

    navigating = false;
    audio.src = cue.url;
    audio.playbackRate = player.rate;
    audio.volume = player.volume;
    await audio.play();
    player.playing = true;
    player.buffering = false;
    prefetch(track, i + 1, 5);
    prefetchContentAhead();
  } catch (e) {
    player.buffering = false;
    const msg = String(e.message || '');
    if (msg.includes('not allowed') || msg.includes('NotAllowedError')) {
      player.playing = false;
      flash('浏览器拦了一次自动播放，再点一下播放即可');
      finish();
      return;
    }
    flash('播报中断：' + (msg || '未知原因'));
    finish();
    if (i + 1 < track.cues.length) setTimeout(() => playCue(i + 1), 500);
    else nextTrack();
  }
}

/** 在线神经语音连续失败几次就判定它不可用（断网 / 系统没装语音包） */
let webFailStreak = 0;

/** 在线神经语音：直接朗读，boundary 事件给逐字进度 */
function speakCue(cue) {
  if (typeof speechSynthesis === 'undefined') { flash('当前浏览器不支持在线语音'); return; }
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  const u = new SpeechSynthesisUtterance(cue.text);
  const v = webVoiceObj(cue);
  if (v) u.voice = v;
  u.lang = 'zh-CN';
  u.rate = player.rate;
  u.volume = player.volume;
  u.onstart = () => {
    webFailStreak = 0;
    player.playing = true;
    player.buffering = false;
  };
  u.onboundary = e => {
    player.webChar = e.charIndex || 0;
    player.cueElapsed = Math.min(cue.dur, (player.webChar / Math.max(1, cue.text.length)) * cue.dur);
  };
  u.onend = () => { if (player.playing) nextCue(); };
  u.onerror = e => {
    const err = e.error || '';
    if (err === 'interrupted' || err === 'canceled') return;   // 我们自己打断的
    webFailStreak++;
    // 连着几次都不出声，就别硬撑了：自动落到本机离线语音，至少能让用户继续听
    if (webFailStreak >= 2) {
      const fallback = player.voices.svr[0];
      webFailStreak = 0;
      if (fallback) {
        flash('在线语音不可用（' + err + '），已自动切到本机语音');
        setVoice(fallback.id);
      } else {
        stop();
        flash('在线语音不可用，且本机没有可用的中文语音');
      }
      return;
    }
    flash('在线语音出错（' + err + '），重试一次');
    setTimeout(() => { if (player.playing) speakCue(cue); }, 500);
  };
  utter = u;
  speechSynthesis.speak(u);
}

/** cue 可以自带 voice（双人对话），没有就用全局那把 */
function webVoiceObj(cue) {
  const id = cue?.voice || player.voice;
  const name = String(id).replace(/^web:/, '');
  return player.voices.web.find(v => v.name === name)?.voice || null;
}

/**
 * 给双人对话挑两把嗓子。
 *
 * 关键约束：必须同一族引擎。浏览器在线音色和本机离线音色是两套完全不同的东西，
 * 混着配的话另一路会被静默忽略，听起来还是同一个人 —— 所以这里先在同族里找，
 * 同族凑不齐两个就整体退回本机语音（本机保证至少能凑够一男一女）。
 */
export function autoPairVoices(baseId) {
  const all = [...player.voices.svr, ...player.voices.web];
  if (!all.length) return { host: '', guest: '' };
  const familyOf = v => (String(v.id || '').startsWith('web:') ? 'web' : 'svr');

  /* 双人对话优先用本机语音：服务端合成才产得出 MP3 文件，
     也才有「拖动进度、导出下载、断网也能听」这些能力。
     浏览器在线语音是当场念出来的，没有音频文件，进度也不稳，
     只在本地凑不齐两个音色时才退而求其次。 */
  const usable = [player.voices.svr, player.voices.web].filter(p => p.length >= 2);
  if (usable.length) {
    const pool = usable[0];
    const base = pool.find(v => v.id === baseId) || pool[0];
    const rest = pool.filter(v => v.id !== base.id);
    const alt =
      rest.find(v => base.gender && v.gender && v.gender !== base.gender) ||
      rest.find(v => v.group && v.group !== base.group) ||
      rest[0];
    return { host: base.id, guest: (alt || base).id };
  }

  // 只剩一把嗓子可挑：至少保证同族，不要跨引擎混搭
  const base = all.find(v => v.id === baseId) || all[0];
  const rest = all.filter(v => v.id !== base.id && familyOf(v) === familyOf(base));
  return { host: base.id, guest: (rest[0] || base).id };
}

export function voiceGroupsRaw() {
  return { web: player.voices.web, svr: player.voices.svr, all: [...player.voices.web, ...player.voices.svr] };
}

/* ------------------------------------------------------------------ */
/* 曲目流转                                                            */
/* ------------------------------------------------------------------ */
function nextCue() {
  const track = curTrack();
  if (!track) return stop();
  if (player.cueIdx + 1 < track.cues.length) playCue(player.cueIdx + 1);
  else nextTrack();
}

function nextTrack(manual = false) {
  const n = player.queue.length;
  if (!n) return stop();
  if (!manual && player.mode === 'single') return playCue(0);

  let next = player.idx + 1;
  if (player.mode === 'shuffle' && n > 1) {
    do { next = Math.floor(Math.random() * n); } while (next === player.idx && n > 1);
  }
  if (next >= n) {
    if (player.mode === 'loop' || player.mode === 'shuffle') next = 0;
    else { stop(); flash('这一轮播报结束了'); return; }
  }
  playTrack(next);
}

async function playTrack(i) {
  const track = player.queue[i];
  if (!track) return stop();
  player.idx = i;
  player.playing = false;
  player.cueElapsed = 0;

  // 播到这条才去抓这条的正文：不是每条新闻都值得抓全文，边播边抓最省
  if (player.fullText && track._raw && !track._raw.content && !track._raw.no_body && track._raw.url) {
    player.fetchingContent = true;
    try {
      const r = await Promise.race([
        api.articleContent(track._raw.id),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))
      ]);
      track._raw.content = r.content;
      track._raw.word_count = r.word_count;
      // 正文到了：把歌词换成全文版，从当前位置接着播
      const refreshed = makeTrack(track._raw, { fullText: true });
      refreshed._raw = track._raw;
      player.queue[i] = refreshed;
      syncMediaSession();
      flash('正文已就位，开始播报全文');
    } catch {
      /* 抓不到就按标题+摘要播，不打断 */
    } finally {
      player.fetchingContent = false;
    }
  }
  playCue(0);
}

function stop() {
  navigating = true;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  if (audio) { try { audio.pause(); } catch { /* ignore */ } }
  utter = null;
  player.playing = false;
  player.buffering = false;
  player.cueIdx = -1;
  player.cueElapsed = 0;
  player.webChar = 0;
  setTimeout(() => { navigating = false; }, 60);
  syncMediaSession();
}

/** 后台预抓后面两条的正文，让连播不断档 */
function prefetchContentAhead() {
  if (!player.fullText) return;
  const ids = player.queue.slice(player.idx + 1, player.idx + 3);
  for (const t of ids) {
    const a = t && t._raw;
    if (!a || a.content || a.no_body || !a.url || a.__fetching) continue;
    a.__fetching = true;
    api.articleContent(a.id)
      .then(r => { a.content = r.content; a.word_count = r.word_count; })
      .catch(() => {})
      .finally(() => { a.__fetching = false; });
  }
}

/* ------------------------------------------------------------------ */
/* 对外操作                                                            */
/* ------------------------------------------------------------------ */
export function setQueue(articles, opts = {}) {
  const list = (articles || []).map(a => {
    const t = makeTrack(a, { fullText: player.fullText });
    t._raw = markRaw(a);
    return t;
  });
  const keepUid = curTrack()?.uid;
  player.queue = list;
  // 列表刷新后尽量停在原来那条上
  if (opts.keepPosition !== false && keepUid) {
    const i = list.findIndex(t => t.uid === keepUid);
    if (i >= 0) { player.idx = i; return; }
  }
  player.idx = -1;
  player.cueIdx = -1;
}

/** 队列里点第 i 条直接开播 */
export function playTrackIndex(i) {
  if (i < 0 || i >= player.queue.length) return;
  playTrack(i);
}

/** 从某条开始播（点卡片 ▶ / 双击列表） */
export function playFrom(articles, articleId) {
  if (!player.queue.length || !player.queue.some(t => t.id === articleId)) setQueue(articles);
  const i = player.queue.findIndex(t => t.id === articleId);
  if (i < 0) { flash('这条暂时没法播报'); return; }
  playTrack(i);
}

/** 播报一个临时文档（网页抓取 / 自定义文本） */
export function playDoc(doc) {
  const t = makeTrackFromDoc(doc);
  player.queue = [t];
  player.idx = 0;
  playCue(0);
}

/**
 * AI 生成的一期节目直接变曲目。
 *
 * script.cues 本来就是 [{speaker, text}]，和 makeTrack 造出来的结构完全一致，
 * 所以字幕滚动、句级进度、全屏字幕、MP3 导出全都不用改一行 —— 这也是
 * 「AI 产物直接做成 cue 数组」的用意。双人对话只是额外给 cue 带上 speaker，
 * 由 voiceOf(cue) 分发到两把不同的嗓子。
 */
export function makeDigestTrack(d, opts = {}) {
  const script = d.script || {};
  const voices = opts.voices || {};
  const kind = script.kind || d.kind || 'newsreel';
  const cues = (script.cues || []).map((c, i) => {
    const spk = c.speaker || 'narrator';
    const text = String(c.text || '').replace(/\s+/g, ' ').trim();
    const label =
      c.speakerLabel ||
      (spk === 'host' ? (script.hostName || '主播')
        : spk === 'guest' ? (script.guestName || '评论员')
          : (script.leadName || '播报'));
    return {
      text,
      kind: c.kind || 'body',
      speaker: spk,
      speakerLabel: label,
      refs: c.refs || [],
      itemIndex: c.itemIndex === undefined ? null : c.itemIndex,
      voice: voices[spk] || '',
      key: spk + '|' + i + '|' + text,
      url: '',
      dur: estimateDuration(text),
      ready: false,
      error: ''
    };
  }).filter(c => c.text);

  return {
    uid: 'dg_' + d.id + '_' + Date.now(),
    id: null,
    digestId: d.id,
    isDigest: true,
    digestKind: kind,
    title: script.title || d.title || 'AI 精选',
    site: 'AI 精选',
    category: kind === 'dialogue' ? '双人对话' : '精选轮播',
    url: '',
    summary: script.subtitle || '',
    wordCount: cues.reduce((s, c) => s + c.text.length, 0),
    isVideo: false,
    publishedAt: d.created_at || '',
    cues,
    cueSource: 'digest',
    voices,
    script
  };
}

export function playDigest(d, opts = {}) {
  const t = makeDigestTrack(d, opts);
  player.queue = [t];
  player.idx = 0;
  playCue(0);
  return t;
}

export function toggle() {
  if (player.playing) return pause();
  if (player.idx < 0 || !curTrack()) {
    if (!player.queue.length) { flash('先去「发现」挑几条新闻进来'); return; }
    return playTrack(0);
  }
  if (isWeb.value) {
    player.playing = true;
    speakCue(curCue() || player.queue[player.idx].cues[0]);
    return;
  }
  if (audio && audio.src) {
    audio.playbackRate = player.rate;
    audio.play().then(() => { player.playing = true; }).catch(() => playCue(player.cueIdx));
    return;
  }
  playCue(Math.max(0, player.cueIdx));
}

export function pause() {
  if (isWeb.value) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  else if (audio) { try { audio.pause(); } catch { /* ignore */ } }
  player.playing = false;
  syncMediaSession();
}

export function stopAll() { stop(); }

export function jumpTrack(step) {
  if (!player.queue.length) return;
  let i = player.idx + step;
  if (i < 0) i = player.mode === 'loop' || player.mode === 'shuffle' ? player.queue.length - 1 : 0;
  if (i >= player.queue.length) {
    if (player.mode === 'loop' || player.mode === 'shuffle') i = 0;
    else { stop(); return; }
  }
  playTrack(i);
}

export function jumpCue(step) {
  const i = player.cueIdx + step;
  if (i < 0) return jumpTrack(-1);
  playCue(i);
}

/** 点歌词某一句 → 从那句开始念 */
export function seekCue(i) { playCue(i); }

/** 拖动进度条 → 定位到大致那一句 */
export function seekRatio(ratio) {
  const track = curTrack();
  if (!track) return;
  const target = Math.max(0, Math.min(1, ratio)) * trackDuration(track);
  let acc = 0;
  for (let i = 0; i < track.cues.length; i++) {
    acc += track.cues[i].dur || 0;
    if (acc >= target) return playCue(i);
  }
  playCue(track.cues.length - 1);
}

export function setRate(v) {
  player.rate = v;
  if (audio) audio.playbackRate = v;
  if (isWeb.value && player.playing && curCue()) speakCue(curCue());
  save(STORAGE.rate, v);
}

export function setVolume(v) {
  player.volume = v;
  if (audio) audio.volume = v;
  if (utter) utter.volume = v;
  save(STORAGE.volume, v);
}

export function setMode(m) {
  player.mode = m;
  save(STORAGE.mode, m);
}

export function setFullText(on) {
  player.fullText = on;
  save(STORAGE.full, on ? '1' : '0');
  // 队列里的曲目按新口径重建（保留播放位置）
  const keepUid = curTrack()?.uid;
  const keepCue = player.cueIdx;
  player.queue = player.queue.map(t => {
    if (!t._raw) return t;
    const nt = makeTrack(t._raw, { fullText: on });
    nt._raw = t._raw;
    return nt;
  });
  if (keepUid) {
    const i = player.queue.findIndex(t => t.uid === keepUid);
    if (i >= 0) { player.idx = i; player.cueIdx = Math.min(keepCue, player.queue[i].cues.length - 1); }
  }
}

export function setVoice(id) {
  const prevWeb = isWeb.value;
  player.voice = id;
  save(STORAGE.voice, id);
  cache.clear();
  inflight.clear();
  if (prevWeb && !isWeb.value) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  if (player.playing || player.idx >= 0) playCue(Math.max(0, player.cueIdx));
}

/* ------------------------------------------------------------------ */
/* 系统级集成：锁屏控制 + 屏幕常亮                                      */
/* ------------------------------------------------------------------ */
function syncMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const t = curTrack();
  try {
    if (!t) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new (window.MediaMetadata || Object)({
      title: t.title,
      artist: t.site,
      album: t.category + ' · 声波播报'
    });
    navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
  } catch { /* ignore */ }
}

function bindMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const H = {
    play: () => toggle(),
    pause: () => pause(),
    previoustrack: () => jumpTrack(-1),
    nexttrack: () => jumpTrack(1),
    stop: () => stopAll()
  };
  for (const [k, fn] of Object.entries(H)) {
    try { navigator.mediaSession.setActionHandler(k, fn); } catch { /* ignore */ }
  }
}

let wakeLock = null;
export async function setWakeLock(on) {
  player.wakeLockOn = on;
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { player.wakeLockOn = false; });
      flash('已开启屏幕常亮，运动时字幕不会熄');
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
      flash('已关闭屏幕常亮');
    }
  } catch (e) {
    player.wakeLockOn = false;
    flash('这个浏览器不支持屏幕常亮');
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */
function save(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } }
function load(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }

const WEB_LABELS = {
  Xiaoxiao: '晓晓', Yunxi: '云希', Yunyang: '云扬', Xiaoyi: '晓伊', Yunjian: '云健',
  Xiaohan: '晓涵', Xiaochen: '晓辰', Xiaomo: '晓墨', Xiaoqiu: '晓秋', Xiaorui: '晓睿',
  Xiaoshuang: '晓双', Xiaoxuan: '晓萱', Xiaoyan: '晓颜', Xiaoyou: '晓悠',
  Yunye: '云野', Yunxia: '云夏', Yunfeng: '云枫', Yunting: '云婷',
  HanHan: '韩韩', Tracy: '翠西', Xiaomeng: '晓梦', Yunze: '云泽'
};
const LOCAL_NAMES = ['Huihui', 'Kangkang', 'Yaoyao'];

function loadWebVoices() {
  if (typeof speechSynthesis === 'undefined') return;
  const all = speechSynthesis.getVoices() || [];
  const zh = all.filter(v => /^zh/i.test(v.lang) && !LOCAL_NAMES.some(n => v.name.includes(n)));
  player.voices.web = zh.map(v => {
    const key = Object.keys(WEB_LABELS).find(k => v.name.includes(k));
    const natural = /Natural/i.test(v.name);
    return {
      id: 'web:' + v.name,
      name: v.name,
      label: (key ? WEB_LABELS[key] : v.name.replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, ''))
        + '（在线' + (natural ? ' · 自然' : '') + '）',
      group: natural ? '在线 · 神经语音' : '在线语音',
      voice: v
    };
  });
}

export async function initPlayer() {
  player.rate = Number(load(STORAGE.rate, 1)) || 1;
  player.volume = Number(load(STORAGE.volume, 1));
  if (!isFinite(player.volume)) player.volume = 1;
  player.mode = load(STORAGE.mode, 'order');
  player.fullText = load(STORAGE.full, '1') !== '0';
  if (audio) audio.volume = player.volume;

  loadWebVoices();
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.onvoiceschanged = loadWebVoices;
    setTimeout(loadWebVoices, 900);
  }

  try {
    const r = await api.ttsVoices();
    player.voices.svr = (r.voices || []).map(v => ({
      id: 'svr:' + v.id,
      name: v.id,
      label: v.label + (v.note ? ' · ' + v.note.split(' · ').pop() : ''),
      group: '本机语音 · 离线',
      gender: v.gender
    }));
    player.engineReady = player.voices.svr.length > 0;
  } catch { player.engineReady = false; }

  const saved = load(STORAGE.voice, '');
  const all = [...player.voices.web.map(v => v.id), ...player.voices.svr.map(v => v.id)];
  if (saved && all.includes(saved)) player.voice = saved;
  else {
    player.voice = (player.voices.web.find(v => /Xiaoxiao/.test(v.name))
      || player.voices.web[0]
      || player.voices.svr[0])?.id || '';
  }

  bindMediaSession();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (player.wakeLockOn && document.visibilityState === 'visible') setWakeLock(true);
    });
  }
}

/* 估算：给进度条在未合成时用一个近似值 */
export { estimateDuration };

/* 调试出口：排查播放异常时在控制台看 __wavecast 即可 */
if (typeof window !== 'undefined') {
  window.__wavecast = {
    player,
    audio,
    cache,
    get state() {
      return audio ? {
        src: String(audio.src || '').slice(-46),
        paused: audio.paused,
        muted: audio.muted,
        currentTime: Math.round((audio.currentTime || 0) * 100) / 100,
        duration: Math.round((audio.duration || 0) * 100) / 100,
        playbackRate: audio.playbackRate,
        volume: audio.volume,
        readyState: audio.readyState,
        error: audio.error ? audio.error.code : null
      } : null;
    }
  };
}
