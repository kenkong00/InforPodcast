/**
 * 端到端验证：用一个「假 OpenAI 服务」冒充大模型，把整条流水线真跑一遍。
 *
 * 为什么这么做：没有真 API key 的情况下，光看代码过不了心。
 * 假服务故意把精选轮播的返回裹在 ```json 代码块里（大模型经常这么干），
 * 顺手验证 parseJSONLoose 的容错真的管用。
 */
import http from 'http';
import { db } from '../server/db.js';
import { startDigest, getDigestPublic } from '../server/ai/pipeline.js';

const PORT = 9345;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function countOf(user) {
  const m = String(user).match(/(\d+)\s*条/);
  return m ? Number(m[1]) : 5;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const sys = (payload.messages || []).find(m => m.role === 'system')?.content || '';
    const user = (payload.messages || []).find(m => m.role === 'user')?.content || '';
    const n = countOf(user);

    let content;
    if (sys.includes('打分')) {
      content = JSON.stringify({
        results: Array.from({ length: n }, (_, i) => ({
          i: i + 1, score: i % 7 === 0 ? 3 : 8, keep: i % 7 !== 0, reason: '这条有实质内容'
        }))
      });
    } else if (sys.includes('两人对话')) {
      const turns = [];
      const push = (spk, t) => turns.push({ speaker: spk, text: t });
      push('host', '先说今天最热的一件事，某厂商又发布了新芯片，你怎么看？');
      push('guest', '我觉得关键不在参数，而在供货，产能上不去价格就下不来。');
      push('host', '那对普通用户来说，现在换机合适吗？');
      push('guest', '不着急，等到双十一大概率会有一轮降价。');
      content = JSON.stringify({
        title: '今日科技对谈',
        lead: '大家好，今天我们来聊聊最近密集发布的新品。',
        outro: '今天就聊到这儿，祝大家理性消费。',
        turns
      });
    } else {
      const items = Array.from({ length: Math.min(6, n) }, (_, i) => ({
        ids: [i + 1],
        title: `第 ${i + 1} 条融合后的事件标题`,
        category: '科技',
        summary: '一句话说清这件事的影响。',
        script: `这是第 ${i + 1} 条的口语播报稿，先说结论。再补一个关键细节，让听众知道和自己有什么关系。`,
        importance: 9 - i
      }));
      // 故意套代码块围栏 —— 验证 JSON 容错解析
      content = '好的，这是本期稿件：\n```json\n' + JSON.stringify({
        title: '今日精选十二条',
        lead: '欢迎收听本期精选。',
        outro: '以上就是本期内容。',
        items
      }) + '\n```\n';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: body.length, completion_tokens: content.length }
    }));
  });
});

await new Promise(r => server.listen(PORT, '127.0.0.1', r));
console.log(`假大模型服务已启动：http://127.0.0.1:${PORT}/v1`);

// 把假服务登记成一个 provider，并设为默认
db.prepare('DELETE FROM llm_providers WHERE base_url LIKE ?').run('%127.0.0.1:9345%');
const info = db.prepare(`
  INSERT INTO llm_providers
    (name, protocol, base_url, api_key, model, temperature, max_tokens, json_mode,
     headers, price_in, price_out, enabled, is_default, notes, created_at)
  VALUES (?, 'openai', ?, 'test-key', 'mock-model', 0.3, 4096, 1, '{}', 0, 0, 1, 1, '', ?)
`).run('测试用假模型', `http://127.0.0.1:${PORT}/v1`, new Date().toISOString());
console.log('已登记 provider id =', info.lastInsertRowid);

async function runOnce(kind) {
  console.log(`\n=========== ${kind === 'dialogue' ? '双人对话' : '精选轮播'} ===========`);
  const { id } = startDigest({
    kind, topN: 12, minScore: 6,
    writeProviderId: info.lastInsertRowid,
    scoreProviderId: info.lastInsertRowid,
    scope: { hours: 0 },
    filter: { minBodyChars: 80 }
  });
  console.log('已提交任务 id =', id);

  const seen = [];
  for (let i = 0; i < 200; i++) {
    const row = db.prepare('SELECT status, stage, stage_msg, progress FROM digests WHERE id=?').get(id);
    if (row && row.stage_msg && seen[seen.length - 1] !== row.stage_msg) {
      seen.push(row.stage_msg);
      console.log(`  [${row.progress}%] ${row.stage}  ${row.stage_msg}`);
    }
    if (row && (row.status === 'done' || row.status === 'failed')) break;
    await sleep(300);
  }

  const d = getDigestPublic(id);
  if (d.status !== 'done') {
    console.log('  ❌ 失败：', d.error);
    return null;
  }
  const s = d.script;
  console.log('  ✅ 生成成功');
  console.log('  标题        ', s.title);
  console.log('  副标题      ', s.subtitle);
  console.log('  内容条数    ', (s.items || []).length);
  console.log('  播报句数    ', s.cues.length, `（预计 ${d.duration_est} 秒）`);
  console.log('  漏斗        ', `${d.input_count} 条原始 → ${d.cluster_count} 簇 → 留 ${d.keep_count}`);
  console.log('  token       ', `入 ${d.tokens_in} / 出 ${d.tokens_out}`);
  console.log('  耗时        ', d.duration_ms, 'ms');
  console.log('  前 6 句台词：');
  for (const c of s.cues.slice(0, 6)) {
    console.log(`    [${c.speakerLabel}] ${c.text.slice(0, 46)}`);
  }
  if (kind === 'dialogue') {
    const roles = new Set(s.cues.map(c => c.speaker));
    console.log('  角色集合    ', [...roles].join('、'), roles.size === 2 ? '（两种 → 会对上两把音色）' : '（⚠️ 不是两种）');
  }
  return d;
}

const a = await runOnce('newsreel');
const b = await runOnce('dialogue');

// 清理：这两期是测试产物，不留垃圾
if (a) db.prepare('DELETE FROM digests WHERE id=?').run(a.id);
if (b) db.prepare('DELETE FROM digests WHERE id=?').run(b.id);
db.prepare('DELETE FROM llm_providers WHERE id=?').run(info.lastInsertRowid);
console.log('\n测试产物已清理');

server.close();
process.exit(0);
