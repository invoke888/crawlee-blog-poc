// 🆕 2026-06-30 单独跑 mirror 测试
// 用法: npx tsx src/run-mirror.ts
// 用 mirrorRouter(Atom 解析)+ mirrorToAtom · 独立 RequestQueue 'mirror-test'
// mirror.xyz cf 反爬严 · 用 ImpitHttpClient Chrome fingerprint + sessionPool 试错

import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Configuration, RequestQueue, Dataset, ProxyConfiguration } from 'crawlee';
import { mirrorRouter, mirrorToAtom } from './handlers/mirror.js';
import { listSources } from './registry/db.js';
import { loadSeen, persistSeen } from './utils/seen-store.js';

Configuration.getGlobalConfig().set('purgeOnStart', false);

await loadSeen();

// 2026-07-01 代理池 · PROXY_URL 在服务器 .env.local · 不进 git
const PROXY_URL = process.env.PROXY_URL ?? '';
const proxyConfiguration = PROXY_URL ? new ProxyConfiguration({ proxyUrls: [PROXY_URL] }) : undefined;
console.log(PROXY_URL ? '🌐 代理池已接入' : '⚠️ 无代理直连');

const sources = listSources({ limit: 5000 }).filter(
    (s) => s.host_platform === 'mirror',
);
console.log(`📊 mirror 源 ${sources.length} 个(blogpicker 状态不可信 · 全量)`);
for (const s of sources) console.log(`   · ${s.base_symbol.padEnd(8)} | ${s.blog_url}`);

interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }
const byAtom = new Map<string, TokenAssoc[]>();
for (const s of sources) {
    const atom = mirrorToAtom(s.blog_url);
    const list = byAtom.get(atom) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    byAtom.set(atom, list);
}
console.log(`\n📍 ${byAtom.size} unique Atom URL`);

const queue = await RequestQueue.open('mirror-test');
const reqs = Array.from(byAtom.entries()).map(([atomUrl, assoc]) => ({
    url: atomUrl,
    userData: { sources_for_url: assoc },
}));
await queue.addRequests(reqs);

const crawler = new CheerioCrawler({
    requestQueue: queue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mirrorRouter,
    proxyConfiguration,
    maxRequestsPerMinute: 60,
    maxConcurrency: 3,
    sameDomainDelaySecs: 2,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/atom+xml', 'text/xml'],
    maxRequestRetries: 3,
});

console.log(`\n🚀 启动 · ${reqs.length} Atom`);
const t0 = performance.now();
await crawler.run();
console.log(`\n✅ 完成 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const dataset = await Dataset.open();
const { items } = await dataset.getData({ limit: 100000 });
const mirrorItems = items.filter((it) => (it as { crawler?: string }).crawler === 'mirror');
console.log(`\n📊 dataset 含 crawler='mirror' 共 ${mirrorItems.length} 条`);
const bySymbol: Record<string, number> = {};
for (const it of mirrorItems) {
    const sym = (it as { base_symbol?: string }).base_symbol ?? '?';
    bySymbol[sym] = (bySymbol[sym] ?? 0) + 1;
}
for (const [sym, n] of Object.entries(bySymbol).sort((a, b) => b[1] - a[1])) {
    console.log(`   · ${sym.padEnd(8)} ${n}`);
}

await persistSeen();
process.exit(0);
