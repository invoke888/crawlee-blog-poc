# 三组疑难源判定报告

日期:2026-07-03 · 判定人:爬虫规则研究员(agent3)· 范围:只判定不改代码

## 〇、方法论说明

本次判定综合使用四份数据:
1. `/tmp/feature-scan.json` — 原始 pub/desc 缺失分桶 + 每源 sample_urls
2. `/tmp/false-positive-scan.json` — 老板追加的误报清单(fp_title 25 / fp_desc 36 / fp_pub 2)
3. **服务器 `storage/datasets/default/`(5547 条全量抓取记录)** — 按 sym 重建索引,拿到每源**全部**历史抓取 URL(不止 sample_urls 给的 1-3 条),用于判断"抓到的到底是不是文章"
4. **`storage/key_value_stores/raw-html/`**(备份 HTML)— 用 cheerio 重新解析,除了原有 og/meta 字段,新增提取 **h1 / JSON-LD(headline·description·datePublished)/ article 标签正文 / SPA 空壳特征**,并对同一 token 的多个 backup 做"跨文件是否变化"比对(常量 = 站级默认值假信号,变化 = 真信号)

关键方法修正:第一版空壳检测把 `<script>` 内联代码也算进"可见文本",导致 Next.js 大型 hydration 脚本把 SCR 误判为"有内容"。修正后(剔除 script/style/noscript 再统计),SCR 等站点的可见文本才正确归零,确认为真空壳。

对无备份的源,通过服务器代理池(`.env.local` 的 `PROXY_URL`)实时重抓 `blog_url` 验证当前状态。

---

## 一、F 桶 55 源判定(备份完全无日期信号)

**分类统计**

| 类别 | 数量 | 说明 |
|---|---|---|
| a. 非文章污染(landing/nav/目录/死链混入) | 39 | 抓到的 URL 根本不是文章 · LIST 发现层问题 |
| b. JS 渲染 - 需 Playwright | 8 | 静态 HTML 是空壳,剔除内联 JS 后可见文本≈0 |
| c. 真无日期 - 放弃(已用真实文章验证) | 3 | 确认是真文章内容,但 og/meta/jsonld/正文全部没有日期信号 |
| d. 真文章 - 有日期但 selector 缺口 | 4 | **不建议直接归入"放弃"** · 日期确实存在(JSON-LD 或正文 byline),现有抽取链缺这层兜底 |
| Twitter 判死 | 1 | x.com 社区页,静态抓取拿不到任何内容 |
| **合计** | **55** | |

**分类总表**

| # | sym | 判定类别 | 证据 |
|---|---|---|---|
| 1 | SCR | b.JS渲染-需Playwright | 8/8 backup 为空壳(id=root类SPA)· 剔除内联JS后可见文本=0字符 · scroll.io 是 Next.js/MUI 全客户端渲染站 |
| 2 | NEAR | a.非文章污染(landing/nav) | 11条记录全部是导航/客服页(Founder Hub/Cookie Policy/Developer Center/Contact Us)· 无一篇博客文章 · 内容真实但非article |
| 3 | BCH | d.真文章-有日期但selector缺口 | 真文章(59条,og_type=article类文章占多数)· 正文里有明确byline日期'by ... Team 07 June 2022'· 现有10个selector都不查纯文本byline · 建议加正文正则兜底 |
| 4 | HOT | a.非文章污染(landing/nav) | 6条记录是resources/product hub静态页 · holo.host本身无独立blog结构 |
| 5 | RLUSD | d.真文章-有日期但selector缺口 | 36条混合:多数为Ripple产品/团队介绍页(非文章)· 但真Insight文章正文里有清晰'Insight Author AvatarTeam RippleApril 30, 2026'byline模式(9个文件命中)· 现有selector抓不到纯文本byline |
| 6 | SFP | c.真无日期-放弃(已验证真文章) | 抽查2篇真/blog/文章(内容详实4768-10799字 非shell · h1为真标题)· og/meta/jsonld三层全空 · 正文regex也未命中真实发布日期 · 确认放弃 |
| 7 | BNT | a.非文章污染(landing/nav) | 仅2条记录,均为Medium风格导航页(People following Bancor/Bancor) |
| 8 | KAT | c.真无日期-放弃(已验证真文章) | 9条全部是/blog/真文章slug(交易大赛/质押/TGE公告等)· 内容详实6846-10212字 非shell · jsonld为空 · 仅1篇有'if you are reading this on March 18 2026'叙事性文本(非结构化发布日期)· 确认放弃 |
| 9 | BTC | a.非文章污染(landing/nav) | 10条全部是About Us页的10种语言版本(zh_CN/pt_BR/hi/uk/ar/da/it/sl/nl/bg)· 与blog完全无关 |
| 10 | ANKR | a.非文章污染(landing/nav) | 10条多为case studies常青介绍页(Flow/Chiliz/Meta Apes/Mantle/BNB)· 无发布日期概念 |
| 11 | PROM | a.非文章污染(landing/nav) | 7条为Privacy Policy/Terms/Whitepaper法务页 · fp误报分析同源确认 |
| 12 | MOVE | a.非文章污染(landing/nav) | 9条多为nav/法务页 · 唯一og_type=article的是/guides/kast · jsonld类型为HowTo(教程类本身无发布日期,合理无bug) |
| 13 | ZRO | a.非文章污染(landing/nav) | 仅1条,Medium风格followers页 |
| 14 | MEGA | a.非文章污染(landing/nav) | 9条为品牌/法务/活动页(Brand Kit/Cookie/Mafia Apply)· fp分析确认这批页面本身非'文章'· 但各页h1/metaDescription确有独立值 |
| 15 | ADA | a.非文章污染(landing/nav) | 10条为Cardano生态应用目录条目('X on Cardano'模式)· 是应用名录不是文章 |
| 16 | ELF | a.非文章污染(landing/nav) | 4条为Developer Resources/Ecosystem/Platform导航页 |
| 17 | FIDA | b.JS渲染-需Playwright | 3条里2条为shell(空title+空壳)· Bonfida疑似客户端渲染 |
| 18 | HOME | a.非文章污染(landing/nav) | 仅1条,Medium风格followers页 |
| 19 | ALT | a.非文章污染(landing/nav) | 4条,Medium风格(AltLayer/People following AltLayer)· 3/4为shell |
| 20 | ORDI | a.非文章污染(landing/nav) | docs.ordinals.com是GitBook式技术文档手册非新闻博客 · 4条title虽不同(Inscriptions/Overview/Wallet)但本质是文档章节非'文章日期'概念 |
| 21 | RSR | a.非文章污染(landing/nav) | 仅2条,Medium风格followers页 |
| 22 | ASR | a.非文章污染(landing/nav) | 20条全部是AS罗马足球俱乐部票务/名单/赛程页(biglietti/rosa-e-staff/calendario)· 与文章无关 · 该blog_url疑似指错子站 |
| 23 | OPEN | a.非文章污染(landing/nav) | 5条为Openledger首页跳转变体 · fp分析确认 |
| 24 | HFT | a.非文章污染(landing/nav) | 仅1条,Medium风格followers页 |
| 25 | XAUT | a.非文章污染(landing/nav) | 20条全部是tether.to说明页(about-us/transparency/whitepaper等)· jsonld统一为WebSite类型站级简介,非文章schema |
| 26 | CYBER | a.非文章污染(landing/nav) | 5条为Stake/Bridge产品页,含1个404 |
| 27 | FIL | d.真文章-有日期但selector缺口 | '100 Days of FVM'为真文章 · JSON-LD显式BlogPosting类型 · datePublished=2023-06-22T16:17:19.831Z(精确ISO时间戳)· 现有pub selector链完全不查JSON-LD · 一行fallback即可修复 |
| 28 | BASED | d.真文章-有日期但selector缺口 | 'Introducing Based Research'为真文章 · JSON-LD显式BlogPosting类型 · datePublished=2026-06-05T00:00:00.000Z · 同FIL,现有链缺JSON-LD兜底 |
| 29 | CTC | a.非文章污染(landing/nav) | 8条为Creditcoin生态项目介绍页(CEIP/PenguinBase/Credit Wallet) |
| 30 | MOCA | a.非文章污染(landing/nav) | 4条为首页的4种语言版本(cn/en/tr/kr)· 与blog无关 |
| 31 | MOG | a.非文章污染(landing/nav) | 仅1条,'MOG Memes'单页meme站,无blog概念 |
| 32 | SQD | a.非文章污染(landing/nav) | 9条为产品/Case Studies目录页 · 目录卡片文本含日期但该页本身(jsonld仅Organization/WebSite/BreadcrumbList)无BlogPosting结构,日期非文章发布日期 |
| 33 | VVV | a.非文章污染(landing/nav) | 9条为FAQ/Bug Bounty/落地页(/lp/ai-chat等)· 无/blog/路径文章 |
| 34 | WEN | b.JS渲染-需Playwright | 仅2条且均为shell |
| 35 | ZORA | b.JS渲染-需Playwright | 10/10为shell(可见文本=0)· 且抓到/debug-ath-bar等内部调试路由,discovery异常 |
| 36 | 4 | b.JS渲染-需Playwright | 23条中12条shell · 命中的是X.com推文嵌入页(4meme.bnb on X/Shiba Army OG on X)· jsonld类型为SocialMediaPosting非BlogPosting |
| 37 | SLX | a.非文章污染(landing/nav) | 10条为Solstice Finance产品/代币页(strcUSX/stSLX/USX)· 'TGE: May 25 2026'是项目里程碑日期非文章日期 |
| 38 | ON | c.真无日期-放弃(已验证真文章) | 1条真文章(on-chain-vs-off-chain-transactions,22300字非shell)· jsonld/正文均无日期信号 · 确认放弃pub;顺带发现h1有真标题而title/og:title退化为站级slogan(标题层面的抽取bug,与pub无关,供参考)· 其余8条为nav页 |
| 39 | XCN | a.非文章污染(landing/nav) | 仅1条,Medium风格followers页 |
| 40 | BROCCOLIF3B | a.非文章污染(landing/nav) | 3条为holding/academy/ecosystem导航页 · article标签是WordPress主题通用包裹(3413~286万字符跨度极端)非真文章正文 · 真post(wp-sitemap里的)未被抓到 |
| 41 | 龙虾 | Twitter判死 | x.com社区成员列表页 · shell · 169字节空壳 · 应直接排除X.com类源 |
| 42 | CROSS | a.非文章污染(landing/nav) | 8条,Medium风格(topic筛选导航页+followers页)· 7/8 shell |
| 43 | LYN | b.JS渲染-需Playwright | 9条全部纯JS重定向壳:<script>window.onload=...location.href='/lander'</script> · 静态HTML仅114字节 |
| 44 | OPENAI | a.非文章污染(landing/nav) | 9条为PreStocks平台公司名录条目(Anthropic/Kalshi/xAI/Neuralink)· 是名录页非文章 |
| 45 | PIPPIN | a.非文章污染(landing/nav) | 4条为纯营销单页站分区(Token/Unicorn/Framework)· 无blog/文章概念,站点未配置任何desc/pub元数据 |
| 46 | USELESS | b.JS渲染-需Playwright | 7/7为shell · 可见文本=0 |
| 47 | AIO | a.非文章污染(landing/nav) | 3条为产品/订阅方案页(Nexus/AIO) |
| 48 | SPACE | a.非文章污染(landing/nav) | 3条为产品/Airdrop Portal页 |
| 49 | CAP | a.非文章污染(landing/nav) | 仅2条,tokenomics/capverse介绍页,title为空,站点无blog |
| 50 | QTUM | a.非文章污染(landing/nav) | 7条为Community/Developer导航页,含1个404 |
| 51 | ASTR | a.非文章污染(landing/nav) | 12条含blog首页本身('Blog | Astar'通用标题)+其余nav页,无具体文章 |
| 52 | AUDF | a.非文章污染(landing/nav) | 3条为Transparency/How It Works说明页非文章 · h1/metaDescription各页有独立值但og:title/og:desc是常量(fp分析确认) |
| 53 | M | a.非文章污染(landing/nav) | 3条为MemeCore首页跳转变体 · fp分析确认 |
| 54 | SPORTFUN | b.JS渲染-需Playwright | 4/4为shell · fp分析确认 |
| 55 | TWLO | a.非文章污染(landing/nav) | 10条为Twilio API文档页(Lookup-API/Verify-API)+404页+PDF转介页,DOM被大量导航图标文字污染 |

**d 类 4 源需要老板决策**(不是"真无日期",是"现有代码没查这个信号源"):

| sym | 真日期证据 | 缺口位置 |
|---|---|---|
| FIL | JSON-LD `BlogPosting.datePublished = 2023-06-22T16:17:19.831Z`(精确 ISO 时间戳) | pub 抽取链(article.ts 第 108-119 行)完全不查 `script[type=application/ld+json]`,只查 meta/time 标签 |
| BASED | JSON-LD `BlogPosting.datePublished = 2026-06-05T00:00:00.000Z` | 同上 |
| BCH | 正文 byline 纯文本 `by Bitcoin Cash Node Team 07 June 2022`(59 篇文章逐篇都有,格式统一) | pub 抽取链没有"正文纯文本日期"这层兜底(选中的 selector 都是标签属性,不扫可见文本) |
| RLUSD | 正文 byline 纯文本 `Insight Author AvatarTeam RippleApril 30, 2026`(9 个文件命中,日期各不相同,确认非噪音) | 同 BCH |

---

## 二、desc 疑难 17 源判定

**分类统计**

| 类别 | 数量 | sym |
|---|---|---|
| 页面差异(sample 恰好抽到分类/tag 页,真文章 desc 实际正常) | 3 | CHR、CHZ、EURI(其中 EURI 全部历史记录都非文章,单列见下) |
| 结构性(网站该字段本身留空,非抽取代码问题) | 2 | GODS、CORE |
| 结构性判死(纯文档站,非博客) | 2 | ORDI、GENIUS |
| 非文章污染 | 4 | XAUT、BROCCOLIF3B、BTC、CSPR |
| 真文章但 selector 抓不到(正文有内容,无 og/meta/article/jsonld 任何一层命中) | 1 | EUL |
| JS 渲染 - 需 Playwright | 2 | LYN(JS 重定向壳)、PHAROS(真链接可发现,但详情页正文是导航占位文本) |
| Twitter 判死 | 1 | 龙虾 |
| 结构性判死(纯营销单页站) | 1 | PIPPIN |
| 非文章污染/结构性(单页站) | 1 | CAP |
| **合计** | **17** | |

**逐源判定**

| sym | 分桶 | 判定 | 证据 |
|---|---|---|---|
| CHR | has_og | 页面差异 · 非 bug | sample_urls 给的 `/tag/updates/` 精确对应 hash `70cc124683d9543a`,该文件确实无 og:desc;其余 11/13 backup(真文章)og:desc 齐全且内容各异 |
| CHZ | has_og | 页面差异 · 非 bug | sample_urls 给的 3 个 URL(academy/announcements/chiliz-chain)hash 精确对应 3 个"无 og:desc"文件,全部是分类导航页;其余 37/43 真文章 og:desc 正常 |
| EURI | has_og | 非文章污染 | sample_urls 给的 `/tag/article/` 同样精确命中"无 desc"文件;但进一步查**全部 7 条历史记录**,无一条是真 news 文章(contact-us/whitepaper/privacy-policy/about-us 静态页),eurite.com/news 的 LIST 发现从未抓到过真文章 |
| GODS | has_og(桶本身误判) | 结构性,非抽取 bug | **18/18 backup 的 og:description content 全部是空字符串**(`<meta property="og:description" content=""/>`,标签存在但值为空)。has_og 桶的检测逻辑只判断"标签是否存在"未判断"content 是否非空",属于**检测方法本身的假阳性**。同时 og:title 确认有真值(如"Gods Unchained — Battle Pass Season 11"),18 条 URL 全部是真文章(newsletter/balance-update/battle-pass 等),站点用 Webflow 建站(`cdn.prod.website-files.com`),确认是网站侧没填 desc 字段,非我们代码问题 |
| CORE | has_og(桶本身误判) | 非文章污染 + 结构性 | 同 GODS,9/9 backup og:description 均为空字符串(Next.js 站,`data-next-head` 标记)。且**全部 10 条历史记录都是 /initiatives/ 生态项目介绍页**,不是 coredao.org 的博客文章 |
| ORDI | has_meta | 结构性判死 | docs.ordinals.com 是技术文档手册,无 og/meta/jsonld/article 任何一层信号(0/4 全空)。h1 固定为"Ordinal Theory Handbook"(文档侧栏品牌名常量),真正区分各页的是 `<title>` 标签(Inscriptions/Overview/Wallet 各不同),但站点从未设置 description 类字段 |
| XAUT | has_jsonld | 非文章污染 | 20/20 backup 的 JSON-LD 是统一的 `WebSite` 类型站级简介("The official home of Tether and USDT stablecoins."),不是文章 schema;历史全部 20 条记录都是 tether.to 说明页(about-us/transparency/faqs 等),从未抓到真文章 |
| EUL | has_article_tag | 真文章但 selector 缺口 | 14 条里 11 条是真 `/blog/xxx` 文章 slug,body 文本正文完整(4K-37K 字符,非空壳),但仅 4/14 命中 og/meta,0/14 有 article 标签或 jsonld。真内容确实渲染在静态 HTML 里,只是没被现有任何 selector(og/meta/article/jsonld 四层)覆盖到,需要"正文首 N 字"兜底才能救 |
| GENIUS | has_article_tag(桶名不副实) | 结构性判死 | docs.tradegenius.com 是纯技术文档站(spot-markets/account-set-up 等章节),10/10 backup 的 og/meta/jsonld/article 全部为空,不是博客 |
| BROCCOLIF3B | has_article_tag | 非文章污染 | 3 条记录(holding/academy/ecosystem)是导航页,article 标签存在但文本长度从 3413 到 286 万字符跨度离谱,是 WordPress 主题给所有页面类型通用包裹的 `<article>` 容器,不代表真文章正文;真正的 post(该源 blog_url 本身是 `wp-sitemap-posts-page-1.xml`)从未被抓到 |
| BTC | none | 非文章污染 | 10 条全部是 About Us 页的 10 种语言版本,与 blog 无关 |
| 龙虾 | none | Twitter 判死 | blog_url = `x.com/i/communities/.../members`,静态抓取仅 169 字节空壳,应直接排除 |
| LYN | none | JS 渲染 - 需 Playwright | **9/9 backup 全部是 114 字节的纯 JS 跳转壳**:`<script>window.onload=function(){window.location.href="/lander"}</script>`,静态抓取永远拿不到内容,是最干净的"需要 Playwright"证据 |
| PIPPIN | none | 结构性判死 | pippin.love 是纯营销单页站(index/unicorn/token/framework 四个 html 页面),站点从未配置任何 og/meta 字段,不是抽取问题 |
| CAP | none | 非文章污染/结构性 | 仅 2 条记录(tokenomics/capverse),title 为空,capnetwork.io 无 blog 结构 |
| PHAROS | none | JS 渲染 - 需 Playwright | 关键证据:26 个 backup 里抽 3 个已知真文章 URL(如 `/blog/realfi-made-real-pharos-2025-wrap-up`)核对,**"可见文本"虽有 6445-12389 字符,但内容全部是导航菜单文本重复**("Explore Ecosystem...Brand Kit...Blog & News...")而非文章正文,title 也退化成站名"Pharos"。说明该站 LIST 层能发现真文章链接(实测重抓 pharos.xyz/resources 首页拿到 13 条 /blog/ 真链接),但 DETAIL 页真内容需要客户端 JS 渲染才会出现,静态 HTML 只有导航壳 |
| CSPR | none | 非文章污染 | 10 条全部是顶层导航页(build/community/case-studies/newsletter 等),含 2 个 `/suspended/`(已废弃项目)页面,casper.network/news 从未被抓到真新闻 |

---

## 三、无备份 14 源判定

14 个 token 实际只对应 **6 个不同的 blog_url**(其余是同一 URL 被多个 sym/token 共享),代理池逐一实测:

| blog_url | 覆盖 sym | 实测结果 | 判定 |
|---|---|---|---|
| `https://sky.money/blog` | SKY | HTTP 200,10.4万字节,静态 HTML 里直接含 4 条真 `/blog/what-is-xxx` 文章链接 | **可救** · 建议下次抓取重试 |
| `https://www.pharos.xyz/resources` | PROS | HTTP 200,8万字节,静态 HTML 含 13 条真 `/blog/` 文章链接。且与 PHAROS(token 7358,同一 blog_url)共享站点,后者已有 26 份历史 backup 佐证可抓 | **可救** · 与 PHAROS 同站,只是这个 token_id 尚未跟上抓取节奏 |
| `https://www.chiliz.com/blog/` | PORTO、SANTOS、ACM | HTTP 200,47万字节,静态 HTML 含至少 6 条真文章链接(注意:文章 URL 在域名根目录,不带 /blog/ 前缀,如 `chiliz.com/spain-fan-token-to-launch...`) | **可救**(3 源同享一个判定) |
| `https://www.paxos.com/blog` | USDP | HTTP 200,43.7万字节,静态 HTML 含 4 条真 `/blog/xxx` 文章链接 | **可救** |
| `https://ondo.finance/blog` | EWZ、TSEM、ISRG、ALAB、TER、KLAC、LRCX | **HTTP 403**,响应头 `x-vercel-mitigated: deny`,响应体仅 "Forbidden"(59 字节)。重试一次结果一致 | **反爬判死** · Vercel 官方机器人防护(BotID/Attack Challenge)主动拒绝非浏览器请求,curl 级别的 UA 伪装无法绕过(需要真实浏览器指纹)。**7 源共享同一命运** |
| `https://blog.re.xyz/` | RE(token 12893) | HTTP 200,3.5万字节,静态 HTML 含真文章链接(june-performance-update/reusde-redemptions 等)。与 RE(token 12894,同一 blog_url)共享站点,后者已有 10 份历史 backup 佐证 | **可救** · 与姊妹 token 12894 同站,已证明可抓 |

**统计:7/14 可救(SKY/PROS/PORTO/SANTOS/ACM/USDP/RE),7/14 反爬判死(Ondo 系全部 7 个 ticker)。**

无备份的根因两极分化:6 个 URL 里 5 个此刻完全正常可抓(说明历史 no_backup 状态大概率是抓取当时的瞬时问题——限速/超时/该 token 未排进当次抓取批次,而非永久性障碍);唯有 ondo.finance 是真实、可复现的服务端主动拦截。

---

## 四、误报源(fp)判定 —— 老板追加需求

范围:`fp_title`(25 条 / 24 个 sym,含 1 条重复)+ `fp_desc`(36 sym)+ `fp_pub`(2 sym)去重后共 **40 个 sym**,其中 17 个与 F 桶/desc 桶/no_backup 重叠(BCH/MEGA/ORDI/MOCA/ZORA/CROSS/USELESS/AUDF/M/SPORTFUN/ALT/HOT/PROM/OPEN 与 F 桶重叠 · PHAROS 与 desc 桶重叠 · PROS/RE 与无备份重叠,判定已在上面各节标注),其余 23 个单独判定于此。

判定方法:对同一 token 的多份 backup,逐字段(title / h1 / og:title / og:desc / meta:desc / article 标签 / JSON-LD headline·desc·datePublished)统计"是否跨文件变化"——**变化 = 真信号,常量 = 站级默认值假信号**。并结合 article.ts 实际抽取优先级(已读源码确认):

```
title  = og:title  || h1 || <title>          （无 desc/article/jsonld 兜底）
desc   = og:desc    || meta:desc || ''        （无 article/jsonld 兜底,只有两层)
pub    = article:published_time || article:modified_time || meta[itemprop=date系] 
         || time[datetime系] || meta[name=date系]           （无 jsonld 兜底)
```

### 4.1 抽取 bug / 轻度问题(真值在页面里,选错了字段优先级)—— 10 源(7 个明确 bug + 3 个轻度基本正常)

| sym | 触发 | 真值在哪 | 证据 |
|---|---|---|---|
| BCH | title | `<h1>`/`<title>` 标签(49-50/59 篇不同)| og:title 100% 常量"Bitcoin Cash Node",但同一批 backup 里 h1/title 逐篇不同(如"BCHN v23.1.0版本发布公告") |
| XAN(Anoma) | title+desc | title→`<title>`标签(59/59 全变)· desc→`<article>`标签(51/59 变化) | og:title 常量(站级 slogan),h1 只有 24/59 覆盖率低于 title 标签的 59/59;article 标签内容 51/59 不同,og/meta desc 100% 常量 |
| MEGA | title+desc | title→h1(8/9 变)· desc→meta:description(9/9 全变!) | **meta:description 已经是完全正确的每页独立值**,但 og:description 优先级更高、只有 2 种取值,把正确的 meta:desc 覆盖掉了 |
| RE(blog.re.xyz) | title | h1/`<title>`标签(10/10 全变) | og:title 常量"Resilience Foundation"(基金会品牌名),h1/title/meta:desc/article 标签全部 10/10 完整变化,desc 字段本身走 meta:desc 已经正常(RE 不在 fp_desc 名单,交叉验证一致) |
| ORDI | title | `<title>`标签(4/4 变化) | og:title 不存在(0/4),h1 固定为"Ordinal Theory Handbook"(常量,是侧栏品牌名不是页面标题),导致 title 抽取链走到 h1 就停了,没有继续 fallback 到真正变化的 `<title>` 标签 |
| AUDF | title+desc | h1(3/3 变)+ meta:description(2/3 变) | og:title/og:desc 常量,h1、meta:description 各页有独立文本,但该站本身也没有真正的"文章"(是 Transparency/How It Works 说明页,不是新闻) |
| BRL1 | title | h1(10/10 全变) | og:title **和** `<title>`标签都是常量(连"最后一层 fallback"都救不了),只有 h1 逐页给出真实标题(如"Consórcio de exchanges forma a 'Tether brasileira'"),是本次样本里 title 三层 selector 全部失守、唯独 h1 保真的典型案例 |
| STABLE | 轻度 | 分页/分类页混入拉低统计,真文章本身抽取基本正常 | title/h1/desc 均有 5-10/10 变化,`/p/2` `/p/3` `/category/xxx` 等分页页占了小部分常量样本 |
| ZETA | 轻度 | 少量 category/terms 页混入,真文章基本正常 | title 7/10 变化,jsonld_date 5/10 有真实变化日期,仅 `/terms-of-use` 和 2 个 category 页拉低统计 |
| ZEN(Horizen) | 轻度/基本正常 | title/h1/og:desc 大部分已在正确工作 | title 10/10、h1 8/10、og:desc 8/10 均已有真实变化,jsonld_date 7/10 有真实变化日期。fp 报的"3/3 同 desc"样本量远小于我方 10 条全量记录,推测是命中了少量旧记录或分页页,不代表该源整体有问题 |

### 4.2 非文章污染(LIST 层抓错链接,不是抽取问题)—— 19 源(其中 ALT/CROSS/HOT/M/MOCA 与 F 桶重叠,已在第一节判定,此处并列展示)

| sym | 证据 |
|---|---|
| ALT、CROSS | blog_url 是 Medium 站,LIST 抓到的是 Medium 内部导航链接(`/followers?gi=...`、`/subpage/...`、`/all?topic=...`),不是文章 permalink |
| ASTER | asterdex.com/en/announcement 的 LIST 抓到整个交易 App 的导航(leaderboard/earn/stage0 等),不是公告文章 |
| BARD(Lombard) | 混合污染:18 条 backup 里既有真 `/blog/xxx` 文章(title 正常变化),也有 `docs.lombard.finance/*` 文档子域名页和 `/app/` 静态页混入,后者拉低整体统计;真文章本身抽取没问题,是 LIST 层跨子域名/跨类型抓取范围过宽 |
| ERA(Caldera) | 真文章(`/blog/xxx` slug,title 9/9 变化,抽取本身正常)· desc 常量是站点本身没给每篇设置 meta description,非 bug,结构性限制 |
| FOGO | 混合:部分真 `/blog/` 文章 + 部分产品页(`/fogo-sessions`)+ 1 个测试页(`/old/portfolio-test`)混入,LIST 发现范围过宽 |
| HOT | resources/product hub 静态页,非文章(与 F 桶结论一致) |
| IOTX | 10/10 是 iotex.io 顶级产品页(/chain /press /ioid),零真文章 |
| LAYER(Solayer) | 10/10 是 legal/产品页(/privacy-policy /ecosystem),h1 都不存在 |
| LIT(Lighter) | 产品页 + 1 个 404,无真文章 |
| M(MemeCore) | 首页多语言/跳转变体,非文章(与 F 桶结论一致) |
| METIS | 10/10 是顶部导航分类页(adopters/governance/community),技术上"每页不同"但都不是文章 |
| MEW | media 分类页(collabs/gifs/shorts),站点疑似无真正博客结构 |
| MNT(Mantle) | 顶部导航链接为主,另混入 1 条 `/blog/rss.xml`(文件型 URL 误当文章,需确认是否修复前旧记录) |
| MOCA | 首页多语言变体(与 F 桶结论一致) |
| PRCL(Parcl) | 产品页 + 1 个 404,无真文章 |
| SCRT(Secret Network) | 10/10 是顶层导航页(含 1 个 coming-soon-page),scrt.network/blog 从未抓到 /blog/ 路径下真文章 |
| SSV(ssv.network) | 10/10 是产品/法务页(incentivized-mainnet-terms/developers/get-funded)+ 1 个 404,技术上"每页不同"但都不是文章 |
| WET(HumidiFi) | 仅 3 条(litepaper/terms-of-use/tokenomics),blog_url 本身就是首页,该项目没有真正的 blog 结构 |

### 4.3 结构性 / 站点本身无该字段(非 bug)—— 2 源

| sym | 证据 |
|---|---|
| QUICK(QuickSwap) | **真文章确认**(14/14 title、h1 完全变化,url 为真 `/posts/xxx` slug)· 但站点没有 og:desc/og:title/article/jsonld 任何字段,只有 1 个 sitewide meta:description。当前 2 层 fallback 链(og→meta)对此类站点无解,需要"正文首段"第 3 层兜底才能救,现有链条结构性不够 |
| USUAL | og:title 已正确变化(5/8,说明站点本身有设置),但 og:desc 站级常量且无 article/jsonld 可替代字段佐证——站点本身可能就是 desc 统一,非我们代码能救 |

### 4.4 与其他组重叠的 JS 渲染 / 判死源(索引,不重复展开)

ZORA、SPORTFUN、USELESS 与 F 桶重叠,判定"JS渲染-需Playwright"已在第一节给出;PROS/PHAROS 与 desc 桶/无备份重叠,判定"JS渲染-需Playwright"已在第二节给出;WBTC、NMR 是净新增源,详细证据见下方 4.5。

### 4.5 老板重点关注:WBTC / NMR pub "全同日期"是什么

| sym | 全同日期值 | 实测确认 | 结论 |
|---|---|---|---|
| **WBTC**(BitGo) | `2025-12-13T00:00:00Z`(10/10 完全相同) | 10 条记录的 URL 全部是 **`/resources/blog/2016/`、`/resources/blog/2017/` 这类年份归档索引页**,跨 7 个语言站点副本(默认站/en-eu/pt-br/ko-kr/uk/es-mx/ja-jp)重复。**这不是文章,是归档列表页**,10 个页面里没有一篇真文章 | **判死**。日期是这批归档索引页模板/页面级的固定时间戳(不是 build 时间戳,更像该索引页 CMS 侧的"最后编辑"日期),跟真文章发布日期无关。根因在 LIST 层:enqueueLinks 把年份归档页 + 多语言重复页当"文章"入队了 |
| **NMR**(Numerai) | `2025-06-17T17:00:17Z`(10/10 完全相同) | 10 条记录 URL 全部是 **`/about-2/` `/about-3/` `/about-4/` ... `/about-N/` 这类 WordPress 重复/修订 slug**,内容(title="About this site")完全一致。JSON-LD 确认这是这批 About 页各自的**真实 WordPress 发布时间**(og:description 显示"Numerai is an independent publication launched in **June 2025**",与该日期吻合)| **判死**。日期本身是真的(这批 about-N 页确实在那时发布),但内容全部是同一篇 About 说明文重复发布出来的近似页(疑似 WP 编辑时产生的冗余修订页),不是新闻/博客文章。根因也在 LIST 层:numer.ai 真正的博客文章链接从未被发现,只抓到了一批 About 变体页 |

两者共同点:**都不是"抽取代码错了",而是"LIST 层把非文章 URL(归档索引 / 重复修订页)当文章入队",desc/pub 抽取本身对这些页面是"如实反映"——只是反映的对象从一开始就选错了。**

---

## 五、跨组系统性发现(供老板决策是否要修)

| # | 发现 | 影响面 | 建议 |
|---|---|---|---|
| 1 | **pub 抽取链完全没有 JSON-LD `datePublished` 兜底** | FIL、BASED 已实锤(JSON-LD 明确 `BlogPosting.datePublished`);FOGO/STABLE/ZEN/ZETA 等源虽不在 F 桶(pub 已靠其他 selector 救回),但也证实 JSON-LD 里普遍藏着真日期 | 加一层 `script[type="application/ld+json"]` 解析,取 `datePublished`,插入现有 fallback 链末尾 |
| 2 | **desc 抽取链只有 og:desc→meta:desc 两层,无 article/jsonld/正文兜底** | EUL(11 篇真文章零信号)、QUICK(14 篇真文章零信号)等结构性缺口源;MEGA(og:desc 覆盖了更好的 meta:desc)| 视性价比决定要不要加"正文首 N 字"第三层兜底(EUL/QUICK 这类站需要) |
| 3 | **title 优先级 og:title 过高,常"抢跑"更准的 h1/title 标签** | BCH/XAN/RE/ORDI 等确认,og:title 是站级 slogan 常量时被误用 | 可考虑"og:title 与站点默认值高度雷同时降级"的启发式,或干脆把 h1/title 标签优先级提到 og:title 之前 |
| 4 | **Medium 托管博客(blog.xxx.io 指向 Medium)LIST 层系统性失效** | ALT、CROSS、BNT、ZRO、HOME、RSR、HFT、XCN 至少 8 源同款问题,抓到的都是 `/followers` `/subpage/xxx` `/all?topic=` 这类 Medium 站内导航,不是文章 permalink | Medium 类站建议改用 RSS(`/feed`)发现文章,而非页面链接爬取 |
| 5 | **has_og 桶检测方法本身有假阳性** | GODS、CORE 的 og:description 标签"存在但 content 为空",被判定为"有信号" | 若之后还用类似方法做特征扫描,判断条件应改为"content 非空"而非"标签存在" |
| 6 | Vercel BotID/Attack Challenge 会对非浏览器 UA 直接 403(`x-vercel-mitigated: deny`) | ondo.finance 及其 7 个 ticker 源 | 除非上真实浏览器指纹(Playwright + stealth),否则这类站永久拿不到内容 |
| 7 | 多个"无备份"源实测已恢复正常 | SKY/PROS/PORTO/SANTOS/ACM/USDP/RE(7/14)| 建议排进下次抓取,大概率能成功,无需特殊处理 |

---

## 六、总体统计汇总

| 组 | 总数 | 关键分布 |
|---|---|---|
| F 桶(pub 缺失) | 55 | 非文章污染 39 · JS渲染 8 · 真无日期放弃 3 · 有日期但缺兜底 4 · Twitter判死 1 |
| desc 疑难 | 17 | 非文章污染 4+页面差异3=7 · 结构性判死/限制 5 · JS渲染 2 · 真selector缺口 1 · Twitter判死 1 · 单页站判死 1 |
| 无备份 | 14(6个去重URL) | 可救 7 · 反爬判死 7(Ondo 系) |
| fp 误报(40 sym 去重,17 与前三组重叠) | 23(净新增) | 抽取bug 2(BRL1/XAN)+ 轻度/基本正常 3(STABLE/ZETA/ZEN) · 非文章污染 14 · 结构性缺兜底 2(QUICK/USUAL) · WBTC/NMR 判死 2 |
