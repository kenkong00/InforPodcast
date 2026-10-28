/**
 * 页面自查：无头 Edge + CDP
 * 用法: node .tools/probe.mjs [url] [outPrefix]
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const URL = process.argv[2] || 'http://localhost:5199/';
const OUT = process.argv[3] || 'shot';
const PORT = 9333;

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

if (!EDGE) { console.error('NO_EDGE'); process.exit(1); }

const profile = path.join(os.tmpdir(), 'wavecast-probe-' + Date.now());
const args = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1440,900',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank'
];
const proc = spawn(EDGE, args, { shell: false, windowsHide: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('CDP 未就绪');
}

function makeClient(ws) {
  return new Promise((resolve, reject) => {
    const c = new WebSocket(ws);
    let id = 0;
    const pending = new Map();
    const events = [];
    c.onopen = () => resolve({
      send(method, params = {}, sessionId = null) {
        const mid = ++id;
        const msg = { id: mid, method, params };
        if (sessionId) msg.sessionId = sessionId;
        c.send(JSON.stringify(msg));
        return new Promise((res, rej) => pending.set(mid, { res, rej }));
      },
      events,
      close: () => c.close()
    });
    c.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method) {
        events.push(m);
      }
    };
    c.onerror = e => reject(new Error('WS error ' + (e.message || '')));
  });
}

(async () => {
  const wsUrl = await getWs();
  const c = await makeClient(wsUrl);
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });

  const raw = c.send;

  await raw('Runtime.enable', {}, sessionId);
  await raw('Page.enable', {}, sessionId);

  const errors = [];
  const waitFor = async (fn, ms = 15000, label = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(300);
    }
    console.log('TIMEOUT: ' + label);
    return false;
  };

  await raw('Page.navigate', { url: URL }, sessionId);
  await sleep(4000);

  // 抓 console 错误
  const evErrors = c.events.filter(e => e.method === 'Runtime.exceptionThrown' && e.sessionId === sessionId);
  for (const e of evErrors) errors.push(JSON.stringify(e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || ''));

  const evalJs = async (expr) => {
    const r = await raw('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };

  await waitFor(async () => (await evalJs('!!document.querySelector(".app")')), 15000, 'app mounted');

  const report = await evalJs(`(() => {
    const q = s => document.querySelector(s);
    const qa = s => [...document.querySelectorAll(s)];
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      app: box(q('.app')),
      topbar: box(q('.topbar')),
      sidenav: box(q('.sidenav')),
      stage: box(q('.stage')),
      dock: box(q('.dock')),
      vinyl: box(q('.vinyl')),
      navItems: qa('.nav-item').length,
      emptyTitle: q('.empty .big')?.textContent || '',
      docHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      overflowHidden: qa('*').filter(el => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 0;
      }).slice(0, 8).map(el => ({
        tag: el.tagName, cls: (el.className || '').toString().slice(0, 40),
        ch: el.clientHeight, sh: el.scrollHeight
      }))
    };
  })()`);

  console.log('=== REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) { console.log('=== JS ERRORS ==='); errors.forEach(e => console.log(e.slice(0, 300))); }

  // 截图
  const shot = async (name) => {
    const r = await raw('Page.captureScreenshot', { format: 'png' }, sessionId);
    const f = path.join(process.cwd(), '.tools', name + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('SHOT -> ' + f);
  };
  await shot(OUT);

  c.close();
  proc.kill();
  setTimeout(() => process.exit(0), 400);
})().catch(e => {
  console.error('PROBE FAILED:', e.message);
  try { proc.kill(); } catch { /* ignore */ }
  process.exit(1);
});
