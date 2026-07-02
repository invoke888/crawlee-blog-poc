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
    // 🆕 2026-07-03 agent 大调研修正(老板拍 a)· 证据在 docs/research/
    UMA: 'https://blog.uma.xyz', // 站方 sitemap 写错自己域名(uma.blog.xyz 不存在)
    USDT: 'https://tether.to/en/blog/', // 原配置路径错 · 照抄同公司 XAUT(实测 24 篇)
    BANK: 'https://lorenzo-protocol.ghost.io', // 真身 Ghost CMS · 原 www.lorenzo-protocol.xyz 是 JS 壳
    FARTCOIN: 'https://www.infinitebackrooms.com/', // 原配置指到单篇叶子页 · 根路径直出 102 条
    CRO: 'https://blog.cronos.com', // 项目迁移 · 新博客是 Substack(旧 blog.cronos.org cf 1014)
    PLAY: 'https://playsout.com/news.html', // www 子域证书失效 + 缺 .html(注:内容是三方聚合 · 老板知悉)
    // 🆕 2026-07-03 第二批(17 agent pattern 审计 · 证据 docs/research/)
    DEEP: 'https://blog.sui.io/', // 原记成一篇具体文章 · prefix_ratio 假阳性根因
    PROS: 'https://www.pharos.xyz/blog', // 原 /resources 是资源页 · 真文章在 /blog(已采 14/26 命中)
    HYPER: 'https://www.hyperlane.xyz/blog-posts-new', // 旧 /blog 零文章 · 73 篇已迁 /blog-posts-new
    SPURS: 'https://www.tottenhamhotspur.com/news', // 原 /media 301 失效 · 真新闻 /news/<id>/<slug>
    LYN: 'https://everlyn.ai/posts/', // 原采样全落姊妹域 everlyn.app 工具页 · 真博客 everlyn.ai/posts
    PEAQ: 'https://www.peaq.xyz/learn/blog', // 原 /community/blog 301 · 已迁 /learn/blog
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

// 🆕 2026-07-01 过滤逻辑收敛到 utils/article-filter.ts(唯一真源 filter-config.json)
// re-export 保持 main.ts / article.ts 等调用方 import 路径不变
export { isLikelyArticleUrl, isBlacklistedHost, HOST_BLACKLIST } from './utils/article-filter.js';
