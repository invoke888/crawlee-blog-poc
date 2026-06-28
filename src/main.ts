import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Dataset, Configuration } from 'crawlee';

import { defaultRouter } from './handlers/default.js';
import { mediumRouter, mediumToRss } from './handlers/medium.js';
import { listSources, type SourceRow } from './registry/db.js';

const sources = listSources({ limit: 5000 });
const mediumSources = sources.filter((s) => s.host_platform === 'medium');
const otherSources = sources.filter((s) => s.host_platform !== 'medium');

console.log(`📊 source registry 总 ${sources.length} 条`);
console.log(`   · medium  ${mediumSources.length} → mediumCrawler(RSS · 1 req/s · 并发 2)`);
console.log(`   · general ${otherSources.length} → generalCrawler(默认 · 并发 10)`);

Configuration.getGlobalConfig().set('purgeOnStart', true);

function buildRequest(s: SourceRow, urlOverride?: string) {
    return {
        url: urlOverride ?? s.blog_url,
        userData: {
            token_id: s.token_id,
            base_symbol: s.base_symbol,
            original_url: s.blog_url,
        },
    };
}

const mediumCrawler = new CheerioCrawler({
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mediumRouter,
    maxRequestsPerMinute: 60,
    maxConcurrency: 2,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/rss+xml', 'text/xml', 'application/atom+xml'],
    maxRequestRetries: 2,
});

const generalCrawler = new CheerioCrawler({
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: defaultRouter,
    maxRequestsPerMinute: 300,
    maxConcurrency: 10,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: 2,
});

const mediumReqs = mediumSources.map((s) => buildRequest(s, mediumToRss(s.blog_url)));
const generalReqs = otherSources.map((s) => buildRequest(s));

console.log(`\n🚀 启动 · 2 个 Crawler 并行`);
const t0 = performance.now();
await Promise.all([
    mediumCrawler.run(mediumReqs),
    generalCrawler.run(generalReqs),
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
