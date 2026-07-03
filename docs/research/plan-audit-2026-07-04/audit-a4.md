# 方案审计 · A4(日志与错误处理全链路)

审计对象:`docs/plan-ops-dashboard-2026-07-04.md`
参照:`docs/handoff-crawlee-poc-p2-2026-07-03.md` + `docs/mockup-ops-b.html` + 现有代码(`src/main.ts` / `src/handlers/article.ts`)
老板原话锚点:"一旦发生错误,我才可以知道是因为代理/网页不可达/429/500/400/404还是什么状态出现了错误"

---

## 问题清单(问题/严重度/证据/建议修改文段)

### 总览

| # | 问题 | 严重度 |
|---|---|---|
| 1 | errorHandler vs failedRequestHandler 语义缺口 · mockup"重试后成功"错误行结构上产不出来 | 🔴 P0 |
| 2 | cf challenge / 软错误页(HTTP 200 但内容是拦截页)完全不进 crawl_errors | 🔴 P0 |
| 3 | 运维台自身故障自监控盲区(废弃 systemd 后无外部看门狗) | 🔴 P0 |
| 4 | 批次硬崩溃(kill -9/OOM)→ runs.status 永久卡 running,无孤儿记录收敛 | 🔴 P0 |
| 5 | "同源同类连续出错→告警"规则无阈值 + 与 §5.3/§6 表述自相矛盾 | 🟡 P1 |
| 6 | main-run.log 归档策略空白(废弃 systemd 后 stdout 去哪/留几天/磁盘预算) | 🟡 P1 |
| 7 | crawl_errors 无 retry_after 结构化字段,mockup 已画出但 schema 没地方装 | 🟡 P1 |
| 8 | source_runs 缺 http_429/timeout/proxy_error 聚合列,http_shift 规则覆盖不到 429 | 🟡 P1 |
| 9 | run-batch 父进程在 articles upsert 完成前崩溃 = 文章因 seen-store 已推进永久丢失 | 🟡 P1 |
| 10 | 源详情面板没有该源的 crawl_errors 明细,"按源聚合视图"缺失 | 🟡 P1 |
| 11 | classify() 优先级顺序未声明(状态码/error.code/message 正则谁先判) | 🟢 P2 |
| 12 | crawl_errors 30 天清理与 runs/source_runs 无清理策略不对称 | 🟢 P2 |
| 13 | retries 字段语义未注明;message 截 300 字可能丢关键信息 | 🟢 P2 |
| 14 | "internal"兜底桶无配套监控规则,新错误模式静默堆积 | 🟢 P2 |
| 15 | mockup 错误类型筛选下拉比 schema kind 少 http_4xx/internal 两项 | 🟢 P2 |
| 16 | 错误驱动型告警 detail 未要求带 kind 分布摘要,只说"挂了"不说"为什么" | 🟢 P2 |

---

### P0-1:errorHandler vs failedRequestHandler 语义缺口

**证据:**
- 计划书 line 210:"错误明细采集:crawlee `failedRequestHandler`/`errorHandler`(每 crawler 挂一次)拿 (request, error) → ... → 内存 buffer 轮末入 crawl_errors。"— 两个 hook 并列提及,未分工。
- `docs/mockup-ops-b.html` line 207(老板已拍板的 UI 基准):`<tr><td>12:01:02</td><td><b>ACX</b></td>...<td><span class="chip">proxy_error</span></td><td>—</td><td class="det-sans">代理连接失败(主力池节点3)· 换节点后成功</td><td>1/2</td></tr>` — 这一行明确展示"第1次尝试失败(代理错误)· 第2次换节点后成功"。
- Crawlee 语义:`failedRequestHandler` 只在**重试耗尽、请求最终判定失败**时触发;上面 ACX 这行请求**最终是成功的**,`failedRequestHandler` 结构上不会为它触发。只有 `errorHandler`(每次尝试失败都触发,不论后续是否重试成功)才能产生这行数据。
- 连锁后果:429 是 session 轮换重试最典型能"救回来"的错误类型(handoff 未提但业务常识 + mockup MED 行本身就是 429 被记录的例子)。若实现时只接 `failedRequestHandler`(计划书文本读起来更像默认这个),则**所有"重试后成功"的瞬时性错误(含大量 429/proxy_error)会系统性从 crawl_errors 消失**,与老板原话"429...出现了错误,我才可以知道"直接冲突——老板关心的往往正是"这个源最近老是 429(哪怕最终抓到了)",而不只是"抓死了才算数"。

**建议修改文段(计划书 §4 line 210 附近):**
> 错误明细采集:crawlee 对每个 crawler 同时挂 `errorHandler`(每次请求尝试失败即触发,含最终重试成功的请求)与 `failedRequestHandler`(重试耗尽最终失败触发)。两者都写 crawl_errors,用 `retries` 字段区分语义(如 `1/2` = 第1次失败第2次仍在重试或已成功,`2/2` 且无后续成功记录 = 最终失败)。error-classify 单测须包含"重试后成功"与"重试耗尽"两类 fixture,对齐 mockup ACX 行与 QNT 行两种形态。

---

### P0-2:cf challenge / 软错误页完全不进 crawl_errors

**证据:**
- `src/handlers/article.ts` line 157-160:
  ```js
  const BAD_TITLE_RE = /(^|\s|\|)(404|page not found|not found|access denied|just a moment|error)(\s|\||$)/i;
  if (BAD_TITLE_RE.test(title)) {
      log.info(`⊘ [DETAIL] 错误页 title 跳过 "${title.slice(0, 50)}" | ${loaded}`);
      return;
  }
  ```
  注意其中 `just a moment` 正是 **Cloudflare JS challenge 页面的标准标题**。这条路径命中的是 HTTP 200(请求"成功"、crawlee 不会认为它 failed)但内容是拦截页——`failedRequestHandler`/`errorHandler` 都不会触发,因为从 crawlee 视角这不是一次失败请求。
- 计划书 schema(line 159)里 `source_runs.blocked_error_page` 只是一个**聚合计数列**,不产生 crawl_errors 行、没有 URL、没有 title 文本、无法从错误日志页搜到。
- handoff §2 也印证这类"看似成功实则被拦"的情况在本项目是真实存在的模式(mirror 管线因 cf JS challenge 整体跳过;substack 因 impit TLS 指纹被拉黑改走 node:fetch)。

**影响:** 老板要求的"网页不可达"里,最隐蔽也最容易被忽视的一类(服务器答应了、但给的是挑战页/软404)完全不可见于错误日志页,只能在 source_runs 里看到一个数字,查不到是哪个 URL、什么 title。

**建议修改文段(计划书 §4 line 210 附近新增一句):**
> detailHandler 内 `BAD_TITLE_RE`/`LIST_TITLE_RE` 命中时(现状仅 `log.info` 后 `return`),额外写一行 crawl_errors:`kind` 按 title 内容二次判定(命中 `just a moment` → `cf_challenge`;命中 `404|not found` → `soft_404`;其余 → `error_page`),`http_status` 记 200,`message` 存匹配到的 title 原文。三个 kind 加入 §4 枚举与 §7.2 筛选下拉。

---

### P0-3:运维台自身故障的自监控盲区(废弃 systemd 后无外部看门狗)

**证据:**
- 全文档唯一的进程自愈机制:计划书 line 284:`systemd dashboard.service 常驻(Restart=always)`。
- 全文 grep "看门狗/watchdog/heartbeat/心跳/自监控/pm2/supervisor" 零命中——没有第二道防线。
- 本次审计任务明确告知的拍板②:"废弃 systemctl(调度进运维台进程 · 批次由运维台 spawn)"——这条新拍板把"调度"这个职责从 systemd 搬进运维台常驻进程,但字面上"废弃 systemctl"没有限定范围,唯一现存的 `Restart=always` 兜底(line 284)大概率也在废弃之列。
- 服务器是 2c4G(handoff §1 + 计划书 line 29),`CRAWLEE_MEMORY_MBYTES=2048` 已经预定死一半内存(handoff §8 坑账实锤此参数直接决定并发上限,说明内存压力是真实存在的运维常量,不是假设)。运维台进程要 24x7 常驻 + 内部定时器调度 + spawn 采集子进程,长期运行下的内存泄漏/OOM 风险并非纸上谈兵。

**影响:** 一旦运维台进程本身崩溃(未捕获异常 / OOM / 长期运行退化),后果是**调度停止 + 账本不再写入 + 告警产生逻辑一起停摆**——而告警系统恰恰是老板发现问题的唯一渠道(C1 UI 页内)。系统"死透了"却没有任何东西能告诉老板"系统已经不工作了",这是自监控设计里最典型的"监控者自己失踪"盲区,且严重度高于普通功能 bug,因为它会让**所有其它错误可观测性设计一并失效且无声**。

**建议修改文段(计划书 §5.1/§7.1 之间新增一节"运维台进程存活保障"):**
> 运维台进程需要独立于自身逻辑的外部存活保障(候选方案见"需要老板拍板"章节)。无论选哪种,要求:①进程崩溃后能在 N 分钟内自动拉起;②进程存活状态本身要能被"运维台之外"的东西观测到(不能靠运维台自己的 dashboard 显示"我还活着"——它挂了 dashboard 也打不开)。

---

### P0-4:批次硬崩溃 → runs.status 永久卡 running,无孤儿记录收敛

**证据:**
- 计划书 line 249:`批次级 | 整轮崩溃 → runs.status=failed + 🔴 告警;timer 下周期自然重跑;flock 互斥(上轮未完 → skipped_overlap 告警)`——这句话默认"崩溃"都能被捕获并写 `status=failed`,但这只在"子进程(main.ts)异常退出、父进程 run-batch 存活并捕获退出事件"的场景下成立。
- 若崩的是 **run-batch/运维台进程本身**(kill -9、OOM killer、服务器重启),没有任何代码在执行写 `status=failed` 这条 UPDATE——因为能执行这条写入的进程已经死了。`runs` 表里这一行会永远停在 `status='running'`,`finished_at` 永远是 NULL。
- flock 文件锁本身没问题(内核在持有进程死亡时自动释放,下一轮能正常抢到锁、不会死锁)——但这只解决"调度继续跑",不解决"这条脏记录躺在表里"。
- 计划书 §8 验收标准第 3 项"执行层 run-batch.ts:锁/超时/失败三路径各实测一次"——只测 3 条路径(锁/超时/失败),没有第 4 条"进程被外部硬杀"路径。
- 下游影响真实存在:总览页(mockup line 100-106)的"脉搏行"如果按"最新一条 runs 记录"取数,这条永远 running 的孤儿记录会让首页**永久**显示"批次进行中"的假象。

**建议修改文段(计划书 §5.4 结尾新增):**
> run-batch 启动时(抢到 flock 锁之后、开始新一轮之前)先检查 `runs` 表里是否存在 `status='running'` 且 `started_at` 早于 `2×batch_timeout_min` 的陈旧记录;若有,判定为进程异常终止,回写 `status='crashed'`(新增枚举值,或复用 `failed` 但 notes 注明"进程异常终止(下轮启动时侦测)"),`finished_at`=当前时间,并触发一条 🔴 `run_crashed` 告警(§6 告警类型清单新增)。§8 验收标准第 3 项追加第 4 条路径:`kill -9` 采集子进程所在的运维台进程,验证下轮启动时正确回收孤儿记录。

---

### P1-5:"同源同类连续出错→告警"规则无阈值 + 文本自相矛盾

**证据:**
- §7.2 错误日志页描述(line 307):"同源同类连续错由 detector 聚合成告警(两页联动)"——没给"连续几轮"或"几条"的判定标准。
- `shared/schedule-config.json`(line 230)`alert_thresholds` 只有 `list_shrink_min`/`pipeline_drop_pct`/`stale_days_info` 三个 key,没有任何"连续出错阈值"配置项——说明这条规则目前**没有对应的 detector 实现依据**,只是一句描述性的话挂在 UI 文案里。
- 更严重的是内部矛盾:
  - §5.3(line 248):"源级 | ... 连续失败升级为告警(不无限静默重试)"——暗示需要"连续"才升级。
  - §6 `source_gone` 规则条件(line 263):"近 7 天有产出的源,本轮 requests>0 且全 failed"——**字面上单轮满足即可开告警**,不要求"连续"。
  - §6 状态机(line 273):"条件连续 2 轮不满足 → 自动 resolved"——这条"连续 2 轮"讲的是**关闭**条件,不是**开启**条件。
  三处对"连续"的要求互相不对齐,执行 Claude 拿到这份文档大概率会按 §6 的字面条件实现成"单轮全失败即开 🔴 告警",与 §5.3/§7.2 的"连续"表述不符——单轮网络抖动就拉响 🔴 级告警,噪音偏高,也不是老板想要的"告警少而准"(§6 line 259 设计原则)。

**建议修改文段(§6 表格前新增一段,并在 schedule-config 补字段):**
> `source_gone` 开启条件改为:近 7 天有产出的源,**连续 `error_streak_runs`(默认 2)轮** requests>0 且全 failed。`schedule-config.json.alert_thresholds` 新增 `error_streak_runs: 2`。crawl_errors 级"同源同类"聚合规则独立成一条新 detector 规则 `error_kind_streak`:同 (token_id, kind) 在 crawl_errors 里连续出现 ≥`error_streak_runs` 轮 → 🟡;≥`error_streak_runs_red`(默认 4)→ 🔴。

---

### P1-6:main-run.log 归档策略空白

**证据:**
- 计划书 §1.2(line 41):"运行日志 | `storage/main-run.log` | 每轮覆盖。handlers 现有 log 点(拦截/入队/成功)是埋点改造的对照表"——明确承认现状是"每轮覆盖",且计划书全文没有再提这件事。
- 老板两个新拍板之一:"废弃 systemctl(调度进运维台进程 · 批次由运维台 spawn)"。现状(handoff §9 line 134)stdout 重定向是通过 shell 的 `> storage/main-run.log 2>&1` 手工拼出来的;一旦改成 run-batch.ts 用 `child_process.spawn` 接管,**stdout 往哪里写、是否按 run 分文件、留几天、占多少磁盘**——这些是全新的、run-batch 必须做决定的事,计划书没有一处提及。
- 现有的丰富 console.log(main.ts 通篇,line 46-528 我审计时读到的大量 `console.log`)是排查具体某轮"为什么这个源没抓到"的重要原始信息来源(比 crawl_errors 结构化数据更细,比如 line 236 的 sitemap 失败降级 LIST 的过程日志),覆盖掉等于丢失这轮的完整现场。
- `runs` 表(§4)没有 `log_path` 之类字段,即使以后想加"查看本轮原始日志"链接也无处挂。

**建议修改文段(计划书 §3 目录规划 或 §5.4 附近新增一节):**
> run-batch spawn 采集子进程时,stdout/stderr 重定向到 `storage/logs/<run_id>.log`(而非覆盖 main-run.log);`runs` 表新增 `log_path TEXT` 列指向该文件。保留策略:与 crawl_errors 对齐,保留最近 30 天或最近 N 次运行(取较严者),run-batch 收尾阶段做超期清理,并在 README.md 的磁盘预算小节给出"单次日志体积 × hourly 频率 × 30 天"的预估数字。总览/错误日志页可选挂一个"查看原始日志"链接指向该文件(至少后端 API 留口子)。

---

### P1-7:crawl_errors 无 retry_after 结构化字段

**证据:**
- `docs/mockup-ops-b.html` line 203(老板已拍板的 UI 基准):`<td class="det-sans">Too Many Requests · retry-after 60s</td>`——UI 设计已经默认要展示 retry-after 的具体秒数。
- 全项目 grep "retry-after/retryAfter/Retry-After" 命中仅此一处(mockup 里的假数据)。计划书 §4 crawl_errors 建表 SQL(line 179-189)没有任何字段能装这个值,只有自由文本 `message`(截 300 字)。
- 429 场景下 retry-after 是**唯一直接告诉运维"该等多久"的信号**(60s 和 3600s 是完全不同的运维含义,前者"稍微放慢"、后者"基本等同临时封禁"),老板明确点名要看 429,这个值理应结构化存储而不是塞进自由文本靠正则复原。

**建议修改文段(§4 crawl_errors 建表 SQL,line 186 `http_status INTEGER` 后新增一行):**
> `retry_after_s INTEGER,  -- 🆕 429/503 响应头 Retry-After 秒数(有则记,无则 NULL)`
> error-classify.ts 对 kind=http_429/http_5xx 时尝试从 `error.response?.headers['retry-after']` 或等价字段解析写入。若 crawlee 传给 `errorHandler`/`failedRequestHandler` 的 error 对象在特定内部重试路径下不携带原始 response(需要实现时用真实 429 响应验证,不能假设一定拿得到——参见"需要老板拍板"章节),退而求其次至少把 header 值原样拼进 `message`,格式固定为便于日后正则抽取(如 `"...·retry-after=60"`)。

---

### P1-8:source_runs 缺 http_429/timeout/proxy_error 聚合列,http_shift 覆盖不到 429

**证据:**
- `source_runs` 建表 SQL(line 147-163)聚合列只有:`failed`(总数)、`http_403`、`http_404`,以及一组"拦截类"计数(`blocked_noise`/`blocked_external`/`blocked_error_page`)——**没有 `http_429`、`timeout`、`proxy_error` 等列**。
- `http_shift` 规则(§6 line 264):"上轮 2xx 为主 → 本轮 403/404 为主"——条件文本明确只看 403/404,结构上也只能看这两个(因为 source_runs 没有别的细分列可供比较)。
- 后果:一个源从"全 200"变成"全 429"(典型的"这个源开始限我了"信号,老板点名要看的状态之一),`http_shift` 不会触发(不是 403/404);`source_gone` 也不一定触发(如果 429 不是 100% 比例,或者站方允许部分请求通过);于是这个明确被老板点名的状态,在 detector 层面没有任何规则能捕捉到环比变化,只能靠人工去错误日志页肉眼翻。

**建议修改文段(§4 source_runs 建表 SQL,line 156 `http_404` 后新增):**
> `http_429 INTEGER DEFAULT 0, timeout INTEGER DEFAULT 0, proxy_error INTEGER DEFAULT 0,  -- 🆕 与 crawl_errors.kind 对齐的聚合列 · 供 detector 环比`
> §6 `http_shift` 规则条件改为"上轮 2xx 为主 → 本轮 403/404/429 为主之一";并新增一条 `rate_limited` 规则:`http_429` 占比 >50% 且连续 2 轮 → 🟡(语义与 403/404 型的"断供"不同,提示"该放慢这个源"而不是"该查规则/查封禁")。

---

### P1-9:run-batch 父进程崩溃窗口 → articles 表永久少数据、无痕迹

**证据:**
- `src/main.ts` line 530-534:采集子进程收尾顺序是 `await persistSeen();` 然后 `process.exit(0);`——seen-store(去重记忆)在子进程退出前已经**落盘提交**。
- 计划书 line 214:"articles 写入:run-batch 在采集结束后,把本轮新增(dataset 中 crawledAt > started_at 的条目)upsert 进 articles 表。"——这一步发生在**子进程退出之后、父进程(run-batch)里**,是单独的一步。
- 两者之间存在时间窗口:子进程已经把这批 URL 记入 `seen-articles`(意味着**下一轮不会再抓这些 URL**,因为 seen-store 就是靠这个去重),但父进程还没来得及把这批文章 upsert 进 `articles` 表。若父进程在这个窗口崩溃(参见 P0-3/P0-4 的崩溃场景),这批文章会:①原始 JSON 还在 `storage/datasets/` 里(数据没有物理丢失),但②**永久不会出现在 articles 表**(博文管理页、未来 push 流程都读不到它们),③**也永远不会被重新采集**(seen-store 已经标记过),④且**没有任何错误/告警提示这件事发生过**——是一种完全静默的数据缺口。

**建议修改文段(§4 "articles 写入" 段落,line 214 后新增):**
> 为避免 seen-store 提交与 articles 落库之间的崩溃窗口造成静默丢数据,两种方案二选一(倾向 A,老板拍板见下):
> A. 调整顺序:main.ts 的 `persistSeen()` 延后到 run-batch 确认 articles upsert 成功之后再调用(需要 main.ts 与 run-batch 之间加一步"确认"信号,轻微增加耦合但消除窗口)。
> B. 保持现状顺序,但 run-batch 每次启动时用 dataset 的 `crawledAt` 时间戳做一次"补漏"扫描:凡是 `crawledAt` 落在某个已完成 run 的时间区间、但未出现在 articles 表里的记录,视为上次崩溃遗留,本轮启动时补 upsert。

---

### P1-10:源详情面板没有该源的 crawl_errors 明细,"按源聚合视图"缺失

**证据:**
- 计划书 §7.1 API 表(line 295):`GET /api/sources/:token_id` 描述为"单源详情(近 30 轮 source_runs + articles 表最近 10 篇 + 告警史)"——三块内容里没有 crawl_errors。
- `docs/mockup-ops-b.html` line 158(源管理页脚注,真实 UI 设计已经画出交互范围):"点行展开详情(30 轮趋势 + 最近博文 + 告警史)"——同样三块,没有第四块"该源最近错误"。
- 结果:老板如果在源管理页看到某源"近轮失败 12/12"(mockup line 151 QNT 行的真实展示),点开详情面板,看到的是趋势图+博文+告警史,**唯独看不到这 12 条失败请求各自是什么类型(403/超时/代理错)**——必须手动跳到错误日志页、在搜索框里敲这个源的 symbol 才能查,链路是断的,不是一步到位的"这个源怎么了"体验。

**建议修改文段(§7.1 line 295 API 描述 + §7.2 源管理页描述):**
> `GET /api/sources/:token_id` 返回内容追加第四块:"近 20 条 crawl_errors(该 token_id,按 at 倒序)"。源管理页展开面板对应增加一个"最近错误"小节(时间/URL/kind chip/message),点击可跳错误日志页并带上该 symbol 的筛选条件(双向链接:错误日志页的源列同样可点回源详情)。

---

### P2 级(改进项,合并简述)

- **P2-11 classify() 优先级未声明**:计划书 line 210 举例"impit 代理错→proxy_error"读起来像是"impit 抛出的错误都归 proxy_error",但 impit 作为 HTTP 客户端本身也会抛超时/403/DNS 失败等各种错误,如果字面理解会导致大量本该细分的错误被"proxy_error"这个桶吃掉,违背老板要精细分类的初衷。建议在 error-classify.ts 设计里明确判定优先级:①有 HTTP 状态码 → 按状态码分(403/404/429/4xx/5xx);②无状态码但有 `error.code`(Node 系统错误码 ECONNRESET/ETIMEDOUT/ENOTFOUND/ECONNREFUSED)→ 按 code 分(unreachable/timeout 等);③都没有 → message 正则兜底;④都不匹配 → `internal`。仅当错误明确来自代理层握手/连接阶段(而非目标站点响应)才归 `proxy_error`。

- **P2-12 保留策略不对称**:crawl_errors 30 天清理(line 190)有明确策略,`runs`/`source_runs`/`articles`/`alerts` 都没有。查 30 天前的批次时,`source_runs.failed` 计数还在但 crawl_errors 明细已被清空,错误日志页对这类历史批次应显式提示"该批次错误明细已超保留期清理"而不是渲染一张空表(容易被误读成"那轮没有错误")。

- **P2-13 字段语义/截断**:`retries` 字段建议在 schema 注释里明确是"该请求已重试次数"还是"最终重试位置(如 2/2)";`message` 截 300 字对长 stack 的错误(尤其 TLS/证书链报错)可能把最有用的部分切掉,建议 `error.code`(短、稳定、机器可读)单独入一列,`message` 仅作人工排查的辅助文本,不作为分类判定依据。

- **P2-14 "internal" 桶无监控**:§6 detector 规则列表(source_gone/http_shift/list_shrink/feed_dead/external_surge/noise_surge/pipeline_drop/run_failed 等)没有一条盯着"未识别错误"本身。建议新增 `unclassified_surge`:单轮 `internal` kind 计数超过阈值 → 🟡,提示"分类器可能遇到新错误模式,需要扩展 kind 枚举"(GOAWAY、重定向循环等目前项目还没实锤过、但常见于爬虫场景的错误类型,都会先落进这个桶)。

- **P2-15 mockup 筛选下拉不全**:`docs/mockup-ops-b.html` line 196 的错误类型下拉比 schema kind 枚举(line 184)少了 `http_4xx` 和 `internal` 两项。执行时如果照抄 mockup 的下拉选项会导致这两类错误在 UI 上永远筛不出来,建议实现时以 schema 枚举为准,不要以 mockup 的示例下拉为准。

- **P2-16 告警 detail 该带"为什么"**:mockup line 134 的 `source_gone` 示例已经带了"本轮 12 请求全部 403"这种具体原因,但这是因为 QNT 恰好 100% 是同一种 kind,容易描述。对于混合错误类型的场景(比如 60% 超时 + 40% 代理错),建议明确要求 alerts.detail 的生成逻辑统一从 crawl_errors 按 run+token 聚合出 kind 分布并拼进 detail(如"12/12 失败 · http_403×8 + timeout×4"),而不是只有"全部失败"这种不带原因的描述,否则退化成"告诉你挂了但不告诉你为什么挂",没有完全兑现老板的诉求。

---

## 需要老板拍板的点

| # | 问题 | 选项 |
|---|---|---|
| 1 | 废弃 systemctl 后,谁保证运维台进程本身活着(P0-3)| A. 保留一个极简 systemd unit,只做"进程活体重启"(`Restart=always`),不装调度定时器,调度逻辑仍在运维台进程内部 —— 字面上"调度职责"确实搬进了运维台,只是"进程存活"这件事继续借 systemd 的手 &nbsp;B. 换用 pm2/forever 等用户态进程管理器 &nbsp;C. cron `@reboot` + 独立 shell 脚本定期探活(心跳文件 mtime),不依赖运维台自身、也不依赖 systemd |
| 2 | crawl_errors 要不要加 `retry_after_s` 结构化列(P1-7)| A. 加列,error-classify 显式解析 &nbsp;B. 不加列,继续塞进 message 自由文本(需先验证 crawlee 在 429 场景下 error 对象是否稳定带得到 response headers,不能假设) |
| 3 | errorHandler 和 failedRequestHandler 是否都接(P0-1)| A. 都接,用 retries 字段区分"重试中失败"与"最终失败"两类行(对齐 mockup ACX/QNT 两种示例)&nbsp;B. 只接 failedRequestHandler(需明确告知老板:后果是"重试后自愈"的错误如多数 429 将不出现在错误日志,与 mockup 展示的效果不符)|
| 4 | seen-store 提交与 articles 落库的崩溃窗口(P1-9)| A. 调整顺序,main.ts 等 run-batch 确认 articles 落库后再 persistSeen &nbsp;B. 保持现状顺序,run-batch 每次启动时做"补漏扫描"弥补 |

---

*审计人:方案审计员 A4(维度:日志与错误)· 2026-07-04*
