# 续接 · Crawlee Node PoC · P2 收官交接(2026-07-03)

> **接收方:** 下一个 Claude 实例(新会话)
> **必读三件套:** 本文档 + `~/.claude/CLAUDE.md`(老板全局铁律)+ `~/.claude/projects/-Users-lindashuai-Desktop-project-crawlee/memory/MEMORY.md`(项目记忆索引 · 每条都要看)
> **上一份 handoff:** `docs/handoff-crawlee-poc-spa-2026-06-30.md`(已过时 · 仅历史参考)

---

## TL;DR

**634 源 · 采集池 519(黑名单4/挂起52/判死59)· 有数据 490 · 三字段全OK 375 · 缺desc仅1 · 全量 6.7min · 增量 4.5min 零重复 · 三池代理+164 源规则表+防陈旧机器防线全部上线。P0/P1/P2 全部收官 · P3 待启(Playwright/住宅池/timer/push)。**

---

## §1 当前状态

| 项 | 值 |
|---|---|
| 本地 | `/Users/lindashuai/Desktop/project/crawlee/` |
| GitHub | `git@github.com:invoke888/crawlee-blog-poc.git`(**SSH remote** · https token 已废)|
| 服务器 | `119.28.68.105`(hk-prod)· user `ubuntu` · `~/crawlee-blog-poc/` · SSH 走 SOCKS5 `127.0.0.1:10808` |
| HEAD | `7dee577`(C 类 9 源规则补齐)· 三端一致 |
| 报告 | `docs/poc-report.html`(**固定文件名** · 日期动态)· 数据 `docs/poc-report-data.json` |
| systemd timer | **停用**(老板拍 · 恢复前提见 §6)|
| 单测 | `npm test` 32 组(package.json 已带 `TSX_TSCONFIG_PATH=` 前缀)|

## §2 架构全景(改哪里 · 一处生效)

### 三池代理(服务器 `~/crawlee-blog-poc/.env.local` · 不进 git)
```
PROXY_URL=socks5://blog:...@admin-pool.hhwlnet.com:1080        # 主力 10 节点 · general 全速
PROXY_URL_MEDIUM=socks5://medium:...@admin-pool.hhwlnet.com:1080  # medium 生态(429 重灾)
PROXY_URL_SLOW=socks5://4q:...@admin-pool.hhwlnet.com:1080     # slow 队列
CRAWLEE_MEMORY_MBYTES=2048   # 🔴 不配=并发锁死1(crawlee 默认只拿总内存25%)· 19.6 倍提速的一行 · 换服务器必带
```
换池 SOP:只改 .env.local · 代码无感。direct_hosts(steemit.com)走 `newUrlFunction` 返 null 跳过代理。

### 规则体系(单一真源 · TS/python/HTML 三层共读)
| 文件 | 内容 |
|---|---|
| `src/utils/filter-config.json` | 白名单段(白名单优先赢黑名单)· landing 段 · 文件后缀 · host_blacklist(4)· **dc_banned_hosts(挂起52 · 住宅池/Playwright 后恢复)** · **dead_hosts(判死59)** · direct_hosts · throttled_domains(medium→池B)|
| `src/utils/source-rules.json` | **164 源 per-source 规则**(17+2 agent 审计产出):include_prefixes(段级带尾斜杠)/include_regex(WordPress日期型)/exclude_prefixes(语言变体)/**mode: sitemap-only**(chiliz×4/MENGO/BAT/REQ/OG 用 post-sitemap.xml 白名单)· 只 high 强制 |
| `src/config.ts URL_OVERRIDES` | 13 源 URL 修正(fetch-sources 同步时自动应用 · 防上游覆盖)|

### 采集管线(main.ts)
- **全并行**:medium(RSS·池B)+ substack(**node:fetch** 绕 cf · impit TLS 被拉黑)+ paragraph(api.paragraph.com RSS)+ general(全速)+ slow(限频域)+ sitemap-only 流 · Promise.all
- **增量**:入口(RSS/LIST)uniqueKey 带 RUN_SALT 每轮重抓;DETAIL 靠 queue dedupe;RSS 文章靠 **seen-store**(KV `seen-articles` · key=`token_id:url`)零重复
- **mirror 默认跳过**(cf JS challenge · `RUN_MIRROR=1` 打开)· 结尾 `process.exit(0)`(不然并行后挂死 19min+)
- LIST enqueue:`same-hostname`(收紧过)+ isValidHttpUrl + isLikelyArticleUrl + checkSourceRuleMulti
- detailHandler:错误页 title 拦截 · 外链根域拦截 · desc 梯队(og/meta→jsonld→**全文2000字**·老板拍"没摘要给全文")· pub 梯队(meta 10 项→jsonld→__NEXT_DATA__→itemprop 元素级)· h1/jsonld_description 双字段(防站级 og 复读 · 聚合层按重复度切换——**切换逻辑还没写 · 见 §7**)

### 报告链(老板说"出报告"就跑这个)
```
服务器: python3 scripts/aggregate-report.py     # 聚合+过滤+ISO时间+disposition+pattern_hit_ratio+腐烂告警
scp /tmp/poc-report.json → docs/poc-report-data.json
本地:   python3 scripts/embed-report.py          # 嵌入+control-char防御+防陈旧检查(死文案/静态章节>7天)
open docs/poc-report.html
```

## §3 数据指标基线(2026-07-03 收官轮)

| 指标 | 值 | 演进 |
|---|---|---|
| 有数据源 | 490/634 | 干净口径(垃圾源已判死出清)|
| 三字段全 OK | 375 | 280→348→373→375 |
| 缺 pub / 缺 desc | 115 / **1** | 208/21 起步 |
| 聚合噪音丢弃 | 180 | 827 起步 |
| pattern 腐烂告警 | 0 | 新机制 |
| 全量 / 增量 | 6.7min / 4.5min | 65min 起步(内存额度+三池+并行+判死出清)|
| 失败请求 | 29 | 90+ 起步 |

## §4 老板拍板记录(全部 · 不许翻案)

1. **blogpicker 状态不可信**(medibloc 实锤 paused 错杀 45%)· 不按 active 过滤 · 采集范围只认自有名单
2. FARTCOIN 砍(相关性弱)· PLAY 砍(三方聚合)→ dead_hosts
3. **「正文」语义:摘要够用 · 没摘要给全文**(desc fallback 全文截 2000 已实现)
4. timer 排后 · 恢复前提:给老板确切单轮时间 + **浏览器(Playwright)采集速度出来后再定**
5. 住宅池暂不做(单 IP 实测:WAF-IP 型能过 TIA/LTC/MINA/SONIC/COW · cf-JS 型无效)
6. push 对接 hhwl 排最后(白名单过滤已装好 · 等 PUSH_API_URL/SECRET)
7. Playwright + 住宅池 = **P3**
8. 报告铁律追加:处置状态行级 chip · 字段齐全度筛选 · desc 50 字预览 · landing 不进示例 · 白名单优先 · generated_at 动态

## §5 老板工作方式(🔴 三条核心 feedback · memory 有档)

1. **主动发现问题列清单 · 老板只审查**:老板给一个例子=一类模式 · 举一反三全查 · 战役收尾必附「主动发现清单」(问题/证据/影响/建议/优先级)
2. **多派 agent**:研究型默认 6-10+ 个并行 · 切片 15-25 项 · sonnet 便宜量大 · 实现型单 agent 防冲突
3. **防陈旧**:报告静态内容有机器防线(embed 脚本查死文案/章节年龄)· 状态列以采集事实为准(probe 是历史快照)

## §6 P3 待办(老板已排期)

| 项 | 内容 | 前置 |
|---|---|---|
| **Playwright 兜底** | cf-JS 型 ~20 源(mirror7/PENGU优先/jito)+ 架构型(PROM DropInBlog JSON API 分支 · FIDA `__NEXT_DATA__` 入口)· **独立进程跑不碰 http 主速度** · curl-impersonate 备选 | 老板启动 |
| **住宅轮换池** | WAF-IP 型 ~20 源(名单=dc_banned 里非 cf-JS 的)· 加第四池分流 | 老板给池 |
| **timer 频率** | 全量 6.7min/增量 4.5min 已有 · 等 Playwright 速度合并汇报老板拍 | Playwright 完 |
| **push 对接** | DRY_RUN 已验(白名单过滤生效)· 等 PUSH_API_URL/SECRET · 注意键名 published_at/publishedTime 双读已修 | 老板给 secret |
| FIDA 微调 | 规则对(/blog/)但 sitemap 入口没覆盖 104 篇(在 __NEXT_DATA__)· 本轮 0 条 | 顺手 |

## §7 已知未完事项(小尾巴)

- **聚合层 h1/jsonld_description 切换逻辑未写**(抓取层双字段已存 · 同源 title 重复度≥80% 时报告应切 h1 显示 — title 误报 25 源的展示层修复)
- probe 剩 33 源未探(timeout 截断 · 下次跑 `PROBE_LIMIT=50 npx tsx src/probe.ts`)
- MENGO/socios 只截了 lastmod 前 10(post-sitemap 有 900 篇 · 存量回填要不要做等老板)
- seen-store 数组会无限涨(巡检 >5MB 告警 · 裁剪策略未做)

## §8 坑与教训(防再踩 · 血泪账)

| 坑 | 症状 | 解 |
|---|---|---|
| `TSX_TSCONFIG_PATH` 环境变量泄漏 | tsx 任何命令报 `Cannot resolve tsconfig at server/tsconfig.json` | 命令前 `TSX_TSCONFIG_PATH=` 置空(npm test 已内置)|
| `CRAWLEE_MEMORY_MBYTES` 未配 | RPM 锁 90 · `desiredConcurrency:1` · 表象像被反爬 | .env.local 配 2048 · 诊断口径 grep `memInfo` |
| pgrep 自匹配 | polling 死循环(SSH 命令行含匹配串)| `pgrep -f "[t]sx src/main.ts"` 方括号 trick |
| 并行后进程不退 | 统计打完挂 19min+ | main.ts 尾 `process.exit(0)` |
| **agent 裸 curl 假反爬** | 判死了生产能抓的源(C 类 9 源全翻案)| 诊断一律用 `scripts/probe-fetch.ts`(impit 生产指纹)|
| playwright MCP 并发抢 tab | 多 agent 判定被互相污染 | agent prompt 明令禁用 playwright MCP |
| Date.parse('12345') | 解析成公元 12344 年 | normalize 纯数字只认 10/13 位时间戳+4位年份 |
| probe null 覆盖 platform | CRO 的 substack 标记被冲 | db.ts 已 COALESCE · 人工标记安全 |
| Edit replace_all 缩进差异 | mediumRouter normalize 漏改一处 | 改多处后 grep 验证全命中 |
| Webflow `<!-- Last Published -->` | 部署时间被当文章时间 | 已知陷阱 · 别信 HTML 头部注释日期 |
| sitemap lastmod 扎堆同一秒 | 批量重建索引 ≠ 真更新 | 判活跃度要抽真文章 datePublished |
| crawlee addRequests 异步 batch 炸进程 | 非法 URL(mailto:)→ unhandledRejection 全进程死 | isValidHttpUrl 前置 + unhandledRejection 兜底(都已装)|

## §9 命令模板

```bash
# SSH(全部远程操作走这个)
ssh -o "ProxyCommand=nc -X 5 -x 127.0.0.1:10808 %h %p" -i /Users/lindashuai/Desktop/key/qj/ssh_pri ubuntu@119.28.68.105

# 服务器全量跑(标准流程)
cd ~/crawlee-blog-poc && pkill -f 'tsx' || true; sleep 2 && git pull --no-rebase
rm -rf storage/datasets storage/request_queues storage/key_value_stores   # 全量才 rm · 增量不 rm
export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env --shell bash)"
set -a; source .env.local; set +a
nohup env NODE_OPTIONS='--max-old-space-size=3072' SITEMAP_URLS_PER_SOURCE=10 npx tsx src/main.ts > storage/main-run.log 2>&1 &

# 出报告(§2 报告链)· 生产探针诊断
npx tsx scripts/probe-fetch.ts <url> [out.html]
# 存储巡检
bash scripts/storage-report.sh
```

## §10 研究资产(全部判定证据)

`docs/research/`:agent2/3 报告(E桶/F桶)+ `pattern-verdicts-205-sources-2026-07-03.json`(205 源判定全档)。32 个 agent 战役史:3(抽取规则)+10(无数据/paused)+17(pattern)+2(C类)。

---
**本文档由 Claude Fable 5 于 2026-07-03 生成 · P0/P1/P2 收官 · P3 待启。**
