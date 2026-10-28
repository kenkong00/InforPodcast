import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9336;
const W = Number(process.env.W || 1440), H = Number(process.env.H || 900);
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-th-'+Date.now());
const proc = spawn(EDGE,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions',`--window-size=${W},${H}`,'--autoplay-policy=no-user-gesture-required','--mute-audio','about:blank'],{shell:false,windowsHide:true});
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
  await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:W<600},S);
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3500);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails)return{__err:r.exceptionDetails.exception?.description||r.exceptionDetails.text};return r.result?.value};
  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'},S);fs.writeFileSync(path.join(process.cwd(),'.tools',n+'.png'),Buffer.from(r.data,'base64'));console.log('SHOT',n)};

  const theme = process.env.THEME;
  const view = process.env.VIEW || 'discover';

  if (view==='discover') { await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现')).click()`); await sleep(2600); }
  if (process.env.PLAY==='1') { await ev(`document.querySelector('.ncard .play-fab')?.click()`); await sleep(7000); }
  if (theme) { await ev(`document.documentElement.setAttribute('data-theme','${theme}')`); await sleep(700); }
  await shot(process.env.OUT || (theme || view));

  if (process.env.ALLTHEMES==='1') {
    for (const t of ['aurora','sunset','cyber','ocean','mocha','porcelain','sakura']) {
      await ev(`document.documentElement.setAttribute('data-theme','${t}')`);
      await sleep(600);
      await shot('theme-'+t);
    }
  }
  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
