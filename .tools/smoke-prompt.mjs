/**
 * 验证「提示词规则」现在确实暴露且可编辑：
 * 打开设置抽屉 → AI 加工 → 点「提示词规则」→ 确认弹窗 + 可编辑 textarea 出现。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 9349;
const EDGE = [
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn('G:/Program Files/nodejs/node.exe', [path.join(process.cwd(), '..', 'server', 'index.js')],
  { cwd: path.join(process.cwd(), '..'), stdio: 'ignore', windowsHide: true, shell: false });
const profile = path.join(os.tmpdir(), 'wc-prompt-' + Date.now());
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-extensions', '--window-size=1440,900',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'
], { shell: false, windowsHide: true });

const cleanup = () => { try { proc.kill(); } catch {} try { srv.kill(); } catch {} };
process.on('exit', cleanup);

(async () => {
  let ws;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } }
    catch {} await sleep(300);
  }
  await sleep(2500);
  const sock = new WebSocket(ws);
  let id = 0; const pend = new Map();
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  const errors = [];
  sock.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params = {}, sid = null) => {
    const mid = ++id; sock.send(JSON.stringify({ id: mid, method, params, ...(sid ? { sessionId: sid } : {}) }));
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

  // 1) 打开设置抽屉（齿轮按钮）
  const opened = await ev(`(()=>{const b=[...document.querySelectorAll('.icon-btn')].find(n=>n.title&&n.title.includes('设置')); if(b)b.click(); return !!b})()`);
  await sleep(900);
  console.log('设置抽屉可打开       ', opened);

  // 2) 抽屉里「提示词规则」那一行的「编辑」按钮存在并点击
  const clicked = await ev(`(()=>{const r=[...document.querySelectorAll('.setting-row')].find(x=>x.textContent.includes('提示词规则')); const b=r&&r.querySelector('button'); if(b){b.click(); return true} return false})()`);
  await sleep(1000);
  console.log('「提示词规则」按钮可点', clicked);

  // 3) 弹窗出现：标题 + textarea（可编辑）+ 已载入提示词内容
  const modal = await ev(`(()=>{const m=document.querySelector('.pm'); if(!m) return {open:false};
    const ta=[...m.querySelectorAll('textarea')];
    return {
      open:true,
      head: m.querySelector('.pm-head')?.textContent.trim(),
      tabs: [...m.querySelectorAll('.pm-tab')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()),
      textareas: ta.length,
      firstVal: (ta[0]?.value||'').slice(0,40),
      hasReset: [...m.querySelectorAll('button')].some(b=>b.textContent.includes('恢复默认')),
      editable: ta[0]? ta[0].readOnly===false && !ta[0].disabled : false
    }})()`);
  console.log('提示词弹窗状态       ', JSON.stringify(modal, null, 2));

  // 4) 切到「双人对话脚本」tab，确认另一套提示词也载入
  await ev(`(()=>{const b=[...document.querySelectorAll('.pm-tab')].find(x=>x.textContent.includes('双人对话')); if(b)b.click()})()`);
  await sleep(600);
  const tab2 = await ev(`(()=>{const ta=document.querySelector('.pm textarea'); return (ta?.value||'').slice(0,46)})()`);
  console.log('切到对话模板内容头   ', JSON.stringify(tab2));

  console.log('\n=== JS 错误 ===');
  console.log(errors.length ? errors.join('\n') : '  无');
  await sleep(200); cleanup(); await sleep(400); process.exit(0);
})().catch(async e => { console.log('FATAL', e.message); cleanup(); process.exit(1); });
