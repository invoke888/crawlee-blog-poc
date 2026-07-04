// 🆕 2026-07-04 per-source 时间规则引擎单测(老板拍:站点定制根治时间抽取)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractPublishedAt, type DateRule } from '../src/utils/date-extract.js';

type FixtureCheerioAPI = Parameters<typeof extractPublishedAt>[0];
const load = (html: string): FixtureCheerioAPI => cheerio.load(html) as unknown as FixtureCheerioAPI;

// 模板 jsonld 污染型页面:jsonld 是站级假值 · 可见 byline 是真值(WLD/SAPIEN 家族)
const POLLUTED = `<html><head>
  <script type="application/ld+json">{"@type":"Article","datePublished":"2026-05-07T00:00:00Z"}</script>
  </head><body><div class="post-meta"><time datetime="2024-11-01T10:00:00Z">Nov 1, 2024</time></div></body></html>`;

test('date-rules · 无规则时走通用梯队(time 标签在 jsonld 之前 · 现状语义)', () => {
    assert.equal(extractPublishedAt(load(POLLUTED), 'https://x.com/blog/a', null), '2024-11-01T10:00:00Z');
});

test('date-rules · ban jsonld:模板值被跳过 · 其余梯队照走', () => {
    const onlyLd = `<html><head><script type="application/ld+json">{"@type":"Article","datePublished":"2026-05-07"}</script></head><body></body></html>`;
    assert.equal(extractPublishedAt(load(onlyLd), 'https://x.com/blog/a', { ban: ['jsonld'] }), '');
    assert.equal(extractPublishedAt(load(onlyLd), 'https://x.com/blog/a', null), '2026-05-07');
});

test('date-rules · selector 定点优先于一切梯队', () => {
    const rule: DateRule = { selector: '.post-meta time', attr: 'datetime', ban: ['jsonld'] };
    assert.equal(extractPublishedAt(load(POLLUTED), 'https://x.com/blog/a', rule), '2024-11-01T10:00:00Z');
});

test('date-rules · selector text + regex 提取', () => {
    const html = `<html><body><div class="byline">Published on March 13, 2025 by Team</div></body></html>`;
    const rule: DateRule = { selector: '.byline', attr: 'text', regex: '([A-Z][a-z]+ \\d{1,2}, \\d{4})' };
    assert.equal(extractPublishedAt(load(html), 'https://x.com/blog/a', rule), 'March 13, 2025');
});

test('date-rules · selector 落空回退通用梯队(站点改版兜底)', () => {
    const rule: DateRule = { selector: '.gone-class time', attr: 'datetime' };
    assert.equal(extractPublishedAt(load(POLLUTED), 'https://x.com/blog/a', rule), '2024-11-01T10:00:00Z');
});

test('date-rules · strategy url_date / none / spa_only', () => {
    const $ = load(POLLUTED);
    assert.equal(extractPublishedAt($, 'https://x.com/blog/2025/01/05/post', { strategy: 'url_date' }), '2025-01-05');
    assert.equal(extractPublishedAt($, 'https://x.com/blog/a', { strategy: 'none' }), '', '显式放弃不瞎抽');
    assert.equal(extractPublishedAt($, 'https://x.com/blog/a', { strategy: 'spa_only' }), '', 'SPA 等 Playwright');
});

test('date-rules · ban meta 跳过全部 meta 层', () => {
    const html = `<html><head><meta property="article:published_time" content="2026-01-01"><meta name="date" content="2026-01-02"></head><body></body></html>`;
    assert.equal(extractPublishedAt(load(html), 'https://x.com/blog/a', null), '2026-01-01');
    assert.equal(extractPublishedAt(load(html), 'https://x.com/blog/a', { ban: ['meta'] }), '');
});
