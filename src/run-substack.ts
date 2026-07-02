// 单独跑 substack 测试(node:fetch 绕 cf · 详见 handlers/medium.ts fetchAndPushSubstack)
// 用法: npx tsx src/run-substack.ts
// 2026-07-01 收敛:解析逻辑只在 fetchAndPushSubstack 一份 · 本文件只做 源加载 + 汇报

import { Configuration, Dataset } from 'crawlee';
import { listSources } from './registry/db.js';
import { loadSeen, persistSeen } from './utils/seen-store.js';
import { substackToRss, fetchAndPushSubstack, type FeedSourceAssoc } from './handlers/medium.js';

Configuration.getGlobalConfig().set('purgeOnStart', false);

await loadSeen();

const sources = listSources({ limit: 5000 }).filter(
    (s) => s.host_platform === 'substack',
);
console.log(`📊 substack 源 ${sources.length} 个(blogpicker 状态不可信 · 全量)`);
for (const s of sources) console.log(`   · ${s.base_symbol.padEnd(8)} | ${s.blog_url}`);

const byRss = new Map<string, FeedSourceAssoc[]>();
for (const s of sources) {
    const rss = substackToRss(s.blog_url);
    const list = byRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    byRss.set(rss, list);
}
console.log(`\n📍 ${byRss.size} unique RSS URL · node:fetch + chrome headers`);

const dataset = await Dataset.open();
const t0 = performance.now();
const r = await fetchAndPushSubstack(byRss, dataset);
console.log(`\n✅ 完成 ${((performance.now() - t0) / 1000).toFixed(1)}s · ok=${r.ok}/${byRss.size} · push ${r.pushed} 条 · 失败 ${r.failed}`);

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

await persistSeen();
process.exit(0);
