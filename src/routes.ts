import { createCheerioRouter } from 'crawlee';

export const router = createCheerioRouter();

router.addDefaultHandler(async ({ request, $, log, pushData }) => {
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
    const ogImage = $('meta[property="og:image"]').attr('content') ?? '';
    const ogDescription = $('meta[property="og:description"]').attr('content') ?? '';
    const ogType = $('meta[property="og:type"]').attr('content') ?? '';
    const ogSiteName = $('meta[property="og:site_name"]').attr('content') ?? '';
    const ogPublishedTime = $('meta[property="article:published_time"]').attr('content') ?? '';

    const title = ogTitle || $('title').text().trim();
    const description = ogDescription || $('meta[name="description"]').attr('content') || '';

    const data = {
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
    };

    log.info(`✅ ${title || '(no title)'} | ${request.loadedUrl}`);
    await pushData(data);
});
