import { createCheerioRouter } from 'crawlee';
import { heuristicHandler } from './heuristic.js';
import { listHandler, detailHandler } from './article.js';

export const defaultRouter = createCheerioRouter();

// P3.4 · og=none 的源走 heuristic handler · 多重 fallback
defaultRouter.addHandler('heuristic', heuristicHandler);

// P3.5 · article 2-level crawl · LIST(首页发现链接)→ DETAIL(抓真 article)
defaultRouter.addHandler('LIST', listHandler);
defaultRouter.addHandler('DETAIL', detailHandler);

defaultRouter.addDefaultHandler(async ({ request, $, log, pushData }) => {
    const tokenId = request.userData?.token_id as number | undefined;
    const baseSymbol = request.userData?.base_symbol as string | undefined;

    const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
    const ogImage = $('meta[property="og:image"]').attr('content') ?? '';
    const ogDescription = $('meta[property="og:description"]').attr('content') ?? '';
    const ogType = $('meta[property="og:type"]').attr('content') ?? '';
    const ogSiteName = $('meta[property="og:site_name"]').attr('content') ?? '';
    const ogPublishedTime = $('meta[property="article:published_time"]').attr('content') ?? '';

    const title = ogTitle || $('title').text().trim();
    const description = ogDescription || $('meta[name="description"]').attr('content') || '';

    const fromSitemap = (request.userData?.from_sitemap as boolean | undefined) ?? false;
    const originalUrl = request.userData?.original_url as string | undefined;

    await pushData({
        crawler: 'general',
        from_sitemap: fromSitemap,
        token_id: tokenId,
        base_symbol: baseSymbol,
        source_url: originalUrl,
        url: request.loadedUrl,
        title,
        description,
        og: {
            title: ogTitle,
            image: ogImage,
            description: ogDescription,
            type: ogType,
            siteName: ogSiteName,
            publishedTime: ogPublishedTime,
        },
        crawledAt: new Date().toISOString(),
    });

    log.info(`✅ [general] ${title || '(no title)'} | ${request.loadedUrl}`);
});
