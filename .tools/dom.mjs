import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9337;
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-dom-'+Date.now());
const proc = spawn(EDGE,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions','--window-size=1440,900','about:blank'],{shell:false,windowsHide:true});
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
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3500);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails)return{__err:r.exceptionDetails.exception?.description||r.exceptionDetails.text};return r.result?.value};
  await ev(`document.documentElement.setAttribute('data-theme','porcelain')`);
  await sleep(600);
  const out = await ev(`(() => {
    const at = (x,y) => { const e = document.elementFromPoint(x,y); return e ? e.tagName+'.'+(e.className||'').toString().slice(0,50) : 'none'; };
    const sd = document.querySelector('.sidenav');
    const cs = getComputedStyle(sd);
    return {
      at200: at(88,200), at400: at(88,400), at600: at(88,600), at700: at(88,700),
      sidenav: { bg: cs.background.slice(0,80), bf: cs.backdropFilter, pos: cs.position, z: cs.zIndex },
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      auroraBg: getComputedStyle(document.querySelector('.aurora')).background.slice(0,60),
      appBg: getComputedStyle(document.querySelector('.app')).background.slice(0,60),
      stageBg: getComputedStyle(document.querySelector('.stage')).backgroundColor,
      stack: (() => { let e = document.elementFromPoint(88,500); const a=[]; while(e && a.length<6){ a.push(e.tagName+'.'+(e.className||'').toString().slice(0,30)); e=e.parentElement; } return a; })()
    };
  })()`);
  console.log(JSON.stringify(out,null,1));
  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
