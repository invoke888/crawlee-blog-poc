# 采集运维观测与管理系统 · 完整方案计划书(终版)

> **状态:** 老板已拍板(2026-07-04)· 终版 · 敲定后交付执行
> **执行方:** 另一个 Claude 实例(本文档为自包含交接物)
> **执行前必读:** 本文档 + `docs/handoff-crawlee-poc-p2-2026-07-03.md` + `~/.claude/projects/-Users-lindashuai-Desktop-project-crawlee/memory/MEMORY.md`(全部条目,特别是 🔴)

---

## 0. 老板拍板记录(不许翻案)

| # | 决策 | 拍板 |
|---|---|---|
| 组件 | **两大组件 · 一个项目 · 一份数据** | 程序 = **采集器**(现有项目)+ **运维台**(分析器/调度器/前后端一体)。共享同一 git 目录成为一个项目,**使用的数据必须一致**(共享数据层,不许两份真相)。现有架构允许为此调整,**但不影响采集逻辑** |
| A | UI 形态 | **A2 · 常驻只读 dashboard**。规则/名单改动不进 UI(交给 Claude 走 git)。唯一写操作:告警 ack |
| B | 运行模式概念 | **无"全量/增量"双模式**。唯一模式 = 带 seen-store 的常规批次(记住已采 url 下次跳过 = 增量;首轮天然等效全量)。"忽略增量" = 清 seen 的**运维动作**(reset),不是调度概念 |
| C | 告警通道 | **C1 UI 页内 + C3 预留主动推送接口**(通道后续再接) |
| D | 访问方式 | **D2 公网 + 密码** |
| E | 分期 | **E1 一期闭环**(账本+调度+环比告警+核心三页),二期(巡检+博文检索+push 页)在真数据上迭代 |
| — | 部署流程 | 批次脚本**不做 git pull**(老板拍:不必要)。代码更新沿用现有人工流程(本地改→push→服务器 pull) |
| — | 调度四维 | 批次完成时间、频率、并发、重试全部纳入架构(§5/§6) |

---

## 1. 背景与现状(执行 Claude 从这里理解系统)

### 1.1 系统是什么

Crawlee Node 爬虫,采集 634 个加密项目官方博客(当前有数据源 501)。服务器 hk-prod(119.28.68.105 · 2c4G · `~/crawlee-blog-poc/`)。三代理池分流 + 五路并行管线(medium RSS / substack 直拉 / paragraph RSS / 通用 RSS 直拉 60 源 / article-detail HTML)。单轮 ~5.5 分钟。

### 1.2 现有数据资产

| 资产 | 位置 | 说明 |
|---|---|---|
| 源注册表 | `storage/sources.db`(SQLite)| 634 源。**账本新表加进同一个库 = 天然一致** |
| 采集产出 | `storage/datasets/default/*.json` | crawlee 原生产物(每博文一 JSON) |
| 已见清单 | KV `seen-articles` | 增量核心:key=`token_id:url`。已知无限增长(裁剪归二期) |
| 原文库 | KV `raw-html` | 每 URL 最新 HTML(调规则用) |
| 采集规则 | `src/utils/filter-config.json` + `source-rules.json` + `config.ts URL_OVERRIDES` | 采集器业务规则 · 单一真源(TS/python/HTML 三层共读)· **位置不动** |
| 静态报告 | `docs/poc-report.html` | 手动生成的汇报快照。**保留不动**,与 dashboard 并存(一个是给老板的正式汇报物,一个是实时运营视图) |
| 运行日志 | `storage/main-run.log` | 每轮覆盖。handlers 现有 log 点(拦截/入队/成功)是埋点改造的对照表 |

### 1.3 痛点

1. **失效不自知**:站点改版(实锤:LAZIO `/en/news/`→`/en/latest-news/` 规则全拦)、品牌迁域(POKT→pocket.network)、feed 失效 — 只有老板抽查或 agent 战役才发现。
2. **运行不留痕**:log 覆盖、无批次记录 — 「这轮 vs 上轮」「某源最近一周表现」无从查起。
3. **无调度**:timer 已停、手动触发、无重叠保护、无批次失败提醒。
4. **无运营视图**:634 源靠静态快照管理。

### 1.4 核心设计判断

**站点变更没有万能检测器,通用信号是"这轮和上轮不一样"。** 方案地基 = 「每轮记账 → 环比对照 → 出告警」,零额外请求覆盖一切变更形态(改版/停更/反爬升级/规则腐烂/feed 失效)。probe 巡检(二期)是补充:发现"还没影响采集但结构已变"的早期信号。

---

## 2. 概念模型

| 概念 | 定义 |
|---|---|
| **采集批次(crawl run)** | 系统唯一运行模式。跑现有 main.ts:入口每轮重抓(RUN_SALT),文章级 seen-store 去重 → 每轮只新增未见博文。首轮 seen 空 = 天然全量效果 |
| **重置(reset)** | 运维动作(非调度概念):清 `storage/` 重新累积。仅大规则变更后由 Claude 手动执行。账本 runs 表有 `is_after_reset` 标志(防环比"新增暴涨"误报) |
| **巡检批次(probe run)** | 二期。零采集纯健康探测:对每源发 2-3 个轻量请求(blog_url 通不通 / 是否 301 搬家 / feed 还是不是 XML / sitemap 还在不在),对比上次巡检发现结构变更。周级低频不打扰站点。复用现成 `scripts/detect-feed.ts` / `audit-probe.ts` 的探测方式(生产指纹) |
| **告警(alert)** | 状态机事件:open(新发)→ 持续(同告警只更新,不重复轰炸)→ resolved(条件消失自动关)/ ack(老板 UI 标已读) |

---

## 3. 总体架构:两组件 + 共享数据层(本版核心修正)

```
┌─────────────────── 一个项目 · 一个 git 目录 ───────────────────┐
│                                                                │
│  ┌──── 采集器 collector ────┐      ┌──── 运维台 ops ─────────┐  │
│  │ src/(现有 · 逻辑不动)   │      │ 调度器:systemd timer    │  │
│  │ main.ts 五路管线          │      │ 执行:run-batch.ts       │  │
│  │ handlers / utils / 规则   │      │ 分析器:detector.ts      │  │
│  │ 轮末:ledger.write(stats) │      │ 后端:server(只读 API) │  │
│  └───────────┬──────────────┘      │ 前端:public(三页)     │  │
│              │                      └───────────┬─────────────┘  │
│              ▼                                  ▼                │
│  ┌──────────────── shared/ 共享数据层(唯一数据通道)─────────┐  │
│  │ db.ts(SQLite 连接 + 全部表 schema:registry + 账本)       │  │
│  │ ledger.ts(账本读写 API:两组件都只经这里碰账本)           │  │
│  │ schedule-config.json + config.ts(频率/并发/阈值 单一真源)  │  │
│  │ types.ts(Run/SourceRun/Alert/Article 类型定义)            │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           ▼                                      │
│              storage/sources.db(唯一数据库)                     │
└──────────────────────────────────────────────────────────────────┘
```

**数据一致性三原则(老板拍板的落地):**

1. **一个库**:registry + 账本 + articles 全在 `storage/sources.db`,不开第二个存储。
2. **一个访问层**:任何组件碰数据库只经 `shared/db.ts` + `shared/ledger.ts`(schema 单处定义,两边 import 同一模块 — 不存在"采集器写的字段运维台不认识")。现有 `src/registry/db.ts` 改为 **re-export shared/db.ts**(项目有先例:config.ts re-export article-filter),调用方 import 路径不变 = **采集逻辑零影响**。
3. **一个写入点**:每类数据只有一个写入者 — registry:fetch-sources(现状)· 账本统计:采集器轮末经 ledger 写 · articles:run-batch 从本轮新增同步 · alerts:detector。谁写谁负责,不交叉。

**统计传递修正**(废除上版的 run-stats.json 文件中转):main.ts 轮末直接调 `ledger.writeSourceRuns(runId, stats)`。`RUN_ID` 由 run-batch 经环境变量传入;**手动裸跑 main.ts(无 RUN_ID)时跳过账本写入** — 向后兼容,采集器单独跑完全不依赖运维台。

**配置边界**:`shared/schedule-config.json` = 跨组件运行参数(频率/并发/阈值);`src/utils/filter-config.json` 等 = 采集器业务规则(位置语义不变)。采集器启动读 shared 的并发参数(缺省回落现有代码默认值 — 兼容)。

### 目录规划(共享现有仓库)

```
crawlee-blog-poc/
├── src/                       # 【采集器】现有 · 逻辑不动 · 只加 ledger 埋点调用
│   └── registry/db.ts         # 改为 re-export shared/db.ts(import 路径兼容)
├── shared/                    # 🆕【共享数据层】两组件唯一数据通道
│   ├── db.ts                  # SQLite 连接 + 全部表 schema(迁移:CREATE TABLE IF NOT EXISTS)
│   ├── ledger.ts              # 账本读写 API(writeRun/writeSourceRuns/upsertAlert/queryXxx)
│   ├── run-stats.ts           # 进程内统计 counter(采集器埋点用)
│   ├── schedule-config.json   # 频率/并发/阈值 单一真源
│   ├── config.ts              # schedule-config 读取模块
│   └── types.ts               # Run/SourceRun/Alert/Article 类型
├── ops/                       # 🆕【运维台】分析器+调度器+前后端一体
│   ├── run-batch.ts           # 批次执行(锁→run→统计→检测→收尾)
│   ├── detector.ts            # 分析器:环比检测(纯函数 · 单测覆盖)
│   ├── server/index.ts        # 后端:node:http + basic auth + 只读 API + 静态托管
│   ├── public/                # 前端:index.html(总览)/ alerts.html / sources.html
│   ├── systemd/               # crawl.service/timer · dashboard.service · install.sh
│   └── README.md              # 装/卸/改频率/改阈值 SOP
├── scripts/                   # 现有工具脚本不动(报告链/探针)
└── test/                      # detector/ledger 单测并入现有 npm test
```

---

## 4. 共享数据层 · schema(全部在 storage/sources.db)

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,           -- 'run-<ISO时间戳>'
  started_at TEXT NOT NULL,
  finished_at TEXT,                  -- 批次完成时间(老板点名)
  duration_s REAL,
  status TEXT NOT NULL,              -- running / ok / failed / timeout / skipped_overlap
  is_after_reset INTEGER DEFAULT 0,
  dataset_added INTEGER,
  requests_total INTEGER,
  requests_failed INTEGER,
  sources_with_new INTEGER,
  alerts_opened INTEGER,
  rpm_actual REAL,                   -- 实际吞吐(并发利用观测)
  git_commit TEXT,                   -- 代码/规则版本(追溯"哪版开始坏")
  notes TEXT
);

CREATE TABLE IF NOT EXISTS source_runs (
  run_id TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  base_symbol TEXT,
  crawler TEXT,
  items_added INTEGER DEFAULT 0,     -- 新增情况
  requests INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,          -- 失败情况
  http_403 INTEGER DEFAULT 0,
  http_404 INTEGER DEFAULT 0,
  blocked_noise INTEGER DEFAULT 0,   -- 规则拦截(规则匹配情况)
  blocked_external INTEGER DEFAULT 0,-- 外链拦截(门面站信号 · MET/POKT 实锤)
  blocked_error_page INTEGER DEFAULT 0,
  list_candidates INTEGER,           -- LIST 候选数(骤降=改版信号 · LAZIO 实锤)
  feed_items INTEGER,                -- feed 源 item 数(0=feed 失效信号)
  PRIMARY KEY (run_id, token_id)
);

CREATE TABLE IF NOT EXISTS articles (  -- 🆕 博文查询真源(dashboard/分析器读这里 · 不扫 dataset 文件)
  url TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  base_symbol TEXT,
  title TEXT, description TEXT,      -- 摘要级(全文仍在 dataset/raw-html)
  published_at TEXT,
  crawler TEXT,
  first_run_id TEXT,                 -- 哪轮采到的
  crawled_at TEXT,
  PRIMARY KEY (url, token_id)        -- 1-to-N 共享博客兼容(push 记忆:同 url 多 token 合法)
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER,                  -- NULL = 批次级
  base_symbol TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,            -- red / yellow / info
  status TEXT NOT NULL DEFAULT 'open',
  first_run_id TEXT, last_run_id TEXT,
  detail TEXT,                       -- 人话+数据("候选 12→0 · 疑似改版")
  created_at TEXT, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS push_runs ( -- 二期激活 · 表先建
  run_id TEXT PRIMARY KEY,
  pushed INTEGER, ok INTEGER, failed INTEGER, detail TEXT
);
```

**采集器埋点改造(src/ 唯一改动面 · 外科手术):** 新建 `shared/run-stats.ts`(内存 counter,按 token_id 累计),在 handlers 现有 log 点旁一行式埋点(`stats.count(tokenId, 'blocked_external')` — 对照表:`⊘ 外链拦截`→blocked_external · `📋 [LIST] 入队 N 候选 M`→list_candidates · `✅ [rss] N items`→feed_items 等)。main.ts 轮末:有 `RUN_ID` 环境变量 → `ledger.writeSourceRuns()`;无 → 跳过。**不改任何采集行为。**

**articles 写入:** run-batch 在采集结束后,把本轮新增(dataset 中 crawledAt > started_at 的条目)upsert 进 articles 表。唯一写入点,与 dataset 同轮同源 = 一致。

---

## 5. 调度 / 并发 / 重试(老板点名四维度)

### 5.1 频率

`shared/schedule-config.json`:

```json
{
  "crawl_interval": "hourly",
  "batch_timeout_min": 30,
  "probe_interval": "weekly",
  "concurrency": { "general_rpm": 600, "general_cc": 20, "medium_rpm": 150, "medium_cc": 5, "slow_rpm": 60, "slow_cc": 3, "rss_cc": 6 },
  "alert_thresholds": { "list_shrink_min": 5, "pipeline_drop_pct": 70, "stale_days_info": 30 }
}
```

- systemd `crawl.timer` 按 interval 安装(改频率 = 改 json + `ops/systemd/install.sh` 重装)
- 单轮 ~5.5min,hourly 负载很轻;频率调整有账本数据支撑后再优化
- Playwright 未来 = 新增批次类型(browser run),本架构直接容纳

### 5.2 并发

- 现有三池 RPM/并发常量提升为读 `shared/config.ts`(缺省回落现有默认值 · 向后兼容)
- 每轮记 `rpm_actual` → 总览页展示 → **调参有数据依据**

### 5.3 重试(三级)

| 级别 | 机制 | 状态 |
|---|---|---|
| 请求级 | crawlee `maxRequestRetries=2` + SessionPool 换 session | ✅ 现状已有 |
| 源级 | 入口每轮 RUN_SALT 必重抓 = 失败源下轮**天然重试**;连续失败升级为告警(不无限静默重试) | ✅ 机制现有 + 🆕 告警 |
| 批次级 | 整轮崩溃 → runs.status=failed + 🔴 告警;timer 下周期自然重跑;flock 互斥(上轮未完 → skipped_overlap 告警) | 🆕 |

### 5.4 互斥与超时

`flock` 锁文件(拿不到 → 记告警退出);run-batch 自我计时,超 `batch_timeout_min` → 杀采集进程 + status=timeout + 🔴 告警。

---

## 6. 分析器 · 告警规则清单(一期 = 环比全套)

`ops/detector.ts`:纯函数读账本(经 shared/ledger),单测全覆盖。**原则:告警少而准 — 博客低频,"没有新文章"是常态不是告警**("最后出文时间"做成源管理页排序列,不进告警)。

| type | 触发条件(阈值在 schedule-config)| 级别 | 含义 |
|---|---|---|---|
| `source_gone` | 近 7 天有产出的源,本轮 requests>0 且全 failed(或 403/404 占比 100%)| 🔴 | 断供(被 ban/站挂/URL 死) |
| `http_shift` | 上轮 2xx 为主 → 本轮 403/404 为主 | 🔴 | 反爬升级或页面消失 |
| `list_shrink` | list_candidates 上轮 >5 → 本轮 0 | 🟡 | **疑似改版**(LAZIO 实锤模式) |
| `feed_dead` | RSS 源 feed_items 连续 2 轮=0(此前正常)| 🟡 | feed 失效/搬家 |
| `external_surge` | blocked_external 从 ~0 → 占候选 >80% | 🟡 | **门面站信号**(MET/POKT 实锤) |
| `noise_surge` | blocked_noise 环比暴增且 items_added=0 | 🟡 | 改版成规则拦不住的形态 |
| `pipeline_drop` | 某管线总新增环比降 >70% 且绝对值 >50 | 🔴 | 管线级故障(如 medium 封池) |
| `run_failed` / `run_timeout` / `run_overlap` | 批次级 | 🔴 | 调度故障 |
| `seen_store_bloat` | seen-articles >5MB | ⚪ | 运维提醒(裁剪归二期) |

**状态机:** 同 (token_id, type) 已有 open → 只更新 last_run_id/detail;条件连续 2 轮不满足 → 自动 resolved;`is_after_reset` 轮跳过环比类检测。
**C3 预留:** detector 收尾调 `notify(alerts)` 钩子 — 一期空实现 + 注释(未来接 TG/webhook/邮件只改这一处)。

---

## 7. 运维台 · dashboard 详设

### 7.1 后端(ops/server/)

- Node/TS,`node:http` 手写路由(不引 web 框架);经 shared/ledger 只读查询
- **basic auth**(D2):账密在服务器 `.env.local`(`DASH_USER/DASH_PASS`,沿用现有密钥惯例不进 git);全路由鉴权 + 失败限速
- systemd `dashboard.service` 常驻(Restart=always);端口默认 8787
- ⚠️ 公网明文 basic auth 风险:执行时二选一 — ①服务器已有 nginx/caddy 则套 HTTPS;②否则强随机长口令 + 非常规端口,"套证书"记二期。不必再问老板

| 只读 API | 内容 |
|---|---|
| `GET /api/summary` | 总览(今日新增/活跃告警数/上次批次状态/下次运行时间/锁状态) |
| `GET /api/runs?limit=50` | 批次时间线 |
| `GET /api/runs/:id` | 单批次 + 该轮 source_runs 摘要 |
| `GET /api/alerts?status=open` | 告警列表 |
| `POST /api/alerts/:id/ack` | 唯一写操作(状态标记) |
| `GET /api/sources` | 全源实时表(join registry+近 N 轮聚合:最后出文时间/近7天新增/失败率/open 告警/disposition) |
| `GET /api/sources/:token_id` | 单源详情(近 30 轮 source_runs + articles 表最近 10 篇 + 告警史) |

### 7.2 前端(ops/public/ · vanilla JS · 延续 poc-report 暖白 serif 视觉)

| 页 | 内容 |
|---|---|
| **总览** | ①调度状态条(上次批次:状态/**完成时间**/耗时 · 下次运行倒计时 · 锁状态)②最近 20 批次时间线卡片(耗时/新增/失败/告警,失败红标)③7 天新增趋势 sparkline(手写 SVG)④管线分布(各管线今日新增) |
| **告警** | open 告警表(级别/类型/源/持续轮数/人话 detail/ack 按钮);已 ack 与已恢复折叠;每条可跳源详情 |
| **源管理** | 全源表(筛选交互沿用报告 §2 习惯:模糊搜/管线/处置/告警筛;列:symbol/URL/管线/**最后出文时间**/近7天新增/近轮失败/告警标)· 点行展开单源详情(近 30 轮新增柱状 + 最近 10 篇博文链接 + 告警史)。不采集源(dead/suspended/excluded)按处置筛可见(= 静态报告 §5 账本的实时版) |

二期:博文全库检索页(articles 表就绪,直接长出)· push 账本页 · 巡检 diff 页。

---

## 8. 分期与验收标准(铁律 6)

### 一期(本计划书交付范围)

| # | 交付物 | 验收标准 |
|---|---|---|
| 1 | shared 共享层(db/ledger/run-stats/config + registry re-export)| `npm test` 全绿;**采集行为零变化**(埋点前后同条件跑,dataset 产出一致);裸跑 main.ts(无 RUN_ID)不写账本、不报错 |
| 2 | 账本(4+1 表 + 埋点)| 跑一轮批次后 runs/source_runs/articles 记录完整,字段与 log 对照抽查一致 |
| 3 | 执行层 run-batch.ts | 锁/超时/失败三路径各实测一次;runs 状态机正确 |
| 4 | 调度 | timer 连续 24h 无人工干预,runs ≥24 条 ok;重叠保护实测(手动占锁 → skipped_overlap) |
| 5 | detector | 单测:每条规则 fixture(触发/不触发/持续/恢复/reset 跳过);实测:临时黑名单一个活跃源 → 下轮 source_gone,移回 → 2 轮后自动 resolved |
| 6 | dashboard 三页 | 公网密码可访问;三页数据与 sqlite 直查一致;ack 生效;**playwright 截图三页附验收报告**(铁律:UI 必真访问自验) |
| 7 | 文档 | ops/README.md(装/卸/改频率/改阈值/reset SOP)+ handoff 补记 |

### 二期(账本跑出真数据后另出计划)

巡检批次(结构 diff 告警)· 博文检索页 · push_runs 激活(等 push 对接 · 注意 push 记忆:同 url 多 token 合并一条 + 首次接通存量不推)· seen-store 裁剪 · C3 通道落地 · HTTPS 完善。

---

## 9. 明确不做(YAGNI · 防执行跑偏)

- ❌ UI 改规则/名单(A2:规则改动走 Claude + git)
- ❌ 不动采集管线逻辑(五路并行/三池/seen-store/规则体系原样;src/ 只加埋点调用 + registry/db.ts re-export)
- ❌ 不搞"全量/增量"模式切换(概念已废,§2)
- ❌ 不引前端框架/组件库/图表库(vanilla JS + 手写 SVG)
- ❌ 不开第二个数据库/存储(一切进 sources.db)
- ❌ 不做用户体系(单账号 basic auth)
- ❌ 静态报告链(poc-report)不动 — 与 dashboard 并存,各司其职

---

## 10. 给执行 Claude 的上下文指路(必读)

1. **项目铁律**(memory 有档,违者返工):本地只改代码、服务器跑数据(SSH 模板见 handoff §9);诊断一律 `scripts/probe-fetch.ts` 生产指纹,**严禁裸 curl**;改完必 commit+push;单一真源哲学;blogpicker 状态不可信。
2. **改 src/ 前**:grep 调用方;main.ts 尾部 `process.exit(0)`(run-batch 要感知退出码);服务器跑批环境(fnm/env/`CRAWLEE_MEMORY_MBYTES`)照抄 handoff §9;registry/db.ts 改 re-export 时先 grep 全部 import 方确认签名不变。
3. **服务器资源**:2c4G;dashboard 内存预算 <200MB;账本写入在批次末尾(不与采集抢 IO);SQLite 开 WAL(dashboard 读与批次写并发)。
4. **测试**:`npm test`(node --test + tsx,已带 `TSX_TSCONFIG_PATH=` 前缀);detector/ledger 测试进同一套。
5. **完工标准**:验收表逐项过 + playwright 截图自验 + 服务器真跑 24h 数据,才能报老板(铁律 12/13:不当二传手)。

---

*计划书终版 · Claude Fable 5 · 2026-07-04 · 敲定后交付执行*
