import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Dataset, Configuration, RequestQueue, Sitemap } from 'crawlee';

import { defaultRouter } from './handlers/default.js';
import { mediumRouter, mediumToRss, paragraphToRss, substackToRss, fetchAndPushSubstack } from './handlers/medium.js';
import { mirrorRouter, mirrorToAtom } from './handlers/mirror.js';
import { listSources, type SourceRow } from './registry/db.js';
import { isLikelyArticleUrl, isBlacklistedHost } from './config.js';

const SITEMAP_URLS_PER_SOURCE = Number(process.env.SITEMAP_URLS_PER_SOURCE ?? 20);

// 🆕 2026-06-30:过滤 blogpicker paused/disabled + hhwl 误判主域(gitbook/github)
const sourcesRaw = listSources({ limit: 5000 }).filter((s) => s.blogpicker_status === 'active');
const sourcesBlocked = sourcesRaw.filter((s) => isBlacklistedHost(s.blog_url));
const sources = sourcesRaw.filter((s) => !isBlacklistedHost(s.blog_url));
if (sourcesBlocked.length > 0) {
    console.log(`⊘ 黑名单过滤 ${sourcesBlocked.length} 源(${sourcesBlocked.map(s => s.base_symbol).join(', ')})`);
}
const mediumSources = sources.filter((s) => s.host_platform === 'medium');
const paragraphSources = sources.filter((s) => s.host_platform === 'paragraph');
// 🆕 2026-06-30 substack 走 RSS(<sub>.substack.com/feed)· 复用 mediumRouter
const substackSources = sources.filter((s) => s.host_platform === 'substack');
// 🆕 2026-06-30 mirror 走 Atom(.../feed/atom)· 独立 mirrorRouter
const mirrorSources = sources.filter((s) => s.host_platform === 'mirror');
const PLATFORM_HANDLED = new Set(['medium', 'paragraph', 'substack', 'mirror']);
const sitemapSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(s.host_platform ?? '')
        && s.fetch_strategy === 'sitemap' && s.sitemap_url,
);
// P3.4 · og=none 的源走 heuristic handler · 多重 fallback 抽 title/description/image/date + RSS auto-discovery
const heuristicSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(s.host_platform ?? '')
        && !(s.fetch_strategy === 'sitemap' && s.sitemap_url)
        && s.og_quality === 'none',
);
const otherSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(s.host_platform ?? '')
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

// 🆕 substack 同模式 · 同 newsletter 1-to-N
const substackByRss = new Map<string, TokenAssoc[]>();
for (const s of substackSources) {
    const rss = substackToRss(s.blog_url);
    const list = substackByRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    substackByRss.set(rss, list);
}

// 🆕 mirror 同模式 · 同账号 1-to-N(用 Atom URL 维度去重)
const mirrorByAtom = new Map<string, TokenAssoc[]>();
for (const s of mirrorSources) {
    const atom = mirrorToAtom(s.blog_url);
    const list = mirrorByAtom.get(atom) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    mirrorByAtom.set(atom, list);
}

// 🆕 2026-06-30 sitemap 按 sitemap_url 去重(ondo 13 token 共用同 sitemap → 1 次 load)
const sitemapByUrl = new Map<string, SourceRow[]>();
for (const s of sitemapSources) {
    const arr = sitemapByUrl.get(s.sitemap_url!) ?? [];
    arr.push(s);
    sitemapByUrl.set(s.sitemap_url!, arr);
}

// P3.5 Bug A · 非 medium 源按 blog_url 维护 1-to-N(KLAC vs TTMI 共 ondo.finance/blog · 不丢数据)
const blogUrlToTokens = new Map<string, TokenAssoc[]>();
for (const s of [...sitemapSources, ...heuristicSources, ...otherSources]) {
    const arr = blogUrlToTokens.get(s.blog_url) ?? [];
    arr.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    blogUrlToTokens.set(s.blog_url, arr);
}

console.log(`📊 source registry 总 ${sources.length} 条(已过黑名单 ${sourcesBlocked.length})`);
console.log(`   · medium    ${mediumSources.length} 源 → ${mediumByRss.size} unique RSS`);
console.log(`   · paragraph ${paragraphSources.length} 源 → ${paragraphByRss.size} unique RSS`);
console.log(`   · substack  ${substackSources.length} 源 → ${substackByRss.size} unique RSS`);
console.log(`   · mirror    ${mirrorSources.length} 源 → ${mirrorByAtom.size} unique Atom`);
console.log(`   · sitemap   ${sitemapSources.length} 源 → ${sitemapByUrl.size} unique sitemap · 每个取前 ${SITEMAP_URLS_PER_SOURCE} URL`);
console.log(`   · heuristic ${heuristicSources.length} 源 → 多重 fallback 抽(og=none 兜底)`);
console.log(`   · other     ${otherSources.length} 源 → 走首页 og`);

// purgeOnStart=false · 避免跟 named queue race(已观察到 ENOENT mkdir lock)
// 外部 SSH 命令前 rm -rf storage/datasets storage/request_queues 控制 purge 时机
Configuration.getGlobalConfig().set('purgeOnStart', false);

// 每个 Crawler 用 named RequestQueue · 避免共享 default queue 出 race condition
const mediumQueue = await RequestQueue.open('medium');
const generalQueue = await RequestQueue.open('general');
const mirrorQueue = await RequestQueue.open('mirror');

const mediumReqs = Array.from(mediumByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc },
}));
// paragraph 入 mediumQueue · 复用 mediumRouter · userData 带 crawler_label 分类
const paragraphReqs = Array.from(paragraphByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc, crawler_label: 'paragraph' as const },
}));
// 🆕 substack 不入 mediumQueue · 改用 node:fetch 直跑(下方)· ImpitHttpClient TLS 被 cf 拉黑
// mirror 独立 queue · 因为 router 不一样(Atom · 不是 RSS)
const mirrorReqs = Array.from(mirrorByAtom.entries()).map(([atomUrl, assoc]) => ({
    url: atomUrl,
    userData: { sources_for_url: assoc },
}));

// 并发拉所有 unique sitemap · 取每个的前 N URL(去重后)
console.log(`\n📍 并发拉 ${sitemapByUrl.size} 个 unique sitemap...`);
const sitemapEntries = Array.from(sitemapByUrl.entries());
const sitemapResults = await Promise.allSettled(
    sitemapEntries.map(async ([sitemapUrl, srcs]) => {
        const { urls } = await Sitemap.load(sitemapUrl);
        return { source: srcs[0], urls };
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
// 🆕 2026-06-30 sitemap 失败 / 0 article URL 的源 · 降级走 LIST handler 抓首页
// 原因:euler.finance/sitemap.txt 不存在但站返回首页 HTML(SPA fallback) · probe 误标
const sitemapFallbackUrls = new Set<string>();
const sitemapReqs = sitemapResults.flatMap((r, i) => {
    const [sitemapUrl, srcs] = sitemapEntries[i];
    if (r.status === 'rejected') {
        sitemapFailed += 1;
        console.warn(`   ⚠️ sitemap 失败 ${sitemapUrl}(${srcs.length} 源关联)· 降级 LIST`);
        for (const s of srcs) sitemapFallbackUrls.add(s.blog_url);
        return [];
    }
    const { source, urls } = r.value;
    // P3.5 · 用 isLikelyArticleUrl 过滤 article-only · 再取前 N
    const articleUrls = (urls as string[]).filter((url) => {
        if (!isValidHttpUrl(url)) { sitemapInvalidUrls += 1; return false; }
        if (!isLikelyArticleUrl(url)) { sitemapNonArticle += 1; return false; }
        return true;
    });
    if (articleUrls.length === 0) {
        // 🆕 sitemap 解析成功但 0 article URL(probe 误标 sitemap)· 降级走 LIST
        for (const s of srcs) sitemapFallbackUrls.add(s.blog_url);
        return [];
    }
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
console.log(`   · sitemap 解析成功 ${sitemapByUrl.size - sitemapFailed} unique · 失败 ${sitemapFailed} · article URL ${sitemapReqs.length} 待 DETAIL`);

// P3.5 Bug A · heuristic + other 合并 · 按 blog_url 去重 · 1-to-N
// 解决 KLAC vs TTMI 共用 blog_url 二号位拿不到数据 bug
// 🆕 2026-06-30 加 sitemapFallbackUrls(sitemap 失败 / 0 article 降级)
const listUrlSet = new Set<string>();
for (const s of [...heuristicSources, ...otherSources]) listUrlSet.add(s.blog_url);
for (const url of sitemapFallbackUrls) listUrlSet.add(url);
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
await mirrorQueue.addRequests(mirrorReqs);

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

// 🆕 2026-06-30 mirror 独立 crawler · Atom feed · cf 反爬严 · sessionPool 高 retry
const mirrorCrawler = new CheerioCrawler({
    requestQueue: mirrorQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mirrorRouter,
    maxRequestsPerMinute: 60,
    maxConcurrency: 3,
    sameDomainDelaySecs: 2,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/atom+xml', 'text/xml'],
    maxRequestRetries: 3,
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

// 🆕 substack 用 node:fetch 独立跑(Crawlee + ImpitHttpClient 被 cf 拉黑)
if (substackByRss.size > 0) {
    console.log(`\n🚀 substack(node:fetch · 绕 cf) · ${substackByRss.size} RSS`);
    const tSub = performance.now();
    const ds = await Dataset.open();
    const r = await fetchAndPushSubstack(substackByRss, ds);
    console.log(`   · substack 完成 ${((performance.now() - tSub) / 1000).toFixed(1)}s · ok=${r.ok} fail=${r.failed} pushed=${r.pushed}`);
}

console.log(`\n🚀 generalCrawler 启动 · ${listReqs.length} LIST + ${sitemapReqs.length} sitemap DETAIL = ${listReqs.length + sitemapReqs.length} 入口 URL`);
const tGen = performance.now();
await generalCrawler.run();
console.log(`   · general 完成 ${((performance.now() - tGen) / 1000).toFixed(1)}s`);

if (mirrorReqs.length > 0) {
    console.log(`\n🚀 mirrorCrawler 启动 · ${mirrorReqs.length} Atom URL`);
    const tMir = performance.now();
    await mirrorCrawler.run();
    console.log(`   · mirror 完成 ${((performance.now() - tMir) / 1000).toFixed(1)}s`);
}

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
