// 🆕 2026-07-01 article URL 过滤单一真源
// 数据源 filter-config.json · 同一份配置给 python 聚合脚本(scripts/aggregate-report.py)读
// 判定优先级(老板 2026-07-01 拍):
//   1. 白名单段命中 → 是 article(即使 path 同时含 landing 段 · 例 AVAX /about/blog/x)
//   2. 黑名单段命中 → 不是
//   3. 文件后缀(.xml/.rss/...) → 不是(修 MINIMAX sitemap.xml bug)
//   4. 根路径 → 不是
//   5. 默认信任(sitemap 给的 URL)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cfg = require('./filter-config.json') as {
    whitelist_segments: string[];
    landing_segments: string[];
    noise_segments: string[];
    noise_last_segments: string[];
    platform_overrides: Record<string, string>;
    rss_feed_overrides: Record<string, string>;
    excluded_token_ids: Record<string, string>;
    file_extensions: string[];
    host_blacklist: string[];
    throttled_domains: Record<string, string[]>;
    dc_banned_hosts: string[];
    dead_hosts: string[];
    direct_hosts: string[];
    blocked_subdomain_prefixes?: string[];
};

function hostMatches(url: string, domains: Iterable<string>): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase();
        for (const d of domains) {
            if (h === d || h.endsWith(`.${d}`)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

// 🆕 2026-07-03 老板拍 c:永久放弃名单(非博客/死站/停更/平台封号 · agent 实测)
const DEAD_HOSTS = new Set(cfg.dead_hosts);
export function isDeadHost(url: string): boolean {
    return hostMatches(url, DEAD_HOSTS);
}

// 🆕 2026-07-03 老板拍 b:跳过代理直连名单(代理池 IP 在该域被单独挑战 · 直连正常)
const DIRECT_HOSTS = new Set(cfg.direct_hosts);
export function isDirectHost(url: string): boolean {
    return hostMatches(url, DIRECT_HOSTS);
}

export const WHITELIST_SEGMENTS = new Set(cfg.whitelist_segments);
export const LANDING_SEGMENTS = new Set(cfg.landing_segments);
export const HOST_BLACKLIST = new Set(cfg.host_blacklist);
const FILE_EXT_RE = new RegExp(`\\.(${cfg.file_extensions.join('|')})$`, 'i');

// 🆕 2026-07-03 自测战役 P0 修复(54 例 · 证据 docs/research/self-test-audit-2026-07-03/):
// noise 段 = 列表/归档/系统页 · 优先级高于白名单(/blog/tag/x 是 tag 归档不是文章 · 白名单先赢正是穿透根因)
// 末段形态 = 页码(/1/ /p/2)· 年份归档(/2016/)· blog-N 分页 · sitemap* · 列表专用段/语言码(仅末段才拦 · 子路径放行)
const NOISE_SEGMENTS = new Set(cfg.noise_segments ?? []);
const NOISE_LAST_SEGMENTS = new Set(cfg.noise_last_segments ?? []);
const PAGINATION_LAST_RE = /^(?:\d{1,3}|(?:19|20)\d{2}|(?:blog|news|posts?|articles?)-(?:all|\d{1,3}))$/;

// 列表/系统页 URL(采集 enqueue 与聚合/push 数据过滤共用同一语义)
// 末段先剥 .html/.php 类后缀再匹配(steemit.com/login.html 实锤:'login.html' ≠ 'login' 精确段)
const PAGE_EXT_RE = /\.(html?|php|aspx?)$/i;
export function isNoiseUrl(url: string): boolean {
    try {
        const u = new URL(url);
        const segs = u.pathname.toLowerCase().split('/').filter(Boolean);
        if (segs.some((s) => NOISE_SEGMENTS.has(s))) return true;
        const last = (segs[segs.length - 1] ?? '').replace(PAGE_EXT_RE, '');
        if (last && (PAGINATION_LAST_RE.test(last) || NOISE_LAST_SEGMENTS.has(last) || last.startsWith('sitemap'))) return true;
        if (last && LANDING_SEGMENTS.has(last) && !segs.some((s) => WHITELIST_SEGMENTS.has(s))) return true;
        // 🆕 2026-07-04 复检:法律页复合词末段(MEGA /rabbithole-terms-of-use 实锤 · 整段词穷举不动这类)
        if (last && /-(terms(-of-(use|service))?|privacy(-policy)?|disclaimer)$/.test(last)) return true;
        // medium 系统页/列表页 query 特征(合集主页来源标记 · 列表排序参数)
        if ((u.searchParams.get('source') ?? '').includes('collection_home_page')) return true;
        if (u.searchParams.has('orderBy')) return true;
        // 🆕 2026-07-04 复检:营销活动 UTM(SPURS 球衣发售推广卡实锤)
        if (/retail|promo/i.test(u.searchParams.get('utm_campaign') ?? '')) return true;
        return false;
    } catch {
        return false;
    }
}

function pathSegments(url: string): string[] | null {
    try {
        return new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
    } catch {
        return null;
    }
}

// URL path 段命中白名单(/blog/ /post/ 等)→ 视为真 article
export function isWhitelistedArticleUrl(url: string): boolean {
    const segs = pathSegments(url);
    return !!segs && segs.some((s) => WHITELIST_SEGMENTS.has(s));
}

// URL 是文件(sitemap.xml / feed.rss / 图片等)· 白名单优先级更高 · 调用方先判白名单
export function isNonArticleFile(url: string): boolean {
    try {
        return FILE_EXT_RE.test(new URL(url).pathname);
    } catch {
        return false;
    }
}

// URL path 段命中 landing 黑名单 · 白名单优先(命中白名单 → 不算 landing)
export function isLandingUrl(url: string): boolean {
    const segs = pathSegments(url);
    if (!segs) return false;
    if (segs.some((s) => WHITELIST_SEGMENTS.has(s))) return false;
    return segs.some((s) => LANDING_SEGMENTS.has(s));
}

// 🆕 2026-07-04 质量战役:docs./careers. 等子域不可能是博客(Falcon docs.* 混入实锤)
// 仅当 URL host ≠ 该源 blog_url host 才拦 —— SNT(status.app)/ORDI/GENIUS(docs.*)登记博客本体不误伤
const BLOCKED_SUB_PREFIXES = cfg.blocked_subdomain_prefixes ?? [];
export function hostOfUrl(url: string): string {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
export function isBlockedSubdomainUrl(url: string, sourceBlogHost?: string): boolean {
    const h = hostOfUrl(url);
    if (!h) return false;
    if (sourceBlogHost && h === sourceBlogHost.toLowerCase()) return false;
    return BLOCKED_SUB_PREFIXES.some((p) => h.startsWith(`${p}.`));
}

// 🆕 2026-07-04 质量战役:URL 路径日期(XMR/XCH 类 /YYYY/MM/DD/ 与 /YYYY-MM-DD-slug · 时间抽取最后兜底)
const URL_DATE_RE = /\/(20[0-3]\d)[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])(?:[/-]|$)/;
export function extractDateFromUrl(url: string): string {
    try {
        const m = URL_DATE_RE.exec(new URL(url).pathname);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
    } catch {
        return '';
    }
}

// 主域黑名单(gitbook/github · hhwl 误判博客源)
export function isBlacklistedHost(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase();
        for (const blocked of HOST_BLACKLIST) {
            if (h === blocked || h.endsWith(`.${blocked}`)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

// 严格 http/https 验证 · crawlee Request 只收这两种 protocol
// (isLikelyArticleUrl 的 new URL 太宽松 · mailto:/ipfs: 也能过 · 2026-07-02 LIST enqueue crash 教训)
export function isValidHttpUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// sitemap URL 过滤主判定(给 main.ts sitemap 流 + LIST enqueue 用)
// 🆕 2026-07-03 noise 判定前置(高于白名单):tag/page/followers 等列表系统页即使带 /blog/ 段也拦
export function isLikelyArticleUrl(url: string): boolean {
    try {
        const u = new URL(url);
        const path = u.pathname.toLowerCase();
        const segs = path.split('/').filter(Boolean);
        if (isNoiseUrl(url)) return false;
        if (segs.some((s) => WHITELIST_SEGMENTS.has(s))) return true;
        if (segs.some((s) => LANDING_SEGMENTS.has(s))) return false;
        if (FILE_EXT_RE.test(path)) return false;
        if (path === '/' || path === '') return false;
        return true;
    } catch {
        return false;
    }
}

// 🆕 2026-07-03 custom-domain 平台源纠偏(detect-feed 探测实锤):host → 真实平台
export function getPlatformOverride(url: string): string | null {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return cfg.platform_overrides?.[h] ?? null;
    } catch {
        return null;
    }
}

// 🆕 2026-07-03 老板拍 a:通用 RSS 源(ghost/wp/gatsby 等 60 host)· host → feed URL
export function getRssFeedOverride(url: string): string | null {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return cfg.rss_feed_overrides?.[h] ?? null;
    } catch {
        return null;
    }
}

// 🆕 2026-07-03 老板拍 c/d:token 级排除(去重/上游错配挂起)· 返回排除原因 · null=不排除
export function getTokenExclusion(tokenId: number): string | null {
    return cfg.excluded_token_ids?.[String(tokenId)] ?? null;
}

// 🆕 2026-07-03 DC-ban 名单(老板拍 b):AWS 段被整段 ban 的站(池 A/C 全 403)· 暂停采集
// 住宅代理接入后:filter-config.json 把域移回 throttled_domains 即恢复
const DC_BANNED = new Set(cfg.dc_banned_hosts);
export function isDcBannedHost(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase();
        for (const domain of DC_BANNED) {
            if (h === domain || h.endsWith(`.${domain}`)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

// 🆕 2026-07-03 限频域分组(老板拍 · 独立代理池):
// 'medium' = medium.com 及子域(429 重灾 · 池 B)· 'slow403' = 限频型 403 四强(池 C)· null = 主力池
export type ThrottleGroup = 'medium' | 'slow403' | null;
export function getThrottleGroup(url: string): ThrottleGroup {
    try {
        const h = new URL(url).hostname.toLowerCase();
        for (const [group, hosts] of Object.entries(cfg.throttled_domains)) {
            for (const domain of hosts) {
                if (h === domain || h.endsWith(`.${domain}`)) return group as ThrottleGroup;
            }
        }
        return null;
    } catch {
        return null;
    }
}

// 数据级白名单过滤(老板 2026-07-01 拍 · push.ts / 聚合共用同一语义):
// 1. 先丢文件型 URL + 🆕 noise URL(followers/tag/分页 · 修 medium custom-domain 源白名单不触发时系统页全放行)
// 2. 该 token 有白名单 article → 只留白名单的 · 其余全丢
// 3. 无白名单 → 留全部非文件非 noise
export function filterArticlesWhitelistFirst<T extends { url?: string }>(items: T[]): T[] {
    const real = items.filter((it) => !it.url || (!isNonArticleFile(it.url) && !isNoiseUrl(it.url)));
    const white = real.filter((it) => it.url && isWhitelistedArticleUrl(it.url));
    return white.length > 0 ? white : real;
}
