/** 交互自查：发现页 → 播放 → 播报台 → 换肤 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 9334;
const URL = 'http://localhost:5199/';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const profile = path.join(os.tmpdir(), 'wavecast-int-' + Date.now());
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required',
  '--mute-audio', 'about:blank'
], { shell: false, windowsHide: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let wsUrl;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* wait */ }
    await sleep(300);
  }
  if (!wsUrl) throw new Error('CDP 未就绪');

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errs = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
    }
  };
  const send = (method, params = {}, sid = null) => {
    const mid = ++id;
    const msg = { id: mid, method, params };
    if (sid) msg.sessionId = sid;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => pending.set(mid, { res, rej }));
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, S);
  await send('Page.enable', {}, S);
  await send('Page.navigate', { url: URL }, S);
  await sleep(3500);

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, S);
    fs.writeFileSync(path.join(process.cwd(), '.tools', name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('SHOT ' + name);
  };

  /* 1) 去发现 */
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现')).click()`);
  await sleep(2600);
  const discover = await ev(`(() => {
    const cards = [...document.querySelectorAll('.ncard')];
    const r = cards[0]?.getBoundingClientRect();
    return {
      cards: cards.length,
      first: cards[0] ? { w: Math.round(r.width), h: Math.round(r.height), title: cards[0].querySelector('.ttl')?.textContent?.slice(0,30) } : null,
      grid: !!document.querySelector('.feed-grid'),
      feedH: document.querySelector('.feed')?.clientHeight,
      feedScroll: document.querySelector('.feed')?.scrollHeight,
      fabVisible: cards[0] ? getComputedStyle(cards[0].querySelector('.play-fab')).opacity : null
    };
  })()`);
  console.log('DISCOVER', JSON.stringify(discover));
  await shot('discover');

  /* 2) 点第一张卡片的播放键 */
  await ev(`document.querySelector('.ncard .play-fab').click()`);
  await sleep(9000);
  const playing = await ev(`(() => ({
    view: !!document.querySelector('.vinyl'),
    spinning: !!document.querySelector('.vinyl.spinning'),
    title: document.querySelector('.np-title')?.textContent?.slice(0,40),
    lyricLines: document.querySelectorAll('.lyric-line').length,
    activeLyric: document.querySelector('.lyric-line.active')?.textContent?.slice(0,50),
    activeIdx: [...document.querySelectorAll('.lyric-line')].findIndex(e=>e.classList.contains('active')),
    dockTitle: document.querySelector('.dock-info .t')?.textContent?.slice(0,30),
    dockCue: document.querySelector('.dock-info .s')?.textContent?.slice(0,40),
    barW: document.querySelector('.dock .bar .fill')?.style.width,
    buffering: document.querySelector('.dock-info .s')?.textContent?.includes('合成'),
    msg: document.querySelector('.toast')?.textContent || ''
  }))()`);
  console.log('PLAYING', JSON.stringify(playing, null, 1));
  await shot('playing');

  /* 3) 再等 12 秒看字幕是否推进 */
  await sleep(12000);
  const after = await ev(`(() => ({
    activeIdx: [...document.querySelectorAll('.lyric-line')].findIndex(e=>e.classList.contains('active')),
    doneCount: document.querySelectorAll('.lyric-line.done').length,
    barW: document.querySelector('.dock .bar .fill')?.style.width,
    time: document.querySelector('.bar-time')?.textContent
  }))()`);
  console.log('AFTER 12s', JSON.stringify(after));
  await shot('playing2');

  /* 4) 换肤：落日渐变 */
  await ev(`document.querySelectorAll('.icon-btn')[document.querySelectorAll('.icon-btn').length-1]?.click()`);
  await sleep(800);

  if (errs.length) { console.log('JS ERRORS:'); errs.slice(0, 6).forEach(e => console.log('  ' + String(e).slice(0, 220))); }
  else console.log('JS ERRORS: none');

  ws.close();
  proc.kill();
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error('FAIL', e.message); try { proc.kill(); } catch { /* ignore */ } process.exit(1); });
