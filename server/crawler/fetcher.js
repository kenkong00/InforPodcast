import iconv from 'iconv-lite';
import { ProxyAgent, Agent, fetch as undiciFetch } from 'undici';
import { getSetting } from '../db.js';

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

export function pickUA(seed = 0) {
  return UA_LIST[seed % UA_LIST.length];
}

/* ---------- 代理支持 ---------- */
let cachedProxy = { url: '', agent: null };
const directAgent = new Agent({ connect: { timeout: 10000 } });

export function proxyInfo() {
  const mode = getSetting('proxy_mode', 'auto'); // auto | on | off
  const url =
    getSetting('proxy_url', '') ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  return { mode, url };
}

function getProxyAgent() {
  const { mode, url } = proxyInfo();
  if (mode === 'off' || !url) return null;
  if (cachedProxy.url !== url) {
    cachedProxy = { url, agent: new ProxyAgent({ uri: url, connect: { timeout: 15000 } }) };
  }
  return cachedProxy.agent;
}

function decodeBuffer(buf, contentType = '') {
  const ct = String(contentType).toLowerCase();
  let enc = null;
  const m = ct.match(/charset=["']?([\w-]+)/);
  if (m) enc = m[1].toLowerCase();
  if (!enc) {
    const head = buf.slice(0, 4096).toString('latin1');
    const mm = head.match(/charset=["']?([\w-]+)/i);
    if (mm) enc = mm[1].toLowerCase();
  }
  if (!enc || enc === 'utf-8' || enc === 'utf8') return buf.toString('utf8');
  try {
    if (iconv.encodingExists(enc)) return iconv.decode(buf, enc);
  } catch { /* ignore */ }
  try {
    return iconv.decode(buf, 'gb18030');
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * 抓取一个 URL，返回 { text, finalUrl, status, contentType, via }
 */
export async function fetchRaw(url, opts = {}) {
  const {
    timeout = 15000,
    headers = {},
    uaSeed = 0,
    useProxy = false,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7'
  } = opts;

  const dispatcher = useProxy ? (getProxyAgent() || directAgent) : directAgent;
  const res = await undiciFetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
    dispatcher,
    headers: {
      'User-Agent': pickUA(uaSeed),
      'Accept': accept,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      ...headers
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  return {
    text: decodeBuffer(buf, contentType),
    finalUrl: res.url || url,
    status: res.status,
    contentType,
    via: useProxy ? 'proxy' : 'direct'
  };
}

/**
 * 抓取（含代理回退）：
 * auto（默认）：先直连，失败后自动走系统代理重试 —— 国内站点直连更快，国外站点自动走代理
 * on ：始终走代理    off：始终直连
 */
export async function fetchWithRetry(url, opts = {}) {
  const { mode } = proxyInfo();
  const agent = mode === 'off' ? null : getProxyAgent();
  const plan = [];
  if (mode === 'on') plan.push(!!agent);
  else {
    plan.push(false);
    if (agent) plan.push(true);
  }

  let lastErr;
  for (let i = 0; i < plan.length; i++) {
    const useProxy = plan[i];
    // 直连阶段给较短超时，失败后快速切代理
    const timeout = (useProxy || plan.length === 1) ? (opts.timeout || 15000) : Math.min(opts.timeout || 15000, 8000);
    try {
      return await fetchRaw(url, { ...opts, timeout, useProxy, uaSeed: i });
    } catch (e) {
      lastErr = e;
      if (i < plan.length - 1) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}
