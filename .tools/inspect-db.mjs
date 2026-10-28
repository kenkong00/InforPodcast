import { db } from '../server/db.js';

const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return [{ ERR: e.message }]; } };

console.log('=== TABLES ===');
console.log(q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name).join(', '));

console.log('\n=== articles 总数 / 有正文 / 分类 ===');
console.log(q('SELECT COUNT(*) total, SUM(CASE WHEN content IS NOT NULL AND length(content)>0 THEN 1 ELSE 0 END) withBody FROM articles'));
console.log(q('SELECT category, COUNT(*) c FROM articles GROUP BY category ORDER BY c DESC LIMIT 12'));

console.log('\n=== llm_providers ===');
for (const r of q('SELECT id,name,base_url,model,enabled,is_default,length(api_key) keylen,call_count,last_error FROM llm_providers')) console.log(r);

console.log('\n=== digests ===');
for (const r of q('SELECT id,kind,status,title,subtitle,item_count,cue_count,input_count,cluster_count,keep_count,tokens_in,tokens_out,duration_ms,created_at,length(script) slen FROM digests ORDER BY id DESC LIMIT 12')) console.log(r);

console.log('\n=== 最近一期 newsreel 的 script 头部 ===');
const last = q("SELECT id, kind, script FROM digests WHERE kind='newsreel' AND status='done' ORDER BY id DESC LIMIT 1")[0];
if (last?.script) {
  const s = JSON.parse(last.script);
  console.log('id', last.id, 'title', s.title);
  console.log('items:', JSON.stringify((s.items || []).slice(0, 3), null, 1));
  console.log('cues(前8):', JSON.stringify((s.cues || []).slice(0, 8), null, 1));
}

console.log('\n=== 最近一期 dialogue 的 script 头部 ===');
const d2 = q("SELECT id, script FROM digests WHERE kind='dialogue' AND status='done' ORDER BY id DESC LIMIT 1")[0];
if (d2?.script) {
  const s = JSON.parse(d2.script);
  console.log('id', d2.id, 'title', s.title, 'host', s.hostName, 'guest', s.guestName);
  console.log('cues(前14):', JSON.stringify((s.cues || []).slice(0, 14).map(c => c.speakerLabel + ':' + c.text), null, 1));
}

console.log('\n=== 候选样本 12 条（最近24h，看正文长度）===');
for (const r of q("SELECT id, site, category, length(content) clen, length(summary) slen, substr(title,1,40) t FROM articles ORDER BY datetime(crawled_at) DESC, id DESC LIMIT 12")) console.log(r);
