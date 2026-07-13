import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler, Dataset, Configuration, RequestQueue, ProxyConfiguration } from 'crawlee';
import { parseSitemap } from '@crawlee/utils';

import { defaultRouter } from './handlers/default.js';
import { mediumRouter, mediumToRss, paragraphToRss, substackToRss, fetchAndPushSubstack, fetchAndPushRssFeeds } from './handlers/medium.js';
import { mirrorRouter, mirrorToAtom } from './handlers/mirror.js';
import { listSources, type SourceRow } from './registry/db.js';
import { isLikelyArticleUrl, isBlacklistedHost, URL_OVERRIDES } from './config.js';
import { isValidHttpUrl, getThrottleGroup, isDcBannedHost, isDeadHost, isDirectHost, getPlatformOverride, getRssFeedOverride, getTokenExclusion, extractDateFromUrl, normalizedHostOfUrl } from './utils/article-filter.js';
import { checkSourceRuleMulti, getSitemapOnly } from './utils/source-rules.js';
import { loadKnownUrls, isKnownUrl } from './utils/known-urls.js';
import { loadSeen, persistSeen } from './utils/seen-store.js';
// 🆕 2026-07-04 运维台对接(计划书 §3 契约):埋点/账本/配置中心/代理 DB 读 — 全部可选,零参数裸跑行为不变
import { statCount, statRequest, recordError, snapshotStats } from '../shared/run-stats.js';
import { flushRun } from '../shared/ledger.js';
import { classifyError } from '../shared/error-classify.js';
import { cfgNum, cfgBool } from '../shared/config.js';
import { getProxyUrl } from '../shared/proxy-config.js';
import type { CheerioCrawlingContext } from 'crawlee';

// 🆕 2026-07-02 crash 教训:crawlee addRequests 的异步 batch 验证失败 = unhandledRejection = 全进程死
// (实测 22:29 全量跑 · 某 LIST 源抽出非法 request · 进程直接退 · dataset 半途 1472 条)
// 爬虫长任务不许单点杀全进程 · log 出错误继续跑 · enqueue 侧已加 isValidHttpUrl 严格验证双保险
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ unhandledRejection(已兜底不杀进程):', reason instanceof Error ? reason.message : reason);
});

const SITEMAP_URLS_PER_SOURCE = cfgNum('sitemap_urls_per_source', Number(process.env.SITEMAP_URLS_PER_SOURCE ?? 20));

// 🆕 错误采集(计划书 §4 · errorHandler 每次尝试失败都记 · failedRequestHandler 终判失败记)
function makeErrorHooks(crawlerLabel: string) {
    const record = (ctx: CheerioCrawlingContext, error: Error, isFinal: boolean) => {
        try {
            const req = ctx.request;
            const assoc = (req.userData?.sources_for_url ?? []) as { token_id: number; base_symbol: string }[];
            const t = assoc[0];
            const cls = classifyError({
                message: error?.message,
                statusCode: (error as { statusCode?: number }).statusCode ?? null,
                code: (error as { code?: string }).code ?? null,
            });
            recordError({
                token_id: t?.token_id, base_symbol: t?.base_symbol, url: req.url,
                kind: cls.kind, http_status: cls.http_status, retry_after_s: cls.retry_after_s,
                error_code: cls.error_code, message: error?.message, retries: req.retryCount, at: new Date().toISOString(),
            });
            statRequest(true);
            if (t) {
                statCount(t.token_id, t.base_symbol, crawlerLabel, 'requests');
                if (isFinal) statCount(t.token_id, t.base_symbol, crawlerLabel, 'failed');
                if (cls.kind === 'http_403') statCount(t.token_id, t.base_symbol, crawlerLabel, 'http_403');
                if (cls.kind === 'http_404') statCount(t.token_id, t.base_symbol, crawlerLabel, 'http_404');
                if (cls.kind === 'http_429') statCount(t.token_id, t.base_symbol, crawlerLabel, 'http_429');
                if (cls.kind === 'timeout') statCount(t.token_id, t.base_symbol, crawlerLabel, 'timeout');
                if (cls.kind === 'proxy_error') statCount(t.token_id, t.base_symbol, crawlerLabel, 'proxy_error');
            }
        } catch { /* 埋点绝不拖垮采集 */ }
    };
    return {
        errorHandler: async (ctx: CheerioCrawlingContext, error: Error) => record(ctx, error, false),
        failedRequestHandler: async (ctx: CheerioCrawlingContext, error: Error) => record(ctx, error, true),
    };
}

// 🆕 2026-07-03 增量死锁修复:入口 request(RSS/LIST)uniqueKey 加轮次盐 · 每轮必重抓
// DETAIL(文章页)不加盐 → 持久 dedupe = 老文章不重抓 · 新文章从入口进来
// 之前 bug:入口 URL 不变 → named queue handled 标记挡死 → 第二轮 0 产出(老板实测怀疑命中)
const RUN_SALT = `run-${Date.now()}`;

// 🆕 2026-06-30:过滤 blogpicker paused/disabled + hhwl 误判主域(gitbook/github)
// 🆕 2026-07-03 老板明确拍:blogpicker 状态不可信 · 不再按 active 过滤(74 个 paused/disabled 全部入池)
// 实锤:medibloc.com/blog 被标 paused 但博文丰富。采集范围由自有判定管:黑名单/DC-ban/(agent 调研中的死站清单)
const sourcesRaw = listSources({ limit: 5000 });
// 🆕 2026-07-04 URL_OVERRIDES 在 main 侧也应用(原只在 fetch-sources 同步时写 db · 新加 override 要等同步才生效
// · MET/POKT 实锤:overrides 加了但 db 未更新 → 采集还用老 URL)· 双防线
for (const s of sourcesRaw) {
    const ov = URL_OVERRIDES[s.base_symbol];
    if (ov && s.blog_url !== ov) s.blog_url = ov;
}
const sourcesBlocked = sourcesRaw.filter((s) => isBlacklistedHost(s.blog_url));
// 🆕 2026-07-03 老板拍 b/c:挂起名单(反爬/JS壳 · 方案就绪恢复)+ 永久放弃名单(死站/非博客)
const sourcesDcBanned = sourcesRaw.filter((s) => !isBlacklistedHost(s.blog_url) && isDcBannedHost(s.blog_url));
const sourcesDead = sourcesRaw.filter((s) => !isBlacklistedHost(s.blog_url) && !isDcBannedHost(s.blog_url) && isDeadHost(s.blog_url));
// 🆕 2026-07-03 老板拍 c/d:token 级排除(重复登记去重 + 上游 blog_url 错配挂起)
const sourcesExcluded = sourcesRaw.filter((s) => getTokenExclusion(s.token_id));
let sources = sourcesRaw.filter((s) => !isBlacklistedHost(s.blog_url) && !isDcBannedHost(s.blog_url) && !isDeadHost(s.blog_url) && !getTokenExclusion(s.token_id));
// 🆕 2026-07-04 单源采集(计划书 §2 · 运维台"单独重采"按钮):ONLY_SYMBOLS=SEI,GLM
const ONLY_SYMBOLS = (process.env.ONLY_SYMBOLS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
if (ONLY_SYMBOLS.length > 0) {
    sources = sources.filter((s) => ONLY_SYMBOLS.includes(s.base_symbol.toUpperCase()));
    console.log(`🎯 单源模式:仅采 ${ONLY_SYMBOLS.join(',')}(命中 ${sources.length} 源)`);
}
if (sourcesBlocked.length > 0) {
    console.log(`⊘ 黑名单过滤 ${sourcesBlocked.length} 源(${sourcesBlocked.map(s => s.base_symbol).join(', ')})`);
}
if (sourcesDcBanned.length > 0) {
    console.log(`⊘ 挂起 ${sourcesDcBanned.length} 源(反爬/JS壳 · 住宅代理或 Playwright 后恢复)`);
}
if (sourcesDead.length > 0) {
    console.log(`⊘ 永久放弃 ${sourcesDead.length} 源(死站/非博客 · agent 实测判死)`);
}
if (sourcesExcluded.length > 0) {
    console.log(`⊘ token 级排除 ${sourcesExcluded.length} 源(去重/上游错配挂起):${sourcesExcluded.map((s) => s.base_symbol).join(', ')}`);
}
// 🆕 2026-07-03 自测战役 A1/A4:平台判定统一走 effectivePlatform
// 1. platform_overrides(filter-config · detect-feed 探测实锤的 custom-domain 平台源)优先
// 2. URL host 是 medium.com 系 → 强制 medium(PTB 实锤:host_platform 空走 LIST · same-hostname 在 medium.com 撞进别人专栏)
// 3. 否则用 registry 的 host_platform
const effectivePlatform = (s: SourceRow): string | null => {
    const override = getPlatformOverride(s.blog_url);
    if (override) return override;
    try {
        const h = new URL(s.blog_url).hostname.toLowerCase();
        if (h === 'medium.com' || h.endsWith('.medium.com')) return 'medium';
    } catch { /* 保持 registry 值 */ }
    return s.host_platform;
};
const mediumSources = sources.filter((s) => effectivePlatform(s) === 'medium');
const paragraphSources = sources.filter((s) => effectivePlatform(s) === 'paragraph');
// 🆕 2026-06-30 substack 走 RSS(<sub>.substack.com/feed)· 复用 mediumRouter
const substackSources = sources.filter((s) => effectivePlatform(s) === 'substack');
// 🆕 2026-06-30 mirror 走 Atom(.../feed/atom)· 独立 mirrorRouter
const mirrorSources = sources.filter((s) => effectivePlatform(s) === 'mirror');
const PLATFORM_HANDLED = new Set(['medium', 'paragraph', 'substack', 'mirror']);
// 🆕 2026-07-03 P2#3 sitemap-only 源(chiliz/socios/BAT/REQ/OG · 真假 URL 同形站)
// 不走 LIST/常规 sitemap · 直接用站方 post-sitemap.xml(纯文章清单)白名单入队
const sitemapOnlySources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(effectivePlatform(s) ?? '') && getSitemapOnly(s.base_symbol),
);
const isSitemapOnly = (s: SourceRow) => !!getSitemapOnly(s.base_symbol);
// 🆕 2026-07-03 老板拍 a:通用 RSS 源(ghost/wp/gatsby 60 host · detect-feed 实锤)· 独立 rssCrawler
// 优先级:平台 > sitemap-only > rss > sitemap > LIST(sitemap-only 三站不在 rss 名单 · 代码层再保险)
const isRssOverride = (s: SourceRow) => !!getRssFeedOverride(s.blog_url);
const rssSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(effectivePlatform(s) ?? '') && !isSitemapOnly(s) && isRssOverride(s),
);
const sitemapSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(effectivePlatform(s) ?? '') && !isSitemapOnly(s) && !isRssOverride(s)
        && s.fetch_strategy === 'sitemap' && s.sitemap_url,
);
// P3.4 · og=none 的源走 heuristic handler · 多重 fallback 抽 title/description/image/date + RSS auto-discovery
const heuristicSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(effectivePlatform(s) ?? '') && !isSitemapOnly(s) && !isRssOverride(s)
        && !(s.fetch_strategy === 'sitemap' && s.sitemap_url)
        && s.og_quality === 'none',
);
const otherSources = sources.filter(
    (s) => !PLATFORM_HANDLED.has(effectivePlatform(s) ?? '') && !isSitemapOnly(s) && !isRssOverride(s)
        && !(s.fetch_strategy === 'sitemap' && s.sitemap_url)
        && s.og_quality !== 'none',
);

// bug 2 修复:多 token_id 共 medium URL · 按 RSS URL 去重 · 反向 1-to-N mapping
interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }
const mediumByRss = new Map<string, TokenAssoc[]>();
for (const s of mediumSources) {
    const rss = mediumToRss(s.blog_url);
    const list = mediumByRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    mediumByRss.set(rss, list);
}

// 🆕 paragraph 同 medium 模式 · 同账号 1-to-N(8 个源现都是 paragraph.com/@xxx)
const paragraphByRss = new Map<string, TokenAssoc[]>();
for (const s of paragraphSources) {
    const rss = paragraphToRss(s.blog_url);
    const list = paragraphByRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    paragraphByRss.set(rss, list);
}

// 🆕 substack 同模式 · 同 newsletter 1-to-N
const substackByRss = new Map<string, TokenAssoc[]>();
for (const s of substackSources) {
    const rss = substackToRss(s.blog_url);
    const list = substackByRss.get(rss) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    substackByRss.set(rss, list);
}

// 🆕 mirror 同模式 · 同账号 1-to-N(用 Atom URL 维度去重)
const mirrorByAtom = new Map<string, TokenAssoc[]>();
for (const s of mirrorSources) {
    const atom = mirrorToAtom(s.blog_url);
    const list = mirrorByAtom.get(atom) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    mirrorByAtom.set(atom, list);
}

// 🆕 2026-07-03 老板拍 a:通用 RSS 源同模式 · feed URL 维度 1-to-N(lido 双 token 共 feed 等)
const rssByFeed = new Map<string, TokenAssoc[]>();
for (const s of rssSources) {
    const feed = getRssFeedOverride(s.blog_url)!;
    const list = rssByFeed.get(feed) ?? [];
    list.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    rssByFeed.set(feed, list);
}

// 🆕 2026-06-30 sitemap 按 sitemap_url 去重(ondo 13 token 共用同 sitemap → 1 次 load)
const sitemapByUrl = new Map<string, SourceRow[]>();
for (const s of sitemapSources) {
    const arr = sitemapByUrl.get(s.sitemap_url!) ?? [];
    arr.push(s);
    sitemapByUrl.set(s.sitemap_url!, arr);
}

// P3.5 Bug A · 非 medium 源按 blog_url 维护 1-to-N(KLAC vs TTMI 共 ondo.finance/blog · 不丢数据)
const blogUrlToTokens = new Map<string, TokenAssoc[]>();
for (const s of [...sitemapSources, ...heuristicSources, ...otherSources]) {
    const arr = blogUrlToTokens.get(s.blog_url) ?? [];
    arr.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    blogUrlToTokens.set(s.blog_url, arr);
}

console.log(`📊 source registry 总 ${sources.length} 条(已过黑名单 ${sourcesBlocked.length})`);
console.log(`   · medium    ${mediumSources.length} 源 → ${mediumByRss.size} unique RSS`);
console.log(`   · paragraph ${paragraphSources.length} 源 → ${paragraphByRss.size} unique RSS`);
console.log(`   · substack  ${substackSources.length} 源 → ${substackByRss.size} unique RSS`);
console.log(`   · rss       ${rssSources.length} 源 → ${rssByFeed.size} unique feed(ghost/wp 通用 · 老板拍 a)`);
console.log(`   · mirror    ${mirrorSources.length} 源 → ${mirrorByAtom.size} unique Atom`);
console.log(`   · sitemap   ${sitemapSources.length} 源 → ${sitemapByUrl.size} unique sitemap · 每个取前 ${SITEMAP_URLS_PER_SOURCE} URL`);
console.log(`   · heuristic ${heuristicSources.length} 源 → 多重 fallback 抽(og=none 兜底)`);
console.log(`   · other     ${otherSources.length} 源 → 走首页 og`);

// purgeOnStart=false · 避免跟 named queue race(已观察到 ENOENT mkdir lock)
// 外部 SSH 命令前 rm -rf storage/datasets storage/request_queues 控制 purge 时机
Configuration.getGlobalConfig().set('purgeOnStart', false);

// 🆕 2026-07-03 RSS 流 article 级 dedupe(老板拍 a)· 跑前加载已见清单
await loadSeen();

// 🆕 2026-07-13 存储根源改造(老板拍):DETAIL 去重记忆迁账本 · queue 每轮 drop 重建不积累
// (旧:queue 文件持久 dedupe 只增不减 · 5 天把批次 4.4min 拖到 15min 超时连环实锤)
const knownCount = loadKnownUrls();
console.log(`📚 账本去重记忆:${knownCount} 已知 URL(DETAIL 入队前跳过 · REFETCH 豁免)`);
async function freshQueue(name: string): Promise<RequestQueue> {
    const stale = await RequestQueue.open(name);
    await stale.drop(); // 上一轮遗留(含 timeout 半途)整体丢弃 · 未入库的 URL 由本轮 LIST/sitemap 重新发现
    return RequestQueue.open(name);
}

// 每个 Crawler 用 named RequestQueue · 避免共享 default queue 出 race condition
const mediumQueue = await freshQueue('medium');
const generalQueue = await freshQueue('general');
const mirrorQueue = await freshQueue('mirror');

// 入口层全部加 RUN_SALT(增量修复)
const mediumReqs = Array.from(mediumByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    uniqueKey: `${rssUrl}#${RUN_SALT}`,
    userData: { sources_for_url: assoc },
}));
// paragraph 入 mediumQueue · 复用 mediumRouter · userData 带 crawler_label 分类
const paragraphReqs = Array.from(paragraphByRss.entries()).map(([rssUrl, assoc]) => ({
    url: rssUrl,
    uniqueKey: `${rssUrl}#${RUN_SALT}`,
    userData: { sources_for_url: assoc, crawler_label: 'paragraph' as const },
}));
// 🆕 substack 不入 mediumQueue · 改用 node:fetch 直跑(下方)· ImpitHttpClient TLS 被 cf 拉黑
// mirror 独立 queue · 因为 router 不一样(Atom · 不是 RSS)
const mirrorReqs = Array.from(mirrorByAtom.entries()).map(([atomUrl, assoc]) => ({
    url: atomUrl,
    userData: { sources_for_url: assoc },
}));
// 🆕 通用 RSS 源:Impit 直拉模式(不走 crawler · 见 fetchAndPushRssFeeds 头注)· 并行 jobs 里跑

// 并发拉所有 unique sitemap · 取每个的前 N URL(去重后)
// 🆕 2026-07-03 换 parseSitemap 拿 lastmod · 修 GLMR 实锤 bug:
// sitemap 不按时间排序 + 截断取前 N → 前 N 全是营销页 · 真文章(带 lastmod 的新文章)被截掉
console.log(`\n📍 并发拉 ${sitemapByUrl.size} 个 unique sitemap...`);
const sitemapEntries = Array.from(sitemapByUrl.entries());
const sitemapResults = await Promise.allSettled(
    sitemapEntries.map(async ([sitemapUrl, srcs]) => {
        const items: { loc: string; lastmod?: Date }[] = [];
        for await (const item of parseSitemap([{ type: 'url', url: sitemapUrl }])) {
            items.push({ loc: item.loc, lastmod: item.lastmod });
        }
        // 🆕 2026-07-05 B 战役:sitemapindex 一层递归(BNB 实锤:顶层是索引 · 真文在子 sitemap 未展开)
        const childXml = items.filter((it) => /\.xml(\?|$)/i.test(it.loc));
        if (childXml.length > 0 && childXml.length >= items.length * 0.5 && items.length < 60) {
            for (const c of childXml.slice(0, 10)) {
                try {
                    for await (const item of parseSitemap([{ type: 'url', url: c.loc }])) {
                        items.push({ loc: item.loc, lastmod: item.lastmod });
                    }
                } catch { /* 子表失败不拖垮 */ }
            }
        }
        // 🆕 2026-07-05 B 战役实锤(26 源漏采诊断):lastmod 大面积缺失(KAVA/XRP)或全站同一构建时间戳
        // (MNT/GLMR/MOVR)时 · 排序退化为原始文件序 · 旧序站取前 N 永远是老文 → 失效检测 + 双兜底
        const withLm = items.filter((it) => it.lastmod);
        const lmUnique = new Set(withLm.map((it) => it.lastmod!.getTime()));
        const lastmodValid = withLm.length >= items.length * 0.5 && lmUnique.size > 2;
        let needListFallback = false;
        if (lastmodValid) {
            items.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
        } else {
            // 兜底 1:URL 路径日期排序(XMR 型 /YYYY/MM/DD/)
            const urlTime = (it: { loc: string }) => Date.parse(extractDateFromUrl(it.loc) || '') || 0;
            const dated = items.filter((it) => urlTime(it) > 0).sort((a, b) => urlTime(b) - urlTime(a));
            if (dated.length >= 3) {
                const undated = items.filter((it) => urlTime(it) === 0);
                items.length = 0;
                items.push(...dated, ...undated);
            } else {
                needListFallback = true; // 兜底 2:降级 LIST 双保险(blog_url 列表页新文天然在前)
            }
        }
        return { source: srcs[0], urls: items.map((i) => i.loc), needListFallback };
    }),
);
let sitemapFailed = 0;

let sitemapInvalidUrls = 0;
let sitemapNonArticle = 0;
// 🆕 2026-06-30 sitemap 失败 / 0 article URL 的源 · 降级走 LIST handler 抓首页
// 原因:euler.finance/sitemap.txt 不存在但站返回首页 HTML(SPA fallback) · probe 误标
const sitemapFallbackUrls = new Set<string>();
const sitemapReqs = sitemapResults.flatMap((r, i) => {
    const [sitemapUrl, srcs] = sitemapEntries[i];
    if (r.status === 'rejected') {
        sitemapFailed += 1;
        console.warn(`   ⚠️ sitemap 失败 ${sitemapUrl}(${srcs.length} 源关联)· 降级 LIST`);
        for (const s of srcs) sitemapFallbackUrls.add(s.blog_url);
        return [];
    }
    const { urls, needListFallback } = r.value;
    if (needListFallback) for (const s of srcs) sitemapFallbackUrls.add(s.blog_url); // lastmod+URL日期双失效 → LIST 双保险
    // P3.5 · 用 isLikelyArticleUrl 过滤 article-only · 再取前 N
    // 🆕 2026-07-03 per-source 规则(17 agent 审计):高置信源强制 pattern 过滤(SPACE 类跑歪根治)
    const chunkSyms = srcs.map((s) => s.base_symbol);
    const articleUrls = (urls as string[]).filter((url) => {
        if (!isValidHttpUrl(url)) { sitemapInvalidUrls += 1; return false; }
        if (!isLikelyArticleUrl(url)) { sitemapNonArticle += 1; return false; }
        if (!checkSourceRuleMulti(chunkSyms, url)) { sitemapNonArticle += 1; return false; }
        return true;
    });
    if (articleUrls.length === 0) {
        // 🆕 sitemap 解析成功但 0 article URL(probe 误标 sitemap)· 降级走 LIST
        for (const s of srcs) sitemapFallbackUrls.add(s.blog_url);
        return [];
    }
    // 🆕 2026-07-04 判死复核战役:sitemap 稀薄(<5 条 article URL)时附加 LIST 双保险
    // (G/HOT 实锤:sitemap 只有 /blog 一条 · 进 DETAIL 被首页拦 → 源挂零 · LIST 页上其实有真文章)
    if (articleUrls.length < 5) {
        for (const s of srcs) sitemapFallbackUrls.add(s.blog_url);
    }
    // 🆕 2026-07-03 修 SUI/DEEP 归属 bug(agent 实锤):共用 sitemap 的源 blog_url 可能不同 ·
    // 之前只查 srcs[0] 的 blog_url → 其他 token 挂零。改为合并全部 srcs 的 tokens(去重)
    const seenTokens = new Set<number>();
    const sources_for_url: TokenAssoc[] = [];
    for (const s of srcs) {
        for (const t of blogUrlToTokens.get(s.blog_url) ?? []) {
            if (!seenTokens.has(t.token_id)) {
                seenTokens.add(t.token_id);
                sources_for_url.push(t);
            }
        }
    }
    return articleUrls.slice(0, SITEMAP_URLS_PER_SOURCE).map((url) => ({
        url,
        label: 'DETAIL',
        userData: {
            sources_for_url,
            from_sitemap: true,
        },
    }));
});
if (sitemapInvalidUrls > 0) console.warn(`   ⚠️ ${sitemapInvalidUrls} 个非法 URL 已跳过`);
if (sitemapNonArticle > 0) console.log(`   · ⊘ ${sitemapNonArticle} 个非 article URL 跳过(isLikelyArticleUrl 过滤)`);
console.log(`   · sitemap 解析成功 ${sitemapByUrl.size - sitemapFailed} unique · 失败 ${sitemapFailed} · article URL ${sitemapReqs.length} 待 DETAIL`);

// P3.5 Bug A · heuristic + other 合并 · 按 blog_url 去重 · 1-to-N
// 解决 KLAC vs TTMI 共用 blog_url 二号位拿不到数据 bug
// 🆕 2026-06-30 加 sitemapFallbackUrls(sitemap 失败 / 0 article 降级)
const listUrlSet = new Set<string>();
for (const s of [...heuristicSources, ...otherSources]) listUrlSet.add(s.blog_url);
for (const url of sitemapFallbackUrls) listUrlSet.add(url);
const listReqs = Array.from(listUrlSet).map((url) => ({
    url,
    uniqueKey: `${url}#${RUN_SALT}`, // LIST 入口每轮必重抓(增量修复)
    label: 'LIST',
    userData: {
        sources_for_url: blogUrlToTokens.get(url) ?? [],
        from_sitemap: false,
    },
}));
console.log(`   · LIST 入队 ${listReqs.length} unique URL(heuristic+other 去重前 ${heuristicSources.length + otherSources.length})`);

// 🆕 P2#3 sitemap-only 拉取(post-sitemap 去重 · chiliz 4 token 共用一个)
const sitemapOnlyByUrl = new Map<string, TokenAssoc[]>();
for (const s of sitemapOnlySources) {
    const ps = getSitemapOnly(s.base_symbol)!;
    const arr = sitemapOnlyByUrl.get(ps) ?? [];
    arr.push({ token_id: s.token_id, base_symbol: s.base_symbol, original_url: s.blog_url });
    sitemapOnlyByUrl.set(ps, arr);
}
const sitemapOnlyReqs: typeof listReqs = [];
if (sitemapOnlyByUrl.size > 0) {
    console.log(`\n📍 sitemap-only 拉 ${sitemapOnlyByUrl.size} 个 post-sitemap(${sitemapOnlySources.length} 源)...`);
    const soResults = await Promise.allSettled(
        Array.from(sitemapOnlyByUrl.entries()).map(async ([psUrl, assoc]) => {
            const items: { loc: string; lastmod?: Date }[] = [];
            for await (const item of parseSitemap([{ type: 'url', url: psUrl }])) {
                items.push({ loc: item.loc, lastmod: item.lastmod });
            }
            items.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
            return { assoc, urls: items.map((i) => i.loc) };
        }),
    );
    for (const r of soResults) {
        if (r.status === 'rejected') { console.warn(`   ⚠️ post-sitemap 拉取失败`); continue; }
        const { assoc, urls } = r.value;
        // post-sitemap 就是文章白名单 · 只做基础校验 · 不走 isLikelyArticleUrl(同形站会误杀)
        const picked = urls.filter(isValidHttpUrl).slice(0, SITEMAP_URLS_PER_SOURCE);
        for (const url of picked) {
            sitemapOnlyReqs.push({
                url,
                label: 'DETAIL',
                userData: { sources_for_url: assoc, from_sitemap: true },
            } as (typeof listReqs)[number]);
        }
        console.log(`   · ${assoc.map((a) => a.base_symbol).join(',')} ← ${picked.length} URL(post-sitemap 共 ${urls.length})`);
    }
}

// 🆕 2026-07-05 定向重抓(老板拍 a):REFETCH_URLS=<文件路径 · 每行一个 URL>
// 加盐绕过 DETAIL 持久 dedupe 强制重抓 · token 关联按 host 匹配 sources.blog_url(自有域源适用)
// 用途:LIST 不再露出的旧文空字段回填(ASR/KAVA 型)· 删行重收 · 漏采补录(ADA 型)
// 契约:裸跑写 dataset · 下轮运维台批次补漏/回填收编 · 不写账本
const refetchReqs: typeof listReqs = [];
const REFETCH_FILE = process.env.REFETCH_URLS ?? '';
if (REFETCH_FILE) {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(REFETCH_FILE, 'utf-8').split('\n').map((s) => s.trim()).filter((u) => u && isValidHttpUrl(u));
    const hostToTokens = new Map<string, TokenAssoc[]>();
    for (const [burl, assoc] of blogUrlToTokens) {
        const h = normalizedHostOfUrl(burl);
        const arr = hostToTokens.get(h) ?? [];
        for (const t of assoc) if (!arr.some((x) => x.token_id === t.token_id)) arr.push(t);
        hostToTokens.set(h, arr);
    }
    let unmatched = 0;
    for (const url of raw) {
        const assoc = hostToTokens.get(normalizedHostOfUrl(url)) ?? [];
        if (assoc.length === 0) { unmatched += 1; continue; }
        refetchReqs.push({
            url,
            uniqueKey: `${url}#refetch-${RUN_SALT}`,
            label: 'DETAIL',
            userData: { sources_for_url: assoc, from_sitemap: false, refetch: true }, // refetch=豁免账本 known-skip(强制重抓语义)
        } as (typeof listReqs)[number]);
    }
    console.log(`🎯 定向重抓:${refetchReqs.length} URL 入队(host 无 token 关联跳过 ${unmatched})`);
}

// 🆕 2026-07-03 限频域分流(老板拍 · 独立代理池):
// medium.com/*.medium.com + 403 四强 → slowQueue(低速 + 池 B/C)· 其余 → generalQueue(主力全速)
// 主力队列不再被限频站的 retry/session-rotation 拖垮(实测 RPM 76 → 预期 300+)
const generalReqs: typeof listReqs = [];
const slowReqs: typeof listReqs = [];
let dcBannedDropped = 0;
let knownSkipped = 0;
for (const req of [...listReqs, ...sitemapReqs, ...sitemapOnlyReqs, ...refetchReqs]) {
    if (isDcBannedHost(req.url)) { dcBannedDropped += 1; continue; } // 兜底:跨源链接指向 DC-ban 域也 drop
    // 🆕 2026-07-13 账本级 dedupe(替代 queue 文件记忆):已入库 DETAIL 不重抓 · refetch 豁免
    if ((req as { label?: string }).label === 'DETAIL' && !(req.userData as { refetch?: boolean })?.refetch && isKnownUrl(req.url)) { knownSkipped += 1; continue; }
    (getThrottleGroup(req.url) ? slowReqs : generalReqs).push(req as (typeof listReqs)[number]);
}
console.log(`   · 分流:general ${generalReqs.length} · slow(限频域)${slowReqs.length} · 账本去重 skip ${knownSkipped}${dcBannedDropped ? ` · DC-ban drop ${dcBannedDropped}` : ''}`);

const slowQueue = await freshQueue('slow');
await mediumQueue.addRequests([...mediumReqs, ...paragraphReqs]);
await generalQueue.addRequests(generalReqs);
await slowQueue.addRequests(slowReqs);
await mirrorQueue.addRequests(mirrorReqs);

// 🆕 2026-07-01 代理池接入 · 2026-07-03 扩三池(老板给独立池 · 全在服务器 .env.local · 不进 git)
// PROXY_URL        主力池(10 节点)· general 队列
// PROXY_URL_MEDIUM medium 专用池 · mediumCrawler(RSS)+ slow 队列的 medium 域
// PROXY_URL_SLOW   403 四强专用池 · slow 队列的 slow403 域
// 🆕 2026-07-04 代理读取点 1/3(计划书 §5.5):DB(面板)优先 · env 兜底 · 回落主池语义留在本地
const PROXY_URL = getProxyUrl('main');
const PROXY_URL_MEDIUM = getProxyUrl('medium') || PROXY_URL;
const PROXY_URL_SLOW = getProxyUrl('slow') || PROXY_URL;
// 🆕 2026-07-03 老板拍 b:direct_hosts(steemit 等)代理被单独挑战 · 直连正常 → newUrlFunction 返 null 跳过代理
const proxyConfiguration = PROXY_URL ? new ProxyConfiguration({
    newUrlFunction: (_sessionId, options) => {
        const url = options?.request?.url ?? '';
        return url && isDirectHost(url) ? null : PROXY_URL;
    },
}) : undefined;
const mediumProxyConfiguration = PROXY_URL_MEDIUM ? new ProxyConfiguration({ proxyUrls: [PROXY_URL_MEDIUM] }) : undefined;
// slow 队列混两组域 · 按 request 域动态选池(medium 域 → 池 B · 403 四强 → 池 C)
const slowProxyConfiguration = PROXY_URL ? new ProxyConfiguration({
    newUrlFunction: (_sessionId, options) => {
        const url = options?.request?.url ?? '';
        return getThrottleGroup(url) === 'medium' ? PROXY_URL_MEDIUM : PROXY_URL_SLOW;
    },
}) : undefined;
console.log(PROXY_URL
    ? `🌐 代理池已接入 · 主力池 + medium 池${PROXY_URL_MEDIUM !== PROXY_URL ? '(独立)' : '(共用)'} + slow 池${PROXY_URL_SLOW !== PROXY_URL ? '(独立)' : '(共用)'}`
    : '⚠️ 无代理(PROXY_URL 未设)· 保守限速');

// 混合方案(2026-06-29 老板拍板 · 2026-07-01 代理池落地调优):
// - sameDomainDelaySecs=0: 真 bug 修复(queue 全同域 reclaim thrashing · 之前 60 秒/req)
// - useSessionPool=true: medium 实测对 RSS 也限速(IP 维度) · SessionPool 保留反爬韧性
// - 无代理 RPM=60/并发 3 保守;有代理 RPM=300/并发 10(轮换 IP 分散压力)
const mediumCrawler = new CheerioCrawler({
    requestQueue: mediumQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mediumRouter,
    proxyConfiguration: mediumProxyConfiguration,
    // 池 B 专用后不用怕 medium 限频 · 但 RSS 一共 ~170 个 · RPM 150 也就 1 分钟 · 稳字优先
    maxRequestsPerMinute: PROXY_URL ? cfgNum('medium_rpm', 150) : 60,
    maxConcurrency: PROXY_URL ? cfgNum('medium_cc', 5) : 3,
    sameDomainDelaySecs: 0,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/rss+xml', 'text/xml', 'application/atom+xml'],
    maxRequestRetries: 2,
    maxRequestsPerCrawl: process.env.MEDIUM_LIMIT ? Number(process.env.MEDIUM_LIMIT) : undefined,
    ...makeErrorHooks('medium'),
});

const generalCrawler = new CheerioCrawler({
    requestQueue: generalQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: defaultRouter,
    proxyConfiguration,
    // 有代理:每请求换 IP · 同域串行限制没必要 → delay 0 + 并发/RPM 拉高(实测 65 min 瓶颈就在这)
    maxRequestsPerMinute: PROXY_URL ? cfgNum('general_rpm', 600) : 300,
    maxConcurrency: PROXY_URL ? cfgNum('general_cc', 20) : 10,
    sameDomainDelaySecs: PROXY_URL ? 0 : 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: 2,
    ...makeErrorHooks('article-detail'),
});

// 🆕 2026-07-03 slow crawler · 限频域专用(medium 域 + 403 四强)· 双池按域动态选
// 低速慢啃 · 跟 general 并行 · 不占关键路径
const slowCrawler = new CheerioCrawler({
    requestQueue: slowQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: defaultRouter,
    proxyConfiguration: slowProxyConfiguration,
    maxRequestsPerMinute: cfgNum('slow_rpm', 60),
    maxConcurrency: cfgNum('slow_cc', 3),
    sameDomainDelaySecs: 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: 2,
    ...makeErrorHooks('article-detail'),
});

// 🆕 2026-06-30 mirror 独立 crawler · Atom feed · cf 反爬严 · sessionPool 高 retry
// 2026-07-01 挂代理(curl+代理仍 cf challenge · 但 impit TLS 指纹 + 新 IP 组合待真验)
const mirrorCrawler = new CheerioCrawler({
    requestQueue: mirrorQueue,
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: mirrorRouter,
    proxyConfiguration,
    maxRequestsPerMinute: cfgNum('mirror_rpm', 60),
    maxConcurrency: cfgNum('mirror_cc', 3),
    sameDomainDelaySecs: 2,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ['application/xml', 'application/atom+xml', 'text/xml'],
    maxRequestRetries: 3,
});

// 🆕 2026-07-03 全并行(老板拍 全量 ≤20min):各 crawler 独立 named queue · 无共享 state · 可安全并行
// (当年串行是防共享 default queue 的 ENOENT race · 分 queue 后此顾虑不存在 · 本轮真跑验证)
const t0 = performance.now();
const SKIP_MEDIUM = process.env.SKIP_MEDIUM === '1' || cfgBool('skip_medium');
const RUN_MIRROR = process.env.RUN_MIRROR === '1' || cfgBool('run_mirror');

const jobs: Promise<void>[] = [];

if (SKIP_MEDIUM) {
    console.log(`⊘ 跳过 mediumCrawler(SKIP_MEDIUM=1)· ${mediumReqs.length} 个 RSS 不抓`);
} else {
    console.log(`🚀 [并行] medium · ${mediumReqs.length + paragraphReqs.length} RSS`);
    jobs.push((async () => {
        const t = performance.now();
        await mediumCrawler.run();
        console.log(`   · medium 完成 ${((performance.now() - t) / 1000).toFixed(1)}s`);
    })());
}

if (substackByRss.size > 0) {
    console.log(`🚀 [并行] substack(node:fetch)· ${substackByRss.size} RSS`);
    jobs.push((async () => {
        const t = performance.now();
        const ds = await Dataset.open();
        const r = await fetchAndPushSubstack(substackByRss, ds);
        console.log(`   · substack 完成 ${((performance.now() - t) / 1000).toFixed(1)}s · ok=${r.ok} fail=${r.failed} pushed=${r.pushed}`);
    })());
}

if (rssByFeed.size > 0) {
    console.log(`🚀 [并行] rss(Impit 直拉)· ${rssByFeed.size} feed(主力池)`);
    jobs.push((async () => {
        const t = performance.now();
        const ds = await Dataset.open();
        const r = await fetchAndPushRssFeeds(rssByFeed, ds);
        console.log(`   · rss 完成 ${((performance.now() - t) / 1000).toFixed(1)}s · ok=${r.ok} fail=${r.failed} pushed=${r.pushed}`);
    })());
}

console.log(`🚀 [并行] general · ${generalReqs.length} URL(主力池 · 全速)`);
jobs.push((async () => {
    const t = performance.now();
    await generalCrawler.run();
    console.log(`   · general 完成 ${((performance.now() - t) / 1000).toFixed(1)}s`);
})());

if (slowReqs.length > 0) {
    console.log(`🚀 [并行] slow · ${slowReqs.length} URL(限频域 · 池 B/C 慢啃)`);
    jobs.push((async () => {
        const t = performance.now();
        await slowCrawler.run();
        console.log(`   · slow 完成 ${((performance.now() - t) / 1000).toFixed(1)}s`);
    })());
}

// mirror 默认跳过(cf JS challenge 实测 IP 无关 · 0 产出纯烧 2.5min)· RUN_MIRROR=1 显式打开(等 Playwright 方案)
if (RUN_MIRROR && mirrorReqs.length > 0) {
    console.log(`🚀 [并行] mirror · ${mirrorReqs.length} Atom(RUN_MIRROR=1)`);
    jobs.push((async () => {
        const t = performance.now();
        await mirrorCrawler.run();
        console.log(`   · mirror 完成 ${((performance.now() - t) / 1000).toFixed(1)}s`);
    })());
} else if (mirrorReqs.length > 0) {
    console.log(`⊘ mirror ${mirrorReqs.length} 源跳过(cf challenge 待 Playwright · RUN_MIRROR=1 打开)`);
}

// 🆕 2026-07-04 收尾容错(计划书 §3 契约):
// - SIGTERM(run-batch 超时先礼后兵):保存 seen + 部分账本再退(不再丢整轮)
// - 管线部分失败:照常 persistSeen + 按已完成部分写账本 · exitCode=1(run-batch 记 partial)
let exiting = false;
async function gracefulFinish(exitCode: number, reason: string): Promise<never> {
    if (exiting) process.exit(exitCode);
    exiting = true;
    try { await persistSeen(); } catch (e) { console.error('⚠️ persistSeen 失败:', (e as Error).message); }
    try { flushRun(snapshotStats()); } catch { /* flushRun 内部已隔离 · 双保险 */ }
    console.log(`🏁 收尾(${reason})· exit=${exitCode}`);
    process.exit(exitCode);
}
process.on('SIGTERM', () => { console.warn('⚠️ SIGTERM(超时被杀)· 保存已得部分…'); void gracefulFinish(1, 'SIGTERM'); });

let pipelineError: Error | null = null;
try {
    await Promise.all(jobs);
} catch (e) {
    pipelineError = e as Error;
    console.error(`🔴 管线整体失败(其余管线产出仍保留):${pipelineError.message}`);
}

const dt = ((performance.now() - t0) / 1000).toFixed(1);

const dataset = await Dataset.open();
const { items, count } = await dataset.getData({ limit: 100000 });
const byCrawler = items.reduce<Record<string, number>>((a, it) => {
    const k = (it.crawler as string) ?? 'unknown';
    a[k] = (a[k] ?? 0) + 1;
    return a;
}, {});

console.log(`\n✅ 总耗时 ${dt} 秒 · dataset ${count} 条`);
for (const [k, v] of Object.entries(byCrawler)) console.log(`   · ${k}: ${v}`);

await gracefulFinish(pipelineError ? 1 : 0, pipelineError ? `partial: ${pipelineError.message.slice(0, 80)}` : 'ok');
