import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9335;
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-p2-'+Date.now());
const proc = spawn(EDGE,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions','--window-size=1440,900','--autoplay-policy=no-user-gesture-required','--mute-audio','about:blank'],{shell:false,windowsHide:true});
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let ws; for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){ws=(await r.json()).webSocketDebuggerUrl;break}}catch{}await sleep(300)}
  const sock=new WebSocket(ws); let id=0; const pend=new Map();
  await new Promise((res,rej)=>{sock.onopen=res;sock.onerror=rej});
  sock.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result)}};
  const send=(method,params={},sid=null)=>{const mid=++id;const msg={id:mid,method,params};if(sid)msg.sessionId=sid;sock.send(JSON.stringify(msg));return new Promise((res,rej)=>pend.set(mid,{res,rej}))};
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId:S}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},S); await send('Page.enable',{},S);
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3500);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails)return{__err:r.exceptionDetails.exception?.description||r.exceptionDetails.text};return r.result?.value};
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现')).click()`);
  await sleep(2500);
  await ev(`document.querySelector('.ncard .play-fab').click()`);
  for (const t of [2000,3000,4000,5000]) {
    await sleep(t===2000?2000:3000);
    const st = await ev(`JSON.stringify(window.__wavecast?.state)`);
    const pl = await ev(`window.__wavecast?.player.playing`);
    const ci = await ev(`window.__wavecast?.player.cueIdx`);
    const cd = await ev(`window.__wavecast?.player.queue[window.__wavecast.player.idx]?.cues[window.__wavecast.player.cueIdx]?.dur`);
    const ct = await ev(`({ce: window.__wavecast?.player.cueElapsed, bo: window.__wavecast?.player.buffering, msg: window.__wavecast?.player.message})`);
    console.log('t+', t, 'playing=',pl,'cueIdx=',ci,'cueDur=',cd);
    console.log('   audio', st);
    console.log('   ', JSON.stringify(ct));
  }
  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
