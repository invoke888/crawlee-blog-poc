// published_at/description/h1 抽取梯队单测 · 沉淀 2026-07-03(修 208 源缺 published_at 问题)
// 跑法: npm test(node --test + tsx loader)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractH1, extractJsonLdMeta, extractNextDataDate } from '../src/utils/date-extract.js';

// cheerio 包 CJS/ESM 各有一份 .d.ts(dual package hazard · 同 date-extract.ts 顶部注释)
// 测试文件是 ESM · cheerio.load() 原生返回 ESM 侧类型 · 跟 extractXxx 参数期望的 CJS 侧类型对不上(TS2345)
// 用 Parameters<> 从函数签名反推期望类型 · 单点 cast · 不用到处散 as
type FixtureCheerioAPI = Parameters<typeof extractJsonLdMeta>[0];
function loadFixture(html: string): FixtureCheerioAPI {
    return cheerio.load(html) as unknown as FixtureCheerioAPI;
}

test('extractJsonLdMeta · 单对象 BlogPosting 全字段抽取', () => {
    const $ = loadFixture(`<html><head>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"BlogPosting","headline":"Test Post","datePublished":"2025-06-01T12:00:00Z","dateModified":"2025-06-02T08:30:00Z","description":"A great post about testing."}
        </script>
    </head><body></body></html>`);
    const meta = extractJsonLdMeta($);
    assert.equal(meta.datePublished, '2025-06-01T12:00:00Z');
    assert.equal(meta.dateModified, '2025-06-02T08:30:00Z');
    assert.equal(meta.description, 'A great post about testing.');
});

test('extractJsonLdMeta · @type 数组形式也能识别(NewsArticle/Article 混排)', () => {
    const $ = loadFixture(`<script type="application/ld+json">
        {"@type":["Article","WebPage"],"datePublished":"2024-03-15T00:00:00Z","description":"Array type test."}
    </script>`);
    const meta = extractJsonLdMeta($);
    assert.equal(meta.datePublished, '2024-03-15T00:00:00Z');
    assert.equal(meta.description, 'Array type test.');
    assert.equal(meta.dateModified, ''); // 没提供 · 保持空串
});

test('extractJsonLdMeta · 顶层数组 · 挑出 Article 类型节点(忽略 Organization)', () => {
    const $ = loadFixture(`<script type="application/ld+json">
        [
          {"@type":"Organization","name":"Acme Inc","description":"公司简介不该被抽到"},
          {"@type":"NewsArticle","datePublished":"2023-11-20T09:15:00Z","description":"News desc."}
        ]
    </script>`);
    const meta = extractJsonLdMeta($);
    assert.equal(meta.datePublished, '2023-11-20T09:15:00Z');
    assert.equal(meta.description, 'News desc.');
});

test('extractJsonLdMeta · @graph 嵌套(WordPress Yoast 插件常见)', () => {
    const $ = loadFixture(`<script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[
          {"@type":"WebSite","name":"Example Site"},
          {"@type":"BlogPosting","datePublished":"2022-01-05T18:00:00Z","dateModified":"2022-01-06T00:00:00Z","description":"Graph desc."}
        ]}
    </script>`);
    const meta = extractJsonLdMeta($);
    assert.equal(meta.datePublished, '2022-01-05T18:00:00Z');
    assert.equal(meta.dateModified, '2022-01-06T00:00:00Z');
    assert.equal(meta.description, 'Graph desc.');
});

test('extractJsonLdMeta · 坏 JSON 不抛错 · 跳过继续找下一个 script', () => {
    const $ = loadFixture(`
        <script type="application/ld+json">{not valid json,,,</script>
        <script type="application/ld+json">{"@type":"Article","datePublished":"2021-07-04T10:00:00Z","description":"Second script works."}</script>
    `);
    assert.doesNotThrow(() => extractJsonLdMeta($));
    const meta = extractJsonLdMeta($);
    assert.equal(meta.datePublished, '2021-07-04T10:00:00Z');
    assert.equal(meta.description, 'Second script works.');
});

test('extractJsonLdMeta · 无 ld+json / 无 Article 系节点 → 全空不误抓', () => {
    const noScript = loadFixture('<html><head></head><body><h1>no ld+json</h1></body></html>');
    const empty1 = extractJsonLdMeta(noScript);
    assert.deepEqual(empty1, { datePublished: '', dateModified: '', description: '' });

    const onlyOrg = loadFixture(`<script type="application/ld+json">
        {"@type":"Organization","name":"Acme","description":"不该被抽到 · Organization 不在白名单类型里"}
    </script>`);
    const empty2 = extractJsonLdMeta(onlyOrg);
    assert.deepEqual(empty2, { datePublished: '', dateModified: '', description: '' });
});

test('extractJsonLdMeta · 跨 script 合并缺失字段(不覆盖已找到的值)', () => {
    const $ = loadFixture(`
        <script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2020-05-05T05:05:05Z"}</script>
        <script type="application/ld+json">{"@type":"BlogPosting","description":"Merged from second script."}</script>
    `);
    const meta = extractJsonLdMeta($);
    assert.equal(meta.datePublished, '2020-05-05T05:05:05Z');
    assert.equal(meta.description, 'Merged from second script.');
    assert.equal(meta.dateModified, '');
});

test('extractNextDataDate · 嵌套 pageProps 路径 + 同层键优先级(publishedAt 赢 date)', () => {
    const deep = loadFixture(`<script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"post":{"title":"Hi","createdAt":"2025-09-10T14:00:00.000Z"}}}}
    </script>`);
    assert.equal(extractNextDataDate(deep), '2025-09-10T14:00:00.000Z');

    const priority = loadFixture(`<script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"date":"2019-01-01T00:00:00Z","publishedAt":"2025-02-02T02:02:02Z"}}}
    </script>`);
    assert.equal(extractNextDataDate(priority), '2025-02-02T02:02:02Z');
});

test('extractNextDataDate · 无 __NEXT_DATA__ / 坏 JSON / 无日期键 → 空串不抛错', () => {
    const noScript = loadFixture('<html><body><h1>no next data here</h1></body></html>');
    assert.equal(extractNextDataDate(noScript), '');

    const badJson = loadFixture('<script id="__NEXT_DATA__" type="application/json">{not valid json</script>');
    assert.doesNotThrow(() => extractNextDataDate(badJson));
    assert.equal(extractNextDataDate(badJson), '');

    const noDateKey = loadFixture(`<script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"post":{"id":42,"slug":"hello"}}}}
    </script>`);
    assert.equal(extractNextDataDate(noDateKey), '');
});

test('extractNextDataDate · 年份越界垃圾值(1970 占位)不误抽 · 深度超限不误抓', () => {
    const epochJunk = loadFixture(`<script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"post":{"date":"1970-01-01T00:00:00.000Z","id":42}}}}
    </script>`);
    assert.equal(extractNextDataDate(epochJunk), '');

    // 构造 10 层嵌套(远超深度限 6 层)· publishedAt 埋在最深处 · 应该找不到
    let deepObj: Record<string, unknown> = { publishedAt: '2025-01-01T00:00:00Z' };
    for (let i = 0; i < 10; i++) deepObj = { nested: deepObj };
    const tooDeep = loadFixture(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(deepObj)}</script>`);
    assert.equal(extractNextDataDate(tooDeep), '');
});

test('extractH1 · 原始值抽取(不做任何梯队判定 · 供聚合层比对 og:title 站级复读)', () => {
    const simple = loadFixture('<html><body><h1>Hello World</h1></body></html>');
    assert.equal(extractH1(simple), 'Hello World');

    const nested = loadFixture('<h1><span>Part1</span> Part2</h1>');
    assert.equal(extractH1(nested), 'Part1 Part2');

    const multiple = loadFixture('<h1>First</h1><h1>Second</h1>');
    assert.equal(extractH1(multiple), 'First');

    const none = loadFixture('<html><body><p>no h1 here</p></body></html>');
    assert.equal(extractH1(none), '');

    const blank = loadFixture('<h1>   </h1>');
    assert.equal(extractH1(blank), '');
});
