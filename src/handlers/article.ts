import { type CheerioCrawlingContext, KeyValueStore } from 'crawlee';
import { ARTICLE_GLOBS, NON_ARTICLE_GLOBS } from '../config.js';

interface TokenAssoc {
    token_id: number;
    base_symbol: string;
    original_url: string;
}

let _rawStore: KeyValueStore | null = null;
async function rawStore(): Promise<KeyValueStore> {
    if (!_rawStore) _rawStore = await KeyValueStore.open('raw-html');
    return _rawStore;
}

function getSources(ctx: CheerioCrawlingContext): TokenAssoc[] {
    return (ctx.request.userData?.sources_for_url ?? []) as TokenAssoc[];
}

// LIST handler · 在博客首页/列表页 · enqueueLinks 发现 article 链接
export async function listHandler(ctx: CheerioCrawlingContext): Promise<void> {
    const { request, log, enqueueLinks } = ctx;
    const sources = getSources(ctx);
    const label = sources[0]?.base_symbol ?? '?';
    const extraTokens = sources.length > 1 ? ` +${sources.length - 1}` : '';

    try {
        const enqueued = await enqueueLinks({
            selector: 'a[href]',
            strategy: 'same-domain',
            label: 'DETAIL',
            globs: ARTICLE_GLOBS,
            exclude: NON_ARTICLE_GLOBS,
            limit: 30,
            userData: { sources_for_url: sources, from_sitemap: false },
        });
        log.info(`📋 [LIST] ${label}${extraTokens} 入队 ${enqueued.processedRequests.length} article · 跳过 ${enqueued.unprocessedRequests.length} | ${request.url}`);
    } catch (e) {
        log.warning(`📋 [LIST] enqueueLinks 失败 ${label}: ${(e as Error).message?.slice(0, 80)}`);
    }
}

function isCategoryPathname(url: string): boolean {
    try {
        const p = new URL(url).pathname.toLowerCase().replace(/\/+$/, '');
        const bareCategoryPaths = ['', '/blog', '/posts', '/post', '/news', '/articles', '/article', '/insights', '/stories', '/writing', '/media', '/updates', '/announcements', '/journal', '/dispatch'];
        if (bareCategoryPaths.includes(p)) return true;
        if (/^\/(blog|posts?|news|articles?)\/page\/\d+$/i.test(p)) return true;
        return false;
    } catch {
        return false;
    }
}

// DETAIL handler · 真 article 页 · 抽真 metadata + 1-to-N pushData + 存 raw HTML
export async function detailHandler(ctx: CheerioCrawlingContext): Promise<void> {
    const { request, $, log, pushData, body } = ctx;
    const sources = getSources(ctx);
    if (sources.length === 0) {
        log.warning(`⊘ [DETAIL] 无 sources_for_url · ${request.loadedUrl}`);
        return;
    }
    const loaded = request.loadedUrl ?? request.url;

    // 双保险 1:URL 等于任一 source 的博客首页 · 跳过(防 enqueueLinks 把首页加回来)
    if (sources.some((s) => request.url === s.original_url || loaded === s.original_url)) {
        log.info(`⊘ [DETAIL] URL 等于博客首页 跳过 | ${loaded}`);
        return;
    }
    // 双保险 2:pathname 纯目录
    if (isCategoryPathname(loaded)) {
        log.info(`⊘ [DETAIL] pathname 纯目录 跳过 | ${loaded}`);
        return;
    }

    // 二次验证:是不是真 article
    const ogType = ($('meta[property="og:type"]').attr('content') ?? '').trim();
    const hasArticleSchema = $('[itemtype*="BlogPosting"], [itemtype*="Article"], [itemtype*="NewsArticle"]').length > 0;
    let hasJsonLdArticle = false;
    $('script[type="application/ld+json"]').each((_, el) => {
        const txt = $(el).text();
        if (/"@type"\s*:\s*"(BlogPosting|Article|NewsArticle)"/i.test(txt)) hasJsonLdArticle = true;
    });
    const isArticle = ogType === 'article' || hasArticleSchema || hasJsonLdArticle;

    if (!isArticle) {
        log.info(`⊘ [DETAIL] 非 article 页跳过 | og:type='${ogType}' schema=${hasArticleSchema} jsonld=${hasJsonLdArticle} | ${loaded}`);
        return;
    }

    const title =
        $('meta[property="og:title"]').attr('content')?.trim() ||
        $('h1').first().text().trim() ||
        $('title').first().text().trim() ||
        '';
    const description =
        $('meta[property="og:description"]').attr('content')?.trim() ||
        $('meta[name="description"]').attr('content')?.trim() ||
        '';
    const image =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        '';
    const publishedAt =
        $('meta[property="article:published_time"]').attr('content')?.trim() ||
        $('meta[itemprop="datePublished"]').attr('content')?.trim() ||
        $('time[datetime]').first().attr('datetime')?.trim() ||
        $('meta[name="date"]').attr('content')?.trim() ||
        '';
    const author =
        $('meta[property="article:author"]').attr('content')?.trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        $('[itemprop="author"]').first().text().trim() ||
        '';

    // 存 raw HTML · key 用第一个 source 的 token_id 命名
    try {
        const kv = await rawStore();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const key = `${sources[0].token_id}-${ts}-${request.id}`;
        await kv.setValue(key, body, { contentType: 'text/html; charset=utf-8' });
    } catch (e) {
        log.warning(`存 raw HTML 失败 ${(e as Error).message?.slice(0, 80)}`);
    }

    // P3.5 Bug A · 1-to-N · 每个 source 一条 dataset(KLAC vs TTMI 都有数据)
    const crawledAt = new Date().toISOString();
    for (const src of sources) {
        await pushData({
            crawler: 'article-detail',
            token_id: src.token_id,
            base_symbol: src.base_symbol,
            source_url: src.original_url,
            url: loaded,
            title,
            description,
            image,
            published_at: publishedAt,
            author,
            og_type: ogType,
            has_schema_blogposting: hasArticleSchema || hasJsonLdArticle,
            crawledAt,
        });
    }

    const symbols = sources.map((s) => s.base_symbol).join(',');
    log.info(`✅ [DETAIL] ${symbols}(×${sources.length}) | ${title.slice(0, 80)} | pub=${publishedAt || '-'}`);
}
