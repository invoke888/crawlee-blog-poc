import { createCheerioRouter, type CheerioCrawlingContext, Dataset, KeyValueStore } from 'crawlee';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { normalizePublishedAt } from '../utils/normalize-date.js';
import { isSeen, markSeen } from '../utils/seen-store.js';
import { underSourceCap, countSourcePush } from '../utils/per-source-cap.js';
import { statCount, statSet, statRequest, recordError } from '../../shared/run-stats.js';
import { classifyError } from '../../shared/error-classify.js';
import { cfgNum } from '../../shared/config.js';
import { getProxyUrl } from '../../shared/proxy-config.js';

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
                statRequest(true);
                const t0 = assoc[0];
                if (t0) statCount(t0.token_id, t0.base_symbol, 'substack', 'failed');
                recordError({ token_id: t0?.token_id, base_symbol: t0?.base_symbol, url: rssUrl,
                    kind: res.status === 403 ? 'http_403' : res.status === 429 ? 'http_429' : res.status >= 500 ? 'http_5xx' : 'http_4xx',
                    http_status: res.status, message: `substack feed HTTP ${res.status}`, at: new Date().toISOString() });
                return;
            }
            statRequest(false);
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
                    if (!underSourceCap(src.token_id)) continue; // 自测模式:该 token 已满额
                    markSeen(src.token_id, postUrl);
                    countSourcePush(src.token_id);
                    statCount(src.token_id, src.base_symbol, 'substack', 'items_added');
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
            for (const src of assoc) {
                statSet(src.token_id, src.base_symbol, 'substack', 'feed_items', itemCount);
                statCount(src.token_id, src.base_symbol, 'substack', 'requests');
            }
            console.log(`✅ [substack] ${rssUrl} ${itemCount}×${assoc.length}=${tasks.length} | ${channelTitle || '(no channel)'}`);
        } catch (e) {
            failed += 1;
            statRequest(true);
            const t0 = assoc[0];
            const cls = classifyError({ message: (e as Error).message, code: (e as { code?: string }).code ?? null });
            if (t0) statCount(t0.token_id, t0.base_symbol, 'substack', 'failed');
            recordError({ token_id: t0?.token_id, base_symbol: t0?.base_symbol, url: rssUrl, kind: cls.kind,
                error_code: cls.error_code, message: (e as Error).message, at: new Date().toISOString() });
            console.log(`❌ [substack] ${rssUrl} ${(e as Error).message ?? e}`);
        }
    }));
    return { ok, failed, pushed };
}

// 🆕 2026-07-03 老板拍 a:通用 RSS 源(ghost/wp/gatsby 60 host)直拉模式
// 为什么不走 CheerioCrawler:①application/rss+xml 不被 cheerio 化($ is not a function)
// ②部分 ghost 站对 crawler 请求形态 403 · 而 detect-feed 的 Impit 直拉实证 87/87 全 200 · 用已验证路径
// RSS 2.0(item)+ Atom(entry)双格式兼容(gatsby 站可能吐 atom)
export async function fetchAndPushRssFeeds(
    byFeed: Map<string, FeedSourceAssoc[]>,
    dataset: Dataset,
): Promise<{ ok: number; failed: number; pushed: number }> {
    const { Impit } = await import('impit');
    // 🆕 2026-07-04 代理读取点 3/3(计划书 §5.5):rss 直拉走主力池(有意设计 · 60 源非 medium 域)
    const impit = new Impit({
        browser: 'chrome',
        proxyUrl: getProxyUrl('main') || undefined,
        timeout: cfgNum('rss_timeout_ms', 25000),
    });
    let ok = 0;
    let failed = 0;
    let pushed = 0;
    const entries = Array.from(byFeed.entries());
    const CONCURRENCY = cfgNum('rss_cc', 6);
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < entries.length) {
            const [feedUrl, assoc] = entries[cursor];
            cursor += 1;
            try {
                const res = await impit.fetch(feedUrl, {
                    headers: {
                        'Accept': 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                });
                if (res.status !== 200) {
                    console.log(`❌ [rss] ${feedUrl} HTTP=${res.status}`);
                    failed += 1;
                    statRequest(true);
                    const t0 = assoc[0];
                    if (t0) statCount(t0.token_id, t0.base_symbol, 'rss', 'failed');
                    recordError({ token_id: t0?.token_id, base_symbol: t0?.base_symbol, url: feedUrl,
                        kind: res.status === 403 ? 'http_403' : res.status === 429 ? 'http_429' : res.status >= 500 ? 'http_5xx' : 'http_4xx',
                        http_status: res.status, message: `rss feed HTTP ${res.status}`, at: new Date().toISOString() });
                    continue;
                }
                statRequest(false);
                const xml = await res.text();
                await saveRawFeed(assoc[0]?.token_id, feedUrl, xml);
                const $ = cheerio.load(xml, { xmlMode: true });
                const channelTitle = $('channel > title, feed > title').first().text().trim();
                let itemCount = 0;
                const tasks: Promise<void>[] = [];
                $('item, entry').each((_, el) => {
                    const $item = $(el);
                    const isAtom = el.tagName?.toLowerCase() === 'entry';
                    const postUrl = isAtom
                        ? ($item.find('link[rel="alternate"]').attr('href') || $item.find('link').first().attr('href') || '').trim()
                        : $item.find('link').first().text().trim();
                    const postTitle = $item.find('title').first().text().trim();
                    const desc = $item.find('description, summary').first().text().trim();
                    const ce = $item.find('content\\:encoded, encoded, content').first().text().trim();
                    const snippet = (desc || ce).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
                    const pubDate = (
                        $item.find('pubDate').first().text()
                        || $item.find('published').first().text()
                        || $item.find('updated').first().text()
                    ).trim();
                    const author = $item.find('dc\\:creator, creator, author > name').first().text().trim();
                    const guid = $item.find('guid, id').first().text().trim();
                    if (!postUrl) return;
                    for (const src of assoc) {
                        if (isSeen(src.token_id, postUrl)) continue;
                        if (!underSourceCap(src.token_id)) continue;
                        markSeen(src.token_id, postUrl);
                        countSourcePush(src.token_id);
                        statCount(src.token_id, src.base_symbol, 'rss', 'items_added');
                        tasks.push(dataset.pushData({
                            crawler: 'rss',
                            token_id: src.token_id,
                            base_symbol: src.base_symbol,
                            source_url: src.original_url,
                            rss_url: feedUrl,
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
                for (const src of assoc) {
                    statSet(src.token_id, src.base_symbol, 'rss', 'feed_items', itemCount);
                    statCount(src.token_id, src.base_symbol, 'rss', 'requests');
                }
                console.log(`✅ [rss] ${feedUrl} ${itemCount} items → ${tasks.length} 条 | ${channelTitle || '(no channel)'}`);
            } catch (e) {
                failed += 1;
                statRequest(true);
                const t0 = assoc[0];
                const cls = classifyError({ message: (e as Error).message, code: (e as { code?: string }).code ?? null });
                if (t0) statCount(t0.token_id, t0.base_symbol, 'rss', 'failed');
                recordError({ token_id: t0?.token_id, base_symbol: t0?.base_symbol, url: feedUrl, kind: cls.kind,
                    error_code: cls.error_code, message: (e as Error).message, at: new Date().toISOString() });
                console.log(`❌ [rss] ${feedUrl} ${((e as Error).message ?? e)}`.slice(0, 160));
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
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
        // 🆕 2026-07-03 custom-domain medium(blog.floki.com 等 · platform_overrides 划进来的):
        // medium 绑定域的标准 feed 就在根 /feed(detect-feed 15 host 实测全通)
        return `${u.protocol}//${u.hostname}/feed`;
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
        // 🆕 2026-07-03 custom-domain paragraph(blog.chainbase.com · platform_overrides 划进来的):
        // 自绑域的 feed 在根 /feed(detect-feed 实测 20 items)
        if (u.hostname !== 'paragraph.com' && !u.hostname.endsWith('.paragraph.com')) {
            return `${u.protocol}//${u.hostname}/feed`;
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
            if (!underSourceCap(src.token_id)) continue; // 自测模式:该 token 已满额
            markSeen(src.token_id, postUrl);
            countSourcePush(src.token_id);
            statCount(src.token_id, src.base_symbol, crawlerLabel, 'items_added');
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

    const mediumLabel = (request.userData?.crawler_label as string | undefined) ?? 'medium';
    for (const src of sourcesForUrl) {
        statSet(src.token_id, src.base_symbol, mediumLabel, 'feed_items', itemCount);
        statCount(src.token_id, src.base_symbol, mediumLabel, 'requests');
    }
    statRequest(false);
    if (itemCount === 0) {
        log.warning(`⚠️ [medium] 0 posts | ${request.url}(${sourcesForUrl.length} tokens 关联)`);
    } else {
        log.info(`✅ [medium] ${itemCount} posts × ${sourcesForUrl.length} tokens = ${pushCount} 条 | ${channelTitle || '(no channel)'}`);
    }
});
