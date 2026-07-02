import { createCheerioRouter, type CheerioCrawlingContext, Dataset, KeyValueStore } from 'crawlee';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { normalizePublishedAt } from '../utils/normalize-date.js';
import { isSeen, markSeen } from '../utils/seen-store.js';

export const mediumRouter = createCheerioRouter();

// 🆕 2026-07-01 RSS/Atom XML 也存 raw-html KV(同 article.ts 模式 · 最新一份覆盖)
// 用于回放调试解析 bug · 不用重抓真站(memory project-save-raw-html)
let _rawStore: KeyValueStore | null = null;
async function rawStore(): Promise<KeyValueStore> {
    if (!_rawStore) _rawStore = await KeyValueStore.open('raw-html');
    return _rawStore;
}

export async function saveRawFeed(tokenId: number | undefined, url: string, xml: string): Promise<void> {
    try {
        const kv = await rawStore();
        const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 16);
        await kv.setValue(`${tokenId ?? 'x'}-${urlHash}`, xml, { contentType: 'text/xml; charset=utf-8' });
    } catch {
        // 存失败不影响主流程
    }
}

// 🆕 2026-06-30 substack fetch + parse · 不走 Crawlee crawler 框架(ImpitHttpClient TLS 被 cf 拉黑)
// 共享给 main.ts 跑 substack 流 + run-substack.ts 单独测
export interface FeedSourceAssoc {
    token_id: number;
    base_symbol: string;
    original_url: string;
}

const SUBSTACK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
};

export async function fetchAndPushSubstack(
    byRss: Map<string, FeedSourceAssoc[]>,
    dataset: Dataset,
): Promise<{ ok: number; failed: number; pushed: number }> {
    let ok = 0;
    let failed = 0;
    let pushed = 0;
    await Promise.all(Array.from(byRss.entries()).map(async ([rssUrl, assoc]) => {
        try {
            const res = await fetch(rssUrl, {
                headers: SUBSTACK_HEADERS,
                redirect: 'follow',
                signal: AbortSignal.timeout(20000),
            });
            if (!res.ok) {
                console.log(`❌ [substack] ${rssUrl} HTTP=${res.status}`);
                failed += 1;
                return;
            }
            const xml = await res.text();
            await saveRawFeed(assoc[0]?.token_id, rssUrl, xml);
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
                    if (isSeen(src.token_id, postUrl)) continue; // 🆕 article 级 dedupe(老板拍 a)
                    markSeen(src.token_id, postUrl);
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
                        publishedTime: normalizePublishedAt(pubDate),
                        guid,
                        crawledAt: new Date().toISOString(),
                    }));
                }
                itemCount += 1;
            });
            await Promise.all(tasks);
            ok += 1;
            pushed += tasks.length;
            console.log(`✅ [substack] ${rssUrl} ${itemCount}×${assoc.length}=${tasks.length} | ${channelTitle || '(no channel)'}`);
        } catch (e) {
            failed += 1;
            console.log(`❌ [substack] ${rssUrl} ${(e as Error).message ?? e}`);
        }
    }));
    return { ok, failed, pushed };
}

export function mediumToRss(url: string): string {
    try {
        const u = new URL(url);
        if (u.hostname.endsWith('.medium.com') && u.hostname !== 'medium.com') {
            return `${u.protocol}//${u.hostname}/feed`;
        }
        if (u.hostname === 'medium.com') {
            const path = u.pathname.replace(/\/+$/, '');
            return `${u.protocol}//medium.com/feed${path}`;
        }
        return url;
    } catch {
        return url;
    }
}

// 🆕 2026-06-30 substack 标准 RSS · 每个 substack 站都开放 /feed
// 形式:https://<sub>.substack.com/  →  https://<sub>.substack.com/feed
// 也支持 custom domain(如 newsletter.banklesshq.com)· 同 /feed pattern
export function substackToRss(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.hostname}/feed`;
    } catch {
        return url;
    }
}

// 🆕 2026-06-30 paragraph.com 走 RSS · 实测 endpoint: api.paragraph.com/blogs/rss/@handle
// paragraph.com/@handle/rss 返回的是字符串提示(不是真 XML)· 真 feed 在 api 子域
export function paragraphToRss(url: string): string {
    try {
        const u = new URL(url);
        if (u.hostname === 'paragraph.com' || u.hostname.endsWith('.paragraph.com')) {
            const handle = u.pathname.split('/').filter(Boolean)[0];
            if (handle && handle.startsWith('@')) {
                return `https://api.paragraph.com/blogs/rss/${handle}`;
            }
        }
        return url;
    } catch {
        return url;
    }
}

interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }

mediumRouter.addDefaultHandler(async (ctx: CheerioCrawlingContext) => {
    const { request, $, log, pushData, body } = ctx;
    const sourcesForUrl = (request.userData?.sources_for_url ?? []) as TokenAssoc[];

    await saveRawFeed(sourcesForUrl[0]?.token_id, request.loadedUrl ?? request.url, String(body));

    const channelTitle = $('channel > title').first().text().trim();

    let itemCount = 0;
    let pushCount = 0;
    const tasks: Promise<void>[] = [];
    $('item').each((_, el) => {
        const $item = $(el);
        const categories: string[] = [];
        $item.find('category').each((__, c) => {
            const v = $(c).text().trim();
            if (v) categories.push(v);
        });
        const description = $item.find('description').text().trim();
        const contentEncoded = $item.find('content\\:encoded, encoded').text().trim();
        const snippet = (description || contentEncoded).replace(/<[^>]+>/g, '').slice(0, 280);
        const postUrl = $item.find('link').text().trim();
        const postTitle = $item.find('title').text().trim();
        const author = $item.find('dc\\:creator, creator').text().trim();
        const pubDate = $item.find('pubDate').text().trim();
        const guid = $item.find('guid').text().trim();

        // bug 2 修复:1 RSS item × N tokens = N 条 dataset
        // 🆕 2026-06-30 crawler 字段从 userData.crawler_label 读 · 默认 'medium' · 让 paragraph 复用同 router
        const crawlerLabel = (request.userData?.crawler_label as string | undefined) ?? 'medium';
        for (const src of sourcesForUrl) {
            if (isSeen(src.token_id, postUrl)) continue; // 🆕 article 级 dedupe(老板拍 a)
            markSeen(src.token_id, postUrl);
            tasks.push(pushData({
                crawler: crawlerLabel,
                token_id: src.token_id,
                base_symbol: src.base_symbol,
                source_url: src.original_url,
                rss_url: request.loadedUrl,
                channel: channelTitle,
                url: postUrl,
                title: postTitle,
                description: snippet,
                author,
                categories,
                // 🆕 2026-07-03 修漏:normalize 落地时 replace_all 因缩进差异漏掉本处(dataset 原始一直 RFC-2822)
                publishedTime: normalizePublishedAt(pubDate),
                guid,
                crawledAt: new Date().toISOString(),
            }));
            pushCount += 1;
        }
        itemCount += 1;
    });
    await Promise.all(tasks);

    if (itemCount === 0) {
        log.warning(`⚠️ [medium] 0 posts | ${request.url}(${sourcesForUrl.length} tokens 关联)`);
    } else {
        log.info(`✅ [medium] ${itemCount} posts × ${sourcesForUrl.length} tokens = ${pushCount} 条 | ${channelTitle || '(no channel)'}`);
    }
});
