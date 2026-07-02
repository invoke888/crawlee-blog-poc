import { type CheerioCrawlingContext, KeyValueStore } from 'crawlee';
import { createHash } from 'node:crypto';
import { isLikelyArticleUrl } from '../config.js';
import { isValidHttpUrl } from '../utils/article-filter.js';

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
        // 🆕 2026-06-30 大改:不用 ARTICLE_GLOBS 过滤 · 跟 isLikelyArticleUrl 同步"信任默认"逻辑
        // 之前漏:bitcoincashnode /en/newsroom/<article> 不在 globs · 入队 0
        // 新法:enqueueLinks same-domain · 用 transformRequestFunction 调 isLikelyArticleUrl 过滤(黑名单 + 根路径)
        const enqueued = await enqueueLinks({
            selector: 'a[href]',
            strategy: 'same-domain',
            label: 'DETAIL',
            limit: 30,
            transformRequestFunction: (req) => {
                // 🆕 2026-07-02 严格 http 验证 · 防非法 URL 进 addRequests 异步 batch 炸全进程
                if (!isValidHttpUrl(req.url)) return false;
                if (!isLikelyArticleUrl(req.url)) return false;
                return req;
            },
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

    // 🆕 2026-06-30 大改:取消"6 证据 isArticle"二次验证
    // 老板实测发现:dinari/coredao 这些站 og:type='website' 但正文真的在 HTML 里 · 被误杀
    // 信任 URL 已过 isLikelyArticleUrl + sitemap · 都尝试抽数据 · 抽不到 title 才丢(下面 title 判定)
    const ogType = ($('meta[property="og:type"]').attr('content') ?? '').trim();
    const hasArticleSchema = $('[itemtype*="BlogPosting"], [itemtype*="Article"], [itemtype*="NewsArticle"]').length > 0;
    let hasJsonLdArticle = false;
    $('script[type="application/ld+json"]').each((_, el) => {
        const txt = $(el).text();
        if (/"@type"\s*:\s*"(BlogPosting|Article|NewsArticle)"/i.test(txt)) hasJsonLdArticle = true;
    });

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
    // 多 meta + tag fallback · 老板实测漏:frax 用 article:modified_time(无 published)
    const publishedAt =
        $('meta[property="article:published_time"]').attr('content')?.trim() ||
        $('meta[property="article:modified_time"]').attr('content')?.trim() ||
        $('meta[itemprop="datePublished"]').attr('content')?.trim() ||
        $('meta[itemprop="dateModified"]').attr('content')?.trim() ||
        $('time[datetime]').first().attr('datetime')?.trim() ||
        $('time[datepublished]').first().attr('datepublished')?.trim() ||
        $('time[pubdate]').first().attr('datetime')?.trim() ||
        $('meta[name="date"]').attr('content')?.trim() ||
        $('meta[name="publish_date"]').attr('content')?.trim() ||
        $('meta[name="pubdate"]').attr('content')?.trim() ||
        '';
    const author =
        $('meta[property="article:author"]').attr('content')?.trim() ||
        $('meta[name="author"]').attr('content')?.trim() ||
        $('[itemprop="author"]').first().text().trim() ||
        '';

    // 存 raw HTML · 覆盖式(每 URL 一个 key · 最新覆盖旧)· 作为测试 fixture 调规则用
    // 老板 2026-06-29:不要每次新文件 · 保存最新一份就好
    try {
        const kv = await rawStore();
        const urlHash = createHash('sha1').update(loaded).digest('hex').slice(0, 16);
        const key = `${sources[0].token_id}-${urlHash}`;
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
