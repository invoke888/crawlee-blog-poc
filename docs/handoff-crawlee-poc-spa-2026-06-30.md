# 续接 · Crawlee Node PoC · hhwl 项目方 blog 采集(2026-06-30 v2 EOD)

> **接收方:** 下一个 Claude 实例(新会话)
> **发起人:** 黄权权
> **来源会话:** 2026-06-30(全天迭代 · 从 P0 大修 → SPA 反向工程 → sitemap 降级 fix)
> **老板全局工作原则:** `~/.claude/CLAUDE.md` · 必读
> **项目 memory 索引:** `~/.claude/projects/-Users-lindashuai-Desktop-project-crawlee/memory/MEMORY.md` · **auto-load 自动读**

---

## TL;DR

**Crawlee Node PoC 跑在 hk-prod · 爬 hhwl 上 634 项目方 blog · 跟 blogpicker prod 双跑零影响。当前 dataset 3609 条(修完 sitemap 降级估 4000+)。今日修了 4 大类 P0 误判(白名单太严 / og 二次验证太严 / enqueueLinks ARTICLE_GLOBS 太严 / sitemap 失败没降级)· 老板抽样验证有效。3 大瓶颈剩:代理池 / SPA Playwright / 推送 hhwl。**

---

## §1 项目状态快照(2026-06-30 23:00 CST)

| 项 | 值 |
|---|---|
| 本地目录 | `/Users/lindashuai/Desktop/project/crawlee/` |
| GitHub | https://github.com/invoke888/crawlee-blog-poc(**public**) |
| 服务器 | ubuntu@`119.28.68.105`(hk-prod · 2c4G · SA5.MEDIUM4)|
| SSH key | `/Users/lindashuai/Desktop/key/qj/ssh_pri` |
| **SSH 走 SOCKS5**(中港线路频繁 timeout) | `-o "ProxyCommand=nc -X 5 -x 127.0.0.1:10808 %h %p"` |
| Node | fnm v24.16.0 用户级 · 不动系统 apt |
| 当前 commit | `57b3803`(sitemap 失败降级 LIST) |
| systemd timer | `crawlee-blog-poc.timer` 每 3h 跑一次 · 老板可能 stop 过 · handoff 时 check `systemctl status` |
| blogpicker prod | **全程零影响** · active + HTTP 200(每次自验)|
| hhwl API | `GET https://blog-picker.hhwlnet.com/api/blogs` · 无鉴权 · 651 条 blog 源(binance 忽略 10 · 剩 634) |

## §2 dataset 分布 · 当前效果

| 桶 | 条数 | 说明 |
|---|---|---|
| medium(RSS) | 262 | 部分 429 反爬(quarkchain/etherfi/api3 等)· 等代理池 |
| article-detail | ~3134 | 主力 · 2-level crawl(LIST → DETAIL) |
| **总 dataset** | **3754**(sitemap 降级 fix 后)| 有数据源约 145 / 634 |
| `b8p8iq1y3` 已完成 | euler.finance: **14 条** ✅(修好)· simonscat: 0 ❌(可能真 SPA) | HTML 已嵌 879KB |

**老板抽样验证过修好的站:**
- ✅ chromia.com / dinari.com(P0 修 og 二次验证放宽)
- ✅ bitcoincashnode.org(30 条)/ blog.orchid.com(29 条)(enqueueLinks 换 isLikelyArticleUrl)
- ⏳ euler.finance / simonscat.xyz(等 background 结果 · sitemap 降级 fix)

## §3 架构

```
main.ts 编排(4 桶 · 3 Crawler):
  ├─ mediumCrawler(CheerioCrawler + ImpitHttpClient)
  │   ├─ medium.com/@user → RSS · maxRPM 120 · concurrency 5
  │   ├─ 关 SessionPool(Crawlee 官方推荐 · RSS 无状态)
  │   └─ paragraph.xyz(同 RSS-like)
  ├─ generalCrawler(CheerioCrawler + ImpitHttpClient)
  │   ├─ sitemap 源:Sitemap.load → article URL(前 10)→ DETAIL handler
  │   ├─ heuristic 源(og=none):首页 → LIST → enqueueLinks → DETAIL
  │   ├─ other 源:首页 → LIST → DETAIL
  │   └─ 🆕 sitemap 降级:Sitemap.load 失败/0 URL 时 · 加进 LIST 桶(euler 类 SPA fallback bug 触发)
  └─ mirrorQueue(Mirror.xyz 特化 · 独立队列 · 反爬硬 · 待代理池)
```

## §4 今日关键改动 · 按 commit(全在 main)

| Commit | 改动 |
|---|---|
| `214d2fe` | fix: 修 P0 大量误判(取消 isArticle 6 证据二次验证 + isLikelyArticleUrl 改默认 true) |
| `212a756` | fix: LIST handler enqueueLinks 不用 ARTICLE_GLOBS · 用 isLikelyArticleUrl 同步 |
| `57b3803` | fix: sitemap 失败/0 article 时降级 LIST(euler.finance/sitemap.txt SPA fallback bug) |
| 早前 · SPA 反向工程 | curl 实测 scroll.io Next.js 14 RSC · 必须带 `next-action` header + `Next-Router-State-Tree` + body `["<slug>"]` 才拿正文 · action ID 在 `page-XXX.js` bundle 里可 grep |
| 早前 · 老板加 | `src/utils/normalize-date.ts`(ISO-8601 归一化开始做) |

## §5 未完成 · 待办

### 🔴 P1(紧急 · 影响覆盖率)
1. **代理池接入** — 老板会给一波代理 · 我接 Crawlee `ProxyConfiguration` · 解 medium 429 + 顽固 403 · memory `project-proxy-pool-pending` 已记
2. **AdaptivePlaywrightCrawler 兜底真 SPA** — dinari/casper/macropod 等 cheerio 抓不到 SSR + 不是 Next.js RSC 的站 · 已调研完 Crawlee 官方推荐(混合 HTTP + 浏览器 · 自动 10-15% 采样学习)
3. **推送 hhwl `/api/posts` 接通** — 等老板配 blogpicker settings 里的 `push_api_url` + `push_api_secret`(**目前空**)

### 🟡 P2(打磨)
4. **coredao 类 Next.js Pages Router** — `__NEXT_DATA__` inline JSON 直接 parse · 已写 PoC `src/spa-poc.ts`(半成品 · 没集成 main.ts · tsx 本地跑不通因 tsconfig 父级路径问题) · 服务器上应能直接调
5. **scroll.io 类 Next.js 14 RSC** — 已验证可行 · action ID 是 deploy-time hash · 每次跑先 GET 首页 → grep `page-XXX.js` bundle 摸 action ID → POST + body 拿 Markdown
6. **raw HTML 保存** — 老板拍板要做 · Crawlee `KeyValueStore` 存每站最新 HTML · 后续调规则本地测试不用真抓 · memory `project-save-raw-html` 已记 · **老板反复强调这条**
7. **ISO-8601 归一化持续** — 老板已开工 `src/utils/normalize-date.ts` · 后续遇到新格式继续加 · memory `project-todo-published-at-iso8601-normalizer` 已记
8. **systemd race** — timer 每 3h 触发新 service · 之前抢占过旧 main.ts(SIGTERM) · 加锁文件或 `RefuseManualStart`

### 🟢 P3(长期)
9. 监控页面 · 每天抓多少 / 失败多少 / 推送成功
10. article 白/黑名单持续迭代(老板发现漏判就报)
11. 长期扩到几千源(hhwl 数据在涨)

## §6 高频铁律(memory 里全 · 只列今天用最多的)

| 铁律 | 触发关键词 |
|---|---|
| **本地开发 · 服务器跑数据** — 反爬/性能测试必须在 hk-prod · 本地只用 tsc 编译 | 跑数据/性能 |
| **不重复造 Crawlee 已有的轮子** — 写新功能前必 grep `docs-reference/crawlee-docs/` + 派 Explore 调研 | 新功能/新 handler |
| **源采集报告必须列全部源 + 可筛选表格** — 634 全列 · 不抽样 · JS 客户端筛选 | 报告/进展 |
| **保存每次采集 HTML 原文** — KeyValueStore(还没做) · 老板反复强调 | 测试/调规则 |
| **派 subagent 必走 6 步 + 干完必自验通过才报老板** — 铁律 12/13 | 派 agent |
| 用中文沟通 · 表格 + emoji + 先结论 | 全局 21a-21g |
| 24x7 数字员工 · 不说睡觉/晚安 | 全局 |
| **不隐藏困惑** — 实测不成立立刻承认 · 不圆场 | 全局 |

## §7 老板沟通风格(重点 · 我今天踩过雷)

- **一字/两字回复** — a/b/c/d/e 是选项 · "q" = quit · "继续" = 让我继续
- **不喜欢我猜** — 实测证据说话 · 猜错必须立刻承认不圆
- **抽样验证** — 老板会随机点报告"无数据"的源 · 打开看真实情况 · 发现漏判会报回
- **对 SPA 反向工程超在行** — 老板会自己看 Chrome DevTools · 摸到 scroll.io POST + next-action · 尊重直觉 · 别粗暴反驳
- **老板已经自己改代码** — `config.ts` 频改 · `utils/normalize-date.ts` 是老板加 · Write/Edit 前**必先 Read**
- **linter 也频繁改文件** — 同上
- **报告默认全量不抽样** · 加"仅有数据"默认筛
- 不接受降级方案 · 不用假数据兜底

## §8 关键命令(直接 copy)

```bash
# SSH(必走 SOCKS5)
ssh -o "ProxyCommand=nc -X 5 -x 127.0.0.1:10808 %h %p" \
    -o ServerAliveInterval=10 \
    -i /Users/lindashuai/Desktop/key/qj/ssh_pri \
    ubuntu@119.28.68.105

# 服务器手动跑
cd ~/crawlee-blog-poc
export PATH="$HOME/.local/share/fnm:$PATH" && eval "$(fnm env --shell bash)"
sudo systemctl stop crawlee-blog-poc.timer                # 停 timer 防抢占
pkill -f 'tsx src/main.ts' ; sleep 3                       # 杀残留
rm -rf storage/datasets storage/request_queues storage/key_value_stores
NODE_OPTIONS='--max-old-space-size=3072' SITEMAP_URLS_PER_SOURCE=10 \
    npm start > storage/main-run.log 2>&1

# 服务器看数据
ls storage/datasets/default/ | wc -l                       # 总条数
grep -l "\"crawler\": \"article-detail\"" storage/datasets/default/*.json | wc -l
sqlite3 storage/sources.db "SELECT COUNT(*), COUNT(probed_at) FROM sources"

# 服务器聚合 JSON(嵌 HTML 用)
# 完整脚本见 src/report.ts · 或用 handoff §11 里的 python 内联

# scp 拉 JSON 本地
scp -o "ProxyCommand=nc -X 5 -x 127.0.0.1:10808 %h %p" \
    -i /Users/lindashuai/Desktop/key/qj/ssh_pri \
    ubuntu@119.28.68.105:/tmp/poc-report.json \
    docs/poc-report-data.json

# 本地嵌 JSON 到 HTML(v3 已支持 articles 数组字段)
python3 -c "
import re, os
h='docs/poc-recap-2026-06-30.html'; j='docs/poc-report-data.json'
with open(h) as f: html=f.read()
nj=open(j).read().replace('</script>','<\\/script>')
html=re.sub(r'<script id=\"data\" type=\"application/json\">.*?</script>',
    f'<script id=\"data\" type=\"application/json\">{nj}</script>', html, count=1, flags=re.DOTALL)
with open(h,'w') as f: f.write(html)
print('HTML:', os.path.getsize(h))
"
```

## §9 关键文件结构

```
src/
├── main.ts                # 4 桶分流 + 3 Crawler 编排 + sitemap 降级
├── config.ts              # IGNORED / ARTICLE_GLOBS / URL_OVERRIDES / isLikelyArticleUrl(老板/linter 频改)
├── fetch-sources.ts       # 拉 hhwl API 进 SQLite
├── probe.ts               # 探每站 fetch_strategy/og_quality/sitemap
├── report.ts              # SQLite 分布报告 CLI
├── push.ts                # 推送 hhwl(等 push_api 配置)
├── spa-poc.ts             # SPA 双抓法 PoC · 未集成 main.ts
├── utils/
│   └── normalize-date.ts  # 🆕 老板自己加 · ISO-8601 归一化
├── registry/
│   ├── schema.sql
│   └── db.ts
└── handlers/
    ├── default.ts         # 通用 og handler(fallback)
    ├── article.ts         # LIST + DETAIL(核心 · 主力抓取)
    ├── medium.ts          # Medium RSS
    ├── heuristic.ts       # og=none 兜底
    ├── paragraph.ts       # Paragraph.xyz 特化
    └── mirror.ts          # Mirror.xyz 特化(反爬硬 · 待代理池)

docs/
├── poc-recap-2026-06-30.html          # 老板看这个(默认筛"仅有数据")
├── poc-report-data.json                # 表格数据(~800KB)
├── handoff-crawlee-poc-spa-2026-06-30.md  # 本文件 v2 EOD
└── docs-reference/                     # Crawlee 官方文档本地缓存(grep 用)
```

## §10 memory 全清单(auto-load)

```
~/.claude/projects/-Users-lindashuai-Desktop-project-crawlee/memory/
├── MEMORY.md                                          # 索引 · auto-load
├── user-role-uses-claude-to-code.md                   # 老板用 claude 写代码
├── workflow-no-tech-stack-concern.md                  # 别列语言栈差距
├── project-rule-local-dev-server-run.md               # 本地开发/服务器跑
├── project-rule-no-reinvent.md                        # 不重复造 Crawlee 已有轮子
├── project-rule-full-source-report.md                 # 报告必须全量不抽样
├── project-proxy-pool-pending.md                      # 代理池待接
├── project-save-raw-html.md                           # 保存每次采集 HTML
├── project-todo-published-at-iso8601-normalizer.md    # ISO-8601 归一化
└── project-crawlee-poc-local-first.md                 # 本地开发 + git push 流程
```

## §11 现在活跃的 background 任务(handoff 时先看)

**`b8p8iq1y3`**(SSH 服务器 + 跑最新代码 `57b3803` + 验证 6 站 + scp + 嵌 HTML 一步)· 状态查看:
```bash
# 新会话第一件事
cat /private/tmp/claude-501/-Users-lindashuai-Desktop-project-crawlee/a4545482-0ed2-4401-aa89-013f8f4ab574/tasks/b8p8iq1y3.output 2>&1 | tail -30
```
如果状态 stopped(会话切换被打断) · SSH 看现状:
```bash
ssh ... "cd ~/crawlee-blog-poc && ls storage/datasets/default/ | wc -l; ps aux | grep tsx"
```
如果 main.ts 还在跑 · 等完;死了 · 手动 npm start(见 §8 命令)。

---

## §12 新会话第一句话建议

> 收到。我接手 Crawlee Node PoC(hhwl 项目方 blog 采集) · 已读续接文档 + memory + 老板 CLAUDE.md。
>
> **现状快照:**
> - dataset 3609 条 · 有数据源约 141 / 634(修完 sitemap 降级估 4000+ · 上轮 background `b8p8iq1y3` 跑中)
> - 今日主要修:白名单太严 / og 二次验证太严 / enqueueLinks 太严 / sitemap 失败没降级 · 老板抽样验证有效
> - 3 大瓶颈:代理池 / Playwright SPA 兜底 / 推送 hhwl(等老板配 push_api)
> - blogpicker prod 全程零影响 · systemd timer 3h 一次
>
> **先看上轮 background 结果:**
> ```
> cat /private/tmp/claude-501/-Users-.../tasks/b8p8iq1y3.output | tail -30
> ```
>
> **请老板拍今天优先级:**
> - **A**. 看 `b8p8iq1y3` 结果 · 继续修剩下漏判(老板抽样风格)
> - **B**. 代理池接入(老板给代理配置)
> - **C**. Playwright 兜底 SPA(dinari/coredao/casper/macropod · 已调研完 AdaptivePlaywrightCrawler 方案)
> - **D**. 推送 hhwl(等老板 `push_api_url` + `push_api_secret`)
> - **E**. raw HTML 保存(老板反复强调 · 长期任务)
> - **F**. 别的

---

**本文档由 Claude Opus 4.7 在 2026-06-30 23:00 CST 生成 · 老板转交新 Claude 实例使用。**
