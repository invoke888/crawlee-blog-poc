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
        for (const src of sourcesForUrl) {
            tasks.push(pushData({
                crawler: 'medium',
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
