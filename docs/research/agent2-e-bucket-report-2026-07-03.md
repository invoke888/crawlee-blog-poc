# E 桶(正文有日期文本 · meta/json-ld 全无)日期抽取规则研究报告

- 母体:107 源(feature-scan.json → pub_buckets.E_body_text)
- 样本:44 源(分层抽样:全部 x.com/root/resources/news/other 边缘路径 39 源 + blog 路径随机 12 源,因 107 源 blog_url 域名本身各不相同,任意子集都天然域名多样)
- 方法:SSH 拉 raw-html 备份(每源最多抓 5 个文件精读 + 全量备份跑轻量正则复核),用 Python HTMLParser 做行号级 DOM 位置追踪,人工复核全部 44 源的判定
- 补充需求(误报源真值位置):对照 /tmp/false-positive-scan.json 的 title/desc 误报清单,核对样本重叠的 8 源

---

## 一、最重要的发现(先说结论)

**E 桶里三分之二的源,采到的 raw-html 备份里根本没有一篇真文章。** 44 个样本里,29 个(66%)的全部备份(不只是抽检的 5 个,是该源保存的全部 raw-html)都是导航页/法务页/产品页/活动页,没有任何一篇是"标题+正文+日期"结构完整的博客文章。这不是"日期难抽"的问题,是"压根没抓到文章"的问题——日期抽取规则做得再好也救不了这部分,需要先解决抓取范围(sample_urls / enqueue 逻辑),再谈日期规则。

**第二重要发现:44 个样本里 28 个(64%)是 Framer 或 Webflow 建站,文档开头 300 字符内必有一条 `<!-- Published <时间戳> -->` 部署时间戳注释,时间戳等于"该页面最后一次构建/发布"而非任何文章的发布日。** 这是目前观察到的头号误报陷阱,若实现时用"正文任意位置正则找日期"且没有过滤 HTML 注释,几乎必中这个陷阱。经交叉验证,样本中至少 5 源(BRL1、USDG、H、G、PAXG)的"正文有日期文本"信号,刨除这条注释后**荡然无存**——即这 5 源大概率是被这条注释拖进 E 桶的误判,而非真的正文有日期。

**第三重要发现:即便找到真文章,也有多种"看起来像日期但不是本文发布日"的陷阱**(相关文章推荐卡片日期、活动/会议日期、法务文档生效日、冻结不更新的模板文案、footer copyright)。详见第三节陷阱清单。

---

## 二、按源分类(44 样本)

### 分类 A:通用启发式可救(High confidence · 有真文章 + 干净日期信号)

| sym | token_id | blog_url | 命中方式 | 日期样例 | 选择器/规则 |
|---|---|---|---|---|---|
| A (Vaulta) | 17 | vaulta.com/resources | `<time>` 标签,off_h1=0 | "Oct 1, 2025" | `time` 标签,卡片内紧邻标题 |
| VANA | 11348 | vana.org/post | class 命中 date,off_h1=0,5/5 样本一致 | "May 15, 2025" | `.article-date-wrap` |
| USAT | 1005 | blog.usat.io | class 命中 date,8/9 样本一致,WordPress | "18 February 2026" | `.post-date`(同一日期在正文首段也复读一次,双重校验方便) |
| CVC (Civic) | 437 | civic.com/news | `<time>` 标签 / class,/field-notes 页面 4 条不同日期 | "July 2, 2026" | `time.text-xs.text-muted`(注意:field-notes 疑似 feed 页,需确认是否有独立文章 URL) |

**通用启发式(伪代码)**:
```
strip_html_comments(doc)          # 第一步必做,见陷阱①
strip_script_style(doc)

anchor = first_match(['h1', '[class*="article-title"]', '[class*="post-title"]',
                       '[class*="entry-title"]', '[class*="blog-detail-title"]'])
reject anchor if text matches /^(blog|news|other blog posts|all articles|page not found)$/i   # 见陷阱⑤

candidates = search_near(anchor, max_dom_distance=6,
                          exclude_ancestors=['footer','aside',
                                              '[class*=related]','[class*=sidebar]',
                                              '[class*=recent]','[class*=card]','[class*=list-item]'])

date = pick_first(candidates, priority=[
    1. <time datetime="..."> 有 datetime 属性,
    2. <time> 无属性但标签本身,
    3. class 命中 /date|publish|byline|timestamp|post-?info|entry-?info|posted-?on|post-?meta|article-?meta|post-?time|blog-detail-time/i,
    4. 紧跟锚点后第一段文本里 "日期 + min read"/"字样" 相邻模式(见陷阱⑥ BNB 案例),
    5. 锚点后第一处正则命中的纯文本(兜底,风险最高,建议只在前 4 层都空时才用,且需过 Step 3 校验)
])

# Step 3 二次校验,任一命中则丢弃、返回"抽取失败"而非硬凑错误日期
reject date if:
    - date == 抓取当天日期(±1天)  # 陷阱①②通用检测
    - date 在同源其它不相关页面 100% 复读  # 陷阱④
    - date 命中容器带 card/related/list-item/sidebar 类名  # 陷阱③
    - date 落在 footer 内
```

**验证数据**(基于 528 条原始正则命中的结构化画像,详见第四节):加 DATECLASS/TIME-tag 过滤后命中 55+47=102 条候选,其中人工复核确认为"文章自身发布日"的约一半(VANA/USAT/A/CVC 四源共 ~20 条命中,基本干净);另一半是陷阱③④(相关文章卡片、冻结模板)混入,说明**仅靠 class 名命中还不够,必须叠加 Step 3 的"跨页复读检测"**。

---

### 分类 B:需要单独规则(有真文章,但需站点专属 selector 或正则扩展)

| sym | token_id | blog_url | 问题 | 具体规则 |
|---|---|---|---|---|
| PHAROS | 7358 | pharos.xyz/resources | Webflow 站不用 `<h1>`,标题用 `<div class="blog-detail-title">`,h1-锚点策略在此完全失效 | 直接用 `.blog-detail-time`(紧跟 `.blog-detail-title` 之后的兄弟 div),不依赖 h1 |
| BNB | 95 | bnbchain.org/en/blog | 真文章日期格式是 `2025.2.10`(年.月.日,不补零),现有 `\d{1,2}\.\d{1,2}\.\d{2,4}` 正则漏抓;定位在 h1 紧后 + "N min read" 相邻 | 正则加一条 `\d{4}\.\d{1,2}\.\d{1,2}`;或用"紧跟 h1 后第一段 + 含 'min read'"做定位 |
| ERA (Caldera) | 361 | caldera.xyz/blog | h1 是"Other blog posts"(推荐区通栏标题,不是文章标题),h1-锚点策略会找错容器;但 9/9 样本 100% 命中日期,`<title>`/`og:title` 本身逐篇正确 | 锚点改用 `<title>`/`og:title` 而不是 h1;日期在 Framer 生成 class(如 `framer-jkamv2`,构建时哈希、不同站点/不同构建会变,不能跨源复用具体 class 名,只能用"离 title 锚点最近的日期文本"这种相对定位) |
| GRASS | 731 | grass.io/learn | 3 篇 `/learn/` 文章都命中同一天 "December 23 2025",无 date 类名提示,疑似非独立发布日(需人工复核这 3 篇是否真是同天发的,或者是某个共享组件的固定文案) | 中等置信度,建议先跑"同源多篇日期是否 100% 复读"校验,复读则判定不可信 |
| SKR (Solana Mobile) | 942 | blog.solanamobile.com | 仅 1/10 样本是真文章,日期只在正文首段散文里出现("March 2, 2026"),无结构化标记 | 弱证据,置信度低,建议多采样确认后再定规则 |

---

### 分类 C:无法可靠抽取(真文章确认存在,但日期信号在静态 HTML 里客观不存在)

| sym | token_id | blog_url | 根因 |
|---|---|---|---|
| RE (Resilience Foundation / blog.re.xyz) | 12894 | blog.re.xyz | Ghost CMS,主题显式设置 `.gh-post-meta { display: none !important; }`,把作者+日期栏位强制隐藏;全文无 `<time>`、无 `article:published_time` meta、无 JSON-LD(0 处)。正文唯一命中的日期文本("June 18, 2026" 等)全部来自页面底部"相关文章"推荐卡片(`.gh-card-wrapper`),是**其它文章**的日期,不是本文的。若采用"正文随便抓一个日期"策略会系统性抓错。次优兜底:Ghost 默认把配图传到 `content/images/size/.../{year}/{month}/...` 路径,年月与发文时间通常接近,可作精度到"月"的弱兜底,但非常规做法建议单独评估 |
| BRL1 | 11357 | brl1.io | 全部 10 个备份里,正文 0 处日期文本(含葡语月份名规则也测过,仍是 0),唯一命中来自 Framer 部署注释。这是"E 桶分类可能就是被注释误判"的 5 个实锤源之一 |

---

### 分类 D:非博客源 / 严重跑题(数据质量问题,不是日期规则问题)

| sym | token_id | blog_url | 问题 |
|---|---|---|---|
| 我踏马来了 | 1648 | x.com/i/communities/2006728550356050179 | blog_url 本身是一个 X(推特)社区页,13 个备份里全是 X 的服务条款页/陌生人个人主页(如 @MollaSohaib、@Scarlet_Crypt),跟该项目的博客毫无关系 |
| PYUSD | 902 | paypal.com/.../pyusd/zh/blog | 58 个备份**没有一个**跟 PYUSD 或 crypto 相关,全是 PayPal 全站营销页(商业贷款、POS 系统、借记卡……),明显是 enqueue 逻辑顺着 PayPal 全站导航跑飞了。建议评估是否该整源放弃或收窄种子 URL |
| GOAT | 726 | goatchan.xyz/blog | 6 个备份里有 3 个是 X.com 陌生人个人主页(@NRv_gg、@gospelofgoatse、@punter_punts)+ 1 个 Jupiter 兑换页,同样是跑飞 |

---

### 分类 E:样本存疑,需要重抓真文章 URL 才能判断(30 源)

以下源的**全部**已保存备份(不只是抽检的 5 个)都不是文章页,现有数据无法判断日期规则,必须先拿到真实文章 URL 重新抓取:

XUSD(148)、ASTER(360)、LAYER(102)、AUDM(11354)、ARKM(78)、XPL(290)、AVAX(493,注:有 1 篇 og:type=article 的真文章但该篇正文搜不到日期,需更多样本)、DRIFT(663)、ICNT(747)、MEW(807)、TRIA(996)、XNO(1739,注:首页有 `.svelte-xxxx date` 命中,提示真文章可能有戏,值得优先重抓)、PEAQ(3593)、LINK/blog.chain.link(521,注:59 个备份全部来自 chain.link 产品页/教育词条页,没有一篇 blog.chain.link 真文章)、BABYDOGE(11356)、VINE(2592,仅 1 个备份)、KAVA(462)、USDG(2161)、CSPR(11360)、SOL(92)、H(737)、EPIC(216)、SAHARA(373)、STX(11319)、G(22,仅 1 个备份)、SONY(12970)、ZAMA(473)、METIS(515)、SXT(180)、PAXG(308)

**汇总**:A 类 4 源 + B 类 5 源 + C 类 2 源 + D 类 3 源 + E 类 30 源(含 AVAX)= 44

---

## 三、陷阱清单(给实现者)

| # | 陷阱 | 案例 | 识别特征 | 应对 |
|---|---|---|---|---|
| ① | **Framer/Webflow 部署时间戳注释** | 28/44 源命中,BRL1/USDG/H/G/PAXG 100% 只有这一条 | `<!doctype html>` 后 300 字符内的 `<!-- Published ... -->` / `<!-- Published: ... GMT+0000 -->` | 取词前必须先剥离 HTML 注释(`<!--.*?-->`),否则正则会把它当正文 |
| ② | **抓取当天日期 / "今天"戳** | Sahara/Paxos/USDG/EpicChain 多篇不相关页面显示同一个接近抓取日的日期 | 值本身就是①注释的另一种表现(Framer/Webflow 站点发布戳恰好等于最近一次构建时间);也可能来自 JS 实时时钟/倒计时组件被静态快照冻结 | 日期 == 抓取当天 ±1 天,且该页面内容与"今天"无逻辑关联时,判定为噪声 |
| ③ | **相关文章推荐卡片日期 ≠ 本文日期** | RE(blog.re.xyz)本文日期被 CSS 隐藏,唯一能搜到的日期全部来自页尾"相关文章"卡片,是别的文章的日期;LINK 的教育词条页同理 | 命中容器带 `card`/`related`/`recent`/`more-post`/`sidebar`/`list-item` 类名,或祖先是 `<aside>` | 命中这些容器一律排除,不作为候选 |
| ④ | **冻结/复用的模板文案** | DRIFT 两个完全不同的活动页,`class="last-updated-date"` 里的值一字不差都是 "Last updated: Jan 15, 2023 at 1:00am UTC"(明显是被克隆的 Webflow 组件,从没更新过);GRASS 三篇不同文章日期也完全一致(存疑,未定性) | class 名字面上带 date/updated,但值在同源多个不相关页面 100% 一致 | 即使 class 名命中"date"关键词,仍要过"跨页复读"校验:同一值出现在 ≥2 个内容明显不同的页面上,判定不可信 |
| ⑤ | **h1 是导航型假标题,不是文章标题** | ERA(caldera.xyz):真实文章页的 `<h1>` 固定写死是"Other blog posts"(底部推荐区通栏标题),不是本文标题;EPIC 的"All Articles"同理是列表页 h1 | h1 文本命中 `/^(blog|news|other blog posts|all articles|page not found)$/i` 等通用导航词 | 锚点匹配前加黑名单过滤;h1 不可用时退化到 `<title>`/`og:title`(需先确认 title 本身不是站级复读,见第五节) |
| ⑥ | **无补零 Y.M.D 格式漏抓** | BNB 真文章日期是 `2025.2.10`(年.月.日,月/日不补零),常见 `\d{1,2}\.\d{1,2}\.\d{2,4}` 正则(D.M.Y/M.D.Y 假设)漏抓 | 4 位数字开头的点分日期 | 正则加 `\d{4}\.\d{1,2}\.\d{1,2}` 分支 |
| ⑦ | **版本号误伤日期正则** | AVAX 的 "2024.11.0" 被 Y.M.D 正则误判成日期(实为版本号/产品迭代号) | 月份或日期段超出 1-12 / 1-31 范围,或"日"字段是个位数但看起来像版本号第三段 | Y.M.D 正则要校验数值范围(月 1-12,日 1-31),不能纯位数匹配 |
| ⑧ | **法务文档生效日 ≠ 文章发布日** | 大量样本(XUSD、AUDM、GRASS、EPIC、SXT、SONY 等)唯一能找到的"日期"来自 Privacy Policy / Terms 页面的"Effective Date",不是博客文章 | 页面 canonical 路径含 `privacy`/`terms`/`cookie`/`compensation-policy` 等词 | 这类页面本身不该进入"文章"候选池,应在选 URL 阶段就过滤掉 |
| ⑨ | **活动/会议日期 ≠ 页面发布日期** | SOL(solana.com/news)样本页大量是"Solana Accelerate APAC/February 11/Hong Kong"这类活动预告页,里面的日期是**活动举办日**,跟这个页面本身发布时间无关 | 上下文含 Event/Accelerate/Conference/Agenda 等词 | 语义上要区分"事件日期"与"发布日期",不能捞到日期就当发布日 |
| ⑩ | **相对时间格式("3 days ago")** | 样本中命中较少(仅 GOAT/1648 等 x.com 页面里见到 "yesterday"),但 x.com/推特类内容本身就该被判定为非博客源排除 | `\d+\s+(days?\|hours?\|...)\s+ago` / yesterday / just now | 需要"抓取时间"才能换算成绝对日期,若抓取时间未记录则该文本不可用;优先级应低于绝对日期格式 |

---

## 四、命中率/误报率(基于结构化扫描的原始数据)

对 44 源共 ~200 个 HTML 文件跑正则(月份长/短名、ISO、点分、斜杠、相对时间等 9 种模式),原始命中 528 条正文日期候选文本,分布:

| 类型 | 命中数 |
|---|---|
| 短月份名 + 日 + 年(如 "Oct 1, 2025") | 197 |
| 长月份名 + 日 + 年(如 "October 1, 2025") | 152 |
| copyright(© 年份) | 100 |
| 仅"月份 + 年"(如 "September 2025") | 60 |
| 日 + 长月份名 + 年(如 "1 November 2024") | 14 |
| 斜杠日期 | 2 |
| 相对时间词(yesterday 等) | 2 |
| 点分日期 | 1 |

对这 528 条按 DOM 上下文打标:

| 标记 | 命中数 | 说明 |
|---|---|---|
| 命中 date/publish/byline 等关键词 class | 55 | 但其中一部分是陷阱④(冻结模板)误伤,需要再过跨页复读校验 |
| 位于 `<time>` 标签内 | 47 | 相对可信,但 Framer/Webflow 站点 `<time>` 使用率不高 |
| 位于 footer | 46 | 应直接排除(copyright 或法务日期) |
| 位于 list/card/related 容器 | 66 | 应直接排除(陷阱③) |
| 都不命中(纯文本裸日期) | 323 | 风险最高,包含真文章正文提及的历史日期、活动日期、Framer 注释误入(未剥注释前)等混杂情况,兜底策略前必须先过 Step 3 校验 |

**结论**:仅按"class 关键词 + `<time>` 标签"两条一次性过滤,能覆盖 102/528(19%)候选,但这 102 条里仍混有陷阱④(DRIFT 冻结戳命中了"date"关键词);其余 81% 候选文本如果不做容器排除 + 跨页复读校验,误报率会非常高。**建议把 Step 3(跨页复读检测 + 抓取日排除 + 容器黑名单)当作强制步骤,而不是可选优化。**

---

## 五、误报源真值位置(老板补充需求)

对照服务器 `/tmp/false-positive-scan.json`(25 个 title 误报源 + 36 个 desc 误报源,按同源重复度检测),本次 44 样本与其重叠 8 源,逐一确认真值实际落点:

| sym | 误报类型 | 误报证据(复读值) | 真值实际位置 | 备注 |
|---|---|---|---|---|
| **LAYER** | title+desc 双误报(10/10 同值) | title="Solayer \| Hardware-accelerated SVM";desc 同款产品介绍 | **无法确认** — 5 个抽检样本没有一个是真文章(隐私政策/生态页/用户协议),h1 全空,需先重抓真文章页才能判断 title/desc 真值落点 | Framer 站,10/10 备份日期文本只有部署注释 |
| **PHAROS** | title 误报(13/14 同值="Pharos") | 站级简称当标题 | 真标题在 `<div class="blog-detail-title">`(h1 标签根本不存在,h1_count=0);真日期紧邻 `<div class="blog-detail-time">` | canonical/og:title 多数样本也是 None,弱服务端渲染,只能靠正文 class 结构定位 |
| **MEW** | title+desc 双误报(3/3 同值) | title = og:description = "MEW - cat in a dogs world"(标题和描述被塞进同一句话,是本样本里最偷懒的一种误报实现) | 真标题在 `<h1>`(Gifs / Shorts / Collabs,逐页不同);真 description **没有可靠来源**——该源 3 个页面都是分类 tab 页而非长文,正文没有独立摘要段落可提取 | |
| **BRL1** | title+desc 双误报(10/10 同值) | title="BRL1 - A stablecoin que reinventa..."；desc 同款品牌介绍句 | 真标题在 `<h1>`(逐篇不同,如"Consórcio de exchanges forma a 'Tether brasileira'...");真 description **没有任何可靠来源** — 10 个备份正文 0 处日期文本(含葡语月份名规则也测过),该源本身就是"E 桶疑似误判"名单里的一个 | 同时印证:title/desc 双误报 + pub 完全无法提取,三者经常同源共现(建站模板越"套壳",三类信息越容易一起沦为站级复读) |
| **RE** | 仅 og:title 误报(10/10 同值="Resilience Foundation") | og:title 被设成站名而非文章标题 | 真标题其实在**原生 `<title>` 标签**(逐篇不同、内容正确,如"Why Governance Exists at Re")和 `<h1 class="gh-article-title">`,两者互相印证可信;真 description 在 `<meta name="description">`(逐篇不同、正确),不在 og:description(该源 og:description 是空字符串) | **反向案例**:如果实现里"优先信 og:title 而不是 `<title>`"(常见做法),对这个源反而会取到错的站名;应该做"og:title 与 title/h1 差异过大时,改信 title/h1"的兜底判断。该源日期仍不可提取(CSS 隐藏,见分类 C) |
| **ASTER** | 仅 desc 误报(10/10 同值) | og:description/meta description 都是同一句品牌广告词 | title/og:title 本身逐页正确(未误报,不需要兜底);description 真值**无法确认**——10 个样本没一个是真正的 announcement 文章 | |
| **ERA** | 仅 desc 误报(9/9 同值) | desc="Caldera is a network of interconnected, purpose-built blockchains..." | title/og:title 本身逐篇正确可信(未误报!可直接当标题用);**但 h1 是陷阱**,固定写死"Other blog posts",千万别用 h1 当标题锚点;description 真值目前样本里没找到独立落点 | 这是本次样本里"标题该信谁"最典型的教学案例:og:description 复读、h1 是假标题、只有 `<title>`/`og:title` 才是真值 |
| **METIS** | 仅 desc 误报(10/10 同值) | desc="Making blockchain accessible + affordable + adaptable" | title/h1 本身可信(逐页不同且对应实际页面内容);但 10 个样本没一个是 `/blog/` 文章,description 真值**无法确认** | |

**规律总结**:
1. **desc 误报比 title 误报更常见**(样本里 6/8 有 desc 误报,只有 3/8 有 title 误报)——很多站点标题逐页认真写,但 meta description 是站长偷懒复用同一句品牌介绍。
2. **og:title 和 `<title>` 可能不一致**,RE 是典型反例:og:title 复读站名,`<title>` 却逐篇正确。实现时不能默认"两者等价,任选其一",建议两者都取,不一致时以 `<title>`/h1 为准。
3. **真值兜底优先级建议**:标题 → `<title>` 标签 / `<h1>`(需过陷阱⑤黑名单)优先于 og:title;描述 → `meta[name=description]` 优先于 og:description(RE 案例里 og:description 是空的,meta description 是对的);两者都拿不到真值时,如实报告"无法确认"而不是硬用站级复读值。
4. **desc 误报和"没有真文章样本"经常同时出现**(LAYER/ASTER/METIS 三源均如此)——不是先有 desc 误报才导致没文章,而是两者共同的根因都是"根本没抽到真实文章页",这再次印证第一节的核心发现。

---

## 六、给实现者的注意事项(总结)

1. **取词前必须剥离 HTML 注释**(`<!--.*?-->`),否则 Framer/Webflow 的部署时间戳注释几乎必中,这是目前样本里最大宗的误报来源(28/44 源命中,5/44 源 100% 只有这一条)。
2. **"class 名带 date"不等于"值可信"**——必须叠加跨页复读检测(同值在 ≥2 个内容不同的页面上出现 = 判定为冻结模板/站级戳,丢弃)。
3. **h1 不一定是文章标题**,可能是列表页/推荐区的通栏标题(ERA/EPIC 案例);标题锚点要有导航词黑名单,失败时退化到 `<title>`(不是 og:title,见第五节 RE 案例)。
4. **相关文章推荐卡片、活动预告、法务文档生效日** 都会产出"合法格式但语义不对"的日期,必须靠容器 class(card/related/sidebar)和页面语义(privacy/terms/event)排除,不能只看格式。
5. **抽不到日期时应如实返回"失败"**,不要用兜底正则硬凑一个错误日期——本次样本里 RE、BRL1 两源就是"有真文章但客观没有可提取日期"的实例,如果强行兜底会引入静默错误数据。
6. **在动手写日期规则之前,建议先解决抓取范围问题**:66%(29/44)的 E 桶样本源,现有备份里一篇真文章都没有,这部分不管日期规则多完善都救不了,应优先排查这些源的 sample_urls/enqueue 逻辑,补抓到真实文章 URL 后再验证日期规则是否有效。
7. **重点关注的"值得优先重抓"名单**(有蛛丝马迹提示真文章可能存在,值得先花力气拿到真 URL 再验证):XNO(nano.org,首页已见 `.svelte-xxxx date` 命中)、AVAX(已有 og:type=article 真文章,只是这一篇没日期,需要更多样本)、LINK(blog.chain.link 需要专门找 `/blog.chain.link/` 域下的文章 slug,而不是 chain.link 主站的产品/教育页)。

---

## 附:采样源清单(44 源 token_id/sym/blog_url)

见本地 `/tmp/e_sample_final.json`(SSH 拉取的原始 feature-scan.json 备份在 `/tmp/feature-scan.json`,false-positive 清单备份在 `/tmp/false-positive-scan.json`)。
