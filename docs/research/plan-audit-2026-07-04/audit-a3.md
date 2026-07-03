# 方案审计 A3(维度:调度)— plan-ops-dashboard-2026-07-04.md

审计范围:计划书 §3(架构图/目录)、§5(调度/并发/重试)、§7(UI呈现)、§8(验收标准)中与"调度"相关的全部内容。核心任务:把 systemd timer 方案改写成"运维台自建调度器"方案。

---

## 问题清单

| # | 问题 | 严重度 | 证据(文件:行) | 建议 |
|---|---|---|---|---|
| P0-1 | 计划书 **7 处**引用 systemd timer/service 触发采集,与老板 2026-07-04 新拍板("废弃 systemctl,调度由运维台自建")全面冲突 | 🔴 P0 | plan §3 架构图 L73「调度器:systemd timer」;§3 目录 L119「systemd/ # crawl.service/timer」;§5.1 L234「systemd \`crawl.timer\` 按 interval 安装」;§5.3 L249「timer 下周期自然重跑;flock 互斥」;§5.4 L253「\`flock\` 锁文件」;§7.1 L284「systemd \`dashboard.service\` 常驻」;§8 验收 L322「timer 连续 24h 无人工干预」 | 见下方【核心交付:§5 完整替换文段】,并同步改 §3/§7.1/§8(文末列出 ripple 编辑点) |
| P0-2 | **崩溃恢复缺失**:新架构把调度搬进 ops 常驻进程后,"下次运行时间"若只存内存,ops 进程一重启(部署/崩溃/OOM)调度就完全失忆 —— 要么立即触发(如果重启即判断"到点了")要么永久错过(如果重启后等一个全新整点/整小时)。旧方案里 systemd timer 由内核持久化定时器状态,这个问题不存在;搬进程内后是**新增的失败模式**,计划书完全没提及 | 🔴 P0 | plan §5.4 L253 只有 flock+超时,无任何重启/持久化设计;§4 schema(L130-207)无 next_run_at 字段落点 | 新增 `schedule_state` 表持久化 `next_run_at`;ops 启动时先跑 `recoverFromCrash()` 补偿僵尸 `running` 行(详见下方替换文段) |
| P0-3 | **互斥机制未适配新架构**:`flock` 文件锁是为"systemd 每次拉起一个全新独立进程"设计的跨进程锁;新架构调度器和执行都常驻同一个 Node 进程里,继续用 flock 会producing 实现两套互斥语义(进程内该用变量,却硬套文件锁),且不解决"重启后/双实例场景"的判断依据 | 🟠 P0 | plan §5.4 L253 沿用 flock;§3 老板拍板的"一个库/一个访问层"原则(L91-95)未被贯彻到锁机制上 | 改成 SQLite 原子占位(`INSERT ... WHERE NOT EXISTS`)替代文件锁,与"一个库"原则一致,见替换文段 |
| P0-4 | **schema 缺口**:老板点名要审计的 5 项调度元数据 —— 下次运行时间持久化 / 暂停恢复状态 / 手动触发记录(谁触发) / 批次类型(未来 browser run) / 排队中状态 —— 现有 `runs`/`source_runs`/`alerts` 表**一项都没覆盖** | 🔴 P0 | plan §4 L130-145 `runs` 表字段:仅 run_id/started_at/finished_at/duration_s/status(枚举 running/ok/failed/timeout/skipped_overlap)/is_after_reset/dataset_added/requests_total/requests_failed/sources_with_new/alerts_opened/rpm_actual/git_commit/notes —— 无 trigger、无 batch_type、status 无 queued 值;全库无 schedule_state 表 | 见下方 SQL 建议(ALTER TABLE + 新表 schedule_state) |
| P0-5 | **A2"唯一写操作=ack"拍板与新增写操作之间存在未声明的冲突**:本次审计任务本身要求设计"手动触发批次"和"暂停/恢复调度"两个新写操作,叠加背景提到的"代理池配置未来前端可设置",三者都突破了 §0 表格 A 行"唯一写操作:告警 ack"的既定拍板。计划书没有任何一处提到这个矛盾,执行 Claude 会陷入两难:要么死守"唯一写操作 ack"不敢做手动触发/暂停(功能缺失),要么擅自扩大写操作范围但没有正式授权(违反铁律 4"不允许擅自修改已确认参数") | 🔴 P0 | plan §0 L14「唯一写操作:告警 ack」;§7.1 L293「\`POST /api/alerts/:id/ack\` \| 唯一写操作(状态标记)」—— 与本次拍板要求的"手动触发/暂停开关"直接矛盾 | 见下方【需要老板拍板的点】第 3 条,建议一次性把写操作范围重新定义为白名单,而不是逐个功能各自突破 |
| P1-6 | **UI"调度状态"呈现不完整**:老板点名"调度状态/用时/这一批成功与否"要在 UI 完整呈现,但计划书总览页设计里,"用时"(耗时)、"这一批成功与否"(status)基本覆盖,唯独**"调度状态"本身**(是否暂停/是否排队中/由谁触发/调度器是否还活着)完全没有对应 UI 元素 —— §7.2 提到"栏底常驻调度状态"这个占位但从未详细设计过内容 | 🟡 P1 | plan §7.2 L299「左侧固定导航(五项 + 栏底常驻调度状态)」只有 6 个字带过,无字段细节;L303 总览行只有"下次倒计时",无暂停态/排队态/触发方式;24 批次健康带(L303)只提"绿黄红",无 queued/skipped_overlap 对应的第 4 种视觉 | 见下方【总览页 & 栏底状态替换文段】 |
| P1-7 | **运维台进程自身守护方案未定**:废弃 systemd `dashboard.service` 触发采集的同时,若连"进程保活"这个基础职责也一并推翻,新架构没说清楚 ops server(现在身兼 dashboard + 调度器双重职责)崩溃后谁把它重新拉起来 | 🟡 P1 | plan §7.1 L284「systemd \`dashboard.service\` 常驻(Restart=always)」是旧设计唯一提及进程守护的地方,新拍板"废弃 systemctl"字面上覆盖了这一行,但没给替代方案 | 见下方【需要老板拍板的点】第 1 条(A/B/C 三选一) |
| P1-8 | **暂停时 next_run_at 的语义未定义**:老板要"暂停调度"开关,但"暂停期间时间是否继续流逝"直接决定"恢复后立刻补跑一轮 vs 等到下一个自然整点"这个体验差异,计划书完全没这个概念,不能靠执行 Claude 自己猜 | 🟡 P1 | 计划书无对应内容(新概念,§2/§5 均未提及"暂停") | 建议:暂停时**冻结** `next_run_at`(不推进),恢复时若 `next_run_at` 已过期则补跑 1 轮(不是把暂停期间错过的 N 轮全部补上),之后回到正常节奏。标注为可拍板项 |
| P1-9 | **ops 进程的 `.env.local` 加载方式未定义,存在"裸跑无代理"的生产事故风险**:旧架构下 systemd `crawl.service` 可以在 unit 文件里配 `EnvironmentFile=.env.local`,保证代理池配置每次都到位;新架构下 main.ts 由 ops 进程 `spawn` 拉起并继承 `process.env`,如果**启动 ops 进程的脚本忘了 `source .env.local`**,子进程会在没有代理池的情况下裸跑,可能导致三池代理配置(handoff §2)全部失效、IP 被目标站封锁 | 🟡 P1(影响面大,操作失误概率不低) | handoff §2「PROXY_URL... 换池 SOP:只改 .env.local · 代码无感」隐含依赖 shell 环境或 systemd EnvironmentFile 注入;plan 未提 ops server 自己如何拿到这些变量 | 建议 `ops/server/index.ts` 入口代码层显式 `dotenv.config({path:'.env.local'})` 而不依赖启动脚本,见替换文段 |
| P1-10 | **`storage/main-run.log` 每轮覆盖的老痛点,在新调度架构下依然没解决,且与"运行不留痕"诉求自相矛盾**:账本(runs/source_runs/crawl_errors)解决了结构化数据不留痕,但原始 stdout/stderr 文本日志依旧覆盖式,旧架构下至少还能靠 `journalctl` 查 systemd 单元的历史日志兜底,新架构下**这个兜底也一并被废弃了**,而计划书没人补上 | 🟡 P1 | plan §1.2 L41「运行日志 storage/main-run.log · 每轮覆盖」;§1.3 L46「痛点2:运行不留痕...无从查起」;新 §5 设计全文未提子进程 stdout/stderr 落盘方式 | run-batch spawn 子进程时按 `run_id` 落盘 `storage/logs/<run_id>.log`(而非固定文件名),配 30 天清理(比照 crawl_errors 策略) |
| P1-11 | **手动触发"忙时"的行为(拒绝 or 排队)未定义**,但老板原话点名"排队中状态"要审计,暗示可能希望支持排队而非简单拒绝,这是个功能行为分歧点,不能由执行 Claude 单方面拍板 | 🟡 P1 | 计划书无对应内容(新功能) | 见下方【需要老板拍板的点】第 2 条 |
| P1-12 | **§8 验收标准 #4 仍完全按 systemd 撰写**,新架构下"timer 连续 24h 无人工干预"这条验收标准既验不了(没有 timer 了)也不够(漏了重启恢复/暂停/手动触发/排队这些新行为) | 🟡 P1 | plan §8 L322「4 \| 调度 \| timer 连续 24h 无人工干预,runs ≥24 条 ok;重叠保护实测(手动占锁 → skipped_overlap 告警)」 | 见下方【§8 验收标准替换文段】 |
| P1-13 | **"栏底常驻调度状态"是跨五页的导航栏组件,但只读 API 表里只有 `GET /api/summary` 一个入口且语义上属于"总览页专用"** —— 若调度状态展示挂在 summary 接口下,告警页/源管理页/博文管理页/错误日志页的导航栏就拿不到数据,组件渲染会出现四页缺数据或要重复打 summary 接口(语义不清晰) | 🟡 P1 | plan §7.1 L289「\`GET /api/summary\` \| 总览(...下次运行时间/锁状态)」;§7.2 L299 栏底状态是五页共享的导航栏元素,与 L289 的"总览专属"接口定位矛盾 | 新增独立轻量接口 `GET /api/schedule/state`,专供导航栏组件在任意页面调用;`/api/summary` 可以继续内嵌同样字段供总览页复用,但不能是唯一来源 |
| P2-14 | `runs` 表建议加 `exit_code`/`exit_signal`,区分"main.ts 逻辑判定失败"、"被 SIGTERM/SIGKILL 杀死"、"未捕获异常崩溃"三种不同失败形态,排障用 | 🟢 P2 | plan §4 L130-145 无此字段 | 见下方 SQL 建议 |
| P2-15 | `schedule_state` 建议加 `last_tick_at` 心跳字段:调度器所在进程"活着但卡死"(event loop 被某个同步阻塞饿死)不会被任何进程级 supervisor 判定为异常,只有应用层心跳能发现 | 🟢 P2 | 新概念,计划书未提及此类"存活但失能"故障模式 | 见下方 SQL 建议 + UI 用 last_tick_at 距今 >5min 标红提示 |
| P2-16 | 建议字段命名 `trigger` → `triggered_by`:`TRIGGER` 是 SQLite 语法关键字(用于 `CREATE TRIGGER`),做列名虽多数场景可用但有转义/工具兼容性风险,且 `triggered_by` 语义更准确(区分 scheduler/manual/未来具体身份) | 🟢 P2 | 命名建议,非计划书原文缺陷 | 直接采纳 `triggered_by` 命名 |
| P2-17 | 暂停开关建议可选"自动过期"(如暂停超过 N 天自动提示/自动恢复),防止老板临时暂停后忘记,长期断供不自知 | 🟢 P2(锦上添花,非必须) | 新概念 | 一期可不做,仅记录 `paused_at` 供 UI 显示"已暂停 N 天"提醒即可,不强制自动恢复 |
| P2-18 | 手动触发 API 建议加节流(如 5-10 秒内重复请求返回 409),防止老板/误触连点多次造成多条 queued 记录堆积 | 🟢 P2 | 新概念 | 前端按钮点击后立即 disable + 后端按 `schedule_state.updated_at` 做简单节流 |

**P0 × 5 / P1 × 8 / P2 × 5,共 18 条。**

---

## 核心交付:§5 完整替换文段(直接替换原计划书 §5.1 ~ §5.4)

> 原标题"5.1 频率"改为"5.1 调度器",因为新架构下这一节的职责已远超"一个 json 配置",涵盖触发、手动触发、暂停在内的完整调度器设计。5.2 并发原文不变,一并贴出保持章节连续。5.3/5.4 有实质修改。

````markdown
## 5. 调度 / 并发 / 重试(老板点名四维度)

### 5.1 调度器(内置 · 2026-07-04 老板拍板废弃 systemctl,不再用 systemd timer 触发采集)

**架构:** 调度逻辑搬进 `ops/server/index.ts` 常驻进程内部,不再依赖任何外部定时机制(systemd timer / cron)触发采集。新增两个职责清晰分离的模块:

- **`ops/scheduler.ts`** —— 只回答"现在该不该跑":`startScheduler()` 在 server 启动时调用一次,内部 `setInterval(tick, scheduler_tick_ms)`(默认 30 秒一次,批次以分钟计,不需要秒级精度)。每次 tick 读 `schedule_state` 判断是否到 `next_run_at`、是否 `paused`,到点就调 `run-batch.ts` 的 `runBatch()`。
- **`ops/run-batch.ts`** —— 只回答"怎么跑一轮":对外导出 `runBatch(opts)`,内部做 SQLite 原子占位 → spawn 采集子进程 → 挂超时 kill → 收尾写账本/调 detector。**调度器 tick 和手动触发 API 走同一个 `runBatch()`,不搭两份互相脱节的实现。**

```ts
// shared/schedule-config.json 新增一项(其余不变)
{
  "crawl_interval": "hourly",
  "scheduler_tick_ms": 30000,   // 🆕 调度器检查粒度,改这个不需要重装任何东西
  "batch_timeout_min": 30,
  ...
}
```

```ts
// ops/run-batch.ts —— 单一执行入口,调度器和手动触发共用
let activeChild: ChildProcess | null = null;   // 进程内快速判重(挡同一 tick 内的重复调用)

export async function runBatch(opts: { trigger: 'scheduler' | 'manual'; batchType?: string }) {
  const batchType = opts.batchType ?? 'crawl';
  if (activeChild) return { ok: false, reason: 'busy' };

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  // SQLite 原子占位,替代 flock 文件锁:全局互斥(不分 batch_type ——
  // 服务器 2c4G 资源有限,crawl/probe/browser 现阶段一律不并行,二期若证明 probe 足够轻量再放开)
  const claimed = ledger.claimRunSlot({ runId, triggeredBy: opts.trigger, batchType });
  if (!claimed) return { ok: false, reason: 'skipped_overlap' };  // 跨重启/双实例场景也认这个

  activeChild = spawn('npx', ['tsx', 'src/main.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, RUN_ID: runId },   // .env.local 由 ops 进程自己 dotenv 加载(见 5.4),子进程自然继承代理池配置
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeToLogFile(activeChild, `storage/logs/${runId}.log`);  // 按 run_id 落盘,替代 main-run.log 覆盖式(问题清单 P1-10)

  const cfg = loadScheduleConfig();  // 每次调用都重新读 json → 改频率零重启生效
  const killTimer = setTimeout(() => {
    activeChild?.kill('SIGTERM');
    setTimeout(() => activeChild?.kill('SIGKILL'), 10_000);  // 10s 宽限后强杀,防僵尸子进程
    ledger.markRunTimeout(runId);
  }, cfg.batch_timeout_min * 60_000);

  activeChild.on('exit', async (code, signal) => {
    clearTimeout(killTimer);
    await ledger.finishRun(runId, { exitCode: code, exitSignal: signal });
    await ledger.advanceNextRun(batchType, cfg.crawl_interval);  // 无论成功失败,统一"结束时刻 + interval"续下一棒
    await runDetectorAndArticleSync(runId);  // 沿用原设计的收尾职责:detector 环比 + articles upsert
    activeChild = null;
  });

  return { ok: true, runId };
}

export const isRunActive = () => activeChild !== null;
```

```ts
// ops/scheduler.ts
export function startScheduler() {
  recoverFromCrash();  // 见 5.4,ops 进程每次启动都先跑一次
  const cfg = loadScheduleConfig();
  setInterval(tick, cfg.scheduler_tick_ms ?? 30_000);
  tick();  // 启动即判断一次,不等第一个 tick 周期
}

function tick() {
  ledger.touchScheduleTick('crawl');   // 🆕 心跳,UI 用来判断调度循环是否卡死(问题清单 P2-15)
  const state = ledger.getScheduleState('crawl');
  if (state.paused) return;             // 暂停:冻结判断,不推进 next_run_at(问题清单 P1-8)
  if (new Date(state.next_run_at) > new Date()) return;
  void runBatch({ trigger: 'scheduler', batchType: 'crawl' });
}
```

**改频率:** 改 `schedule-config.json` 的 `crawl_interval` 即可,调度器每次 tick / 每次 `runBatch` 调用都重新读文件(零重启热更新)。**不再需要"改 json + 重装 install.sh"这道部署动作** —— 这是老 systemd 方案遗留的运维摩擦,新架构顺带消除。

**手动触发(dashboard"立即跑一轮"按钮):** `POST /api/schedule/trigger` → 调 `runBatch({trigger:'manual'})`。若当前有批次在跑:
- **拍板 A(默认建议 · 拒绝)**:直接返回 `409 {reason:'busy'}`,前端提示"当前有批次在跑,请稍后"。实现简单,`runBatch()` 内部逻辑不用改。
- **拍板 B(排队)**:忙时改为插入一行 `status='queued'`,`tick()` 和 `runBatch` 的 exit 回调里优先检查是否有 queued 行待跑。complexity 更高,一期不建议做,但 **schema 按 B 的需要预留 `queued` 状态值**(见 §4 补充),二期低成本升级,不需要再动库结构。

**暂停/恢复(老板临时不想跑):** `POST /api/schedule/pause` / `POST /api/schedule/resume`(body/path 带 `schedule_name`,一期固定 `'crawl'`)。`pause` 只是把 `schedule_state.paused` 置 1,`tick()` 直接短路;`next_run_at` **冻结不动**(不是继续推进),恢复时如果 `next_run_at` 已过期则下一个 tick 立刻补跑一轮,而不是把暂停期间"错过的 N 轮"全部补上。暂停期间没有新 run 产生,detector 也就不会有新的误报(detector 只在 run 结束时触发,不会因为"长期没数据"本身报警)。

### 5.2 并发

(不变,详见原文 —— 现有三池 RPM/并发常量读 `shared/config.ts`,每轮记 `rpm_actual`)

### 5.3 重试(三级)

| 级别 | 机制 | 状态 |
|---|---|---|
| 请求级 | crawlee `maxRequestRetries=2` + SessionPool 换 session | ✅ 现状已有 |
| 源级 | 入口每轮 RUN_SALT 必重抓 = 失败源下轮**天然重试**;连续失败升级为告警(不无限静默重试) | ✅ 机制现有 + 🆕 告警 |
| 批次级 | 整轮崩溃 → runs.status=failed + 🔴 告警;**调度器下一次 tick(next_run_at 到点)自然重跑**;SQLite 原子占位互斥(上轮未完 → skipped_overlap 告警) | 🆕 |

### 5.4 互斥、超时与崩溃恢复(替代 flock,补齐重启鲁棒性)

**互斥:** 不再用文件 `flock`(那是为"每次 systemd 都拉起一个全新独立进程"设计的跨进程锁,新架构下调度和执行常驻同一进程,继续用文件锁属于两套语义硬凑)。改成两层:
1. 进程内 `activeChild` 变量 —— 挡同一进程内的重复 spawn(tick 与手动按钮几乎同时触发的极端情况)
2. `runs` 表 SQLite 原子占位(`INSERT INTO runs (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM runs WHERE status IN ('running','queued'))`,检查受影响行数判断是否抢到)—— 挡跨重启/双实例场景,与"一个库一个访问层"架构原则一致,不新引入第二套锁机制

**超时:** run-batch 内 `setTimeout(batch_timeout_min)` → 先 `SIGTERM`,10s 宽限后 `SIGKILL` 兜底(防僵尸子进程),`status=timeout` + 🔴 告警。

**🆕 崩溃恢复(新架构必须补的能力):** 调度节奏(`next_run_at`)现在活在**持久化的 `schedule_state` 表**里,不是内存变量 —— 这是从"外部 systemd 记时"迁移到"进程自己记时"之后必须补的一环,否则 ops 进程一重启,调度就失忆(问题清单 P0-2)。

```ts
function recoverFromCrash() {
  // 1. 找僵尸 running 行:started_at 早于 (now - batch_timeout_min - 5min 缓冲) 仍是 running
  //    → 上次 ops 进程死亡时刚好有批次在跑,子进程大概率已经不在了(孤儿进程另计)
  const stale = ledger.findStaleRunningRuns();
  for (const run of stale) {
    ledger.markRunCrashed(run.run_id);  // status='crashed' + alert(type:'run_interrupted', 🔴)
  }
  // 2. schedule_state 首次部署无行 → 初始化(next_run_at = now,立即安排第一轮)
  const cfg = loadScheduleConfig();
  ledger.ensureScheduleState('crawl', { intervalMs: parseInterval(cfg.crawl_interval) });
}
```

**ops 进程自身的环境变量加载(踩坑提醒 · 问题清单 P1-9):** 旧架构下 systemd `crawl.service` 可在 unit 文件配 `EnvironmentFile=.env.local`,保证代理池配置每次都到位。新架构下 main.ts 由 ops 进程 `spawn` 拉起并继承 `process.env`,**ops 进程自己必须先把 `.env.local` 加载进 `process.env`**。建议 `ops/server/index.ts` 入口代码层显式:

```ts
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });   // 不依赖启动脚本里的 `source .env.local`,消除人为遗漏风险
```

这样无论 ops 进程被 nohup / pm2 / systemd 哪种方式拉起(见【需要老板拍板的点】第 1 条),代理池配置和 `DASH_USER/DASH_PASS` 都稳定到位,不受启动方式差异影响。
````

---

## §4 补充:schema 建议(对应老板点名的 5 项调度元数据)

```sql
-- runs 表新增列(ALTER,不是新建;shared/db.ts 迁移函数里新增这几行 ALTER TABLE IF NOT EXISTS 逻辑)
ALTER TABLE runs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'scheduler';
  -- 'scheduler'(定时触发) / 'manual'(dashboard 按钮) / 'startup_recovery'(崩溃恢复产生的占位行,理论上不会真的跑)
ALTER TABLE runs ADD COLUMN batch_type   TEXT NOT NULL DEFAULT 'crawl';
  -- 'crawl'(一期唯一)/ 'probe'(二期)/ 'browser'(未来 Playwright)
ALTER TABLE runs ADD COLUMN exit_code    INTEGER;   -- 子进程真实退出码(排障用,问题清单 P2-14)
ALTER TABLE runs ADD COLUMN exit_signal  TEXT;      -- 超时被杀时的信号:SIGTERM / SIGKILL

-- status 新增枚举取值(SQLite 无强制 CHECK,靠代码层约束,可选加 CHECK 约束):
--   既有:running / ok / failed / timeout / skipped_overlap
--   🆕 新增:queued(排队中,拍板 B 才会真正用到,一期先预留)
--          crashed(崩溃恢复判定专用,区别于 main.ts 自身正常判定的 failed)

-- 🆕 新表:schedule_state(调度自身状态 —— 老板点名的 5 项缺口的核心落点)
CREATE TABLE IF NOT EXISTS schedule_state (
  schedule_name   TEXT PRIMARY KEY,        -- 'crawl'(一期唯一)/ 'probe' / 'browser'(预留,不提前建行)
  interval_ms     INTEGER NOT NULL,
  next_run_at     TEXT NOT NULL,           -- 🔴 核心:重启后调度器靠这个恢复节奏(问题清单 P0-2)
  paused          INTEGER NOT NULL DEFAULT 0,
  paused_at       TEXT,
  last_tick_at    TEXT,                    -- 🆕 心跳:调度循环最后一次醒来的时间(问题清单 P2-15)
  last_triggered_run_id TEXT,
  updated_at      TEXT NOT NULL
);

-- alerts.type 新增取值:run_interrupted(崩溃恢复时僵尸 running 行触发,区别于既有 run_failed/run_timeout/run_overlap)
```

---

## 总览页 & 栏底调度状态 · UI 替换文段(§7.2)

原 §7.2 总览行只有"状态/完成时间/耗时/新增/失败/吞吐 · 下次倒计时",遗漏了"调度状态"本身(暂停/排队/触发方式/心跳)。替换为:

> **总览页脉搏行**:上次批次:状态(需能显式区分 ok / failed / timeout / **crashed**)/ 完成时间 / 耗时 / 新增 / 失败 / 吞吐 · 触发方式图标(⏱️ 定时 / 👆 手动)· 下次倒计时(**暂停时整块替换为"⏸ 调度已暂停",并放一个就近的"恢复"按钮**)· **"立即跑一轮"按钮**(见下方拍板点,按钮点击后二次确认 + 立即 disable 防连点)
>
> **24 批次健康带**:绿=ok,黄=timeout,红=failed/crashed,**灰=skipped_overlap/queued**(灰色表示"这格根本没真正跑",与红色"跑了但失败"区分开 —— 一排连续变灰是调度可能挂了或被遗忘暂停的直观信号)。hover 详情带上 `triggered_by`。
>
> **最近批次表**:新增列 **触发方式**;`batch_type` 列一期可以先不在表格里展示(只有 crawl 一种,展示了也没有区分度),但 `GET /api/runs` 返回体必须带这个字段,为二期 probe/browser 上线时"加一列"铺路,不需要到时候再改接口签名。
>
> **栏底常驻调度状态**(左侧导航栏底部,§7.2 原文提过名字但没设计内容,现补齐):调度开关(🟢 运行中 / ⏸ 已暂停,点击即暂停/恢复,这是暂停功能在 UI 上的家)+ 下次运行倒计时(与脉搏行联动同一份数据,不要写两套倒计时逻辑)+ 调度器心跳新鲜度(`last_tick_at` 距今 > 5 分钟时标 ⚠️,提示调度循环可能卡死)。因为这个组件五个页面都常驻可见,不能只挂在总览页的 `GET /api/summary` 下(问题清单 P1-13),需要独立轻量接口:

```
GET  /api/schedule/state        # { paused, next_run_at, last_tick_at, active_run_id | null }
POST /api/schedule/trigger      # 手动触发,见拍板点
POST /api/schedule/pause        # { schedule_name }
POST /api/schedule/resume       # { schedule_name }
```

---

## §8 验收标准替换文段(第 4 行)

原文:「4 | 调度 | timer 连续 24h 无人工干预,runs ≥24 条 ok;重叠保护实测(手动占锁 → skipped_overlap 告警)」

替换为:

| # | 交付物 | 验收标准 |
|---|---|---|
| 4 | 调度(内置) | ①内置调度器连续 24h 无人工干预且 ops 进程未重启,runs ≥24 条 ok;②**重启恢复实测**:人工 kill ops 进程(含跑批次中途 kill),重新拉起后 \`next_run_at\` 从持久化状态正确恢复(不重复触发、不错过超过 1 个周期),遗留 running 行被正确标记 crashed + 告警;③手动触发在无并发时实测成功,在已有 running 批次时按拍板策略(拒绝/排队)实测;④暂停开关:暂停后 30min 内 0 条新 run,恢复后按拍板策略(补跑 1 轮/等下个自然节点)实测;⑤重叠保护实测(SQLite 占位失败 → skipped_overlap 告警) |

---

## 其余 ripple 编辑点(非核心 5.1/5.4,但为保持全文一致必须同步改)

| 位置 | 现状 | 建议 |
|---|---|---|
| §3 架构图 L73 | 「调度器:systemd timer」 | 改「调度器:内置(scheduler.ts · setInterval + schedule_state 持久化)」 |
| §3 目录规划 L114-120 | `ops/systemd/` 目录含 crawl.service/timer | 改成:`ops/scheduler.ts`(新增)、`ops/run-batch.ts` 保留、`ops/deploy/`(替代 `ops/systemd/`,内容视【需要老板拍板的点】第 1 条 A/B/C 结果而定) |
| §7.1 L284 | 「systemd \`dashboard.service\` 常驻(Restart=always)」 | 改成引用拍板结果的占位句,例如:「ops server 进程守护方案见 §5.1 附录 A/B/C(老板拍板前先按 C·极简 systemd 仅进程守护实现,不阻塞功能开发)」 |

---

## 需要老板拍板的点

1. **运维台(ops server)进程自身谁拉起?**(废弃 systemd `crawl.timer` 触发采集之后,新问题:这个身兼"调度器+dashboard"双职责的常驻 Node 进程,自己崩溃了谁重启它)

   | 方案 | 做法 | 优点 | 缺点 |
   |---|---|---|---|
   | A · 极简 nohup+cron 自愈 | `nohup npx tsx ops/server/index.ts &` 启动;crontab 每 1-5 分钟跑 `pgrep` 检测,不在则重新拉起;另加 `@reboot` 规则应对服务器重启 | 零新依赖,最贴合项目"不引重依赖"哲学 | 检测延迟 1-5 分钟(期间 dashboard 不可访问 + 调度停摆);需要自己写自愈脚本;没有现成日志管理 |
   | B · pm2 | `pm2 start ops/server/index.ts --interpreter tsx --name ops-dashboard` + `pm2 save && pm2 startup` | 崩溃后近乎瞬时自动重启;`pm2 logs`/`pm2 monit` 现成运维体验;开机自启一条命令搞定 | 新增一个全局工具依赖(pm2 daemon 常驻吃内存,2c4G 服务器需评估);与"不引重依赖"原则有点张力 |
   | C · 保留一个仅做进程守护的极简 systemd service(不含 timer) | 保留计划书原有的 `dashboard.service`(`Restart=always`,`RestartSec=5`),只是明确它现在**只管保活,不管调度**(调度逻辑已完全在 ops server 内部) | 改动最小(计划书本来就设计了这个文件);systemd 原生瞬时重启 + 开机自启 + journalctl 日志,不引新依赖 | 需要向老板确认"废弃 systemctl"的边界 —— 若本意是"技术栈层面彻底不碰 systemd"(比如未来要容器化),则 C 不符合精神;若本意只是"不要让 systemd timer 承担业务调度语义",则 C 完全合规 |

   审计员倾向:**C**(改动最小、复用既有设计、不新增依赖;"废弃 systemctl"的老拍板原话是"不再用 systemd timer **触发采集**",指向的是调度语义要搬进代码里让运维台自己可见可控,不是连基础的进程保活也要禁用 systemd)。但最终由老板定。

2. **手动触发"立即跑一轮"时,若已有批次在跑,是拒绝还是排队?**
   - A(拒绝,建议默认):直接提示"当前有批次在跑,请稍后",实现简单
   - B(排队):记一条 `status='queued'`,当前批次跑完自动接续执行
   - 老板原话点名要审计"排队中状态"这个 schema 字段,暗示可能倾向 B;审计员建议:**一期先做 A,schema 按 B 预留 `queued` 状态值**,二期升级成本很低,不需要再动库结构。

3. **A2"唯一写操作 = 告警 ack"是否需要正式扩大为写操作白名单?**
   本次任务新增的"手动触发批次"“暂停/恢复调度”,加上背景提到的"代理池配置未来前端可设置",三者都是新的写操作,与 §0 拍板表 A 行"唯一写操作:告警 ack"直接冲突。建议不要让每个功能各自"悄悄"突破只读原则,而是一次性请老板拍板:把 A2 的写操作范围正式重新定义为白名单,例如:

   > **A2'**:常驻只读 dashboard,**写操作白名单** = {告警 ack、手动触发批次、暂停/恢复调度}。(代理池配置写操作留到"未来"实现时再单独申请加入白名单,本期不做)

   这样执行 Claude 有明确授权边界,不需要自己判断"这个算不算违反只读原则"。

4. **暂停调度要不要"自动过期"保护**(如暂停超 N 天自动提醒/自动恢复,防止老板忘记恢复导致长期断供不自知)?审计员建议一期不做自动恢复(避免"老板故意长期暂停却被强制恢复"的反效果),但 UI 显示"已暂停 N 天"提醒即可,成本很低。这条不强制拍板,仅供参考,除非老板有强烈意见。
