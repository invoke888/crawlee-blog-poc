// 🆕 2026-07-03 自测战役修复单测(54 P0 / 7 P1 / 47 P2 · 证据 docs/research/self-test-audit-2026-07-03/)
// 覆盖:noise URL 判定 · 平台纠偏 · custom-domain RSS 转换 · 正文日期兜底 · 数据级 noise 过滤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
    isNoiseUrl,
    isLikelyArticleUrl,
    getPlatformOverride,
    getRssFeedOverride,
    getTokenExclusion,
    filterArticlesWhitelistFirst,
} from '../src/utils/article-filter.js';
import { mediumToRss, paragraphToRss } from '../src/handlers/medium.js';
import { extractVisibleDate } from '../src/utils/date-extract.js';

// cheerio dual package hazard · 同 test/date-extract.test.ts 的单点 cast 模式
type FixtureCheerioAPI = Parameters<typeof extractVisibleDate>[0];
function loadFixture(html: string): FixtureCheerioAPI {
    return cheerio.load(html) as unknown as FixtureCheerioAPI;
}

test('isNoiseUrl · medium 系统页(followers/activity/subpage 实锤 12 源)', () => {
    assert.equal(isNoiseUrl('https://blog.floki.com/followers?gi=6b92e9087a2f'), true);
    assert.equal(isNoiseUrl('https://blog.space.id/activity?gi=bcabb38ad31f'), true);
    assert.equal(isNoiseUrl('https://blog.altlayer.io/subpage/51a4b5b54099'), true);
    // collection_home_page 来源标记(合集页链接)· 普通 source= 参数不拦
    assert.equal(isNoiseUrl('https://news.aspecta.ai/x-5bdbc4175930?source=collection_home_page---4'), true);
    assert.equal(isNoiseUrl('https://blog.floki.com/monthly-ama-e053d3d7d67a?source=rss----abc'), false);
    // BNT /all?orderBy 列表页
    assert.equal(isNoiseUrl('https://blog.bancor.network/all?orderBy=earliest'), true);
});

test('isNoiseUrl · 列表/分页/归档(实锤 16 源)', () => {
    assert.equal(isNoiseUrl('https://blog.chainbase.com/p/2'), true); // C 分页
    assert.equal(isNoiseUrl('https://spotlight.tezos.com/1/'), true); // XTZ 页码
    assert.equal(isNoiseUrl('https://akash.network/blog/news/1/'), true); // AKT 分页
    assert.equal(isNoiseUrl('https://www.bitgo.com/resources/blog/2016/'), true); // WBTC 年份归档
    assert.equal(isNoiseUrl('https://www.nomina.io/blog-3'), true); // NOM blog-N
    assert.equal(isNoiseUrl('https://epicchain.io/blog/blog-all'), true); // EPIC blog-all
    assert.equal(isNoiseUrl('https://coin98.com/blog/tag/campaigns-events/'), true); // C98 tag
    assert.equal(isNoiseUrl('https://www.zetachain.com/blog/category/x/page/1'), true); // ZETA 分类分页
    assert.equal(isNoiseUrl('https://anoma.net/blog/authors/zach'), true); // XAN 作者归档
    assert.equal(isNoiseUrl('https://moca.network/blog/press/'), true); // MOCA 末段 press
    assert.equal(isNoiseUrl('https://www.safepal.com/en/blog/academy'), true); // SFP 末段 academy
    assert.equal(isNoiseUrl('https://blog.succinct.xyz/learn/'), true); // PROVE 末段 learn
    assert.equal(isNoiseUrl('https://usat.io/sitemap.html'), true); // USAT sitemap 文件名
    assert.equal(isNoiseUrl('https://blog.iqai.com/kr/'), true); // IQ 语言码末段
    assert.equal(isNoiseUrl('https://blog.zentry.com/th'), true); // ZENT 语言码末段
});

test('isNoiseUrl · 复测轮收网(stripExt/复合词/新末段 · 机器比对实锤)', () => {
    assert.equal(isNoiseUrl('https://steemit.com/login.html'), true); // 末段剥后缀匹配 landing
    assert.equal(isNoiseUrl('https://www.vaulta.com/privacy-policy'), true); // 复合词 landing 末段
    assert.equal(isNoiseUrl('https://www.awenetwork.ai/terms-of-service'), true);
    assert.equal(isNoiseUrl('https://www.orbs.com/jp/'), true); // 语言码 jp
    assert.equal(isNoiseUrl('https://www.safepal.com/en/blog/announcements'), true); // 分区列表末段
    assert.equal(isNoiseUrl('https://www.bitgo.com/resources/blog/industry/'), true);
    // 不误杀:末段 landing 词但有白名单段(真文章)· announcements 子路径
    assert.equal(isNoiseUrl('https://example.com/blog/why-security-matters/'), false);
    assert.equal(isNoiseUrl('https://example.com/announcements/big-launch'), false);
});

test('isNoiseUrl · 真文章不误杀', () => {
    assert.equal(isNoiseUrl('https://neo.org/blog/details/4320'), false); // 4 位 ID 非页码非年份
    assert.equal(isNoiseUrl('https://example.com/2026/07/some-article'), false); // 年份中段(WordPress 日期型)
    assert.equal(isNoiseUrl('https://kaitoblogs.substack.com/p/some-post'), false); // substack /p/slug
    assert.equal(isNoiseUrl('https://example.com/press/big-announcement'), false); // press 子路径是真文章
    assert.equal(isNoiseUrl('https://example.com/blog/kr-market-update'), false); // 语言码只拦纯末段
    assert.equal(isNoiseUrl('https://blog.sei.io/why-sei-is-fast/'), false);
});

test('isLikelyArticleUrl · noise 高于白名单(穿透根因修复)· 白名单仍赢 landing', () => {
    assert.equal(isLikelyArticleUrl('https://coin98.com/blog/tag/campaigns-events/'), false);
    assert.equal(isLikelyArticleUrl('https://akash.network/blog/news/1/'), false);
    assert.equal(isLikelyArticleUrl('https://moca.network/blog/press/'), false);
    // AVAX case 不回归(老板 2026-07-01 拍:白名单赢 landing)
    assert.equal(isLikelyArticleUrl('https://www.avax.network/about/blog/avalanche-research'), true);
    // 🆕 landing 扩充段(营销/产品页实锤)
    assert.equal(isLikelyArticleUrl('https://www.allora.network/partners'), false);
    assert.equal(isLikelyArticleUrl('https://neo.org/technology'), false);
    assert.equal(isLikelyArticleUrl('https://zeusnetwork.xyz/ecosystem'), false);
    assert.equal(isLikelyArticleUrl('https://blog.newton.xyz/signin/'), false);
    assert.equal(isLikelyArticleUrl('https://aave.com/pro'), false);
});

test('getRssFeedOverride/getTokenExclusion · 老板拍 a/c/d(通用 RSS 60 host + token 级排除)', () => {
    assert.equal(getRssFeedOverride('https://blog.sei.io/some-post'), 'https://blog.sei.io/feed');
    assert.equal(getRssFeedOverride('https://blog.orchid.com/'), 'https://blog.orchid.com/rss'); // feed 路径按探测结果
    assert.equal(getRssFeedOverride('https://www.chiliz.com/'), null); // sitemap-only 三站不进名单
    assert.equal(getRssFeedOverride('https://example.com/'), null);
    assert.ok(getTokenExclusion(11393)); // c 去重 EDGEX
    assert.ok(getTokenExclusion(2489)); // d 挂起 OPENAI
    assert.equal(getTokenExclusion(669), null); // EDGE 保留
    assert.equal(getTokenExclusion(12893), null); // RE 保留
});

test('getPlatformOverride · custom-domain 平台源纠偏(detect-feed 24 host)', () => {
    assert.equal(getPlatformOverride('https://blog.floki.com/'), 'medium');
    assert.equal(getPlatformOverride('https://blog.bittensor.com/some-post'), 'medium');
    assert.equal(getPlatformOverride('https://news.frax.com/'), 'substack');
    assert.equal(getPlatformOverride('https://blog.chainbase.com/'), 'paragraph');
    assert.equal(getPlatformOverride('https://example.com/blog'), null);
});

test('mediumToRss/paragraphToRss · custom-domain fallback /feed', () => {
    assert.equal(mediumToRss('https://blog.floki.com/'), 'https://blog.floki.com/feed');
    assert.equal(mediumToRss('https://medium.com/@somebody'), 'https://medium.com/feed/@somebody'); // 原逻辑不变
    assert.equal(mediumToRss('https://sub.medium.com/'), 'https://sub.medium.com/feed'); // 原逻辑不变
    assert.equal(paragraphToRss('https://blog.chainbase.com/'), 'https://blog.chainbase.com/feed');
    assert.equal(paragraphToRss('https://paragraph.com/@handle'), 'https://api.paragraph.com/blogs/rss/@handle'); // 原逻辑不变
});

test('extractVisibleDate · 正文可见日期兜底(37 源实锤)', () => {
    const d1 = extractVisibleDate(loadFixture('<html><body><article><h1>T</h1><span>May 25, 2026</span><p>body</p></article></body></html>'));
    assert.equal(d1.startsWith('2026-05-25'), true);
    const d2 = extractVisibleDate(loadFixture('<html><body><main>Published on June 27th, 2023 by team</main></body></html>'));
    assert.equal(d2.startsWith('2023-06-27'), true);
    const d3 = extractVisibleDate(loadFixture('<html><body><article>25 May 2026 — intro</article></body></html>'));
    assert.equal(d3.startsWith('2026-05-25'), true);
    const d4 = extractVisibleDate(loadFixture('<html><body><article>发布于 2026.10.28 正文</article></body></html>'));
    assert.equal(d4.startsWith('2026-10-28'), true);
    // 无日期 → 空;超范围年份不认
    assert.equal(extractVisibleDate(loadFixture('<html><body><article>no date here</article></body></html>')), '');
    assert.equal(extractVisibleDate(loadFixture('<html><body><article>Jan 1, 1999 old</article></body></html>')), '');
});

test('extractVisibleDate · 复审收紧(byline 优先 · 歧义放弃 · 美式日期)', () => {
    // byline 标记的日期赢过正文更早出现的事件日期(RESOLV/USAT 误锚实锤)
    const byline = extractVisibleDate(loadFixture(
        '<html><body><article>The incident on May 1, 2026 caused issues. Published June 10, 2026 by team.</article></body></html>',
    ));
    assert.equal(byline.startsWith('2026-06-10'), true);
    // 多个不同日期且无 byline → 歧义放弃(宁缺勿错)
    assert.equal(extractVisibleDate(loadFixture(
        '<html><body><article>On May 1, 2026 we saw X. Later June 10, 2026 brought Y.</article></body></html>',
    )), '');
    // 美式 MM/DD/YYYY(复审实锤格式)
    const us = extractVisibleDate(loadFixture('<html><body><main>Published 06/27/2023</main></body></html>'));
    assert.equal(us.startsWith('2023-06-27'), true);
    // 前词粘连容错('InsightsOctober 7, 2023' 类)
    const glued = extractVisibleDate(loadFixture('<html><body><article>InsightsOctober 7, 2023 body text</article></body></html>'));
    assert.equal(glued.startsWith('2023-10-07'), true);
});

test('filterArticlesWhitelistFirst · noise 硬丢(medium custom-domain 无白名单段时不再放行系统页)', () => {
    const items = [
        { url: 'https://blog.floki.com/followers?gi=1' },
        { url: 'https://blog.floki.com/real-post-abc123' },
    ];
    const out = filterArticlesWhitelistFirst(items);
    assert.deepEqual(out, [{ url: 'https://blog.floki.com/real-post-abc123' }]);
});
