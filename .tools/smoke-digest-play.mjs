/**
 * 端到端播放验证：往库里塞一期双人对话，在浏览器里点「播放」，
 * 实测这一期的每一句是不是分别用了两把不同的嗓子、字幕有没有跟着走。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const DB = path.join(process.cwd(), '..', 'server', 'data', 'aggregator.db');
const db = new Database(DB);

const script = {
  kind: 'dialogue',
  title: '验证用：今日双人对话',
  subtitle: '主播 × 评论员 · 2 轮对话',
  hostName: '主播',
  guestName: '评论员',
  items: [{ index: 0, title: '新芯片发布值不值得关注', summary: '', sources: [] }],
  cues: [
    { speaker: 'host', speakerLabel: '主播', kind: 'lead', text: '今天聊聊新芯片。', refs: [] },
    { speaker: 'guest', speakerLabel: '评论员', kind: 'body', text: '关键在供货。', refs: [] },
    { speaker: 'host', speakerLabel: '主播', kind: 'body', text: '现在换机合适吗？', refs: [] },
    { speaker: 'guest', speakerLabel: '评论员', kind: 'outro', text: '可以再等等。', refs: [] }
  ]
};

db.prepare('DELETE FROM digests WHERE title=?').run(script.title);
const info = db.prepare(`
  INSERT INTO digests (kind, title, subtitle, status, stage, stage_msg, progress, models, scope,
    input_count, cluster_count, drop_count, keep_count, item_count, cue_count, script,
    tokens_in, tokens_out, duration_ms, error, created_at)
  VALUES ('dialogue', ?, ?, 'done', 'done', '生成完成', 100, '{}', '{}',
    100, 80, 20, 60, 1, 4, ?, 0, 0, 1200, '', ?)
`).run(script.title, script.subtitle, JSON.stringify(script), new Date().toISOString());
console.log('已插入测试节目 id =', info.lastInsertRowid);

const PORT = 9349;
const EDGE = [
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn('G:/Program Files/nodejs/node.exe', [path.join(process.cwd(), '..', 'server', 'index.js')],
  { cwd: path.join(process.cwd(), '..'), stdio: 'ignore', windowsHide: true, shell: false });
const profile = path.join(os.tmpdir(), 'wc-dg-' + Date.now());
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-extensions', '--window-size=1440,900',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'
], { shell: false, windowsHide: true });

const cleanup = () => {
  try { proc.kill(); } catch { /* ignore */ }
  try { srv.kill(); } catch { /* ignore */ }
  try { db.prepare('DELETE FROM digests WHERE id=?').run(info.lastInsertRowid); } catch { /* ignore */ }
};
process.on('exit', cleanup);

(async () => {
  let ws;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } }
    catch { /* retry */ }
    await sleep(300);
  }
  await sleep(2500);

  const sock = new WebSocket(ws);
  let id = 0;
  const pend = new Map();
  const errors = [];
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  sock.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 180));
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}, sid = null) => {
    const mid = ++id; const msg = { id: mid, method, params };
    if (sid) msg.sessionId = sid;
    sock.send(JSON.stringify(msg));
    return new Promise((res, rej) => pend.set(mid, { res, rej }));
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, S);
  await send('Page.enable', {}, S);
  /* 先把本机语音引擎预热起来，否则页面刚加载时语音清单还没到位，
     双人配对会临时退到浏览器在线音色，测出来就不是真实使用状态了 */
  for (let i = 0; i < 60; i++) {
    try {
      await fetch('http://127.0.0.1:5199/api/tts/warmup', { method: 'POST' });
      const v = await (await fetch('http://127.0.0.1:5199/api/tts/voices')).json();
      if ((v.data?.voices || []).length >= 2) { console.log('本机语音已就绪：', v.data.voices.map(x => x.label).join(' / ')); break; }
    } catch { /* 服务还没起来 */ }
    await sleep(1000);
  }

  await send('Page.navigate', { url: 'http://localhost:5199/' }, S);
  await sleep(4200);

  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) { errors.push('EVAL ' + (r.exceptionDetails.exception?.description || '').slice(0, 160)); return null; }
    return r.result?.value;
  };

  await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.textContent.includes('AI 精选')).click()`);
  await sleep(1200);
  const rows = await ev(`document.querySelectorAll('.drow').length`);
  console.log('节目列表行数      ', rows);

  await ev(`document.querySelector('.drow .btn.primary').click()`);
  await sleep(1500);

  const t = await ev(`(()=>{const q=window.__wavecast.player.queue; const tr=q[0]; return {
    nowView: !!document.querySelector('.vinyl'),
    title: tr?.title, kind: tr?.digestKind,
    cueCount: tr?.cues.length,
    voices: tr?.cues.map(c=>c.voice),
    labels: tr?.cues.map(c=>c.speakerLabel)
  }})()`);
  console.log('曲目              ', JSON.stringify(t));

  console.log('\n等待逐句合成与播放…');
  let last = '';
  for (let i = 0; i < 22; i++) {
    await sleep(1500);
    const s = await ev(`(()=>{const p=window.__wavecast.player; const tr=p.queue[p.idx]; return {
      playing: p.playing, cueIdx: p.cueIdx,
      urls: tr?.cues.map(c=>c.url? c.url.slice(-10):'…'),
      active: document.querySelector('.lyric-line.active')?.textContent?.trim(),
      speakerChip: document.querySelector('.lyric-line.active .who')?.textContent
    }})()`);
    if (!s) continue;
    const line = `${s.playing ? '▶' : '⏸'} 第${s.cueIdx + 1}句 ${s.speakerChip || ''} ${(s.active || '').slice(0, 20)}`;
    if (line !== last) { console.log('  ' + line); last = line; }
    if (s.cueIdx >= 3 && s.urls && s.urls.filter(u => u !== '…').length >= 4) break;
  }

  const final = await ev(`(()=>{const p=window.__wavecast.player; const tr=p.queue[p.idx]; return {
    urls: tr.cues.map(c=>c.url.slice(-12)),
    uniqUrls: new Set(tr.cues.map(c=>c.url)).size,
    voicesUsed: [...new Set(tr.cues.map(c=>c.voice))],
    progress: document.querySelector('.np-sub')?.textContent?.trim().slice(0,40)
  }})()`);
  console.log('\n=== 结果 ===');
  console.log('四句音频文件名    ', JSON.stringify(final.urls));
  console.log('互不相同的数量    ', final.uniqUrls, final.uniqUrls === 4 ? '（四段各自独立 → 音色确实分开了）' : '（⚠️ 有复用，需排查）');
  console.log('实际用到的音色    ', JSON.stringify(final.voicesUsed));
  console.log('JS 错误           ', errors.length ? errors.join(' | ') : '无');

  cleanup();
  await sleep(300);
  console.log('\n测试节目已从库中删除');
  process.exit(0);
})().catch(async e => { console.log('FATAL', e.message); cleanup(); process.exit(1); });
