/**
 * 大模型方案注册表：保存、选择、测试
 *
 * 用户可以在这里并存任意多个方案 —— 本地 Ollama 一个，DeepSeek 一个，公司网关一个。
 * 每个方案绑定一个「用途」角色：粗筛打分用便宜的，写稿用强的，对话脚本用文风活的。
 */
import { db, getSetting, setSetting } from '../db.js';
import { testProvider, publicView } from './client.js';
import { LOCAL_DEMO_URL } from './localmodel.js';

/** 内置预设。全都是 OpenAI 兼容协议，区别只有 base_url 和模型名。 */
export const PRESETS = [
  {
    name: '内置演示模型（无需 key）',
    base_url: LOCAL_DEMO_URL,
    model: 'local-demo',
    price_in: 0, price_out: 0,
    notes: '离线可用、不联网、不用填 key。从抓取到的原文里抽取事实组装成稿，用来先看流水线效果；接入真实模型后措辞会更自然'
  },
  {
    name: 'DeepSeek 官方',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    price_in: 1, price_out: 8,
    notes: '中文强、价格极低，适合同时承担打分与写稿'
  },
  {
    name: '本地 Ollama',
    base_url: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    api_key: 'ollama',
    price_in: 0, price_out: 0,
    notes: '完全离线、不要钱。需要本机先跑 ollama serve 并 pull 好模型'
  },
  {
    name: '阿里云百炼（通义千问）',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    price_in: 0.8, price_out: 2,
    notes: '走兼容模式，与 OpenAI 协议一致'
  },
  {
    name: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    price_in: 0.1, price_out: 0.1,
    notes: 'glm-4-flash 有免费额度，适合做粗筛'
  },
  {
    name: 'Moonshot（Kimi）',
    base_url: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    price_in: 2, price_out: 8,
    notes: '长文本友好'
  },
  {
    name: '硅基流动 SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    price_in: 0.5, price_out: 0.5,
    notes: '聚合多家开源模型，有免费额度'
  },
  {
    name: '腾讯混元',
    base_url: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbo',
    price_in: 1, price_out: 5,
    notes: '兼容 OpenAI 协议'
  },
  {
    name: 'OpenAI 官方',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    price_in: 0.15, price_out: 0.6,
    notes: '需要能直连或配代理的环境'
  },
  {
    name: 'OpenRouter 中转',
    base_url: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    price_in: 0.2, price_out: 0.8,
    notes: '一个 key 打通多家模型'
  },
  {
    name: '本地 LM Studio / vLLM',
    base_url: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    api_key: 'lm-studio',
    price_in: 0, price_out: 0,
    notes: '本地自建推理服务的通用入口'
  }
];

export function listProviders(includeDisabled = true) {
  const sql = includeDisabled
    ? 'SELECT * FROM llm_providers ORDER BY is_default DESC, enabled DESC, id'
    : 'SELECT * FROM llm_providers WHERE enabled=1 ORDER BY is_default DESC, id';
  return db.prepare(sql).all().map(publicView);
}

export function getProviderRow(id) {
  return db.prepare('SELECT * FROM llm_providers WHERE id=?').get(Number(id)) || null;
}

export function getProviderPublic(id) {
  const row = getProviderRow(id);
  return row ? publicView(row) : null;
}

export function createProvider(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('请给方案起个名字');
  const info = db.prepare(`
    INSERT INTO llm_providers
      (name, protocol, base_url, api_key, model, temperature, max_tokens, json_mode,
       headers, price_in, price_out, enabled, is_default, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    name,
    body.protocol || 'openai',
    String(body.base_url || '').trim(),
    String(body.api_key || ''),
    String(body.model || '').trim(),
    body.temperature === undefined ? 0.3 : Number(body.temperature),
    Number(body.max_tokens) || 4096,
    body.json_mode === false ? 0 : 1,
    typeof body.headers === 'string' ? body.headers : JSON.stringify(body.headers || {}),
    Number(body.price_in) || 0,
    Number(body.price_out) || 0,
    body.enabled === false ? 0 : 1,
    body.is_default ? 1 : 0,
    String(body.notes || ''),
    new Date().toISOString()
  );
  if (body.is_default) setDefault(info.lastInsertRowid);
  return getProviderPublic(info.lastInsertRowid);
}

export function updateProvider(id, body = {}) {
  const cur = getProviderRow(id);
  if (!cur) throw new Error('方案不存在');
  const m = { ...cur, ...body };
  // 前端回传的是打码串，原样写回去会把真实 key 覆盖成 **** —— 空或非打码串才更新
  if (body.api_key !== undefined) {
    m.api_key = String(body.api_key || '');
  }
  db.prepare(`
    UPDATE llm_providers SET name=?, protocol=?, base_url=?, api_key=?, model=?,
      temperature=?, max_tokens=?, json_mode=?, headers=?, price_in=?, price_out=?,
      enabled=?, is_default=?, notes=?
    WHERE id=?
  `).run(
    m.name, m.protocol || 'openai', m.base_url, m.api_key, m.model,
    Number(m.temperature) || 0.3, Number(m.max_tokens) || 4096,
    m.json_mode ? 1 : 0,
    typeof m.headers === 'string' ? m.headers : JSON.stringify(m.headers || {}),
    Number(m.price_in) || 0, Number(m.price_out) || 0,
    m.enabled ? 1 : 0, m.is_default ? 1 : 0, m.notes || '',
    Number(id)
  );
  if (body.is_default) setDefault(Number(id));
  return getProviderPublic(Number(id));
}

export function setDefault(id) {
  db.transaction(() => {
    db.prepare('UPDATE llm_providers SET is_default=0').run();
    db.prepare('UPDATE llm_providers SET is_default=1, enabled=1 WHERE id=?').run(Number(id));
  })();
  return getProviderPublic(id);
}

export function deleteProvider(id) {
  db.prepare('DELETE FROM llm_providers WHERE id=?').run(Number(id));
  return { id: Number(id) };
}

/**
 * 选一个方案：优先显式指定 → 其次用途别名 → 最后默认/第一个可用的
 */
export function pickProvider(explicitId) {
  if (explicitId) {
    const row = getProviderRow(explicitId);
    if (!row) throw new Error('指定的模型方案不存在（id=' + explicitId + '）');
    if (!row.enabled) throw new Error('方案「' + row.name + '」已停用');
    return row;
  }
  const row = db.prepare('SELECT * FROM llm_providers WHERE enabled=1 ORDER BY is_default DESC, id LIMIT 1').get();
  if (!row) {
    throw new Error('还没有配置大模型方案。去设置 → AI 模型里加一个，选个预设再填 key。');
  }
  return row;
}

export async function testConnection(id) {
  const row = getProviderRow(id);
  if (!row) throw new Error('方案不存在');
  return testProvider(row);
}

/** 首次启动塞几个常见方案占位（没 key，用户填一下就能用） */
export function ensureProviderSeed() {
  const count = db.prepare('SELECT COUNT(*) c FROM llm_providers').get().c;
  let added = 0;

  if (count === 0) {
    const names = ['内置演示模型（无需 key）', '本地 Ollama', 'DeepSeek 官方', '阿里云百炼（通义千问）'];
    let demoId = null;
    for (const want of names) {
      const p = PRESETS.find(x => x.name === want);
      if (!p) continue;
      // 内置演示模型设为默认：开箱即用、无需填 key 也能把整条流水线跑通看效果
      const created = createProvider({ ...p, enabled: 1, is_default: want === '内置演示模型（无需 key）' });
      if (want === '内置演示模型（无需 key）') demoId = created.id;
      added++;
    }
    return added;
  }

  /* 老库补种：给已经用过这个网站的人补上内置演示模型，并设为默认。
     只补一次（用 settings 打标），用户主动删掉之后就不再打扰。
     设为默认是为了让「没填任何 key」的用户也能直接点生成看到效果，
     否则默认会落到无 key 的远程方案上，一点生成就是 401/429。 */
  if (getSetting('local_demo_seeded', '') !== '1') {
    let demoId = null;
    const has = db.prepare('SELECT id FROM llm_providers WHERE base_url LIKE ?').get(LOCAL_DEMO_URL + '%');
    if (!has) {
      const p = PRESETS.find(x => x.name === '内置演示模型（无需 key）');
      if (p) { const created = createProvider({ ...p, enabled: 1 }); demoId = created.id; added++; }
    } else {
      demoId = has.id;
    }
    setSetting('local_demo_seeded', '1');
    if (demoId) setDefault(demoId);
  }
  return added;
}

export function usageSummary(limit = 50) {
  const rows = db.prepare('SELECT * FROM llm_usage ORDER BY id DESC LIMIT ?').all(Number(limit) || 50);
  const today = new Date().toISOString().slice(0, 10);
  const agg = db.prepare(`
    SELECT COUNT(*) calls, SUM(ok) oks, SUM(prompt_tokens) pin, SUM(completion_tokens) pout, SUM(latency_ms) lat
    FROM llm_usage WHERE created_at >= ?
  `).get(today + 'T00:00:00');
  return {
    recent: rows,
    today: {
      calls: agg.calls || 0,
      oks: agg.oks || 0,
      prompt_tokens: agg.pin || 0,
      completion_tokens: agg.pout || 0,
      avg_latency_ms: agg.calls ? Math.round((agg.lat || 0) / agg.calls) : 0
    }
  };
}
