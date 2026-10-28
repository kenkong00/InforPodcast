import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9341;
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-fin-'+Date.now());
const proc = spawn(EDGE,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions','--window-size=1440,900','--autoplay-policy=no-user-gesture-required','--mute-audio','about:blank'],{shell:false,windowsHide:true});
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let ws; for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){ws=(await r.json()).webSocketDebuggerUrl;break}}catch{}await sleep(300)}
  const sock=new WebSocket(ws); let id=0; const pend=new Map();
  await new Promise((res,rej)=>{sock.onopen=res;sock.onerror=rej});
  sock.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}};
  const send=(method,params={},sid=null)=>{const mid=++id;const msg={id:mid,method,params};if(sid)msg.sessionId=sid;sock.send(JSON.stringify(msg));return new Promise((res,rej)=>pend.set(mid,{res,rej}))};
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId:S}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},S); await send('Page.enable',{},S);
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3800);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails){console.log('ERR',r.exceptionDetails.exception?.description?.slice(0,160));return null}return r.result?.value};
  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'},S);fs.writeFileSync(path.join(process.cwd(),'.tools',n+'.png'),Buffer.from(r.data,'base64'));console.log('SHOT',n)};

  // 队列页
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现')).click()`);
  await sleep(2600);
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('播放队列')).click()`);
  await sleep(1000); await shot('f-queue');

  // 阅读器
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现')).click()`);
  await sleep(2600);
  await ev(`document.querySelectorAll('.ncard')[2].click()`);
  await sleep(4000);
  const reader = await ev(`(()=>{const m=document.querySelector('.modal');return {open:!!m, title:m?.querySelector('.reader-title')?.textContent?.slice(0,30), tools:[...document.querySelectorAll('.reader-tools .btn')].map(b=>b.textContent.trim())}})()`);
  console.log('READER', JSON.stringify(reader));
  await shot('f-reader');

  // 阅读器里点「播报本篇」
  await ev(`[...document.querySelectorAll('.reader-tools .btn')].find(b=>b.textContent.includes('播报本篇'))?.click()`);
  await sleep(5000);
  const after = await ev(`(()=>({view:!!document.querySelector('.vinyl'), cue:document.querySelector('.lyric-line.active')?.textContent?.slice(0,40)}))()`);
  console.log('AFTER SPEAK DOC', JSON.stringify(after));
  await shot('f-doc-speak');

  // 设置抽屉（换装）
  await ev(`document.querySelector('.modal .icon-btn')?.click()`);
  await sleep(600);
  await ev(`[...document.querySelectorAll('.icon-btn')].find(e=>e.title.includes('换装'))?.click()`);
  await sleep(1200);
  const drawer = await ev(`(()=>({open:!!document.querySelector('.drawer'), themes:document.querySelectorAll('.theme-card').length, rows:document.querySelectorAll('.setting-row').length}))()`);
  console.log('DRAWER', JSON.stringify(drawer));
  await shot('f-settings');

  // 点「樱雪」换肤
  await ev(`[...document.querySelectorAll('.theme-card')].find(e=>e.textContent.includes('樱雪'))?.click()`);
  await sleep(1400); await shot('f-sakura');

  // 数据源管理
  await ev(`document.querySelector('.drawer .icon-btn')?.click()`); await sleep(500);
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('数据源管理'))?.click()`);
  await sleep(1800); await shot('f-sources');

  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
