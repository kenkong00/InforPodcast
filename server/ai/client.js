/**
 * 统一的大模型调用层
 *
 * 为什么只需要一个适配器：
 * OpenAI 的 POST /chat/completions 已经是事实标准 —— DeepSeek、智谱 GLM、
 * Moonshot(Kimi)、阿里百炼兼容模式、腾讯混元、硅基流动、OpenRouter、
 * 以及本地的 Ollama / LM Studio / vLLM，全都实现了这一套。
 * 所以「本地」和「API 服务商」在代码里没有区别，只是 base_url 指向
 * http://localhost:11434/v1 还是 https://api.deepseek.com/v1。
 *
 * 对外只有两个函数：chat() 拿原文，chatJSON() 拿结构化结果。
 */
import { ProxyAgent, Agent, fetch as undiciFetch } from 'undici';
import { db } from '../db.js';
import { proxyInfo } from '../crawler/fetcher.js';
import { isLocalDemo, localDemoChat } from './localmodel.js';

const JSON_HINT = '严格输出 JSON，不要输出解释文字、不要输出 Markdown 代码块围栏。';

let cachedProxy = { url: '', agent: null };
const directAgent = new Agent({ connect: { timeout: 15000 } });

function getProxyAgent() {
  const { mode, url } = proxyInfo();
  if (mode === 'off' || !url) return null;
  if (cachedProxy.url !== url) {
    cachedProxy = { url, agent: new ProxyAgent({ uri: url, connect: { timeout: 20000 } }) };
  }
  return cachedProxy.agent;
}

/** 不管用户填的是 https://x/v1 还是 https://x/v1/chat/completions，都归一到完整 URL */
export function endpointOf(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少 base_url');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (!/\/v\d+$/i.test(base)) base += '/v1';
  return base + '/chat/completions';
}

function authHeaders(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.api_key) h.Authorization = 'Bearer ' + p.api_key;
  let extra = {};
  try { extra = JSON.parse(p.headers || '{}'); } catch { /* ignore */ }
  return { ...h, ...extra };
}

function pickUsage(u) {
  if (!u) return { prompt: 0, completion: 0 };
  return {
    prompt: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
    completion: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0
  };
}

/**
 * 单次 POST。
 * undici 的 fetch 必须显式传 dispatcher 才走代理，所以这里按 useProxy 二选一。
 */
async function postOnce(url, body, headers, timeoutMs, useProxy) {
  const dispatcher = useProxy ? (getProxyAgent() || directAgent) : directAgent;
  const res = await undiciFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error.code || JSON.stringify(j.error))) || detail;
    } catch { /* 不是 JSON，用原文 */ }
    const err = new Error('HTTP ' + res.status + '：' + detail);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error('响应不是合法 JSON：' + text.slice(0, 200));
  }
  const content =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    json?.content ??
    '';
  return { content: String(content), usage: pickUsage(json.usage), raw: json };
}

/** 直连优先、失败自动切代理 —— 与爬虫保持一致的策略 */
async function postWithFallback(url, body, headers, timeoutMs) {
  const { mode } = proxyInfo();
  const agent = mode === 'off' ? null : getProxyAgent();
  const plan = [];
  if (mode === 'on') plan.push(!!agent);
  else { plan.push(false); if (agent) plan.push(true); }

  let lastErr;
  for (let i = 0; i < plan.length; i++) {
    const useProxy = plan[i];
    try {
      return await postOnce(url, body, headers, timeoutMs, useProxy);
    } catch (e) {
      lastErr = e;
      // 400/401/403 是请求本身的问题，换通道也没用，直接抛
      if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      if (i < plan.length - 1) await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/** 返回给前端用的脱敏视图 */
export function publicView(p) {
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    base_url: p.base_url,
    model: p.model,
    temperature: p.temperature,
    max_tokens: p.max_tokens,
    json_mode: !!p.json_mode,
    headers: p.headers,
    price_in: p.price_in,
    price_out: p.price_out,
    enabled: !!p.enabled,
    is_default: !!p.is_default,
    notes: p.notes,
    has_key: !!p.api_key,
    api_key_masked: maskKey(p.api_key),
    last_ok_at: p.last_ok_at,
    last_error: p.last_error,
    latency_ms: p.latency_ms,
    call_count: p.call_count
  };
}

function logUsage(row) {
  try {
    db.prepare(`
      INSERT INTO llm_usage
        (provider_id, provider_name, model, role, prompt_tokens, completion_tokens, latency_ms, ok, message, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      row.providerId || null, row.providerName || '', row.model || '', row.role || '',
      row.prompt || 0, row.completion || 0, row.latency || 0, row.ok ? 1 : 0,
      String(row.message || '').slice(0, 500), new Date().toISOString()
    );
    db.prepare('UPDATE llm_providers SET call_count = call_count + 1 WHERE id = ?').run(row.providerId || 0);
  } catch { /* 用量记录失败不影响主流程 */ }
}

function touchProvider(id, ok, latency, err) {
  try {
    if (ok) {
      db.prepare('UPDATE llm_providers SET last_ok_at=?, latency_ms=?, last_error=? WHERE id=?')
        .run(new Date().toISOString(), latency, '', id);
    } else {
      db.prepare('UPDATE llm_providers SET last_error=?, latency_ms=? WHERE id=?')
        .run(String(err || '').slice(0, 300), latency, id);
    }
  } catch { /* ignore */ }
}

/**
 * 基础对话。
 * @param {object} p llm_providers 的一行
 * @param {Array<{role:string,content:string}>} messages
 * @param {{role?:string, timeoutMs?:number, temperature?:number, maxTokens?:number, json?:boolean, retries?:number}} opts
 */
export async function chat(p, messages, opts = {}) {
  if (!p) throw new Error('未选择大模型方案');

  /* 内置演示模型：不发网络请求，直接在本地从候选原文里抽取组装。
     没有 key 的时候也能把整条流水线跑通看效果。 */
  if (isLocalDemo(p)) {
    const t0 = Date.now();
    const sys = messages.find(m => m.role === 'system')?.content || '';
    const user = messages.find(m => m.role === 'user')?.content || '';
    const r = localDemoChat(sys, user);
    const ms = Date.now() - t0;
    logUsage({
      providerId: p.id, providerName: p.name, model: p.model, role: opts.role || '',
      prompt: r.usage.prompt, completion: r.usage.completion, latency: ms, ok: true
    });
    touchProvider(p.id, true, ms, '');
    return { content: r.content, usage: r.usage, latencyMs: ms, provider: p };
  }

  const url = endpointOf(p.base_url);
  if (!p.model) throw new Error('方案「' + p.name + '」没有填模型名');
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const retries = Number.isFinite(opts.retries) ? opts.retries : 1;

  const baseBody = {
    model: p.model,
    messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : (Number(p.temperature) || 0.3),
    max_tokens: Number(opts.maxTokens) || Number(p.max_tokens) || 4096,
    stream: false
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const body = { ...baseBody };
    // 想要 JSON 就先礼貌地请求 json_object；网关不支持会在 400 里说，届时自动降级
    if (opts.json || p.json_mode) body.response_format = { type: 'json_object' };
    const t0 = Date.now();
    try {
      const r = await postWithFallback(url, body, authHeaders(p), timeoutMs);
      logUsage({
        providerId: p.id, providerName: p.name, model: p.model, role: opts.role || '',
        prompt: r.usage.prompt, completion: r.usage.completion, latency: Date.now() - t0, ok: true
      });
      touchProvider(p.id, true, Date.now() - t0, '');
      return { content: r.content, usage: r.usage, latencyMs: Date.now() - t0, provider: p };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const hatesJson = /response_format|json_object|json schema|Unsupported/i.test(msg);
      const shouldDropJson = hatesJson && (opts.json || p.json_mode);
      logUsage({
        providerId: p.id, providerName: p.name, model: p.model, role: opts.role || '',
        latency: Date.now() - t0, ok: false, message: msg
      });
      touchProvider(p.id, false, Date.now() - t0, msg);
      if (shouldDropJson) {
        // 去掉 response_format 再试一轮，靠提示词约束 + 本地容错解析
        p = { ...p, json_mode: 0 };
        continue;
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error('调用大模型失败：' + String(lastErr?.message || lastErr));
}

/* ---------------- JSON 容错解析 ---------------- */

function stripFences(s) {
  let out = String(s || '').trim();
  const fence = out.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return out;
}

/** 从任意文本里捞出第一个完整的 {...} 或 [...] 块 */
function extractBalance(s, open, close) {
  const start = s.indexOf(open);
  if (start < 0) return '';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return '';
}

function repair(s) {
  return String(s || '')
    .replace(/,\s*([}\]])/g, '$1')            // 去掉尾逗号
    .replace(/[\u201c\u201d]/g, '"')           // 中文引号
    .replace(/\/\/[^\n"]*/g, '')               // 行注释
    .replace(/[\x00-\x08\x0b-\x1f]/g, ' ');    // 控制字符
}

/**
 * 尽力从大模型输出里解析出 JSON。大模型爱在 JSON 外面套话、爱加代码块围栏、
 * 偶尔还吐半个 JSON —— 这里逐级兜底，实在不行才报错。
 */
export function parseJSONLoose(raw, wantArray = false) {
  const attempts = [];
  const clean = stripFences(raw);
  attempts.push(clean);
  const obj = extractBalance(clean, '{', '}');
  const arr = extractBalance(clean, '[', ']');
  if (wantArray && arr) attempts.unshift(arr);
  if (!wantArray && obj) attempts.unshift(obj);
  attempts.push(repair(obj || clean));
  attempts.push(repair(arr || clean));

  for (const a of attempts) {
    if (!a) continue;
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object') return v;
    } catch { /* 换下一种 */ }
  }
  throw new Error('大模型没有返回可解析的 JSON（前 160 字）：' + String(raw).slice(0, 160));
}

/**
 * 对话 + 强制拿 JSON 对象。
 * 即使模型不支持 json_object，也会靠提示词约束 + parseJSONLoose 兜住。
 */
export async function chatJSON(p, system, user, opts = {}) {
  const sys = String(system || '') + '\n\n' + JSON_HINT;
  let hintRetried = false;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    const r = await chat(p, [
      { role: 'system', content: sys },
      { role: 'user', content: String(user || '') }
    ], { json: true, ...opts, temperature: i === 0 ? (opts.temperature ?? 0.2) : 0 });
    try {
      const data = parseJSONLoose(r.content, !!opts.wantArray);
      return { data, raw: r.content, usage: r.usage, latencyMs: r.latencyMs, provider: r.provider };
    } catch (e) {
      lastErr = e;
      if (!hintRetried) { hintRetried = true; continue; }
    }
  }
  throw lastErr || new Error('JSON 解析失败');
}

/** 连接测试：只问一句最短的话，验证 key / 地址 / 模型三者都对得上 */
export async function testProvider(p) {
  // 内置演示模型不走网络，直接判可用
  if (isLocalDemo(p)) {
    return { ok: true, latencyMs: 0, reply: '内置演示模型可用（离线抽取生成，不联网）', model: p.model, usage: { prompt: 0, completion: 0 } };
  }
  const t0 = Date.now();
  try {
    const r = await chat(p, [{ role: 'user', content: '回复两个字：可用' }], {
      role: 'test', timeoutMs: 30000, maxTokens: 32, retries: 0, temperature: 0
    });
    return {
      ok: true, latencyMs: Date.now() - t0, reply: r.content.slice(0, 80),
      model: p.model, usage: r.usage
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, message: String(e.message || e), model: p.model };
  }
}
