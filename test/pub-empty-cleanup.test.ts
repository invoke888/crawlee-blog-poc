// 🆕 2026-07-18 pub空清查战役规则增量(老板拍A · 6 agent 28 host 调研落地)
// 调研结论 vs 规则库比对后真改动收敛为:ALLO 新规则 + lgl. 黑子域;TWLO/CSPR/TREE 等库里早有规则(回归锁防误删)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractPublishedAt, rulesFor } from '../src/utils/date-extract.js';
import { isBlockedSubdomainUrl } from '../src/utils/article-filter.js';

type FixtureCheerioAPI = Parameters<typeof extractPublishedAt>[0];
const load = (html: string): FixtureCheerioAPI => cheerio.load(html) as unknown as FixtureCheerioAPI;

test('ALLO · 新规则:可见 byline selector(区分 Webflow 站级构建戳与 related 网格)', () => {
    const rule = rulesFor('https://www.allora.network/blog/x')?.date;
    assert.equal(rule?.selector, '.blog-header-contain .blog-grid-date');
    const html = `<html><body><!-- Last Published: Wed Jul 08 2026 --><div class="blog-header-contain"><h1>title</h1><div class="blog-grid-date">July 25, 2024</div></div>
      <div class="related"><div class="blog-grid-date">November 13, 2025</div></div></body></html>`;
    assert.equal(extractPublishedAt(load(html), 'https://www.allora.network/blog/x', rule), 'July 25, 2024');
});

test('lgl. 黑子域 · SKR 政策页跨子域外链拦截(误伤面全库扫=0 仅政策页命中)', () => {
    assert.equal(isBlockedSubdomainUrl('https://lgl.solanamobile.com/cookie-policy-web', 'blog.solanamobile.com'), true);
    // 源自身就是 lgl. 域时不拦(黑子域机制既有保护语义)
    assert.equal(isBlockedSubdomainUrl('https://lgl.solanamobile.com/x', 'lgl.solanamobile.com'), false);
});

test('回归锁 · 复查确认的既有规则不许被误删(2026-07-17 调研维持原判)', () => {
    assert.equal(rulesFor('https://www.casper.network/news/x')?.date?.strategy, 'none');      // CSPR 确证无字段
    assert.equal(rulesFor('https://www.treehouse.finance/blog/x')?.date?.strategy, 'html_regex'); // TREE RSC 流
    assert.ok(rulesFor('https://www.twilio.com/en-us/blog/x')?.date?.selector);               // TWLO AEM selector
    assert.equal(rulesFor('https://katana.network/blog/x')?.date?.strategy, 'none');          // KAT 全站无日期
    assert.equal(rulesFor('https://zebec.io/blog/x')?.date?.strategy, 'none');                // ZBCN 模板无日期
    assert.equal(rulesFor('https://billions.network/blog/x')?.date?.strategy, 'none');        // BILL CMS 空绑定
});
