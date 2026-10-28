/**
 * 本机微软语音合成（Windows OneCore / WinRT）
 *
 * 为什么不用 SAPI（SAPI.SpVoice）：
 *   SAPI 只能"边合成边从扬声器播放"，前端无法暂停/拖动/即时停止，
 *   而且 SAPI 只注册了 Huihui 一个中文语音。
 * OneCore 引擎多出 Yaoyao、Kangkang 两个中文语音，且能把结果合成成
 * WAV 文件 → 前端用 <audio> 播放，暂停、拖动进度、随时停止、断点续播
 * 全部变成浏览器原生能力。
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpegStatic from 'ffmpeg-static';
import { getSetting, setSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(__dirname, 'tts.ps1');
const CACHE_DIR = path.join(__dirname, 'data', 'tts-cache');
/** 无损 WAV 缓存：播报播放用 MP3，这里只留合成原始件，供 MP3 转码与离线导出复用 */
const WAV_DIR = path.join(CACHE_DIR, 'wav');
const TMPDIR = path.join(os.tmpdir(), 'info-agg-tts');
const EXPORT_DIR = path.join(__dirname, 'data', 'tts-export');
export const ffmpegAvailable = !!ffmpegStatic;

const MAX_CACHE_FILES = 6000;
const MAX_CACHE_BYTES = 600 * 1024 * 1024; // 600MB
const SYNTH_TIMEOUT = 45000;
/* 句级播报会把一篇正文切成几十句，MP3 化后单句约 40KB，
   不这么做的话 100 篇正文就是 600MB+ 的 WAV。 */
const MP3_BITRATE = '64k';

/** 语音中文名（本机 OneCore 只提供中文语音给本应用） */
const VOICE_LABELS = {
  'Microsoft Huihui': { label: '慧慧', note: '女声 · 沉稳默认' },
  'Microsoft Yaoyao': { label: '瑶瑶', note: '女声 · 清亮' },
  'Microsoft Kangkang': { label: '康康', note: '男声' }
};

export const ttsState = {
  ready: false,
  busy: false,
  lastError: '',
  lastSynthMs: 0,
  synthCount: 0,
  cacheFiles: 0,
  cacheBytes: 0,
  voice: 'Microsoft Huihui',
  rate: 0
};

let proc = null;
let starting = null;
let readyResolve = null;
let buf = '';
let pending = null;          // 当前等待的合成请求
let chain = Promise.resolve(); // 串行队列
let tmpSeq = 0;
let cachedVoices = null;

/* ---------------- 缓存目录 ---------------- */
function ensureDirs() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(WAV_DIR, { recursive: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(TMPDIR, { recursive: true }); } catch { /* ignore */ }
}
ensureDirs();

export const TTS_CACHE_DIR = CACHE_DIR;

function scanCache() {
  let files = 0;
  let bytes = 0;
  const list = [];
  const AUDIO_EXT = ['.mp3', '.wav'];
  const collect = dir => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!AUDIO_EXT.some(e => f.endsWith(e))) continue;
        const p = path.join(dir, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        files++;
        bytes += st.size;
        list.push({ name: p, size: st.size, mtime: st.mtimeMs });
      }
    } catch { /* ignore */ }
  };
  collect(CACHE_DIR);
  collect(WAV_DIR);
  ttsState.cacheFiles = files;
  ttsState.cacheBytes = bytes;
  return list;
}

/** 超过上限时按最久未使用淘汰 */
function pruneCache() {
  const list = scanCache();
  if (list.length <= MAX_CACHE_FILES && ttsState.cacheBytes <= MAX_CACHE_BYTES) return;
  list.sort((a, b) => a.mtime - b.mtime);
  let files = list.length;
  let bytes = ttsState.cacheBytes;
  const targetFiles = Math.floor(MAX_CACHE_FILES * 0.8);
  const targetBytes = Math.floor(MAX_CACHE_BYTES * 0.8);
  for (const f of list) {
    if (files <= targetFiles && bytes <= targetBytes) break;
    try {
      fs.unlinkSync(f.name);
      files--;
      bytes -= f.size;
    } catch { /* ignore */ }
  }
  scanCache();
}

/* ---------------- daemon ---------------- */
function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;
  if (line === '::READY::') {
    ttsState.ready = true;
    if (readyResolve) { readyResolve(true); readyResolve = null; }
    return;
  }
  if (line.startsWith('::ERROR::')) {
    ttsState.lastError = line.slice(9);
    ttsState.ready = false;
    if (readyResolve) { readyResolve(false); readyResolve = null; }
    if (pending) { pending.reject(new Error(ttsState.lastError)); pending = null; }
    return;
  }
  if (line.startsWith('::SYNTHED::')) {
    const parts = line.slice(11).split('::');
    const bytes = Number(parts[0]) || 0;
    const ms = Number(parts[1]) || 0;
    if (pending) {
      pending.resolve({ bytes, ms });
      pending = null;
    }
    return;
  }
  if (line.startsWith('::SYNTHERR::')) {
    if (pending) { pending.reject(new Error(line.slice(12))); pending = null; }
    return;
  }
}

export function ensureDaemon() {
  if (proc && ttsState.ready) return Promise.resolve(true);
  if (starting) return starting;

  starting = new Promise(resolve => {
    ensureDirs();
    let p;
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DAEMON], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      ttsState.lastError = '无法启动语音引擎：' + e.message;
      starting = null;
      return resolve(false);
    }
    proc = p;
    p.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    p.stderr.on('data', d => {
      const s = d.toString('utf8').trim();
      if (s) ttsState.lastError = s.slice(0, 300);
    });
    const down = () => {
      proc = null;
      ttsState.ready = false;
      starting = null;
      cachedVoices = null;
      if (pending) { pending.reject(new Error('语音引擎已退出')); pending = null; }
    };
    p.on('error', e => { ttsState.lastError = e.message; down(); resolve(false); });
    p.on('exit', () => { down(); });

    readyResolve = ok => { starting = null; resolve(ok); };
    setTimeout(() => {
      if (!ttsState.ready && readyResolve) {
        ttsState.lastError = ttsState.lastError || '语音引擎启动超时（本机可能未安装中文语音）';
        readyResolve(false);
        readyResolve = null;
      }
    }, 25000);
  });
  return starting;
}

function send(cmd) {
  if (proc && !proc.killed) {
    try { proc.stdin.write(cmd + '\n'); return true; } catch { return false; }
  }
  return false;
}

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

function writeTextFile(text) {
  const f = path.join(TMPDIR, `t${Date.now()}_${tmpSeq++}.txt`);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

/* ---------------- 语音列表 ---------------- */
export async function listVoices(force = false) {
  if (cachedVoices && !force) return cachedVoices;
  const ok = await ensureDaemon();
  if (!ok) return { ok: false, voices: [], error: ttsState.lastError || '语音引擎不可用' };

  const result = await new Promise(resolve => {
    let acc = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(acc);
    };
    // 复用 stdout 解析：临时挂一个监听
    const onData = d => {
      for (const line of d.toString('utf8').split('\n')) {
        const s = line.trim();
        if (s.startsWith('V|')) {
          const [, n, lang, gender] = s.split('|');
          try {
            acc.push({
              name: Buffer.from(n, 'base64').toString('utf8'),
              lang: lang || '',
              gender: gender || ''
            });
          } catch { /* ignore */ }
        } else if (s === '::LISTEND::') {
          finish();
        }
      }
    };
    proc.stdout.on('data', onData);
    send('::LIST::');
    setTimeout(() => {
      proc && proc.stdout.off('data', onData);
      finish();
    }, 12000);
  });

  // 只保留中文语音（用户明确要求不要英文）
  const zh = result.filter(v => /^zh/i.test(v.lang));
  const voices = (zh.length ? zh : result).map(v => {
    const meta = VOICE_LABELS[v.name] || {};
    return {
      id: v.name,
      name: v.name,
      label: meta.label || v.name,
      note: meta.note || '',
      lang: v.lang,
      gender: v.gender
    };
  });
  cachedVoices = { ok: voices.length > 0, voices, error: voices.length ? '' : '未找到中文语音' };
  return cachedVoices;
}

/* ---------------- 合成 ---------------- */
function cacheKey(text, voice, rate) {
  return crypto.createHash('md5').update([voice || '', rate ?? 0, text].join('\u0001'), 'utf8').digest('hex');
}

/**
 * 合成一段文本为 WAV。
 * @returns {Promise<{url:string, bytes:number, ms:number, cached:boolean}>}
 */
/* 底层：向 daemon 发一条合成指令，写 WAV 到 wavPath.part，完成后 rename。返回 {bytes,ms} */
function synthToFileRaw(text, voice, rate, wavPath) {
  return new Promise((resolve, reject) => {
    const txtPath = writeTextFile(String(text || ''));
    const done = fn => { try { fs.unlinkSync(txtPath); } catch { /* ignore */ } fn(); };
    pending = {
      resolve: r => done(() => resolve(r)),
      reject: e => done(() => reject(e))
    };
    const sent = send('::SYNTH::' + b64(wavPath + '.part') + '|' + b64(voice) + '|' + rate + '|' + b64(txtPath));
    if (!sent) { pending = null; return done(() => reject(new Error('语音引擎无响应'))); }
    setTimeout(() => {
      if (pending) { pending = null; done(() => reject(new Error('语音合成超时'))); }
    }, SYNTH_TIMEOUT);
  });
}

/** 读 RIFF 头算 WAV 时长（秒）。句级播报要显示进度，必须拿到每句的准确时长。 */
function wavDuration(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(96);
    const n = fs.readSync(fd, head, 0, 96, 0);
    fs.closeSync(fd);
    if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF') return 0;
    let pos = 12;
    while (pos + 8 <= n) {
      const id = head.toString('ascii', pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === 'fmt ' && pos + 8 + 16 <= n) {
        // fmt 数据布局：audioFormat(2) numChannels(2) sampleRate(4) byteRate(4)
        // → byteRate 起始于 chunk 数据区 +8，也就是 pos + 16
        const byteRate = head.readUInt32LE(pos + 16);
        if (!byteRate) return 0;
        // 数据块大小：优先取 data 头，取不到就用文件尾
        let dpos = pos + 8 + size;
        let dataSize = 0;
        while (dpos + 8 <= n) {
          const did = head.toString('ascii', dpos, dpos + 4);
          if (did === 'data') { dataSize = head.readUInt32LE(dpos + 4); break; }
          dpos += 8 + head.readUInt32LE(dpos + 4);
        }
        if (!dataSize) {
          try { dataSize = fs.statSync(file).size - 44; } catch { dataSize = 0; }
        }
        return Math.round((dataSize / byteRate) * 1000) / 1000;
      }
      pos += 8 + size;
    }
  } catch { /* ignore */ }
  return 0;
}

function wavToMp3(wav, mp3) {
  if (!ffmpegStatic) return Promise.resolve(false);
  return ffmpegRun([
    '-i', wav,
    '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-ar', '24000', '-ac', '1',
    '-y', mp3
  ]).then(() => true).catch(() => false);
}

/**
 * 合成一段文本，返回绝对路径（带缓存）。
 * @param {string} text
 * @param {{voice?:string, rate?:number, format?:'mp3'|'wav'}} opts
 *   format='mp3'（默认）用于即时播报：缓存体积小 5 倍，浏览器原生可播可拖。
 *   format='wav' 用于离线导出拼接：无损。
 */
export function synthToFile(text, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const voice = opts.voice || ttsState.voice || 'Microsoft Huihui';
  const rate = Number.isFinite(Number(opts.rate)) ? Number(opts.rate) : (ttsState.rate || 0);
  const wantWav = opts.format === 'wav';
  const key = cacheKey(clean, voice, rate);
  const wavFile = path.join(WAV_DIR, key + '.wav');
  const outFile = wantWav ? wavFile : path.join(CACHE_DIR, key + '.mp3');
  const minSize = wantWav ? 44 : 512;
  ttsState.voice = voice;
  ttsState.rate = rate;

  if (!clean) return Promise.resolve({ file: '', bytes: 0, ms: 0, duration: 0, cached: false, empty: true });

  const job = async () => {
    try {
      const st = fs.statSync(outFile);
      if (st.size > minSize) {
        return {
          file: outFile, bytes: st.size, ms: 0, cached: true,
          duration: wantWav ? wavDuration(outFile) : 0
        };
      }
    } catch { /* miss */ }

    const ok = await ensureDaemon();
    if (!ok) throw new Error(ttsState.lastError || '语音引擎不可用');

    // 引擎只能吐 WAV，统一先落到 WAV_DIR，再按需转 MP3
    const res = await synthToFileRaw(clean, voice, rate, wavFile);
    if (!res.bytes) {
      try { fs.unlinkSync(wavFile + '.part'); } catch { /* ignore */ }
      return { file: '', bytes: 0, ms: res.ms, duration: 0, cached: false, empty: true };
    }
    fs.renameSync(wavFile + '.part', wavFile);
    ttsState.lastSynthMs = res.ms;
    ttsState.synthCount++;

    const dur = wavDuration(wavFile);
    if (wantWav) {
      pruneCache();
      return { file: wavFile, bytes: res.bytes, ms: res.ms, duration: dur, cached: false };
    }

    const converted = await wavToMp3(wavFile, outFile);
    if (converted) {
      let bytes = 0;
      try { bytes = fs.statSync(outFile).size; } catch { /* ignore */ }
      pruneCache();
      return { file: outFile, bytes, ms: res.ms, duration: dur, cached: false };
    }
    // 没有 ffmpeg / 转码失败：直接播放 WAV，功能不受影响
    pruneCache();
    return { file: wavFile, bytes: res.bytes, ms: res.ms, duration: dur, cached: false };
  };

  const run = chain.then(job, job);
  chain = run.catch(() => {});
  return run;
}

/** 即时播报用：合成并返回可静态托管的 URL（保留原 4000 字上限） */
export function synth(text, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  return synthToFile(clean, opts).then(r => ({
    url: r.file ? '/tts-cache/' + path.relative(CACHE_DIR, r.file).replace(/\\/g, '/') : '',
    bytes: r.bytes, ms: r.ms, duration: r.duration || 0, cached: r.cached, empty: r.empty
  }));
}

/* ---------------- 离线 MP3 导出 ---------------- */
function safeName(s) {
  const base = String(s || 'article').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || 'article';
}

/** 把长文切成 ≤max 字的小段（优先在句末切），避免单次合成超限 */
function chunkText(text, max = 1400) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  const paras = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  const cutters = ['。', '！', '？', '!', '?', '；', ';', '，', ',', '、'];
  for (let p of paras) {
    while (p.length > max) {
      let cut = -1;
      for (const ch of cutters) {
        const idx = p.lastIndexOf(ch, max);
        if (idx > 0) { cut = idx + 1; break; }
      }
      if (cut < 0) cut = max;
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  }
  return out.length ? out : [raw];
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegStatic, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    p.on('error', e => reject(new Error('无法启动 ffmpeg：' + e.message)));
    p.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 退出码 ' + code + '：' + err.slice(-500)));
    });
  });
}

export function getExportDir() {
  const d = (getSetting('tts_export_dir', '') || '').trim();
  if (d && fs.existsSync(d)) return d;
  try { fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch { /* ignore */ }
  return EXPORT_DIR;
}

export function setExportDir(dir) {
  const d = String(dir || '').trim();
  if (!/^[a-zA-Z]:[\\/]/.test(d) && !d.startsWith('\\\\')) {
    throw new Error('请填写绝对路径，例如 D:\\语音导出');
  }
  fs.mkdirSync(d, { recursive: true });
  setSetting('tts_export_dir', d);
  return d;
}

/**
 * 把一段文章文本合成并导出为 MP3（完全离线，使用本机语音）。
 * 长文自动分段合成后由 ffmpeg 拼接编码为单个 MP3。
 * @returns {Promise<{ok:boolean, path:string, url:string, bytes:number, voice:string, chunks:number}>}
 */
export async function exportMp3({ text, voice = 'Microsoft Huihui', rate = 0, fileName = '' }) {
  if (!ffmpegStatic) throw new Error('ffmpeg 未安装，无法导出 MP3');
  const chunks = chunkText(text, 1400);
  if (!chunks.length) throw new Error('没有可合成的文本');

  const wavs = [];
  for (const c of chunks) {
    // 拼接需要无损 WAV；如果播报时已经合成过同一段，这里直接命中缓存
    const r = await synthToFile(c, { voice, rate, format: 'wav' });
    if (r.file && r.bytes) wavs.push(r.file);
  }
  if (!wavs.length) throw new Error('语音合成失败（无可用音频）');

  const dir = getExportDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = safeName(fileName || String(text).slice(0, 40)) + '.mp3';
  const outPath = path.join(dir, name);

  const args = [];
  for (const w of wavs) args.push('-i', w);
  if (wavs.length === 1) {
    args.push('-codec:a', 'libmp3lame', '-b:a', '128k', '-y', outPath);
  } else {
    const filt = wavs.map((_, i) => '[' + i + ':a]').join('') + 'concat=n=' + wavs.length + ':v=0:a=1[out]';
    args.push('-filter_complex', filt, '-map', '[out]', '-codec:a', 'libmp3lame', '-b:a', '128k', '-y', outPath);
  }
  await ffmpegRun(args);

  const st = fs.statSync(outPath);
  return {
    ok: true,
    path: outPath,
    url: '/tts-export/' + encodeURIComponent(path.basename(outPath)),
    bytes: st.size,
    voice,
    chunks: wavs.length
  };
}

export function cacheInfo() {
  scanCache();
  return {
    files: ttsState.cacheFiles,
    bytes: ttsState.cacheBytes,
    mb: Math.round((ttsState.cacheBytes / 1048576) * 10) / 10
  };
}

export function clearCache() {
  const wipe = dir => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.part')) {
          try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  };
  wipe(CACHE_DIR);
  wipe(WAV_DIR);
  scanCache();
  return cacheInfo();
}

export function shutdown() {
  try { send('::QUIT::'); } catch { /* ignore */ }
  setTimeout(() => { try { proc && proc.kill(); } catch { /* ignore */ } }, 300);
}

process.on('exit', shutdown);
