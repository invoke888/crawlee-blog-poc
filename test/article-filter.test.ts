// article URL 过滤单测 · 沉淀 2026-06-30 ~ 07-01 全部实战 case
// 跑法: npm test(node --test + tsx loader)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isLikelyArticleUrl,
    isWhitelistedArticleUrl,
    isLandingUrl,
    isNonArticleFile,
    isBlacklistedHost,
    isValidHttpUrl,
    isNoiseUrl,
    filterArticlesWhitelistFirst,
    getThrottleGroup,
    isDcBannedHost,
    isDeadHost,
    isDirectHost,
} from '../src/utils/article-filter.js';
import { normalizePublishedAt } from '../src/utils/normalize-date.js';
import { mediumToRss, paragraphToRss, substackToRss } from '../src/handlers/medium.js';
import { mirrorToAtom } from '../src/handlers/mirror.js';

test('isLikelyArticleUrl · 白名单优先', () => {
    // AVAX case(老板 2026-07-01 拍):/about/blog/x 含 /blog/ → 白名单赢过 about 黑名单
    assert.equal(isLikelyArticleUrl('https://www.avax.network/about/blog/avalanche-research'), true);
    assert.equal(isLikelyArticleUrl('https://www.minimax.io/blog/minimax-maxproof-math-proof-evolution'), true);
    assert.equal(isLikelyArticleUrl('https://kaitoblogs.substack.com/p/some-post'), true);
    assert.equal(isLikelyArticleUrl('https://example.com/news/latest'), true);
    assert.equal(isLikelyArticleUrl('https://example.com/insights/q3'), true);
    // 白名单优先甚至赢过文件后缀(拍板 tradeoff:/blog/post.json 信任)
    assert.equal(isLikelyArticleUrl('https://example.com/blog/post.json'), true);
    // 🆕 2026-07-03 自测战役行为变更(54 P0 实锤):noise 段高于白名单 · /blog/page/2 分页页拦掉
    assert.equal(isLikelyArticleUrl('https://example.com/blog/page/2'), false);
});

test('isLikelyArticleUrl · P0 chromia 不能误杀(默认信任)', () => {
    // 老板 2026-06-30 抽样发现的原始 P0:月份 slug 不命中任何白名单 · 必须默认 true
    assert.equal(isLikelyArticleUrl('https://chromia.com/may-2026-monthly-update/'), true);
    assert.equal(isLikelyArticleUrl('https://medium.com/coredao/some-article-2024'), true);
});

test('isLikelyArticleUrl · 段精确不误杀(includes bug 回归)', () => {
    // 旧 path.includes('/feed') 会误杀 /feedback · 段精确修掉
    assert.equal(isLikelyArticleUrl('https://example.com/feedback'), true);
    assert.equal(isLikelyArticleUrl('https://example.com/page-not-found'), true);
    assert.equal(isLikelyArticleUrl('https://example.com/blog/security-audit-2024'), true);
});

test('isLikelyArticleUrl · landing 黑名单(dataset 杂质实测段)', () => {
    assert.equal(isLikelyArticleUrl('https://holo.host/pricing/'), false);
    assert.equal(isLikelyArticleUrl('https://1inch.com/security'), false);
    assert.equal(isLikelyArticleUrl('https://flow.com/faq'), false);
    assert.equal(isLikelyArticleUrl('https://status.app/team'), false);
    assert.equal(isLikelyArticleUrl('https://example.com/about'), false);
    assert.equal(isLikelyArticleUrl('https://example.com/blog-x/category/web3/'), false);
});

test('isLikelyArticleUrl · 文件型 URL(MINIMAX sitemap.xml bug 回归)', () => {
    // 2026-07-01 老板报:MINIMAX 示例 article 是 sitemap.xml 本身
    assert.equal(isLikelyArticleUrl('https://www.minimaxi.com/sitemap.xml'), false);
    assert.equal(isLikelyArticleUrl('https://www.minimaxi.com/sitemap-0.xml'), false);
    assert.equal(isLikelyArticleUrl('https://example.com/feed.rss'), false);
    assert.equal(isLikelyArticleUrl('https://example.com/feed.atom'), false);
    assert.equal(isLikelyArticleUrl('https://example.com/foo.pdf'), false);
});

test('isLikelyArticleUrl · 根路径 + 畸形 URL', () => {
    assert.equal(isLikelyArticleUrl('https://example.com/'), false);
    assert.equal(isLikelyArticleUrl('not-a-url'), false);
});

test('isLandingUrl · 白名单优先抑制 landing 判定', () => {
    assert.equal(isLandingUrl('https://www.avax.network/about/blog/x'), false); // 白名单赢
    assert.equal(isLandingUrl('https://flow.com/faq'), true);
    assert.equal(isLandingUrl('https://example.com/some-article'), false); // 中性
});

test('isValidHttpUrl · 非 http 协议(2026-07-02 LIST enqueue crash 回归)', () => {
    // crash 真因:a[href] 抽出非 http 链接 · isLikelyArticleUrl 的 new URL 不挑协议放行
    // → crawlee addRequests 异步 batch 验证 url 失败 → unhandledRejection → 全进程死
    assert.equal(isValidHttpUrl('javascript:void(0)'), false);
    assert.equal(isValidHttpUrl('mailto:hi@example.com'), false);
    assert.equal(isValidHttpUrl('tel:+1234567890'), false);
    assert.equal(isValidHttpUrl('ipfs://QmHash/article'), false);
    assert.equal(isValidHttpUrl('not-a-url'), false);
    assert.equal(isValidHttpUrl('https://example.com/blog/x'), true);
    assert.equal(isValidHttpUrl('http://example.com'), true);
    // isLikelyArticleUrl 对这些确实放行(白名单段命中)· 所以必须 isValidHttpUrl 前置双保险
    assert.equal(isLikelyArticleUrl('ipfs://gateway/blog/x'), true);
});

test('isNonArticleFile', () => {
    assert.equal(isNonArticleFile('https://x.com/sitemap.xml'), true);
    assert.equal(isNonArticleFile('https://x.com/blog/a-post'), false);
});

test('isBlacklistedHost · gitbook/github(hhwl 误判源)', () => {
    assert.equal(isBlacklistedHost('https://blog.gitbook.io'), true);
    assert.equal(isBlacklistedHost('https://clanker.gitbook.io/clanker-documentation'), true);
    assert.equal(isBlacklistedHost('https://github.com/blorm-network/ZerePy/releases'), true);
    assert.equal(isBlacklistedHost('https://ondo.finance/blog'), false); // 老板确认真博客 · 不拉黑
});

test('filterArticlesWhitelistFirst · 数据级过滤语义(push.ts + 聚合共用)', () => {
    const mixed = [
        { url: 'https://x.com/blog/real-post' },
        { url: 'https://x.com/faq' },
        { url: 'https://x.com/sitemap.xml' },
    ];
    // 有白名单 → 只留白名单
    assert.deepEqual(filterArticlesWhitelistFirst(mixed), [{ url: 'https://x.com/blog/real-post' }]);
    // 无白名单 → 留全部非文件非 noise("有白名单才独占"语义不变)
    // 🆕 2026-07-03 复测轮:/faq 这类末段 landing 页也数据级丢弃(自测战役实锤)
    const noWhite = [
        { url: 'https://x.com/faq' },
        { url: 'https://x.com/sitemap.xml' },
        { url: 'https://x.com/some-page' },
    ];
    assert.deepEqual(filterArticlesWhitelistFirst(noWhite), [
        { url: 'https://x.com/some-page' },
    ]);
    // MINIMAX case:只有 sitemap.xml → 全丢 → 空
    assert.deepEqual(filterArticlesWhitelistFirst([{ url: 'https://www.minimaxi.com/sitemap.xml' }]), []);
});

test('normalizePublishedAt · Unix 时间戳(2026-07-03 OXT 体检实锤)', () => {
    assert.equal(normalizePublishedAt('1658775500'), '2022-07-25T18:58:20.000Z'); // 10 位秒
    assert.equal(normalizePublishedAt('1658775500000'), '2022-07-25T18:58:20.000Z'); // 13 位毫秒
    assert.equal(normalizePublishedAt('12345'), ''); // 5 位纯数字 · 不是时间戳 · 🆕 置空(B1 行为变更)
    assert.equal(normalizePublishedAt('0000000000'), ''); // 超范围 · 🆕 置空
});

test('normalizePublishedAt · 全格式(memory 待办的实测格式)', () => {
    assert.equal(normalizePublishedAt(''), '');
    assert.equal(normalizePublishedAt(null), '');
    assert.equal(normalizePublishedAt(undefined), '');
    assert.equal(normalizePublishedAt('2025-10-08T09:00:00-04:00'), '2025-10-08T13:00:00.000Z'); // WordPress 带时区
    assert.equal(normalizePublishedAt('2025-06-03T00:00:00.000Z'), '2025-06-03T00:00:00.000Z'); // no-op
    assert.equal(normalizePublishedAt('Mon, 21 Jul 2025 19:06:42 GMT'), '2025-07-21T19:06:42.000Z'); // RSS RFC-822
    assert.equal(normalizePublishedAt('  2025-06-03T00:00:00.000Z  '), '2025-06-03T00:00:00.000Z'); // trim
    assert.equal(normalizePublishedAt('invalid garbage'), ''); // 🆕 置空(BABY 'Insert Publish Date' 占位符实锤)
});

test('getThrottleGroup · 限频域分组(2026-07-03 独立池分流)', () => {
    // medium 生态 → 池 B
    assert.equal(getThrottleGroup('https://medium.com/feed/pivx'), 'medium');
    assert.equal(getThrottleGroup('https://trueusd.medium.com/some-post'), 'medium');
    // 主力池
    assert.equal(getThrottleGroup('https://chromia.com/blog/x'), null);
    assert.equal(getThrottleGroup('not-a-url'), null);
});

test('isDcBannedHost · DC-ban 四强(2026-07-03 老板拍 b · 住宅代理后恢复)', () => {
    assert.equal(isDcBannedHost('https://quant.network/news/x'), true);
    assert.equal(isDcBannedHost('https://blog.celestia.org/x'), true);
    assert.equal(isDcBannedHost('https://litecoin.com/blog/x'), true);
    assert.equal(isDcBannedHost('https://minaprotocol.com/blog/x'), true);
    assert.equal(isDcBannedHost('https://chromia.com/blog/x'), false);
    // DC-ban 域从 throttled 移除后 · getThrottleGroup 应返回 null
    assert.equal(getThrottleGroup('https://quant.network/news/x'), null);
});

test('isDeadHost / isDirectHost · agent 大调研名单(2026-07-03 老板拍 b/c)', () => {
    // dead:永久放弃(死站/非博客)
    // 🆕 2026-07-03 判死复核:cheems.pet 是 SPA 全路径同壳 → 转挂起(dead→dc_banned)
    assert.equal(isDeadHost('https://cheems.pet/blog'), false);
    assert.equal(isDcBannedHost('https://cheems.pet/blog'), true);
    assert.equal(isDeadHost('https://illuvium.medium.com/post'), true); // 子域精确 · 不连坐 medium.com
    assert.equal(isDeadHost('https://medium.com/feed/pivx'), false); // medium 主域受保护
    assert.equal(isDeadHost('https://chromia.com/blog/x'), false);
    // direct:跳过代理(steemit 代理被单独挑战 · 直连正常)
    assert.equal(isDirectHost('https://steemit.com/@steemitblog/post'), true);
    assert.equal(isDirectHost('https://chromia.com/blog/x'), false);
});

test('平台 URL → feed 转换', () => {
    // medium
    assert.equal(mediumToRss('https://arweave.medium.com/'), 'https://arweave.medium.com/feed');
    assert.equal(mediumToRss('https://medium.com/pivx'), 'https://medium.com/feed/pivx');
    // paragraph(实测 endpoint 在 api 子域)
    assert.equal(paragraphToRss('https://paragraph.com/@synapse-labs'), 'https://api.paragraph.com/blogs/rss/@synapse-labs');
    assert.equal(paragraphToRss('https://paragraph.com/@yieldbasis/some-post'), 'https://api.paragraph.com/blogs/rss/@yieldbasis');
    assert.equal(paragraphToRss('https://paragraph.com/notanhandle'), 'https://paragraph.com/notanhandle'); // passthrough
    // substack
    assert.equal(substackToRss('https://kaitoblogs.substack.com/'), 'https://kaitoblogs.substack.com/feed');
    // mirror(Atom)
    assert.equal(mirrorToAtom('https://mirror.xyz/aglddao.eth'), 'https://mirror.xyz/aglddao.eth/feed/atom');
    assert.equal(mirrorToAtom('https://aevo.mirror.xyz/'), 'https://aevo.mirror.xyz/feed/atom');
});

// 🆕 2026-07-05 核对战役(20 agent · 385 条三源核对)新增过滤规则回归
test('isNoiseUrl · 白名单词末段=栏目索引页(socios/chain.link/hive 实锤 · 存量核验零误伤)', () => {
    assert.equal(isNoiseUrl('https://www.socios.com/es/blog/'), true); // 语言首页尾斜杠
    assert.equal(isNoiseUrl('https://chain.link/newsroom'), true); // newsroom 也是白名单词
    assert.equal(isNoiseUrl('https://hive.blog/@hiveio/posts'), true); // 账号文章列表
    assert.equal(isNoiseUrl('https://www.twilio.com/en-us/blog/insights'), true); // 漏网的列表子页
    // 真文不受影响:白名单词在中段
    assert.equal(isNoiseUrl('https://www.socios.com/es/blog/some-article-slug'), false);
    assert.equal(isNoiseUrl('https://blog.chain.link/scale-defi/'), false);
});

test('isNoiseUrl · 新复合词末段带白名单保护(RIF/macropod/NAORIS 实锤)', () => {
    assert.equal(isNoiseUrl('https://rif.technology/terms-conditions/'), true);
    assert.equal(isNoiseUrl('https://example.com/terms-and-conditions'), true);
    assert.equal(isNoiseUrl('https://www.macropod.com/resources/travel-rule-faq'), true);
    assert.equal(isNoiseUrl('https://www.naorisprotocol.com/mica-compliance-white-paper'), true);
    // 白名单段保护:博客里的 FAQ/白皮书解读真文不误杀
    assert.equal(isNoiseUrl('https://example.com/blog/what-is-mica-faq'), false);
    assert.equal(isNoiseUrl('https://example.com/blog/reading-the-bitcoin-white-paper'), false);
});

test('isLikelyArticleUrl · thorchain 主站营销页(landing 词表扩充)', () => {
    assert.equal(isLikelyArticleUrl('https://thorchain.org/brand-assets'), false);
    assert.equal(isLikelyArticleUrl('https://thorchain.org/vision'), false);
    assert.equal(isLikelyArticleUrl('https://thorchain.org/bond-rune'), false);
    assert.equal(isLikelyArticleUrl('https://brl1.io/en/caso_de_uso'), false);
    assert.equal(isLikelyArticleUrl('https://www.naorisprotocol.com/exchanges'), false);
    // blog 子域真文不受影响
    assert.equal(isLikelyArticleUrl('https://blog.thorchain.org/affiliate-fees-on-thorchain'), true);
});

test('isBlacklistedHost · 非博客官网导航站(RVN/NAORIS 实锤 · 真博客在 medium 不受影响)', () => {
    assert.equal(isBlacklistedHost('https://ravencoin.org/halving/'), true);
    assert.equal(isBlacklistedHost('https://www.naorisprotocol.com/exchanges'), true);
    assert.equal(isBlacklistedHost('https://medium.com/naoris-protocol/some-post'), false);
});

test('normalizePublishedAt · 无年份日期 V8 默认 2001 → 当前年兜底(KAVA 实锤)', () => {
    const fixed = normalizePublishedAt('Wed Nov, 12');
    assert.notEqual(fixed, '');
    assert.equal(fixed.startsWith('2001'), false); // 不再落 2001
    const y = Number(fixed.slice(0, 4));
    const nowY = new Date().getFullYear();
    assert.equal(y === nowY || y === nowY - 1, true); // 当前年 · 未来>48h 则回退一年
    // 真 2001 年日期不受影响
    assert.equal(normalizePublishedAt('2001-11-12'), '2001-11-12T00:00:00.000Z');
});
