# 续接 · Crawlee 采集器 + 运维台 · 全量质量收官 + push 接通 + 存储根源改造(2026-07-13)

> **接收方:** 下一个 Claude 实例(新会话)
> **必读三件套:** 本文档 + `~/.claude/CLAUDE.md`(老板全局铁律 · 🆕 本会话新增 3a"修复不引入新问题")+ memory/MEMORY.md(每条链接文件都要读 · 特别是全部 🔴)
> **上一份 handoff:** `docs/handoff-crawlee-ops-2026-07-05.md`(架构背景仍有效 · 其 §5 待办/调度参数/push 状态已被本文档取代)
> **本文档为当前唯一有效交接。**

---

## TL;DR

**本会话(07-05 深夜 → 07-13)七大板块:①三源核对循环战役 R1→R3(43 agent · 规则库 139→156 · SOP 固化为项目 skill)②全库假博文清查+全量一次过战役(150+ agent · workflow 编排 3660 条逐条核对 · 规则库→168 · 假 65 清 · 漏采 738 补 · 老板拍"以后默认全量不抽样")③Last-Modified 兜底(采集+回填双路径常态化 · 三防线+行级防线)④push 对接完成并开启(officialblog API · HMAC · 5 篇真推验证)⑤调度 15min/轮+严格起跑 ⑥OOM 死锁事故(零采集 2 天)根治:tick 孤儿自愈+MemoryMax 1536M ⑦存储运输带架构(老板拍"根源解决"):账本去重+queue 每轮弃+dataset 收编即清 · 批次耗时钉死。终态:库 ~8200 条 · 168 host 规则 · 90 单测 · 三端 `5777064`。**

## §1 当前状态

| 项 | 值 |
|---|---|
| HEAD | `5777064` · 三端一致 |
| 调度 | **15min/轮 · 超时 15min · 严格触发时刻起跑**(advance 在 claim 后 · isRunActive 防重叠)· tick 30s 内嵌 stale 孤儿自愈 |
| **push** | **已接通已开启**(push_enabled=1)· `POST http://124.222.33.143:9900/api/officialblog/messages/ingest` · HMAC-SHA256(X-API-Key/Timestamp/Nonce/Signature)· camelCase items ≤200/批 · **username=host(老板拍)** · publishedAt/content 空也发(老板确认后端非必须)· 凭据在服务器 app_config(push_api_url/key/secret · 不进 git)· 存量 7473+ 全 skipped_backlog · 5 篇真推全 accepted 已验证 · **⚠️ 新文自动推送路径(批内 runPusher)尚未亲眼验证过一次真实自动推,下任先查** |
| 数据 | 库 ~8200 条(7478+重跑新增)· 规则库 **extract-rules.json 168 host** · 90 单测全绿 |
| **存储架构** | 🆕 运输带模式(2026-07-13):DETAIL 去重=账本(`src/utils/known-urls.ts`)· 4 queue 每轮 freshQueue(drop 重建)· dataset harvest 成功即 rmSync 整目录 · raw-html 14 天 retention · **批次耗时钉死 4-7min 不再逐日爬坡**(实证:旧架构 5 天 4.3→18.2min 爬到 OOM) |
| service | MemoryMax **1536M**(原 400M=OOM 真因)· Restart=always · RestartSec=5 |
| 挂起新增 | blog.codatta.io→dead(无法访问)· multiversx.com→dc_banned(403)· 两域曾日刷 366 次 403 |

## §2 本会话老板拍板记录(不许翻案)

1. **全局铁律 3a**(已写入 ~/.claude/CLAUDE.md):修复问题不引入新问题——改前量误伤面/精确优先于通用/改完必回归/举一反三不扩大化(safepal 实锤:-academy 复合词若用宽词表会误杀 Vana Academy/Orbs Perpetual Hub 真文 → 只能 per-source 精确 exclude)
2. **质量核对默认口径=全量非 RSS 一次过**(「不要局限于今天跑的」「一次性全部跑过」):核全部 article-detail ~3700 条 · workflow 编排(不抽样不嫌疑驱动 · 抽样三层盲区 FIL 实锤)· skill quality-verify-loop 已按此升级
3. **Last-Modified 兜底**:所有无发布时间的用协议头做最后兜底(知情接受"站点重发布日"精度)· 防线四道:解析失败/距抓取<10min(动态now)/未来>48h/**晚于该行首采+5min(CSPR 页面重生成戳实锤 · 老板抓)**
4. **push 字段映射**:username=host · blogId=url(超256 sha1)· content=body_excerpt 优先 · 文档"必须"字段 publishedAt/content 实际非必须(老板确认 · 实测空值 accept)
5. **调度**:15min/轮 · 超时 15min · **严格每 interval 起跑**(b)
6. **socios 4 源(ATM/PSG/MENGO/POR)永久拉黑**(拍 A · 非真博客 · 球队官网方案已否)· RVN/NAORIS 主站 host_blacklist(真博客=medium 已在采)
7. **存储问题从根源解决**(运输带架构 · 非定期打扫)
8. 博文页 UI:全表一行不换行 · badge 在标题前 · 标题 30 字+tip · 正文窄 · push 列宽 · **存量不推也显示手动推送按钮**
9. UI 时间一律北京(run_id 内嵌 UTC 戳也不许直接展示)· 错误日志分页

## §3 战役成果速览(证据在 memory + git log)

### 三源核对循环 R1→R3(07-05)
- R1:20 agent 核 385 条(84 博客×5)→ 修复 10 agent 44 host 全实测 → reset 重跑 → R2 复检 96 条零回归 → R3 12 host 清尾
- 白名单词末段=列表页通用拦(socios/chain.link/hive 三类一次修 · 存量零误伤)· **white-first 改 host 级口径**(token 级差点灭杀 OXT blog.orchid.com 275 条双渠道真文)
- KAVA 无年份 V8 落 2001+时区漂移(UTC 重建)· ICNT dmy transform · 葡西月份 · STORJ/FOGO/ARKM ban jsonld 构建戳
- **SOP 固化**:`.claude/skills/quality-verify-loop/SKILL.md`(进 git)· 触发词"核对文章/三源核对/质量循环"

### 全库假博文清查(07-05 夜)
- L0/L1 机器六维扫 → L2 源诊断(嫌疑核验+漏采+源级方案)→ L3 随机 300 盲测 **0 假**
- 50 假清+源级根治:HIVE 三段式 regex(源缺 source-rules 全放行)/ORBS landing 11 词(产品页互链)/MNT include_regex 两段/MEGA 前缀/WLD 专属 exclude
- MNT 漏采 76 篇 sitemap 缺口 · IRYS 8 篇(SITEMAP_URLS_PER_SOURCE 截断)· ADA 3 篇 → REFETCH 全补

### 全量一次过(07-05 深夜 · workflow)
- **116 片 3660 条逐条 WebFetch 核对**(~15M token)· 假 15/字段错 503/漏采 393
- 修复 workflow 41 host 补 body 规则(divs 型/论坛型/Framer)· REFETCH 845 条一次跑掉
- 收割层补 checkSourceRuleMulti(source-rule exclude 曾只在采集侧生效 · filecoin cloudpaws 删了又回实锤)
- 尾部定性:body 空 62 + pub 空 78 全是 spa_only 结构性(vanarchain/scroll/arc/zora/TWT 空壳)等 P3 Playwright

### OOM 死锁事故(07-11~13 · 零采集 2 天)
- 链条:dataset 5 天积累→回填 8175 条内存暴涨→**MemoryMax=400M OOM 杀 service**→新批次占位 27 秒成孤儿→重启时孤儿仅 30s 不满 stale 阈值没清→**孤儿检查只在启动跑一次**→next_run 卡过去每 30s skip→6200+ 条 skipped_overlap
- 修:tick 每 30s 清 stale 孤儿(自愈+红色告警)· MemoryMax 1536M · skip 垃圾已清

### 存储运输带架构(07-13 · 老板拍根源)
- 实证:批次 4.3→18.2min 逐日 +1min(queue 686M/dataset 8418 文件/kv 812M 每轮全量翻)
- known-urls.ts 账本去重(双插入点:main 分流循环+listHandler · REFETCH userData.refetch 豁免)· freshQueue drop · dataset 收编即清 · raw-html 14 天
- 首轮实测:6.2min 全量 · 账本 skip 1011 · queue 5.9M · 批后 dataset=0
- **附带根治**:删行重收不再需要 reset · dataset 残留回流类 bug 根绝 · 上午临时加的"回填 6h 降频"已回滚(冲突且不需要)

## §4 坑与教训(本会话新增 · 全在 memory 有档)

| 坑 | 解 |
|---|---|
| run_id 内嵌 UTC 戳被当时间看(老板抓) | UI 显示北京 started_at · run_id 挂 title;sqlite CURRENT_TIMESTAMP 无 Z → bj() 前端防御补 Z |
| 🔴 dataset 严禁删单文件(crawlee entryNumber 连续读 · 删 45 文件致批次崩实锤) | 清 dataset 唯一姿势=整目录(运输带已自动化) |
| tsconfig 只查 src/ · ops 裸奔(rulesFor 漏 import 却 tsc 绿) | include 已扩 ops/shared;ops 改完仍要真跑验收 |
| WebFetch markdown 视角盲区(__NEXT_DATA__/time[datetime] 看不到 · Webflow Last-Published/Framer data-framer-ssr-released-at 构建戳误读) | 核对 false positive 源头 · 修复批必须原始 HTML 复核 |
| 服务器 fnm PATH(非交互 shell 无 npx) | `export PATH=/home/ubuntu/.local/share/fnm/aliases/default/bin:$PATH` |
| 服务器 package-lock 被 npm 重写挡 pull | `git checkout -- package-lock.json` 再 pull |
| 复合词穿透精确段词表(safepal-academy ≠ academy) | 与真文同形只能 per-source exclude(铁律 3a) |
| lm 兜底 CDN/重生成戳 | 行级防线:候选>首采+5min 弃(33 行污染已回滚) |
| 监控脚本 UTC/北京阈值写错自坑 | 服务器一律 UTC 思维 · 展示才转北京 |
| push append-only 无去重 | 靠 push_status 严格只推一次;批推成功→回写前进程死=极小概率重复(记录在案未修) |

## §5 下一步(老板启动才做 · 优先级)

| 项 | 内容 | 前置 |
|---|---|---|
| **⚠️ push 自动推验证** | 新文自动推送(批内 runPusher)还没亲眼验过一次:`SELECT * FROM articles WHERE push_status='pushed' AND url NOT IN (那5篇测试)` 有行=通;顺带看 push_runs 表 | **下任第一件事** |
| P3 Playwright | spa_only 尾部(vanarchain/scroll/arc/zora/TWT ~140 条空字段)+ cf 挂起源(mirror/PENGU/QNT/multiversx)唯一出路 · batch_type=browser 预留 | 老板启动 |
| 大站观察 | BAT/BTC/ETH/JOE/KMNO/DCR 增量自愈观察(07-05 起) | 看数据 |
| 住宅池 | WAF-IP 型恢复(TIA/LTC/MINA/SONIC/COW) | 老板给池 |
| 二期 | FTS 全文检索 · desc 复读长尾 · probe 巡检 · C3 告警推送(调度停摆外部可见) · seen-store 裁剪 | 数据跑稳 |
| 全源正式报告 | 老板说"出报告"按 poc-report 铁律走 aggregate-report.py | 老板叫 |

## §6 运维速查(增量 · 其余同 07-05 版)

```bash
# 服务器 npx(非交互 shell)
export PATH=/home/ubuntu/.local/share/fnm/aliases/default/bin:$PATH
# 定向重抓(漏采/删行重收/回填 · 加盐绕账本dedupe需 refetch 标记 · 裸跑产物下轮批次收编)
REFETCH_URLS=/tmp/urls.txt CRAWLEE_MEMORY_MBYTES=2048 npx tsx src/main.ts
# push 连通测试(真推 N 篇)
npx tsx ops/push-test.ts [url...]
# 全量核对(默认口径)= invoke Skill(quality-verify-loop) → workflow 116 片模式
# 凭据类全在服务器 app_config(push_api_*)与 .env.local(DASH_/PROXY_)· 均不进 git
```

## §7 老板工作方式(本会话强化)

1. **铁律 3a**:改前量误伤面 · 精确优先 · 必回归 · 举一反三不扩大化
2. **全量优先于抽样**(核对类任务默认全库一次过 · workflow 编排)
3. **假的/漏的必须出源级根治方案**,"删行+加词"=偷懒(feedback-no-lazy-source-level-fix)
4. 老板抽查抓一条=必挖到架构级真因(FIL→抽样盲区 · CSPR→行级防线 · skipped_overlap→孤儿自愈+存储架构)
5. 中文 · 表格+emoji · 结论先行 · 拍板项字母编号 · 改完必真验(playwright UI 登录/SQL/日志)才报

---
*本文档由 Claude Fable 5 于 2026-07-13 生成 · 下一棒从 §5 第一行(push 自动推验证)接。*
