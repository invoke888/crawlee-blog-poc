import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Dataset, Configuration, RequestQueue, Sitemap } from 'crawlee';

import { defaultRouter } from './handlers/default.js';
import { mediumRouter, mediumToRss } from './handlers/medium.js';
import { listSources, type SourceRow } from './registry/db.js';

const SITEMAP_URLS_PER_SOURCE = Number(process.env.SITEMAP_URLS_PER_SOURCE ?? 20);

const sources = listSources({ limit: 5000 });
const mediumSources = sources.filter((s) => s.host_platform === 'medium');
const sitemapSources = sources.filter(
    (s) => s.host_platform !== 'medium' && s.fetch_strategy === 'sitemap' && s.sitemap_url,
);
// P3.4 · og=none 的源走 heuristic handler · 多重 fallback 抽 title/description/image/date + RSS auto-discovery
const heuristicSources = sources.filter(
    (s) => s.host_platform !== 'medium'
        && !(s.fetch_strategy === 'sitemap' && s.sitemap_url)
        && s.og_quality === 'none',
);
const otherSources = sources.filter(
    (s) => s.host_platform !== 'medium'
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

console.log(`📊 source registry 总 ${sources.length} 条`);
console.log(`   · medium    ${mediumSources.length} 源 → ${mediumByRss.size} unique RSS(1-to-N mapping)`);
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

// 并发拉所有 sitemap · 取每个的前 N URL
console.log(`\n📍 并发拉 ${sitemapSources.length} 个 sitemap...`);
const sitemapResults = await Promise.allSettled(
    sitemapSources.map(async (s) => {
        const { urls } = await Sitemap.load(s.sitemap_url!);
        return { source: s, urls: urls.slice(0, SITEMAP_URLS_PER_SOURCE) };
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
const sitemapReqs = sitemapResults.flatMap((r, i): { url: string; userData: Record<string, unknown> }[] => {
    if (r.status === 'rejected') {
        sitemapFailed += 1;
        console.warn(`   ⚠️ sitemap 失败 token_id=${sitemapSources[i].token_id} ${sitemapSources[i].sitemap_url}`);
        return [];
    }
    const { source, urls } = r.value;
    return urls
        .filter((url) => {
            const ok = isValidHttpUrl(url);
            if (!ok) sitemapInvalidUrls += 1;
            return ok;
        })
        .map((url) => ({
            url,
            userData: {
                token_id: source.token_id,
                base_symbol: source.base_symbol,
                original_url: source.blog_url,
                from_sitemap: true,
            },
        }));
});
if (sitemapInvalidUrls > 0) console.warn(`   ⚠️ ${sitemapInvalidUrls} 个非法 URL 已跳过`);
console.log(`   · sitemap 解析成功 ${sitemapSources.length - sitemapFailed} · 失败 ${sitemapFailed} · 总 ${sitemapReqs.length} URL`);

const otherReqs = otherSources.map((s: SourceRow) => ({
    url: s.blog_url,
    userData: {
        token_id: s.token_id,
        base_symbol: s.base_symbol,
        original_url: s.blog_url,
        from_sitemap: false,
    },
}));

const heuristicReqs = heuristicSources.map((s: SourceRow) => ({
    url: s.blog_url,
    label: 'heuristic',
    userData: {
        token_id: s.token_id,
        base_symbol: s.base_symbol,
        original_url: s.blog_url,
        from_sitemap: false,
    },
}));

await mediumQueue.addRequests(mediumReqs);
await generalQueue.addRequests([...otherReqs, ...sitemapReqs, ...heuristicReqs]);

const mediumCrawler = new CheerioCrawler({
    requestQueue: mediumQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mediumRouter,
    maxRequestsPerMinute: 60,
    maxConcurrency: 3,
    sameDomainDelaySecs: 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/rss+xml', 'text/xml', 'application/atom+xml'],
    maxRequestRetries: 2,
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

console.log(`\n🚀 mediumCrawler 启动 · ${mediumReqs.length} 个 RSS`);
const tMed = performance.now();
await mediumCrawler.run();
console.log(`   · medium 完成 ${((performance.now() - tMed) / 1000).toFixed(1)}s`);

console.log(`\n🚀 generalCrawler 启动 · ${otherReqs.length + sitemapReqs.length} 个 URL`);
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
