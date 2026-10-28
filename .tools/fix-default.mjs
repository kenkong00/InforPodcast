import { db } from '../server/db.js';
import { setDefault } from '../server/ai/registry.js';

// 1) 把内置演示模型设为默认
const demo = db.prepare("SELECT id FROM llm_providers WHERE base_url LIKE 'internal://%'").get();
if (demo) {
  setDefault(demo.id);
  console.log('已将内置演示模型 (id=' + demo.id + ') 设为默认方案');
} else {
  console.log('未找到内置演示模型，跳过');
}

// 2) 清掉上次 CDP 测试留下的失败记录
const r = db.prepare("DELETE FROM digests WHERE status='failed' OR item_count=0");
const del = r.run();
console.log('清理失败/空节目记录：', del.changes, '条');

// 3) 确认结果
for (const p of db.prepare('SELECT id,name,base_url,is_default,enabled FROM llm_providers ORDER BY id').all())
  console.log(' 方案', p.id, p.name, '| default=' + p.is_default, '| enabled=' + p.enabled);
for (const d of db.prepare('SELECT id,kind,status,item_count FROM digests ORDER BY id').all())
  console.log(' 节目', d.id, d.kind, d.status, d.item_count + '条');
