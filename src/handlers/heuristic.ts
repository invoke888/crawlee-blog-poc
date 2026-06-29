import type { CheerioCrawlingContext } from 'crawlee';

function abs(base: string, maybeRelative: string | undefined): string {
    if (!maybeRelative) return '';
    try {
        return new URL(maybeRelative, base).toString();
    } catch {
        return maybeRelative;
    }
}

export async function heuristicHandler(ctx: CheerioCrawlingContext): Promise<void> {
    const { request, $, log, pushData } = ctx;
    const tokenId = request.userData?.token_id as number | undefined;
    const baseSymbol = request.userData?.base_symbol as string | undefined;
    const originalUrl = request.userData?.original_url as string | undefined;
    const loaded = request.loadedUrl ?? request.url;

    // title:多重 fallback
    const title =
        $('meta[property="og:title"]').attr('content')?.trim() ||
        $('meta[name="title"]').attr('content')?.trim() ||
        $('title').first().text().trim() ||
        $('h1').first().text().trim() ||
        '';

    // description:多重 fallback
    const description =
        $('meta[property="og:description"]').attr('content')?.trim() ||
        $('meta[name="description"]').attr('content')?.trim() ||
        $('article p').first().text().trim().slice(0, 280) ||
        $('main p').first().text().trim().slice(0, 280) ||
        $('p').first().text().trim().slice(0, 280) ||
        '';

    // image:多重 fallback
    const imageRaw =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        $('article img').first().attr('src') ||
        $('main img').first().attr('src') ||
        $('link[rel="icon"][sizes]').attr('href') ||
        $('link[rel="apple-touch-icon"]').attr('href') ||
        $('link[rel="icon"]').attr('href') ||
        $('img').first().attr('src') ||
        '';
    const image = abs(loaded, imageRaw);

    // published_at:多重 fallback · 部分站只有 modified_time(frax)· 部分用 <time> tag(superform/monad)
    const publishedAt =
        $('meta[property="article:published_time"]').attr('content') ||
        $('meta[property="article:modified_time"]').attr('content') ||
        $('meta[itemprop="datePublished"]').attr('content') ||
        $('meta[itemprop="dateModified"]').attr('content') ||
        $('time[datetime]').first().attr('datetime') ||
        $('time[datepublished]').first().attr('datepublished') ||
        $('meta[name="date"]').attr('content') ||
        $('meta[name="publish_date"]').attr('content') ||
        $('meta[name="pubdate"]').attr('content') ||
        '';

    // RSS / Atom auto-discovery · 后续可以 enqueue 走 RSS
    const rssLinkRaw =
        $('link[type="application/rss+xml"]').first().attr('href') ||
        $('link[type="application/atom+xml"]').first().attr('href') ||
        '';
    const rssDiscovered = abs(loaded, rssLinkRaw);

    // article URL 候选(找站内最像"文章"的链接 · 后续可考虑深爬)
    const sampleArticleLinks: string[] = [];
    $('article a[href], main a[href], .post a[href], .entry a[href]').slice(0, 5).each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
            const u = new URL(href, loaded);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                sampleArticleLinks.push(u.toString());
            }
        } catch {
            // skip
        }
    });

    await pushData({
        crawler: 'heuristic',
        token_id: tokenId,
        base_symbol: baseSymbol,
        source_url: originalUrl,
        url: loaded,
        title,
        description,
        image,
        published_at: publishedAt,
        rss_discovered: rssDiscovered,
        sample_article_links: sampleArticleLinks,
        crawledAt: new Date().toISOString(),
    });

    const has = title ? '✅' : '⚠️';
    log.info(`${has} [heuristic] ${(title || '(no title)').slice(0, 50)} | rss=${rssDiscovered ? '有' : '无'} | ${loaded}`);
}
