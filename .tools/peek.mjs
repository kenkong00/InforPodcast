import { db } from '../server/db.js';
const rows = db.prepare("SELECT id,site,title,summary,content,hot_value,rank FROM articles WHERE site='ithome' ORDER BY datetime(crawled_at) DESC LIMIT 4").all();
for (const r of rows) {
  console.log('---', r.id, r.site, '| rank', r.rank, '| hot', r.hot_value);
  console.log('T:', r.title);
  console.log('S:', String(r.summary||'').replace(/\s+/g,' '));
  console.log('C:', String(r.content||'').replace(/\s+/g,' ').slice(0,300) || '(空)');
}
console.log('\n=== 热榜类样本 ===');
for (const r of db.prepare("SELECT id,site,title,summary FROM articles WHERE category='热榜' ORDER BY rank ASC LIMIT 5").all()) {
  console.log('-', r.site, '|', r.title, '|', String(r.summary||'').replace(/\s+/g,' ').slice(0,120));
}
