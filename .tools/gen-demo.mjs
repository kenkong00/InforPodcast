/**
 * 用内置演示模型把真实流水线跑一遍，产出两期节目（精选轮播 + 双人对话）并留在历史里。
 * 用法：node .tools/gen-demo.mjs [newsreel|dialogue|both] [topN]
 */
import fs from 'fs';
import path from 'path';
import { db } from '../server/db.js';
import { ensurePromptSeed, listPrompts } from '../server/ai/prompts.js';
import { ensureProviderSeed, listProviders } from '../server/ai/registry.js';
import { startDigest, getDigestPublic } from '../server/ai/pipeline.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(process.cwd(), '.samples');
fs.mkdirSync(OUT, { recursive: true });

ensurePromptSeed();
ensureProviderSeed();

console.log('=== 提示词版本 ===');
for (const p of listPrompts()) {
  const hasNew = p.content.system.includes('违反就算不合格');
  console.log(` ${p.key.padEnd(9)} 新版约束: ${hasNew ? '✅ 已生效' : (p.key === 'score' ? '—' : '❌ 未升级')}`);
}

const provs = listProviders();
console.log('\n=== 方案 ===');
for (const p of provs) console.log(` id=${p.id} ${p.name} | ${p.base_url} | enabled=${p.enabled} | key=${p.has_key}`);
const demo = provs.find(p => p.base_url.startsWith('internal://'));
if (!demo) { console.error('没有内置演示模型方案'); process.exit(1); }
console.log('-> 使用', demo.name, 'id=', demo.id);

const which = (process.argv[2] || 'both').toLowerCase();
const topN = Number(process.argv[3]) || 12;

async function runOnce(kind, n) {
  console.log(`\n=========== ${kind === 'dialogue' ? '双人对话' : '精选轮播'} (topN=${n}) ===========`);
  const { id } = startDigest({
    kind, topN: n, minScore: 5,
    writeProviderId: demo.id, scoreProviderId: demo.id,
    scope: { hours: 0 },
    filter: { minBodyChars: 60 }
  });
  let row;
  for (let i = 0; i < 400; i++) {
    row = db.prepare('SELECT status, progress, stage, stage_msg FROM digests WHERE id=?').get(id);
    if (row && (row.status === 'done' || row.status === 'failed')) break;
    await sleep(150);
  }
  const d = getDigestPublic(id);
  if (d.status !== 'done') { console.log('  ❌ 失败：', d.error); return null; }
  const s = d.script;
  console.log(`  ✅ id=${d.id} · ${d.input_count} 条原始 → ${d.cluster_count} 簇 → 留 ${d.keep_count} → 写 ${s.items.length} 条 / ${s.cues.length} 句 · ${d.duration_ms}ms`);
  console.log('  标题：', s.title, '|', s.subtitle);
  return d;
}

function dumpTxt(d, file) {
  const s = d.script;
  const L = ['# ' + s.title, '> ' + (s.subtitle || ''), ''];
  for (const c of s.cues) L.push((c.speakerLabel ? c.speakerLabel + '：' : '') + c.text);
  L.push('', '---', `原始 ${d.input_count} 条 → 去重成 ${d.cluster_count} 簇 → 留 ${d.keep_count} 条`);
  fs.writeFileSync(path.join(OUT, file), L.join('\n'), 'utf8');
  console.log('  📄 已导出', file);
}

if (which === 'newsreel' || which === 'both') {
  const a = await runOnce('newsreel', topN);
  if (a) {
    dumpTxt(a, '精选轮播成品.txt');
    console.log('\n--- 逐条检查（标题 / 正文长度）---');
    for (const it of a.script.items) {
      const cues = a.script.cues.filter(c => c.itemIndex === it.index && c.kind === 'body');
      const len = cues.reduce((s, c) => s + c.text.length, 0);
      console.log(` ${String(it.index + 1).padStart(2)}. [${String(len).padStart(3)}字] ${it.title}`);
    }
  }
}

if (which === 'dialogue' || which === 'both') {
  const b = await runOnce('dialogue', topN);
  if (b) dumpTxt(b, '双人对话成品.txt');
}
process.exit(0);
