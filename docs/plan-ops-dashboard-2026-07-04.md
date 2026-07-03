# 采集运维观测与管理系统 · 完整方案计划书

> **状态:** 老板已拍板(2026-07-04)· 待最终敲定后交付执行
> **执行方:** 另一个 Claude 实例(本文档为自包含交接物)
> **仓库:** 与采集项目共享同一 git 目录(老板拍:单项目单目录,只是多一个后端+前端,不开新仓库)
> **执行前必读:** 本文档 + `docs/handoff-crawlee-poc-p2-2026-07-03.md` + `~/.claude/projects/-Users-lindashuai-Desktop-project-crawlee/memory/MEMORY.md`(全部条目,特别是 🔴)

---

## 0. 老板拍板记录(不许翻案)

| # | 决策 | 拍板 |
|---|---|---|
| A | UI 形态 | **A2 · 服务器常驻只读 dashboard**。规则/名单改动不进 UI(交给 Claude 走 git)。唯一允许的写操作:告警 ack(状态标记,非规则) |
| B | 运行模式概念 | **无"全量/增量"双模式**。系统只有一种采集批次:带 seen-store 的常规轮(记住已采博文 url,下次跳过 = 增量;首轮天然等效全量)。"忽略增量重来" = 清 seen 的**运维动作**(reset),不是调度模式 |
| C | 告警通道 | **C1 UI 页内展示 + C3 预留主动推送接口**(通道后续想到再接,接口先留) |
| D | 访问方式 | **D2 公网 + 密码** |
| E | 分期 | **E1 一期先闭环**(账本+调度+环比告警+核心三页),二期(巡检+博文检索+push 页)在真数据上迭代 |
| — | 部署流程 | 批次脚本**不做 git pull**(老板拍:不必要)。代码更新沿用现有人工流程(本地改→push→服务器 pull 一次) |
| — | 频率/并发/重试 | 批次完成时间、频率、并发、重试全部纳入本架构(见 §4/§5) |

---

## 1. 背景与现状(执行 Claude 从这里理解系统)

### 1.1 系统是什么

Crawlee Node 爬虫,采集 634 个加密项目官方博客(当前有数据源 501)。跑在服务器 hk-prod(119.28.68.105 · 2c4G · `~/crawlee-blog-poc/`)。三代理池分流 + 五路并行管线(medium RSS / substack 直拉 / paragraph RSS / 通用 RSS 直拉 60 源 / article-detail HTML)。单轮 ~5.5 分钟(sitemap 每源 10 条口径)。

### 1.2 现有数据资产(账本系统直接在这些之上生长)

| 资产 | 位置 | 说明 |
|---|---|---|
| 源注册表 | `storage/sources.db`(SQLite)| 634 源:token_id/base_symbol/blog_url/host_platform/og_quality/fetch_strategy/sitemap_url 等。**账本新表直接加进这个库** |
| 采集产出 | `storage/datasets/default/*.json` | 每条博文一个 JSON(token_id/url/title/description/published_at/crawler/crawledAt) |
| 已见清单 | KV `seen-articles` | 增量的核心:key=`token_id:url`。**已知问题:无限增长,巡检 >5MB 告警,裁剪策略未做**(纳入本项目二期) |
| 原文库 | KV `raw-html` | 每 URL 最新一份 HTML(调规则用) |
| 规则 | `src/utils/filter-config.json` + `src/utils/source-rules.json` + `src/config.ts URL_OVERRIDES` | 单一真源,TS/python/HTML 三层共读 |
| 静态报告 | `docs/poc-report.html`(+`poc-report-data.json`)| 手动跑报告链生成的快照。**保留不动**(给老板的正式汇报物),dashboard 是另一个东西(实时运营视图) |
| 运行日志 | `storage/main-run.log` | 每轮覆盖。各 handler 已有丰富 log 点(拦截/入队/成功),是埋点改造的对照表 |

### 1.3 痛点(本项目要解决的)

1. **失效不自知**:站点改版(实锤:LAZIO `/en/news/`→`/en/latest-news/` 规则全拦)、品牌迁域(POKT→pocket.network)、feed 失效 — 只有老板抽查或 agent 战役才发现。
2. **运行不留痕**:log 覆盖、无批次记录 — 无法回答"这轮 vs 上轮""某源最近一周表现"。
3. **无调度**:systemd timer 已停,手动触发;无重叠保护、无批次级失败提醒。
4. **无运营视图**:634 源靠静态快照管理。

### 1.4 核心设计判断

**站点变更没有万能检测器,通用信号是"这轮和上轮不一样"。** 所以本方案的地基是「每轮记账 → 环比对照 → 出告警」,零额外请求就覆盖:改版、停更、反爬升级、规则腐烂、feed 失效全部形态。probe 巡检(二期)只是补充(发现"还没影响采集但结构已变"的早期信号)。

---

## 2. 概念模型(按老板拍板 B 修正)

| 概念 | 定义 |
|---|---|
| **采集批次(crawl run)** | 系统唯一的运行模式。跑现有 main.ts:入口(RSS/LIST/sitemap)每轮重抓(RUN_SALT 机制),文章级靠 seen-store 去重 → 每轮只新增未见博文。首轮 seen 为空 = 天然全量效果 |
| **重置(reset)** | 运维动作,非调度概念。清 `storage/`(seen/queue/dataset)后下一轮重新累积。仅在大规则变更后由 Claude 手动执行(会造成下一轮"新增"虚高,账本要标记 reset 标志位防环比误报) |
| **巡检批次(probe run)** | 二期。零采集,纯健康探测:对每源发 2-3 个轻量请求(blog_url 通不通/是否 301 搬家/feed 还是不是 XML/sitemap 还在不在),对比上次巡检发现结构变更。周级低频,不打扰站点。复用现成 `scripts/detect-feed.ts` / `scripts/audit-probe.ts` 的探测方式(生产指纹) |
| **告警(alert)** | 有状态机的持续事件:open(新发)→ 持续(同一告警不重复轰炸,只更新 last_run)→ resolved(条件消失自动关闭)/ ack(老板在 UI 标记已读) |

---

## 3. 架构总览

```
┌─────────── 调度层 ───────────┐
│ systemd timer(每小时)        │
│ + 手动触发(跑同一脚本)        │
│ + flock 互斥锁(防重叠)        │
└──────────┬──────────────────┘
           ▼
┌─────────── 执行层 ───────────┐
│ scripts/run-batch.ts          │
│ 1. 取锁 · runs 表插 running    │
│ 2. 跑 src/main.ts(管线不动)  │
│ 3. 收运行统计 → source_runs    │
│ 4. 跑 detector(环比检测)     │
│ 5. alerts upsert · runs 收尾   │
└──────────┬──────────────────┘
           ▼
┌─────────── 账本层 ───────────┐
│ storage/sources.db 加 4 表:   │
│ runs / source_runs /          │
│ alerts / push_runs(预留)     │
└──────────┬──────────────────┘
           ▼
┌─────────── 视图层 ───────────┐
│ server/(Node 常驻服务)       │
│ 只读 JSON API + 静态前端       │
│ 公网 + basic auth(D2)        │
│ 页面:总览 / 告警 / 源管理      │
└──────────────────────────────┘
```

**目录规划**(共享现有仓库,老板拍):

```
crawlee-blog-poc/
├── src/                    # 现有采集(改动最小化:只加统计埋点)
├── scripts/
│   ├── run-batch.ts        # 🆕 批次包装(执行层)
│   └── detector.ts         # 🆕 环比检测(独立可测)
├── server/                 # 🆕 dashboard 后端(Node/TS)
│   ├── index.ts            # http 服务 + basic auth + 静态托管
│   ├── api.ts              # 只读 JSON 接口
│   └── public/             # 🆕 前端(vanilla JS · 延续报告暖白 serif 视觉)
│       ├── index.html      # 总览
│       ├── alerts.html     # 告警
│       └── sources.html    # 源管理(含单源详情)
├── ops/
│   ├── schedule-config.json # 🆕 频率/并发/阈值 单一真源
│   ├── crawl.service / crawl.timer / dashboard.service  # 🆕 systemd 单元
└── test/                   # detector/账本 单测加入现有 npm test
```

---

## 4. 账本层详设(SQLite schema)

加在现有 `storage/sources.db`(与 registry 同库,单源 join 方便;驱动复用 `src/registry/db.ts` 同款)。

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,          -- 'run-<ISO时间戳>'
  started_at TEXT NOT NULL,          -- ISO-8601
  finished_at TEXT,                  -- 完成时间(老板点名要的)
  duration_s REAL,
  status TEXT NOT NULL,              -- running / ok / failed / timeout / skipped_overlap
  is_after_reset INTEGER DEFAULT 0,  -- reset 后首轮标记(防环比误报"新增暴涨")
  dataset_added INTEGER,             -- 本轮新增博文数
  requests_total INTEGER,
  requests_failed INTEGER,
  sources_with_new INTEGER,          -- 有新增的源数
  alerts_opened INTEGER,
  rpm_actual REAL,                   -- 实际吞吐(观测并发利用率)
  git_commit TEXT,                   -- 代码/规则版本(可追溯"哪个版本开始坏的")
  notes TEXT
);

CREATE TABLE IF NOT EXISTS source_runs (
  run_id TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  base_symbol TEXT,
  crawler TEXT,                      -- 该源本轮走的管线(medium/rss/substack/paragraph/article-detail)
  items_added INTEGER DEFAULT 0,     -- 新增博文数(老板要的"新增情况")
  requests INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,          -- 失败情况
  http_403 INTEGER DEFAULT 0,        -- 反爬信号
  http_404 INTEGER DEFAULT 0,
  blocked_noise INTEGER DEFAULT 0,   -- 规则拦截计数(noise/landing)
  blocked_external INTEGER DEFAULT 0,-- 外链拦截(门面站信号!MET/POKT 实锤模式)
  blocked_error_page INTEGER DEFAULT 0,
  list_candidates INTEGER,           -- LIST 页候选数(骤降=改版信号,LAZIO 实锤)
  feed_items INTEGER,                -- feed 源:本轮 feed item 数(0=feed 失效信号)
  PRIMARY KEY (run_id, token_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER,                  -- NULL = 批次级告警
  base_symbol TEXT,
  type TEXT NOT NULL,                -- 见 §6 告警规则清单
  severity TEXT NOT NULL,            -- red / yellow / info
  status TEXT NOT NULL DEFAULT 'open', -- open / ack / resolved
  first_run_id TEXT,
  last_run_id TEXT,                  -- 持续更新 · 不重复开新告警
  detail TEXT,                       -- 人话描述+数据(如 "候选 12→0 · 疑似改版")
  created_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS push_runs (   -- 二期激活 · 表先建
  run_id TEXT PRIMARY KEY,
  pushed INTEGER, ok INTEGER, failed INTEGER,
  detail TEXT
);
```

**埋点改造(src/ 唯一改动面 · 外科手术)**:main.ts / handlers 现有 log 点(`✅ [DETAIL]`、`⊘ 外链拦截`、`📋 [LIST] 入队 N 候选 M`、`✅ [rss] N items` 等)已覆盖全部统计维度 — 新建 `src/utils/run-stats.ts`(进程内 counter,按 token_id 累计),在这些 log 点旁边同步 `stats.count(tokenId, 'blocked_external')` 一行式埋点,轮末 main.ts 输出 `storage/run-stats.json`,由 run-batch.ts 读走入库。**不改任何采集行为**。dataset 新增数按 crawledAt > 批次 started_at 统计(或 seen-store 本轮新增数,实现取简单可靠者)。

---

## 5. 调度 / 并发 / 重试(老板点名的四维度)

### 5.1 频率(多久采集一次)

`ops/schedule-config.json`(单一真源,改配置不改代码):

```json
{
  "crawl_interval": "hourly",        // systemd OnCalendar 值 · 默认每小时(单轮 ~5.5min 负载轻)
  "batch_timeout_min": 30,           // 超时告警阈值
  "probe_interval": "weekly",        // 二期巡检
  "concurrency": { "general_rpm": 600, "general_cc": 20, "medium_rpm": 150, "medium_cc": 5, "slow_rpm": 60, "slow_cc": 3, "rss_cc": 6 },
  "alert_thresholds": { "...": "见 §6" }
}
```

- systemd `crawl.timer` 读 interval 生成(改频率 = 改 json + 重装 timer,提供 `ops/install.sh` 一键)
- **批次完成时间**:runs 表 finished_at/duration_s,总览页批次时间线直接展示
- Playwright 未来上线 = 新增一种批次类型(browser run),本架构直接容纳,互不影响

### 5.2 并发

- 现有三池 RPM/并发常量提升为读 schedule-config(main.ts 启动读取,缺省回落现有默认值 — 向后兼容)
- 每轮账本记录 `rpm_actual`(requests_total ÷ duration),总览页展示 → **调参有数据依据**(而不是拍脑袋)

### 5.3 重试(三级,大部分是现状显式化)

| 级别 | 机制 | 状态 |
|---|---|---|
| 请求级 | crawlee `maxRequestRetries=2` + SessionPool 换 session | ✅ 现状已有 |
| 源级 | 入口(RSS/LIST/sitemap)每轮 RUN_SALT 必重抓 = **失败源下轮天然重试**;连续失败升级为告警(§6 source_gone)而非无限静默重试 | ✅ 机制现有 + 🆕 告警 |
| 批次级 | 整轮崩溃 → runs.status=failed + 🔴 告警;timer 下个周期自然重跑;互斥锁防重叠(上轮未完 → 本次 skipped_overlap + 告警) | 🆕 |

### 5.4 互斥与超时

- `flock /tmp/crawl-batch.lock`:拿不到锁 → 记 skipped_overlap 告警后退出
- run-batch 自我计时:超 batch_timeout_min → 杀采集进程 + status=timeout + 🔴 告警

---

## 6. 检测层 · 告警规则清单(一期 = 环比全套)

每轮 run-batch 末尾跑 `scripts/detector.ts`(纯函数读账本,单测覆盖)。**设计原则:告警要少而准 — 博客天然低频,"没有新文章"是常态不是告警**(停更观察做成源管理页的"最后出文时间"排序列,不进告警)。

| type | 触发条件(默认阈值 · schedule-config 可调)| 级别 | 含义 |
|---|---|---|---|
| `source_gone` | 该源近 7 天有产出,本轮 requests>0 且全 failed(或 http_403/404 占比 100%) | 🔴 | 源断供(被 ban/站挂/URL 死) |
| `http_shift` | 该源上轮 2xx 为主 → 本轮 403/404 为主 | 🔴 | 反爬升级或页面消失 |
| `list_shrink` | list_candidates 上轮 >5 → 本轮 0 | 🟡 | **疑似改版**(LAZIO 实锤模式:链接形态变了规则全拦) |
| `feed_dead` | RSS 类源 feed_items 连续 2 轮 = 0(此前正常)| 🟡 | feed 失效/搬家 |
| `external_surge` | blocked_external 从 ~0 → 占候选 >80% | 🟡 | **门面站信号**(MET/POKT 实锤:链接全指外域) |
| `noise_surge` | blocked_noise 环比暴增且 items_added=0 | 🟡 | 疑似改版成规则拦不住的形态 |
| `pipeline_drop` | 某管线(rss/medium/...)总新增环比降 >70% 且绝对值 >50 | 🔴 | 管线级故障(如 medium 封池) |
| `run_failed` / `run_timeout` / `run_overlap` | 批次级 | 🔴 | 调度故障 |
| `seen_store_bloat` | seen-articles >5MB(现有巡检项收编)| ⚪ | 运维提醒 |

**状态机**:同 (token_id, type) 已有 open 告警 → 只更新 last_run_id/detail(不重复新建);触发条件连续 2 轮不满足 → 自动 resolved。老板 UI 可 ack(仅改变展示分组,不影响检测)。

**C3 预留**:detector 收尾调用 `notify(alerts)` 钩子 — 一期实现为空函数 + 注释(未来接 TG bot/webhook/邮件只改这一个函数)。

---

## 7. 视图层 · dashboard 详设

### 7.1 后端(server/)

- Node/TS,`node:http` + 手写路由(不引 web 框架,项目哲学少依赖);读 sources.db(只读连接)
- **basic auth**(D2):账密放服务器 `.env.local`(`DASH_USER/DASH_PASS`,沿用现有密钥管理惯例,不进 git);全部路由鉴权;登录失败限速(简单计数防爆破)
- systemd `dashboard.service` 常驻(Restart=always);端口默认 8787
- ⚠️ 风险声明:公网 + basic auth 是明文口令(HTTP)。计划书建议执行时二选一:①服务器已有 nginx/caddy 则套 HTTPS;②否则先用强随机长口令 + 非常规端口,并把"套证书"记为二期项。老板已拍 D2,此处执行 Claude 按服务器实况选①或②,不必再问

只读 API(全部返 JSON):

| 路由 | 内容 |
|---|---|
| `GET /api/runs?limit=50` | 批次列表(时间线) |
| `GET /api/runs/:id` | 单批次详情 + 该轮 source_runs 摘要 |
| `GET /api/alerts?status=open` | 告警列表 |
| `POST /api/alerts/:id/ack` | 唯一写操作(状态标记) |
| `GET /api/sources` | 全源实时表(join registry + 最近 N 轮聚合:最后出文时间/近7天新增/失败率/open 告警数/disposition) |
| `GET /api/sources/:token_id` | 单源详情(近 30 轮 source_runs + 最近 10 篇博文 + 告警历史) |
| `GET /api/summary` | 总览统计(今日新增/活跃告警/下次运行时间/调度状态) |

### 7.2 前端(server/public/ · vanilla JS · 延续 poc-report 暖白 serif 视觉)

**一期三页:**

| 页 | 内容 |
|---|---|
| **总览** | ①调度状态条(上次批次:状态/完成时间/耗时 · 下次运行倒计时 · 锁状态)②最近 20 批次时间线卡片(耗时/新增/失败/告警数,失败批次红标)③7 天新增趋势 sparkline ④管线分布(各管线本日新增) |
| **告警** | open 告警表(级别 emoji/类型/源/持续轮数/人话 detail/ack 按钮),已 ack 与已恢复折叠分组;每条告警可跳该源详情 |
| **源管理** | 全源表(复用报告 §2 的筛选交互习惯:模糊搜/管线/处置/告警状态筛;列:symbol/URL/管线/**最后出文时间**/近7天新增/近轮失败/告警 🔴🟡)· 点行展开单源详情(近 30 轮新增柱状图 + 最近 10 篇博文带链接 + 该源告警史)。不采集源(dead/suspended/excluded)也在表内按处置筛选可见(替代静态报告 §5 的实时版) |

**二期:** 博文全库检索页 · push 账本页 · 巡检 diff 页。

---

## 8. 分期与验收标准(铁律 6)

### 一期(本计划书交付范围)

| # | 交付物 | 验收标准 |
|---|---|---|
| 1 | 账本层(4 表 + run-stats 埋点)| 跑一轮批次后 runs/source_runs 有完整记录;**现有采集行为零变化**(埋点前后同条件跑,dataset 产出一致);`npm test` 含账本/检测单测全绿 |
| 2 | 执行层 run-batch.ts | 手动跑通:锁/超时/失败路径各验一次(模拟);runs 状态机正确 |
| 3 | 调度 | timer 装上后连续 24h 无人工干预,runs 表 ≥24 条 ok 记录;重叠保护验证(手动占锁 → skipped_overlap) |
| 4 | detector + 告警 | 单测:每条规则一组 fixture(触发/不触发/持续/恢复);实测:临时把某活跃源加黑名单 → 下轮 source_gone 告警出现,移回 → 2 轮后自动 resolved |
| 5 | dashboard 三页 | 公网密码可访问;三页数据与 sqlite 直查一致;ack 生效;playwright 截图三页附验收报告(项目铁律:UI 必真访问自验) |
| 6 | 文档 | ops/README.md(装/卸/改频率/改阈值 SOP)+ handoff 补记 |

### 二期(账本跑出真数据后启动,另出计划)

巡检批次(probe run + 结构 diff 告警)· 博文检索页 · push_runs 激活(等 push 对接)· seen-store 裁剪策略 · 告警主动推送通道(C3 落地)· HTTPS 完善。

---

## 9. 明确不做(YAGNI · 防执行跑偏)

- ❌ UI 改规则/名单(A2 拍板:规则改动走 Claude + git)
- ❌ 不动采集管线逻辑(五路并行/三池/seen-store/规则体系全部原样;src/ 只加埋点)
- ❌ 不引前端框架/组件库/图表库(vanilla JS + 手写 SVG sparkline)
- ❌ 不做用户体系(单账号 basic auth 够)
- ❌ 不做"全量/增量"模式切换(概念已废,见 §2)
- ❌ 静态报告链(poc-report)不动 — 它是给老板的正式汇报物,与 dashboard 并存

---

## 10. 给执行 Claude 的上下文指路(必读)

1. **项目铁律**(memory 有档,违者返工):本地只改代码、服务器跑数据(hk-prod SSH 命令模板见 handoff §9);诊断一律 `scripts/probe-fetch.ts` 生产指纹,**严禁裸 curl**;改完必 commit+push;单一真源哲学(配置进 json,三层共读);blogpicker 状态不可信。
2. **改 src/ 前**:grep 调用方;main.ts 有 `process.exit(0)` 尾(批次包装要感知退出码);`CRAWLEE_MEMORY_MBYTES` 等环境依赖见 handoff §2;跑批命令环境准备(fnm/env)照抄 handoff §9 模板。
3. **服务器资源**:2c4G,dashboard 内存预算 <200MB;账本写入在批次末尾(不与采集抢 IO)。
4. **测试**:`npm test`(node --test + tsx,命令已带 `TSX_TSCONFIG_PATH=` 前缀);新增 detector/账本测试进同一套。
5. **完工标准**:验收表逐项过 + playwright 截图自验 + 服务器真跑 24h 数据截图,才能报老板(铁律 12/13:不当二传手)。

---

*计划书 · Claude Fable 5 · 2026-07-04 · 老板敲定后交付执行*
