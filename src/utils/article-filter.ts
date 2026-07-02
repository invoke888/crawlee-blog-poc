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
    file_extensions: string[];
    host_blacklist: string[];
    throttled_domains: Record<string, string[]>;
    dc_banned_hosts: string[];
};

export const WHITELIST_SEGMENTS = new Set(cfg.whitelist_segments);
export const LANDING_SEGMENTS = new Set(cfg.landing_segments);
export const HOST_BLACKLIST = new Set(cfg.host_blacklist);
const FILE_EXT_RE = new RegExp(`\\.(${cfg.file_extensions.join('|')})$`, 'i');

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

// sitemap URL 过滤主判定(给 main.ts sitemap 流用)
export function isLikelyArticleUrl(url: string): boolean {
    try {
        const u = new URL(url);
        const path = u.pathname.toLowerCase();
        const segs = path.split('/').filter(Boolean);
        if (segs.some((s) => WHITELIST_SEGMENTS.has(s))) return true;
        if (segs.some((s) => LANDING_SEGMENTS.has(s))) return false;
        if (FILE_EXT_RE.test(path)) return false;
        if (path === '/' || path === '') return false;
        return true;
    } catch {
        return false;
    }
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
// 1. 先丢文件型 URL
// 2. 该 token 有白名单 article → 只留白名单的 · 其余全丢
// 3. 无白名单 → 留全部非文件型
export function filterArticlesWhitelistFirst<T extends { url?: string }>(items: T[]): T[] {
    const real = items.filter((it) => !it.url || !isNonArticleFile(it.url));
    const white = real.filter((it) => it.url && isWhitelistedArticleUrl(it.url));
    return white.length > 0 ? white : real;
}
