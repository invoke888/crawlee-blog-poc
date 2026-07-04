# 采集运维观测与管理系统 · 完整方案计划书 v3(终版 · 5 agent 审计合入)

> **状态:** 老板拍板 + 5 维度审计(对接/博文/调度/错误/代理池)57 条发现全部终审合入 · 全部拍板完毕 · 冻结执行
> **执行方:** 另一个 Claude 实例(本文档自包含)
> **执行前必读:** 本文档 + `docs/handoff-crawlee-poc-p2-2026-07-03.md` + `~/.claude/projects/-Users-lindashuai-Desktop-project-crawlee/memory/MEMORY.md`(全部条目,特别是 🔴)
> **UI 布局基准:** `docs/mockup-ops-b.html`(方案 B 深色控制台 · 老板拍板)· 审计资产:`docs/research/plan-audit-2026-07-04/`

---

## 0. 老板拍板记录(不许翻案)

| # | 决策 | 拍板 |
|---|---|---|
| 组件 | **两大组件 · 一个项目 · 一份数据** | 程序 = **采集器**(现有 src/)+ **运维台**(调度器+分析器+推送器+前后端一体,ops/)。同一 git 仓库、同一 SQLite 库、经 shared/ 共享数据层。现有架构可调整但**不影响采集逻辑** |
| 契约 | **采集器保持简单 · 可单独调试** | 采集器只做"抓 → dataset + 统计"。入参全部可选 env(RUN_ID / ONLY_SYMBOLS / 配置覆盖),**零参数裸跑 = 现有行为**。永远不做:push、调度、告警、articles 维护。未来 Claude 改规则只碰 src/,运维台零感知 |
| push | **push 归运维台**(不归采集器) | 理由:push 失败可在面板手动重试。ops/pusher.ts,数据源 = articles 表,按 url 合并 token list,首次接通存量不推(push 记忆铁律) |
| 单源 | **采集器支持单源采集** | `ONLY_SYMBOLS=SEI` env,由运维台调用(源详情"单独重采"按钮 / 规则改后验证) |
| 配置 | **可配置项全部单一真相** | 运行参数进 SQLite(app_config/proxy_config),面板写、采集器每批次读同一张表 — 物理上杜绝"面板改了采集器没变"。规则文件(filter-config/source-rules/URL_OVERRIDES)仍走 git + Claude |
| 代理 | **代理池前端可配置** | 三池连接串进 `proxy_config` 表 · 设置页查看(脱敏)/编辑/连通测试 · 下批次生效 · 改动记审计 |
| A | UI 只读 + **写操作白名单** | 白名单 = { 告警 ack · 手动触发批次 · 暂停/恢复调度 · 代理池配置(含测试)· push 手动重推 } — 全部为老板逐项点名的功能。规则/名单改动仍 100% 走 Claude + git |
| B | 无"全量/增量"双模式 | 唯一模式 = seen-store 常规批次。reset = 运维动作(精确范围见 §2) |
| C | 告警通道 | C1 UI 页内 + C3 预留 notify() 钩子 |
| D | 访问方式 | 公网 + 密码;**因代理池可写(密钥过公网),传输加密(HTTPS)提前到一期强制**(nginx/caddy 套证书,服务器无则装 Caddy 单二进制;不改变"公网+密码"拍板,只加密传输层) |
| E | 分期 | 一期闭环(账本+调度+检测+push+六页);二期(probe 巡检 / FTS 全文检索 / seen 裁剪) |
| UI | **方案 B 深色控制台 · 一期六页** | 总览 / 告警 / 源管理 / 博文管理 / 错误日志 / **设置**(代理池+运行参数) |
| 调度 | **废弃 systemd timer** | 调度完全内置运维台进程(scheduler.ts)。改频率改配置即热生效,不碰 systemctl |
| — | 部署 | 批次不做 git pull;代码更新走人工 push/pull |
| ✅ | 运维台进程守护 | **C · 极简 systemd service 仅保活**(2026-07-04 老板拍"就以目前":Restart=always 一行 · 无任何 timer · 调度职责 0% 在 systemd)|

**终审定案表**(审计拍板点中按既有拍板/项目原则直接定案的,老板可扫一眼,有异议随时翻):

| 定案 | 依据 |
|---|---|
| reset 固化为 `ops/reset.ts` 脚本,禁止现场手打 rm | 防误删不可逆资产 |
| 手动触发忙时**拒绝**(409),schema 预留 queued 二期升级 | 简单优先 |
| 正文搜索 = 标题/摘要 + **body_excerpt(全文前 3000 字)**,FTS 二期 | detailHandler 已算全文,加字段成本极低;纯"摘要搜索"会让博文页货不对板 |
| 裸跑保留为调试用途 + run-batch 每轮启动**补漏扫描**(dataset 有而 articles 无的条目补录) | 一个机制同时兜住裸跑数据和崩溃窗口,两份真相自动收敛 |
| errorHandler + failedRequestHandler **都接**(retries 区分"重试后成功/最终失败") | mockup ACX 行(老板拍的基准)结构上依赖它 |
| crawl_errors 加 `retry_after_s` 结构化列 | 429 的"该等多久"是关键运维信号 |
| 代理池保存防呆 = **软阻断**(测试失败可二次确认强制存,记 saved_despite_test_failure) | 硬阻断在"池子已死急需换池"的救火场景自锁 |
| throttled_domains(域→池映射)**不进前端**,走 git | 业务规则深耦合 filter-config,老板拍的是"代理数据"非分流规则 |
| rss 直拉走主力池是**有意设计**(60 源是 ghost/wp 非 medium 域),UI 文案照代码事实写 | 本项目 2026-07-03 决策确认 |
| 暂停不自动恢复,UI 显示"已暂停 N 天" | 防反直觉强制恢复 |

---

## 1. 背景与现状

### 1.1 系统是什么
Crawlee Node 爬虫,采集 634 个加密项目官方博客(当前有数据源 501)。服务器 hk-prod(119.28.68.105 · 2c4G · `~/crawlee-blog-poc/`)。三代理池 + 五路并行管线(medium RSS / substack 直拉 / paragraph RSS / 通用 RSS 直拉 / article-detail HTML)。单轮 ~5.5 分钟。

### 1.2 现有数据资产
| 资产 | 位置 | 说明 |
|---|---|---|
| 源注册表 | `storage/sources.db` | 634 源。账本/articles/配置新表**全部加进同一个库** |
| 采集产出 | `storage/datasets/default/*.json` | crawlee 原生,每博文一 JSON |
| 已见清单 | KV `seen-articles` | 增量核心。无限增长(裁剪二期,`seen_store_bloat` 告警盯着) |
| 原文库 | KV `raw-html` | 每 URL 最新 HTML |
| 采集规则 | `src/utils/filter-config.json` + `source-rules.json` + `config.ts URL_OVERRIDES` | git 管 · Claude 改 · 面板只读展示 git 版本 |
| 静态报告 | `docs/poc-report.html` | 保留不动,与 dashboard 并存 |
| 运行日志 | `storage/main-run.log` | 现状每轮覆盖 → 本项目改为按批次归档(§5.4) |

### 1.3 痛点
①失效不自知(LAZIO 改版/POKT 迁域/feed 失效全靠抽查)②运行不留痕(log 覆盖、无批次账)③无调度(timer 停用、无重叠保护)④无运营视图。

### 1.4 核心设计判断
**站点变更没有万能检测器,通用信号是"这轮和上轮不一样"。** 地基 = 每轮记账 → 环比对照 → 出告警,零额外请求覆盖一切变更形态。probe 巡检(二期)是早期信号补充。

---

## 2. 概念模型

| 概念 | 定义 |
|---|---|
| **采集批次(crawl run)** | 唯一运行模式。跑 src/main.ts:入口每轮重抓(RUN_SALT),文章级 seen-store 去重。首轮 seen 空 = 天然全量效果。**注意:`RUN_SALT` 是 main.ts 内部去重盐(`run-<epoch毫秒>`,任何跑法都生成),与账本 `RUN_ID`(`run-<ISO时间戳>`,run-batch 注入,裸跑时不存在)是两个完全独立的标识,禁止合并或互相替代** |
| **重置(reset)** | 运维动作。**精确范围 = `rm -rf storage/datasets storage/request_queues storage/key_value_stores`,明确不清 `storage/sources.db`**(registry+账本+articles+配置永久保留 — is_after_reset 标志的意义正建立在账本跨 reset 存活上)。固化为 `ops/reset.ts` 脚本执行,禁止现场自由解读"清 storage"手打 rm。仅大规则变更后由 Claude 手动执行。reset 后 articles 保留但其 dataset/raw-html 原文已清 — 博文详情接口必须做存在性判断(§7.1) |
| **单源采集** | `ONLY_SYMBOLS=SEI,GLM` env → main.ts 源过滤链后一行 filter。运维台源详情"单独重采"按钮触发(runs.batch_type='single') |
| **巡检批次(probe run)** | 二期。零采集健康探测(生产指纹),对比上次结构 diff |
| **告警(alert)** | 状态机:open → 持续(同告警只更新 last_run)→ resolved(条件连续 2 轮消失自动关)/ ack |

---

## 3. 总体架构

```
┌────────────────────── 一个项目 · 一个 git 仓库 ──────────────────────┐
│  ┌── 采集器 collector(src/ · 逻辑不动)──┐                            │
│  │ main.ts 五路管线 · handlers · 规则     │◀── spawn(RUN_ID/ONLY_SYMBOLS)│
│  │ 轮末:persistSeen → ledger 统计(有     │                            │
│  │ RUN_ID 才写 · try/catch 隔离,账本失败  │   ┌── 运维台 ops(常驻进程)─┐│
│  │ 绝不拖垮采集)· 退出码               ──┼──▶│ scheduler.ts(内置调度)  ││
│  └────────────────────────────────────────┘   │ run-batch.ts(批次执行) ││
│                                                │ detector.ts(环比分析)  ││
│      批次收尾(run-batch):                     │ pusher.ts(推送+重试)   ││
│      ①收割 dataset 新增 → articles              │ server/(API+六页前端)  ││
│      ②补漏扫描(裸跑/崩溃窗口兜底)             └─────────────────────────┘│
│      ③detector → alerts  ④pusher → hhwl                                  │
│  ┌────────── shared/ 共享数据层(唯一数据通道)──────────────────────┐   │
│  │ db.ts(连接+全部 schema:registry+账本+配置 · WAL)                │   │
│  │ ledger.ts(账本读写)· run-stats.ts(埋点 counter)                │   │
│  │ config.ts(app_config 读取:env 显式 > DB > 代码默认)             │   │
│  │ proxy-config.ts(getProxyUrl:DB 优先 env 兜底)· proxy-test.ts    │   │
│  │ error-classify.ts(错误分类纯函数)· types.ts                      │   │
│  └──────────────────────┬───────────────────────────────────────────┘   │
│                storage/sources.db(唯一数据库)                           │
└───────────────────────────────────────────────────────────────────────────┘
```

**数据一致性三原则:**
1. **一个库**:registry + 账本 + articles + app_config + proxy_config 全在 sources.db。
2. **一个访问层**:碰库只经 shared/。`src/registry/db.ts` 改造**分三步,不是简单 re-export**(审计 A1 实锤:它是有状态模块,引用的 config.ts 先例是纯函数,不对等):①shared/db.ts 的 schema 初始化**合并** `src/registry/schema.sql`(sources 表)与全部新表,统一一次 `CREATE TABLE IF NOT EXISTS`;②`upsertSource/updateProbe/listSources/countSources/SourceRow` 迁入 shared(db.ts 或 shared/registry.ts),registry/db.ts 才改纯 barrel re-export;③对 8 个调用方(main/probe/fetch-sources/report/run-mirror/run-substack/run-paragraph/scripts/detect-feed)逐个 `tsc --noEmit` + 跑通验证。
3. **一个写入点**:registry←fetch-sources · 账本统计←采集器轮末 · articles/补漏←run-batch · alerts←detector · push 状态←pusher · proxy_config/app_config←dashboard。

**采集器↔运维台交互契约:**
- run-batch `spawn('npx',['tsx','src/main.ts'],{env:{RUN_ID,...}})`,stdout/stderr 管道到 `storage/logs/<run_id>.log`(main-run.log 覆盖式废弃)。
- **RUN_ID 网关覆盖全部账本写入点**(不止 writeSourceRuns):收敛为单入口 `ledger.flushRun(stats, errors)`,内部统一判 `process.env.RUN_ID`,无则丢弃缓冲(裸跑不记账是拍板行为)。防止 main.ts 散落多处 if 漏改。
- **账本写入失败隔离**:flushRun 内部 try/catch,失败仅 console.error,**绝不上抛**;`persistSeen()` 排在账本写入之前 — 账本挂了最坏丢一轮统计,不丢采集产出、不丢去重状态。
- **main.ts 崩溃容错**:`await Promise.all(jobs)` 包 try/catch:catch 后照常 persistSeen + 按已完成管线**部分写账本**,再 `process.exitCode=1` 退出。run-batch 收到非零码仍查 source_runs,有部分数据则 status=failed + notes 注明"部分管线成功 N/5"。
- **SIGTERM 收尾**:main.ts 注册 SIGTERM handler(persistSeen + 部分账本 → exit 1);run-batch 超时先 SIGTERM,10s 宽限后 SIGKILL — 超时被杀不再丢整轮 seen。
- **补漏扫描**:run-batch 每轮启动时扫 dataset 中"已在文件、不在 articles 表"的条目补 upsert — 同时兜住裸跑产物和 run-batch 崩溃窗口(seen 已提交但 articles 未写)两类静默缺口。
- **ops 进程自加载 .env.local**:`ops/server/index.ts` 入口显式 `dotenv.config({path:'.env.local'})`(不依赖启动脚本 source,消除"忘 source 裸跑无代理"事故)。

### 目录规划

```
crawlee-blog-poc/
├── src/                       # 【采集器】逻辑不动 · 只加:埋点调用 / SIGTERM handler / try-catch / ONLY_SYMBOLS filter / 配置读取替换
│   └── registry/db.ts         # 三步改造后为 barrel(见上)
├── shared/                    # 【共享数据层】
│   ├── db.ts · ledger.ts · run-stats.ts · config.ts · proxy-config.ts · proxy-test.ts · error-classify.ts · types.ts
├── ops/                       # 【运维台】
│   ├── scheduler.ts           # 内置调度(tick + schedule_state 持久化 + 心跳)
│   ├── run-batch.ts           # 批次执行(占位→spawn→超时→收割→补漏→detector→pusher)
│   ├── detector.ts            # 环比检测(纯函数 · 单测全覆盖)
│   ├── pusher.ts              # push 推送 + 重试(src/push.ts 迁入,采集器零 push 职责)
│   ├── reset.ts               # reset 固化脚本(精确三目录)
│   ├── server/index.ts        # node:http + basic auth + API + 静态托管
│   ├── public/                # 六页前端(按 mockup-ops-b.html)
│   ├── deploy/                # 进程守护物料(按 §5.6 拍板结果)+ Caddy/nginx HTTPS 配置样例
│   └── README.md              # 装/卸/改频率/改阈值/reset/换池 SOP + 磁盘预算
└── test/                      # detector/ledger/error-classify/display 单测并入 npm test
```

---

## 4. 共享数据层 · schema(全在 storage/sources.db · WAL)

> 保留策略总则:runs/source_runs/articles/alerts/config 类**永久保留**(资产化历史);crawl_errors 与 storage/logs/ **30 天清理**(run-batch 收尾执行)。`base_symbol` 各表均为写入时快照,改名不回溯,精确检索以 token_id 为准。

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,           -- 'run-<ISO时间戳>'
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_s REAL,
  status TEXT NOT NULL,              -- running/ok/failed/timeout/skipped_overlap/queued(二期)/crashed(崩溃恢复判定)
  triggered_by TEXT NOT NULL DEFAULT 'scheduler',  -- scheduler/manual
  batch_type TEXT NOT NULL DEFAULT 'crawl',        -- crawl/single/probe(二期)/browser(未来)
  scope TEXT,                        -- batch_type=single 时记 symbols
  is_after_reset INTEGER DEFAULT 0,
  dataset_added INTEGER, requests_total INTEGER, requests_failed INTEGER,
  sources_with_new INTEGER, alerts_opened INTEGER, rpm_actual REAL,
  git_commit TEXT,
  proxy_main_hash TEXT, proxy_medium_hash TEXT, proxy_slow_hash TEXT,  -- 当轮生效池指纹(sha256 前12位 · 换池归因)
  exit_code INTEGER, exit_signal TEXT,
  log_path TEXT,                     -- storage/logs/<run_id>.log
  notes TEXT
);

CREATE TABLE IF NOT EXISTS source_runs (
  run_id TEXT NOT NULL, token_id INTEGER NOT NULL, base_symbol TEXT, crawler TEXT,
  items_added INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
  http_403 INTEGER DEFAULT 0, http_404 INTEGER DEFAULT 0,
  http_429 INTEGER DEFAULT 0, timeout INTEGER DEFAULT 0, proxy_error INTEGER DEFAULT 0,  -- 与 kind 对齐的环比列
  blocked_noise INTEGER DEFAULT 0, blocked_external INTEGER DEFAULT 0, blocked_error_page INTEGER DEFAULT 0,
  list_candidates INTEGER, feed_items INTEGER,
  PRIMARY KEY (run_id, token_id)
);

CREATE TABLE IF NOT EXISTS articles (
  url TEXT NOT NULL, token_id INTEGER NOT NULL, base_symbol TEXT,
  title TEXT, h1 TEXT,               -- h1/jsonld_description 与 dataset 对齐存原始值
  description TEXT, jsonld_description TEXT,
  body_excerpt TEXT,                 -- 全文前 3000 字(detailHandler 始终填 · RSS 类为 snippet)· 正文搜索用 · FTS 二期
  published_at TEXT, crawler TEXT,
  first_run_id TEXT, crawled_at TEXT,   -- 均为首采信息 · UPDATE 不覆盖
  last_seen_at TEXT,                    -- 每次 upsert 刷新
  push_status TEXT DEFAULT 'none',      -- none/pushed/failed/skipped_backlog(存量·铁律不推·push 上线时一次性回填)
  pushed_at TEXT, push_error TEXT, push_retries INTEGER DEFAULT 0,
  PRIMARY KEY (url, token_id)
);
-- 🔴 UPSERT 铁律(COALESCE 教训 · registry updateProbe 先例):禁止整行覆盖。
-- ON CONFLICT DO UPDATE 只刷新 last_seen_at(以及内容列的空值回填);
-- first_run_id/crawled_at/push_* 一律不出现在 SET 列表。展示层 title/desc 切换
-- 在 API 读取时按 token 分组现算(直接 import src/utils/display-fields.ts,不造第三份实现)。
-- push 回写:UPDATE ... WHERE url=?(不带 token_id · 合并推送后同 url 姊妹行状态一致)。

CREATE TABLE IF NOT EXISTS crawl_errors (
  err_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, token_id INTEGER, base_symbol TEXT, url TEXT,
  kind TEXT NOT NULL,     -- proxy_error/unreachable/timeout/http_403/http_404/http_429/http_4xx/http_5xx/
                          -- tls_error/parse_error/cf_challenge/soft_404/error_page/internal
  http_status INTEGER, retry_after_s INTEGER,   -- 429/503 的 Retry-After(解析不到则拼进 message)
  error_code TEXT,        -- Node error.code(ECONNRESET 等 · 机器可读,分类判定依据)
  message TEXT,           -- 原文截 300(人读辅助,不作分类依据)
  retries INTEGER,        -- 该行产生时已重试次数(errorHandler 每次尝试失败都记一行 · failedRequestHandler 终判行)
  at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_state (
  schedule_name TEXT PRIMARY KEY,    -- 'crawl'(一期唯一)
  interval_ms INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,         -- 🔴 调度节奏持久化 · 重启不失忆
  paused INTEGER NOT NULL DEFAULT 0, paused_at TEXT,
  last_tick_at TEXT,                 -- 心跳 · UI 距今>5min 标 ⚠️(调度循环卡死信号)
  last_triggered_run_id TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER, base_symbol TEXT,
  type TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  first_run_id TEXT, last_run_id TEXT,
  detail TEXT,   -- 必须带原因分布(从 crawl_errors 聚合 kind:如 "12/12 失败 · http_403×8 + timeout×4")
  created_at TEXT, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS push_runs (
  run_id TEXT PRIMARY KEY, pushed INTEGER, ok INTEGER, failed INTEGER, skipped INTEGER, detail TEXT
);

CREATE TABLE IF NOT EXISTS app_config (   -- 运行参数单一真相(面板写 · 采集器/调度读)
  key TEXT PRIMARY KEY, value TEXT, value_type TEXT,  -- string/number/bool/secret
  category TEXT,       -- schedule/concurrency/crawl/push/alerts
  label TEXT,          -- 面板中文名
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS proxy_config (
  pool TEXT PRIMARY KEY,             -- 'main'/'medium'/'slow'(封闭三值)
  value TEXT NOT NULL,               -- 明文连接串(安全水位与 .env.local 对等 · 不做应用层加密防套娃)
  updated_at TEXT NOT NULL, updated_by_ip TEXT,
  last_test_at TEXT, last_test_ok INTEGER, last_test_egress_ip TEXT, last_test_latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS config_audit (  -- 面板每次修改留痕(独立表 · 不塞 alerts 状态机)
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT NOT NULL,          -- 'proxy.main' / 'app.general_rpm' …
  old_value_masked TEXT, new_value_masked TEXT,    -- secret 永远脱敏
  old_value_hash TEXT, new_value_hash TEXT,        -- 与 runs.proxy_*_hash 关联归因
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
-- sources 表加 last_article_at 列(run-batch 批末物化),/api/sources 不实时扫 articles
```

**采集器埋点(src/ 改动面):** `shared/run-stats.ts` 内存 counter,handlers 现有 log 点旁一行埋点(对照:`⊘ 外链拦截`→blocked_external · `📋 [LIST] 候选 N`→list_candidates · `✅ [rss] N items`→feed_items)。**错误采集**:每 crawler 同时挂 `errorHandler`(每次尝试失败,含最终成功的)+ `failedRequestHandler`(终判失败),经 `shared/error-classify.ts` 分类入缓冲;**BAD_TITLE_RE/LIST_TITLE_RE 命中(HTTP 200 软错误页)也写一行**:`just a moment`→cf_challenge · `404|not found`→soft_404 · 其余→error_page(老板要的"网页不可达"最隐蔽一类,不能只有聚合计数)。分类优先级:①HTTP 状态码 ②error.code(ECONNRESET/ETIMEDOUT/ENOTFOUND…)③message 正则 ④internal 兜底;仅代理层握手/连接错误才归 proxy_error(防"impit 抛的全算代理错"吃掉细分)。error-classify 单测覆盖全部 kind + "重试后成功/重试耗尽"两形态 fixture。

**articles 收割 + body_excerpt:** detailHandler 新增始终填充的 `body_excerpt`(article/main 全段落文本前 3000 字,与现有 desc 梯队互不影响);RSS 类管线该字段 = snippet。run-batch 收尾从 dataset 收割新增 → 按 §4 UPSERT 铁律入 articles。

---

## 5. 运维台核心模块

### 5.1 调度器(内置 · 废弃 systemd timer)

`ops/scheduler.ts`:server 启动时 `startScheduler()` → `setInterval(tick, 30s)`。每 tick:写 `schedule_state.last_tick_at`(心跳)→ 查 paused(暂停即短路,`next_run_at` 冻结)→ 到点调 `runBatch({trigger:'scheduler'})`。**启动先跑 `recoverFromCrash()`**:①runs 表 `status='running'` 且 started_at 早于 2×超时的孤儿行 → 标 `crashed` + 🔴 `run_interrupted` 告警(修"进程硬死后首页永远显示批次进行中"的假象)②schedule_state 无行则初始化。

`ops/run-batch.ts` 导出 `runBatch(opts)`(调度 tick 与手动触发按钮共用同一入口):
1. 进程内 `activeChild` 判重 + **SQLite 原子占位**(`INSERT ... WHERE NOT EXISTS(running)`,替代 flock — 与"一个库"原则一致,同时防双实例)
2. spawn 采集器(RUN_ID 注入 · stdout→`storage/logs/<run_id>.log`)
3. 超时:SIGTERM → 10s 宽限 → SIGKILL,status=timeout + 🔴
4. exit 回调:finishRun(exit_code/signal)→ `advanceNextRun`(结束时刻+interval)→ 收割 articles + 补漏扫描 → detector → pusher

**手动触发** `POST /api/schedule/trigger`:忙时返 409"当前有批次在跑"(前端按钮 disable + 后端 10s 节流防连点)。**暂停/恢复** `POST /api/schedule/pause|resume`:暂停冻结 next_run_at;恢复时若已过期则下个 tick 补跑 **1 轮**(不补暂停期间全部)。改频率:面板设置页写 app_config → 下个 tick 生效,零重启零 systemctl。

### 5.2 并发(配置中心接管)

**5 处硬编码点逐一迁移(审计实锤,漏一处 = 面板改了某管线没变):**
| 位置 | 参数 | app_config key |
|---|---|---|
| main.ts generalCrawler | RPM 600/300 · cc 20/10 · delay 0/1 | general_rpm/general_cc(保留 PROXY_URL 有无两档回落) |
| main.ts mediumCrawler | RPM 150/60 · cc 5/3 | medium_rpm/medium_cc |
| main.ts slowCrawler | RPM 60 · cc 3 | slow_rpm/slow_cc |
| main.ts mirrorCrawler | RPM 60 · cc 3 | **mirror_rpm/mirror_cc(独立键 · 不与 slow 共用 — P3 mirror 复活后防联动 bug)** |
| handlers/medium.ts `CONCURRENCY=6` + 超时 25s | rss 直拉 worker-pool(独立机制) | rss_cc/rss_timeout_ms |

读取:`shared/config.ts` — 显式 env > app_config(DB)> 代码默认值。每轮记 `rpm_actual` 供调参。其余 A 类项(sitemap 每源 N 条 / LIST 候选上限 / mirror·medium 流开关 / 调度间隔·超时 / 告警阈值 / push 配置)同机制,首次启动从 .env.local/默认值 seed 入库。

### 5.3 重试(三级)
| 级别 | 机制 |
|---|---|
| 请求级 | crawlee retries=2 + SessionPool(现状) |
| 源级 | 入口每轮重抓 = 天然重试;连续失败 → 告警(§6 error_streak) |
| 批次级 | 崩溃 → failed/crashed + 🔴;下个 tick 自然重跑;原子占位防重叠 |

### 5.4 日志归档
批次 stdout → `storage/logs/<run_id>.log`(runs.log_path),30 天清理,README 给磁盘预算(单轮体积×24×30)。错误日志页对超保留期批次显示"明细已超期清理"而非空表。

### 5.5 代理池配置(§0 拍板落地)
- **存储** `proxy_config` 表(§9 红线"不开第二存储"唯一合规解);一次性 seed 脚本从 .env.local 迁入,`getProxyUrl(pool)` = DB 优先 env 兜底。
- **消费点 3 处全改**(grep 实锤):main.ts:361-363 / run-mirror.ts:17 / handlers/medium.ts:127。medium/slow 回落主池的业务语义留在 main.ts 原地。
- **生效** = 下批次(采集器 spawn 新进程天然重读;不做热更新 — 紧急止损组合拳 = 改配置 + 手动触发一轮)。UI 保存提示必须写明"下次批次(预计 HH:MM)生效"。
- **测试** `shared/proxy-test.ts`:服务器侧 impit 生产指纹打 api.ipify.org + **一次直连基线对照**(双失败 = ipify 的锅,只有"直连通、代理挂"才判池坏);测试结果(出口 IP/延迟)落 proxy_config。
- **防呆** 软阻断:保存自动测试,失败返 422 + 详情,二次确认带 force 才写库(记 saved_despite_test_failure)。
- **归因** runs 表三哈希列,换池前后失败率跳变可直查;config_audit 哈希与 runs 哈希可 `=` 关联成完整链路。

### 5.6 运维台进程守护(已拍:C)

| 方案 | 做法 | 代价 |
|---|---|---|
| A | nohup 起 + crontab 每分钟 pgrep 自愈 + @reboot | 零依赖;恢复延迟 1-5 分钟;自写脚本 |
| B | pm2 | 秒级拉起+日志管理;新增常驻依赖(2c4G 需评估) |
| **C(推荐)** | **保留一个极简 systemd service(仅 Restart=always 保活,不含任何 timer)** | 改动最小、瞬时拉起、开机自启、journalctl 兜底;前提 = 确认"废弃 systemctl"指的是**调度职责**不用 systemd,进程保活这个 OS 层职责可以继续借它的手 |

要求(无论选哪个):进程崩溃 N 分钟内自动拉起;存活状态能被运维台**之外**的东西观测(它挂了 dashboard 自己report不了自己)。

---

## 6. 分析器 · 告警规则(detector.ts 纯函数 · 单测覆盖触发/不触发/持续/恢复/reset 跳过)

> 原则:少而准。"没有新文章"是常态不进告警(做成源管理页"最后出文时间"排序)。`is_after_reset` 轮跳过环比类。阈值全部 app_config 可调(error_streak_runs=2 等)。

| type | 条件 | 级别 |
|---|---|---|
| `source_gone` | 近 7 天有产出,**连续 2 轮** requests>0 且全 failed(403/404 占比 100%) | 🔴 |
| `http_shift` | 上轮 2xx 为主 → 本轮 403/404/**429** 为主 | 🔴 |
| `rate_limited` | http_429 占比 >50% 且连续 2 轮(区别断供:提示"放慢"非"查封") | 🟡 |
| `list_shrink` | list_candidates 上轮>5 → 本轮 0(LAZIO 改版模式) | 🟡 |
| `feed_dead` | RSS 源 feed_items 连续 2 轮=0(此前正常) | 🟡 |
| `external_surge` | blocked_external 从 ~0 → 占候选>80%(MET/POKT 门面站模式) | 🟡 |
| `noise_surge` | blocked_noise 暴增且 items_added=0 | 🟡 |
| `error_kind_streak` | 同 (token,kind) 连续 ≥2 轮出错 🟡 / ≥4 轮 🔴("同源同类连续出错"的精确定义) | 🟡/🔴 |
| `pipeline_drop` | 管线新增环比降>70% 且绝对值>50 | 🔴 |
| `unclassified_surge` | 单轮 internal kind 超阈值(分类器遇到新错误模式该扩枚举了) | 🟡 |
| `run_failed`/`run_timeout`/`run_overlap`/`run_interrupted`(crashed) | 批次级 | 🔴 |
| `seen_store_bloat` / `dataset_bloat` | seen>5MB / datasets 目录>500MB | ⚪ |

alerts.detail 统一从 crawl_errors 聚合 kind 分布拼原因("12/12 失败 · http_403×8 + timeout×4"),不许只说"挂了"。收尾调 `notify(alerts)` 空钩子(C3 预留)。

---

## 7. push 模块(ops/pusher.ts · 归运维台)

- 数据源:articles `push_status='none'`。src/push.ts 迁入 ops(采集器零 push 职责)。
- 合并:按 url 聚合 token_id list 推一条(🔴 铁律);回写 `WHERE url=?`(姊妹行同步)。
- 存量:push 上线时一次性 `UPDATE ... SET push_status='skipped_backlog' WHERE crawled_at < 接通时刻`(🔴 铁律:首次接通存量不推 — 用数据圈定,不靠代码记忆)。
- 重试:自动(下批次重推 failed,上限 push_retries N 次)+ **手动**(博文页单条/批量"重推"按钮 — 老板拍的抓手)。push_runs 记账。
- 开关/URL/SECRET 在 app_config(secret 类,面板脱敏)。

---

## 8. dashboard(六页 · 布局基准 mockup-ops-b.html)

### 8.1 后端
node:http 手写路由 · basic auth(.env.local)+ 失败限速 · **HTTPS 一期强制**(§0-D:nginx/caddy 套证书;无则 Caddy 单二进制自动证书)· 端口 8787。

| API | 说明 |
|---|---|
| `GET /api/summary` | 总览统计 |
| `GET /api/schedule/state` | **独立轻量接口**(paused/next_run_at/last_tick_at/active_run)— 供六页共用的栏底调度状态组件,不挂 summary 下 |
| `POST /api/schedule/trigger` / `pause` / `resume` | 写白名单 |
| `GET /api/runs?limit=` / `GET /api/runs/:id` | 批次(带 triggered_by/batch_type/exit_code/log_path) |
| `GET /api/alerts?status=` / `POST /api/alerts/:id/ack` | 告警 |
| `GET /api/sources` | 全源实时(join last_article_at 物化列) |
| `GET /api/sources/:token_id` | 单源详情:30 轮 source_runs + 最近 10 篇 + 告警史 + **近 20 条 crawl_errors**(第四块 · 审计补)+ 「单独重采」按钮 |
| `GET /api/articles?q=&symbol=&crawler=&push=&pub_from=&pub_to=&crawled_from=&crawled_to=&fields=&page=` | 博文列表(q 搜 title/description/**body_excerpt**;fields=缺title/缺desc/缺pub 完整度筛选;每行带 `shared_count` 窗口函数) |
| `GET /api/articles/detail?url=&token_id=` | 单篇详情:摘要字段 + 尝试读 raw-html 正文,读不到返 `full_text_available:false`(reset 前旧文的预期状态,前端提示而非 500) |
| `POST /api/push/retry` | 手动重推(单条/批量) |
| `GET/PUT /api/proxy-config/:pool` + `POST .../test` + `GET .../audit` | §5.5 |
| `GET/PUT /api/app-config` | 设置页运行参数(写 config_audit) |

### 8.2 六页要点(mockup 之外的增补,实现以本节为准)
- **总览**:脉搏行加触发方式图标(⏱/👆)+ "立即跑一轮"按钮;暂停时整块替换"⏸ 已暂停(N 天)+ 恢复按钮";批次健康带四色:绿 ok / 黄 timeout / 红 failed·crashed / **灰 skipped_overlap**(连排灰 = 调度停摆的直观信号);批次表加"触发"列。
- **栏底调度状态**(六页常驻):运行/暂停开关 + 下次倒计时 + 心跳新鲜度(>5min ⚠️)。
- **告警**:detail 展示 kind 分布;跳源详情双向链接。
- **源管理**:行内"单独重采";详情第四块"最近错误"(可跳错误页带筛选)。
- **博文**:筛选加"字段完整度";`shared_count>1` 行标"共享×N" badge(1-to-N 不是重复 bug);push 状态列 + 重推按钮。
- **错误日志**:筛选下拉以 schema kind 枚举为准(mockup 少了 http_4xx/internal,以 schema 为准);超期批次显示"明细已清理"。
- **设置**(第 6 页):代理池三卡(脱敏/跟随主池 badge 照代码事实/编辑分字段/测试×2 处/最近变更折叠)+ 运行参数分组表单(并发/深度/调度/告警/push)+ 只读展示"当前规则版本 git commit"。

---

## 9. 分期与验收

### 一期
| # | 交付物 | 验收标准 |
|---|---|---|
| 1 | shared 层 + registry 三步改造 | `tsc --noEmit` + 8 调用方逐个跑通;裸跑 main.ts(无 RUN_ID)零账本零报错;**采集行为零变化**(改造前后同条件 dataset 一致) |
| 2 | 账本+埋点+错误采集 | 跑批后 runs/source_runs/articles/crawl_errors 完整;errorHandler"重试后成功"行与 failedRequest"终判"行都出现(mockup ACX/QNT 两形态);软错误页(cf_challenge)入账实测;log 对照抽查一致 |
| 3 | run-batch | 占位/超时(SIGTERM 后 seen 保住)/失败/**kill -9 后孤儿 run 回收(crashed)**四路径实测;补漏扫描实测(裸跑一轮 → 下批次 articles 补齐) |
| 4 | 调度(内置) | 24h 无人工干预 ≥24 条 ok;**重启恢复**:kill ops 进程(含批次中途)重启后 next_run_at 正确恢复、孤儿标 crashed+告警;手动触发忙时 409;暂停 30min 零新 run、恢复补跑 1 轮;双实例占位互斥 |
| 5 | detector | 每规则 fixture(触发/不触发/持续/恢复/reset 跳过);实测临时黑名单→source_gone→移回 2 轮自动 resolved;detail 带 kind 分布 |
| 6 | 六页 dashboard | **HTTPS** + 密码;六页数据与 sqlite 直查一致;博文筛选各维度 + 完整度 + 共享 badge;错误页分类抽查 10 条;设置页改并发→下批次 rpm_actual 变化可见;**playwright 六页截图三态附验收** |
| 7 | 代理池配置 | 三池脱敏/跟随 badge 与代码回落一致;3 消费点全切换,下批次 runs 哈希与保存值一致;测试为服务器侧 impit(能区分池故障 vs ipify 故障);测试失败强存被 audit 打标;seed 迁移后老板零手输 |
| 8 | push 模块 | DRY_RUN 通道验证(真推等老板给 URL/SECRET);skipped_backlog 回填 SQL 演练;手动重推按钮生效(dry 模式) |
| 9 | 文档 | ops/README(装/卸/改频率/改池/reset/磁盘预算 SOP)+ handoff 补记 |

### 二期
probe 巡检(结构 diff)· FTS5 全文检索 · seen-store 裁剪 · C3 通道落地 · queued 排队升级 · 多用户审计(如需要)。

---

## 10. 明确不做(YAGNI)
- ❌ UI 改规则/名单/throttled_domains(走 Claude+git;面板只读展示规则版本)
- ❌ 不动采集管线逻辑(src/ 改动仅限:埋点/SIGTERM/try-catch/ONLY_SYMBOLS/配置读取替换/body_excerpt 字段)
- ❌ 不开第二数据库/存储 · ❌ reset 不清 sources.db
- ❌ 不引前端框架/图表库(vanilla JS + 手写 SVG)· 不做用户体系 · 不做代理热更新 · 不做配置应用层加密(套娃)
- ❌ 静态报告链(poc-report)不动

## 11. 给执行 Claude 的指路
1. 铁律:本地改码服务器跑 / probe 一律生产指纹禁裸 curl / 改完 commit+push / 单一真源 / blogpicker 状态不可信 / UI 必 playwright 自验三态。
2. **正式采集一律走 run-batch**;handoff §9 裸跑 SOP 降级为"调试用途"(产物由补漏扫描兜底收敛,但期间 dashboard 会短暂少这批数据 — 预期行为)。
3. 改 src/ 前 grep 调用方;main.ts 尾 `process.exit(0)` 与 SIGTERM handler 共存注意顺序;跑批环境(fnm/CRAWLEE_MEMORY_MBYTES)照 handoff §9。
4. 服务器 2c4G:dashboard <200MB;SQLite WAL;账本写在批次末尾。
5. 完工 = 验收表逐项 + 六页截图 + 24h 真跑数据,才报老板(不当二传手)。

---
*v3 终版 · Claude Fable 5 · 2026-07-04 · 5 agent 审计 57 条全合入 · 已冻结 · 执行中*
