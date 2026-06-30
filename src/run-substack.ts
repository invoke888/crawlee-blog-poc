// 🆕 2026-06-30 单独跑 substack 测试 · 第 3 版 · 用 node:fetch 绕开 ImpitHttpClient
// 用法: npx tsx src/run-substack.ts
//
// 调试发现: substack 把 ImpitHttpClient 的 TLS fingerprint 加 cf 黑名单 (实测 ImpitHttpClient 全 403 ·
// 但 node:fetch + chrome headers 全 200 + 真 RSS · 实测 3/3 = 238KB/18KB/395KB)
// 因此本 entry 直接用 node:fetch · 不走 Crawlee crawler 框架
// 优点: substack 不严反爬 · fetch + headers 足够
// 缺点: 没 sessionPool / 限速 · 全部并发跑 (10 源也就 10 个并发 · 风险低)

import { Configuration, Dataset } from 'crawlee';
import * as cheerio from 'cheerio';
import { listSources } from './registry/db.js';
import { substackToRss } from './handlers/medium.js';

Configuration.getGlobalConfig().set('purgeOnStart', false);

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
};

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
console.log(`\n📍 ${byRss.size} unique RSS URL · 用 node:fetch + chrome headers`);

const dataset = await Dataset.open();
const t0 = performance.now();
let okCount = 0;
let totalPush = 0;
let failed = 0;

await Promise.all(Array.from(byRss.entries()).map(async ([rssUrl, assoc]) => {
    try {
        const res = await fetch(rssUrl, {
            headers: HEADERS,
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            console.log(`❌ ${rssUrl} HTTP=${res.status}`);
            failed += 1;
            return;
        }
        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        const channelTitle = $('channel > title').first().text().trim();
        let itemCount = 0;
        const tasks: Promise<void>[] = [];
        $('item').each((_, el) => {
            const $item = $(el);
            const desc = $item.find('description').first().text().trim();
            const ce = $item.find('content\\:encoded, encoded').first().text().trim();
            const snippet = (desc || ce).replace(/<[^>]+>/g, '').slice(0, 280);
            const postUrl = $item.find('link').first().text().trim();
            const postTitle = $item.find('title').first().text().trim();
            const author = $item.find('dc\\:creator, creator').first().text().trim();
            const pubDate = $item.find('pubDate').first().text().trim();
            const guid = $item.find('guid').first().text().trim();

            for (const src of assoc) {
                tasks.push(dataset.pushData({
                    crawler: 'substack',
                    token_id: src.token_id,
                    base_symbol: src.base_symbol,
                    source_url: src.original_url,
                    rss_url: rssUrl,
                    channel: channelTitle,
                    url: postUrl,
                    title: postTitle,
                    description: snippet,
                    author,
                    publishedTime: pubDate,
                    guid,
                    crawledAt: new Date().toISOString(),
                }));
            }
            itemCount += 1;
        });
        await Promise.all(tasks);
        okCount += 1;
        totalPush += tasks.length;
        console.log(`✅ ${rssUrl} ${itemCount} items × ${assoc.length} = ${tasks.length} | ${channelTitle || '(no channel)'}`);
    } catch (e) {
        failed += 1;
        console.log(`❌ ${rssUrl} ${(e as Error).message ?? e}`);
    }
}));

console.log(`\n✅ 完成 ${((performance.now() - t0) / 1000).toFixed(1)}s · ${okCount}/${byRss.size} RSS 成功 · push ${totalPush} 条 · 失败 ${failed}`);

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
