import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9339;
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-batch-'+Date.now());
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
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails){console.log('EV ERR',r.exceptionDetails.exception?.description?.slice(0,150));return null}return r.result?.value};
  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'},S);fs.writeFileSync(path.join(process.cwd(),'.tools',n+'.png'),Buffer.from(r.data,'base64'));console.log('SHOT',n)};

  // 1. 发现页
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现')).click()`);
  await sleep(2800);
  await shot('b-discover');

  // 2. 发现页 · 瓷白
  await ev(`document.documentElement.setAttribute('data-theme','porcelain')`);
  await sleep(1500); await shot('b-discover-light');

  // 3. 播报台 · 午夜
  await ev(`document.documentElement.setAttribute('data-theme','midnight')`);
  await sleep(500);
  await ev(`document.querySelector('.ncard .play-fab').click()`);
  await sleep(11000);
  await shot('b-now');

  // 4. 播报台 · 落日
  await ev(`document.documentElement.setAttribute('data-theme','sunset')`); await sleep(1500); await shot('b-now-sunset');
  // 5. 播报台 · 赛博
  await ev(`document.documentElement.setAttribute('data-theme','cyber')`); await sleep(1500); await shot('b-now-cyber');
  // 6. 播报台 · 深海
  await ev(`document.documentElement.setAttribute('data-theme','ocean')`); await sleep(1500); await shot('b-now-ocean');
  await ev(`document.documentElement.setAttribute('data-theme','midnight')`); await sleep(1500);

  // 7. 全屏字幕
  await ev(`[...document.querySelectorAll('.icon-btn')].find(e=>e.title.includes('全屏字幕'))?.click()`);
  await sleep(1600); await shot('b-zen');
  await ev(`[...document.querySelectorAll('.zen .icon-btn')].find(e=>e.title.includes('退出'))?.click()`);
  await sleep(700);

  // 8. 队列
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('播放队列')).click()`);
  await sleep(1500); await shot('b-queue');

  // 9. 移动端
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},S);
  await sleep(1500);
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('正在播报')).click()`);
  await sleep(1200); await shot('b-m-now');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},S);
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现'))?.click()`);
  await sleep(1600); await shot('b-m-discover');

  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
