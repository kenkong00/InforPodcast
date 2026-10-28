import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db, DATA_DIR, getSetting, setSetting } from './db.js';
import { SEED_SOURCES } from './seeds.js';
import { crawlAll, crawlSource, crawlState, fetchOneUrl, fetchArticleContent, fetchContentBatch } from './crawler/index.js';
import { ttsState, listVoices, synth, cacheInfo, clearCache, ensureDaemon, TTS_CACHE_DIR, getExportDir, setExportDir, exportMp3, ffmpegAvailable } from './tts.js';
import { ensurePromptSeed, listPrompts, savePrompt, getPrompt } from './ai/prompts.js';
import {
  PRESETS, listProviders, createProvider, updateProvider, deleteProvider,
  setDefault, testConnection, ensureProviderSeed, usageSummary
} from './ai/registry.js';
import {
  startDigest, listDigests, getDigestPublic, deleteDigest, digestProgress, genState
} from './ai/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5199;
const DIST = path.join(__dirname, '..', 'web', 'dist');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------- 初始化默认源 ---------- */
function normalizeSeed(s) {
  return {
    name: s.name,
    site: s.site || hostOf(s.url),
    url: s.url,
    type: s.type || 'auto',
    parser: s.parser || '',
    category: s.category || '综合',
    notes: s.notes || '',
    limit_count: Number(s.limit_count) || 50,
    enabled: s.enabled === undefined ? 1 : (s.enabled ? 1 : 0),
    no_body: s.no_body ? 1 : 0,
    config: JSON.stringify(s.config || {})
  };
}

function ensureSeed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sources').get().c;
  if (count === 0) {
    const stmt = db.prepare(`
      INSERT INTO sources (name, site, url, type, parser, category, enabled, config, notes, limit_count, no_body, created_at)
      VALUES (@name, @site, @url, @type, @parser, @category, @enabled, @config, @notes, @limit_count, @no_body, @created_at)
    `);
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const s of SEED_SOURCES) stmt.run({ ...normalizeSeed(s), created_at: now });
    })();
    console.log(`[init] 已写入 ${SEED_SOURCES.length} 个默认数据源`);
  }
}
ensureSeed();
ensureProviderSeed();
ensurePromptSeed();

/* ---------- 工具 ---------- */
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, message: msg });

/* ---------- 统计 ---------- */
function readStats() {
  const total = db.prepare('SELECT COUNT(*) c FROM articles').get().c;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = db.prepare("SELECT COUNT(*) c FROM articles WHERE crawled_at >= ?").get(today + 'T00:00:00').c;
  const sources = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
  const enabledSources = db.prepare('SELECT COUNT(*) c FROM sources WHERE enabled=1').get().c;
  const pages = db.prepare('SELECT COUNT(*) c FROM pages').get().c;
  const byCategory = db.prepare('SELECT category, COUNT(*) c FROM articles GROUP BY category ORDER BY c DESC').all();
  const bySource = db.prepare(`
    SELECT s.id, s.name, s.site, s.category, s.enabled, s.last_status, s.last_crawled_at, COUNT(a.id) c
    FROM sources s LEFT JOIN articles a ON a.source_id = s.id
    GROUP BY s.id ORDER BY s.category, s.name
  `).all();
  return { total, todayCount, sources, enabledSources, pages, byCategory, bySource };
}

app.get('/api/stats', (req, res) => ok(res, readStats()));

/**
 * 首屏引导接口：把「打开页面第一眼要用到的数据」一次打包返回。
 * 前端不用再串行打 4 个请求，转圈的时间直接减半；
 * 同时它也是前端的「服务就绪探针」—— 探不通就继续等，而不是甩一个连接拒绝。
 */
app.get('/api/boot', (req, res) => {
  const stats = readStats();
  ok(res, {
    booted_at: new Date().toISOString(),
    stats,
    providers: listProviders(false).length,
    digests: db.prepare('SELECT COUNT(*) c FROM digests').get().c,
    prompts: db.prepare('SELECT COUNT(*) c FROM prompts').get().c
  });
});

/* ---------- 数据源管理 ---------- */
app.get('/api/sources', (req, res) => {
  const rows = db.prepare('SELECT * FROM sources ORDER BY category, id').all();
  ok(res, rows);
});

app.post('/api/sources', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.url) return fail(res, '名称与网址不能为空', 400);
  const info = db.prepare(`
    INSERT INTO sources (name, site, url, type, parser, category, enabled, config, notes, limit_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.name,
    b.site || hostOf(b.url),
    b.url,
    b.type || 'auto',
    b.parser || '',
    b.category || '综合',
    b.enabled === false ? 0 : 1,
    typeof b.config === 'string' ? b.config : JSON.stringify(b.config || {}),
    b.notes || '',
    Number(b.limit_count) || 50,
    new Date().toISOString()
  );
  ok(res, db.prepare('SELECT * FROM sources WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/sources/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  if (!cur) return fail(res, '数据源不存在', 404);
  const b = req.body || {};
  const merged = { ...cur, ...b };
  db.prepare(`
    UPDATE sources SET name=?, site=?, url=?, type=?, parser=?, category=?, enabled=?, config=?, notes=?, limit_count=?, no_body=?
    WHERE id=?
  `).run(
    merged.name,
    merged.site || hostOf(merged.url),
    merged.url,
    merged.type || 'auto',
    merged.parser || '',
    merged.category || '综合',
    merged.enabled ? 1 : 0,
    typeof merged.config === 'string' ? merged.config : JSON.stringify(merged.config || {}),
    merged.notes || '',
    Number(merged.limit_count) || 50,
    merged.no_body ? 1 : 0,
    id
  );
  // 源改了「无正文」标记，已入库的条目同步更新
  if (b.no_body !== undefined) {
    db.prepare('UPDATE articles SET no_body=? WHERE source_id=?').run(merged.no_body ? 1 : 0, id);
  }
  ok(res, db.prepare('SELECT * FROM sources WHERE id=?').get(id));
});

app.delete('/api/sources/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM sources WHERE id=?').run(id);
  db.prepare('DELETE FROM articles WHERE source_id=?').run(id);
  ok(res, { id });
});

app.post('/api/sources/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  if (!cur) return fail(res, '数据源不存在', 404);
  db.prepare('UPDATE sources SET enabled=? WHERE id=?').run(cur.enabled ? 0 : 1, id);
  ok(res, db.prepare('SELECT * FROM sources WHERE id=?').get(id));
});

app.post('/api/sources/reset', (req, res) => {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO sources (name, site, url, type, parser, category, enabled, config, notes, limit_count, no_body, created_at)
    VALUES (@name, @site, @url, @type, @parser, @category, @enabled, @config, @notes, @limit_count, @no_body, @created_at)
  `);
  const existing = new Set(db.prepare('SELECT url FROM sources').all().map(r => r.url));
  let added = 0;
  db.transaction(() => {
    for (const s of SEED_SOURCES) {
      if (!existing.has(s.url)) { stmt.run({ ...normalizeSeed(s), created_at: now }); added++; }
    }
  })();
  ok(res, { added });
});

/* ---------- 设置（代理等） ---------- */
app.get('/api/settings', (req, res) => {
  ok(res, {
    proxy_mode: getSetting('proxy_mode', 'auto'),
    proxy_url: getSetting('proxy_url', '') || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
  });
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.proxy_mode !== undefined) setSetting('proxy_mode', b.proxy_mode);
  if (b.proxy_url !== undefined) setSetting('proxy_url', b.proxy_url);
  ok(res, { proxy_mode: getSetting('proxy_mode', 'auto'), proxy_url: getSetting('proxy_url', '') });
});

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/* ---------- 爬取 ---------- */
app.post('/api/crawl', async (req, res) => {
  const r = await crawlAll(req.body || {});
  ok(res, r);
});

app.get('/api/crawl/status', (req, res) => {
  ok(res, {
    running: crawlState.running,
    startedAt: crawlState.startedAt,
    finishedAt: crawlState.finishedAt,
    total: crawlState.total,
    done: crawlState.done,
    newTotal: crawlState.newTotal,
    current: crawlState.current,
    scope: crawlState.scope,
    message: crawlState.message,
    results: crawlState.results
  });
});

app.post('/api/sources/:id/crawl', async (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  if (!s) return fail(res, '数据源不存在', 404);
  const r = await crawlSource(s);
  ok(res, r);
});

/* ---------- 信息列表 ---------- */
app.get('/api/articles', (req, res) => {
  const {
    category = '', source = '', q = '', site = '',
    unread = '', starred = '', page = '1', pageSize = '60', sort = 'new'
  } = req.query;
  const where = [];
  const params = {};
  if (category) { where.push('category = @category'); params.category = category; }
  if (source) { where.push('source_id = @source'); params.source = Number(source); }
  if (site) { where.push('site = @site'); params.site = site; }
  if (unread === '1') where.push('is_read = 0');
  if (starred === '1') where.push('is_starred = 1');
  if (q) {
    where.push('(title LIKE @q OR summary LIKE @q OR content LIKE @q OR site LIKE @q)');
    params.q = '%' + q + '%';
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = sort === 'rank'
    ? 'ORDER BY (rank IS NULL), rank ASC, crawled_at DESC'
    : 'ORDER BY datetime(crawled_at) DESC, id DESC';
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(200, Math.max(1, Number(pageSize) || 60));
  const totalRow = db.prepare(`SELECT COUNT(*) c FROM articles ${w}`).get(params);
  const rows = db.prepare(`SELECT * FROM articles ${w} ${order} LIMIT ${size} OFFSET ${(p - 1) * size}`).all(params);
  ok(res, { total: totalRow.c, page: p, pageSize: size, list: rows });
});

app.patch('/api/articles/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const sets = [];
  const params = { id };
  if (b.is_read !== undefined) { sets.push('is_read=@is_read'); params.is_read = b.is_read ? 1 : 0; }
  if (b.is_starred !== undefined) { sets.push('is_starred=@is_starred'); params.is_starred = b.is_starred ? 1 : 0; }
  if (b.category !== undefined) { sets.push('category=@category'); params.category = b.category; }
  if (b.no_body !== undefined) { sets.push('no_body=@no_body'); params.no_body = b.no_body ? 1 : 0; }
  if (!sets.length) return fail(res, '没有可更新字段', 400);
  db.prepare(`UPDATE articles SET ${sets.join(',')} WHERE id=@id`).run(params);
  ok(res, db.prepare('SELECT * FROM articles WHERE id=?').get(id));
});

app.delete('/api/articles/:id', (req, res) => {
  db.prepare('DELETE FROM articles WHERE id=?').run(Number(req.params.id));
  ok(res, { id: Number(req.params.id) });
});

app.post('/api/articles/clear', (req, res) => {
  const { olderThanDays = 0, category = '' } = req.body || {};
  const where = [];
  const params = {};
  if (category) { where.push('category = @category'); params.category = category; }
  if (Number(olderThanDays) > 0) {
    const d = new Date(Date.now() - Number(olderThanDays) * 86400000).toISOString();
    where.push('crawled_at < @d');
    params.d = d;
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const r = db.prepare(`DELETE FROM articles ${w}`).run(params);
  ok(res, { deleted: r.changes });
});

/* ---------- 正文抓取（站内阅读 / 语音播报用） ---------- */
app.get('/api/articles/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM articles WHERE id=?').get(Number(req.params.id));
  if (!row) return fail(res, '条目不存在', 404);
  ok(res, row);
});

app.post('/api/articles/:id/content', async (req, res) => {
  try {
    const r = await fetchArticleContent(Number(req.params.id));
    ok(res, r);
  } catch (e) {
    fail(res, e.message || '正文抓取失败');
  }
});

app.post('/api/articles/content-batch', async (req, res) => {
  const { ids = [], concurrency = 3 } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return fail(res, 'ids 不能为空', 400);
  try {
    ok(res, await fetchContentBatch(ids.map(Number), Math.min(6, Number(concurrency) || 3)));
  } catch (e) {
    fail(res, e.message);
  }
});

/* ---------- 语音播报（本机 Windows OneCore 语音 → WAV 文件） ----------
 * 合成好的音频放在 /tts-cache 下静态托管，前端用 <audio> 播放，
 * 因此暂停、拖动进度、随时停止、断点续播都是浏览器原生能力。 */
app.use('/tts-cache', express.static(TTS_CACHE_DIR, {
  maxAge: '7d',
  immutable: true,
  setHeaders: r => r.setHeader('Cache-Control', 'public, max-age=604800, immutable')
}));

app.get('/api/tts/voices', async (req, res) => {
  ok(res, await listVoices(req.query.refresh === '1'));
});

app.get('/api/tts/status', (req, res) => {
  ok(res, {
    ready: ttsState.ready,
    busy: ttsState.busy,
    voice: ttsState.voice,
    rate: ttsState.rate,
    lastSynthMs: ttsState.lastSynthMs || 0,
    synthCount: ttsState.synthCount || 0,
    cache: cacheInfo(),
    lastError: ttsState.lastError
  });
});

/** 合成单段文本 */
app.post('/api/tts/synth', async (req, res) => {
  const { text = '', voice = '', rate = 0 } = req.body || {};
  if (!String(text).trim()) return fail(res, '文本为空', 400);
  try {
    ok(res, await synth(text, { voice, rate }));
  } catch (e) {
    fail(res, e.message || '语音合成失败');
  }
});

/** 批量预合成（歌词逐句预取，减少等待）。上限 60 句：句级播报一篇正文会切出几十句。
 *  items 里每一项可以自带 voice —— 双人对话时两个角色要用两把音色。 */
app.post('/api/tts/synth-batch', async (req, res) => {
  const { items = [], voice = '', rate = 0 } = req.body || {};
  if (!Array.isArray(items) || !items.length) return fail(res, 'items 不能为空', 400);
  const out = [];
  for (const it of items.slice(0, 60)) {
    const v = it.voice || voice || '';
    try {
      const r = await synth(it.text || '', { voice: v, rate });
      out.push({
        key: it.key ?? null,
        url: r.url,
        bytes: r.bytes,
        duration: r.duration || 0,
        cached: r.cached,
        error: ''
      });
    } catch (e) {
      out.push({ key: it.key ?? null, url: '', bytes: 0, duration: 0, cached: false, error: e.message });
    }
  }
  ok(res, { list: out });
});

app.post('/api/tts/warmup', async (req, res) => {
  const okk = await ensureDaemon();
  const v = okk ? await listVoices() : { voices: [] };
  ok(res, { ready: okk, error: okk ? '' : ttsState.lastError, voices: v.voices || [] });
});

app.get('/api/tts/cache', (req, res) => ok(res, cacheInfo()));
app.post('/api/tts/cache/clear', (req, res) => ok(res, clearCache()));

/* ---------- 离线 MP3 导出（本机语音 → WAV → ffmpeg → MP3，存到指定目录） ---------- */
app.get('/api/tts/export-dir', (req, res) => {
  ok(res, { dir: getExportDir(), ffmpeg: !!ffmpegAvailable });
});

app.post('/api/tts/export-dir', (req, res) => {
  const { dir } = req.body || {};
  try {
    ok(res, { dir: setExportDir(dir) });
  } catch (e) {
    fail(res, e.message || '目录设置失败', 400);
  }
});

app.post('/api/tts/export', async (req, res) => {
  const { text = '', voice = '', rate = 0, fileName = '' } = req.body || {};
  if (!String(text).trim()) return fail(res, '文本为空', 400);
  try {
    ok(res, await exportMp3({ text, voice, rate, fileName }));
  } catch (e) {
    fail(res, e.message || 'MP3 导出失败');
  }
});

/* 提供已导出的 MP3（仅限导出目录内，防目录穿越） */
app.get('/tts-export/:file', (req, res) => {
  const dir = getExportDir();
  const f = path.basename(decodeURIComponent(req.params.file));
  const fp = path.join(dir, f);
  if (!fp.startsWith(dir) || !fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `inline; filename="${f}"`);
  fs.createReadStream(fp).pipe(res);
});

/* ---------- 大模型方案管理 ---------- */
app.get('/api/ai/providers', (req, res) => {
  ok(res, { list: listProviders(), presets: PRESETS });
});

app.post('/api/ai/providers', (req, res) => {
  try { ok(res, createProvider(req.body || {})); }
  catch (e) { fail(res, e.message || '创建失败', 400); }
});

app.put('/api/ai/providers/:id', (req, res) => {
  try { ok(res, updateProvider(Number(req.params.id), req.body || {})); }
  catch (e) { fail(res, e.message || '保存失败', 400); }
});

app.delete('/api/ai/providers/:id', (req, res) => ok(res, deleteProvider(Number(req.params.id))));

app.post('/api/ai/providers/:id/default', (req, res) => {
  try { ok(res, setDefault(Number(req.params.id))); }
  catch (e) { fail(res, e.message || '设置失败', 400); }
});

app.post('/api/ai/providers/:id/test', async (req, res) => {
  try { ok(res, await testConnection(Number(req.params.id))); }
  catch (e) { fail(res, e.message || '测试失败'); }
});

app.get('/api/ai/usage', (req, res) => ok(res, usageSummary(Number(req.query.limit) || 50)));

/* ---------- 提示词模板 ---------- */
app.get('/api/ai/prompts', (req, res) => ok(res, listPrompts()));

app.put('/api/ai/prompts/:key', (req, res) => {
  const b = req.body || {};
  try { ok(res, savePrompt(req.params.key, { system: b.system || '', user: b.user || '', __title: b.title, __hint: b.hint })); }
  catch (e) { fail(res, e.message || '保存失败', 400); }
});

app.post('/api/ai/prompts/:key/reset', (req, res) => {
  try { ok(res, resetPrompt(req.params.key)); }
  catch (e) { fail(res, e.message || '恢复失败', 400); }
});

/* ---------- AI 节目（精选轮播 / 双人对话） ---------- */
app.get('/api/digests', (req, res) => ok(res, listDigests(Number(req.query.limit) || 50)));

app.get('/api/digests/:id', (req, res) => {
  const d = getDigestPublic(Number(req.params.id));
  if (!d) return fail(res, '节目不存在', 404);
  ok(res, d);
});

app.delete('/api/digests/:id', (req, res) => ok(res, deleteDigest(Number(req.params.id))));

app.post('/api/digests/generate', (req, res) => {
  try { ok(res, startDigest(req.body || {})); }
  catch (e) { fail(res, e.message || '无法开始生成', 400); }
});

app.get('/api/digests/status/current', (req, res) => {
  if (!genState.running || !genState.id) return ok(res, { running: false });
  ok(res, { running: true, ...(digestProgress(genState.id) || {}) });
});

app.get('/api/digests/:id/status', (req, res) => {
  const p = digestProgress(Number(req.params.id));
  if (!p) return fail(res, '节目不存在', 404);
  ok(res, p);
});

/* ---------- 单 URL 抓取 ---------- */
app.post('/api/fetch', async (req, res) => {
  const { url, category = '网页抓取' } = req.body || {};
  if (!url) return fail(res, '请输入网址', 400);
  try {
    const page = await fetchOneUrl(String(url).trim(), category);
    ok(res, page);
  } catch (e) {
    fail(res, e.message || '抓取失败');
  }
});

app.get('/api/pages', (req, res) => {
  const rows = db.prepare('SELECT id, url, title, site, category, word_count, crawled_at FROM pages ORDER BY crawled_at DESC LIMIT 200').all();
  ok(res, rows);
});

app.get('/api/pages/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pages WHERE id=?').get(Number(req.params.id));
  if (!row) return fail(res, '记录不存在', 404);
  ok(res, row);
});

app.delete('/api/pages/:id', (req, res) => {
  db.prepare('DELETE FROM pages WHERE id=?').run(Number(req.params.id));
  ok(res, { id: Number(req.params.id) });
});

/* ---------- 日志 ---------- */
app.get('/api/logs', (req, res) => {
  const rows = db.prepare('SELECT * FROM crawl_logs ORDER BY id DESC LIMIT 100').all();
  ok(res, rows);
});

/* ---------- 静态资源 ---------- */
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('<h3>前端未构建，请先运行 npm run build</h3>'));
}

app.listen(PORT, () => {
  console.log('==============================================');
  console.log(`  信息聚合网站已启动  ->  http://localhost:${PORT}`);
  console.log(`  数据库: ${path.join(DATA_DIR, 'aggregator.db')}`);
  console.log('==============================================');
});
