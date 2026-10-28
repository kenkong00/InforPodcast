import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'aggregator.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  site           TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT 'auto',
  parser         TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT '综合',
  enabled        INTEGER NOT NULL DEFAULT 1,
  config         TEXT NOT NULL DEFAULT '{}',
  notes          TEXT NOT NULL DEFAULT '',
  limit_count    INTEGER NOT NULL DEFAULT 50,
  last_crawled_at TEXT,
  last_status    TEXT,
  last_message   TEXT,
  total_items    INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_category ON sources(category);

CREATE TABLE IF NOT EXISTS articles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER,
  source_name   TEXT NOT NULL DEFAULT '',
  site          TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '综合',
  title         TEXT NOT NULL,
  url           TEXT NOT NULL DEFAULT '',
  hash          TEXT NOT NULL UNIQUE,
  summary       TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  rank          INTEGER,
  hot_value     TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  crawled_at    TEXT NOT NULL,
  word_count    INTEGER NOT NULL DEFAULT 0,
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_starred    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_articles_cat ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_time ON articles(crawled_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_star ON articles(is_starred);

CREATE TABLE IF NOT EXISTS pages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL,
  url_hash     TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL DEFAULT '',
  site         TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '网页抓取',
  content      TEXT NOT NULL DEFAULT '',
  word_count   INTEGER NOT NULL DEFAULT 0,
  crawled_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_time ON pages(crawled_at DESC);

CREATE TABLE IF NOT EXISTS crawl_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER,
  source_name  TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running',
  new_count    INTEGER NOT NULL DEFAULT 0,
  total_count  INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON crawl_logs(started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/* ---------- 大模型方案（可保存多个，本地 / API 服务商一视同仁） ----------
   protocol 目前只用 openai —— 因为 DeepSeek、智谱 GLM、Moonshot、DashScope 兼容模式、
   硅基流动、OpenRouter、本地 Ollama / LM Studio / vLLM 全部实现了
   POST {base_url}/chat/completions 这同一套协议，写一份适配器就能全接。 */
CREATE TABLE IF NOT EXISTS llm_providers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  protocol     TEXT NOT NULL DEFAULT 'openai',
  base_url     TEXT NOT NULL DEFAULT '',
  api_key      TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  temperature  REAL NOT NULL DEFAULT 0.3,
  max_tokens   INTEGER NOT NULL DEFAULT 4096,
  json_mode    INTEGER NOT NULL DEFAULT 1,
  headers      TEXT NOT NULL DEFAULT '{}',
  price_in     REAL NOT NULL DEFAULT 0,
  price_out    REAL NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  is_default   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT NOT NULL DEFAULT '',
  last_ok_at   TEXT,
  last_error   TEXT NOT NULL DEFAULT '',
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  call_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_providers_enabled ON llm_providers(enabled);

/* 每次调用的用量与结果，用于「这期花了多少钱」和问题回溯 */
CREATE TABLE IF NOT EXISTS llm_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id       INTEGER,
  provider_name     TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,
  message           TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_time ON llm_usage(id DESC);

/* 提示词模板：写死在代码里用户没法调，放库里可以在界面改 */
CREATE TABLE IF NOT EXISTS prompts (
  key        TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  hint       TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

/* AI 加工产物：一期「节目」。script 统一为 cue[] —— speaker + text，
   和现有句级字幕引擎的数据结构完全一致，直接喂给播放器。 */
CREATE TABLE IF NOT EXISTS digests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL DEFAULT 'newsreel',
  title        TEXT NOT NULL DEFAULT '',
  subtitle     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'running',
  stage        TEXT NOT NULL DEFAULT '',
  stage_msg    TEXT NOT NULL DEFAULT '',
  progress     INTEGER NOT NULL DEFAULT 0,
  models       TEXT NOT NULL DEFAULT '{}',
  scope        TEXT NOT NULL DEFAULT '{}',
  input_count  INTEGER NOT NULL DEFAULT 0,
  cluster_count INTEGER NOT NULL DEFAULT 0,
  drop_count   INTEGER NOT NULL DEFAULT 0,
  keep_count   INTEGER NOT NULL DEFAULT 0,
  item_count   INTEGER NOT NULL DEFAULT 0,
  cue_count    INTEGER NOT NULL DEFAULT 0,
  script       TEXT NOT NULL DEFAULT '{}',
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  error        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digests_time ON digests(id DESC);
`);

/* ---------- 轻量迁移：无正文来源标记（视频/音频站点） ---------- */
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!hasColumn('sources', 'no_body')) {
  db.exec('ALTER TABLE sources ADD COLUMN no_body INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('articles', 'no_body')) {
  db.exec('ALTER TABLE articles ADD COLUMN no_body INTEGER NOT NULL DEFAULT 0');
}

/* 存量数据回填：已知视频/音频站点直接标记为「无文字正文」 */
db.exec(`
  UPDATE articles SET no_body = 1
  WHERE no_body = 0 AND (
    url LIKE '%bilibili.com%' OR url LIKE '%b23.tv%'   OR url LIKE '%douyin.com%'
    OR url LIKE '%iesdouyin.com%' OR url LIKE '%kuaishou.com%' OR url LIKE '%iqiyi.com%'
    OR url LIKE '%v.qq.com%'   OR url LIKE '%youku.com%'  OR url LIKE '%acfun.cn%'
    OR url LIKE '%youtube.com%' OR url LIKE '%youtu.be%'  OR url LIKE '%ixigua.com%'
    OR url LIKE '%ximalaya.com%' OR url LIKE '%music.163.com%'
  )
`);

export function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
