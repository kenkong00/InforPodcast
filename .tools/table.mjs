import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = 9352;
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-tbl-'+Date.now());
const W = Number(process.argv[2]||1440), H = Number(process.argv[3]||900);
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
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3800);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails){console.log('ERR',r.exceptionDetails.exception?.description?.slice(0,200));return null}return r.result?.value};
  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'},S);fs.writeFileSync(path.join(process.cwd(),'.tools',n+'.png'),Buffer.from(r.data,'base64'));console.log('SHOT',n)};

  console.log(`--- viewport ${W}x${H} ---`);
  // 打开数据源管理
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('数据源管理'))?.click()`);
  await sleep(2200);

  const modal = await ev(`(()=>{
    const m=document.querySelector('.modal');
    if(!m) return {open:false};
    const body=m.querySelector('.modal-body');
    const tbl=m.querySelector('table.tbl');
    return {
      open:true,
      modalW: Math.round(m.getBoundingClientRect().width),
      modalRight: Math.round(m.getBoundingClientRect().right),
      vw: innerWidth,
      bodyOverflowX: body? getComputedStyle(body).overflowX : null,
      bodyScrollW: body? body.scrollWidth : null,
      bodyClientW: body? body.clientWidth : null,
      bodyHScroll: body? body.scrollWidth - body.clientWidth : null,
      tblW: tbl? Math.round(tbl.getBoundingClientRect().width) : null,
      tblScrollW: tbl? tbl.scrollWidth : null
    };
  })()`);
  console.log('MODAL', JSON.stringify(modal));

  const clipped = await ev(`(()=>{
    const out=[];
    document.querySelectorAll('table.tbl th, table.tbl td').forEach(el=>{
      if(el.scrollWidth > el.clientWidth + 1){
        out.push({tag:el.tagName, txt:(el.textContent||'').trim().slice(0,22), cw:el.clientWidth, sw:el.scrollWidth});
      }
    });
    return out;
  })()`);
  console.log('CLIPPED_CELLS', clipped?.length || 0);
  (clipped||[]).slice(0,25).forEach(c=>console.log('  ', JSON.stringify(c)));

  const cols = await ev(`(()=>{
    const ths=[...document.querySelectorAll('table.tbl thead th')];
    return ths.map(th=>({name:(th.textContent||'').trim(), w:Math.round(th.getBoundingClientRect().width), inline:th.style.width||''}));
  })()`);
  console.log('COLUMNS', JSON.stringify(cols));

  const selects = await ev(`(()=>{
    const ss=[...document.querySelectorAll('table.tbl select')];
    return ss.slice(0,6).map(s=>({w:Math.round(s.getBoundingClientRect().width), sw:s.scrollWidth, opts:s.options.length, sel:s.options[s.selectedIndex]?.text||''}));
  })()`);
  console.log('SELECTS', JSON.stringify(selects));

  const overflowPage = await ev(`(()=>{
    const bad=[];
    document.querySelectorAll('body *').forEach(el=>{
      const cs=getComputedStyle(el);
      if((cs.overflowX==='hidden'||cs.overflow==='hidden') && el.scrollWidth>el.clientWidth+4 && el.clientWidth>0){
        bad.push({cls:(el.className&&el.className.toString().slice(0,40))||el.tagName, cw:el.clientWidth, sw:el.scrollWidth});
      }
    });
    return bad.slice(0,10);
  })()`);
  console.log('OVERFLOW_HIDDEN_CLIP', JSON.stringify(overflowPage));

  const docScroll = await ev(`({docScrollW:document.documentElement.scrollWidth, vw:innerWidth})`);
  console.log('PAGE', JSON.stringify(docScroll));

  await shot('tbl-'+W);
  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
