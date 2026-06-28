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

mediumRouter.addDefaultHandler(async (ctx: CheerioCrawlingContext) => {
    const { request, $, log, pushData } = ctx;
    const tokenId = request.userData?.token_id as number | undefined;
    const baseSymbol = request.userData?.base_symbol as string | undefined;
    const originalUrl = request.userData?.original_url as string | undefined;

    const channelTitle = $('channel > title').first().text().trim();

    let count = 0;
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

        pushData({
            crawler: 'medium',
            token_id: tokenId,
            base_symbol: baseSymbol,
            source_url: originalUrl,
            rss_url: request.loadedUrl,
            channel: channelTitle,
            url: $item.find('link').text().trim(),
            title: $item.find('title').text().trim(),
            description: snippet,
            author: $item.find('dc\\:creator, creator').text().trim(),
            categories,
            publishedTime: $item.find('pubDate').text().trim(),
            guid: $item.find('guid').text().trim(),
            crawledAt: new Date().toISOString(),
        });
        count += 1;
    });

    if (count === 0) {
        log.warning(`⚠️ [medium] 0 posts | ${request.url}`);
    } else {
        log.info(`✅ [medium] ${count} posts | ${channelTitle || '(no channel)'} | ${request.url}`);
    }
});
