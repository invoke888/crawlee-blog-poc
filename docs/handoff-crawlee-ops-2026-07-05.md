# 续接 · Crawlee 采集器 + 运维台 · 质量战役收官交接(2026-07-05)

> **接收方:** 下一个 Claude 实例(新会话)
> **必读三件套:** 本文档 + `~/.claude/CLAUDE.md`(老板全局铁律)+ memory/MEMORY.md(项目记忆索引 · 每条链接文件都要读 · 特别是全部 🔴)
> **上一份 handoff:** `docs/handoff-crawlee-ops-2026-07-04.md`(基础架构描述仍有效 · 其 §6 待办与运维台入口信息已被本文档更新)
> **本文档为当前唯一有效交接。**

---

## TL;DR

**本会话(07-04 下午 → 07-05)四大板块:①运维台切正式域名+UI 登录门厅+dashboard 六项增强 ②代理三池换东京直连 IP ③质量战役一期(字段级:四层过滤+138 host 规则库+回填通道 · 5 轮重跑 3 轮复检收敛)④全管线循环二期(路由级:R1 499 源→R2 141 源网络核验→B 26 源漏采诊断→R3 终核 · 修复 29 搬家+16 切 LIST+sitemap 三重增强 · XRP 12 年缺口闭合)。两战役合计 114 agent、7 轮全量重跑。终态:库 7215 条 · 全管线发布时间接近全覆盖 · 调度运行中(60min/批)· 三端一致 `270faaf` · 73 组单测全绿。**

## §1 当前状态

| 项 | 值 |
|---|---|
| 本地 | `/Users/lindashuai/Desktop/project/crawlee/` |
| GitHub | `git@github.com:invoke888/crawlee-blog-poc.git`(本地 SSH push · **服务器 remote 是 https 只能 pull**)|
| 服务器 | hk-prod `119.28.68.105` · ubuntu · `~/crawlee-blog-poc/` · SSH 走 SOCKS5 `127.0.0.1:10808` |
| HEAD | `270faaf` · 三端一致 |
| **运维台** | **`https://blog-picker.hhwlnet.com`**(LE 证书 certbot.timer 自动续期 · 80→443 · 旧 8788 已下线)· **UI 登录门厅**(cookie 30 天免登 · 账密 boss/见服务器 `.env.local` DASH_PASS · curl/脚本仍可 Basic 头 · **playwright 自验必须走 UI 表单登录**,httpCredentials 因静态页免鉴权不激活)· auth 全在 node 层(`ops/server/auth.ts` · nginx 纯反代不加 auth=老板拍)|
| 代理 | **三池已切东京直连 IP `13.231.108.161:1080`**(2026-07-04 老板拍 · 不经中转)· DB proxy_config 主源 + `.env.local` 兜底双层一致 · 换池 SOP 见 memory 三池架构 |
| 调度 | **运行中** · 60min/批 · 增量单轮 4-9min · push 未接通(等老板给 URL+SECRET)|
| 数据 | **7215 条**(article-detail 3685 · medium 1799 · rss 1254 · substack 373 · paragraph 104)· 发布时间接近全覆盖 · 挂起/排除:dc_banned 60 host + excluded_token_ids 11 |
| 单测 | `npm test` **73 组**全绿(quality-filters / date-rules / ops-auth 为本会话新增)|

## §2 本会话老板拍板记录(不许翻案)

1. **域名+证书**:blog-picker.hhwlnet.com · LE 正式证书 · 老 8788 下线
2. **鉴权**:node 层唯一 auth · nginx 不加中间件层 auth · UI 登录门厅(方案 C 三选一拍定)· 凭据给过老板(boss/2ad7…)
3. **dashboard 时间显示一律北京 UTC+8 到秒**(全站已改 · 之前显示的是 UTC)
4. 博文页列序:**博客(点击跳博客站)/标题/正文/发布时间/采集时间**;完整度筛选口径必须与显示字段一致(老板抓过两处口径 bug:源管理三点=最近采集 3 条全齐;博文缺正文=body+desc 双空)
5. 源管理:完整度三点+筛选 · 最近发布(纯 MAX pub)· 博文数 · 列头排序(id/symbol/最近发布/博文数)· **行内点击禁弹窗**,"打开最近"按钮开浮窗(可拖拽/调大小)
6. **push 存量语义**:6185 篇已全标 skipped_backlog;此后新采=none=未推(行内推送按钮 · 未接通时按钮走 dry 演练不回写)
7. 代理三池 host 换 13.231.108.161(东京直连)
8. **质量战役方法论(老板核心拍板)**:"没有统一标准就针对错误站点写特定规则 · 派 agent 定规则 · 多花时间把地基打好";"清数据重跑 → agent 复检(漏网/匹配错/规则错/漏规则/可救回)→ 错误单独抽出再修再跑 → 直到没问题/彻底无法解决 → 出报告";"全部管线含 RSS 都要查(怀疑误判为 RSS)" —— **这套循环 SOP 已固化进 memory,后续新问题按 SOP 转**
9. 处置拍板:**EPIC 黑名单** · 二期 C(desc 规则机制+RSC body 扩展)· 搬家 29 源更新(A)· 漏采根因战役(B)· 死亡项目 12 源挂起(C)· **共享栏目维持采集(D1:Socios 系 PORTO/MENGO/ARG + PreStocks ANTHROPIC + Ondo 系不动)**

## §3 两大战役成果(证据 /tmp/r1-out-* r2-out-* b-out-* fix2-out-* 及 memory)

### 一期 · 字段质量(07-04 深夜 · 73 agent · 5 轮重跑)
- **四层过滤同语义**(LIST 入队/收割入库/push/聚合 · 之前收割层零过滤=老板看到 DIA use-cases 垃圾的根因)· 白名单优先必须**全库口径**(tokenHasWhite)
- **规则库 `src/utils/extract-rules.json` 138 host**:date(ban/selector 遍历取首个命中/url_date/none/spa_only/**html_regex**)· title(ban og/selector)· body(容器三级回退+**html_regex 提 RSC 转义 articleBody**,Ondo 系 2400+ 字实证)· desc(ban og/meta → 自动落真正文,30 host 站级口号名单)
- **回填通道**(run-batch:known 行同款过滤后 upsert,COALESCE 只补空)—— 修"抽取器升级旧行永不自愈"机制债;UPSERT 六列全是空值回填语义,**非空错值必须删行重收**
- normalize 增强:序数词/点号月/D/M/YYYY(仅日>12)/未来时间 >48h 置空(CYBER 截止日误锚实锤)
- 数据操作:删 293 垃圾(备份 storage/cleaned-articles-*.json)· 原文实证修库 21 条 · 复读 desc 置空重写

### 二期 · 全管线循环(07-05 · 41 agent · R1→R2→B→R3)
- **老板怀疑全中**:PUNDIX feed=废弃通知频道 · SAGA 项目卖掉加密业务转型 · CVC 域名被无关公司接盘 · KMNO 登记自有域却采旧 medium
- **A 搬家 31 源**:新址全锁定并生效(ORCA/API3/BAND/CARV/PIXEL/AMP/YFI/BAT→brave.com 等)
- **B 漏采根治**:sitemap 流三重增强(`src/main.ts`:lastmod 失效检测[覆盖<50% 或唯一值≤2]→URL 日期兜底排序→双失效降级 LIST + sitemapindex 一层递归)· 16 源 fetch_strategy 切 LIST · **XRP 2014→2026-06 十二年缺口闭合**
- **C 挂起 12**:VELO/SIREN/STG/ETHW/ICX/SAGA/CVC/BLEND/MITO/SD/ASP/STEEM(平台源用 excluded_token_ids)
- 真停更 46 源双重核实(KSM/RAY 头部项目真弃更 Medium · 反直觉但实测)· 盲审误判 6 个被交叉验证平反(ONE/AAVE/SXT/NEO/ELF/IMX)

## §4 坑与教训(本会话新增 · 防再踩 · 详见 memory 三条 🔴)

| 坑 | 解 |
|---|---|
| **整域黑名单险情**:挂起 medium 平台源时把 medium.com/paragraph.com 整域塞进 dc_banned(险杀 193 源) | 批次窗口内撤回 · **平台源挂起只用 excluded_token_ids(token 级)** |
| **改 blog_url 六步 SOP**(A 包实操教训) | 同时重填 host_platform(substack/自定义域无 URL 兜底,清空=掉 LIST 挂零)· 自定义域配 platform_overrides · substack 必须 xxx.substack.com 标准形态 · **尾斜杠与同 blog 其他 token 完全一致**(1-to-N 按字符串分组,socios 斜杠分裂实锤)· 清 source-rules 旧域残留 · mirror 系=采不到 |
| 收割层 known 行整体 skip → 空字段永不自愈 | 回填通道(见 §3) |
| tsc 退出码被管道 head 吞 → 带类型错 commit 推出一次 | 检查必须看真实退出码(`npx tsc --noEmit; echo $?` 不接管道) |
| playwright httpCredentials 登不进(静态页免鉴权无 401 挑战) | 自验走 UI 表单填账密 |
| auth 失败限速死锁(无凭据首发也计数+锁续命) | 已重写:只计"错误凭据"·锁到期清零 |
| 完整度筛选与显示字段口径断层(老板抓的两处) | **铁律:筛选字段必须与显示字段同口径** |
| agent 盲审 vs 已拍板背景(Ondo 共享/strategy none 被误报) | 汇总纠偏环节必须过一遍"已拍板合法名单+已定性无解清单" |

## §5 下一步(老板启动才做)

| 项 | 内容 | 前置 |
|---|---|---|
| **push 接通** | 面板设置页填 URL/SECRET + push_enabled=1 · 🔴 铁律:同 url 多 token 合并一条(token_ids list)· 存量不推(已提前全标)| 老板给 secret |
| **P3 Playwright** | 结构性残留 ~14 源的唯一出路:JS 列表(SPURS/HEI/GLMR)+ SPA 壳(SCR/ASTR/VANRY/TWT)+ cf 挂起源(mirror7/PENGU/QNT 等)· 独立进程 batch_type=browser 已预留 | 老板启动 |
| 大站观察类 | BAT(brave.com/blog 采到但全老文)· BTC(bitcoincore 新文未入)· ETH(发现侧顺序 low-conf)· JOE/KMNO(medium feed 波动)· DCR(内容在 GitHub 外链)——先看几轮增量是否自愈,不愈按循环 SOP 转 | 观察 1 周 |
| 住宅轮换池 | WAF-IP 型恢复(TIA/LTC/MINA/SONIC/COW)| 老板给池 |
| 二期 | probe 巡检批次 · FTS 全文检索 · seen-store 裁剪 · C3 告警推送 · 13 组 desc 复读长尾 · ICNT 型 D/M/Y transform 字段 | 数据跑稳后 |
| 全源正式报告 | 老板说"出报告"按 poc-report 铁律(全 634 源+可筛选)走 aggregate-report.py 流程 | 老板叫 |

## §6 运维速查(变更点加粗 · 其余同 07-04 版)

```bash
# SSH(全部远程操作)
ssh -o "ProxyCommand=nc -X 5 -x 127.0.0.1:10808 %h %p" -i /Users/lindashuai/Desktop/key/qj/ssh_pri ubuntu@119.28.68.105
# 部署:本地改→push → 服务器 pull → sudo systemctl restart ops-dashboard
# dashboard API(Basic 兼容通道):curl -u "boss:<DASH_PASS>" https://blog-picker.hhwlnet.com/api/runs?limit=1
# 手动触发全量:POST /api/schedule/trigger · 暂停/恢复:/api/schedule/pause|resume
# reset(大规则变更后):npx tsx ops/reset.ts --confirm(三目录 · 永不碰 sources.db)
# 存量清理:npx tsx ops/clean-articles.ts(dry)→ --confirm(自动备份)· 顺序铁律:先上过滤再清
# 规则回放验证:npx tsx scripts/verify-date-rules.ts <html目录>
# 备份文件:storage/cleaned-articles-*.json · /tmp/backup-*.json · /tmp/a-backup-old-blogurls.json · .env.local.bak-proxy-switch
```

## §7 老板工作方式(本会话强化 · 全套见 CLAUDE.md + memory)

1. 老板给一个例子=一类模式,举一反三主动发现全部问题,列清单(问题/证据/建议/优先级)老板只拍板
2. 研究型战役:**20 agent 量级老板点过名** · sonnet · 切片 15-25 · 纯数据分析禁网时禁 playwright · 网络核验用 WebFetch 禁代理 · 临时文件唯一名
3. **循环 SOP(老板拍)**:清数据重跑 → agent 复检五维 → 错误单独抽出修 → 再跑 → 收敛/定性无解 → 报告;agent 结果必过"纠偏环节"(已拍板合法名单/已定性无解)
4. 改动完必:tsc 真实退出码 + 73 单测 + commit push + 服务器 pull restart + **真路径自验**(playwright UI 登录/curl/SQL 终检)才报老板
5. 中文 · 表格+emoji · 结论先行 · 拍板项字母编号 · 注意事项随手入 memory

---
*本文档由 Claude Fable 5 于 2026-07-05 生成 · 质量战役两役收官 · 下一棒从 §5 接。*
