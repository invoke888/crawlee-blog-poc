---
name: quality-verify-loop
description: 三源质量核对循环战役(标题/正文/发布时间 核对→修规则→重跑→复检→收敛→报告)。老板说"核对文章/三源核对/质量循环/跑一轮核对/派agent核对采集质量"等即触发。参数可带:时间窗(默认今天北京时间)、每博客条数(默认最后5条)、是否含 feed 型(默认排除)。2026-07-05 核对战役实战固化。
---

# 三源质量核对循环 SOP(2026-07-05 战役固化)

**目标**:库内文章三字段(标题/正文/发布时间)正确·无遗漏·可修补的都修掉;假博文清出;循环到"能修清单"为空=收敛。

**默认参数**(老板可改):范围=今天(北京时间,即 crawled_at >= 前一日T16:00Z)· 每博客最后 5 条 · 只核 article-detail 管线(medium/rss/substack/paragraph feed 型字段结构化不核,老板 2026-07-05 拍)· 核对 20 agent / 修复 10 agent / 复检 10 agent · 全部 sonnet · 切片 15-25 条。

## R1 核对轮

1. **导出核对集**(SSH hk-prod,见 handoff 运维速查):按 blog_url 分组(共享博客 url 去重),窗口函数取每博客最新 N 条,JOIN sources 带 blog_url/fetch_strategy。
2. **切片**:本地 python 按博客均分 20 片写 `/tmp/verify-<日期>-slice-NN.json`(唯一名),每片附该 host 的 extract-rules 现行规则(host 匹配:精确→逐级去子域段,strip www)。
3. **派核对 agent**(20 × sonnet):每条 WebFetch 原 URL 判定——①is_real_article(假博文=attribution/legal/tag/列表/功能页,参考 ravencoin 例)②title ③body ④date 各判 ok/wrong/missing_recoverable/missing_confirmed/expected_empty ⑤fix_suggestion。**prompt 必带纠偏背景**:strategy none/spa_only 空=预期;已定性站方问题清单(AUDIO/BANANA/JUP/VANA/ARC/ENA/IP/EURI/KAT/SKR/ZORA,以 memory 无解清单最新版为准);Ondo 系共享博客合法;同秒批量发布可能是真的;date-only 合法、时区 ±1 天=ok;拿不准标 uncertain 不硬判。输出 JSON 到 /tmp 唯一名。
4. **机器汇总**:合并全部输出,按 verdict 统计、按 host 聚合问题,分类:假博文 / body 空白(规则缺)/ body 错值 / date 错值 / date 可回填 / title 错 / uncertain。

## 修复轮

5. **假博文归因我自己做**(不派 agent):逐条查根因——已知模式:白名单词末段=列表页 · landing 词缺 · 复合词(faq/white-paper/terms-conditions)· host 整站非博客(→host_blacklist,真博客渠道在 medium 的不受影响)· 跨子域主站营销页(landing 词补)· 混合内容中心(source-rules exclude)。**加通用规则前必跑存量误伤面 SQL**(末段匹配全库扫,像"白名单末段拦"当时零误伤才落地)。
6. **规则修复批**(10 × sonnet,每片 4-5 host):派前从服务器 raw-html 存档按 token_id 打包 scp 回本地(key=`{token_id}-{sha1(url)[:16]}`);agent 读原始 HTML(存档没有就 curl 带 Chrome UA)定 selector/regex,**必须用 `/tmp/verify-venv/bin/python3` + bs4 select() 实测**(venv 不在就 `python3 -m venv /tmp/verify-venv && pip install beautifulsoup4 -i 清华镜像`),没实测标 low 不合入。输出规则片段 + tested_samples + **delete_urls(非空错值行,COALESCE 回填不覆盖非空,必须删行重收)**。
7. **引擎/同语义自查**(每轮必过):①新过滤逻辑 TS 侧改了,**python aggregate-report.py 的 is_noise/white-first 必须同步**(07-04 曾漏 terms/utm 两条)②normalize/date-extract 引擎级 bug 单独修+单测 ③改四层过滤前想清 host 级 vs token 级口径(white-first token 级曾差点灭杀 OXT 275 条双渠道真文)。
8. **合入验证**:merge 规则进 extract-rules.json(只覆盖 agent 给的字段,附 `_note: 日期+战役`)→ `npx tsc --noEmit; echo $?`(真实退出码不接管道)→ `npm test` → **新逻辑必加回归单测**。

## 部署清理重跑

9. **三端检查** → commit push → 服务器 `git pull --rebase`(package-lock 脏了 checkout 丢弃)→ `sudo systemctl restart ops-dashboard`。服务器 npx 需 `export PATH=/home/ubuntu/.local/share/fnm/aliases/default/bin:$PATH`。
10. **暂停调度**(POST /api/schedule/pause,curl -u boss:$DASH_PASS)→ 确认无批次 running。
11. **清理**:`npx tsx ops/clean-articles.ts` dry-run 先看——**数量超预期必须停下查原因**(是新规则合法命中还是口径误杀),合理才 --confirm(自动备份);**clean 不查 host_blacklist,黑名单域行要手动 SQL 删**;delete_urls 错值行手动删(先备份 JSON)。
12. **reset 判断**:错值行删后必须 reset(否则补漏扫描把旧 dataset 错值收回来);⚠️ **reset 会清 raw-html 存档**——需要存档的先拉。`npx tsx ops/reset.ts --confirm` → POST /api/schedule/trigger 全量 → 轮询 /api/runs 到完成(后台 bash 循环)→ 恢复调度(/api/schedule/resume)。

## R2 复检轮 → 收敛

13. **SQL 终检**(先机器后 agent):假博文回流=0?修过 host 的 body/date 覆盖率?错值特征(同戳/2001/未来)清零?
14. **轻量复检**(10 agent):重跑后新增行每博客 2 条,同 R1 判定口径,重点验 was_fixed 的 host。**注意复检工具盲区会产生 false positive**:__NEXT_DATA__/time[datetime] 属性 WebFetch 的 markdown 视角看不到;Webflow "Last Published"/Framer data-framer-ssr-released-at 构建戳会被误读为发布时间——修复批必须以原始 HTML 复核为准。
15. **收敛判定**:R1 修复零回归 + 新问题只剩"新记账 host"→ 小规模 R3 修复批清尾;连续一轮"能修清单"为空 = 收敛;残余逐条定性归档(站方问题/spa_only 等 Playwright/工具盲区)不许滚雪球。
16. **报告**:结论先行表格(核对量/修复量/收敛态)+ 主动发现清单(问题/证据/建议/优先级,老板只拍板)+ 遗留定性账。新坑随手入 memory。

## 已固化的机制事实(别再踩)

- 空值行:重跑后回填通道(known 行 COALESCE)自愈;**LIST 不再露出的旧文永不被重访→不自愈**(定向重抓机制待建,遗留账)
- 每轮 agent 结果必过纠偏环节;一个例子=一类模式,主动举一反三列清单
- 假博文 URL 模式三板斧:白名单词末段拦(通用)/ landing+noise 词表补 / source-rules per-symbol exclude(最专)
- 服务器时区陷阱:V8 按进程本地时区解析无年份日期(KAVA -1 天实锤)→ 引擎统一 Date.UTC 重建
