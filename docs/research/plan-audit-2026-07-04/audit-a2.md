# 方案审计 · A2(博客/博文数据模型)

被审计文档:`docs/plan-ops-dashboard-2026-07-04.md`
参照文档:`docs/handoff-crawlee-poc-p2-2026-07-03.md`
补充验证(只读,未改动任何文件):`src/utils/display-fields.ts`、`src/handlers/article.ts`、`src/registry/db.ts`、`src/registry/schema.sql`、`scripts/aggregate-report.py`、`docs/mockup-ops-b.html`

---

## 问题清单

### 🔴 P0-1 · articles 表 UPSERT 语义完全未定义 — 三个具体覆盖风险

**问题**:计划书 line 214 关于 articles 写入只有一句话:"run-batch 在采集结束后,把本轮新增(dataset 中 crawledAt > started_at 的条目)upsert 进 articles 表。唯一写入点,与 dataset 同轮同源 = 一致。" 完全没有说 ON CONFLICT (url, token_id) 命中时,逐列该覆盖还是保留。这不是吹毛求疵——项目自己的代码库里已经踩过同类坑并留了先例。

**证据**:
- `src/registry/db.ts:66-90` `updateProbe()` 对 `host_platform` 显式用 `COALESCE(@host_platform, host_platform)`,注释直接写:"probe 检测不出 platform(custom-domain substack 如 CRO)时保留人工标记 · 不许 null 覆盖"(对应 handoff `§8` 坑表:"probe null 覆盖 platform | CRO 的 substack 标记被冲 | db.ts 已 COALESCE")。这正是"naive upsert 覆盖已有正确值"这个 bug 模式在**同一个数据库文件**里已经发生过一次的实锤。articles 表比 sources 表牵涉更多"不能被覆盖"的字段,计划书却完全没提这个先例。
- **子风险 a(push_status/pushed_at 被冲掉)**:reset 会清 seen-store(计划书 line 61),导致下一轮"重新发现"全部历史 URL,run-batch 会把它们当"本轮新增"重新 upsert 一遍(line 214 逻辑本身如此)。如果 upsert 是整行覆盖或 SET 列表包含 push_status/pushed_at,**每次 reset 都会把所有已推送文章的状态冲回 'none'**。二期一旦有任何"push_status=none 就重新推送"的自动化逻辑,会对已经推过的用户重复推送——直接撞上 🔴 push 记忆铁律。
- **子风险 b(title/description 复读 bug 被重新引入)**:`src/utils/display-fields.ts`(2026-07-03 老板拍板新增)实现了 `computeDisplayFields()`,专门解决"BCH 59 篇 title 全叫 'Bitcoin Cash Node'"、"~17 源 og:description 站级 slogan 复读"这类站级复读误报,`scripts/aggregate-report.py:142,191` 用 Python 复刻了同一逻辑用于静态报告。但这是**按同源多条一起看的批量/群体函数**(`modeRatio` 需要整批数据算复读占比),不是单条记录可套用的转换。计划书 articles 表(line 170)只有扁平的 `title TEXT, description TEXT` 两列,也没有 `h1`/`jsonld_description` 列,line 214 更没提要不要套用这套切换逻辑。如果 run-batch 只是把 dataset 里原始 `title`/`description` 字段直接搬进 articles,**静态报告已经修好的复读 bug 会原样出现在博文管理页**——而这恰恰是老板点名要看的新页面。
- **子风险 c(crawled_at 语义不明)**:articles 有 `first_run_id`("哪轮采到的")和 `crawled_at`,但没定义 `crawled_at` 是"首次采集"还是"最近一次采集"。如果 upsert 每次都刷新 `crawled_at`,reset 后全部历史文章会在同一天显示"采集时间=今天",博文管理页的"采集时间范围"筛选在 reset 当天/次日会变得没有意义(几乎全量命中)。

**建议修改文段**(替换 line 214 段落):
> **articles 写入:** run-batch 在采集结束后,把本轮新增(dataset 中 crawledAt > started_at 的条目)UPSERT 进 articles 表,冲突键 `(url, token_id)`。**禁止整行覆盖式 UPSERT**(参考 `src/registry/db.ts updateProbe()` 的 COALESCE 教训),ON CONFLICT DO UPDATE 逐列声明:
> - `title`/`description`:不要直接写抓取原始字段。articles 增加 `h1 TEXT, jsonld_description TEXT` 两列与 dataset 对齐存原始值;展示用的"最终标题/摘要"在 `GET /api/articles` 读取时按 token_id 分组现算,复用 `src/utils/display-fields.ts` 的 `computeDisplayFields()`(TS 组件可直接 import,不新造第三份实现)。
> - `first_run_id`:UPDATE 时不覆盖(不出现在 SET 列表,或 `COALESCE(first_run_id, excluded.first_run_id)`)。
> - `push_status`/`pushed_at`:UPDATE 时不覆盖(不出现在 SET 列表;只由专门的 push 回写流程改)。
> - `crawled_at`:定义为"首次采集时间"(INSERT 时设置,UPDATE 不覆盖);如需"最近一次验证还在"的语义,另加 `last_seen_at` 字段,每次 upsert 都刷新。

---

### 🔴 P0-2 · reset 是否清空 storage/sources.db(articles/账本所在库)未写明确

**问题**:计划书 line 61 定义"重置(reset)"= "清 storage/ 重新累积"。但 line 35 明确写"账本新表加进同一个库"——也就是说 `storage/sources.db` **物理上就在 storage/ 目录下**。字面读"清 storage/",sources.db 会被一并清空,包括刚建的 runs/source_runs/articles/alerts 全部账本历史。这与同一行提到的 `is_after_reset` 标志矛盾:如果账本表本身会被 reset 清空,`is_after_reset` 这个"防环比误报"的标志毫无意义(没有历史可环比)。

**证据**:
- 计划书 line 33-41(1.2 现有数据资产表)第一行:"源注册表 | `storage/sources.db`(SQLite)| 634 源。**账本新表加进同一个库 = 天然一致**"
- 计划书 line 61:"重置(reset)| 运维动作(非调度概念):清 storage/ 重新累积...账本 runs 表有 is_after_reset 标志"
- 现有已实际使用的 SOP(handoff `§9` 命令模板,line 130-131):`rm -rf storage/datasets storage/request_queues storage/key_value_stores` —— **明确不含 sources.db**,说明团队现有惯例是"只清产出/队列/KV,不碰 db 文件"。但这个惯例是隐含在旧 SOP 里的,计划书重新定义"reset"概念时没有显式重申/继承这一条,存在被字面误读的风险(尤其新执行 Claude 未必会去比对旧命令模板的排除范围)。

**风险**:一旦被误读成 `rm -rf storage/*` 或"清 storage/ = 清整个目录",会把 runs/source_runs/**articles**/alerts 全部账本资产**不可逆删除**——这正是这整套系统的核心资产("articles 成为唯一历史",见下一条)。

**建议修改文段**(替换 line 61 表格行):
> | **重置(reset)** | 运维动作(非调度概念):清 `storage/datasets`、`storage/request_queues`、`storage/key_value_stores`(seen-articles + raw-html 两个 KV)。**明确不清 `storage/sources.db`**(registry + 账本 runs/source_runs/articles/alerts 永久保留 —— `is_after_reset` 标志的意义正建立在账本必须跨 reset 存活之上)。仅大规则变更后由 Claude 手动执行。 |

同时建议把这条locked 进 §9"明确不做"清单,加一条 "❌ reset 不清 storage/sources.db",双保险。

---

### 🔴 P0-3 · "正文关键词"搜索承诺与数据模型只存摘要级 description 之间的语义缺口

**问题**:计划书 line 19(老板拍板表)与 line 306(博文管理页详设)都写"筛...正文关键词..."。但 articles 表(line 165-177)只有 `title`/`description` 两个摘要级字段,line 169 注释自己也承认"摘要级(全文仍在 dataset/raw-html)"。查 `src/handlers/article.ts:169-190`,`description` 的生成规则是:**有正常 meta/og 摘要时就是 1-3 句摘要**,只有在"完全没有摘要"时才 fallback 成正文前 2000 字。也就是说对**大多数**有正常摘要的文章,"正文关键词"搜索实际只是"摘要关键词"搜索——正文里出现但摘要里没有的词,搜不到,而且用户不会意识到这是"搜索范围不够",只会以为"这篇文章没提到这个词"。

这不是要推翻 handoff `§4` 第 3 点"「正文」语义:摘要够用·没摘要给全文"的老板拍板——那条拍板解决的是"**摘要展示**够不够格代表正文"的问题;这里是"**关键词搜索**要不要覆盖正文全文"的问题,两者标准不同,老板没有对后者拍过板。

**证据**:
- 计划书 line 19、line 306(UI 文案"正文关键词")
- 计划书 line 165-177(articles schema,只有 title/description 两列)、line 169 注释
- 计划书 line 306 API `GET /api/articles?q=&...`,`q=` 匹配哪些列未说明
- `src/handlers/article.ts:169-190`(description 生成梯队:og/meta → jsonld → 全文2000字,仅在无摘要时触发全文 fallback)
- 全仓库 grep 确认目前**零 FTS5 使用先例**,新增全文检索是全新工程量,不是复用已有能力

**建议修改文段**(在 line 306 后加一段,提供三个方案供老板选):
> **"正文关键词"搜索范围说明**(需明确,三选一):
> - **A(诚实降级 · 零成本)**:UI 文案改成"标题/摘要关键词",不动 schema 不动查询,只是不再对"正文"打包票。
> - **B(扩大摘要 · 低成本)**:description 生成规则从"仅无摘要时才截 2000 字全文"改为"始终额外存一份 `body_excerpt`(截 3000-5000 字)",LIKE 查询覆盖面显著提升。
> - **C(真全文检索 · 工程量最大)**:articles 旁加一张 SQLite FTS5 虚拟表,内容来源于方案 B 的 `body_excerpt` 或 raw-html 现抽正文,MATCH 语法查询,量级到十万级依然快,但当前代码库无 FTS 先例,需要新增写入同步逻辑。
> 一期建议至少做 A;B 列入二期优化;C 除非博文量级预期短期破十万,暂不必要。

---

### 🔴 P0-4 · 手动裸跑 main.ts 会产生 articles 遗漏,与"不许两份真相"拍板冲突

**问题**:计划书 line 97 明确"手动裸跑 main.ts(无 RUN_ID)时跳过账本写入",line 214 明确 articles 唯一写入点是 run-batch.ts(在采集**结束后**读 dataset 写 articles)。也就是说,**只要不经过 run-batch.ts 触发的采集,产生的 dataset 文章永远不会进 articles 表**。

而 handoff `§9`(本计划书指定的必读材料)"服务器全量跑(标准流程)"一节给出的命令模板就是直接 `nohup ... npx tsx src/main.ts`——绕开 run-batch.ts。计划书通篇没有一处说"这份旧 SOP 以后弃用/仅限调试/不算正式批次",也没有说"以后所有采集必须通过 run-batch.ts 触发"。

**风险**:只要执行 Claude(或未来任何人)沿用 handoff `§9` 现成的、写得明明白白的"标准流程"手动开一轮(例如改完规则想马上验证效果、紧急重跑),dataset 会新增文章,但 articles 表不会同步,博文管理页/源管理页会**静默漏掉这批文章、没有任何报错或告警**——直接违反计划书自己第 0 节老板拍板:"使用的数据必须一致(共享数据层,不许两份真相)"。这个 bug 模式比"数据错误"更隐蔽,因为它不报错、不崩溃,只是"安静地少一块"。

**证据**:
- 计划书 line 97:"RUN_ID 由 run-batch 经环境变量传入;**手动裸跑 main.ts(无 RUN_ID)时跳过账本写入**"
- 计划书 line 214:"articles 写入:run-batch 在采集结束后...upsert 进 articles 表。**唯一写入点**"
- handoff `§9`(line 129-134):"服务器全量跑(**标准流程**)" 给出的正是绕开 run-batch 的裸 `nohup npx tsx src/main.ts` 命令
- 计划书第 0 节:"共享同一 git 目录成为一个项目...使用的数据必须一致(共享数据层,**不许两份真相**)"

**建议修改文段**(在 §10"给执行 Claude 的上下文指路"补一条):
> 6. **手动裸跑弃用声明**:一期起,正式采集一律通过 `run-batch.ts` 触发(即使临时验证规则改动,也建议 `RUN_ID=manual-$(date +%s) npx tsx ops/run-batch.ts` 方式跑,而不是 handoff §9 旧 SOP 的裸 `nohup tsx src/main.ts`)。确需裸跑排障(例如只想看某条规则效果、不想污染账本)时,**必须知悉产出的 dataset 条目不会进 articles 表**,博文管理页会与 dataset 出现差异,这是预期行为而非 bug。

---

### 🟡 P1-1 · push_status 三态枚举缺"存量排除"态,与"首次接通存量不推"铁律字段级不兼容

**问题**:articles.push_status 只有 `none`/`pushed`/`failed` 三态(line 174)。🔴 push 记忆铁律要求"首次接通存量不推"——push 功能上线那一刻,所有已存在的历史文章都不能被推送。但这些文章的状态既不是"pushed"也不是"failed",按现有定义只能落进 `none`,而 `none` 的字面语义是"还没推,以后有机会该推"。二期任何"push_status=none 就纳入待推送候选"的自动化逻辑,上线当天就会把全部历史存量一次性推给用户——正是这条铁律要禁止的场景。

**证据**:
- 计划书 line 174:`push_status TEXT DEFAULT 'none'` 三态定义
- 计划书 line 330(二期清单):"注意 push 记忆:同 url 多 token 合并一条 + **首次接通存量不推**"——铁律本身在计划书里被提及,但没有落到字段设计上

**建议修改文段**(line 174 改为):
> `push_status TEXT DEFAULT 'none', -- none(未推·新文章候选)/ pushed / failed / excluded_backlog(存量·按铁律不推,push 上线时一次性回填)`
>
> 二期 push 上线时执行一次性回填:`UPDATE articles SET push_status='excluded_backlog' WHERE crawled_at < '<push上线时刻>' AND push_status='none';` —— 用数据一次性圈定"存量"边界,不依赖后续代码逻辑记住"要过滤存量"这种容易遗忘的隐性规则。这个字段建议**现在**(一期定 schema 时)就加上,避免二期再做一次表结构迁移+回填脚本。

---

### 🟡 P1-2 · 合并推送(同 url 多 token 一次推送)回写粒度未指定

**问题**:articles 的 PRIMARY KEY 是 `(url, token_id)`,push_status 按每一行独立存储。但 push 记忆铁律要求"同 url 多 token 合并一条带全 token list"推送,即一次推送覆盖 N 个 token。回写时,是 `UPDATE articles SET push_status=... WHERE url=?`(该 url 下所有姊妹行同步更新)还是 `WHERE url=? AND token_id=?`(可能出现"同一次合并推送,3 行里只有触发的那一行被标记 pushed,另外 2 行还是 none")?计划书没写,二期实现时容易两种理解各写一半。

**证据**:计划书 line 176 注释"1-to-N 共享博客兼容(push 记忆:同 url 多 token 合法)"、line 330 二期提醒引用同一条铁律,但两处都只提到"要兼容",没提回写 SQL 的 WHERE 范围。

**建议修改文段**(在 line 330 二期清单该句后追加):
> push 回写建议 `UPDATE articles SET push_status=?, pushed_at=? WHERE url=?`(不加 `AND token_id=?`),让共享同一 url 的所有 token 行状态保持一致,契合"合并一条推送"的语义。若未来出现"同 url 但部分 token 需要单独退订不推"的例外场景,再加字段区分,一期/二期设计阶段不必预留。

---

### 🟡 P1-3 · 634 源实时 join 缺索引规划,与项目自己既有惯例相悖

**问题**:计划书 `§4` 全部新表(runs/source_runs/articles/alerts/crawl_errors/push_runs)**零 CREATE INDEX 语句**。但 `GET /api/sources`(line 294)明确是"实时表(join registry+近 N 轮聚合:最后出文时间/近7天新增/失败率/open 告警/disposition)",博文管理页(line 306)要支持标题/正文/博客/管线/push/发布时间范围/采集时间范围的组合筛选+排序——这些查询模式都比现有 `sources` 表复杂得多,而现有 `sources` 表(`src/registry/schema.sql`)反而配了 4 个索引(`idx_sources_blog_url`/`fetch_strategy`/`host_platform`/`og_quality`)。新表查询更重却不规划索引,是明显的对照倒退。mockup-ops-b.html line 181 的示例数据已经是"5,944 篇"量级,且服务器只有 2c4G(计划书 line 350),账本写入还要求"不与采集抢 IO"——不加索引的全表扫描会在数据量增长后逐渐拖慢 dashboard,且和"不抢 IO"的原则本身冲突(未加索引的扫描一样吃 CPU/磁盘)。

**证据**:计划书 `§4`(line 129-208)全文无 `CREATE INDEX`;`src/registry/schema.sql`(line 29-32)对照组有 4 个索引;计划书 line 294、line 306、line 350

**建议修改文段**(在 `§4` schema 代码块末尾追加):
> ```sql
> CREATE INDEX IF NOT EXISTS idx_articles_token_crawled ON articles(token_id, crawled_at);
> CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published_at);
> CREATE INDEX IF NOT EXISTS idx_articles_push ON articles(push_status);
> CREATE INDEX IF NOT EXISTS idx_source_runs_token ON source_runs(token_id, run_id);
> CREATE INDEX IF NOT EXISTS idx_alerts_token_status ON alerts(token_id, status);
> CREATE INDEX IF NOT EXISTS idx_crawl_errors_run ON crawl_errors(run_id);
> CREATE INDEX IF NOT EXISTS idx_crawl_errors_kind ON crawl_errors(kind);
> ```
> 另外,`/api/sources` 的"近7天新增"建议直接从 `source_runs.items_added` 按时间窗口求和(该表远小于 articles 且已按 token_id 可聚合),不必扫 articles 全表;"最后出文时间"如果 detector 每轮批次都要为全部 634 源算一次,建议改成批末物化写回(例如给 sources 表加 `last_article_at` 列,run-batch 批末一并 UPDATE),而不是每次 API 请求都实时 join 聚合。

---

### 🟡 P1-4 · 字段质量筛选(不只是展示)未列入博文管理页筛选维度

**问题**:handoff `§4` 第 8 点(报告铁律)明确静态报告有"字段齐全度筛选"能力,用来批量定位"哪些源缺 pub/缺 desc,该修抽取规则了"——这是团队日常排查问题依赖的功能(呼应"主动发现问题"铁律)。mockup-ops-b.html line 181 确认博文管理页详情面板会**展示**"字段质量"(点标题→正文预览/字段质量/原文链接),但计划书 line 306 的筛选维度列表与 mockup line 166-172 的筛选控件/表头都**没有把字段齐全度作为筛选条件**——也就是说新页面能"点开单篇看质量",不能"批量筛出所有缺 desc 的文章"。对 634 源、数千篇文章的规模,"一条条点开看"不现实,新页面在这个维度上是对静态报告能力的部分倒退。

**证据**:handoff line 81("字段齐全度筛选");计划书 line 306(筛选维度清单无字段质量);mockup-ops-b.html line 166-172(筛选控件/表头无字段质量列),line 181(仅详情面板提字段质量)

**建议修改文段**(line 306 筛选维度清单追加一项):
> ...· push 状态(未推/已推/失败)· **字段完整度(全/缺title/缺desc/缺pub)** · 发布时间范围 · 采集时间范围...

对应查询只是 `WHERE title IS NULL OR description IS NULL OR published_at IS NULL` 的组合,成本很低。

---

### 🟡 P1-5 · 1-to-N(同 url 多 token)在博文管理页的展示语义未定义

**问题**:计划书 line 176 注释点出了 1-to-N 场景存在("1-to-N 共享博客兼容"),但完全没写博文管理页怎么展示。查 mockup-ops-b.html(布局基准,老板已拍板按它实现)line 172 表头是"标题|博客|管线|发布时间|采集时间|push",逐行单文章设计,全文 grep 未见任何"共享/shared/×N"相关的列或标识。这意味着同一篇文章对应 3 个 token 时,页面会原样显示 3 行一模一样的标题+时间,用户第一反应会以为是"抓重复了的 bug",而不是"一稿多 token"的正常形态——尤其 push 状态按 (url, token_id) 独立记录,3 行还可能显示不同推送状态(A 已推、B 未推),更容易被误读成数据错误。

**证据**:计划书 line 176;mockup-ops-b.html line 172(表头设计)、全文 grep 无共享标识相关内容

**建议修改文段**(line 306 后加一段):
> **1-to-N 展示**:不做 GROUP BY url 合并成一行(会掩盖每个 token 独立 push 状态这一必要信息),保留逐行展示,但:① `GET /api/articles` 每行附加 `shared_count`(同 url 有多少个 token,`COUNT(*) OVER (PARTITION BY url)` 窗口函数,SQLite 3.25+ 原生支持);② 标题列若 `shared_count>1`,加"共享×N" badge,点开可看其余 token 列表——避免被误读成重复 bug。

---

### 🟢 P2-1 · articles 无保留期策略,需明确是否为有意的资产化设计

**问题**:crawl_errors 明确"按 run 保留 30 天"(line 190),但 runs/source_runs/articles/alerts 都没有任何保留期/清理策略。结合 line 61"dataset 被 reset 清掉后 articles 成为唯一历史"的定位,这大概率是有意为之——articles 就该是永久资产,不像 crawl_errors 是短期诊断数据。但计划书没有一句话明说"这是有意不清理",容易被执行 Claude 误以为遗漏而自作主张加清理逻辑,或者反过来被误以为"跟 crawl_errors 一样该清"而定期误删历史。

**证据**:计划书 line 190(crawl_errors 30 天保留)vs runs/source_runs/articles/alerts 全无对应说明;line 61(articles 承担历史资产角色)

**建议修改文段**(§4 开头补一句):
> runs/source_runs/articles/alerts 均为**永久保留**(资产化历史设计,不同于 crawl_errors 30 天诊断留存);增长量级由索引/FTS(见 P1-3/P0-3)兜底,不做定期清理。

---

### 🟢 P2-2 · base_symbol 快照字段在品牌迁移后与 registry 脱节

**问题**:source_runs/articles/alerts/crawl_errors 四张表都各自冗余存了一份 `base_symbol`(为避免每次查询 join registry,可以理解),但这是插入时的快照值。handoff `§4` 第 2 点本身就有实锤先例:POKT 品牌改名迁移到 pocket.network。如果这类改名以后再发生,registry(sources 表)里的 base_symbol 更新了,但历史行的 base_symbol 不会跟着变——"博文管理页按博客名筛选"用新名字搜不到改名前的旧文章。这是可接受的常见 trade-off(token_id 才是稳定身份),但计划书完全没提这一点。

**证据**:handoff line 45(POKT→pocket.network 实锤);计划书 line 150、168、182、195(四张表各自的 base_symbol 冗余列)

**建议修改文段**(§4 开头补一句):
> `base_symbol` 为写入时快照,若源发生改名,历史行不回溯更新;精确检索以 `token_id` 为准,`base_symbol` 仅作展示与模糊搜索的辅助索引。

---

## 需要老板拍板的点

| # | 决策点 | 选项 | 关联问题 |
|---|---|---|---|
| 1 | "正文关键词"搜索到底要不要覆盖真正文 | A 诚实降级(改文案为"标题/摘要") / B 扩大摘要截断长度 / C 上 FTS5 真全文检索 | P0-3 |
| 2 | 手动裸跑 main.ts 今后怎么处理 | A 一律弃用,所有采集(含调试)都走 run-batch.ts / B 保留裸跑作为纯调试选项,但明确写清楚"不进 articles,数据会与 dashboard 不一致" | P0-4 |
| 3 | 1-to-N 共享博客要不要在 UI 上加"共享×N"标识 | mockup-ops-b.html(已拍板的布局基准)没画这个细节,是否需要在既定布局上小补一笔 | P1-5 |

---

*审计人:方案审计员 A2 · 审计维度:博客/博文数据模型 · 未修改任何文件 · 未访问网络*
