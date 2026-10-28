/**
 * 本地预处理层对照实测：用库里真实的抓取数据跑一遍，
 * 打印「原始 → 去重 → 过滤」的递减漏斗，并抽样看聚类是否真的把同一事件并到一起了。
 */
import { db } from '../server/db.js';
import { preprocess, normalizeTitle, dice } from '../server/ai/preprocess.js';

const total = db.prepare('SELECT COUNT(*) c FROM articles').get().c;
console.log('库内文章总数:', total);
if (!total) {
  console.log('没有数据，先跑一次爬取再来测');
  process.exit(0);
}

const rows = db.prepare('SELECT * FROM articles ORDER BY datetime(crawled_at) DESC LIMIT 3000').all();

const t0 = Date.now();
const { kept, report } = preprocess(rows, {});
const ms = Date.now() - t0;

console.log('\n=== 漏斗 ===');
console.log(`原始           ${report.total} 条`);
console.log(`聚类后         ${report.clusterCount} 簇（并入重复 ${report.deduped} 条）`);
console.log(`规则淘汰       ${report.dropped} 簇`);
console.log(`最终候选       ${report.kept} 条`);
console.log(`耗时           ${ms} ms  （${rows.length} 条，纯本地计算）`);
console.log('\n淘汰原因分布:');
for (const r of report.dropReasons) console.log(`  ${r.reason.padEnd(22)} ${r.count}`);

console.log('\n=== 重复簇抽样（同一事件被多家媒体报道） ===');
const dup = kept.filter(k => k.size > 1).slice(0, 5);
if (!dup.length) console.log('  没有发现重复簇（可能是数据太少，或各源内容差异大）');
for (const k of dup) {
  console.log(`\n  [${k.size} 家] ${k.lead.title}`);
  for (const m of k.members.slice(1, 5)) console.log(`        · ${m.site}｜${m.title}`);
}

console.log('\n=== 相似度算法自检 ===');
const cases = [
  ['英伟达股价大涨市值突破新高', '英伟达股价大涨，市值再创新高'],
  ['iPhone 17 系列正式发布', 'iPhone 17 系列正式发布 Pro 版涨价'],
  ['台风明天登陆浙江沿海', '台风明天登陆浙江沿海地区，将带来强降雨'],
  ['今天股市收盘大盘上涨', '某明星官宣结婚']
];
for (const [a, b] of cases) {
  const ga = new Set(), gb = new Set();
  const nx = '^' + normalizeTitle(a) + '$', ny = '^' + normalizeTitle(b) + '$';
  for (let i = 0; i < nx.length - 1; i++) ga.add(nx.slice(i, i + 2));
  for (let i = 0; i < ny.length - 1; i++) gb.add(ny.slice(i, i + 2));
  console.log(`  ${dice(ga, gb).toFixed(3)}  ${a}  ⟷  ${b}`);
}
console.log('\n（阈值 0.62：前三组应当合并，最后一组应当分开）');
