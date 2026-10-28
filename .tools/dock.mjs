import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9340;
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-dk-'+Date.now());
const proc = spawn(EDGE,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions','--window-size=390,844','about:blank'],{shell:false,windowsHide:true});
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
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},S);
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3600);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails)return{__err:r.exceptionDetails.exception?.description?.slice(0,200)||r.exceptionDetails.text};return r.result?.value};
  const out = await ev(`(() => {
    const d = document.querySelector('.dock');
    const cs = getComputedStyle(d);
    const kid = el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { cls: el.className.slice(0,20), area: c.gridArea, row: c.gridRow, col: c.gridColumn, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      display: cs.display,
      cols: cs.gridTemplateColumns,
      areas: cs.gridTemplateAreas,
      rows: cs.gridTemplateRows,
      h: Math.round(d.getBoundingClientRect().height),
      vw: window.innerWidth,
      matches720: window.matchMedia('(max-width:720px)').matches,
      kids: [...d.children].map(kid)
    };
  })()`);
  console.log(JSON.stringify(out,null,1));
  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
