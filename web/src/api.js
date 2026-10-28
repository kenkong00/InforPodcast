const BASE = '/api';

async function req(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('服务返回异常（非 JSON）'); }
  if (!json.success) throw new Error(json.message || '请求失败');
  return json.data;
}

export const api = {
  boot: () => req('/boot'),
  stats: () => req('/stats'),
  sources: () => req('/sources'),
  addSource: body => req('/sources', { method: 'POST', body: JSON.stringify(body) }),
  updateSource: (id, body) => req('/sources/' + id, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSource: id => req('/sources/' + id, { method: 'DELETE' }),
  toggleSource: id => req('/sources/' + id + '/toggle', { method: 'POST' }),
  resetSources: () => req('/sources/reset', { method: 'POST' }),

  crawlAll: (body = {}) => req('/crawl', { method: 'POST', body: JSON.stringify(body) }),
  crawlStatus: () => req('/crawl/status'),
  crawlSource: id => req('/sources/' + id + '/crawl', { method: 'POST' }),

  articles: params => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return req('/articles?' + qs);
  },
  patchArticle: (id, body) => req('/articles/' + id, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteArticle: id => req('/articles/' + id, { method: 'DELETE' }),
  clearArticles: body => req('/articles/clear', { method: 'POST', body: JSON.stringify(body) }),

  fetchUrl: (url, category) => req('/fetch', { method: 'POST', body: JSON.stringify({ url, category }) }),
  pages: () => req('/pages'),
  page: id => req('/pages/' + id),
  deletePage: id => req('/pages/' + id, { method: 'DELETE' }),

  getArticle: id => req('/articles/' + id),
  articleContent: id => req('/articles/' + id + '/content', { method: 'POST' }),
  contentBatch: ids => req('/articles/content-batch', { method: 'POST', body: JSON.stringify({ ids }) }),

  ttsVoices: () => req('/tts/voices'),
  ttsStatus: () => req('/tts/status'),
  ttsSynth: body => req('/tts/synth', { method: 'POST', body: JSON.stringify(body) }),
  ttsSynthBatch: body => req('/tts/synth-batch', { method: 'POST', body: JSON.stringify(body) }),
  ttsWarmup: () => req('/tts/warmup', { method: 'POST' }),
  ttsCache: () => req('/tts/cache'),
  ttsClearCache: () => req('/tts/cache/clear', { method: 'POST' }),

  ttsExportDir: () => req('/tts/export-dir'),
  ttsSetExportDir: dir => req('/tts/export-dir', { method: 'POST', body: JSON.stringify({ dir }) }),
  ttsExport: body => req('/tts/export', { method: 'POST', body: JSON.stringify(body) }),

  logs: () => req('/logs'),
  settings: () => req('/settings'),
  updateSettings: body => req('/settings', { method: 'POST', body: JSON.stringify(body) }),

  /* ---------- 大模型方案 ---------- */
  providers: () => req('/ai/providers'),
  addProvider: body => req('/ai/providers', { method: 'POST', body: JSON.stringify(body) }),
  updateProvider: (id, body) => req('/ai/providers/' + id, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProvider: id => req('/ai/providers/' + id, { method: 'DELETE' }),
  defaultProvider: id => req('/ai/providers/' + id + '/default', { method: 'POST' }),
  testProvider: id => req('/ai/providers/' + id + '/test', { method: 'POST' }),
  aiUsage: limit => req('/ai/usage' + (limit ? '?limit=' + limit : '')),

  prompts: () => req('/ai/prompts'),
  savePrompt: (key, body) => req('/ai/prompts/' + key, { method: 'PUT', body: JSON.stringify(body) }),
  resetPrompt: key => req('/ai/prompts/' + key + '/reset', { method: 'POST' }),

  /* ---------- AI 节目 ---------- */
  digests: limit => req('/digests' + (limit ? '?limit=' + limit : '')),
  digest: id => req('/digests/' + id),
  deleteDigest: id => req('/digests/' + id, { method: 'DELETE' }),
  generateDigest: body => req('/digests/generate', { method: 'POST', body: JSON.stringify(body) }),
  digestStatus: id => req('/digests/' + id + '/status'),
  digestCurrent: () => req('/digests/status/current')
};

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + '天前';
  return new Date(t).toLocaleDateString('zh-CN');
}
