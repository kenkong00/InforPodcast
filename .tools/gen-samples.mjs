/**
 * 用「数据驱动的本地演示模型」把真实流水线跑一遍，产出两期节目（精选轮播 + 双人对话）。
 *
 * 这个假模型不是返回占位文字，而是解析流水线喂给它的真实候选清单
 *（与你库里 1133 条同源），按系统提示词的规则（口语化、先结论后细节、数字转中文、
 * 双人 host/guest 严格交替、丢掉非中文/超短的低价值条目）合成稿件。
 * 你看到的 = 真实数据 + 真实流水线的提示词规则。写成的是"及格线"文案，
 * 真实云端模型接入后会更流畅 —— 但去重、打分筛选、格式全部一致。
 * 写好的两期会留在 AI精选 历史里，可直接播放。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { db } from '../server/db.js';
import { startDigest, getDigestPublic } from '../server/ai/pipeline.js';

const PORT = 9351;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(process.cwd(), '.samples');
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 中文数字（处理百分比，让朗读自然） ---------------- */
const D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function intToCN(n) {
  if (n === 0) return '零';
  if (n < 10) return D[n];
  if (n < 20) return '十' + (n % 10 ? D[n % 10] : '');
  if (n < 100) return D[Math.floor(n / 10)] + '十' + (n % 10 ? D[n % 10] : '');
  if (n < 1000) return D[Math.floor(n / 100)] + '百' + (n % 100 ? intToCN(n % 100) : '');
  return String(n);
}
function toCN(num) {
  const neg = num < 0; num = Math.abs(num);
  const [ip, dp] = String(num).split('.');
  let r = intToCN(Number(ip));
  if (dp) r += '点' + dp.split('').map(d => D[Number(d)] || d).join('');
  return (neg ? '负' : '') + r;
}

const CJK = /[一-鿿]/;
const hasCJK = s => CJK.test(s || '');

/* ---------------- 把文本处理成「能直接念」的口语 ---------------- */
function spoken(s) {
  return String(s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)%/g,
      (m, a, b) => '百分之' + toCN(Number(a)) + '至百分之' + toCN(Number(b)))
    .replace(/(\d+(?:\.\d+)?)%/g, (m, p) => '百分之' + toCN(Number(p)))
    .replace(/[（(][^）)]*[）)]/g, '，')        // 去括号，改成停顿
    .replace(/[【】\[\]*_`#~>|]/g, ' ')
    .replace(/\.{3,}|…+/g, '')                  // 去掉省略号
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+[，。]\s*/g, '，')
    .trim();
}

/* 把候选摘要洗成「一句干净、不截断、不重复标题」的口播正文 */
function cleanSummary(raw, title) {
  let s = String(raw || '');
  // 去掉导语噪音（开头或句中都可能有「IT之家在现场获悉」）
  s = s.replace(/IT之家[^\n，。]*?(?:消息|获悉)[，。]?/g, '');
  s = s.replace(/^(据[^\n，。]*?报道[，。]?\s*|IT之家附[^\n，。]*?[。]?\s*)/, '');
  s = spoken(s);
  // 切到第一个完整句子；没有句号就用逗号断，避免一整段复述标题
  const dot = s.indexOf('。');
  const comma = s.indexOf('，');
  let cut = -1;
  if (dot > 6 && dot <= 46) cut = dot;
  else if (comma > 6 && comma < dot) cut = comma;
  else if (dot > 6) cut = dot;
  else if (s.length > 40) cut = 40;
  if (cut > 6) s = s.slice(0, cut + 1);
  // 去掉和标题重复的开头或结尾，避免「标题念两遍」
  const t = spoken(title || '');
  if (t) {
    if (s.startsWith(t)) s = s.slice(t.length).replace(/^[，。\s]+/, '');
    if (s.endsWith(t)) s = s.slice(0, s.length - t.length).replace(/[，。\s]+$/, '');
  }
  return s.trim();
}

/* ---------------- 解析流水线喂进来的候选清单 ---------------- */
function parseCandidates(user) {
  const out = [];
  for (const line of String(user).split('\n')) {
    const m = line.match(/^#(\d+)\s*\|/);
    if (!m) continue;
    const idx = Number(m[1]);
    const segs = line.slice(m[0].length).split(' | ');
    let site = '', title = '', summary = '', hot = '';
    for (const s of segs) {
      if (s.startsWith('标题：')) title = s.slice(3).trim();
      else if (s.startsWith('摘要：')) summary = s.slice(3).trim();
      else if (s.startsWith('来源')) site = s.replace(/^来源\d*家?：/, '').trim();
      else if (s.startsWith('热度：')) hot = s.slice(3).trim();
    }
    if (title) out.push({ idx, site, title, summary, hot });
  }
  return out;
}
function numOf(user, re, fb) { const m = String(user).match(re); return m ? Number(m[1]) : fb; }

/* ---------------- 假模型：按提示词规则合成（及格线文案） ---------------- */
function synthesize(sys, user) {
  const cands = parseCandidates(user);

  if (sys.includes('打分')) {
    // 模拟一个合格的评分器：非中文 / 摘要过短 的条目标为低价值并淘汰
    const results = cands.map(c => {
      const noCN = !hasCJK(c.title) && !hasCJK(c.summary);
      const thin = spoken(c.summary).length < 16;
      const weak = noCN || thin;
      return {
        i: c.idx,
        score: weak ? 3 : 8,
        keep: !weak,
        reason: noCN ? '非中文/价值低' : (thin ? '内容偏空' : '有实质信息')
      };
    });
    return JSON.stringify({ results });
  }

  if (sys.includes('两人对话')) {
    const topicCount = Math.min(6, numOf(user, /覆盖\s*(\d+)\s*个话题/, 5));
    const topics = cands.filter(t => hasCJK(t.title)).slice(0, topicCount);
    const turns = [];
    const push = (spk, text) => { const t = spoken(text); if (t) turns.push({ speaker: spk, text: t }); };
    const intros = ['先聊一个，', '接着看，', '再说一个，', '还有一个，', '顺便聊聊，', '最后看，'];
    const qs = [
      '这事儿背后，你觉得关键看点是什么？',
      '那它跟咱们普通人有什么关系？',
      '所以这个节点，算不算个拐点？',
      '要是你，会怎么看这件事？',
      '它会不会只是短期热点？',
      '普通人现在该关注点啥？'
    ];
    const opinions = [
      '我的看法是，短期看情绪，长期还是看落地。',
      '说白了，它更像是个信号，别被标题带节奏。',
      '对普通人来说，先把信息看全，再判断跟自己有没有关系。',
      '关键不在这一件事，而在它背后那股趋势。',
      '现在下结论还早，但这事值得多留个心眼。',
      '它的意义更多是方向性的，不用急着站队。'
    ];
    const follows = [
      '尤其是别只看一个数字就下结论。',
      '当然，落地还要看后续的执行。',
      '不过也别高估它短期的影响力。',
      '时间会替我们筛掉噪音。',
      '真要动手，也得等更多信息。',
      '这一步走得稳不稳，还得再看。'
    ];
    push('host', `今天我们先聊几个刚冒头的话题。`);
    topics.forEach((t, i) => {
      const title = spoken(t.title);
      const fact = cleanSummary(t.summary, t.title) || '目前公开信息还不多，先做个初步判断。';
      push('host', `${intros[i % intros.length]}${title}。`);
      push('guest', fact);
      push('guest', opinions[i % opinions.length]);
      push('host', qs[i % qs.length]);
      push('guest', follows[i % follows.length]);
    });
    push('host', `好，今天就先聊到这几个。信息很多，关键是自己有判断力。`);
    return JSON.stringify({
      title: `对谈 · ${topics[0]?.site || '今日'}等 ${topics.length} 个话题`,
      lead: `大家好，欢迎收听今天的对谈节目，我是主播。`,
      outro: `今天就聊到这里，我们下期再会。`,
      turns
    });
  }

  // 精选轮播：标题单独成句，script 是一句干净的口播（不重复标题 / 不截断 / 无导语噪音）
  const topN = Math.min(12, numOf(user, /最值得播报的\s*(\d+)\s*条/, 10));
  const seen = new Set();
  const items = [];
  for (const c of cands.slice(0, topN * 6)) {
    if (!hasCJK(c.title)) continue;                       // 非中文趋势榜等直接跳过
    const body = cleanSummary(c.summary, c.title);
    if (!body) continue;
    const key = spoken(c.title).slice(0, 8);               // 同一件事多源已在前端去重，这里按标题防串
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.length >= topN) break;
    items.push({
      ids: [c.idx],
      title: spoken(c.title),
      category: '',
      summary: body.slice(0, 30),
      script: body,
      importance: 10 - items.length
    });
  }
  return JSON.stringify({
    title: `今日精选 ${items.length} 条`,
    lead: `欢迎收听本期精选，今天给你梳理了 ${items.length} 件最值得关注的事。`,
    outro: `以上就是本期全部内容，希望这些信息对你有用，我们下期再见。`,
    items
  });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const msgs = payload.messages || [];
    const sys = msgs.find(m => m.role === 'system')?.content || '';
    const user = msgs.find(m => m.role === 'user')?.content || '';
    const content = synthesize(sys, user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: Math.round(body.length / 2), completion_tokens: Math.round(content.length / 2) }
    }));
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
console.log(`本地演示模型已启动：http://127.0.0.1:${PORT}`);

db.prepare('DELETE FROM llm_providers WHERE base_url LIKE ?').run('%127.0.0.1:9351%');
const info = db.prepare(`
  INSERT INTO llm_providers
    (name, protocol, base_url, api_key, model, temperature, max_tokens, json_mode,
     headers, price_in, price_out, enabled, is_default, notes, created_at)
  VALUES (?, 'openai', ?, 'demo', 'local-demo', 0.3, 4096, 1, '{}', 0, 0, 1, 0, '本地演示模型（无需 key）', ?)
`).run('本地演示模型(临时)', `http://127.0.0.1:${PORT}/v1`, new Date().toISOString());
const PID = info.lastInsertRowid;
console.log('已登记演示方案 id =', PID);

async function runOnce(kind, topN) {
  console.log(`\n=========== ${kind === 'dialogue' ? '双人对话' : '精选轮播'} ===========`);
  const { id } = startDigest({
    kind, topN, minScore: 6,
    writeProviderId: PID, scoreProviderId: PID,
    scope: { hours: 0 },
    filter: { minBodyChars: 80 }
  });
  console.log('任务 id =', id);
  let row;
  for (let i = 0; i < 250; i++) {
    row = db.prepare('SELECT status, progress, stage, stage_msg FROM digests WHERE id=?').get(id);
    if (row && (row.status === 'done' || row.status === 'failed')) break;
    await sleep(300);
  }
  const d = getDigestPublic(id);
  if (d.status !== 'done') { console.log('  ❌ 失败：', d.error); return null; }
  const s = d.script;
  console.log('  ✅ 成功  ·  标题：', s.title);
  console.log('  ·', `${d.input_count} 条原始 → ${d.cluster_count} 簇 → 留 ${d.keep_count} → 写 ${s.items.length} 条 / ${s.cues.length} 句`);
  console.log('  · token 入', d.tokens_in, '/ 出', d.tokens_out, '· 模型耗时', d.duration_ms, 'ms');
  return d;
}

function dumpTxt(d, file) {
  const s = d.script;
  const L = [];
  L.push('# ' + s.title);
  L.push('> ' + (s.subtitle || '') + '（本地演示模型生成，接入真实 key 后措辞更自然）');
  L.push('');
  for (const c of s.cues) {
    const who = c.speakerLabel ? c.speakerLabel + '：' : '';
    L.push(who + c.text);
  }
  L.push('');
  L.push('---');
  L.push(`原始 ${d.input_count} 条 → 去重成 ${d.cluster_count} 簇 → 留 ${d.keep_count} 条`);
  L.push(`token 入 ${d.tokens_in} / 出 ${d.tokens_out} · 模型耗时 ${d.duration_ms}ms`);
  fs.writeFileSync(path.join(OUT, file), L.join('\n'), 'utf8');
  console.log('  📄 已导出', file);
}

const a = await runOnce('newsreel', 12);
const b = await runOnce('dialogue', 12);
if (a) dumpTxt(a, '精选轮播示例.txt');
if (b) dumpTxt(b, '双人对话示例.txt');

db.prepare('DELETE FROM llm_providers WHERE id=?').run(PID);
console.log('\n演示方案已清理（两期节目保留在 AI精选 历史中，可直接播放）');

server.close();
process.exit(0);
