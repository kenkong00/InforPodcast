import { db } from '../server/db.js';
for (const r of db.prepare('SELECT id,kind,status,title,item_count,cue_count,created_at FROM digests ORDER BY id').all())
  console.log(`id=${String(r.id).padStart(3)} ${r.kind.padEnd(9)} ${r.status.padEnd(7)} ${String(r.item_count).padStart(3)}条 ${String(r.cue_count).padStart(3)}句  ${r.title}`);
