// 🆕 2026-06-30 单独跑 substack 测试
// 用法: npx tsx src/run-substack.ts
// 复用 mediumRouter + substackToRss · 独立 RequestQueue 'substack-test' · 不污染 main 流程

import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Configuration, RequestQueue, Dataset } from 'crawlee';
import { mediumRouter, substackToRss } from './handlers/medium.js';
import { listSources } from './registry/db.js';

Configuration.getGlobalConfig().set('purgeOnStart', false);

const sources = listSources({ limit: 5000 }).filter(
    (s) => s.host_platform === 'substack' && s.blogpicker_status === 'active',
);
console.log(`📊 substack 源 ${sources.length} 个(active only)`);
for (const s of sources) console.log(`   · ${s.base_symbol.padEnd(8)} | ${s.blog_url}`);

interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }
const byRss = new Map<string, TokenAssoc[]>();
for (const s of sources) {
    const rss = substackToRss(s.blog_url);
    const list = byRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    byRss.set(rss, list);
}
console.log(`\n📍 ${byRss.size} unique RSS URL`);

const queue = await RequestQueue.open('substack-test');
const reqs = Array.from(byRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc, crawler_label: 'substack' as const },
}));
await queue.addRequests(reqs);

const crawler = new CheerioCrawler({
    requestQueue: queue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mediumRouter,
    maxRequestsPerMinute: 60,
    maxConcurrency: 3,
    sameDomainDelaySecs: 0,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/rss+xml', 'text/xml', 'application/atom+xml'],
    maxRequestRetries: 3,
});

console.log(`\n🚀 启动 · ${reqs.length} RSS`);
const t0 = performance.now();
await crawler.run();
console.log(`\n✅ 完成 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const dataset = await Dataset.open();
const { items } = await dataset.getData({ limit: 100000 });
const subItems = items.filter((it) => (it as { crawler?: string }).crawler === 'substack');
console.log(`\n📊 dataset 含 crawler='substack' 共 ${subItems.length} 条`);
const bySymbol: Record<string, number> = {};
for (const it of subItems) {
    const sym = (it as { base_symbol?: string }).base_symbol ?? '?';
    bySymbol[sym] = (bySymbol[sym] ?? 0) + 1;
}
for (const [sym, n] of Object.entries(bySymbol).sort((a, b) => b[1] - a[1])) {
    console.log(`   · ${sym.padEnd(8)} ${n}`);
}
