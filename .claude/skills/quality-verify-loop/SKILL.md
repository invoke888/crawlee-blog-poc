---
name: quality-verify-loop
description: 三源质量核对循环战役(标题/正文/发布时间 核对→修规则→重跑→复检→收敛→报告)。老板说"核对文章/三源核对/质量循环/跑一轮核对/派agent核对采集质量"等即触发。默认全量非RSS一次过(不抽样不限窗口)。2026-07-05 核对战役实战固化。
---

# 三源质量核对循环 SOP(2026-07-05 战役固化)

**目标**:库内文章三字段(标题/正文/发布时间)正确·无遗漏·可修补的都修掉;假博文清出;循环到"能修清单"为空=收敛。

## 🔴 默认口径=全量非 RSS 一次过(2026-07-05 老板拍 · 取代"今天窗口"抽样)

**老板原话:「就不能一次性全部跑过吗...除了rss 然后除了今天有抓到的 实际全部除了rss 都要去做」「能不能一次性过」「不要局限于今天跑的」。**

- **范围铁律**:默认核**全部 article-detail 管线**(当前 ~3700 条去重 URL / ~229 源),不是今天窗口、不是抽样、不是嫌疑驱动。RSS 型(rss/medium/substack/paragraph)feed 字段结构化不核(老板拍)。
- **为什么放弃抽样**:抽样/嫌疑法有三层盲区,永远漏(FIL zh 页实锤:不在当天+title恰好8字符躲过嫌疑规则+随机300没抽中 → 三层全躲)。老板要的是"一次过不留遗留"。
- **执行方式=Workflow 编排**(不是手动派 20 agent 一波):`Workflow` 工具 pipeline 全部切片(每片 ~30 条 · ~116 片),自动管并发(cap ~14)跑到底,一次覆盖全库。手动 20-agent 只适合 <400 条的小范围复检。老板明确要"一次性全部跑过"= workflow 的正当 opt-in。
- **agent 数**:核对片数 = ceil(去重URL / 30);修复批按问题 host 数切(每片 4-5 host);复检同核对但只覆盖改过的源。全 sonnet。
- 老板若明确说"只核今天/只核某源"才缩范围,否则一律全量。

## R1 全量核对轮

1. **导出核对集**(SSH hk-prod):`SELECT ... FROM articles a JOIN sources s WHERE a.crawler='article-detail' ORDER BY s.blog_url`(全量,不加时间窗)。本地 URL 去重(共享博客核对一次)。
2. **切片**:本地 python 按 ~30 条/片切,大源(>35条)自身按 25 条分段,写 `/tmp/full-slice-NNN.json`(3位编号唯一名),每片附该 host 的 extract-rules 现行规则(host 匹配:精确→逐级去子域段,strip www)。
3. **Workflow 全量核对**:pipeline 全部片号,每片一个 sonnet agent(schema 强制结构化输出 + 双写 /tmp/full-out-NNN.json)。agent 逐条 WebFetch 判定——①is_real_article(假博文=attribution/legal/tag/列表/功能/分类/账号页,参考 ravencoin/socios/mantle分类根页)②title ③body ④date 各判 ok/wrong/missing_recoverable/expected_empty ⑤每 blog 对照列表页查漏采。**prompt 必带纠偏背景**:strategy none/spa_only 空=预期;已定性站方清单(AUDIO/BANANA/JUP/VANA/ARC/ENA/IP*/EURI/KAT/SKR/ZORA,*IP=datafdn.org 已补 body 规则照常核 · 以 memory 无解清单最新版为准);Ondo系/VET-VTHO/多语言系列文标题复读合法;CMS 同秒批发=真;lm 兜底同秒聚集非信号;date-only 合法、±1天时区容差;发布时间晚于采集=bug 必报;拿不准 uncertain。
4. **机器汇总**:合并全部 /tmp/full-out-*.json,按 host 聚合问题,分类:假博文 / body 空白(规则缺)/ body 错值 / date 错值 / date 可回填 / title 错 / 漏采 / uncertain。

## 修复轮

5. **假博文归因我自己做**(不派 agent):逐条查根因——已知模式:白名单词末段=列表页 · landing 词缺 · 复合词(faq/white-paper/terms-conditions)· host 整站非博客(→host_blacklist,真博客渠道在 medium 的不受影响)· 跨子域主站营销页(landing 词补)· 混合内容中心(source-rules exclude)。**加通用规则前必跑存量误伤面 SQL**(末段匹配全库扫,像"白名单末段拦"当时零误伤才落地)。
6. **规则修复批**(10 × sonnet,每片 4-5 host):派前从服务器 raw-html 存档按 token_id 打包 scp 回本地(key=`{token_id}-{sha1(url)[:16]}`);agent 读原始 HTML(存档没有就 curl 带 Chrome UA)定 selector/regex,**必须用 `/tmp/verify-venv/bin/python3` + bs4 select() 实测**(venv 不在就 `python3 -m venv /tmp/verify-venv && pip install beautifulsoup4 -i 清华镜像`),没实测标 low 不合入。输出规则片段 + tested_samples + **delete_urls(非空错值行,COALESCE 回填不覆盖非空,必须删行重收)**。
7. **引擎/同语义自查**(每轮必过):①新过滤逻辑 TS 侧改了,**python aggregate-report.py 的 is_noise/white-first 必须同步**(07-04 曾漏 terms/utm 两条)②normalize/date-extract 引擎级 bug 单独修+单测 ③改四层过滤前想清 host 级 vs token 级口径(white-first token 级曾差点灭杀 OXT 275 条双渠道真文)。
8. **合入验证**:merge 规则进 extract-rules.json(只覆盖 agent 给的字段,附 `_note: 日期+战役`)→ `npx tsc --noEmit; echo $?`(真实退出码不接管道)→ `npm test` → **新逻辑必加回归单测**。

## 部署清理重跑

9. **三端检查** → commit push → 服务器 `git pull --rebase`(package-lock 脏了 checkout 丢弃)→ `sudo systemctl restart ops-dashboard`。服务器 npx 需 `export PATH=/home/ubuntu/.local/share/fnm/aliases/default/bin:$PATH`。
10. **暂停调度**(POST /api/schedule/pause,curl -u boss:$DASH_PASS)→ 确认无批次 running。
11. **清理**:`npx tsx ops/clean-articles.ts` dry-run 先看——**数量超预期必须停下查原因**(是新规则合法命中还是口径误杀),合理才 --confirm(自动备份);**clean 不查 host_blacklist,黑名单域行要手动 SQL 删**;delete_urls 错值行手动删(先备份 JSON)。
12. **reset 判断**:错值行删后必须 reset(否则补漏扫描把旧 dataset 错值收回来);⚠️ **reset 会清 raw-html 存档**——需要存档的先 tar 备份。🔴 **严禁 os.remove 单个 dataset JSON 文件**(crawlee 按 entryNumber 连续读 · 文件空洞=下批收尾 Dataset.getData 崩溃 · 2026-07-05 实锤):清 dataset 的唯一姿势是 reset。`npx tsx ops/reset.ts --confirm` → POST /api/schedule/trigger 全量 → 轮询 /api/runs 到完成(后台 bash 循环)→ 恢复调度(/api/schedule/resume)。

## 漏采根治(全量口径新增 · 不许只删不补)

8b. **漏采单独成方案**(老板铁律 [[feedback-no-lazy-source-level-fix]]):核对 agent 报的 missing[] 按源归因——LIST 静态无链/SPA 列表遮挡(切 sitemap 发现)/sitemap 缺口(改 include_regex + sitemapindex 递归)/分页深处/跨域。**定向重抓机制已建**:`REFETCH_URLS=<文件路径> npx tsx src/main.ts` 裸跑(加盐绕 dedupe · host 匹配 token · 写 dataset 下轮批次收编)。漏采 URL(sitemap 缺口/agent 实锤缺文)+ 空字段旧文 + 删行重收目标 一起进 refetch 清单一次跑掉。

## 部署清理重跑

9. **三端检查** → commit push → 服务器 `git pull --rebase`(package-lock 脏了 checkout 丢弃)→ `sudo systemctl restart ops-dashboard`。服务器 npx 需 `export PATH=/home/ubuntu/.local/share/fnm/aliases/default/bin:$PATH`。**🔴 tsconfig include 已含 ops/shared**(2026-07-05 补:此前只查 src/ · ops 改动漏 import 也 tsc 全绿 · rulesFor 未 import 致批次 failed 实锤)——ops/ 改完 tsc 有类型保护但仍要真跑一轮验收。
10. **暂停调度**(POST /api/schedule/pause,curl -u boss:$DASH_PASS)→ 确认无批次 running。
11. **清理**:`npx tsx ops/clean-articles.ts` dry-run 先看——**数量超预期必须停下查原因**(是新规则合法命中还是口径误杀),合理才 --confirm(自动备份);**clean 已含 blacklisted_host 桶**;delete_urls 错值行手动删(先备份 JSON)。
12. **reset 判断**:错值行删后必须 reset(否则补漏扫描把旧 dataset 错值收回来);⚠️ **reset 会清 raw-html 存档**——需要存档的先 `tar czf` 备份。🔴 **严禁 os.remove 单个 dataset JSON 文件**(crawlee 按 entryNumber 连续读 · 文件空洞=下批收尾 Dataset.getData 崩溃 · 2026-07-05 实锤):清 dataset 的唯一姿势是 reset。定向重抓走 REFETCH 裸跑(不 reset,产物下轮收编)。`npx tsx ops/reset.ts --confirm` → POST /api/schedule/trigger 全量 → 轮询 /api/runs 到完成(后台 bash 循环)→ 恢复调度(/api/schedule/resume)。

## R2 复检轮 → 收敛

13. **SQL 终检**(先机器后 agent):假博文回流=0?修过 host 的 body/date 覆盖率?错值特征(同戳/2001/未来/pub>crawl)清零?漏采源行数是否回升?
14. **复检**(全量口径:改过的源全覆盖 · 非改动源抽样背书):同 R1 判定口径,重点验 fixed 的源。**注意复检工具盲区会产生 false positive**:__NEXT_DATA__/time[datetime] 属性 WebFetch 的 markdown 视角看不到;Webflow "Last Published"/Framer data-framer-ssr-released-at 构建戳会被误读为发布时间——修复批必须以原始 HTML 复核为准。
15. **收敛判定**:R1 修复零回归 + 新问题只剩"新记账 host"→ 小规模清尾修复批;连续一轮"能修清单"为空 = 收敛;残余逐条定性归档(站方问题/spa_only 等 Playwright/工具盲区)不许滚雪球。
16. **报告**:结论先行表格(核对量/修复量/收敛态)+ 主动发现清单(问题/证据/建议/优先级,老板只拍板)+ 遗留定性账。新坑随手入 memory。

## 已固化的机制事实(别再踩)

- **全量优先于抽样**:抽样/嫌疑法永远有盲区(FIL 三层躲过实锤)· 老板要"一次过" · 默认 workflow 全量 pipeline
- 空值行:重跑后回填通道(known 行 COALESCE)自愈;LIST 不再露出的旧文靠 **REFETCH_URLS 定向重抓**回填(已建)
- 每轮 agent 结果必过纠偏环节;一个例子=一类模式,主动举一反三列清单;**假的/漏的都出源级方案不许只删**([[feedback-no-lazy-source-level-fix]])
- 假博文 URL 模式三板斧:白名单词末段拦(通用)/ landing+noise 词表补 / source-rules per-symbol include_regex/exclude(最专)
- 服务器时区陷阱:V8 按进程本地时区解析无年份日期(KAVA -1 天实锤)→ 引擎统一 Date.UTC 重建
- lm 兜底行级防线:候选值晚于该行首采时间+5min = 页面重生成/CDN 戳非发布时间(CSPR 实锤)
- 🔴 清 dataset 唯一姿势=reset(严禁删单文件)· ops/ 改动 tsconfig 已纳入类型检查但仍要真跑验收
