import { db } from '../server/db.js';
console.log('=== llm_providers ===');
const rows = db.prepare('SELECT id,name,base_url,enabled,is_default,length(api_key) klen FROM llm_providers ORDER BY id').all();
for (const r of rows) console.log(r.id, '|', r.name, '|', r.base_url, '| en=' + r.enabled, 'def=' + r.is_default, 'keylen=' + (r.klen||0));
console.log('=== settings local_demo_seeded ===');
const s = db.prepare("SELECT key,value FROM settings WHERE key='local_demo_seeded'").get();
console.log(s || '(无)');
console.log('=== digests ===');
for (const r of db.prepare('SELECT id,kind,status,item_count,cue_count,created_at FROM digests ORDER BY id').all())
  console.log(r.id, r.kind, r.status, r.item_count + '条', r.cue_count + '句', r.created_at);
