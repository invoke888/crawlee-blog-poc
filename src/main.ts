import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Dataset, Configuration, RequestQueue } from 'crawlee';

import { defaultRouter } from './handlers/default.js';
import { mediumRouter, mediumToRss } from './handlers/medium.js';
import { listSources } from './registry/db.js';

const sources = listSources({ limit: 5000 });
const mediumSources = sources.filter((s) => s.host_platform === 'medium');
const otherSources = sources.filter((s) => s.host_platform !== 'medium');

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
console.log(`   · medium  ${mediumSources.length} 源 → ${mediumByRss.size} unique RSS(1-to-N mapping)`);
console.log(`   · general ${otherSources.length} → generalCrawler`);

Configuration.getGlobalConfig().set('purgeOnStart', true);

// 每个 Crawler 用 named RequestQueue · 避免共享 default queue 出 race condition
const mediumQueue = await RequestQueue.open('medium');
const generalQueue = await RequestQueue.open('general');

const mediumReqs = Array.from(mediumByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc },
}));
const generalReqs = otherSources.map((s) => ({
    url: s.blog_url,
    userData: {
        token_id: s.token_id,
        base_symbol: s.base_symbol,
        original_url: s.blog_url,
    },
}));

await mediumQueue.addRequests(mediumReqs);
await generalQueue.addRequests(generalReqs);

const mediumCrawler = new CheerioCrawler({
    requestQueue: mediumQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mediumRouter,
    maxRequestsPerMinute: 30,
    maxConcurrency: 2,
    sameDomainDelaySecs: 2,
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

console.log(`\n🚀 启动 · 2 个 Crawler 并行 · named queues`);
const t0 = performance.now();
await Promise.all([
    mediumCrawler.run(),
    generalCrawler.run(),
]);
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
