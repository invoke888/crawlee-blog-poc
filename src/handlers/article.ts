import { type CheerioCrawlingContext, KeyValueStore } from 'crawlee';
import { createHash } from 'node:crypto';
import { isLikelyArticleUrl } from '../config.js';
import { isValidHttpUrl, isWhitelistedArticleUrl } from '../utils/article-filter.js';
import { checkSourceRuleMulti } from '../utils/source-rules.js';
import { extractH1, extractJsonLdMeta, extractVisibleDate, extractPublishedAt, titleRuleFor, bodyRuleFor } from '../utils/date-extract.js';
import { normalizePublishedAt } from '../utils/normalize-date.js';
import { underSourceCap, countSourcePush } from '../utils/per-source-cap.js';
import { statCount, statSet, statRequest, recordError } from '../../shared/run-stats.js';
import { classifySoftErrorPage } from '../../shared/error-classify.js';

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
    const { request, $, log, crawler } = ctx;
    const sources = getSources(ctx);
    const label = sources[0]?.base_symbol ?? '?';
    const extraTokens = sources.length > 1 ? ` +${sources.length - 1}` : '';

    try {
        // 🆕 2026-06-30 大改:不用 ARTICLE_GLOBS 过滤 · 跟 isLikelyArticleUrl 同步"信任默认"逻辑
        // 🆕 2026-07-03 自测战役复审:enqueueLinks 改手动收集+排序 —
        // 白名单段 URL(/blog/ 等)优先入队 · 首页导航链接(/gaming /brand 类)只在文章链接不足时垫底
        // (复审实锤 ~15 源:LIST 候选被导航页占满 · 每源限量时第一条永远是导航页)
        const base = request.loadedUrl ?? request.url;
        const baseHost = new URL(base).hostname;
        const seen = new Set<string>();
        const candidates: { url: string; white: boolean }[] = [];
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            let abs: string;
            try {
                abs = new URL(href, base).toString().replace(/#.*$/, '');
            } catch {
                return;
            }
            if (seen.has(abs)) return;
            seen.add(abs);
            // 🆕 2026-07-02 严格 http 验证 · 防非法 URL 进 addRequests 异步 batch 炸全进程
            if (!isValidHttpUrl(abs)) return;
            // 🆕 2026-07-03 P2#4 收紧:same-hostname(5 次实锤混入 docs.*/build.* 子域垃圾)
            try {
                if (new URL(abs).hostname !== baseHost) return;
            } catch {
                return;
            }
            if (!isLikelyArticleUrl(abs)) return;
            // 🆕 2026-07-03 per-source 规则(17 agent 审计 · SPACE 类同域跑歪根治)
            if (!checkSourceRuleMulti(sources.map((s) => s.base_symbol), abs)) return;
            candidates.push({ url: abs, white: isWhitelistedArticleUrl(abs) });
        });
        candidates.sort((a, b) => Number(b.white) - Number(a.white)); // 稳定排序 · 白名单内保持页面出现顺序
        const picked = candidates.slice(0, LIST_ENQUEUE_LIMIT);
        // 🆕 运维台埋点:LIST 候选数(骤降=改版信号)· 被过滤链接数计 blocked_noise
        for (const src of sources) {
            statSet(src.token_id, src.base_symbol, 'article-detail', 'list_candidates', candidates.length);
            statCount(src.token_id, src.base_symbol, 'article-detail', 'blocked_noise', Math.max(0, seen.size - candidates.length));
            statCount(src.token_id, src.base_symbol, 'article-detail', 'requests');
        }
        statRequest(false);
        await crawler.addRequests(picked.map((c) => ({
            url: c.url,
            label: 'DETAIL',
            userData: { sources_for_url: sources, from_sitemap: false },
        })));
        log.info(`📋 [LIST] ${label}${extraTokens} 入队 ${picked.length} article(白名单 ${picked.filter((c) => c.white).length})· 候选 ${candidates.length} | ${request.url}`);
    } catch (e) {
        log.warning(`📋 [LIST] 链接收集失败 ${label}: ${(e as Error).message?.slice(0, 80)}`);
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
    statRequest(false);
    for (const src of sources) statCount(src.token_id, src.base_symbol, 'article-detail', 'requests');

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
            for (const src of sources) statCount(src.token_id, src.base_symbol, 'article-detail', 'blocked_external');
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

    // 🆕 2026-07-04 地基工程:per-source title 规则(selector 定点 > ban og 跳站级口号 > 通用梯队)
    const tRule = titleRuleFor(loaded);
    const title =
        (tRule?.selector ? $(tRule.selector).first().text().trim() : '') ||
        (tRule?.ban?.includes('og') ? '' : $('meta[property="og:title"]').attr('content')?.trim()) ||
        h1Text ||
        $('title').first().text().trim() ||
        '';

    // 🆕 2026-07-03 P0#2 错误页拦截(体检实锤 13 条 "404 | STBL" / "Page not found" 入库)
    const BAD_TITLE_RE = /(^|\s|\|)(404|page not found|not found|access denied|just a moment|error)(\s|\||$)/i;
    if (BAD_TITLE_RE.test(title)) {
        log.info(`⊘ [DETAIL] 错误页 title 跳过 "${title.slice(0, 50)}" | ${loaded}`);
        for (const src of sources) statCount(src.token_id, src.base_symbol, 'article-detail', 'blocked_error_page');
        recordError({
            token_id: sources[0]?.token_id, base_symbol: sources[0]?.base_symbol, url: loaded,
            kind: classifySoftErrorPage(title), http_status: 200, message: `软错误页 title: ${title.slice(0, 120)}`,
            at: new Date().toISOString(),
        });
        return;
    }
    // 🆕 2026-07-03 自测战役:列表页 title 拦截(实锤 "Blog - Page 2" / "597 articles, page 2 of 50" / "(Page 1)")
    const LIST_TITLE_RE = /\(page\s+\d+\)|page\s+\d+\s+of\s+\d+|(^|\|\s*)page\s+\d+(\s*$|\s*\|)|\b\d+\s+articles?,/i;
    if (LIST_TITLE_RE.test(title) || LIST_TITLE_RE.test(h1Text)) {
        log.info(`⊘ [DETAIL] 列表页 title 跳过 "${title.slice(0, 50)}" | ${loaded}`);
        for (const src of sources) statCount(src.token_id, src.base_symbol, 'article-detail', 'blocked_error_page');
        return;
    }

    // 🆕 2026-07-03 P1#8 desc 质量 fallback(体检:desc==title 35 条 · <30 字符 150 条)
    // 梯队:og/meta → json-ld description → article/main 首个有意义 <p>(轻量 · 不是全文抽取)
    const metaDesc =
        $('meta[property="og:description"]').attr('content')?.trim() ||
        $('meta[name="description"]').attr('content')?.trim() ||
        '';
    // 🆕 2026-07-04 body_excerpt(计划书定案:正文搜索用 · 始终抽全文前 3000)
    // 🆕 地基工程:per-source body 规则(正文容器定点 · 容器落空回退通用防改版)
    const bSel = bodyRuleFor(loaded)?.selector;
    let paras = bSel ? $(bSel).find('p') : $('article p, main p');
    // 规则 selector 自身就是段落集合(如 '.content p')时 find('p') 为空 → 直接用;仍空回退通用防改版
    if (bSel && paras.length === 0) paras = $(bSel) as unknown as typeof paras;
    if (bSel && paras.length === 0) paras = $('article p, main p');
    const fullText = paras
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((t) => t.length >= 20)
        .join(' ')
        .replace(/\s+/g, ' ');
    const bodyExcerpt = fullText.slice(0, 3000);
    let description = metaDesc;
    if (!description || description.length < 30 || description === title) {
        const jd = (jsonLdMeta.description || '').trim();
        if (jd && jd.length >= 30 && jd !== title) {
            description = jd;
        } else if (fullText) {
            // 2026-07-03 老板拍:摘要够用 · 没摘要就给全文(截 2000)
            description = fullText.slice(0, 2000);
        }
    }
    const image =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        '';
    // 🆕 2026-07-04 老板拍:梯队搬入 date-extract.extractPublishedAt(通用梯队 + per-source date-rules.json 定制)
    // 层序不变:meta → time 标签 → jsonld → __NEXT_DATA__ → itemprop 元素 → 可见日期 → URL 日期
    const publishedAt = extractPublishedAt($, loaded);
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
    // 🆕 2026-07-04 老板实锤 CYBER:正文"停用截止日 2026-08-15"被当发布时间(真实 02-17)
    // 未来时间防御:发布时间不可能在抓取时刻 48h 之后(时区差+当天预发容差)→ 置空进 pub_missing(宁缺勿错)
    if (publishedAtFinal && Date.parse(publishedAtFinal) > Date.now() + 48 * 3600 * 1000) {
        log.info(`⊘ [DETAIL] published_at 在未来("${publishedAtFinal}" · 疑似截止/活动日期误锚)→ 置空 | ${loaded}`);
        publishedAtFinal = '';
    }

    // P3.5 Bug A · 1-to-N · 每个 source 一条 dataset(KLAC vs TTMI 都有数据)
    const crawledAt = new Date().toISOString();
    for (const src of sources) {
        if (!underSourceCap(src.token_id)) continue; // 自测模式:该 token 已满额
        countSourcePush(src.token_id);
        statCount(src.token_id, src.base_symbol, 'article-detail', 'items_added');
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
            body_excerpt: bodyExcerpt,
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
