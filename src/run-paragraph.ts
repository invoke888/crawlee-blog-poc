// 🆕 2026-06-30 单独跑 paragraph 测试 · 不影响 main.ts 流程
// 用法: npx tsx src/run-paragraph.ts
// 复用 mediumRouter + paragraphToRss · 独立 RequestQueue 'paragraph-test' · 不污染 medium queue

import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Configuration, RequestQueue, Dataset } from 'crawlee';
import { mediumRouter, paragraphToRss } from './handlers/medium.js';
import { listSources } from './registry/db.js';
import { loadSeen, persistSeen } from './utils/seen-store.js';

Configuration.getGlobalConfig().set('purgeOnStart', false);

await loadSeen();

const sources = listSources({ limit: 5000 }).filter(
    (s) => s.host_platform === 'paragraph' && s.blogpicker_status === 'active',
);
console.log(`📊 paragraph 源 ${sources.length} 个(active only)`);
for (const s of sources) console.log(`   · ${s.base_symbol.padEnd(8)} | ${s.blog_url}`);

interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }
const byRss = new Map<string, TokenAssoc[]>();
for (const s of sources) {
    const rss = paragraphToRss(s.blog_url);
    const list = byRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    byRss.set(rss, list);
}
console.log(`\n📍 ${byRss.size} unique RSS URL`);

const queue = await RequestQueue.open('paragraph-test');
const reqs = Array.from(byRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    userData: { sources_for_url: assoc, crawler_label: 'paragraph' as const },
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
    maxRequestRetries: 2,
});

console.log(`\n🚀 启动 · ${reqs.length} RSS`);
const t0 = performance.now();
await crawler.run();
console.log(`\n✅ 完成 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const dataset = await Dataset.open();
const { items } = await dataset.getData({ limit: 100000 });
const paragraphItems = items.filter((it) => (it as { crawler?: string }).crawler === 'paragraph');
console.log(`\n📊 dataset 含 crawler='paragraph' 共 ${paragraphItems.length} 条`);
const bySymbol: Record<string, number> = {};
for (const it of paragraphItems) {
    const sym = (it as { base_symbol?: string }).base_symbol ?? '?';
    bySymbol[sym] = (bySymbol[sym] ?? 0) + 1;
}
for (const [sym, n] of Object.entries(bySymbol).sort((a, b) => b[1] - a[1])) {
    console.log(`   · ${sym.padEnd(8)} ${n}`);
}

await persistSeen();
process.exit(0);
