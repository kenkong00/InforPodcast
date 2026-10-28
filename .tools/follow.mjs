/**
 * 验证歌词「跟着语音走」：
 *  1) 滚动条是否长在 .lyric-scroll 自己身上（而不是 .np 在滚）
 *  2) 当前句是否落在容器正中
 *  3) 用户滚过之后要「让位」，让位结束要恢复跟随
 *
 * 不依赖真实语音推进 —— 直接改 __wavecast.player.cueIdx 模拟「念到下一句」，
 * 这样 headless 环境下 TTS 不可用也能测出滚动逻辑。
 */
import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const PORT = Number(process.argv[4] || 9361);
const EDGE = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const profile = path.join(os.tmpdir(),'wc-fol-'+Date.now());
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
  const errs=[]; await send('Log.enable',{},S);
  sock.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.method==='Log.entryAdded'&&m.params?.entry?.level==='error')errs.push(m.params.entry.text.slice(0,120))}catch{}});
  await send('Page.navigate',{url:'http://localhost:5199/'},S); await sleep(3800);
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true},S);if(r.exceptionDetails){console.log('ERR',r.exceptionDetails.exception?.description?.slice(0,200));return null}return r.result?.value};
  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'},S);fs.writeFileSync(path.join(process.cwd(),'.tools',n+'.png'),Buffer.from(r.data,'base64'));console.log('SHOT',n)};

  const PROBE = `(()=>{
    const box=document.querySelector('.lyric-scroll');
    if(!box) return {err:'no .lyric-scroll'};
    const np=document.querySelector('.np');
    const right=document.querySelector('.np-right');
    const lines=[...box.querySelectorAll('.lyric-line')];
    const act=box.querySelector('.lyric-line.active');
    const br=box.getBoundingClientRect();
    const ar=act?act.getBoundingClientRect():null;
    const cs=getComputedStyle(box);
    return {
      cueIdx: window.__wavecast ? window.__wavecast.player.cueIdx : null,
      totalCues: lines.length,
      activeLine: act?act.textContent.slice(0,16):null,
      /* 关键 1：歌词容器自己能不能滚 */
      boxClientH: box.clientHeight,
      boxScrollH: box.scrollHeight,
      boxDelta: box.scrollHeight - box.clientHeight,
      boxScrollTop: Math.round(box.scrollTop),
      boxPadTop: cs.paddingTop,
      boxPadBottom: cs.paddingBottom,
      spacerH: getComputedStyle(box,'::before').height,
      /* 关键 2：外层不能再滚，否则说明布局又退回去了 */
      npOverflowY: getComputedStyle(np).overflowY,
      npDelta: np.scrollHeight - np.clientHeight,
      npAlign: getComputedStyle(np).alignItems,
      /* 关键 3：当前句离容器中心多远（0 = 正中） */
      boxH: Math.round(br.height),
      activeOffCenter: ar ? Math.round((ar.top+ar.height/2)-(br.top+br.height/2)) : null,
      activeVisible: ar ? (ar.bottom>br.top+4 && ar.top<br.bottom-4) : null,
      rightH: Math.round(right.getBoundingClientRect().height)
    };
  })()`;

  // 进入发现页 → 打开阅读器 → 点「播报本篇」，让曲目与 cues 就位
  await ev(`[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('发现'))?.click()`);
  await sleep(2600);
  await ev(`document.querySelectorAll('.ncard')[0]?.click()`);
  await sleep(4500);
  await ev(`[...document.querySelectorAll('.reader-tools .btn')].find(b=>b.textContent.includes('播报本篇'))?.click()`);
  await sleep(6500);
  // 关掉阅读器，免得遮住歌词
  await ev(`document.querySelector('.modal .icon-btn')?.click()`);
  await sleep(900);

  const has = await ev(`!!document.querySelector('.lyric-scroll .lyric-line')`);
  console.log('CUES READY', has);
  console.log('P0 初始      ', JSON.stringify(await ev(PROBE)));
  await shot('fol-0-init');

  // —— 程序自动推进：应当跟随并居中 ——
  await ev(`window.__wavecast.player.cueIdx = 6`);
  await sleep(1300);
  console.log('P1 跳到第7句 ', JSON.stringify(await ev(PROBE)));
  await shot('fol-1-follow');

  await ev(`window.__wavecast.player.cueIdx = 14`);
  await sleep(1300);
  console.log('P2 跳到第15句', JSON.stringify(await ev(PROBE)));

  // —— 用户滚了一下：应当「让位」，不抢滚动条 ——
  const userScroll = await ev(`(()=>{
    const box=document.querySelector('.lyric-scroll');
    box.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));
    const before=Math.round(box.scrollTop);
    window.__wavecast.player.cueIdx = 20;
    return {before};
  })()`);
  await sleep(1300);
  const afterLock = await ev(PROBE);
  console.log('P3 用户滚后  ', JSON.stringify({ ...afterLock, expect:'不跟随（activeOffCenter 应明显偏离 0）' }));
  await shot('fol-2-userlock');

  // —— 让位窗口过后：应当恢复跟随 ——
  await sleep(2900);
  await ev(`window.__wavecast.player.cueIdx = 10`);
  await sleep(1400);
  console.log('P4 让位结束  ', JSON.stringify(await ev(PROBE)));
  await shot('fol-3-resume');

  // —— 点某一句：立即恢复跟随 ——
  await ev(`document.querySelectorAll('.lyric-scroll .lyric-line')[2]?.click()`);
  await sleep(1300);
  console.log('P5 点第3句   ', JSON.stringify(await ev(PROBE)));

  // —— 最后一句也要能居中（不是被底部截断）——
  await ev(`(function(){const n=document.querySelectorAll('.lyric-scroll .lyric-line').length;window.__wavecast.player.cueIdx=n-1;})()`);
  await sleep(1400);
  console.log('P6 最后一句  ', JSON.stringify(await ev(PROBE)));
  await shot('fol-4-last');

  // —— 全屏字幕同样验证 ——
  await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.includes('全屏字幕'))?.click()`);
  await sleep(1500);
  await ev(`window.__wavecast.player.cueIdx = 8`);
  await sleep(1400);
  const zen = await ev(`(()=>{
    const box=document.querySelector('.zen-lyric');
    if(!box) return {err:'no .zen-lyric'};
    const act=box.querySelector('.lyric-line.active');
    const br=box.getBoundingClientRect(), ar=act?act.getBoundingClientRect():null;
    return {clientH:box.clientHeight, scrollH:box.scrollHeight, delta:box.scrollHeight-box.clientHeight,
            scrollTop:Math.round(box.scrollTop), padTop:getComputedStyle(box).paddingTop,
            spacer:getComputedStyle(box,'::before').height,
            activeOffCenter: ar?Math.round((ar.top+ar.height/2)-(br.top+br.height/2)):null};
  })()`);
  console.log('P7 全屏字幕  ', JSON.stringify(zen));
  await shot('fol-5-zen');

  console.log('JS_ERRORS', errs.length, errs.slice(0,4).join(' | '));
  proc.kill(); setTimeout(()=>process.exit(0),300);
})().catch(e=>{console.error('FAIL',e.message);try{proc.kill()}catch{};process.exit(1)});
