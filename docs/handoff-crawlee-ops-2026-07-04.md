# 续接 · Crawlee 采集器 + 运维台 · 一期上线交接(2026-07-04)

> **接收方:** 下一个 Claude 实例(新会话)
> **必读三件套:** 本文档 + `~/.claude/CLAUDE.md`(老板全局铁律)+ memory/MEMORY.md(项目记忆索引 · 每条链接文件都要读 · 特别是全部 🔴)
> **上一份 handoff:** `docs/handoff-crawlee-poc-p2-2026-07-03.md`(系统基础仍有效 · 但其 §9 裸跑 SOP 已降级为调试用途)
> **本文档为当前唯一有效交接。**

---

## TL;DR

**系统已从"单采集器"进化为「采集器(src/)+ 运维台(ops/)+ 共享数据层(shared/)」两组件一项目。运维台一期 2026-07-04 上线:内置调度(每小时自动跑批 · systemd timer 已废)+ 账本(11 张表)+ 13 条环比告警 + push 模块(待接通)+ 六页深色 dashboard(https://blog-picker.hhwlnet.com · 正式域名+LE 证书 2026-07-04 切换)。数据基线:634 源 · 有数据 501 · articles 6109 篇。57 组单测全绿。验收余项:24h 连续调度观察(2026-07-04 15:27 起算)。**

本会话三大战役:①自测战役(每源1条+10 agent 审查 → 54 P0 修复 → 5 轮验证,噪音归零,RSS 化 84 源)②判死复核战役(14 agent · 59 dead+24 SPA 全复核 → 救回 11 源,490→501)③运维台(brainstorm → 3 套 mockup → 5 agent 审计计划书 → 全量实施上线)。

---

## §1 当前状态

| 项 | 值 |
|---|---|
| 本地 | `/Users/lindashuai/Desktop/project/crawlee/` |
| GitHub | `git@github.com:invoke888/crawlee-blog-poc.git`(本地 SSH remote · **服务器 remote 是 https 不能 push,只 pull**)|
| 服务器 | hk-prod `119.28.68.105` · ubuntu · `~/crawlee-blog-poc/` · SSH 走 SOCKS5 `127.0.0.1:10808` |
| HEAD | `0229ce3`(handoff 补记)· 三端一致 |
| **运维台** | `https://blog-picker.hhwlnet.com`(2026-07-04 切正式域名:nginx 443 反代 8787 · Let's Encrypt 证书 · certbot.timer 自动续期 · 80 自动跳 https · 旧 8788 入口已下线)· **UI 登录门厅**(老板拍方案 C:cookie 30 天免登 · curl/脚本仍可 Basic 头 · 凭据在服务器 `.env.local` DASH_USER/DASH_PASS)· auth 全在 node 层(ops/server/auth.ts · 4 组单测)· nginx 纯反代不加 auth(老板拍)|
| 进程 | `sudo systemctl status ops-dashboard`(**仅保活** · Restart=always · 调度 100% 在进程内)· 日志 `journalctl -u ops-dashboard` |
| 调度 | 内置 · 每 60min 自动跑批(interval 在面板设置页可改 · 下 tick 生效)· 首批 2026-07-04 15:27 起 |
| 数据 | 634 源 · 采集池 ~508(黑名单4/挂起61/判死42/token排除5)· 有数据 501 · articles 6109 · 单轮全量 ~4.6min |
| 单测 | `npm test` **57 组**(article-filter/date-extract/source-rules/self-test-fixes/display-fields/ops)|
| 静态报告 | `docs/poc-report.html`(§5 不采集账本 · 动态渲染)· 与 dashboard 并存(报告=正式汇报物 · dashboard=实时运营)|

## §2 架构全景(两组件一项目 · 改哪里一处生效)

```
src/(采集器 · 契约:零参数裸跑=原行为 · 永不做 push/调度/告警)
 ├─ main.ts        五路并行:medium/substack/paragraph RSS + 通用RSS直拉60源 + article-detail
 │                 入参全可选 env:RUN_ID(写账本)/ ONLY_SYMBOLS=SEI(单源)
 ├─ handlers/      medium.ts(RSS+substack+rss直拉)· article.ts(LIST白名单优先排序+DETAIL)
 └─ utils/         filter-config.json(规则单一真源:白名单/noise/landing/platform_overrides/
                   rss_feed_overrides 63host/excluded_token_ids/dead/dc_banned)· source-rules.json ·
                   display-fields.ts(title/desc 复读切换)· config.ts URL_OVERRIDES
shared/(唯一数据层 · 两组件只经这里碰 sqlite)
 ├─ db.ts          连接+全部 schema(registry sources 表 + 11 张运维表)· OPS_DB_PATH 可注入(单测)
 ├─ ledger.ts      flushRun(RUN_ID 网关单入口+失败隔离)· claimRunSlot(原子占位)· upsertArticles(逐列铁律)
 ├─ config.ts      配置中心:env 显式 > app_config(DB·面板写)> 代码默认 · CONFIG_DEFAULTS 全清单
 ├─ proxy-config.ts getProxyUrl(DB优先env兜底)· 3 消费点:main.ts/run-mirror.ts/handlers/medium.ts
 └─ error-classify.ts 14 kind 枚举(含 cf_challenge/soft_404 软200错误页)
ops/(运维台 · 常驻进程)
 ├─ scheduler.ts   内置调度(30s tick · schedule_state 持久化 · 崩溃恢复标 crashed)
 ├─ run-batch.ts   批次:占位→spawn采集器→超时TERM/KILL→收割articles+补漏扫描→detector→pusher
 ├─ detector.ts    13 条环比告警规则(source_gone连续2轮/list_shrink/feed_dead/rate_limited…)
 ├─ pusher.ts      push(开关默认关 · 合并token list · 存量skipped_backlog · 面板重推)
 ├─ reset.ts       固化 reset(三目录 · 绝不碰 sources.db)· `--confirm` 才执行
 └─ server/        API+六页(总览/告警/源管理/博文/错误日志/设置)
storage/sources.db(唯一库:sources+runs+source_runs+articles+crawl_errors+alerts+
                    schedule_state+push_runs+app_config+proxy_config+config_audit)
storage/logs/<run_id>.log(批次日志 · 30天)
```

**数据流:** 调度 tick → runBatch spawn 采集器(RUN_ID)→ 采集器写 dataset + 轮末 flushRun 统计 → run-batch 收割 dataset 新增进 articles(+补漏扫描兜住裸跑/崩溃缺口)→ detector 环比出告警 → pusher(接通后)。

## §3 老板拍板记录(本会话新增 · 不许翻案)

1. **两组件一项目一份数据** · 采集器保持简单可裸跑调试 · push 归运维台(失败可手动重推)· 单源采集由运维台调用
2. **配置单一真相**:运行参数(并发5点/深度/调度/告警阈值/push)进 app_config;代理三池进 proxy_config;面板写、采集器每批次读同表、下批次生效。**规则文件仍走 git+Claude,面板永不编辑规则**
3. **写操作白名单**:ack · 手动触发 · 暂停/恢复 · 代理池配置(软阻断:测试失败可二次确认强存) · push 重推
4. **无"全量/增量"双模式**:唯一模式=seen-store 常规批次;reset=运维动作(`ops/reset.ts --confirm`)
5. **废弃 systemd timer**(调度职责);进程守护拍 C=极简 systemd service 仅保活
6. UI 拍**方案 B 深色控制台**(基准 `docs/mockup-ops-b.html`)· 一期六页
7. 🔴 push 铁律(memory 有档):同 url 多 token 合并一条推送(token_ids list)· **首次接通存量不推**(skipped_backlog 机制已实现)
8. 自测战役期间拍:a=RSS化60源 · b=Ondo 系共享博客合法保留 · c=EDGE/RE 重复登记去重 · d=OPENAI/PTB/AHT_3 挂起(USAT 复核后不挂)· e=display 切换已上线
9. 全局铁律 13a 已立(CLAUDE.md):**开发新前端必调设计 skill + 2-3 套方案老板选**
10. 🆕 2026-07-04 晚批拍板:UI 登录门厅(方案 C · 弹窗绝迹);dashboard 时间显示**一律北京 UTC+8 到秒**;博文列序=博客(跳博客站)/标题/正文/发布/采集;源详情=可拖拽浮窗(修告警查看源跳转);页面铺满去 max-width;**存量 6185 篇已全标 skipped_backlog**(此后新采=none=未推 · 行内推送按钮 · push 未接通时按钮走 dry 演练不回写)

## §4 本会话大战役成果(证据全在 docs/research/)

| 战役 | 成果 | 资产 |
|---|---|---|
| 自测(每源1条+10 agent)| 54 P0 全歼:noise 三层规则(优先级高于白名单)· custom-domain 平台源 24host 划 RSS · 通用 RSS 直拉 60host(Impit 直拉 · **不走 crawler**:rss+xml 不被 cheerio 化+ghost 403 两坑)· LIST 白名单优先排序 · pub 覆盖 73.5%→85% | `self-test-audit-2026-07-03/` |
| 判死复核(14 agent)| 59 dead:救回7(MEGA/LA/ARPA/GLM/OSMO/PUNDIX/DCR)+ 转挂起9 + 维持43;24 SPA:救回7;**有数据源 490→501**;误判 15 模式入记忆 | `dead-review-2026-07-04/` |
| 运维台(5 agent 审计+实施)| 计划书 v3(57 审计发现合入)→ 一期全部上线 | `plan-audit-2026-07-04/` + `docs/plan-ops-dashboard-2026-07-04.md` |

## §5 坑与教训(本会话新增 · 防再踩)

| 坑 | 解 |
|---|---|
| **crawler 跑 feed 两坑**:application/rss+xml 不被 cheerio 化($ is not a function)+ 部分 ghost 站对 crawler 形态 403 | feed 一律 Impit 直拉(fetchAndPushRssFeeds · detect-feed 87/87 实证)|
| cheerio `.text()` 块级粘连破坏词边界(TitleMay 25)| 剥标签取文本(extractVisibleDate 已修)|
| Date.parse 裸日期按服务器时区(UTC+8 回退一天)| 显式 UTC 解析 |
| visible date 误锚事件日期(RESOLV/USAT)| byline 优先 + 前600字唯一日期 + 多日期歧义放弃 |
| 判死误判 15 模式(UA-only 探测/空note/假feed/SPA同壳…)| memory `project-source-verdict-pitfalls` 必读 · 拿不准放 suspended 不放 dead |
| registry/db.ts 是有状态模块不能简单 re-export | 已三步改造(schema 合并 shared/db + 函数迁移 + barrel)|
| reset"清 storage"字面执行会删账本 | `ops/reset.ts` 固化三目录 · sources.db 永不清 |
| 服务器 remote https 不能 push | 服务器只 pull;本地 SSH remote push |
| `nohup A & sleep && tail B` 的 & 作用域坑(cd 只在后台段生效)| tail 用绝对路径 |
| 账本/埋点必须失败隔离 | flushRun try/catch 不上抛 · persistSeen 排账本前 |
| playwright MCP 沙箱无 require/Buffer/btoa | page.evaluate 里算 base64 |

## §6 下一步(老板启动才做)

| 项 | 内容 | 前置 |
|---|---|---|
| **24h 验收复查** | 2026-07-05 15:27 后查 runs ≥24 条 ok(dashboard 总览或 `/api/runs`)· 顺带看首批告警是否合理(告警太吵就调阈值) | 时间到 |
| **push 接通** | 老板给 PUSH_API_URL/SECRET → 面板设置页填入 + push_enabled=1 → 自动存量回填+开推 · **注意 push 铁律 memory** | 老板给 secret |
| **P3 Playwright** | cf-JS 型挂起源(mirror7/PENGU/jito/QNT 等 61 挂起中的 cf 型)+ ASTR/ZENT/LAZIO(JS 链接层)· 独立进程/批次类型 browser(架构已预留 batch_type)· 完了给速度数据 | 老板启动 |
| 住宅轮换池 | WAF-IP 型恢复(TIA/LTC/MINA/SONIC/COW)· proxy_config 可直接面板加 | 老板给池 |
| 二期 | probe 巡检批次 · FTS 全文检索 · seen-store 裁剪(>5MB 告警盯着)· C3 告警推送通道 · queued 排队(~~正式 HTTPS 证书~~ ✅ 2026-07-04 已完成) | 一期数据跑稳后 |
| 小尾巴 | UMA sitemap 流黑洞单诊 · OSMO=Discourse 单例平台(LIST 抓到 /t/ 真帖已可用)· mockup A/C 文件可删可留 | 顺手 |

## §7 运维速查(日常操作全在 dashboard · SOP 详见 ops/README.md)

```bash
# SSH(全部远程操作)
ssh -o "ProxyCommand=nc -X 5 -x 127.0.0.1:10808 %h %p" -i /Users/lindashuai/Desktop/key/qj/ssh_pri ubuntu@119.28.68.105
# 部署更新:本地改→push → 服务器:
cd ~/crawlee-blog-poc && git pull --no-rebase && sudo systemctl restart ops-dashboard
# 调试裸跑采集器(不写账本 · 产物下轮自动补漏收编):
export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env --shell bash)" && set -a; source .env.local; set +a
ONLY_SYMBOLS=SEI npx tsx src/main.ts
# reset(大规则变更后):npx tsx ops/reset.ts --confirm
# 老板要静态报告:python3 scripts/aggregate-report.py → scp → python3 scripts/embed-report.py(报告链不变)
```

## §8 老板工作方式(继承 + 本会话强化)

1. **主动发现列清单**(问题/证据/建议/优先级)· 老板只审查;一个例子=一类模式,举一反三
2. 研究型 6-10+ sonnet agent 并行(切片15-25)· 诊断一律 `scripts/probe-fetch.ts` 生产指纹 · **严禁裸 curl** · agent 禁 playwright MCP · **并行 agent 临时文件要唯一名**
3. 方案类:先沟通方案+拍板点表格 → 计划书 → 5 agent 审计 → 终审合入 → 实施;**新前端必 2-3 套 mockup 供选**(铁律 13a)
4. 完工必自验(playwright 截图/curl 真路径)才报老板 · 注意事项随手入记忆
5. 中文 · 表格+emoji · 看逻辑不看代码 · blogpicker 状态不可信 · 改完必 commit+push · 报告前必过防陈旧

---
*本文档由 Claude Fable 5 于 2026-07-04 生成 · 运维台一期上线收官 · 下一棒从 §6 接。*
