# 方案审计 A1 · 采集器↔运维台对接层面

> 审计对象:`docs/plan-ops-dashboard-2026-07-04.md`(终版计划书)
> 参照:`docs/handoff-crawlee-poc-p2-2026-07-03.md` + 现有代码实证(src/registry/db.ts、src/main.ts、src/config.ts、src/handlers/medium.ts)
> 已知但计划书未体现的拍板:①代理池未来前端可设置 ②废弃 systemctl,调度内置进运维台常驻进程

## 汇总表

| # | 问题 | 严重度 |
|---|---|---|
| 1 | `registry/db.ts` "re-export" 指令与其引用的先例不对等,字面执行会破坏 8 个调用方 | 🔴 P0 |
| 2 | reset 定义"清 `storage/`"未明确排除 `storage/sources.db`,误清会连注册表+账本+push_status 一起丢 | 🔴 P0 |
| 3 | main.ts 无顶层 try/catch,并行管线整体 reject → 非零退出且跳过账本/seen-store 持久化 | 🔴 P0 |
| 4 | 账本写入(ledger/crawl_errors)无失败隔离设计,db 锁/磁盘满会拖垮整轮本已成功的采集 | 🔴 P0 |
| 5 | `crawl_errors.run_id` NOT NULL,但 RUN_ID 网关只点名了 `writeSourceRuns`,裸跑很可能在错误分类落库时崩溃 | 🔴 P0 |
| 6 | 调度内置进运维台常驻进程(拍板②)与"run-batch 独立子进程"架构冲突,计划书完全未重新设计 | 🔴 P0 |
| 7 | reset 后 articles/dataset/raw-html 一致性未定义,博文详情页缺对应 API 端点 | 🟡 P1 |
| 8 | 超时/手动杀进程无 SIGTERM 处理与 grace period,必定丢失该轮 seen-store | 🟡 P1 |
| 9 | 并发参数回落覆盖不全(mirror 池未命名 + medium.ts 独立 CONCURRENCY 机制未点名) | 🟡 P1 |
| 10 | main-run.log 每轮覆盖,账本不含原始日志归档,超过 1 小时的历史批次无法深挖 | 🟡 P1 |
| 11 | 代理池前端化(拍板①)shared/config 未预留位置,二期要再动一次采集器代码 + 密钥落盘安全边界未定 | 🟡 P1 |
| 12 | `RUN_SALT`(main.ts 内部去重盐)与 `RUN_ID`(账本标识)命名相似,易被混淆 | ⚪ P2 |
| 13 | `storage/datasets/default/` 无限增长,缺少类似 `seen_store_bloat` 的告警 | ⚪ P2 |

---

## 问题清单

### 1. 【P0】registry/db.ts "re-export" 指令与其引用的先例不对等

**证据(计划书原文,行 94)**:
> "现有 `src/registry/db.ts` 改为 **re-export shared/db.ts**(项目有先例:config.ts re-export article-filter),调用方 import 路径不变 = **采集逻辑零影响**。"

**证据(现有代码实证)**:
- `src/config.ts:119-120` 引用的先例是:`export { isLikelyArticleUrl, isBlacklistedHost, HOST_BLACKLIST } from './utils/article-filter.js';` —— 三个**纯函数/常量**,零状态、零副作用、零 schema 加载。
- `src/registry/db.ts` 实际是一个**有状态模块**:`db()` 是单例连接(带 `journal_mode = WAL` pragma),首次调用时 `_db.exec(readFileSync(SCHEMA_PATH))` 执行**自己的** `src/registry/schema.sql`(定义 `sources` 表);此外还导出 `upsertSource()` / `updateProbe()` / `listSources()` / `countSources()` 四个业务函数和 `SourceRow` 接口。
- 实测 8 个文件 import 自 `registry/db.ts`:`src/main.ts` `src/probe.ts` `src/fetch-sources.ts` `src/report.ts` `src/run-mirror.ts` `src/run-substack.ts` `src/run-paragraph.ts` `scripts/detect-feed.ts`。

**问题**:若字面执行"改为 re-export shared/db.ts"(照抄 config.ts 那种一行 `export * from`/`export {...} from`),会直接丢掉 `upsertSource`/`updateProbe`/`listSources`/`countSources` 四个函数 —— 8 个调用方全部编译/运行时报错(`fetch-sources.ts` 靠 `upsertSource` 同步注册表、`probe.ts` 靠 `updateProbe` 写探测结果)。即便 `shared/db.ts` 把这四个函数也一并搬过去,还有第二个坑:计划书里 `shared/db.ts` 的职责被定义为"SQLite 连接 + **全部表 schema**"—— 如果这个"全部表 schema"只包含新账本 6 张表(runs/source_runs/articles/crawl_errors/alerts/push_runs),不包含 `registry/schema.sql` 里的 `sources` 表 DDL,那么纯 re-export 后 `sources` 表将永远不会被创建(现在这个副作用来自 registry/db.ts 自己的 `db()` 函数),全新环境/换服务器时会直接炸。**"import 路径不变 = 采集逻辑零影响"这句话目前不成立**,因为它只保证了路径,没保证导出的符号集合和 schema 初始化行为。

**建议修改(可直接合入计划书 §3 第 94 行处)**:
> 现有 `src/registry/db.ts` 改造分两步,而非简单 re-export:
> ① `shared/db.ts` 的 schema 初始化必须**合并** `src/registry/schema.sql`(sources 表)与新增 6 张账本表,统一在一次 `db()` 首调用里 `CREATE TABLE IF NOT EXISTS` 全部执行;
> ② `upsertSource`/`updateProbe`/`listSources`/`countSources`/`SourceRow` 这几个注册表专属函数迁移进 `shared/db.ts`(或新建 `shared/registry.ts` 承载,`shared/db.ts` 只留连接+schema),`src/registry/db.ts` 才改成纯 barrel:`export * from '../shared/db.js'`。
> ③ 执行前必须对 8 个调用方(`main.ts`/`probe.ts`/`fetch-sources.ts`/`report.ts`/`run-mirror.ts`/`run-substack.ts`/`run-paragraph.ts`/`scripts/detect-feed.ts`)逐个跑一次 `npm run <对应脚本>` 或至少 `tsc --noEmit` 确认签名对齐,不能只 grep 一次"有没有 import"就当作验证通过。

---

### 2. 【P0】reset 定义"清 storage/"未明确排除 storage/sources.db

**证据(计划书原文,行 61)**:
> "**重置(reset)** | 运维动作(非调度概念):**清 `storage/` 重新累积**。仅大规则变更后由 Claude 手动执行。账本 runs 表有 `is_after_reset` 标志(防环比"新增暴涨"误报)"

**证据(架构图,行 87)**:
> `storage/sources.db(唯一数据库)` —— sources.db 明确就放在 `storage/` 目录**里面**。

**证据(现有 reset 命令,handoff §9 & 历史 handoff 两处一致)**:
```
rm -rf storage/datasets storage/request_queues storage/key_value_stores   # 全量才 rm · 增量不 rm
```
这条现有命令**从未**清过 `storage/sources.db`。

**问题**:计划书用"清 `storage/`"这四个字描述 reset,字面读法和现有实际执行的 rm 命令范围**不一致**(现有命令只清 3 个子目录,不是整个 `storage/`)。sources.db 现在承载的不只是注册表(可靠 fetch-sources.ts 重建),还有**账本全部历史**(runs/source_runs/alerts,这是本次运维台项目存在的意义,重建不了)和 **articles 表 push_status**(如果误清,pushed 状态归零,二期激活 push 后会对已经推送过的旧文章**重复推送**,直接违反计划书自己在 §8 二期部分引用的"push 记忆:首次接通存量不推"铁律)。执行 Claude 如果没有交叉核对 handoff 里的历史 rm 命令,单看这句"清 storage/ 重新累积"很可能写出 `rm -rf storage/*` 这种一步到位的实现。

**建议修改(可直接合入计划书 §2 概念模型表 reset 行)**:
> **重置(reset)**:运维动作(非调度概念)。精确范围 = `rm -rf storage/datasets storage/key_value_stores storage/request_queues`(与现有全量跑 SOP 完全一致);**明确不清除 `storage/sources.db`**(registry + 账本 + articles 全部保留)。建议在 `ops/run-batch.ts` 或 `ops/README.md` 里把这条命令封装成一个命名函数/脚本(如 `ops/reset.ts`),不允许执行 Claude 现场自由解读"清 storage/"再手打 rm 命令。仅大规则变更后由 Claude 手动执行。账本 `runs` 表有 `is_after_reset` 标志(防环比"新增暴涨"误报)。

---

### 3. 【P0】main.ts 无顶层 try/catch,并行管线整体 reject 会跳过账本写入

**证据(计划书原文,行 97 + 212)**:
> "RUN_ID 由 run-batch 经环境变量传入;**手动裸跑 main.ts(无 RUN_ID)时跳过账本写入**"
> "main.ts 轮末:有 `RUN_ID` 环境变量 → `ledger.writeSourceRuns()`;无 → 跳过。**不改任何采集行为。**"

**证据(现有代码实证,grep 全文确认)**:
- `src/main.ts` 全文**没有**任何 `try`/`catch`/`async function main`/`main().catch(...)` 包裹 —— 是裸的顶层 top-level await 流程。
- `src/main.ts:17-19` 已装的 `unhandledRejection` 处理器明确写着"**已兜底不杀进程**",但这个处理器只吞**孤儿 rejection**(如 crawlee 内部 addRequests 异步校验失败这类没人 await 的 promise)。
- 五路管线是 `jobs.push((async () => { await xxxCrawler.run(); })())` 塞进数组再 `await Promise.all(jobs)`——这些 promise **是被 Promise.all 消费的**,如果某个 `xxxCrawler.run()` 真的整体抛错(比如网络/配置层面的致命错误,不是单个 request 级失败),会让 `Promise.all(jobs)` reject,`await Promise.all(jobs)` 在顶层抛出**未被捕获的异常** —— 这是 Node 对 top-level await 的标准行为:直接终止进程、非零退出码,且**不会**触发 line 17 装的 unhandledRejection 兜底(因为这不是孤儿 rejection,是已被 await 但没被 try/catch 的同步式抛错)。
- `main.ts:534` 的 `process.exit(0)`、以及 `persistSeen()` 调用,都在 `await Promise.all(jobs)` **之后**。

**问题**:计划书对"main.ts 轮末写账本"的设计,隐含假设"main.ts 总会跑到最后一行"。但现有代码里唯一保证不崩的兜底(unhandledRejection)覆盖的是孤儿 rejection,不覆盖五路管线自身的顶层失败。一旦某路管线(比如 general 池代理挂了)真的抛出顶层错误:
- 该轮**四路可能已经成功**产出的数据仍然进了 dataset,但 `ledger.writeSourceRuns()` 和 `persistSeen()` 全部执行不到 —— 意味着这一轮**source_runs 整表缺失**,detector 环比读不到基线,可能对所有当轮"应该有数据但没记账"的源误判(比如漏报或者错误触发 `source_gone`)。
- seen-store 没持久化 → 下一轮这五路管线的 URL 会被当成"新"重新抓一遍(自愈但浪费一整轮资源,且如果 push 已经上线,可能把同一批文章又推一次)。
- run-batch 只能靠"非零退出码"知道这轮失败,但完全看不出是"整轮崩了"还是"崩之前其实有 4/5 管线已经成功"——`runs.status` 目前只有 running/ok/failed/timeout/skipped_overlap,没有"partial"状态可以表达这种情况。

**建议修改(可直接合入计划书 §3 统计传递修正段,行 97 之后新增一段)**:
> **main.ts 崩溃路径的账本容错**:main.ts 现状是顶层裸跑(无 try/catch),五路管线中任一路整体 reject 会导致进程带非零码退出且跳过轮末的 `persistSeen()`/`ledger.writeSourceRuns()`。为了不让"最后一步写账本"变成单点故障,改造时需要:
> ① 把 `await Promise.all(jobs)` 包一层 try/catch,catch 到的错误记录哪几路失败、哪几路成功,**照常**执行 `persistSeen()`(seen-store 该存的还是要存,不因为某一路挂了就连累其他四路的去重效果),再重新 throw 或 `process.exitCode = 1` 退出;
> ② `ledger.writeSourceRuns()` 按**已完成的管线**部分写入(哪怕只有 4/5 路数据),而不是所有管线必须全部成功才写这一轮的账本;
> ③ run-batch 收到非零退出码时,仍然去查 `source_runs` 表本轮是否有部分数据,如果有则 `runs.status` 记 `failed` 但 `notes` 字段注明"部分管线成功(N/5)",避免 detector 把"部分挂了"和"整轮死透"混为一谈。

---

### 4. 【P0】账本写入无失败隔离设计,db 锁/磁盘满会拖垮已经成功的采集

**审计问题原文对应**:"采集器写账本失败时(db 锁/磁盘满)对采集本身的影响 — 有没有隔离设计?"

**证据**:计划书全文(§3/§4/§10)对 `ledger.writeSourceRuns()`、`crawl_errors` flush 的描述都是直接一句"main.ts 轮末...写入",**没有任何一处提到失败隔离/try-catch/降级**。对照的是同一份计划书自己在架构上强调的"外科手术式改动、不改任何采集行为"的哲学,以及现有代码里 `unhandledRejection` 处理器的设计初衷("爬虫长任务不许单点杀全进程")—— 但这个初衷目前**没有延伸到新增的账本写入代码**。

**问题**:`better-sqlite3` 是同步 API,遇到 `SQLITE_BUSY`(WAL 模式下概率降低但不是 0,尤其 dashboard 端如果有慢查询或 checkpoint)或 `SQLITE_FULL`(磁盘满)会直接 `throw`。`ledger.writeSourceRuns()` 这行代码如果排在 `persistSeen()` **之前**(计划书行 212 的描述顺序:先讲 ledger 写,§3 里`persistSeen()` 在 main.ts 尾部但先后顺序未定），一旦抛错且没有 try/catch,会复现问题 3 的整个连锁反应:一次**完全成功**的采集(五路全部跑完、dataset 全部写好),仅仅因为账本这一行代码写失败,就导致 seen-store 丢失 + 进程非零退出 + run-batch 把这轮标记为 failed —— 这是纯粹的记账故障拖累了主业务,和"账本"这个功能本该有的"旁路旁站、不反噬采集"定位完全相反。

**建议修改(可直接合入计划书 §4 末尾,"articles 写入"段之后新增一段)**:
> **账本写入失败隔离**:`ledger.writeSourceRuns()` 与 crawl_errors 的落库调用必须各自包一层 try/catch,失败只 `console.error` 记录("⚠️ 账本写入失败(不影响本轮采集产出):..."),**绝不允许**向上抛出到顶层。且 `persistSeen()` 必须排在账本写入**之前**(或与账本写入互不依赖、任一失败不影响另一个),保证"账本这个新功能挂了"的最坏情况,只丢一轮的统计/告警可见性,不丢采集产出、不丢去重状态、不让 run-batch 把一次成功的采集误判为失败。

---

### 5. 【P0】crawl_errors.run_id 是 NOT NULL,但 RUN_ID 网关只点名了 writeSourceRuns

**证据(计划书原文,行 179-189 schema)**:
```sql
CREATE TABLE IF NOT EXISTS crawl_errors (
  ...
  run_id TEXT NOT NULL,
  ...
);
```
**证据(RUN_ID 网关描述,行 212)**:
> "main.ts 轮末:有 `RUN_ID` 环境变量 → `ledger.writeSourceRuns()`;无 → 跳过。"

**证据(现有标准手动跑法,handoff §9)**:
```bash
nohup env NODE_OPTIONS='--max-old-space-size=3072' SITEMAP_URLS_PER_SOURCE=10 npx tsx src/main.ts > storage/main-run.log 2>&1 &
```
这条现有的、handoff 明确写的"服务器全量跑标准流程"命令,**完全没有传 RUN_ID**——是裸跑。

**问题**:计划书对"RUN_ID 网关"的措辞,字面上只覆盖了 `ledger.writeSourceRuns()` 这一个调用点。但 §4 同一段还描述了 crawl_errors 的采集路径:"crawlee failedRequestHandler/errorHandler...→ 内存 buffer 轮末入 crawl_errors"。这个 flush 动作如果没有**单独**做同样的 RUN_ID 判断,裸跑时(RUN_ID 是 undefined)会尝试往 `crawl_errors` 插入 `run_id = undefined/null`,直接撞上 `NOT NULL` 约束抛错。这个错误如果没被 try/catch(参见问题 4),又会顺着问题 3 的链路把整个裸跑进程带崩 —— 而裸跑恰恰是 handoff §9 里"标准手动全量/增量跑"的默认方式,是老板和执行 Claude 最常用的路径,不是边缘场景。

**建议修改(可直接合入计划书 §4 crawl_errors 段末尾)**:
> **RUN_ID 网关必须覆盖全部账本写入点,不止 source_runs**:`shared/run-stats.ts` 的内存 counter 本身不落库,可以无条件运行;但凡是真正写 SQLite 的动作 —— `ledger.writeSourceRuns()`、crawl_errors 的轮末 flush —— 都必须共享同一个判断:`if (process.env.RUN_ID) { ...写入... }`,无 RUN_ID 时错误分类缓冲区直接丢弃(裸跑不记账本,是明确拍板的行为,不是漏做)。建议把这个判断收敛成一个入口函数(如 `shared/ledger.ts` 导出 `flushRun(stats, errors)`,内部统一判断 RUN_ID 存在与否),而不是让 main.ts 里散落两处独立的 `if (RUN_ID)` 判断,防止漏改一处。

---

### 6. 【P0】调度内置进运维台常驻进程(拍板②)与"run-batch 独立子进程"架构冲突,计划书未重新设计

**审计前提**:题目明确"废弃 systemctl:调度由运维台常驻进程内置(不用 systemd timer)"是已拍板但计划书尚未体现的需求,审计时按已定需求处理。

**证据(计划书当前架构,多处依赖 systemd timer 的旧设计)**:
- 架构图(行 73):"调度器:systemd timer"
- §5.1(行 234):"systemd `crawl.timer` 按 interval 安装(改频率 = 改 json + `ops/systemd/install.sh` 重装)"
- §7.1(行 283):"systemd `dashboard.service` 常驻(Restart=always)"
- 目录规划(行 119):`ops/systemd/ # crawl.service/timer · dashboard.service · install.sh`
- §8 验收标准 #4(行 322):"调度:timer 连续 24h 无人工干预,runs ≥24 条 ok"

**问题**:这些段落全部建立在"systemd timer 定时触发 → 拉起独立的 run-batch.ts 进程 → run-batch spawn main.ts"这个三层独立进程模型上。拍板②把最外层的触发机制从 systemd timer 换成"运维台常驻进程内置调度",这不是简单的"改个触发方式"文字游戏,而是牵动至少三个必须重新设计的点,计划书目前一个都没覆盖:

1. **进程边界要不要保留**:如果"内置调度"被理解成"调度器的 setInterval/cron 循环和批次执行逻辑都跑在同一个 Node 进程里"(也就是 ops/server 那个长驻 HTTP 服务进程),那么一次采集批次里任何未捕获异常(参见问题 3),爆炸半径会从"这一轮采集失败"扩大到"**整个运维台挂掉**"——HTTP API 也访问不了、调度器本身也停了、下一轮更不会触发,比现在 systemd timer 方案(每轮是独立短命进程,炸了也不影响 dashboard.service)风险明显更高。这是运维台项目"为了可观测性/可靠性"而生,如果被拍板②意外削弱可靠性,是本末倒置。
2. **调度器自己的存活保障从哪来**:原方案里 dashboard.service 靠 `Restart=always` 兜底自己挂了会被拉起来;调度逻辑现在并入这个进程后,"废弃 systemctl"如果被理解成连 `dashboard.service` 这个 systemd **service**(不是 timer)单元也一起弃用,那 ops 进程本身崩溃后**谁来拉起它**是空白 —— 需要老板明确"废弃 systemctl"的范围(见下方"需要老板拍板")。
3. **批次互斥机制要不要降级**:§5.4 的 `flock` 锁文件是为了防止两个**独立进程**(不同 timer tick 触发的两次 run-batch)重叠。调度内置后,如果触发和执行都在同一个常�驻进程里,互斥可以退化成一个内存布尔标志(`isRunning`),更简单也更快;但如果还要防"有人手动在服务器上又起了一个 ops 进程"这种双实例场景,flock 还是该留。计划书没有交代这层要不要变。

**建议修改(建议作为计划书 §3/§5 新增小节,标题可用"调度内置架构(2026-07-04 补充拍板)")**:
> 调度由运维台常驻进程内置触发,但**批次执行仍必须走独立子进程**,不能把 run-batch 的逻辑内联成常驻进程里的一个直接函数调用:常驻进程内的调度循环(`setInterval` 或等效机制)到点后 `child_process.spawn('npx', ['tsx', 'ops/run-batch.ts'], {env: {...process.env, RUN_ID}})`,像现在 systemd timer 触发 run-batch 一样,只是触发者从 systemd 换成进程内定时器。这样一次批次崩溃的爆炸半径仍然局限在子进程内,不会带崩 HTTP API 和调度器本身。
> 批次互斥用常驻进程内存里的 `isRunning` 布尔标志即可(同进程内天然串行,不需要跨进程锁);如果还要防止"服务器上手动又起了一份 ops 进程"这种场景,`flock` 文件锁作为第二道防线保留。
> 常驻进程自身的存活保障(如果崩了谁拉起来)需要老板明确"废弃 systemctl"的具体范围 —— 详见下方"需要老板拍板"第 B 条。

---

### 7. 【P1】reset 后 articles/dataset/raw-html 一致性未定义,博文详情缺 API 端点

**审计问题原文对应**:"reset 运维动作(清 storage)与账本/articles 表的一致性(dataset 清了但 articles 表还在 — 是设计还是漏洞?要不要 reset 时同步处理?)"

**证据**:
- articles 表字段注释(行 169):"title TEXT, description TEXT, -- 摘要级(**全文仍在 dataset/raw-html**)"
- 现有 reset 范围(问题 2 已确认)会清 `storage/key_value_stores`(含 raw-html KV)和 `storage/datasets`,但**不清** `storage/sources.db`(articles 表所在)。
- §7.2 博文管理页描述(行 306):"列:标题(**点开:正文预览/字段质量/原文链**)..." —— 但 §7.1 只读 API 列表里**没有**任何 `GET /api/articles/:xxx` 或等价的"单篇详情"端点,`GET /api/articles` 按其参数列表(`q/symbol/crawler/push/pub_from/pub_to/crawled_from/crawled_to/page`)看只是列表查询。

**问题**:两个独立缺口叠加会导致真实的用户可见 bug:reset 之后,articles 表里 reset **之前**采集的历史行永久保留(url/title/description/发布时间等摘要字段都在),但支撑"正文预览"的原始载体(dataset JSON、raw-html KV)已经被清空。用户在博文管理页翻到 reset 之前的老文章、点开看"正文预览",要么读到空值要么后端报错 —— 而这些行在列表里看起来和新文章没有任何视觉区别(都是正常的 articles 行),对使用 dashboard 的老板来说会显得"数据坏了"而不知道是 reset 的正常副作用。另外"正文预览/原文链"这个交互目前连 API 契约都没有,执行 Claude 大概率会现场决定"正文预览从哪读",容易读错(比如直接读 raw-html KV 而不做存在性判断)。

**建议修改(可直接合入计划书 §7.1 API 表,新增一行 + §4 articles 表注释后补一句)**:
> `GET /api/articles/:url_hash`(或 `?url=&token_id=`) | 单篇详情:articles 摘要字段 + 尝试读 dataset/raw-html 全文,**读不到时返回 `full_text_available:false`**(不报 500),前端据此显示"该文章早于最近一次 reset,原文已随存储重置清理,仅保留摘要"。
>
> articles 表补充说明:reset 只清 `storage/datasets`/`storage/key_value_stores`,不清 `sources.db`,因此 **reset 之前的 articles 行会永久留存,但其"正文仍在 dataset/raw-html"这句承诺在 reset 后失效**——这是已知的设计取舍(保留检索历史优先于保证正文可回溯),不是需要修的 bug,但博文详情接口必须做存在性判断而不是假设 dataset/raw-html 一定在。

---

### 8. 【P1】超时/手动杀进程无 SIGTERM 处理与 grace period,必定丢失该轮 seen-store

**审计问题原文对应**:"main.ts process.exit(0) 尾与 run-batch 子进程管理的交互(退出码、超时杀进程、僵尸进程、stdout/log 归档)计划书覆盖了吗?"

**证据(计划书原文,行 253)**:
> "run-batch 自我计时,超 `batch_timeout_min` → **杀采集进程** + status=timeout + 🔴 告警。"

**证据(现有代码实证)**:
- `src/main.ts` 全文 grep 确认**没有**任何 `process.on('SIGTERM', ...)` 或 `SIGINT` 处理器,只有 `unhandledRejection`。
- `persistSeen()` 和(计划中的)账本写入都排在 `await Promise.all(jobs)` **之后**,即整个抓取流程的最后一步。

**问题**:计划书对"杀采集进程"没有说明发什么信号、给不给收尾时间。Node 子进程默认 `kill()` 发 SIGTERM,如果目标进程没注册 handler,Node 的默认行为是**立即终止、不执行任何清理代码**——效果上跟 SIGKILL 没有本质区别。由于 `persistSeen()` 目前排在流程最后,这意味着**任何一次超时触发的 kill,都 100% 丢失这一轮已经抓到但还没来得及走到"轮末"的 seen-store 更新**,即使被杀前 4 路管线已经跑完 95%。后果:下一轮这些 URL 会被当新的重新抓一遍(自愈但浪费,如果接近 batch_timeout 的源经常这样,会形成"永远追不上、每次都在超时线上被杀、从来没能把 seen-store 更新写进去"的死循环,detector 看到的是持续 0 条 source_runs,而不是真实的"这个源就是慢"）。同时僵尸进程风险本身较低(main.ts 目前不 spawn 任何子进程,SIGKILL 也不会留僵尸),这部分不是问题,但"杀进程=保证丢当轮账本和去重状态"这个隐藏代价,计划书完全没提。

**建议修改(可直接合入计划书 §5.4)**:
> `flock` 锁文件(拿不到 → 记告警退出);run-batch 自我计时,超 `batch_timeout_min` 时**先发 SIGTERM**,main.ts 需注册对应 handler:收到 SIGTERM 立即调用当前已收集到的 `persistSeen()` + 账本部分写入(哪怕本轮没跑完),再 `process.exit(1)`;run-batch 等待一个 grace period(建议 10-30s)后如果进程还没退出再补发 SIGKILL 强杀。这样超时场景至少能保住"已经抓完的部分"不用重新来过,而不是每次超时都从零重来。

---

### 9. 【P1】并发参数回落覆盖不全:mirror 池未命名 + medium.ts 独立并发机制未点名

**审计问题原文对应**:"并发参数从 shared/config 读的回落逻辑是否清晰可执行?"

**证据(计划书原文,行 240 + schedule-config,行 229)**:
> "现有三池 RPM/并发常量提升为读 `shared/config.ts`(缺省回落现有默认值 · 向后兼容)"
> `"concurrency": { "general_rpm": 600, "general_cc": 20, "medium_rpm": 150, "medium_cc": 5, "slow_rpm": 60, "slow_cc": 3, "rss_cc": 6 }`

**证据(现有代码实证,main.ts 实际有 4 个硬编码并发点,不是 3 个)**:
| 位置 | 代码 | 对应 schedule-config 键 |
|---|---|---|
| `main.ts:393-394` | `maxRequestsPerMinute: PROXY_URL ? 150 : 60, maxConcurrency: PROXY_URL ? 5 : 3` | medium_rpm/medium_cc(有对应)|
| `main.ts:409-410` | `maxRequestsPerMinute: PROXY_URL ? 600 : 300, maxConcurrency: PROXY_URL ? 20 : 10` | general_rpm/general_cc(有对应)|
| `main.ts:424-425` | `maxRequestsPerMinute: 60, maxConcurrency: 3`(slowCrawler,无 PROXY_URL 三元)| slow_rpm/slow_cc(有对应)|
| `main.ts:439-440` | `maxRequestsPerMinute: 60, maxConcurrency: 3`(**mirrorCrawler**,同样无三元)| **schedule-config 里没有 mirror_rpm/mirror_cc 键位** |

另外 `src/handlers/medium.ts:209` 有一个完全独立的机制:`Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))` —— 一个 worker-pool 并发控制,和上面 4 个 crawlee `Crawler` 构造参数**不是一套代码路径**,大概率对应 schedule-config 里的 `rss_cc`,但计划书原文完全没点名这第 5 个位置。

**问题**:mirror 池目前巧合和 slow 池数值相同(60/3),容易被执行 Claude 误判"只有三池"(计划书原文自己也这么说)而漏改 mirror 这一处(继续硬编码),或者偷懒把 mirror 和 slow 共用同一个 `slow_cc` 配置键——这样以后调 slow 池参数会连带影响 mirror 池(P3 阶段 Playwright 方案落地后 mirror 要恢复启用,到时候两个语义不同的池共用一个配置项会成为一个隐蔽的联动 bug)。`handlers/medium.ts` 的 `CONCURRENCY` 常量所在文件、机制都和 main.ts 不一样,一句"现有三池 RPM/并发常量提升为读 shared/config.ts"很容易让执行 Claude 只改 main.ts 里熟悉的三处,漏掉 medium.ts。

**建议修改(可直接合入计划书 §5.2)**:
> 现有并发相关硬编码点实际有 **5 处**,分布在 2 个文件,迁移时逐一对应:
> - `main.ts` 内 4 个 crawlee Crawler 构造参数:general(行 409 附近)/medium(行 393 附近)/slow(行 424 附近)/**mirror(行 439 附近,目前无对应配置键,需要在 schedule-config.json 新增 `mirror_rpm`/`mirror_cc`,即使当前 mirror 默认跳过也要给独立键位,不要与 slow 共用)**。
> - `handlers/medium.ts:209` 的 `CONCURRENCY` worker-pool 常量(rss 直拉),对应 `rss_cc`,是完全独立于 crawlee `maxConcurrency` 的另一套并发机制,需要单独接入 shared/config 读取逻辑。
> 每处统一用 `sharedConfig?.concurrency?.xxx ?? <现有硬编码默认值>` 的回落写法(注意 general/medium 两处的默认值本身还分 `PROXY_URL` 有无两档,回落时要保留这层判断,不能简单拿一个数覆盖)。

---

### 10. 【P1】main-run.log 每轮覆盖,账本不含原始日志归档

**审计问题原文对应**:"main.ts process.exit(0) 尾与 run-batch 子进程管理的交互...stdout/log 归档"

**证据**:
- handoff 痛点(计划书行 46):"**运行不留痕**:log 覆盖、无批次记录"—— 这是本项目要解决的原始痛点之一。
- handoff §1(行 41):"运行日志 `storage/main-run.log` | 每轮覆盖。"
- 计划书 `runs` 表 schema(行 130-145)没有任何日志路径字段;`/api/runs/:id`(行 291)只返回"单批次 + 该轮 source_runs 摘要",不含原始 stdout。
- §5.1(行 235):"单轮 ~5.5min,hourly 负载很轻"—— 确认调度频率是 hourly。

**问题**:结构化账本(runs/source_runs/crawl_errors)解决了"多少条/失败多少"这类**数字**留痕,但原始 console 输出(比如某个 handler 打的具体调试信息、某次异常的完整 stack trace)依然只活在 `main-run.log` 里,而这个文件"每轮覆盖"的痛点计划书**没有解决**,只是绕过去了。hourly 频率下,一个批次的原始日志窗口只有 1 小时——如果一个 🔴 级 `run_failed` 告警在 UI 里挂了半天才被人看到(比如老板晚上睡了,第二天早上才看告警页),此时早就被后续几轮覆盖,原始报错信息永久丢失,只剩账本里的聚合数字,给深挖具体故障原因造成困难。

**建议修改(可直接合入计划书 §4 runs 表 schema 后,或 §5.1)**:
> run-batch 收尾时把本轮 stdout/stderr 从 `storage/main-run.log` 复制归档到 `storage/logs/<run_id>.log`(而不是让 main.ts 继续每轮覆盖同一个文件),`runs` 表增加一列 `log_path TEXT`;`/api/runs/:id` 返回时带上日志文件路径或(小文件场景下)日志内容摘要,方便点开某一条历史批次直接看当时的原始输出。归档日志同样纳入 crawl_errors 的 30 天清理周期,防止无限膨胀。

---

### 11. 【P1】代理池前端化(拍板①)shared/config 未预留位置,密钥落盘安全边界未定

**审计前提**:题目明确"代理池配置未来要能在前端设置"是已拍板但计划书尚未体现的需求。

**证据**:
- 现状(handoff §2):三池代理密钥在服务器 `.env.local`(`PROXY_URL`/`PROXY_URL_MEDIUM`/`PROXY_URL_SLOW`,含明文用户名密码),**不进 git**。
- 计划书 `shared/schedule-config.json`(行 224-232)只覆盖"频率/并发/阈值",完全不提代理相关字段。
- §7.1 basic auth 密钥沿用同样的模式("账密在服务器 `.env.local`...沿用现有密钥惯例不进 git")。

**问题**:一期不需要做代理池的前端可编辑功能,但既然已经拍板"未来要能在前端设置",现在的 `shared/config.ts` 单一真源设计如果不预留同款模式,二期要做这件事时,还得再进 main.ts 改一次代理构造代码(`ProxyConfiguration` 初始化目前读的是 `process.env.PROXY_URL` 系列,和 `shared/config.ts` 现在管的"频率/并发"完全是两条线)。更重要的是一个安全边界问题:代理 URL 本身就是 `socks5://user:pass@host:port` 格式的**明文凭证**,一旦要做"前端可设置",必然伴随"前端要能读到当前配置回显"这个需求(不然用户怎么知道现在配的是什么),这意味着要么在 UI 里明文展示代理密码(风险高,尤其 D2 是"公网+密码"访问模式,basic auth 密码强度是执行 Claude 自己权衡的,不一定够强),要么做脱敏展示+单独的"重置密码"式交互(工作量不小)。这个决策(存哪、怎么脱敏、要不要加密)**不是纯技术问题,是安全边界问题**,不应该由执行 Claude 现场自己拍板。

**建议修改(可直接合入计划书 §3 配置边界段,行 99 之后)**:
> **代理池配置的前向兼容(为未来前端可编辑铺路,一期不实现 UI)**:一期 `shared/config.ts` 暂不接管代理凭证,仍读 `.env.local` 的 `PROXY_URL`/`PROXY_URL_MEDIUM`/`PROXY_URL_SLOW`;但代理相关的读取逻辑建议和并发参数用同一种"配置源优先、env 兜底"的写法封装(即便一期配置源永远为空,直接走 env 分支),减少二期改造时的重复劳动。二期真正做"前端设置代理池"之前,存储位置(shared/*.json 明文 / 加密字段 / 独立数据库表)、UI 要不要脱敏回显、访问该配置的写接口要不要比 alerts ack 更高的鉴权门槛,这些安全边界问题需要老板一次性拍板,不建议执行 Claude 到时候自行决定。

---

### 12. 【P2】RUN_SALT 与 RUN_ID 命名相似,易被混淆

**证据**:
- `src/main.ts:26`:`const RUN_SALT = \`run-${Date.now()}\`;`—— 现有机制,给 RSS/LIST 入口 URL 的 `uniqueKey` 加盐,保证"每轮必重抓入口、DETAIL 页靠 queue dedupe"。任何跑法(裸跑/run-batch 跑)都会生成,和运维台无关。
- 计划书 `runs.run_id` schema 注释(行 131):`-- 'run-<ISO时间戳>'`,由 run-batch 生成、经 `RUN_ID` 环境变量传入 main.ts,裸跑时不存在。

**问题**:两个概念都以 `run-` 开头、都叫"run 什么",一个是纯本地生成的爬虫去重盐(与账本无关),一个是账本外部注入的批次标识(裸跑时不存在)。计划书 §2 概念模型段落把"采集批次(crawl run)"的定义和 RUN_SALT 放在同一句话里讲("跑现有 main.ts:入口每轮重抓(RUN_SALT)"),容易让读者(包括执行 Claude)以为两者有关联,进而可能出现"直接拿 RUN_SALT 当 RUN_ID 用"或"改造时把两个变量合并"这类误操作 —— 一旦合并,`runs.run_id` 的格式会从 `run-<ISO时间戳>` 变成 `run-<epoch毫秒数>`,后续任何按 run_id 前缀做时间解析/排序的代码都会出问题。

**建议修改(可直接合入计划书 §2 概念模型 "采集批次" 行末尾)**:
> 采集批次(crawl run):系统唯一运行模式。跑现有 main.ts:入口每轮重抓(RUN_SALT),文章级 seen-store 去重 → 每轮只新增未见博文。首轮 seen 空 = 天然全量效果。**(注:`RUN_SALT` 是 main.ts 内部生成的爬虫去重盐,格式 `run-<epoch毫秒>`,任何跑法都会生成,与账本的 `RUN_ID`/`run_id`(格式 `run-<ISO时间戳>`,由 run-batch 注入、裸跑时不存在)是两个完全独立、互不相关的标识,改造时不要合并或互相替代。)**

---

### 13. 【P2】storage/datasets/default/ 无限增长,缺少类似 seen_store_bloat 的告警

**证据**:
- 计划书 alerts 规则表(行 271)有 `seen_store_bloat`:"seen-articles >5MB | ⚪ | 运维提醒(裁剪归二期)"——只针对 KV 存储。
- reset 的触发条件是"仅大规则变更后由 Claude 手动执行"(行 61),属于低频、人工判断触发,不是自动周期性清理。
- `storage/datasets/default/*.json` 是 crawlee 原生产物,每篇博文一个 JSON,只有 reset 才清空(问题 2 已确认现有 rm 命令范围)。

**问题**:hourly 调度长期跑下来,`storage/datasets/default/` 会持续累积(reset 频率低,可能几个月一次甚至更久),体积增长速度比 `seen-articles` KV(只存 `token_id:url` 这种短字符串)快得多,因为每条记录是完整的文章 JSON(标题+正文/摘要+若干字段)。2c4G 服务器磁盘空间有限,这属于和 `seen_store_bloat` 同类的运维盲点,但计划书没有覆盖。

**建议修改(可直接合入计划书 §6 告警规则表,seen_store_bloat 行后新增一行)**:
> `dataset_bloat` | `storage/datasets/default/` 目录体积 > 阈值(建议先观察真实增长速度再定,如 500MB)| ⚪ | 运维提醒(裁剪/归档策略归二期,和 seen_store_bloat 一并处理)

---

## 需要老板拍板的点

| # | 待拍板问题 | 为什么需要老板而非执行 Claude 决定 |
|---|---|---|
| A | reset 的精确清除范围要不要固化成一个命名脚本(如 `ops/reset.ts` 封装 `rm -rf storage/datasets storage/key_value_stores storage/request_queues`,明确排除 sources.db),还是允许执行 Claude 每次自由解读"清 storage/" | 关系到会不会误删账本+注册表这种不可逆操作,不应该靠现场文字理解 |
| B | "废弃 systemctl"的范围:只是不用 **systemd timer**(定时触发),`dashboard.service`(进程守护/开机自启/崩溃自动重启)这个 **service** 单元还留不留 | 直接决定 ops 常驻进程崩溃后有没有人拉起来;字面"废弃 systemctl"有歧义,拍板②的原话没有区分 timer 和 service 两种单元类型 |
| C | reset 时 `articles.push_status` 要不要一并清空/回滚(保留 vs 重置直接决定二期激活 push 后会不会对旧文章重复推送) | 涉及外部推送副作用(hhwl API),不是纯技术选择,一旦选错会真实产生重复数据 |
| D | 代理池前端化后,密钥怎么存(shared/*.json 明文 / 加密字段 / 独立库)、UI 要不要脱敏回显、写接口鉴权门槛要不要高于 alerts ack | 安全边界判断,且当前访问模式是"D2 公网+密码",密钥暴露面比内网环境大 |
