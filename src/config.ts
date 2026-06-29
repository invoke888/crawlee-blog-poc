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

// 简单"URL 像 article"判断(给 sitemap URL 过滤用)
export function isLikelyArticleUrl(url: string): boolean {
    try {
        const u = new URL(url);
        const path = u.pathname.toLowerCase();

        const blackSegments = [
            '/about', '/contact', '/privacy', '/terms', '/legal',
            '/login', '/signup', '/register',
            '/category/', '/categories/', '/tag/', '/tags/', '/author/',
            '/feed', '/rss', '/sitemap',
            '/page/', '/search', '/archive',
        ];
        if (blackSegments.some((s) => path.includes(s))) return false;

        const fileExt = /\.(jpg|jpeg|png|gif|pdf|zip|svg|webp|mp4|css|js)$/i;
        if (fileExt.test(path)) return false;

        const whiteSegments = [
            '/blog/', '/post/', '/posts/',
            '/news/', '/article', '/articles/',
            '/insights/', '/stories/', '/p/',
            '/announcements/', '/research/',
            '/2023/', '/2024/', '/2025/', '/2026/',
        ];
        if (whiteSegments.some((s) => path.includes(s))) return true;

        return false;
    } catch {
        return false;
    }
}
