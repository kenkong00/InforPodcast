import { db } from '../server/db.js';
console.log('=== articles crawled_at 分布（按天）===');
for (const r of db.prepare("SELECT substr(crawled_at,1,10) d, COUNT(*) c FROM articles GROUP BY d ORDER BY d DESC LIMIT 10").all())
  console.log(' ', r.d, r.c);
console.log('=== 最新 crawled_at ===');
console.log(db.prepare('SELECT MAX(crawled_at) m, MIN(crawled_at) n FROM articles').get());
console.log('=== 当前时间 ===');
console.log(new Date().toISOString());
console.log('=== 最近 24h / 48h / 全部 的可加工候选（minBodyChars>=80）===');
for (const h of [24, 48, 72, 0]) {
  const sql = h > 0
    ? `SELECT COUNT(*) c FROM articles WHERE crawled_at >= datetime('now','-${h} hours') AND length(content)>=80`
    : `SELECT COUNT(*) c FROM articles WHERE length(content)>=80`;
  console.log(' h=' + h, db.prepare(sql).get().c);
}
