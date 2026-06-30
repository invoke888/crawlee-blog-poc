export const IGNORED_HOST_PATTERNS = [
    'binance.com',          // 交易所 · 不是 token 项目方 blog
    'okx.com',              // 交易所 · 同上
    'club.onefootball.com', // OFC · 粉丝俱乐部活动页 · 不是 blog
];

export function isIgnoredUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return IGNORED_HOST_PATTERNS.some((p) => host.includes(p));
    } catch {
        return false;
    }
}

// article URL 白名单(glob 风格 · 给 enqueueLinks 用)· 长期迭代
export const ARTICLE_GLOBS = [
    '**/blog/**',
    '**/post/**',
    '**/posts/**',
    '**/news/**',
    '**/article/**',
    '**/articles/**',
    '**/insights/**',
    '**/stories/**',
    '**/p/**',
    '**/202[0-9]/**',
    '**/announcements/**',
    '**/research/**',
    // 2026-06-29 老板拍板加(Bug B 扩名单)
    '**/writing/**',       // MIRA 类
    '**/press-center/**',  // GUN 类
    '**/updates/**',       // 项目方公告
    '**/media/**',         // 媒体页
    '**/journal/**',       // 期刊
    '**/dispatch/**',      // newsletter
    '**/announcement/**',
    // 🆕 2026-06-30 Explore agent 调研:42.6% 失败源是 sitemap 被过滤过严 · 加 21 个白名单
    // 证据:WOO sitemap 8660 URL → 过滤后 0 / SCR 36→0 / UNI 178→0
    '**/learn/**',         // learning hub
    '**/tutorial/**',
    '**/tutorials/**',
    '**/guide/**',
    '**/guides/**',
    '**/resource/**',      // vaulta.com/resources 类
    '**/resources/**',
    '**/education/**',
    '**/docs/**',          // 文档型博客
    '**/publication/**',
    '**/publications/**',
    '**/post-mortem/**',   // 事后分析
    '**/event/**',
    '**/events/**',
    '**/content/**',
    '**/column/**',
    '**/columns/**',
    '**/opinion/**',
    '**/analysis/**',
    '**/feature/**',
    '**/features/**',
    '**/interview/**',
    '**/interviews/**',
    '**/report/**',
    '**/reports/**',
    '**/case-study/**',
    '**/case-studies/**',
    '**/whitepaper/**',
    '**/whitepapers/**',
    '**/technical/**',
    '**/deep-dive/**',
];

// URL_OVERRIDES · hhwl 数据 URL 错的硬改 · 老板维护 · 长期清单
// key = base_symbol(因为 token_id 难记) · value = 正确 blog_url
export const URL_OVERRIDES: Record<string, string> = {
    MEW: 'https://mew.xyz/news', // 老板指出:hhwl 给的是 /media · 真实是 /news
};

// 非 article URL 黑名单(glob 风格)· 长期迭代
export const NON_ARTICLE_GLOBS = [
    '**/about*',
    '**/contact*',
    '**/privacy*',
    '**/terms*',
    '**/legal*',
    '**/login*',
    '**/signup*',
    '**/register*',
    '**/page/*',
    '**/category/*',
    '**/tag/*',
    '**/author/*',
    '**/feed/*',
    '**/rss/*',
    '**/sitemap*',
    '**/*.{jpg,jpeg,png,gif,pdf,zip,svg,webp,mp4}',
];

// 🆕 2026-06-30 hhwl 主域黑名单 · 这些被误判为博客 · 实际是 docs / repo / 平台
// 不影响 sources.db · main.ts 加载时 filter
export const HOST_BLACKLIST = new Set<string>([
    'gitbook.io',     // docs 平台 · 不是博客
    'github.com',     // 代码仓库 · 不是博客(如 ZEREBRO /releases)
    'github.io',      // GitHub Pages · 主要 docs / landing
]);

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

// 简单"URL 像 article"判断(给 sitemap URL 过滤用)
export function isLikelyArticleUrl(url: string): boolean {
    try {
        const u = new URL(url);
        const path = u.pathname.toLowerCase();

        // 🆕 2026-06-30 改"段精确匹配" · path.includes 会误杀 `/blog/about-our-product`
        // 实测 dataset 95/2940 (3%) 强杂质 · 都是 path 段命中 landing 关键词
        // 段精确:URL 路径分段后 · 任一段命中即 reject(不影响 article 标题里含同字 slug)
        const blackPathSegments = new Set([
            'about', 'contact', 'privacy', 'terms', 'legal',
            'login', 'signup', 'register',
            'category', 'categories', 'tag', 'tags', 'author',
            'feed', 'rss', 'sitemap',
            'page', 'search', 'archive', 'embed',
            // 🆕 dataset 杂质分析新加(team:20 / faq:15 / docs:15 / careers:13 / pricing:7 / security:6 / cookies:4 / jobs:2 / disclaimer:2 / imprint:1 / settings:1)
            'team', 'faq', 'docs', 'careers', 'pricing', 'security',
            'cookies', 'jobs', 'disclaimer', 'imprint', 'settings', 'support', 'help',
        ]);
        // 🆕 2026-06-30 老板拍:URL 段命中白名单 → 直接 true · 跳过黑名单
        // 防误伤真 article (例 AVAX `/about/blog/x` · 含 /blog/ 是真 article · 黑名单 about 会误杀)
        const articleWhitePathSegments = new Set([
            'blog', 'post', 'posts', 'article', 'articles', 'news', 'insights',
            'stories', 'update', 'updates', 'entries', 'journal',
            'release', 'releases',
            'p', // substack 用 /p/<slug>
        ]);
        const segs = path.split('/').filter(Boolean);
        if (segs.some((s) => articleWhitePathSegments.has(s))) return true;
        if (segs.some((s) => blackPathSegments.has(s))) return false;

        // 🆕 2026-07-01 加 xml/rss/atom/txt/json/csv · 修 MINIMAX sitemap.xml 被当 article 抓 bug
        const fileExt = /\.(jpg|jpeg|png|gif|pdf|zip|svg|webp|mp4|css|js|xml|rss|atom|txt|json|csv)$/i;
        if (fileExt.test(path)) return false;

        // 🆕 2026-06-30 改"默认 true · 只过黑名单"
        // 老板实测发现:chromia 用 /may-2026-monthly-update/ 这种月份 slug · 不命中任何白名单关键词
        // 之前"必须命中白名单"逻辑 → 误杀大量真 article
        // 修法:sitemap 里的 URL 默认信任 · 只过明确不是 article 的(category / about / 文件等)

        // 根路径不要(首页)
        if (path === '/' || path === '') return false;

        // 默认信任 sitemap 给的 URL
        return true;
    } catch {
        return false;
    }
}
