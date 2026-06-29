import { type CheerioCrawlingContext, KeyValueStore } from 'crawlee';
import { ARTICLE_GLOBS, NON_ARTICLE_GLOBS } from '../config.js';

interface SourceInfo {
    token_id: number;
    base_symbol: string;
    original_url: string;
}

let _rawStore: KeyValueStore | null = null;
async function rawStore(): Promise<KeyValueStore> {
    if (!_rawStore) _rawStore = await KeyValueStore.open('raw-html');
    return _rawStore;
}

// LIST handler · 在博客首页/列表页 · enqueueLinks 发现 article 链接
export async function listHandler(ctx: CheerioCrawlingContext): Promise<void> {
    const { request, log, enqueueLinks } = ctx;
    const source = request.userData as unknown as SourceInfo;

    try {
        const enqueued = await enqueueLinks({
            selector: 'a[href]',
            strategy: 'same-domain',
            label: 'DETAIL',
            globs: ARTICLE_GLOBS,
            exclude: NON_ARTICLE_GLOBS,
            limit: 30,
            userData: { ...source },
        });
        log.info(`📋 [LIST] ${source.base_symbol} 入队 ${enqueued.processedRequests.length} article · 跳过 ${enqueued.unprocessedRequests.length} | ${request.url}`);
    } catch (e) {
        log.warning(`📋 [LIST] enqueueLinks 失败 ${source.base_symbol} ${request.url}: ${(e as Error).message?.slice(0, 80)}`);
    }
}

// DETAIL handler · 真 article 页 · 抽真 metadata + 存 raw HTML
export async function detailHandler(ctx: CheerioCrawlingContext): Promise<void> {
    const { request, $, log, pushData, body } = ctx;
    const source = request.userData as unknown as SourceInfo;
    const loaded = request.loadedUrl ?? request.url;

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

    // 存 raw HTML(老板拍板:每次访问保存一份 · 后续调白/黑名单 + selector 不用重抓)
    try {
        const kv = await rawStore();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const key = `${source.token_id}-${ts}-${request.id}`;
        await kv.setValue(key, body, { contentType: 'text/html; charset=utf-8' });
    } catch (e) {
        log.warning(`存 raw HTML 失败 ${(e as Error).message?.slice(0, 80)}`);
    }

    await pushData({
        crawler: 'article-detail',
        token_id: source.token_id,
        base_symbol: source.base_symbol,
        source_url: source.original_url,
        url: loaded,
        title,
        description,
        image,
        published_at: publishedAt,
        author,
        og_type: ogType,
        has_schema_blogposting: hasArticleSchema || hasJsonLdArticle,
        crawledAt: new Date().toISOString(),
    });

    log.info(`✅ [DETAIL] ${source.base_symbol} | ${title.slice(0, 80)} | pub=${publishedAt || '-'}`);
}
