import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Dataset, Configuration, RequestQueue, Sitemap } from 'crawlee';

import { defaultRouter } from './handlers/default.js';
import { mediumRouter, mediumToRss, paragraphToRss } from './handlers/medium.js';
import { listSources, type SourceRow } from './registry/db.js';
import { isLikelyArticleUrl } from './config.js';

const SITEMAP_URLS_PER_SOURCE = Number(process.env.SITEMAP_URLS_PER_SOURCE ?? 20);

// 🆕 2026-06-30:过滤掉 blogpicker 自己标 paused/disabled 的源 · 58 个不应爬(Explore agent 调研)
const sources = listSources({ limit: 5000 }).filter((s) => s.blogpicker_status === 'active');
const mediumSources = sources.filter((s) => s.host_platform === 'medium');
// 🆕 2026-06-30 paragraph 走 RSS(api.paragraph.com/blogs/rss/@h)· 复用 mediumRouter
const paragraphSources = sources.filter((s) => s.host_platform === 'paragraph');
const sitemapSources = sources.filter(
    (s) => s.host_platform !== 'medium' && s.host_platform !== 'paragraph'
        && s.fetch_strategy === 'sitemap' && s.sitemap_url,
);
// P3.4 · og=none 的源走 heuristic handler · 多重 fallback 抽 title/description/image/date + RSS auto-discovery
const heuristicSources = sources.filter(
    (s) => s.host_platform !== 'medium' && s.host_platform !== 'paragraph'
        && !(s.fetch_strategy === 'sitemap' && s.sitemap_url)
        && s.og_quality === 'none',
);
const otherSources = sources.filter(
    (s) => s.host_platform !== 'medium' && s.host_platform !== 'paragraph'
        && !(s.fetch_strategy === 'sitemap' && s.sitemap_url)
        && s.og_quality !== 'none',
);

// bug 2 修复:多 token_id 共 medium URL · 按 RSS URL 去重 · 反向 1-to-N mapping
interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }
const mediumByRss = new Map<string, TokenAssoc[]>();
for (const s of mediumSources) {
    const rss = mediumToRss(s.blog_url);
    const list = mediumByRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    mediumByRss.set(rss, list);
}

// 🆕 paragraph 同 medium 模式 · 同账号 1-to-N(8 个源现都是 paragraph.com/@xxx)
const paragraphByRss = new Map<string, TokenAssoc[]>();
for (const s of paragraphSources) {
    const rss = paragraphToRss(s.blog_url);
    const list = paragraphByRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    paragraphByRss.set(rss, list);
}

// P3.5 Bug A · 非 medium 源按 blog_url 维护 1-to-N(KLAC vs TTMI 共 ondo.finance/blog · 不丢数据)
const blogUrlToTokens = new Map<string, TokenAssoc[]>();
for (const s of [...sitemapSources, ...heuristicSources, ...otherSources]) {
    const arr = blogUrlToTokens.get(s.blog_url) ?? [];
    arr.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    blogUrlToTokens.set(s.blog_url, arr);
}

console.log(`📊 source registry 总 ${sources.length} 条`);
console.log(`   · medium    ${mediumSources.length} 源 → ${mediumByRss.size} unique RSS(1-to-N mapping)`);
console.log(`   · paragraph ${paragraphSources.length} 源 → ${paragraphByRss.size} unique RSS(api.paragraph.com)`);
console.log(`   · sitemap   ${sitemapSources.length} 源 → 每个取前 ${SITEMAP_URLS_PER_SOURCE} URL`);
console.log(`   · heuristic ${heuristicSources.length} 源 → 多重 fallback 抽(og=none 兜底)`);
console.log(`   · other     ${otherSources.length} 源 → 走首页 og`);

// purgeOnStart=false · 避免跟 named queue race(已观察到 ENOENT mkdir lock)
// 外部 SSH 命令前 rm -rf storage/datasets storage/request_queues 控制 purge 时机
Configuration.getGlobalConfig().set('purgeOnStart', false);

// 每个 Crawler 用 named RequestQueue · 避免共享 default queue 出 race condition
const mediumQueue = await RequestQueue.open('medium');
const generalQueue = await RequestQueue.open('general');

const mediumReqs = Array.from(mediumByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc },
}));
// paragraph 入同 mediumQueue · 复用 mediumRouter · userData 带 crawler_label='paragraph' 让 push 分类
const paragraphReqs = Array.from(paragraphByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc, crawler_label: 'paragraph' as const },
}));

// 并发拉所有 sitemap · 取每个的前 N URL
console.log(`\n📍 并发拉 ${sitemapSources.length} 个 sitemap...`);
const sitemapResults = await Promise.allSettled(
    sitemapSources.map(async (s) => {
        const { urls } = await Sitemap.load(s.sitemap_url!);
        return { source: s, urls };
    }),
);
let sitemapFailed = 0;
function isValidHttpUrl(u: string): boolean {
    try {
        const parsed = new URL(u);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

let sitemapInvalidUrls = 0;
let sitemapNonArticle = 0;
const sitemapReqs = sitemapResults.flatMap((r, i) => {
    if (r.status === 'rejected') {
        sitemapFailed += 1;
        console.warn(`   ⚠️ sitemap 失败 token_id=${sitemapSources[i].token_id} ${sitemapSources[i].sitemap_url}`);
        return [];
    }
    const { source, urls } = r.value;
    // P3.5 · 用 isLikelyArticleUrl 过滤 article-only · 再取前 N
    const articleUrls = (urls as string[]).filter((url) => {
        if (!isValidHttpUrl(url)) { sitemapInvalidUrls += 1; return false; }
        if (!isLikelyArticleUrl(url)) { sitemapNonArticle += 1; return false; }
        return true;
    });
    // P3.5 Bug A · userData 改用 sources_for_url 数组 · 1-to-N
    const sources_for_url = blogUrlToTokens.get(source.blog_url) ?? [];
    return articleUrls.slice(0, SITEMAP_URLS_PER_SOURCE).map((url) => ({
        url,
        label: 'DETAIL',
        userData: {
            sources_for_url,
            from_sitemap: true,
        },
    }));
});
if (sitemapInvalidUrls > 0) console.warn(`   ⚠️ ${sitemapInvalidUrls} 个非法 URL 已跳过`);
if (sitemapNonArticle > 0) console.log(`   · ⊘ ${sitemapNonArticle} 个非 article URL 跳过(isLikelyArticleUrl 过滤)`);
console.log(`   · sitemap 解析成功 ${sitemapSources.length - sitemapFailed} · 失败 ${sitemapFailed} · article URL ${sitemapReqs.length} 待 DETAIL`);

// P3.5 Bug A · heuristic + other 合并 · 按 blog_url 去重 · 1-to-N
// 解决 KLAC vs TTMI 共用 blog_url 二号位拿不到数据 bug
const listUrlSet = new Set<string>();
for (const s of [...heuristicSources, ...otherSources]) listUrlSet.add(s.blog_url);
const listReqs = Array.from(listUrlSet).map((url) => ({
    url,
    label: 'LIST',
    userData: {
        sources_for_url: blogUrlToTokens.get(url) ?? [],
        from_sitemap: false,
    },
}));
console.log(`   · LIST 入队 ${listReqs.length} unique URL(heuristic+other 去重前 ${heuristicSources.length + otherSources.length})`);

await mediumQueue.addRequests([...mediumReqs, ...paragraphReqs]);
await generalQueue.addRequests([...listReqs, ...sitemapReqs]);

// 混合方案(2026-06-29 老板拍板 · 等代理池来再调):
// - sameDomainDelaySecs=0: 真 bug 修复(queue 全同域 reclaim thrashing · 之前 60 秒/req)
// - useSessionPool=true: medium 实测对 RSS 也限速(IP 维度) · SessionPool 保留反爬韧性
// - maxRPM=60 + concurrency=3: 保守 · 不触发限速
// - retries=2: 反爬偶发 · 多重试一次
// 代理池接入后:升 RPM + 配 ProxyConfiguration + per-source interval
const mediumCrawler = new CheerioCrawler({
    requestQueue: mediumQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mediumRouter,
    maxRequestsPerMinute: 60,
    maxConcurrency: 3,
    sameDomainDelaySecs: 0,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/rss+xml', 'text/xml', 'application/atom+xml'],
    maxRequestRetries: 2,
    maxRequestsPerCrawl: process.env.MEDIUM_LIMIT ? Number(process.env.MEDIUM_LIMIT) : undefined,
});

const generalCrawler = new CheerioCrawler({
    requestQueue: generalQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: defaultRouter,
    maxRequestsPerMinute: 300,
    maxConcurrency: 10,
    sameDomainDelaySecs: 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: 2,
});

// 串行跑 · 避免 named queue 并发 race(ENOENT mkdir lock)
const t0 = performance.now();
const SKIP_MEDIUM = process.env.SKIP_MEDIUM === '1';

if (SKIP_MEDIUM) {
    console.log(`\n⊘ 跳过 mediumCrawler(SKIP_MEDIUM=1)· ${mediumReqs.length} 个 RSS 不抓`);
} else {
    console.log(`\n🚀 mediumCrawler 启动 · ${mediumReqs.length} 个 RSS`);
    const tMed = performance.now();
    await mediumCrawler.run();
    console.log(`   · medium 完成 ${((performance.now() - tMed) / 1000).toFixed(1)}s`);
}

console.log(`\n🚀 generalCrawler 启动 · ${listReqs.length} LIST + ${sitemapReqs.length} sitemap DETAIL = ${listReqs.length + sitemapReqs.length} 入口 URL`);
const tGen = performance.now();
await generalCrawler.run();
console.log(`   · general 完成 ${((performance.now() - tGen) / 1000).toFixed(1)}s`);

const dt = ((performance.now() - t0) / 1000).toFixed(1);

const dataset = await Dataset.open();
const { items, count } = await dataset.getData({ limit: 100000 });
const byCrawler = items.reduce<Record<string, number>>((a, it) => {
    const k = (it.crawler as string) ?? 'unknown';
    a[k] = (a[k] ?? 0) + 1;
    return a;
}, {});

console.log(`\n✅ 总耗时 ${dt} 秒 · dataset ${count} 条`);
for (const [k, v] of Object.entries(byCrawler)) console.log(`   · ${k}: ${v}`);
