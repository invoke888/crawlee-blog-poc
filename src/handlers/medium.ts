import { createCheerioRouter, type CheerioCrawlingContext } from 'crawlee';

export const mediumRouter = createCheerioRouter();

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
    const { request, $, log, pushData } = ctx;
    const sourcesForUrl = (request.userData?.sources_for_url ?? []) as TokenAssoc[];

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
                publishedTime: pubDate,
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
