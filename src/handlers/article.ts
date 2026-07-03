import { type CheerioCrawlingContext, KeyValueStore } from 'crawlee';
import { createHash } from 'node:crypto';
import { isLikelyArticleUrl } from '../config.js';
import { isValidHttpUrl } from '../utils/article-filter.js';
import { checkSourceRuleMulti } from '../utils/source-rules.js';
import { extractH1, extractJsonLdMeta, extractNextDataDate, extractVisibleDate } from '../utils/date-extract.js';
import { normalizePublishedAt } from '../utils/normalize-date.js';
import { underSourceCap, countSourcePush } from '../utils/per-source-cap.js';

// 🆕 2026-07-03 自测模式可调:LIST 每页 enqueue 上限(生产默认 30 · 每源限 1 自测传 5 降载)
const LIST_ENQUEUE_LIMIT = Number(process.env.LIST_ENQUEUE_LIMIT ?? 30);

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
            // 🆕 2026-07-03 P2#4 收紧:same-domain 按根域放行 · 5 次实锤混入 docs.*/build.*/platform.* 子域垃圾
            // (docs.tac.build / docs.chiliz.com / docs.sia.tech / build.avax.network / platform.minimax.io)
            strategy: 'same-hostname',
            label: 'DETAIL',
            limit: LIST_ENQUEUE_LIMIT,
            transformRequestFunction: (req) => {
                // 🆕 2026-07-02 严格 http 验证 · 防非法 URL 进 addRequests 异步 batch 炸全进程
                if (!isValidHttpUrl(req.url)) return false;
                if (!isLikelyArticleUrl(req.url)) return false;
                // 🆕 2026-07-03 per-source 规则(17 agent 审计 · SPACE 类同域跑歪根治)
                if (!checkSourceRuleMulti(sources.map((s) => s.base_symbol), req.url)) return false;
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
    // 🆕 自测模式:关联 token 全部满额 → 跳过解析(请求已发出 · 只省解析/存储)
    if (sources.every((s) => !underSourceCap(s.token_id))) return;
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

    // 🆕 2026-07-03 P0#3 外链拦截(体检实锤 49 条:MET 采到 google.com · redirect 追踪后落到外域)
    // loadedUrl 根域 ≠ 任一 source 根域 → skip(POKT pocket/pokt 迁移类由 URL_OVERRIDES 解决 · 不在这放行)
    const rootDomain = (h: string | null): string => {
        const parts = (h ?? '').toLowerCase().replace(/^www\./, '').split('.');
        return parts.length >= 2 ? parts.slice(-2).join('.') : (h ?? '');
    };
    try {
        const loadedRoot = rootDomain(new URL(loaded).hostname);
        const sourceRoots = new Set(sources.map((s) => {
            try { return rootDomain(new URL(s.original_url).hostname); } catch { return ''; }
        }));
        if (loadedRoot && !sourceRoots.has(loadedRoot)) {
            log.info(`⊘ [DETAIL] 外链拦截 ${loadedRoot} ∉ 源域 | ${loaded}`);
            return;
        }
    } catch { /* URL 解析失败走后续流程 */ }

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

    // 🆕 2026-07-03 published_at/description 抽取梯队增强(修 208 源缺 published_at 问题)
    // + og:title/og:description 站级复读误报维度(h1/jsonld_description 单独存 · 不做判定 · 聚合层切换)
    const jsonLdMeta = extractJsonLdMeta($);
    const h1Text = extractH1($);

    const title =
        $('meta[property="og:title"]').attr('content')?.trim() ||
        h1Text ||
        $('title').first().text().trim() ||
        '';

    // 🆕 2026-07-03 P0#2 错误页拦截(体检实锤 13 条 "404 | STBL" / "Page not found" 入库)
    const BAD_TITLE_RE = /(^|\s|\|)(404|page not found|not found|access denied|just a moment|error)(\s|\||$)/i;
    if (BAD_TITLE_RE.test(title)) {
        log.info(`⊘ [DETAIL] 错误页 title 跳过 "${title.slice(0, 50)}" | ${loaded}`);
        return;
    }
    // 🆕 2026-07-03 自测战役:列表页 title 拦截(实锤 "Blog - Page 2" / "597 articles, page 2 of 50" / "(Page 1)")
    const LIST_TITLE_RE = /\(page\s+\d+\)|page\s+\d+\s+of\s+\d+|(^|\|\s*)page\s+\d+(\s*$|\s*\|)|\b\d+\s+articles?,/i;
    if (LIST_TITLE_RE.test(title) || LIST_TITLE_RE.test(h1Text)) {
        log.info(`⊘ [DETAIL] 列表页 title 跳过 "${title.slice(0, 50)}" | ${loaded}`);
        return;
    }

    // 🆕 2026-07-03 P1#8 desc 质量 fallback(体检:desc==title 35 条 · <30 字符 150 条)
    // 梯队:og/meta → json-ld description → article/main 首个有意义 <p>(轻量 · 不是全文抽取)
    const metaDesc =
        $('meta[property="og:description"]').attr('content')?.trim() ||
        $('meta[name="description"]').attr('content')?.trim() ||
        '';
    let description = metaDesc;
    if (!description || description.length < 30 || description === title) {
        const jd = (jsonLdMeta.description || '').trim();
        if (jd && jd.length >= 30 && jd !== title) {
            description = jd;
        } else {
            // 🆕 2026-07-03 老板拍:摘要够用 · 没摘要就给全文(article/main 全段落合并 · 截 2000)
            const fullText = $('article p, main p')
                .map((_, el) => $(el).text().trim())
                .get()
                .filter((t) => t.length >= 20)
                .join(' ')
                .replace(/\s+/g, ' ');
            if (fullText) description = fullText.slice(0, 2000);
        }
    }
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
        jsonLdMeta.datePublished ||
        extractNextDataDate($) ||
        // 🆕 2026-07-03 P1#7 itemprop 微数据元素级(体检:65 条有 schema 标记但 pub 空 · 非 meta 形态)
        $('[itemprop="datePublished"]').first().attr('datetime')?.trim() ||
        $('[itemprop="datePublished"]').first().attr('content')?.trim() ||
        $('[itemprop="datePublished"]').first().text().trim() ||
        // 🆕 2026-07-03 自测战役 B3:正文可见日期兜底(37 源实锤 byline 日期只在正文)· 梯队最末
        extractVisibleDate($) ||
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

    // 🆕 2026-07-03 自测战役 B2:动态 jsonld 污染防御(MINIMAX 实锤:jsonld datePublished=页面渲染时刻)
    // 解析后与抓取时刻差 <10 分钟 → 大概率是动态生成的"now" · 置空进 pub_missing 桶(比错日期好)
    let publishedAtFinal = normalizePublishedAt(publishedAt);
    if (publishedAtFinal) {
        const dt = Math.abs(Date.parse(publishedAtFinal) - Date.now());
        if (dt < 10 * 60 * 1000) {
            // 动态 jsonld 命中在梯队前段 · 正文可见日期兜底没机会触发 → 这里补一次(MINIMAX 实锤正文有真日期)
            const visible = normalizePublishedAt(extractVisibleDate($));
            log.info(`⊘ [DETAIL] published_at≈抓取时刻(动态生成嫌疑)"${publishedAtFinal}" → ${visible ? `正文日期 ${visible}` : '置空'} | ${loaded}`);
            publishedAtFinal = visible;
        }
    }

    // P3.5 Bug A · 1-to-N · 每个 source 一条 dataset(KLAC vs TTMI 都有数据)
    const crawledAt = new Date().toISOString();
    for (const src of sources) {
        if (!underSourceCap(src.token_id)) continue; // 自测模式:该 token 已满额
        countSourcePush(src.token_id);
        await pushData({
            crawler: 'article-detail',
            token_id: src.token_id,
            base_symbol: src.base_symbol,
            source_url: src.original_url,
            url: loaded,
            title,
            h1: h1Text,
            description,
            jsonld_description: jsonLdMeta.description,
            image,
            published_at: publishedAtFinal,
            author,
            og_type: ogType,
            has_schema_blogposting: hasArticleSchema || hasJsonLdArticle,
            crawledAt,
        });
    }

    const symbols = sources.map((s) => s.base_symbol).join(',');
    log.info(`✅ [DETAIL] ${symbols}(×${sources.length}) | ${title.slice(0, 80)} | pub=${publishedAt || '-'}`);
}
