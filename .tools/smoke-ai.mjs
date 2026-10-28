/**
 * 新增页面的自助冒烟：Headless Edge + CDP，实测 DOM 而不是看代码猜。
 * 覆盖：AI 精选页、AI 模型管理弹窗、以及有没有 JS 报错 / 横向溢出。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 9347;
const EDGE = [
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 1. 起后端 */
const srv = spawn('G:/Program Files/nodejs/node.exe', [path.join(process.cwd(), '..', 'server', 'index.js')],
  { cwd: path.join(process.cwd(), '..'), stdio: 'ignore', windowsHide: true, shell: false });

/* 2. 起 Edge */
const profile = path.join(os.tmpdir(), 'wc-ai-' + Date.now());
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-extensions', '--window-size=1440,900',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'
], { shell: false, windowsHide: true });

const cleanup = () => {
  try { proc.kill(); } catch { /* ignore */ }
  try { srv.kill(); } catch { /* ignore */ }
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
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  const errors = [];
  sock.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
    }
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}, sid = null) => {
    const mid = ++id;
    const msg = { id: mid, method, params };
    if (sid) msg.sessionId = sid;
    sock.send(JSON.stringify(msg));
    return new Promise((res, rej) => pend.set(mid, { res, rej }));
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, S);
  await send('Page.enable', {}, S);
  await send('Page.navigate', { url: 'http://localhost:5199/' }, S);
  await sleep(4200);

  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) { errors.push('EVAL ' + (r.exceptionDetails.exception?.description || '').slice(0, 160)); return null; }
    return r.result?.value;
  };
  const clickNav = async label => {
    await ev(`(()=>{const e=[...document.querySelectorAll('.nav-item')].find(n=>n.textContent.includes('${label}')); if(e)e.click(); return !!e})()`);
    await sleep(900);
  };

  console.log('=== AI 精选页 ===');
  const navHas = await ev(`!![...document.querySelectorAll('.nav-item')].find(n=>n.textContent.includes('AI 精选'))`);
  console.log('侧栏入口存在        ', navHas);
  await clickNav('AI 精选');
  const dg = await ev(`(()=>{const g=document.querySelector('.dg'); return {
    mounted: !!g, cols: g?getComputedStyle(g).gridTemplateColumns:'',
    kinds: [...document.querySelectorAll('.kind')].map(k=>k.querySelector('.kn')?.textContent),
    selects: document.querySelectorAll('.dg .form-grid select').length,
    inputs: document.querySelectorAll('.dg .form-grid input').length,
    goBtn: document.querySelector('.dg-go')?.textContent.trim(),
    goDisabled: document.querySelector('.dg-go')?.disabled,
    modelOpts: [...document.querySelectorAll('.dg select')].map(s=>s.options.length).reduce((a,b)=>a+b,0)
  }})()`);
  console.log(JSON.stringify(dg, null, 2));

  console.log('\n=== 切到双人对话，音色选择器应出现 ===');
  await ev(`document.querySelectorAll('.kind')[1].click()`);
  await sleep(500);
  const dlg = await ev(`(()=>({
    voiceSelects: [...document.querySelectorAll('.dg select')].filter(s=>[...s.querySelectorAll('option')].some(o=>o.textContent.includes('声')||o.textContent.includes('慧慧')||o.textContent.includes('在线'))).length,
    nameInputs: [...document.querySelectorAll('.dg input')].filter(i=>['主播','评论员'].includes(i.value)).length
  }))()`);
  console.log(JSON.stringify(dlg));

  console.log('\n=== AI 模型管理弹窗 ===');
  await clickNav('AI 模型管理');
  await sleep(900);
  const mm = await ev(`(()=>{const m=document.querySelector('.modal'); return {
    open: !!m,
    rows: [...document.querySelectorAll('.mm-row')].map(r=>r.querySelector('.n')?.textContent),
    presets: document.querySelectorAll('.mm-presets .btn').length,
    fields: [...document.querySelectorAll('.mm-form input')].map(i=>i.previousElementSibling?.textContent?.slice(0,14)),
    head: m?.querySelector('.modal-head')?.textContent.trim(),
    overflowX: document.documentElement.scrollWidth - window.innerWidth
  }})()`);
  console.log(JSON.stringify(mm, null, 2));

  console.log('\n=== 历史节目列表（库里已有生成记录时会显示）===');
  const listRows = await ev(`document.querySelectorAll('.drow').length`);
  console.log('节目行数            ', listRows);

  console.log('\n=== JS 错误 ===');
  console.log(errors.length ? errors.join('\n') : '  无');

  await sleep(200);
  cleanup();
  await sleep(400);
  process.exit(0);
})().catch(async e => { console.log('FATAL', e.message); cleanup(); process.exit(1); });
