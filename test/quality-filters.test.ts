// 🆕 2026-07-04 质量战役单测:规则增量命中 / 白名单优先零误伤 / noise_last 末段语义 / 黑子域 host 对照 / URL 日期
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isLikelyArticleUrl, isLandingUrl, isNoiseUrl, isBlockedSubdomainUrl, extractDateFromUrl,
} from '../src/utils/article-filter.js';

test('质量战役 · 新 landing 词拦截(agent 审计实锤源)', () => {
    // DIA use-cases(老板实锤)
    assert.equal(isLikelyArticleUrl('https://www.diadata.org/use-cases/tokenized-rwas/'), false);
    assert.equal(isLandingUrl('https://www.diadata.org/use-cases/'), true);
    // DIA /app/ 数据页(28 条)
    assert.equal(isLikelyArticleUrl('https://www.diadata.org/app/price/asset/Arbitrum/0x0c88/'), false);
    // Ripple 产品线
    assert.equal(isLikelyArticleUrl('https://ripple.com/solutions/prime-brokerage/'), false);
    assert.equal(isLikelyArticleUrl('https://ripple.com/industry/banking/'), false);
    assert.equal(isLikelyArticleUrl('https://ripple.com/impact/'), false);
    // AVAX/chain.link/akash/maple/livepeer
    assert.equal(isLikelyArticleUrl('https://www.avax.network/build/developer-hub'), false);
    assert.equal(isLikelyArticleUrl('https://chain.link/platform'), false);
    assert.equal(isLikelyArticleUrl('https://chain.link/data-feeds'), false);
    assert.equal(isLikelyArticleUrl('https://akash.network/token/'), false);
    assert.equal(isLikelyArticleUrl('https://akash.network/gpus-on-demand/'), false);
    assert.equal(isLikelyArticleUrl('https://maple.finance/earn/maple-institutional'), false);
    assert.equal(isLikelyArticleUrl('https://maple.finance/transparency'), false);
    assert.equal(isLikelyArticleUrl('https://livepeer.org/primer'), false);
    assert.equal(isLikelyArticleUrl('https://brl1.io/como_funciona'), false);
    assert.equal(isLikelyArticleUrl('https://www.opengradient.ai/mediakit'), false);
    assert.equal(isLikelyArticleUrl('https://pocket.network/press-kit/'), false);
});

test('质量战役 · noise_last 只拦末段(栏目索引页)· 中段真文放行', () => {
    // BitGo 分类索引页(末段 engineering/product)
    assert.equal(isNoiseUrl('https://www.bitgo.com/resources/blog/engineering/'), true);
    assert.equal(isNoiseUrl('https://www.bitgo.com/resources/blog/product/'), true);
    // world.org 栏目页
    assert.equal(isNoiseUrl('https://world.org/blog/product'), true);
    assert.equal(isNoiseUrl('https://world.org/blog/how-to'), true);
    assert.equal(isNoiseUrl('https://world.org/blog/policy'), true);
    // macropod 列表页(末段 resources)拦 · 真文(末段 slug)放行
    assert.equal(isNoiseUrl('https://www.macropod.com/resources'), true);
    assert.equal(isLikelyArticleUrl('https://www.macropod.com/resources/audm-hops-onto-base'), true);
    // Twilio 真教程:developers/tutorials/integrations 全在中段 → 放行(防误伤铁证)
    assert.equal(isLikelyArticleUrl('https://www.twilio.com/en-us/blog/developers/tutorials/integrations/patient-appointment-scheduling'), true);
    assert.equal(isNoiseUrl('https://www.twilio.com/en-us/blog/developers/tutorials/integrations/patient-appointment-scheduling'), false);
    // Twilio 栏目索引(末段 products)拦 · 真产品新闻文放行
    assert.equal(isNoiseUrl('https://www.twilio.com/en-us/blog/products'), true);
    assert.equal(isLikelyArticleUrl('https://www.twilio.com/en-us/blog/products/compliance-toolkit-generally-available'), true);
    // substack 占位页:noise 优先级高于白名单 /p/
    assert.equal(isNoiseUrl('https://runonflux.substack.com/p/coming-soon'), true);
    assert.equal(isLikelyArticleUrl('https://runonflux.substack.com/p/coming-soon'), false);
    // turtle 真文(guides 在中段)放行
    assert.equal(isLikelyArticleUrl('https://www.turtle.xyz/blog/guides/how-design-liquidity-mining-campaign-that'), true);
});

test('质量战役 · 黑子域 host 对照(登记博客本体不误伤)', () => {
    // docs 子域混入(Falcon 型):与源 host 不同 → 拦
    assert.equal(isBlockedSubdomainUrl('https://docs.falconfinance.io/whitepaper', 'falconfinance.io'), true);
    assert.equal(isBlockedSubdomainUrl('https://careers.example.com/x', 'example.com'), true);
    // ORDI/GENIUS:blog_url 本身就是 docs.* → 放行
    assert.equal(isBlockedSubdomainUrl('https://docs.ordinals.com/inscriptions.html', 'docs.ordinals.com'), false);
    // SNT:status.app 是主域不是 status. 子域 → 前缀不匹配放行
    assert.equal(isBlockedSubdomainUrl('https://status.app/blog/x', 'status.app'), false);
    // 无源 host 信息时仍拦明确前缀
    assert.equal(isBlockedSubdomainUrl('https://docs.foo.com/x'), true);
    assert.equal(isBlockedSubdomainUrl('https://blog.foo.com/x'), false);
});

test('质量战役 · URL 路径日期兜底(XMR/XCH 实锤)', () => {
    assert.equal(extractDateFromUrl('https://www.getmonero.org/2026/06/30/monero-gui-release.html'), '2026-06-30');
    assert.equal(extractDateFromUrl('https://example.com/blog/2025-01-05-my-post'), '2025-01-05');
    assert.equal(extractDateFromUrl('https://example.com/blog/my-post'), '');
    assert.equal(extractDateFromUrl('https://example.com/2099/99/99/x'), '');   // 非法月日不吃
    assert.equal(extractDateFromUrl('https://example.com/v2/2500-units'), '');  // 不是日期形态
});

test('质量战役 · 白名单继续先赢 landing(AVAX /about/blog/x 老例)', () => {
    assert.equal(isLikelyArticleUrl('https://www.avax.network/about/blog/some-real-post'), true);
    assert.equal(isLandingUrl('https://www.avax.network/about/blog/some-real-post'), false);
});
