import { db } from '../server/db.js';
const keep = Number(process.argv[2] || 0);
if (keep) db.prepare('DELETE FROM digests WHERE id < ?').run(keep);
else db.prepare('DELETE FROM digests').run();
for (const r of db.prepare('SELECT id,kind,title FROM digests ORDER BY id').all())
  console.log(`保留 id=${r.id} ${r.kind} ${r.title}`);
