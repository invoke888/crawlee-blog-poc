-- 运维台账本/配置 schema(2026-07-04 计划书 §4 · 与 src/registry/schema.sql(sources 表)同库 storage/sources.db)
-- 保留策略:runs/source_runs/articles/alerts/config 永久;crawl_errors + storage/logs 30 天(run-batch 收尾清理)
-- base_symbol 各表为写入时快照 · 改名不回溯 · 精确检索以 token_id 为准

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_s REAL,
  status TEXT NOT NULL,              -- running/ok/failed/timeout/skipped_overlap/queued(二期)/crashed
  triggered_by TEXT NOT NULL DEFAULT 'scheduler',
  batch_type TEXT NOT NULL DEFAULT 'crawl',   -- crawl/single/probe(二期)/browser(未来)
  scope TEXT,
  is_after_reset INTEGER DEFAULT 0,
  dataset_added INTEGER, requests_total INTEGER, requests_failed INTEGER,
  sources_with_new INTEGER, alerts_opened INTEGER, rpm_actual REAL,
  git_commit TEXT,
  proxy_main_hash TEXT, proxy_medium_hash TEXT, proxy_slow_hash TEXT,
  exit_code INTEGER, exit_signal TEXT,
  log_path TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS source_runs (
  run_id TEXT NOT NULL, token_id INTEGER NOT NULL, base_symbol TEXT, crawler TEXT,
  items_added INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
  http_403 INTEGER DEFAULT 0, http_404 INTEGER DEFAULT 0,
  http_429 INTEGER DEFAULT 0, timeout INTEGER DEFAULT 0, proxy_error INTEGER DEFAULT 0,
  blocked_noise INTEGER DEFAULT 0, blocked_external INTEGER DEFAULT 0, blocked_error_page INTEGER DEFAULT 0,
  list_candidates INTEGER, feed_items INTEGER,
  PRIMARY KEY (run_id, token_id)
);

-- 🔴 UPSERT 铁律:禁整行覆盖 · first_run_id/crawled_at/push_* 不进 SET · 展示切换 API 层现算(display-fields.ts)
CREATE TABLE IF NOT EXISTS articles (
  url TEXT NOT NULL, token_id INTEGER NOT NULL, base_symbol TEXT,
  title TEXT, h1 TEXT,
  description TEXT, jsonld_description TEXT,
  body_excerpt TEXT,
  published_at TEXT, crawler TEXT,
  first_run_id TEXT, crawled_at TEXT,
  last_seen_at TEXT,
  push_status TEXT DEFAULT 'none',   -- none/pushed/failed/skipped_backlog
  pushed_at TEXT, push_error TEXT, push_retries INTEGER DEFAULT 0,
  PRIMARY KEY (url, token_id)
);

CREATE TABLE IF NOT EXISTS crawl_errors (
  err_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, token_id INTEGER, base_symbol TEXT, url TEXT,
  kind TEXT NOT NULL,
  http_status INTEGER, retry_after_s INTEGER,
  error_code TEXT,
  message TEXT,
  retries INTEGER,
  at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_state (
  schedule_name TEXT PRIMARY KEY,
  interval_ms INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0, paused_at TEXT,
  last_tick_at TEXT,
  last_triggered_run_id TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER, base_symbol TEXT,
  type TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  first_run_id TEXT, last_run_id TEXT,
  detail TEXT,
  created_at TEXT, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS push_runs (
  run_id TEXT PRIMARY KEY, pushed INTEGER, ok INTEGER, failed INTEGER, skipped INTEGER, detail TEXT
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY, value TEXT, value_type TEXT,
  category TEXT, label TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS proxy_config (
  pool TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by_ip TEXT,
  last_test_at TEXT, last_test_ok INTEGER, last_test_egress_ip TEXT, last_test_latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS config_audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT NOT NULL,
  old_value_masked TEXT, new_value_masked TEXT,
  old_value_hash TEXT, new_value_hash TEXT,
  test_result TEXT, saved_despite_test_failure INTEGER DEFAULT 0,
  client_ip TEXT, at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_token_crawled ON articles(token_id, crawled_at);
CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_articles_push ON articles(push_status);
CREATE INDEX IF NOT EXISTS idx_source_runs_token ON source_runs(token_id, run_id);
CREATE INDEX IF NOT EXISTS idx_alerts_token_status ON alerts(token_id, status);
CREATE INDEX IF NOT EXISTS idx_crawl_errors_run ON crawl_errors(run_id);
CREATE INDEX IF NOT EXISTS idx_crawl_errors_kind ON crawl_errors(kind);
